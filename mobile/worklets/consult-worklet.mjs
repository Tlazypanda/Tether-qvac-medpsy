/**
 * Bare worklet — the phone's P2P half. Runs Hyperswarm INSIDE the Bare runtime
 * (react-native-bare-kit) and bridges to React Native over BareKit.IPC with newline-delimited JSON.
 *
 * WHY A WORKLET AT ALL. React Native's JS runtime cannot host Hyperswarm: it has no UDP sockets, no
 * real `Buffer`, and (on JSC) no BigInt. Bare has all three. So everything that touches the network
 * or money lives here, and React Native is left as pure UI. Pattern borrowed from Leash
 * (github.com/danielAsaboro/Leash, apps/mobile/worklets) — the reference implementation for getting
 * the Holepunch stack running under Expo on physical phones.
 *
 * The division of labour, and why it is drawn here:
 *   · Worklet (this file) — Hyperswarm, the consult wire protocol, and EIP-712 voucher signing.
 *     ethers v6 needs a genuine BigInt and refuses a JSBI shim; Bare has one, JSC does not.
 *   · React Native — UI, and (health-worker role) MedPsy-4B inference via @qvac/sdk, which routes
 *     through its OWN worklet over the SDK's expo-rpc-client. We never load the model in here.
 *
 * It speaks exactly the protocol in src/core/protocol.ts, so a phone and a laptop are
 * interchangeable on either side of a consult. Do not let the two drift.
 *
 * RN → worklet
 *   { cmd: 'start',   role: 'asker'|'health-worker', bootstrap?, wallet: {...}, offer?: {...} }
 *   { cmd: 'consult', requestId, question }                         (asker: send a consult)
 *   { cmd: 'draft-done',  requestId, stage: 'awaiting_review' }      (health worker: draft parked)
 *   { cmd: 'approve', requestId, answer, edited, reviewMs, draftMs, stats }
 *   { cmd: 'reject',  requestId, reason }
 *   { cmd: 'stop' }
 *
 * worklet → RN
 *   { type: 'ready' } | { type: 'peers', count }
 *   { type: 'offer', ... }                                          (asker: a health worker found)
 *   { type: 'consult-in', requestId, question, askerWallet }         (health worker: work to do)
 *   { type: 'answer', requestId, answer, approvedByHuman, edited, reviewMs, draftMs, cost, model }
 *   { type: 'declined', requestId, reason }
 *   { type: 'paid', requestId, cumulative }
 *   { type: 'error', error }
 */
import b4a from 'b4a';
import { createHash } from 'bare-crypto';
import Hyperswarm from 'hyperswarm';

const IPC = BareKit.IPC;

// Keep in lockstep with src/core/medconsult.ts. Hardcoded rather than imported because bare-pack
// bundles this file standalone — a mismatch here means the phone silently joins a different topic.
const MEDCONSULT_TOPIC = 'medconsult:demo:v1';
const TOPIC = createHash('sha256').update(MEDCONSULT_TOPIC).digest();

function out(o) {
  IPC.write(b4a.from(JSON.stringify(o) + '\n'));
}

/** Newline-delimited JSON, matching src/core/protocol.ts send()/onMessages(). */
function send(conn, msg) {
  try {
    conn.write(b4a.from(JSON.stringify(msg) + '\n'));
  } catch {
    /* peer gone — the close handler cleans up */
  }
}

function onMessages(conn, handler) {
  let buf = '';
  conn.on('data', (d) => {
    buf += b4a.toString(d);
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      void handler(m);
    }
  });
  conn.on('error', () => {});
}

/**
 * Same LAN-local bootstrap escape hatch as src/core/swarm.ts: with no bootstrap we use the public
 * Holepunch DHT (needs internet), with one we stay entirely on the local network. The phone demo is
 * filmed in airplane mode, so this is normally set.
 */
function swarmOptions(bootstrap) {
  if (!Array.isArray(bootstrap) || !bootstrap.length) return {};
  return { bootstrap };
}

const state = {
  role: null,
  swarm: null,
  wallet: null, // { address, privateKey } — supplied by RN from secure storage
  offer: null, // health-worker role: what we advertise
  conns: new Set(),
  /** asker: requestId → the connection we sent it on, so the answer can be matched back. */
  pending: new Map(),
  /** health worker: requestId → the connection that asked, so an approval can be routed back. */
  inbound: new Map(),
};

function announcePeers() {
  out({ type: 'peers', count: state.conns.size });
}

// ── asker role ────────────────────────────────────────────────────────────────────────────────────

function askerConnection(conn) {
  onMessages(conn, (m) => {
    if (m.type === 'offer') {
      // Surface the health worker so the UI can show who is answering and at what price.
      out({
        type: 'offer',
        sellerWallet: m.sellerWallet,
        model: m.model,
        priceBaseUnits: m.priceBaseUnits,
        tps: m.tps,
        chainId: m.chainId,
      });
      return;
    }
    if (m.type === 'consultAck') {
      out({ type: 'stage', requestId: m.requestId, stage: m.stage });
      return;
    }
    if (m.type === 'consultReady') {
      // The health worker has an approved answer but has NOT sent the words yet. Pay first — the
      // voucher is the access handshake, exactly as upstream. Signing happens here in Bare because
      // ethers needs a real BigInt.
      void payAndCollect(conn, m);
      return;
    }
    if (m.type === 'consultAnswer') {
      out({
        type: 'answer',
        requestId: m.requestId,
        answer: m.answer,
        approvedByHuman: m.approvedByHuman === true,
        edited: m.edited === true,
        reviewMs: Number(m.reviewMs ?? 0),
        draftMs: Number(m.draftMs ?? 0),
        model: m.model,
        stats: m.stats ?? {},
      });
      state.pending.delete(m.requestId);
      return;
    }
    if (m.type === 'consultReject') {
      // A human declining is a legitimate outcome, not an error. Pass the stage through so the UI
      // can say "the health worker did not approve" rather than "network problem".
      out({ type: 'declined', requestId: m.requestId, reason: m.reason, stage: m.stage });
      state.pending.delete(m.requestId);
      return;
    }
    if (m.type === 'reject') {
      out({ type: 'error', error: m.reason });
    }
  });
}

/**
 * Sign a cumulative EIP-712 voucher for this consult and send it, then let `consultAnswer` through.
 *
 * NOTE (unverified on device): this mirrors the desktop storefront's draw step. It assumes the escrow
 * channel is ALREADY OPEN — opening one is an on-chain transaction and must happen before airplane
 * mode, so the phone never opens a channel mid-demo.
 */
async function payAndCollect(conn, m) {
  try {
    const { Wallet, TypedDataEncoder } = await import('ethers');
    if (!state.wallet?.privateKey) {
      out({ type: 'error', error: 'no wallet on this device — cannot sign a voucher' });
      return;
    }
    const price = BigInt(m.priceBaseUnits ?? '0');
    const prev = BigInt(state.cumulative ?? '0');
    const cumulative = prev + price;

    const signer = new Wallet(state.wallet.privateKey);
    const domain = state.wallet.voucherDomain; // { name, version, chainId, verifyingContract }
    const types = {
      Voucher: [
        { name: 'payer', type: 'address' },
        { name: 'payee', type: 'address' },
        { name: 'epoch', type: 'uint256' },
        { name: 'cumulative', type: 'uint256' },
      ],
    };
    const value = {
      payer: state.wallet.address,
      payee: state.wallet.payee,
      epoch: BigInt(state.wallet.epoch ?? '0'),
      cumulative,
    };
    void TypedDataEncoder; // kept for parity with src/core/escrow.ts's digest checks
    const signature = await signer.signTypedData(domain, types, value);

    state.cumulative = cumulative.toString();
    send(conn, {
      type: 'draw',
      buyerWallet: state.wallet.address,
      cumulative: cumulative.toString(),
      signature,
    });
    out({ type: 'paid', requestId: m.requestId, cumulative: cumulative.toString() });
  } catch (e) {
    out({ type: 'error', error: 'voucher signing failed: ' + (e && e.message) });
  }
}

// ── health-worker role ────────────────────────────────────────────────────────────────────────────

function healthWorkerConnection(conn) {
  // Advertise immediately, exactly as the desktop seller does on connection.
  if (state.offer) {
    send(conn, {
      type: 'offer',
      sellerWallet: state.offer.sellerWallet,
      model: state.offer.model,
      priceBaseUnits: String(state.offer.priceBaseUnits),
      tps: state.offer.tps ?? 0,
      token: state.offer.token,
      chainId: state.offer.chainId,
      ...(state.offer.escrow ? { escrow: state.offer.escrow } : {}),
    });
  }

  onMessages(conn, (m) => {
    if (m.type === 'consultReq') {
      // Hand the question up to RN, which owns MedPsy and the approval UI. Nothing is drafted here.
      state.inbound.set(m.requestId, conn);
      send(conn, { type: 'consultAck', requestId: m.requestId, stage: 'drafting' });
      out({
        type: 'consult-in',
        requestId: m.requestId,
        question: m.question,
        askerWallet: m.buyerWallet,
      });
      return;
    }
    if (m.type === 'draw') {
      // Voucher received for an already-approved consult → release the words.
      const held = state.approved?.get(m.buyerWallet?.toLowerCase?.() ?? '');
      send(conn, { type: 'drawAck', cumulative: m.cumulative });
      if (held) {
        send(conn, held);
        state.approved.delete(m.buyerWallet.toLowerCase());
      }
    }
  });
}

// ── IPC command loop ──────────────────────────────────────────────────────────────────────────────

let inbuf = '';
IPC.on('data', (chunk) => {
  inbuf += b4a.toString(chunk);
  const parts = inbuf.split('\n');
  inbuf = parts.pop() || '';
  for (const line of parts) {
    if (!line) continue;
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      continue;
    }
    void onCommand(req);
  }
});

async function onCommand(req) {
  try {
    if (req.cmd === 'start') return await start(req);
    if (req.cmd === 'consult') return sendConsult(req);
    if (req.cmd === 'draft-done') return draftDone(req);
    if (req.cmd === 'approve') return approve(req);
    if (req.cmd === 'reject') return reject(req);
    if (req.cmd === 'stop') return await stop();
  } catch (e) {
    out({ type: 'error', error: (e && e.message) || String(e) });
  }
}

async function start(req) {
  if (state.swarm) return; // idempotent — a remount must not create a second swarm
  state.role = req.role;
  state.wallet = req.wallet ?? null;
  state.offer = req.offer ?? null;
  state.approved = new Map();
  state.cumulative = req.wallet?.cumulative ?? '0';

  state.swarm = new Hyperswarm(swarmOptions(req.bootstrap));
  state.swarm.on('connection', (conn) => {
    state.conns.add(conn);
    conn.on('close', () => {
      state.conns.delete(conn);
      announcePeers();
    });
    conn.on('error', () => {});
    if (state.role === 'asker') askerConnection(conn);
    else healthWorkerConnection(conn);
    announcePeers();
  });

  // The health worker is the server (it has the model); the asker looks it up.
  const server = state.role === 'health-worker';
  await state.swarm.join(TOPIC, { server, client: !server }).flushed();
  out({ type: 'ready', role: state.role, topic: b4a.toString(TOPIC, 'hex') });
}

function sendConsult(req) {
  const conn = [...state.conns][0];
  if (!conn) {
    out({ type: 'declined', requestId: req.requestId, reason: 'no health worker online', stage: 'gate' });
    return;
  }
  state.pending.set(req.requestId, conn);
  send(conn, {
    type: 'consultReq',
    requestId: req.requestId,
    buyerWallet: state.wallet?.address ?? '',
    question: req.question,
  });
}

function draftDone(req) {
  const conn = state.inbound.get(req.requestId);
  if (conn) send(conn, { type: 'consultAck', requestId: req.requestId, stage: 'awaiting_review' });
}

/**
 * The human tapped Approve & Send. Announce readiness WITHOUT the text, hold the answer until the
 * voucher lands, then release it — payment stays the access handshake.
 */
function approve(req) {
  const conn = state.inbound.get(req.requestId);
  if (!conn) {
    out({ type: 'error', error: 'approved a consult whose asker has disconnected' });
    return;
  }
  const answer = {
    type: 'consultAnswer',
    requestId: req.requestId,
    answer: req.answer,
    approvedByHuman: true,
    edited: req.edited === true,
    reviewMs: Number(req.reviewMs ?? 0),
    draftMs: Number(req.draftMs ?? 0),
    model: state.offer?.model ?? '',
    stats: req.stats ?? {},
  };
  const wallet = (req.askerWallet ?? '').toLowerCase();
  state.approved.set(wallet, answer);
  send(conn, {
    type: 'consultReady',
    requestId: req.requestId,
    priceBaseUnits: String(state.offer?.priceBaseUnits ?? '0'),
  });
  state.inbound.delete(req.requestId);
}

function reject(req) {
  const conn = state.inbound.get(req.requestId);
  if (conn) {
    send(conn, {
      type: 'consultReject',
      requestId: req.requestId,
      reason: req.reason || 'rejected by health worker',
      stage: 'human',
    });
    state.inbound.delete(req.requestId);
  }
}

async function stop() {
  try {
    await state.swarm?.destroy();
  } catch {
    /* already down */
  }
  state.swarm = null;
  state.conns.clear();
}

out({ type: 'ready', boot: true });
