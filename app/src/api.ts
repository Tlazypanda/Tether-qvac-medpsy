// Typed client for the engine API (src/web/server.ts).
// Fork note: upstream had three outcomes — 'local' (free on-device draft), 'paid' (escalated to a
// peer) and 'declined'. This device has no model, so 'local' and 'paid' collapse into a single
// outcome: a 'consult' answered by a health worker peer and approved by a human.
export type Source = 'consult' | 'declined';

export interface Peer {
  id: string;
  address: string;
  model: string;
  price: string;
  tps: number;
  online: boolean;
  served: number; // paid answers this seller has delivered to you
  failed: number; // failed attempts
  successRate: number; // [0,1], neutral 0.5 until there's history
}

export interface WalletStatus {
  exists: boolean;
  unlocked: boolean;
  address: string | null;
}

export interface State {
  wallet: WalletStatus;
  // the fields below are present only once the wallet is unlocked:
  buyer?: { address: string; usdt: string; eth: string };
  cloudBytes?: number;
  spent?: string;
  budget?: string;
  sellerModel?: string | null;
  price?: string | null;
  peer?: Peer | null;
  sellersOnline?: number;
  selected?: string;
  escrow?: boolean; // escrow (payment-channel) mode is enabled on this engine
  sessions?: EscrowSession[]; // open payment channels (instant paid answers)
  ready: boolean;
  setupErr: string | null;
  modelProgress?: ModelProgress;
}

export interface EscrowSession {
  seller: string; // seller wallet address
  deposit: string; // USD₮ locked
  spent: string; // USD₮ drawn so far
  remaining: string; // USD₮ left in the channel
}

export interface ModelProgress {
  phase: 'warming' | 'downloading' | 'ready' | 'error';
  model?: string;
  percentage?: number;
  message?: string;
}

export interface SellersResp {
  sellers: Peer[];
  selected: string;
}

export type DeclineReason = 'no-peer' | 'budget' | 'rejected' | 'error';

export interface AskResult {
  source: Source;
  reason: DeclineReason | null; // why there is no answer, when source === 'declined'
  answer: string;
  note: string | null;
  cost: string;
  model: string | null;
  healthWorker: string | null; // the health worker's earnings address
  // Provenance of the answer — the point of the whole flow.
  approvedByHuman: boolean;
  edited: boolean; // the health worker changed the model's wording before sending
  reviewMs: number | null; // how long the human spent reviewing
  draftMs: number | null; // how long MedPsy took to draft
  disclaimer?: string;
  stats: { ttftMs: number | null; tps: number | null };
  error?: string;
}

export interface SellerStatus {
  running: boolean;
  online: boolean;
  model: string | null;
  price: string | null; // base-units
  tps: number | null;
  address: string | null;
  requestsServed: number;
  earned: string | null; // base-units, on-chain delta since going online
  startedAt: number | null;
  error: string | null;
}

export interface SellerOfferProfile {
  model: string;
  price: string; // human USD₮
  priceBaseUnits: string;
  tps: number;
}

export interface SellableModel {
  id: string;
  loaded: boolean;
  tps: number | null;
  backend: string | null;
  price: string; // human USD₮ for this model tier
}

export interface SellerProfile {
  backend: string | null;
  platform: string | null;
  topSellable: string | null;
  recommended: string | null; // the prober's optimal pick — highlight + pre-select this
  localDraft: string | null;
  ts: string | null;
  offer: SellerOfferProfile | null;
  models: SellableModel[]; // runnable models this machine benchmarked (each with its tiered price)
}

async function postJson(url: string, body: unknown): Promise<any> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `request failed (${r.status})`);
  return data;
}

export async function getState(): Promise<State> {
  const r = await fetch('/api/state');
  if (!r.ok) throw new Error(`state ${r.status}`);
  return r.json();
}

export async function getSellers(): Promise<SellersResp> {
  const r = await fetch('/api/sellers');
  if (!r.ok) throw new Error(`sellers ${r.status}`);
  return r.json();
}

export async function selectSeller(id: string): Promise<void> {
  await postJson('/api/select', { id });
}

export async function ask(prompt: string): Promise<AskResult> {
  const r = await fetch('/api/ask', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt }),
  });
  return r.json();
}

// ---- seller mode ----
export async function getSellerStatus(): Promise<SellerStatus> {
  const r = await fetch('/api/seller/status');
  if (!r.ok) throw new Error(`seller status ${r.status}`);
  return r.json();
}
export async function getSellerProfile(): Promise<SellerProfile> {
  const r = await fetch('/api/seller/profile');
  if (!r.ok) throw new Error(`seller profile ${r.status}`);
  return r.json();
}
export async function startSeller(model?: string): Promise<SellerStatus> {
  return postJson('/api/seller/start', model ? { model } : {});
}
export async function stopSeller(): Promise<void> {
  await postJson('/api/seller/stop', {});
}

// ---- wallet ----
export async function createWallet(password: string): Promise<{ address: string; mnemonic: string }> {
  return postJson('/api/wallet/create', { password });
}
export async function importWallet(mnemonic: string, password: string): Promise<{ address: string }> {
  return postJson('/api/wallet/import', { mnemonic, password });
}
export async function unlockWallet(password: string): Promise<{ address: string }> {
  return postJson('/api/wallet/unlock', { password });
}
export async function lockWallet(): Promise<void> {
  await fetch('/api/wallet/lock', { method: 'POST' });
}
export async function exportWallet(password: string): Promise<string> {
  const d = await postJson('/api/wallet/export', { password });
  return d.mnemonic as string;
}
