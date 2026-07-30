// MedPsy-4B on the health worker's phone, plus the approval state machine.
//
// This is the mobile counterpart of src/sell/consult.ts. That file was deliberately written
// transport-agnostic ("a mobile port can reuse it untouched"), and the state machine here is the same
// one — queued → drafting → awaiting_review → approved | rejected, with the draft parking
// indefinitely on awaiting_review because a human is reading it.
//
// The difference is where inference runs. On desktop the queue owns a modelId from a Node-side
// @qvac/sdk. Here @qvac/sdk resolves its `#rpc` import to expo-rpc-client, so loadModel/completion
// transparently drive the SDK's OWN Bare worklet. We do NOT load the model in our P2P worklet — two
// copies of a 2.7 GB model in one process would OOM a phone instantly.
//
// Generations are serialised for the same reason: one 4B decode at a time.
import { useCallback, useEffect, useRef, useState } from 'react';
import { CONSULT_PREDICT_TOKENS, CONSULT_SYSTEM_PROMPT, MEDPSY_MODEL } from './medconsult';

export type Stage = 'queued' | 'drafting' | 'awaiting_review' | 'approved' | 'rejected' | 'error';

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
  stage: Stage;
  /** What MedPsy wrote — never mutated by an edit, so the audit trail survives. */
  draft: string;
  /** What the human actually approved; may differ from `draft`. */
  finalAnswer: string;
  edited: boolean;
  error?: string;
  rejectReason?: string;
  receivedAt: number;
  draftedAt?: number;
  decidedAt?: number;
  draftMs: number;
  reviewMs: number;
  stats: ConsultStats;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Remove any reasoning block that leaks into the content stream. Mirrors stripThinking() in
 * src/sell/consult.ts — with captureThinking:true the desktop build showed a full draft, a bare
 * `</think>`, then the real answer starting over and truncating. Keep the two in step.
 */
function stripThinking(text: string): string {
  let out = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const close = out.lastIndexOf('</think>');
  if (close !== -1) out = out.slice(close + '</think>'.length);
  return out.replace(/<\/?think>/gi, '').trim();
}

export function useMedPsy() {
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadPct, setLoadPct] = useState(0);
  const [consults, setConsults] = useState<Consult[]>([]);

  const sdkRef = useRef<any>(null);
  const modelIdRef = useRef<unknown>(null);
  // Serialise decodes; a burst of consults must not thrash unified memory.
  const chainRef = useRef<Promise<void>>(Promise.resolve());

  /**
   * Mirror of `consults` that is always up to date synchronously.
   *
   * WHY: approve()/reject() must RETURN the decided consult, because the caller immediately hands it
   * to the P2P worklet to deliver. React does not run a `setState(fn)` updater synchronously, so
   * reading the result from inside the updater returns null and the answer never gets sent — i.e.
   * tapping "Approve & Send" would appear to do nothing. So decisions are computed off this ref and
   * the state update is derived from it.
   */
  const ref = useRef<Consult[]>([]);

  const commit = useCallback((next: Consult[]) => {
    ref.current = next;
    setConsults(next);
  }, []);

  const patch = useCallback(
    (id: string, up: Partial<Consult>) => {
      commit(ref.current.map((c) => (c.id === id ? { ...c, ...up } : c)));
    },
    [commit],
  );

  // Warm the model on mount so the first consult of the day is not also the slowest.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const sdk: any = await import('@qvac/sdk');
        sdkRef.current = sdk;
        const modelId = await sdk.loadModel({
          modelSrc: sdk[MEDPSY_MODEL],
          modelType: 'llm',
          modelConfig: { ctx_size: 8192 },
          onProgress: (p: any) => {
            if (!cancelled) setLoadPct(Math.floor(Number(p?.percentage ?? 0)));
          },
        });
        if (cancelled) return;
        modelIdRef.current = modelId;
        setReady(true);
      } catch (e: any) {
        if (!cancelled) setLoadError(String(e?.message ?? e));
      }
    })();
    return () => {
      cancelled = true;
      const sdk = sdkRef.current;
      const modelId = modelIdRef.current;
      if (sdk && modelId) sdk.unloadModel({ modelId, clearStorage: false }).catch(() => {});
    };
  }, []);

  /** A consult arrived over P2P. Queue it and start drafting; nothing is sent anywhere yet. */
  const submit = useCallback(
    (id: string, question: string, askerWallet: string) => {
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
      commit([c, ...ref.current]);

      chainRef.current = chainRef.current.then(() => draft(c)).catch(() => {});
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [commit],
  );

  async function draft(c: Consult) {
    const startedAt = Date.now();
    patch(c.id, { stage: 'drafting' });
    try {
      const sdk = sdkRef.current;
      if (!sdk || !modelIdRef.current) throw new Error('MedPsy is not loaded yet');

      const run = sdk.completion({
        modelId: modelIdRef.current,
        history: [
          { role: 'system', content: CONSULT_SYSTEM_PROMPT },
          { role: 'user', content: c.question },
        ],
        stream: true,
        // See stripThinking() above — capturing reasoning merged it into the draft, blew the token
        // budget and truncated the real answer. We never display reasoning, so don't capture it.
        captureThinking: false,
        kvCache: false, // each consult is independent — no leakage between patients
        generationParams: { predict: CONSULT_PREDICT_TOKENS, reasoning_budget: 0 },
      });

      let text = '';
      for await (const ev of run.events) {
        if (ev.type === 'contentDelta') {
          text += ev.text;
          // Stream into the UI so the health worker watches it write, as on desktop.
          patch(c.id, { draft: text });
        }
      }
      const final = await run.final.catch(() => null);
      const s = final?.stats ?? {};
      if (!text.trim() && final?.contentText) text = String(final.contentText);
      text = stripThinking(text);

      const draftedAt = Date.now();
      patch(c.id, {
        draft: text,
        finalAnswer: text,
        draftedAt,
        draftMs: draftedAt - startedAt,
        stats: {
          ttftMs: num(s.timeToFirstToken),
          tps: num(s.tokensPerSecond),
          promptTokens: num(s.promptTokens),
          completionTokens: num(s.generatedTokens),
          backend: s.backendDevice ?? undefined,
        },
        // The draft stops here. It is NOT sent — it waits for a person.
        stage: 'awaiting_review',
      });
    } catch (e: any) {
      patch(c.id, { stage: 'error', error: String(e?.message ?? e), decidedAt: Date.now() });
    }
  }

  /**
   * Human tapped Approve & Send. `editedText` overrides the draft when they changed it.
   * Returns the decided consult so the caller can deliver it, or null if it was not reviewable.
   */
  const approve = useCallback(
    (id: string, editedText?: string): Consult | null => {
      const c = ref.current.find((x) => x.id === id);
      if (!c || c.stage !== 'awaiting_review') return null;
      const text = (editedText ?? c.draft).trim();
      if (!text) return null; // never deliver an empty answer
      const decidedAt = Date.now();
      const decided: Consult = {
        ...c,
        finalAnswer: text,
        edited: text !== c.draft.trim(),
        stage: 'approved',
        decidedAt,
        reviewMs: decidedAt - (c.draftedAt ?? decidedAt),
      };
      commit(ref.current.map((x) => (x.id === id ? decided : x)));
      return decided;
    },
    [commit],
  );

  /** Human tapped Reject. Nothing is delivered and nothing is charged. */
  const reject = useCallback(
    (id: string, reason?: string): Consult | null => {
      const c = ref.current.find((x) => x.id === id);
      if (!c || c.stage !== 'awaiting_review') return null;
      const decidedAt = Date.now();
      const decided: Consult = {
        ...c,
        stage: 'rejected',
        rejectReason: reason?.trim() || 'rejected by health worker',
        decidedAt,
        reviewMs: decidedAt - (c.draftedAt ?? decidedAt),
      };
      commit(ref.current.map((x) => (x.id === id ? decided : x)));
      return decided;
    },
    [commit],
  );

  return { ready, loadError, loadPct, consults, submit, approve, reject };
}
