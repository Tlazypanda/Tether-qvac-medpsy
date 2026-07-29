// Conduit buyer storefront — the live marketplace of sellers + the purchase flow.
//
// One Hyperswarm client joined to the market topic discovers sellers (each sends an `offer`),
// keeps a registry the UI can browse, and `purchase()` runs the proven negotiation against a
// chosen seller: quoteReq → quote(nonce) → sign-bind + pay USD₮ → receipt → grant → delegate.
// (Generalises src/node/buy.ts to many sellers + a long-lived process.)
import crypto from 'node:crypto';
import Hyperswarm from 'hyperswarm';
import { Wallet as EthWallet, JsonRpcProvider } from 'ethers';
import { send, onMessages, type Msg } from '../core/protocol';
import { createEscrowClient, type EscrowClient } from '../core/escrow';
import type { Reputation } from '../core/reputation';
import type { ConduitAccount } from '../core/wallet';
import { MEDCONSULT_TOPIC } from '../core/medconsult';

// Fork note: our own topic (see src/core/medconsult.ts) — never upstream's `conduit:market:v1`.
const TOPIC = crypto.createHash('sha256').update(MEDCONSULT_TOPIC).digest();

export interface SellerOffer {
  id: string; // storefront peer key (hex) — stable marketplace id
  sellerWallet: string;
  model: string;
  priceBaseUnits: bigint;
  tps: number;
  token: string;
  chainId: number;
  escrow?: string; // escrow contract address, if this seller accepts payment-channel sessions
  online: boolean;
  lastSeen: number;
  // first-party reputation (this buyer's own experience with the seller):
  served: number;
  failed: number;
  successRate: number; // [0,1], neutral 0.5 when no history
}

export interface PurchaseResult {
  answer: string;
  cost: bigint;
  txHash?: string;
  via: 'channel' | 'per-inference'; // how it settled (escrow voucher vs one on-chain payment)
  model: string;
  sellerWallet: string;
  stats?: { ttftMs?: number; tps?: number; promptTokens?: number };
  // ── med-consult (fork) — provenance of the answer, surfaced to the asker's screen ──
  approvedByHuman?: boolean; // always true for a delivered consult; a draft cannot reach us otherwise
  edited?: boolean; // the health worker changed the model's wording before sending
  reviewMs?: number; // how long the human spent reviewing
  draftMs?: number; // how long MedPsy took to write the draft
}

export interface SessionInfo {
  seller: string; // seller wallet
  deposit: string; // base units
  cumulative: string; // total drawn (signed) so far
  remaining: string; // deposit − cumulative
}

export interface Storefront {
  list(): SellerOffer[];
  getActive(): SellerOffer | null;
  select(id: string): SellerOffer | null; // an offer id, or 'auto'
  selectedId(): string;
  sessions(): SessionInfo[]; // open escrow channels (for the UI session chip)
  purchase(seller: SellerOffer, prompt: string): Promise<PurchaseResult>;
  close(): Promise<void>;
}

export interface StorefrontDeps {
  buyer: ConduitAccount; // pays + address
  signerPhrase: string; // BIP-39 phrase for the off-chain bind signature (buyer = account 0)
  consumerPub: string; // QVAC consumer pubkey (the key the seller firewall-allows on grant)
  rpcUrl: string; // EVM RPC (for escrow on-chain open/topUp)
  escrow?: { address: string; chainId: number } | null; // deployed ConduitEscrow (enables channel mode)
  depositBaseUnits?: bigint; // per-channel deposit (default 0.05 USD₮)
  sessionDurationSecs?: number; // channel expiry (default 1h)
  reputation?: Reputation; // first-party seller reputation (ranks "Auto", shown in the marketplace)
  log?: (m: string) => void;
  /** Fired once a consult is with a human — lets the asker's UI say "a health worker is reviewing". */
  onAwaitingReview?: (requestId: string) => void;
}

interface SessionState {
  epoch: bigint;
  cumulative: bigint; // total drawn (signed) this session
  deposit: bigint;
  providerPub: string;
  expiry: bigint; // on-chain channel expiry (unix secs) — past this the seller rejects vouchers
}

interface ConnRec {
  id: string;
  conn: any;
  offer?: SellerOffer;
  pending: Map<string, { resolve: (m: any) => void; reject: (e: Error) => void }>;
}

// cheapest, then fastest (display order / tiebreak)
function byPriceThenSpeed(a: SellerOffer, b: SellerOffer): number {
  if (a.priceBaseUnits !== b.priceBaseUnits) return a.priceBaseUnits < b.priceBaseUnits ? -1 : 1;
  return b.tps - a.tps;
}

export async function createStorefront(deps: StorefrontDeps): Promise<Storefront> {
  const log = deps.log ?? (() => {});
  const signer = EthWallet.fromPhrase(deps.signerPhrase);
  const swarm = new Hyperswarm();
  const conns = new Map<string, ConnRec>();
  let selected = 'auto';

  // Escrow (channel) mode — opt-in, only when a deployment is configured. The buyer's on-chain
  // signer (account 0) is provider-connected for open/topUp; sessions are kept per seller wallet.
  const esc: EscrowClient | null = deps.escrow
    ? createEscrowClient(deps.rpcUrl, deps.escrow.address, deps.escrow.chainId)
    : null;
  const escrowWallet = esc ? signer.connect(new JsonRpcProvider(deps.rpcUrl)) : null;
  const sessionStates = new Map<string, SessionState>(); // sellerWallet(lower) → session
  const deposit = deps.depositBaseUnits ?? 1_000_000n; // 1 USD₮ — generous so long sessions/demos don't exhaust (~100 answers @ 0.01)
  const duration = deps.sessionDurationSecs ?? 3600;

  function offers(): SellerOffer[] {
    return [...conns.values()].map((c) => c.offer).filter((o): o is SellerOffer => !!o);
  }

  function activeOffer(): SellerOffer | null {
    const online = offers().filter((o) => o.online);
    if (!online.length) return null;
    if (selected !== 'auto') {
      const sel = online.find((o) => o.id === selected);
      if (sel) return sel; // selected seller still online
    }
    // 'auto' (or selected went offline) → best reputation, then cheapest, then fastest.
    return [...online].sort((a, b) => {
      const sa = deps.reputation?.score(a.sellerWallet) ?? 0.5;
      const sb = deps.reputation?.score(b.sellerWallet) ?? 0.5;
      if (Math.abs(sa - sb) > 0.02) return sb - sa; // meaningfully better reputation wins
      return byPriceThenSpeed(a, b);
    })[0]!;
  }

  function resolvePending(rec: ConnRec, kind: string, m: any) {
    const p = rec.pending.get(kind);
    if (p) { rec.pending.delete(kind); p.resolve(m); }
  }

  function handle(rec: ConnRec, m: Msg) {
    if (m.type === 'offer') {
      const rep = deps.reputation?.get(m.sellerWallet);
      rec.offer = {
        id: rec.id,
        sellerWallet: m.sellerWallet,
        model: m.model,
        priceBaseUnits: BigInt(m.priceBaseUnits),
        tps: m.tps,
        token: m.token,
        chainId: m.chainId,
        escrow: m.escrow,
        online: true,
        lastSeen: Date.now(),
        served: rep?.served ?? 0,
        failed: rep?.failed ?? 0,
        successRate: deps.reputation?.successRate(m.sellerWallet) ?? 0.5,
      };
      log(`[storefront] seller ${rec.id.slice(0, 10)}… offers ${m.model} @ ${m.priceBaseUnits} (~${m.tps} tps)${m.escrow ? ' [escrow]' : ''}`);
    } else if (m.type === 'quote') {
      resolvePending(rec, 'quote', m);
    } else if (m.type === 'grant') {
      resolvePending(rec, 'grant', m);
    } else if (m.type === 'sessionGrant') {
      resolvePending(rec, 'sessionGrant', m);
    } else if (m.type === 'drawAck') {
      resolvePending(rec, 'drawAck', m);
    } else if (m.type === 'consultAck' || m.type === 'consultReady' || m.type === 'consultAnswer') {
      // Consult replies are keyed by request id: a health worker may have several consults in
      // flight from the same asker, and a stale reply must not resolve the wrong wait.
      resolvePending(rec, `${m.type}:${m.requestId}`, m);
    } else if (m.type === 'consultReject') {
      const e = new Error(
        m.stage === 'human'
          ? 'the health worker reviewed this consult and did not approve it'
          : 'consult refused: ' + m.reason,
      );
      (e as any).stage = m.stage;
      for (const kind of ['consultAck', 'consultReady', 'consultAnswer']) {
        const key = `${kind}:${m.requestId}`;
        const p = rec.pending.get(key);
        if (p) { rec.pending.delete(key); p.reject(e); }
      }
    } else if (m.type === 'reject') {
      const e = new Error('seller rejected: ' + m.reason);
      for (const [k, p] of rec.pending) { rec.pending.delete(k); p.reject(e); }
    }
  }

  swarm.on('connection', (conn: any) => {
    const id = Buffer.from(conn.remotePublicKey).toString('hex');
    const rec: ConnRec = { id, conn, pending: new Map() };
    conns.set(id, rec);
    onMessages(conn, (m) => handle(rec, m));
    conn.on('close', () => {
      if (rec.offer) rec.offer.online = false;
      for (const [k, p] of rec.pending) { rec.pending.delete(k); p.reject(new Error('seller disconnected')); }
    });
    conn.on('error', () => {});
  });

  await swarm.join(TOPIC, { server: false, client: true }).flushed();
  log('[storefront] searching for sellers…');

  // `ms = 0` means wait indefinitely — used only while a human reviews a consult. It is still
  // bounded in practice: the seller's `consultReject` and the connection's 'close' both reject it.
  function waitFor(rec: ConnRec, kind: string, ms: number): Promise<any> {
    return new Promise((resolve, reject) => {
      const to = ms > 0
        ? setTimeout(() => { rec.pending.delete(kind); reject(new Error(`timeout waiting for ${kind}`)); }, ms)
        : null;
      rec.pending.set(kind, {
        resolve: (m: any) => { if (to) clearTimeout(to); resolve(m); },
        reject: (e: Error) => { if (to) clearTimeout(to); reject(e); },
      });
    });
  }

  // Fork note: upstream had a `delegateAndRun()` here — it loaded a model handle bound to the
  // seller's provider pubkey and streamed tokens straight to the buyer. That is precisely the path
  // a human cannot step into (see the consult section of src/core/protocol.ts), so it is gone. The
  // asker's device now runs no model at all; it sends a question and receives approved text.

  // Open (or resume) an escrow channel to this seller and get the granted provider pubkey.
  async function ensureSession(rec: ConnRec, offer: SellerOffer): Promise<SessionState> {
    const key = offer.sellerWallet.toLowerCase();
    // small safety margin so we never start a draw against a channel that expires moments later
    const now = BigInt(Math.floor(Date.now() / 1000)) + 30n;

    // Reuse a cached session only while it's still within its on-chain expiry. A channel that has
    // expired can't be reused — the seller rejects vouchers against it ("channel expired") — so
    // drop the stale cache and reopen below.
    const have = sessionStates.get(key);
    if (have && now < have.expiry) return have;
    if (have) sessionStates.delete(key);
    if (!esc || !escrowWallet) throw new Error('escrow not configured');

    let ch = await esc.channel(escrowWallet.address, offer.sellerWallet);

    // An expired-but-still-open channel is unusable, and the contract refuses to open a new one over
    // it ("already open"). Reclaim the unspent remainder via withdraw — allowed at/after expiry,
    // which closes the channel — then open a fresh one below. open() bumps the epoch, so vouchers
    // from the old channel can't be replayed.
    if (ch.open && BigInt(Math.floor(Date.now() / 1000)) >= ch.expiry) {
      log(`[storefront] channel → ${offer.sellerWallet.slice(0, 10)}… expired; reclaiming remainder + reopening`);
      await esc.withdraw(escrowWallet, offer.sellerWallet);
      ch = await esc.channel(escrowWallet.address, offer.sellerWallet);
    }

    if (!ch.open) {
      log(`[storefront] opening escrow channel → ${offer.sellerWallet.slice(0, 10)}… (deposit ${deposit})`);
      await esc.open(escrowWallet, offer.token, offer.sellerWallet, deposit, duration);
      ch = await esc.channel(escrowWallet.address, offer.sellerWallet);
    }
    // ask the seller to verify the channel on-chain and grant the gated provider
    send(rec.conn, { type: 'sessionOpen', buyerConsumerPub: deps.consumerPub, buyerWallet: escrowWallet.address, epoch: ch.epoch.toString() });
    const grant = await waitFor(rec, 'sessionGrant', 120_000);
    const sess: SessionState = { epoch: ch.epoch, cumulative: ch.claimed, deposit: ch.deposit, providerPub: grant.providerPub, expiry: ch.expiry };
    sessionStates.set(key, sess);
    return sess;
  }

  // Re-pull a seller's reputation into its live offer so the marketplace reflects the latest outcome.
  function refreshOfferRep(sellerWallet: string) {
    const rep = deps.reputation?.get(sellerWallet);
    for (const c of conns.values()) {
      if (c.offer && c.offer.sellerWallet.toLowerCase() === sellerWallet.toLowerCase()) {
        c.offer.served = rep?.served ?? 0;
        c.offer.failed = rep?.failed ?? 0;
        c.offer.successRate = deps.reputation?.successRate(sellerWallet) ?? 0.5;
      }
    }
  }

  async function runPurchase(seller: SellerOffer, prompt: string): Promise<PurchaseResult> {
    const rec = conns.get(seller.id);
    if (!rec || !rec.offer?.online) throw new Error('seller offline');
    const conn = rec.conn;
    const price = seller.priceBaseUnits;

    // ── MED-CONSULT PATH ── A consult always settles through an escrow channel: the channel is the
    // one step that genuinely needs the internet, and the demo opens it deliberately BEFORE going
    // into airplane mode. Upstream's per-inference on-chain path would need connectivity at the
    // moment of asking, which is exactly what this fork claims not to need — so it is refused
    // rather than silently used.
    if (!esc || !escrowWallet) throw new Error('escrow not configured — a consult settles over a payment channel (set CONDUIT_ESCROW=1)');
    if (!seller.escrow) throw new Error('this health worker does not accept payment channels');

    const sess = await ensureSession(rec, seller);
    if (sess.cumulative + price > sess.deposit) {
      // Channel nearly drained — top it up on-chain so a long session/demo never stalls mid-consult.
      // NOTE: this touches the chain, so it needs connectivity. Fund generously before filming.
      log(`[storefront] channel low — auto top-up ${deposit} → ${seller.sellerWallet.slice(0, 10)}…`);
      await esc.topUp(escrowWallet, seller.token, seller.sellerWallet, deposit);
      const ch = await esc.channel(escrowWallet.address, seller.sellerWallet);
      sess.deposit = ch.deposit;
    }

    const requestId = crypto.randomBytes(16).toString('hex');

    // 1) Send the question. The health worker's device drafts it locally with MedPsy.
    send(conn, { type: 'consultReq', requestId, buyerWallet: escrowWallet.address, question: prompt });
    await waitFor(rec, `consultAck:${requestId}`, 30_000); // gate passed, drafting started
    log(`[storefront] consult ${requestId.slice(0, 8)}… accepted — health worker is drafting, then reviewing`);
    deps.onAwaitingReview?.(requestId);

    // 2) Wait for a HUMAN. There is deliberately no timeout on human judgement — a health worker
    //    mid-consultation may take minutes, and timing them out would be the wrong failure mode.
    //    A rejected draft rejects this promise via `consultReject` (stage: 'human'); a dropped
    //    connection rejects it via the conn 'close' handler. Neither can hang forever.
    const ready = await waitFor(rec, `consultReady:${requestId}`, 0);
    log('[storefront] health worker approved — settling the voucher');

    // 3) Pay. The answer text has NOT crossed the wire yet — payment is still the access handshake.
    sess.cumulative += price; // running total owed
    const sig = await esc.signVoucher(escrowWallet, seller.sellerWallet, sess.epoch, sess.cumulative);
    send(conn, { type: 'draw', buyerWallet: escrowWallet.address, cumulative: sess.cumulative.toString(), signature: sig });
    await waitFor(rec, 'drawAck', 20_000); // health worker verified + recorded the voucher (instant)
    void ready;

    // 4) Voucher verified → the approved answer is released.
    const ans = await waitFor(rec, `consultAnswer:${requestId}`, 30_000);
    return {
      answer: String(ans.answer ?? '').trim(),
      cost: price,
      via: 'channel',
      model: seller.model,
      sellerWallet: seller.sellerWallet,
      stats: ans.stats,
      approvedByHuman: ans.approvedByHuman === true,
      edited: ans.edited === true,
      reviewMs: Number(ans.reviewMs ?? 0),
      draftMs: Number(ans.draftMs ?? 0),
    };
  }

  return {
    list() {
      return offers().sort(byPriceThenSpeed);
    },
    getActive: activeOffer,
    selectedId() {
      return selected;
    },
    select(id: string) {
      selected = id;
      return activeOffer();
    },
    sessions() {
      return [...sessionStates.entries()].map(([seller, s]) => ({
        seller,
        deposit: s.deposit.toString(),
        cumulative: s.cumulative.toString(),
        remaining: (s.deposit - s.cumulative).toString(),
      }));
    },
    async purchase(seller, prompt) {
      // Record the outcome against the seller's reputation (served on success, failed on any error)
      // and refresh the offer's displayed counts so the marketplace updates live.
      try {
        const res = await runPurchase(seller, prompt);
        deps.reputation?.recordServed(seller.sellerWallet, res.stats?.tps ?? null);
        refreshOfferRep(seller.sellerWallet);
        return res;
      } catch (e) {
        deps.reputation?.recordFailed(seller.sellerWallet);
        refreshOfferRep(seller.sellerWallet);
        throw e;
      }
    },
    async close() {
      try { swarm.destroy(); } catch {}
    },
  };
}
