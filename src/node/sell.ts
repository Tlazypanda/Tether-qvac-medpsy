// Conduit SELLER node — discovery + negotiation + payment-gated provider, all over P2P.
//
// Reads its capability profile → advertises an offer on a Hyperswarm topic. For each buyer:
// quote (single-use nonce) → verify a signed, on-chain-confirmed payment → open a firewall-gated
// QVAC provider for exactly that buyer → grant the provider pubkey. No orchestrator.
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Hyperswarm from 'hyperswarm';
import { verifyMessage, JsonRpcProvider, HDNodeWallet, type BaseWallet } from 'ethers';
import { loadEnv } from '../core/env';
import { randomSeedHex } from '../core/identity';
import { MEDPSY_MODEL, MEDCONSULT_TOPIC } from '../core/medconsult';
import { swarmOptions, discoveryMode } from '../core/swarm';
import type { Consult } from '../sell/consult';

// Merge `.env` into process.env FIRST. Ordering is load-bearing: PROVIDER_SEED below, and
// CONDUIT_ESCROW / HW_UI_* later, are read straight off process.env. Without this, `CONDUIT_ESCROW=1`
// in `.env` did nothing and this node advertised an offer with no payment-channel support, which the
// asker reported as "this health worker does not accept payment channels".
loadEnv();

// Fork note: a distinct topic from upstream's `conduit:market:v1`, so this node never meets a real
// Conduit buyer (which would speak the delegation protocol, not the consult protocol) and our
// testing never shows up as noise on the live Conduit marketplace.
const TOPIC = crypto.createHash('sha256').update(MEDCONSULT_TOPIC).digest();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// This process's QVAC provider identity — set before the SDK touches the swarm.
const providerSeed = process.env.PROVIDER_SEED || randomSeedHex();
process.env.QVAC_HYPERSWARM_SEED = providerSeed;

const { loadConfig } = await import('../core/config');
const { getAccount } = await import('../core/wallet');
const { offerFromProfile, priceFor } = await import('../core/pricing');
const { send, onMessages, bindMessage } = await import('../core/protocol');
const { createEscrowClient, loadEscrowDeployment } = await import('../core/escrow');
const { createConsultQueue } = await import('../sell/consult');
const { startApprovalServer } = await import('../sell/approval-server');
const { makeAudit } = await import('../core/audit');
const sdk: any = await import('@qvac/sdk');

const cfg = loadConfig();
// Wallet source: the engine (seller mode) injects the unlocked wallet via CONDUIT_SELLER_MNEMONIC;
// the CLI/demo path falls back to the .env dev mnemonic. Account 1 = the seller's earnings address
// (must differ from the buyer's account 0 so a single machine can buy from its own seller).
const sellerMnemonic = process.env.CONDUIT_SELLER_MNEMONIC || cfg.mnemonic;
if (!sellerMnemonic) {
  console.error('[seller] no wallet mnemonic — set CONDUIT_SELLER_MNEMONIC (engine passes the unlocked wallet) or a .env mnemonic');
  process.exit(1);
}
const seller = await getAccount(sellerMnemonic, cfg.rpcUrl, 1); // seller earnings = account 1 of the wallet

const here = path.dirname(fileURLToPath(import.meta.url));
const RESOURCES = process.env.CONDUIT_RESOURCES || path.join(here, '../..');
let offer = { model: MEDPSY_MODEL, priceBaseUnits: priceFor(MEDPSY_MODEL), tps: 0 };
try {
  const profile = JSON.parse(readFileSync(path.join(RESOURCES, 'bench-profile.json'), 'utf8'));
  const probed = offerFromProfile(profile);
  // Fork guard: this node serves medical consults, so it must only ever advertise the consult
  // model. A profile left over from upstream Conduit (or from a `BENCH_LADDER` experiment) would
  // otherwise silently make us offer a general-purpose model on a medical topic — the kind of
  // thing that must not be discovered mid-shoot. Take the profile's measured tok/s, ignore its pick.
  if (probed && probed.model === MEDPSY_MODEL) {
    offer = probed;
  } else if (probed) {
    console.log(`[health-worker] ignoring stale bench profile (top model ${probed.model} ≠ ${MEDPSY_MODEL}) — re-run \`npm run bench\``);
  }
  // The node may override the prober's pick (CONDUIT_SELLER_MODEL) — but ONLY to a model this
  // machine actually benchmarked as runnable (no "might crash" choices). Price follows the model.
  const chosen = process.env.CONDUIT_SELLER_MODEL;
  if (chosen) {
    const m = profile.models?.find((x: any) => x.id === chosen && x.loaded);
    if (m) offer = { model: chosen, priceBaseUnits: priceFor(chosen), tps: m.tps ?? 0 };
    else console.log(`[health-worker] requested model ${chosen} not in this machine's runnable set — keeping ${offer.model}`);
  }
} catch { /* default */ }

// nonce → seller USD₮ balance at quote time (for confirm-by-delta); used nonces can't be replayed.
const quotes = new Map<string, { balanceBefore: bigint }>();
const used = new Set<string>();
let providerPub: string | undefined;

// ── Escrow (payment-channel) mode — opt-in via CONDUIT_ESCROW=1 + a deployed contract. The seller
// verifies the buyer's on-chain channel, serves per signed voucher, and redeems in the background.
const escrowDep = process.env.CONDUIT_ESCROW === '1' ? loadEscrowDeployment() : null;
const esc = escrowDep ? createEscrowClient(cfg.rpcUrl, escrowDep.address, escrowDep.chainId) : null;
const escrowWallet: BaseWallet | null = esc
  ? HDNodeWallet.fromPhrase(sellerMnemonic, undefined, "m/44'/60'/0'/0/1").connect(new JsonRpcProvider(cfg.rpcUrl))
  : null;
// buyerWallet(lower) → live session
const sessions = new Map<string, { buyerPub: string; epoch: bigint; deposit: bigint; cumulative: bigint; lastSig: string; claimed: bigint; claiming: boolean }>();
const CLAIM_THRESHOLD = 50_000n; // redeem on-chain once unclaimed earnings reach 0.05 USD₮

// Total earnings signed-for but not yet redeemed on-chain, across all live sessions. Vouchers are
// settled in batches (CLAIM_THRESHOLD) to save gas, so a freshly-served request earns USD₮ that
// won't hit the wallet for a while. The engine adds this to the on-chain delta so the seller's live
// "earned" reflects money actually owed, not just what's been claimed. Emitted on every change.
function totalPendingBaseUnits(): bigint {
  let p = 0n;
  for (const s of sessions.values()) p += s.cumulative - s.claimed;
  return p;
}
function emitPending() {
  console.log(`[seller] earned-pending ${totalPendingBaseUnits()}`);
}

// Background redeem — never blocks serving the buyer; fire-and-forget when earnings cross the threshold.
function maybeClaim(buyerWallet: string) {
  const s = sessions.get(buyerWallet.toLowerCase());
  if (!s || !esc || !escrowWallet || s.claiming) return;
  if (s.cumulative - s.claimed < CLAIM_THRESHOLD) return;
  s.claiming = true;
  const target = s.cumulative, sig = s.lastSig;
  esc.claim(escrowWallet, buyerWallet, target, sig)
    .then((tx) => { s.claimed = target; console.log(`[seller] claimed ${target} on-chain (tx ${tx.slice(0, 12)}…)`); emitPending(); })
    .catch((e: any) => console.log('[seller] claim failed (will retry):', e?.message ?? e))
    .finally(() => { s.claiming = false; });
}

// Read the seller's USD₮ balance, surviving transient RPC timeouts (a public testnet RPC blips).
// A seller daemon must never crash on a flaky balance read — degrade the negotiation instead.
async function balanceOrNull(): Promise<bigint | null> {
  try { return await seller.tokenBalance(cfg.usdtAddress); }
  catch (e: any) { console.log('[seller] rpc error reading balance:', e?.message ?? e); return null; }
}

// ── med-consult: local drafting + the human-approval gate ───────────────────────────────────────
// The consult queue owns the MedPsy handle and parks each draft on `awaiting_review` until a human
// decides. The approval server is the health worker's screen (upstream's provider role is headless).
// Per-role log, matching the asker's `AUDIT_LOG.asker.jsonl`. It used to default to the generic
// `AUDIT_LOG.jsonl`, which was wrong twice over: the docs told you to read the health-worker file
// (which then stayed empty and made a good run look like a failed one), and it collided with
// `npm run audit`, so each clobbered the other's evidence.
const audit = makeAudit(process.env.CONDUIT_AUDIT_LOG || 'AUDIT_LOG.health-worker.jsonl');
let connectedPeers = 0;

const queue = createConsultQueue({
  sdk,
  model: offer.model,
  log: (m) => console.log(m),
  onChange: (c) => { ui?.broadcast(); if (c.stage === 'awaiting_review') console.log('[health-worker] AWAITING HUMAN REVIEW — open ' + (ui?.url ?? 'the approval screen')); },
  onDraftDelta: () => scheduleUiPush(), // stream tokens to the screen, throttled
});

let ui: Awaited<ReturnType<typeof startApprovalServer>> | null = null;

// Draft tokens arrive faster than a screen needs repainting; coalesce to ~10 fps so a 4B
// generation doesn't spend its time serialising JSON snapshots.
let uiPushTimer: NodeJS.Timeout | null = null;
function scheduleUiPush() {
  if (uiPushTimer) return;
  uiPushTimer = setTimeout(() => { uiPushTimer = null; ui?.broadcast(); }, 100);
}

// Consults a human approved that are waiting on the asker's payment voucher before the text is
// released. Keyed by asker wallet (lower) → FIFO, since one `draw` settles exactly one consult.
const awaitingPayment = new Map<string, Array<{ conn: any; consult: Consult }>>();

function queueForPayment(wallet: string, entry: { conn: any; consult: Consult }) {
  const k = wallet.toLowerCase();
  const arr = awaitingPayment.get(k) ?? [];
  arr.push(entry);
  awaitingPayment.set(k, arr);
}

/** Called after a voucher verifies: release the oldest paid-for consult to that asker. */
function deliverPaidConsult(wallet: string) {
  const k = wallet.toLowerCase();
  const arr = awaitingPayment.get(k);
  if (!arr || !arr.length) return;
  const { conn, consult: c } = arr.shift()!;
  if (!arr.length) awaitingPayment.delete(k);
  send(conn, {
    type: 'consultAnswer',
    requestId: c.id,
    answer: c.finalAnswer,
    approvedByHuman: true,
    edited: c.edited,
    reviewMs: c.reviewMs,
    draftMs: c.draftMs,
    model: offer.model,
    stats: c.stats,
  });
  console.log(`[health-worker] answer delivered for ${c.id.slice(0, 8)}… (paid, human-approved)`);
  // The evidence line: a human approved this, how long they looked at it, and that it ran here.
  audit.log('consult', {
    request_id: c.id,
    model: offer.model,
    role: 'health-worker',
    approved_by_human: true,
    edited_by_human: c.edited,
    review_ms: c.reviewMs,
    draft_ms: c.draftMs,
    ttft_ms: c.stats.ttftMs ?? null,
    tps: c.stats.tps ?? null,
    prompt_tokens: c.stats.promptTokens ?? null,
    completion_tokens: c.stats.completionTokens ?? null,
    backend: c.stats.backend ?? null,
    price_base_units: offer.priceBaseUnits.toString(),
    asker_wallet: c.askerWallet,
    cloud_bytes: 0,
  });
}

async function handleConsult(conn: any, m: { requestId: string; buyerWallet: string; question: string }) {
  // ── The payment gate ── Upstream refuses a freeloader at the Noise handshake (0 bytes served).
  // Our equivalent, one layer up: without a verified on-chain channel this device does not draft,
  // so a non-paying peer costs the health worker zero GPU cycles and zero battery — and of course
  // receives zero answer bytes.
  const s = sessions.get(m.buyerWallet.toLowerCase());
  if (!s) {
    send(conn, { type: 'consultReject', requestId: m.requestId, reason: 'no open payment channel — open one first', stage: 'gate' });
    console.log('[health-worker] REJECTED consult (no payment channel) — 0 bytes, 0 GPU cycles');
    audit.log('p2p', { sub: 'consult_refused_unpaid', asker_wallet: m.buyerWallet, bytes_served: 0 });
    return;
  }
  if (s.cumulative + offer.priceBaseUnits > s.deposit) {
    send(conn, { type: 'consultReject', requestId: m.requestId, reason: 'payment channel exhausted — top up', stage: 'gate' });
    return;
  }
  const question = String(m.question ?? '').trim();
  if (!question) {
    send(conn, { type: 'consultReject', requestId: m.requestId, reason: 'empty consult', stage: 'gate' });
    return;
  }

  console.log(`[health-worker] consult ${m.requestId.slice(0, 8)}… received → drafting locally with ${offer.model}`);
  queue.submit(m.requestId, question, m.buyerWallet);
  send(conn, { type: 'consultAck', requestId: m.requestId, stage: 'drafting' });

  // Park here for as long as the human needs. There is no timeout on human judgement.
  const decided = await queue.waitForDecision(m.requestId);

  if (decided.stage === 'rejected') {
    send(conn, { type: 'consultReject', requestId: m.requestId, reason: 'the health worker did not approve this draft', stage: 'human' });
    audit.log('consult', {
      request_id: decided.id, model: offer.model, role: 'health-worker',
      approved_by_human: false, outcome: 'rejected_by_human',
      review_ms: decided.reviewMs, draft_ms: decided.draftMs, cloud_bytes: 0,
    });
    return;
  }
  if (decided.stage !== 'approved') {
    send(conn, { type: 'consultReject', requestId: m.requestId, reason: decided.error ?? 'drafting failed', stage: 'error' });
    return;
  }

  // Approved. Announce readiness WITHOUT the text, take payment, then deliver (see protocol.ts).
  queueForPayment(m.buyerWallet, { conn, consult: decided });
  send(conn, { type: 'consultReady', requestId: m.requestId, priceBaseUnits: String(offer.priceBaseUnits) });
}

async function ensureProvider(buyerPub: string): Promise<string> {
  if (!providerPub) {
    const res = await sdk.startQVACProvider({ firewall: { mode: 'allow', publicKeys: [buyerPub] } });
    providerPub = res.publicKey;
  }
  return providerPub!;
}

async function verifyReceipt(m: any): Promise<{ ok: boolean; reason?: string }> {
  const q = quotes.get(m.nonce);
  if (!q) return { ok: false, reason: 'unknown nonce' };
  if (used.has(m.nonce)) return { ok: false, reason: 'nonce already used' };
  let signer: string;
  try { signer = verifyMessage(bindMessage(m.nonce, m.buyerConsumerPub, m.buyerWallet), m.signature); }
  catch { return { ok: false, reason: 'bad signature' }; }
  if (signer.toLowerCase() !== String(m.buyerWallet).toLowerCase()) return { ok: false, reason: 'signature ≠ wallet' };
  const price = offer.priceBaseUnits;
  let bal = await balanceOrNull();
  for (let i = 0; i < 40 && (bal === null || bal < q.balanceBefore + price); i++) { await sleep(2000); bal = await balanceOrNull(); }
  if (bal === null || bal < q.balanceBefore + price) return { ok: false, reason: 'payment not confirmed on-chain' };
  used.add(m.nonce);
  return { ok: true };
}

const swarm = new Hyperswarm(swarmOptions());
swarm.on('connection', (conn: any) => {
  console.log('[health-worker] asker connected');
  connectedPeers++;
  ui?.broadcast();
  conn.on('close', () => { connectedPeers = Math.max(0, connectedPeers - 1); ui?.broadcast(); });
  send(conn, { type: 'offer', sellerWallet: seller.address, model: offer.model, priceBaseUnits: String(offer.priceBaseUnits), tps: offer.tps, token: cfg.usdtAddress, chainId: cfg.chainId, ...(escrowDep ? { escrow: escrowDep.address } : {}) });
  onMessages(conn, async (m) => {
    if (m.type === 'quoteReq') {
      const balanceBefore = await balanceOrNull();
      if (balanceBefore === null) { send(conn, { type: 'reject', reason: 'seller rpc unavailable, retry' }); return; }
      const nonce = crypto.randomBytes(16).toString('hex');
      quotes.set(nonce, { balanceBefore });
      send(conn, { type: 'quote', price: String(offer.priceBaseUnits), sellerWallet: seller.address, nonce, token: cfg.usdtAddress, chainId: cfg.chainId });
      console.log('[seller] quoted', String(offer.priceBaseUnits), 'nonce', nonce.slice(0, 12) + '…');
    } else if (m.type === 'receipt') {
      const v = await verifyReceipt(m);
      if (!v.ok) { console.log('[seller] REJECT:', v.reason); send(conn, { type: 'reject', reason: v.reason! }); return; }
      const pub = await ensureProvider(m.buyerConsumerPub);
      send(conn, { type: 'grant', providerPub: pub });
      console.log('[seller] payment verified → GRANTED, provider', pub.slice(0, 16) + '…');
    } else if (m.type === 'sessionOpen') {
      // Verify the buyer's escrow channel on-chain, then grant the gated provider (the channel = the grant).
      if (!esc) { send(conn, { type: 'reject', reason: 'seller does not accept escrow channels' }); return; }
      let ch;
      try { ch = await esc.channel(m.buyerWallet, seller.address); }
      catch (e: any) { send(conn, { type: 'reject', reason: 'channel read failed: ' + (e?.message ?? e) }); return; }
      const now = Math.floor(Date.now() / 1000);
      if (!ch.open) { send(conn, { type: 'reject', reason: 'no open channel' }); return; }
      if (ch.deposit < offer.priceBaseUnits) { send(conn, { type: 'reject', reason: 'deposit below price' }); return; }
      if (Number(ch.expiry) <= now) { send(conn, { type: 'reject', reason: 'channel expired' }); return; }
      if (ch.epoch.toString() !== m.epoch) { send(conn, { type: 'reject', reason: 'epoch mismatch' }); return; }
      sessions.set(m.buyerWallet.toLowerCase(), { buyerPub: m.buyerConsumerPub, epoch: ch.epoch, deposit: ch.deposit, cumulative: ch.claimed, lastSig: '', claimed: ch.claimed, claiming: false });
      const pub = await ensureProvider(m.buyerConsumerPub);
      send(conn, { type: 'sessionGrant', providerPub: pub, epoch: ch.epoch.toString() });
      console.log(`[seller] channel verified → GRANTED, deposit ${ch.deposit}, provider ${pub.slice(0, 16)}…`);
    } else if (m.type === 'draw') {
      // A per-inference voucher: verify the cumulative is signed by the buyer, increasing, and within deposit.
      if (!esc) { send(conn, { type: 'reject', reason: 'escrow not supported' }); return; }
      const s = sessions.get(m.buyerWallet.toLowerCase());
      if (!s) { send(conn, { type: 'reject', reason: 'no session' }); return; }
      const cumulative = BigInt(m.cumulative);
      let signer: string;
      try { signer = esc.recoverVoucher(m.buyerWallet, seller.address, s.epoch, cumulative, m.signature); }
      catch { send(conn, { type: 'reject', reason: 'bad voucher' }); return; }
      if (signer.toLowerCase() !== m.buyerWallet.toLowerCase()) { send(conn, { type: 'reject', reason: 'voucher signer mismatch' }); return; }
      if (cumulative <= s.cumulative) { send(conn, { type: 'reject', reason: 'voucher not increasing' }); return; }
      if (cumulative > s.deposit) { send(conn, { type: 'reject', reason: 'voucher exceeds deposit' }); return; }
      s.cumulative = cumulative;
      s.lastSig = m.signature;
      send(conn, { type: 'drawAck', cumulative: cumulative.toString() });
      console.log(`[seller] draw ${cumulative} verified → GRANTED (served)`);
      emitPending(); // a voucher just landed — surface the earned delta even before it's claimed
      // The voucher is good — now, and only now, the approved answer text crosses the wire.
      deliverPaidConsult(m.buyerWallet);
      maybeClaim(m.buyerWallet);
    } else if (m.type === 'consultReq') {
      await handleConsult(conn, m);
    }
  });
});

// The approval screen comes up BEFORE the node announces itself, so a consult can never arrive
// with nowhere for a human to review it.
ui = await startApprovalServer({
  queue,
  model: offer.model,
  chainId: cfg.chainId,
  peersConnected: () => connectedPeers,
  log: (m) => console.log(m),
});

await swarm.join(TOPIC, { server: true, client: false }).flushed();
console.log(`[seller] online. offer: ${offer.model} @ ${offer.priceBaseUnits} base-units, ~${offer.tps} tps. wallet ${seller.address}`);
console.log(`[health-worker] discovery: ${discoveryMode()}`);
console.log(`[health-worker] review consults at ${ui.url} — nothing is sent to an asker without your approval`);

// Warm MedPsy now (a few seconds from cache, minutes on first download) so the first consult of
// the session isn't also the slowest. Failure here is fatal: a health worker node that cannot draft
// has nothing to offer, and silently accepting consults it can't answer would be worse.
queue.warm().catch((e: any) => {
  console.error('[health-worker] FATAL: could not load ' + offer.model + ':', e?.message ?? e);
  console.error('[health-worker] run `npm run bench` to download/verify the model, then restart.');
  void shutdown();
});

async function shutdown() { try { await ui?.close(); } catch {} try { await queue.close(); } catch {} try { await sdk.stopQVACProvider(); } catch {} try { await sdk.close(); } catch {} try { await swarm.destroy(); } catch {} process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// A seller is a long-running daemon — never let a stray error (e.g. a flaky RPC) take it down.
process.on('uncaughtException', (e: any) => console.error('[seller] uncaught (staying up):', e?.message ?? e));
process.on('unhandledRejection', (e: any) => console.error('[seller] unhandled (staying up):', e?.message ?? e));
