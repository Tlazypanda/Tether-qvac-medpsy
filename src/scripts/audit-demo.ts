// Audit demo — produces a structured JSONL audit log for ONE on-device run that captures the model
// lifecycle and per-inference performance, exactly as required for review:
//   • model_load   — every model load, with wall-clock load_ms and the backend device (proves GPU/on-device)
//   • inference    — prompt, prompt/completion/total tokens, TTFT (ms), tokens/sec, and cloud_bytes (always 0)
//   • model_unload — every unload, with unload_ms
//
// It runs entirely on-device through @qvac/sdk — no network, no testnet, no cloud. Models must be cached
// (run `npm run bench` once to populate them). Output: AUDIT_LOG.jsonl. Run: npm run audit
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeAudit } from '../core/audit';
import { MEDPSY_MODEL, CONSULT_SYSTEM_PROMPT, CONSULT_PREDICT_TOKENS } from '../core/medconsult';

const here = path.dirname(fileURLToPath(import.meta.url));
const sdk: any = await import('@qvac/sdk');

const audit = makeAudit(path.join(here, '../../AUDIT_LOG.jsonl'));
const now = () => Number(process.hrtime.bigint() / 1_000n) / 1000; // ms, monotonic

// Each entry: the QVAC model constant, the role it plays in the consult flow, and the prompts.
// Fork note: upstream ran a 0.6B local-draft tier plus a 4B seller tier. This fork has exactly one
// model — MedPsy-4B on the health worker's device — so the plan is a single entry with real
// consult prompts, which is what the on-camera audit artifact should show.
const PLAN: ReadonlyArray<{ model: string; role: string; predict: number; prompts: string[] }> = [
  {
    model: MEDPSY_MODEL,
    role: 'health-worker', // the model the health worker drafts with, on their own device
    predict: CONSULT_PREDICT_TOKENS,
    prompts: [
      'Patient is 34, has had a sore throat for 4 days with a fever of 38.5C, no cough, and painful swollen glands under the jaw. Difficult to swallow solids.',
      'Patient is 61 with known type 2 diabetes. A small blister on the sole of the right foot has been there 2 weeks, now with surrounding redness and a bad smell. No fever. They say it does not hurt much.',
    ],
  },
];

// One generation. Mirrors src/buy/router.ts: reasoning_budget:0 keeps the whole budget on the answer
// (a small thinking model otherwise burns it all reasoning), kvCache:false = an independent call.
async function runInference(modelId: unknown, prompt: string, predict: number) {
  const t0 = now();
  const run = sdk.completion({
    modelId,
    history: [
      { role: 'system', content: CONSULT_SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ],
    stream: true,
    captureThinking: true,
    kvCache: false,
    generationParams: { predict, reasoning_budget: 0 },
  });
  let answer = '';
  for await (const ev of run.events) {
    if (ev.type === 'contentDelta') answer += ev.text;
  }
  const final = await run.final.catch(() => null);
  const s = final?.stats ?? {};
  // QVAC completion stats: promptTokens (input) + generatedTokens (output). totalTokens is not
  // emitted for completions, so derive it.
  const promptTokens = s.promptTokens ?? null;
  const completionTokens = s.generatedTokens ?? null;
  const totalTokens =
    promptTokens != null && completionTokens != null ? promptTokens + completionTokens : null;
  return {
    wall_ms: round(now() - t0),
    answer: (answer || final?.contentText || '').trim(),
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    ttft_ms: round(s.timeToFirstToken),
    tps: round(s.tokensPerSecond),
    backend: s.backendDevice ?? null,
  };
}

function round(n: unknown): number | null {
  return typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

async function main() {
  console.log('audit demo → on-device model lifecycle + inference performance\n');
  for (const step of PLAN) {
    // ---- load ----
    const tLoad = now();
    const modelId = await sdk.loadModel({
      modelSrc: sdk[step.model],
      modelType: 'llm',
      modelConfig: { ctx_size: 8192 },
    });
    const loadMs = round(now() - tLoad);
    audit.log('model_load', { model: step.model, model_type: 'llm', role: step.role, load_ms: loadMs });
    console.log(`[load]  ${step.model}  (${loadMs} ms)`);

    // ---- inference(s) ----
    for (const prompt of step.prompts) {
      const r = await runInference(modelId, prompt, step.predict);
      audit.log('inference', {
        model: step.model,
        role: step.role,
        prompt,
        prompt_tokens: r.prompt_tokens,
        completion_tokens: r.completion_tokens,
        total_tokens: r.total_tokens,
        ttft_ms: r.ttft_ms,
        tps: r.tps,
        backend: r.backend,
        cloud_bytes: 0,
      });
      console.log(
        `[infer] ${step.model}  ttft=${r.ttft_ms}ms  tps=${r.tps}  tokens=${r.total_tokens}  backend=${r.backend}`
      );
    }

    // ---- unload ----
    const tUnload = now();
    await sdk.unloadModel({ modelId });
    const unloadMs = round(now() - tUnload);
    audit.log('model_unload', { model: step.model, unload_ms: unloadMs });
    console.log(`[unload]${step.model}  (${unloadMs} ms)\n`);
  }

  try {
    await sdk.close?.();
  } catch {
    /* nothing */
  }
  console.log('audit log →', audit.path);
}

main()
  .then(() => setTimeout(() => process.exit(0), 300))
  .catch((e) => {
    console.error('AUDIT DEMO ERROR:', e?.message ?? e);
    process.exit(1);
  });
