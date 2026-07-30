// React Native side of the Bare bridge: starts the packed worklet and turns its newline-delimited
// JSON into typed events. Mirrors Leash's forwardWorklet.ts.
//
// The bundles are BUILD PRODUCTS of `npm run bundle:worklets` — Metro cannot see inside them, so a
// stale bundle keeps running old P2P code with no warning. Rebuild after editing the .mjs.
import { Platform } from 'react-native';

export type WorkletEvent =
  | { type: 'ready'; role?: Role; topic?: string; boot?: boolean }
  | { type: 'peers'; count: number }
  | { type: 'offer'; sellerWallet: string; model: string; priceBaseUnits: string; tps: number; chainId: number }
  | { type: 'stage'; requestId: string; stage: 'drafting' | 'awaiting_review' }
  | { type: 'consult-in'; requestId: string; question: string; askerWallet: string }
  | {
      type: 'answer';
      requestId: string;
      answer: string;
      approvedByHuman: boolean;
      edited: boolean;
      reviewMs: number;
      draftMs: number;
      model: string;
      stats: { ttftMs?: number; tps?: number; backend?: string };
    }
  | { type: 'declined'; requestId: string; reason: string; stage: 'gate' | 'human' | 'error' }
  | { type: 'paid'; requestId: string; cumulative: string }
  | { type: 'error'; error: string };

export type Role = 'asker' | 'health-worker';

/** What the worklet needs to sign a voucher. Assembled in RN, used only inside Bare. */
export interface WalletBundle {
  address: string;
  privateKey: string;
  payee: string;
  epoch: string;
  cumulative?: string;
  voucherDomain: { name: string; version: string; chainId: number; verifyingContract: string };
}

export interface StartOpts {
  role: Role;
  /** LAN-local DHT bootstrap, e.g. [{ host: '192.168.1.50', port: 49737 }]. Omit for the public DHT. */
  bootstrap?: Array<{ host: string; port: number }>;
  wallet?: WalletBundle;
  offer?: {
    sellerWallet: string;
    model: string;
    priceBaseUnits: string;
    tps: number;
    token: string;
    chainId: number;
    escrow?: string;
  };
}

// Loaded as text via Metro's asset handling (see metro.config.js).
const BUNDLE =
  Platform.OS === 'android'
    ? require('../worklets/consult-worklet.android.bundle.js')
    : require('../worklets/consult-worklet.bundle.js');

type Listener = (e: WorkletEvent) => void;

let worklet: any = null;
let ipc: any = null;
const listeners = new Set<Listener>();
let inbuf = '';

function emit(e: WorkletEvent) {
  for (const l of [...listeners]) {
    try {
      l(e);
    } catch {
      /* a UI listener must never break the bridge */
    }
  }
}

function decode(chunk: any): string {
  if (typeof chunk === 'string') return chunk;
  // Bare hands us a Uint8Array; RN has no Buffer.
  return new TextDecoder().decode(chunk);
}

function encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function ensureWorklet() {
  if (worklet) return;
  const { Worklet } = require('react-native-bare-kit');
  worklet = new Worklet();
  worklet.start('/consult.bundle', BUNDLE, []);
  ipc = worklet.IPC;

  ipc.on('data', (chunk: any) => {
    inbuf += decode(chunk);
    const parts = inbuf.split('\n');
    inbuf = parts.pop() || '';
    for (const line of parts) {
      if (!line) continue;
      try {
        emit(JSON.parse(line) as WorkletEvent);
      } catch {
        /* partial or malformed frame — skip it */
      }
    }
  });
}

function write(msg: Record<string, unknown>) {
  ensureWorklet();
  ipc.write(encode(JSON.stringify(msg) + '\n'));
}

export function onWorkletEvent(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Join the consult topic in the given role. Idempotent inside the worklet. */
export function startSwarm(opts: StartOpts) {
  write({ cmd: 'start', ...opts });
}

/** Asker: send a consult. */
export function sendConsult(requestId: string, question: string) {
  write({ cmd: 'consult', requestId, question });
}

/** Health worker: the draft is complete and now waiting on a human. */
export function markAwaitingReview(requestId: string) {
  write({ cmd: 'draft-done', requestId, stage: 'awaiting_review' });
}

/** Health worker: Approve & Send. Delivers the answer and settles the voucher in one step. */
export function approveConsult(args: {
  requestId: string;
  askerWallet: string;
  answer: string;
  edited: boolean;
  reviewMs: number;
  draftMs: number;
  stats?: Record<string, unknown>;
}) {
  write({ cmd: 'approve', ...args });
}

/** Health worker: Reject. Nothing is delivered and nothing is charged. */
export function rejectConsult(requestId: string, reason: string) {
  write({ cmd: 'reject', requestId, reason });
}

export function stopSwarm() {
  if (!worklet) return;
  write({ cmd: 'stop' });
}
