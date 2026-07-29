// The asker's agent — sends a health question to a paid health-worker peer and returns the
// human-approved answer.
//
// Fork note (vs upstream Conduit): upstream's market agent was an "answer-free-or-pay-to-escalate"
// brain. It ran a local 0.6B draft, measured self-consistency in the confidence router, and only
// paid a peer when the local model looked unsure. That whole branch is gone here, because the
// asker's device carries NO model at all — there is nothing to draft with and nothing to be
// confident about. Every consult is a direct, paid request to a health worker.
//
// What survives, deliberately, is the SpendPolicy: the router only ever *recommended* paying, and
// the policy was always the thing that authorised it. It is still the only thing that authorises
// it — a per-call cap plus a session budget, so a compromised or chatty peer cannot drain a wallet.
import type { SpendPolicy } from './policy';
import type { Storefront } from './storefront';

export interface ConsultResult {
  source: 'consult' | 'declined';
  /** Why no consult happened. 'no-peer' = no health worker online; 'budget' = spend policy refused;
   *  'rejected' = a human reviewed the draft and declined to send it; 'error' = the round-trip failed. */
  reason?: 'no-peer' | 'budget' | 'rejected' | 'error';
  answer: string;
  cost: bigint;
  note?: string;
  model?: string;
  healthWorker?: string; // the health worker's earnings address
  approvedByHuman?: boolean;
  edited?: boolean;
  reviewMs?: number;
  draftMs?: number;
  stats?: { ttftMs?: number; tps?: number; promptTokens?: number };
}

export interface MarketAgentDeps {
  policy: SpendPolicy;
  storefront: Storefront;
  log?: (m: string) => void;
}

export interface MarketAgent {
  ask(prompt: string): Promise<ConsultResult>;
}

export function createMarketAgent(deps: MarketAgentDeps): MarketAgent {
  const log = deps.log ?? (() => {});
  return {
    async ask(prompt: string): Promise<ConsultResult> {
      const worker = deps.storefront.getActive();
      if (!worker) {
        return {
          source: 'declined',
          reason: 'no-peer',
          answer: '',
          cost: 0n,
          note: 'No health worker is online to take this consult. This device has no medical model of its own, so there is nothing to fall back to.',
        };
      }

      const verdict = deps.policy.check(worker.priceBaseUnits);
      if (!verdict.ok) {
        return {
          source: 'declined',
          reason: 'budget',
          answer: '',
          cost: 0n,
          note: `${verdict.reason} — no consult was sent and nothing was charged`,
        };
      }

      try {
        log(`[asker] sending consult to health worker ${worker.sellerWallet.slice(0, 10)}… (${worker.model})`);
        const res = await deps.storefront.purchase(worker, prompt);
        deps.policy.record(res.cost);
        return {
          source: 'consult',
          answer: res.answer,
          cost: res.cost,
          model: res.model,
          healthWorker: res.sellerWallet,
          approvedByHuman: res.approvedByHuman,
          edited: res.edited,
          reviewMs: res.reviewMs,
          draftMs: res.draftMs,
          stats: res.stats,
        };
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        // A human declining to send a draft is a legitimate outcome, not a failure — and the asker
        // must be told plainly that a person looked at this and chose not to answer.
        const rejected = e?.stage === 'human' || /did not approve/i.test(msg);
        return {
          source: 'declined',
          reason: rejected ? 'rejected' : 'error',
          answer: '',
          cost: 0n,
          note: rejected
            ? 'A health worker reviewed this consult and chose not to send an answer. You were not charged.'
            : `The consult did not complete (${msg}). You were not charged.`,
        };
      }
    },
  };
}
