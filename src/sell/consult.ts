// The health worker's consult queue — local MedPsy drafting + the human-approval state machine.
//
// This is the piece upstream Conduit has no equivalent of. Upstream's provider path is fully
// automatic: payment verifies, the firewall opens, and QVAC streams tokens to the buyer with no
// application code in between. Here a human sits in the middle, so a consult is a small state
// machine that can park indefinitely on `awaiting_review` while a person reads.
//
//   queued → drafting → awaiting_review → (approved | rejected)
//                                       ↘ error
//
// The queue owns the MedPsy model handle and serialises drafting: one 4B generation at a time, so
// a burst of consults can't thrash a phone's unified memory. Everything is in-process and
// transport-agnostic — src/node/sell.ts wires it to the P2P link, src/sell/approval-server.ts
// wires it to the health worker's screen, and a mobile port can reuse it untouched.
import { MEDPSY_MODEL, CONSULT_SYSTEM_PROMPT, CONSULT_PREDICT_TOKENS } from '../core/medconsult';

export type ConsultStage = 'queued' | 'drafting' | 'awaiting_review' | 'approved' | 'rejected' | 'error';

export interface ConsultStats {
  ttftMs?: number;
  tps?: number;
  promptTokens?: number;
  completionTokens?: number;
  backend?: string;
}

export interface Consult {
  id: string;
  question: string;
  askerWallet: string;
  stage: ConsultStage;
  draft: string; // what MedPsy wrote (never mutated by the edit — kept for the audit trail)
  finalAnswer: string; // what the human actually approved (may differ from `draft`)
  edited: boolean;
  error?: string;
  rejectReason?: string;
  receivedAt: number;
  draftStartedAt?: number;
  draftedAt?: number; // draft complete → the human's review clock starts here
  decidedAt?: number;
  draftMs: number;
  reviewMs: number; // wall-clock time the human spent before deciding — logged as evidence
  stats: ConsultStats;
}

/** A consult as the approval UI sees it (no internals, JSON-safe). */
export interface ConsultView extends Omit<Consult, 'stats'> {
  stats: ConsultStats;
  model: string;
}

export interface ConsultQueueDeps {
  sdk: any; // @qvac/sdk
  model?: string; // defaults to MedPsy-4B
  predict?: number;
  log?: (m: string) => void;
  /** Fired on any state change so the UI (SSE) and the P2P layer can react. */
  onChange?: (c: Consult) => void;
  /** Fired as draft tokens arrive, so the health worker watches it write in real time. */
  onDraftDelta?: (c: Consult, delta: string) => void;
}

export interface ConsultQueue {
  /** Load MedPsy so the first consult of the day isn't also the slowest. */
  warm(): Promise<void>;
  ready(): boolean;
  loadError(): string | null;
  submit(id: string, question: string, askerWallet: string): Consult;
  get(id: string): Consult | undefined;
  list(): Consult[];
  /** Human taps Approve & Send. `editedText` overrides the draft when the human changed it. */
  approve(id: string, editedText?: string): Consult | undefined;
  /** Human taps Reject. Nothing is delivered and nothing is charged. */
  reject(id: string, reason?: string): Consult | undefined;
  /** Resolves once the consult leaves `awaiting_review` (i.e. a human decided). */
  waitForDecision(id: string): Promise<Consult>;
  close(): Promise<void>;
}

export function createConsultQueue(deps: ConsultQueueDeps): ConsultQueue {
  const log = deps.log ?? (() => {});
  const model = deps.model ?? MEDPSY_MODEL;
  const predict = deps.predict ?? CONSULT_PREDICT_TOKENS;
  const consults = new Map<string, Consult>();
  const waiters = new Map<string, Array<(c: Consult) => void>>();

  let modelId: unknown = null;
  let loadErr: string | null = null;
  let warming: Promise<void> | null = null;
  // Serialise generations — a 4B model is the biggest thing on the device; two at once will OOM a phone.
  let chain: Promise<void> = Promise.resolve();

  function changed(c: Consult) {
    try { deps.onChange?.(c); } catch { /* a UI listener must never break the queue */ }
  }

  function settle(c: Consult) {
    const ws = waiters.get(c.id);
    if (ws) { waiters.delete(c.id); for (const w of ws) w(c); }
  }

  async function warm(): Promise<void> {
    if (warming) return warming;
    warming = (async () => {
      const t0 = Date.now();
      log(`[health-worker] loading ${model} …`);
      try {
        modelId = await deps.sdk.loadModel({
          modelSrc: deps.sdk[model],
          modelType: 'llm',
          modelConfig: { ctx_size: 8192 },
          onProgress: (p: any) => {
            const pct = Math.floor(Number(p?.percentage ?? 0));
            if (pct % 20 === 0) log(`[health-worker] model download ${pct}%`);
          },
        });
        log(`[health-worker] model ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      } catch (e: any) {
        loadErr = String(e?.message ?? e);
        log(`[health-worker] MODEL LOAD FAILED: ${loadErr}`);
        throw e;
      }
    })();
    return warming;
  }

  async function draft(c: Consult): Promise<void> {
    c.stage = 'drafting';
    c.draftStartedAt = Date.now();
    changed(c);
    try {
      if (!modelId) await warm();
      const run = deps.sdk.completion({
        modelId,
        history: [
          { role: 'system', content: CONSULT_SYSTEM_PROMPT },
          { role: 'user', content: c.question },
        ],
        stream: true,
        // captureThinking:true merged MedPsy's reasoning into the content stream, so the health
        // worker's screen showed a full draft, then a bare `</think>`, then the REAL answer starting
        // over and truncating when it hit the token budget. Measured cost: draft_ms went from ~18s
        // to 95–217s and the delivered answer was cut mid-sentence. We do not display reasoning
        // anywhere, so don't capture it. `stripThinking` below is the belt-and-braces half.
        captureThinking: false,
        kvCache: false, // each consult is independent — no leakage between patients
        generationParams: { predict, reasoning_budget: 0 },
      });
      for await (const ev of run.events) {
        if (ev.type === 'contentDelta') {
          c.draft += ev.text;
          try { deps.onDraftDelta?.(c, ev.text); } catch { /* ignore UI errors */ }
        }
      }
      const final = await run.final.catch(() => null);
      const s = final?.stats ?? {};
      if (!c.draft.trim() && final?.contentText) c.draft = String(final.contentText);
      // Strip once the stream is complete: a partial `</think>` split across two deltas cannot be
      // matched mid-stream, so the live view may flicker, but what the human reviews is clean.
      c.draft = stripThinking(c.draft);
      c.stats = {
        ttftMs: num(s.timeToFirstToken),
        tps: num(s.tokensPerSecond),
        promptTokens: num(s.promptTokens),
        completionTokens: num(s.generatedTokens),
        backend: s.backendDevice ?? undefined,
      };
      c.draftedAt = Date.now();
      c.draftMs = c.draftedAt - (c.draftStartedAt ?? c.draftedAt);
      // The draft is NOT sent anywhere. It parks here until a human decides.
      c.stage = 'awaiting_review';
      c.finalAnswer = c.draft;
      log(`[health-worker] draft ready for ${c.id.slice(0, 8)}… (${c.draftMs} ms, ${c.stats.tps?.toFixed?.(1) ?? '?'} tok/s) — AWAITING HUMAN REVIEW`);
      changed(c);
    } catch (e: any) {
      c.stage = 'error';
      c.error = String(e?.message ?? e);
      c.decidedAt = Date.now();
      log(`[health-worker] draft failed for ${c.id.slice(0, 8)}…: ${c.error}`);
      changed(c);
      settle(c);
    }
  }

  function num(v: unknown): number | undefined {
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  }

  /**
   * Remove any reasoning block the model still emits into the content stream.
   *
   * Defensive: `captureThinking: false` should prevent this, but a stray `</think>` reaching the
   * approval screen is a bad thing to discover on camera, and worse to deliver to an asker. Handles
   * both a well-formed `<think>…</think>` and the observed half-open case where only the closing tag
   * appears (everything before it was reasoning).
   */
  function stripThinking(text: string): string {
    let out = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
    const close = out.lastIndexOf('</think>');
    if (close !== -1) out = out.slice(close + '</think>'.length);
    return out.replace(/<\/?think>/gi, '').trim();
  }

  return {
    warm,
    ready: () => modelId != null,
    loadError: () => loadErr,

    submit(id, question, askerWallet) {
      const c: Consult = {
        id,
        question,
        askerWallet,
        stage: 'queued',
        draft: '',
        finalAnswer: '',
        edited: false,
        receivedAt: Date.now(),
        draftMs: 0,
        reviewMs: 0,
        stats: {},
      };
      consults.set(id, c);
      changed(c);
      chain = chain.then(() => draft(c)).catch(() => {});
      return c;
    },

    get: (id) => consults.get(id),
    list: () => [...consults.values()].sort((a, b) => b.receivedAt - a.receivedAt),

    approve(id, editedText) {
      const c = consults.get(id);
      if (!c || c.stage !== 'awaiting_review') return undefined;
      const text = (editedText ?? c.draft).trim();
      if (!text) return undefined; // never deliver an empty answer
      c.finalAnswer = text;
      c.edited = text !== c.draft.trim();
      c.stage = 'approved';
      c.decidedAt = Date.now();
      c.reviewMs = c.decidedAt - (c.draftedAt ?? c.decidedAt);
      log(`[health-worker] APPROVED ${c.id.slice(0, 8)}… by human after ${(c.reviewMs / 1000).toFixed(1)}s review${c.edited ? ' (edited)' : ''}`);
      changed(c);
      settle(c);
      return c;
    },

    reject(id, reason) {
      const c = consults.get(id);
      if (!c || c.stage !== 'awaiting_review') return undefined;
      c.stage = 'rejected';
      c.rejectReason = reason?.trim() || 'rejected by health worker';
      c.decidedAt = Date.now();
      c.reviewMs = c.decidedAt - (c.draftedAt ?? c.decidedAt);
      log(`[health-worker] REJECTED ${c.id.slice(0, 8)}… after ${(c.reviewMs / 1000).toFixed(1)}s — ${c.rejectReason}`);
      changed(c);
      settle(c);
      return c;
    },

    waitForDecision(id) {
      const c = consults.get(id);
      if (!c) return Promise.reject(new Error('unknown consult ' + id));
      if (c.stage === 'approved' || c.stage === 'rejected' || c.stage === 'error') return Promise.resolve(c);
      return new Promise<Consult>((resolve) => {
        const arr = waiters.get(id) ?? [];
        arr.push(resolve);
        waiters.set(id, arr);
      });
    },

    async close() {
      try { if (modelId) await deps.sdk.unloadModel({ modelId, clearStorage: false }); } catch { /* shutting down */ }
      modelId = null;
    },
  };
}
