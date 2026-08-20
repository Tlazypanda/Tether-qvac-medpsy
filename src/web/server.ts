// The ASKER's app — a tiny Node server wrapping the spend policy and the live P2P storefront,
// serving the chat + wallet UI. This device holds no medical model: every consult goes to a paid
// health-worker peer, is drafted on THEIR device, and is reviewed by a human before it comes back.
//
// The wallet is a per-user encrypted keystore (src/core/keystore.ts): the app is LOCKED until the
// user creates/imports + unlocks it; the asker account + storefront are built on unlock.
// A `.env` mnemonic auto-unlocks in dev.
// Run: npm run web
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatUnits } from 'ethers';
import { randomSeedHex, publicKeyHexFromSeed } from '../core/identity';
import { MEDICAL_DISCLAIMER } from '../core/medconsult';

const PORT = Number(process.env.PORT || 8788);
const buyerSeed = process.env.QVAC_HYPERSWARM_SEED || randomSeedHex();
const buyerPub = publicKeyHexFromSeed(buyerSeed);
process.env.QVAC_HYPERSWARM_SEED = buyerSeed; // this process = buyer (set before the SDK loads)

const { loadConfig } = await import('../core/config');
const { getAccount } = await import('../core/wallet');
const { SpendPolicy } = await import('../buy/policy');
const { createStorefront } = await import('../buy/storefront');
const { createMarketAgent } = await import('../buy/market-agent');
const { loadEscrowDeployment } = await import('../core/escrow');
const { createReputation } = await import('../core/reputation');
const { createSellerManager } = await import('./seller');
const { offerFromProfile, priceFor } = await import('../core/pricing');
const keystore = await import('../core/keystore');
const sdk: any = await import('@qvac/sdk');

const here = path.dirname(fileURLToPath(import.meta.url));
// Where the static assets + bench profile live. In dev this resolves to the repo root (here =
// src/web). In the packaged app the engine runs as a compiled bundle from a different dir, so
// Electron passes CONDUIT_RESOURCES pointing at the bundled resources (see electron/main.ts).
const RESOURCES = process.env.CONDUIT_RESOURCES || path.join(here, '../..');
const appDist = path.join(RESOURCES, 'app/dist'); // built React app (npm run app:build)

// Shown only when the React app hasn't been built yet (app/dist missing) — a short prompt, not a 404.
const buildPrompt = `<!doctype html><html><head><meta charset="utf-8"><title>MedConsult</title>
<style>html,body{height:100%;margin:0}body{background:#0E1217;color:#E7F0EF;font:16px/1.6 system-ui,-apple-system,sans-serif;display:grid;place-items:center}
.c{max-width:460px;padding:32px;text-align:center}h1{color:#2BE3A8;font-weight:600;margin:0 0 14px}
code{background:#16202b;border:1px solid #22303a;border-radius:6px;padding:3px 9px;color:#2BE3A8;font-family:ui-monospace,monospace;font-size:14px}
p{color:#8A9AA6;margin:10px 0}</style></head>
<body><div class="c"><h1>⬡ MedConsult</h1><p>The web UI isn't built yet. Run:</p>
<p><code>npm run app:install</code></p><p><code>npm run app:build</code></p>
<p>then refresh — or <code>npm run start</code> to build &amp; serve in one step.</p></div></body></html>`;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

const DEC = 6;
const MAX_PER_CALL = 100_000n; // 0.1 USD₮ hard cap per single inference
const MAX_BUDGET = 1_000_000n; // 1 USD₮ session budget
const MIN_PW = 8;

const cfg = loadConfig();
const policy = new SpendPolicy(MAX_PER_CALL, MAX_BUDGET);
// Escrow (payment-channel) mode is opt-in: CONDUIT_ESCROW=1 + a deployed contract. The seller child
// inherits CONDUIT_ESCROW via the spawned env, so enabling it here turns it on for both roles.
const escrowDep = process.env.CONDUIT_ESCROW === '1' ? loadEscrowDeployment() : null;
const reputation = createReputation(); // first-party seller reputation (persists to ~/.conduit/reputation.json)

// Seller mode: the engine manages the proven sell.ts as a child (spawn/kill/inspect). It earns into
// account index 1 of the unlocked wallet (distinct from the buyer's index 0). See src/web/seller.ts.
const seller = createSellerManager({
  repoRoot: RESOURCES,
  rpcUrl: cfg.rpcUrl,
  usdtAddress: cfg.usdtAddress,
  makeEarningsAccount: (m: string) => getAccount(m, cfg.rpcUrl, 1),
  log: (msg) => console.log(msg),
});

// The seller's offer + this machine's capability profile (read from bench-profile.json), so the
// seller screen can show "you'll offer Qwen3 4B @ 0.01 · ~59 tps" before going online.
function sellerProfile() {
  try {
    const profile = JSON.parse(readFileSync(path.join(RESOURCES, 'bench-profile.json'), 'utf8'));
    const o = offerFromProfile(profile);
    return {
      backend: profile.backend ?? null,
      platform: profile.platform ?? null,
      topSellable: profile.topSellable ?? null,
      localDraft: profile.localDraft ?? null,
      ts: profile.ts ?? null,
      recommended: profile.topSellable ?? null, // the prober's optimal pick — highlighted in the UI
      offer: o
        ? { model: o.model, price: formatUnits(o.priceBaseUnits, DEC), priceBaseUnits: o.priceBaseUnits.toString(), tps: o.tps }
        : null,
      // Sellable models = those this machine actually benchmarked as runnable, with their tiered price.
      // The seller may pick any of these; the prober's `recommended` is pre-selected in the UI.
      models: (profile.models ?? [])
        .filter((m: any) => m.loaded)
        .map((m: any) => ({ id: m.id, loaded: true, tps: m.tps ?? null, backend: m.backend ?? null, price: formatUnits(priceFor(m.id), DEC) })),
    };
  } catch {
    return { backend: null, platform: null, topSellable: null, recommended: null, localDraft: null, ts: null, offer: null, models: [] };
  }
}

// ---- wallet + dependent services (buyer / storefront / agent are built on unlock) ----
let wallet: { mnemonic: string; address: string } | null = null;
let buyer: any = null;
let storefront: any = null;
let agent: any = null;
let setupErr: string | undefined;

// Fork note: upstream warmed a local 0.6B router here and streamed its multi-GB download progress
// to the UI. The asker's device deliberately carries NO model — that is the premise of the demo —
// so there is nothing to download and nothing to warm. The endpoint and the field are kept so the
// React app's existing wiring keeps working; they simply report "ready" from the start.
type ModelProgress = { phase: 'warming' | 'downloading' | 'ready' | 'error'; model?: string; percentage?: number; message?: string };
const modelProgress: ModelProgress = { phase: 'ready', message: 'no on-device model — consults are answered by a health worker peer' };
const progressClients = new Set<http.ServerResponse>();

async function unlockWith(mnemonic: string): Promise<string> {
  const acct = await getAccount(mnemonic, cfg.rpcUrl, 0); // buyer = account 0 of this wallet
  const sf = await createStorefront({ buyer: acct, signerPhrase: mnemonic, consumerPub: buyerPub, rpcUrl: cfg.rpcUrl, escrow: escrowDep, reputation, log: (m) => console.log(m) });
  buyer = acct;
  storefront = sf;
  agent = null; // (re)created lazily once the storefront exists
  wallet = { mnemonic, address: acct.address };
  return acct.address;
}

function lock(): void {
  const sf = storefront;
  wallet = null; buyer = null; storefront = null; agent = null;
  void sf?.close?.();
}

function getAgent(): any {
  // Fork note: upstream gated this on the local router being warm. The asker has no model to warm.
  if (!agent && storefront) agent = createMarketAgent({ policy, storefront, log: (m) => console.log(m) });
  return agent;
}

// Dev convenience only: no keystore on disk but `.env` has a mnemonic → auto-unlock the dev wallet.
// (The shipped app has no .env, so real users always go through create/import/unlock.)
// Set CONDUIT_NO_ENV_WALLET=1 to force the real onboarding/unlock flow even in dev.
if (!keystore.exists() && cfg.mnemonic && process.env.CONDUIT_NO_ENV_WALLET !== '1') {
  void unlockWith(cfg.mnemonic).catch((e) => { setupErr = String(e?.message ?? e); });
}

function walletStatus() {
  return { exists: keystore.exists(), unlocked: !!wallet, address: wallet?.address ?? keystore.readAddress() };
}

function json(res: http.ServerResponse, code: number, obj: unknown) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function offerJson(o: { id: string; sellerWallet: string; model: string; priceBaseUnits: bigint; tps: number; online: boolean; served?: number; failed?: number; successRate?: number }) {
  return {
    id: o.id, address: o.sellerWallet, model: o.model, price: formatUnits(o.priceBaseUnits, DEC), tps: o.tps, online: o.online,
    served: o.served ?? 0, failed: o.failed ?? 0, successRate: o.successRate ?? 0.5,
  };
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); } });
  });
}

// ---------- static (built React app) ----------
function serveStatic(res: http.ServerResponse, pathname: string): boolean {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const full = path.normalize(path.join(appDist, rel));
  if (!full.startsWith(appDist)) { res.writeHead(403); res.end('forbidden'); return true; }
  if (!existsSync(full) || !statSync(full).isFile()) return false;
  const ext = path.extname(full);
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=86400',
  });
  res.end(readFileSync(full));
  return true;
}
function serveApp(res: http.ServerResponse, pathname: string) {
  if (serveStatic(res, pathname)) return;
  if (existsSync(path.join(appDist, 'index.html'))) { serveStatic(res, '/'); return; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(buildPrompt);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const p = url.pathname;
  void (async () => {
    // ---------- wallet management ----------
    if (req.method === 'GET' && p === '/api/wallet') {
      json(res, 200, walletStatus());
      return;
    }
    if (req.method === 'POST' && p === '/api/wallet/create') {
      const { password } = await readBody(req);
      if (keystore.exists()) { json(res, 409, { error: 'a wallet already exists on this machine' }); return; }
      if (!password || String(password).length < MIN_PW) { json(res, 400, { error: `password must be at least ${MIN_PW} characters` }); return; }
      try {
        const w = await keystore.create(password);
        await unlockWith(w.mnemonic);
        json(res, 200, { address: w.address, mnemonic: w.mnemonic }); // mnemonic returned ONCE for backup
      } catch (e: any) { json(res, 500, { error: String(e?.message ?? e) }); }
      return;
    }
    if (req.method === 'POST' && p === '/api/wallet/import') {
      const { mnemonic, password } = await readBody(req);
      if (!password || String(password).length < MIN_PW) { json(res, 400, { error: `password must be at least ${MIN_PW} characters` }); return; }
      try {
        const w = await keystore.importMnemonic(String(mnemonic ?? ''), password);
        await unlockWith(w.mnemonic);
        json(res, 200, { address: w.address });
      } catch (e: any) { json(res, 400, { error: String(e?.message ?? e) }); }
      return;
    }
    if (req.method === 'POST' && p === '/api/wallet/unlock') {
      const { password } = await readBody(req);
      try {
        const w = await keystore.unlock(String(password ?? ''));
        await unlockWith(w.mnemonic);
        json(res, 200, { address: w.address });
      } catch (e: any) { json(res, 401, { error: String(e?.message ?? e) }); }
      return;
    }
    if (req.method === 'POST' && p === '/api/wallet/lock') {
      lock();
      json(res, 200, { ok: true });
      return;
    }
    if (req.method === 'POST' && p === '/api/wallet/export') {
      if (!wallet) { json(res, 401, { error: 'wallet locked' }); return; }
      if (!keystore.exists()) { json(res, 200, { mnemonic: wallet.mnemonic }); return; } // dev .env fallback (no password)
      const { password } = await readBody(req);
      try {
        const w = await keystore.unlock(String(password ?? '')); // re-verify the password before revealing
        json(res, 200, { mnemonic: w.mnemonic });
      } catch { json(res, 401, { error: 'wrong password' }); }
      return;
    }

    // ---------- model load progress (SSE) ----------
    if (req.method === 'GET' && p === '/api/model/progress') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify(modelProgress)}\n\n`);
      progressClients.add(res);
      req.on('close', () => progressClients.delete(res));
      return;
    }

    // ---------- state ----------
    if (req.method === 'GET' && p === '/api/state') {
      const w = walletStatus();
      if (!wallet) {
        json(res, 200, { wallet: w, ready: false, sellersOnline: 0, peer: null, selected: 'auto', setupErr: setupErr ?? null, modelProgress });
        return;
      }
      const active = storefront.getActive();
      const [bU, bE] = await Promise.all([buyer.tokenBalance(cfg.usdtAddress), buyer.ethBalance()]);
      json(res, 200, {
        wallet: w,
        buyer: { address: buyer.address, usdt: formatUnits(bU, DEC), eth: formatUnits(bE, 18) },
        cloudBytes: 0,
        spent: formatUnits(policy.spent, DEC),
        budget: formatUnits(MAX_BUDGET, DEC),
        sellerModel: active?.model ?? null,
        price: active ? formatUnits(active.priceBaseUnits, DEC) : null,
        peer: active ? offerJson(active) : null,
        sellersOnline: storefront.list().filter((o: any) => o.online).length,
        selected: storefront.selectedId(),
        escrow: !!escrowDep,
        sessions: storefront.sessions().map((s: any) => ({
          seller: s.seller,
          deposit: formatUnits(BigInt(s.deposit), DEC),
          spent: formatUnits(BigInt(s.cumulative), DEC),
          remaining: formatUnits(BigInt(s.remaining), DEC),
        })),
        ready: !setupErr,
        setupErr: setupErr ?? null,
        modelProgress,
      });
      return;
    }

    // ---------- marketplace ----------
    if (req.method === 'GET' && p === '/api/sellers') {
      if (!storefront) { json(res, 200, { sellers: [], selected: 'auto' }); return; }
      json(res, 200, { sellers: storefront.list().map(offerJson), selected: storefront.selectedId() });
      return;
    }
    if (req.method === 'POST' && p === '/api/select') {
      if (!storefront) { json(res, 409, { error: 'wallet locked' }); return; }
      const { id } = await readBody(req);
      const active = storefront.select(id || 'auto');
      json(res, 200, { ok: true, selected: storefront.selectedId(), active: active ? offerJson(active) : null });
      return;
    }

    // ---------- seller mode ----------
    if (req.method === 'GET' && p === '/api/seller/status') {
      json(res, 200, seller.status());
      return;
    }
    if (req.method === 'GET' && p === '/api/seller/profile') {
      json(res, 200, sellerProfile());
      return;
    }
    if (req.method === 'POST' && p === '/api/seller/start') {
      if (!wallet) { json(res, 401, { error: 'wallet locked' }); return; }
      const { model } = await readBody(req); // optional: the seller's chosen model (else the prober's pick)
      try { json(res, 200, await seller.start(wallet.mnemonic, typeof model === 'string' ? model : undefined)); }
      catch (e: any) { json(res, 500, { error: String(e?.message ?? e) }); }
      return;
    }
    if (req.method === 'POST' && p === '/api/seller/stop') {
      await seller.stop();
      json(res, 200, { ok: true });
      return;
    }

    // ---------- ask ----------
    if (req.method === 'POST' && p === '/api/ask') {
      const { prompt } = await readBody(req);
      if (!prompt || !String(prompt).trim()) { json(res, 400, { error: 'empty prompt' }); return; }
      if (!wallet) { json(res, 401, { error: 'wallet locked' }); return; }
      const a = getAgent();
      if (!a) { json(res, 503, { error: setupErr ?? 'engine still warming up' }); return; }
      try {
        const r = await a.ask(String(prompt));
        json(res, 200, {
          source: r.source, reason: r.reason ?? null, answer: r.answer, note: r.note ?? null,
          cost: formatUnits(r.cost, DEC),
          model: r.model ?? null,
          healthWorker: r.healthWorker ?? null,
          // Provenance the asker's screen shows: a person approved this, and how long they took.
          approvedByHuman: r.approvedByHuman ?? false,
          edited: r.edited ?? false,
          reviewMs: r.reviewMs ?? null,
          draftMs: r.draftMs ?? null,
          disclaimer: MEDICAL_DISCLAIMER,
          stats: { ttftMs: r.stats?.ttftMs ?? null, tps: r.stats?.tps ?? null },
        });
      } catch (e: any) { json(res, 500, { error: String(e?.message ?? e) }); }
      return;
    }

    if (req.method === 'GET') { serveApp(res, p); return; }
    res.writeHead(404); res.end('not found');
  })();
});

server.listen(PORT, () => {
  const built = existsSync(path.join(appDist, 'index.html'));
  const w = walletStatus();
  console.log(`\n  ⬡ MedConsult — open  →  http://localhost:${PORT}\n`);
  console.log(`  wallet: ${w.unlocked ? `unlocked ${w.address}` : w.exists ? 'locked (enter password)' : 'none yet (create or import in the app)'}`);
  if (!built) console.log('  note: React app not built — run `npm run app:build` for the UI (showing a build prompt until then).');
  console.log('  warming up the local model…\n');
});

async function shutdown() {
  try { await seller.stop(); } catch {}
  try { lock(); } catch {}
  try { await sdk.close?.(); } catch {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
