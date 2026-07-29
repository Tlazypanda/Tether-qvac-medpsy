// Capability Prober — a node benchmarks ITS OWN hardware to decide what it can sell.
//
// Walks a model ladder (small → large): loads each, runs a short completion, records real
// load time + TTFT + tokens/sec + backend (gpu/cpu), then unloads. The largest model that
// loads AND clears a min-tps bar becomes `topSellable`. No pricing here — that's `pricing.ts`.
//
// Fork note: `localDraft` (the smallest model that loaded) is retained in the profile for
// compatibility, but this fork never uses it — the asker carries no model at all, so there is
// no local draft to fall back to. See src/core/medconsult.ts.
//
// Reusable: Phase 3 calls `probe()` to generate storefront offers; `scripts/bench.ts` is the CLI.
import { MEDPSY_MODEL } from './medconsult';

export interface ModelBench {
  id: string;
  loaded: boolean;
  backend?: string;
  ttftMs?: number;
  tps?: number;
  loadMs?: number;
  error?: string;
}

export interface CapabilityProfile {
  ts: string;
  platform: string;
  arch: string;
  backend: string; // 'gpu' | 'cpu' | 'mixed' | 'unknown'
  minSellTps: number;
  models: ModelBench[];
  topSellable: string | null; // largest model id clearing the bar
  localDraft: string | null; // smallest model id that loaded
}

export interface ProbeOptions {
  ladder?: string[]; // model-constant names, ordered small → large
  minSellTps?: number;
  prompt?: string;
  retries?: number; // retries on a download timeout (P2P registry can be flaky)
  log?: (msg: string) => void;
}

// Fork note (vs upstream Conduit): upstream walked a ladder of general-purpose Qwen3/Llama tiers
// and sold the largest one that cleared the bar. A health worker's device serves exactly one
// model — MedPsy-4B — so the "ladder" is a single rung. The prober still earns its keep: it proves
// this device can actually load and run MedPsy at a usable tok/s before the node advertises a
// consult offer it can't honour.
export const DEFAULT_LADDER = [MEDPSY_MODEL];

export async function probe(opts: ProbeOptions = {}): Promise<CapabilityProfile> {
  const log = opts.log ?? (() => {});
  const minSellTps = opts.minSellTps ?? 10;
  const prompt = opts.prompt ?? 'Reply with exactly: ok';
  const ladder = opts.ladder ?? DEFAULT_LADDER;
  const retries = opts.retries ?? 1;

  const sdk: any = await import('@qvac/sdk');
  const results: ModelBench[] = [];

  for (const id of ladder) {
    const modelSrc = sdk[id];
    if (!modelSrc) {
      results.push({ id, loaded: false, error: 'unknown model constant' });
      log(`   ✗ ${id}: unknown constant`);
      continue;
    }
    log(`▶ ${id} …`);
    const tLoad = Date.now();
    try {
      let lastPct = -1;
      const onProgress = (p: any) => {
        const pct = Math.floor((p?.percentage ?? 0) / 20) * 20;
        if (pct !== lastPct) {
          lastPct = pct;
          log(`   download ${pct}%`);
        }
      };
      let modelId: string | undefined;
      for (let attempt = 0; ; attempt++) {
        try {
          modelId = await sdk.loadModel({ modelSrc, modelType: 'llm', onProgress });
          break;
        } catch (e: any) {
          const m = String(e?.message ?? e);
          if (attempt >= retries || !/timeout/i.test(m)) throw e;
          log(`   ⟳ retry ${attempt + 1}/${retries} after: ${m.slice(0, 80)}`);
          lastPct = -1;
        }
      }
      const loadMs = Date.now() - tLoad;
      const run = sdk.completion({ modelId, history: [{ role: 'user', content: prompt }], stream: true });
      for await (const ev of run.events) {
        void ev; // drain to force generation
      }
      const final = await run.final.catch(() => null);
      const bench: ModelBench = {
        id,
        loaded: true,
        loadMs,
        backend: final?.stats?.backendDevice,
        ttftMs: final?.stats?.timeToFirstToken,
        tps: final?.stats?.tokensPerSecond,
      };
      results.push(bench);
      log(`   ✓ backend=${bench.backend ?? '?'} ttft=${bench.ttftMs?.toFixed?.(0) ?? '?'}ms tps=${bench.tps?.toFixed?.(1) ?? '?'} (load ${(loadMs / 1000).toFixed(1)}s)`);
      await sdk.unloadModel({ modelId, clearStorage: false });
    } catch (e: any) {
      const msg = String(e?.message ?? e).slice(0, 160);
      results.push({ id, loaded: false, error: msg });
      log(`   ✗ ${msg}`);
    }
  }

  // ladder is small → large: last sellable entry is the largest sellable model.
  const sellable = results.filter((r) => r.loaded && (r.tps ?? 0) >= minSellTps);
  const topSellable = sellable.length ? sellable[sellable.length - 1]!.id : null;
  const loadedOk = results.filter((r) => r.loaded);
  const localDraft = loadedOk.length ? loadedOk[0]!.id : null;

  const backends = new Set(loadedOk.map((r) => r.backend).filter(Boolean) as string[]);
  const backend = backends.size === 0 ? 'unknown' : backends.size === 1 ? [...backends][0]! : 'mixed';

  return {
    ts: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    backend,
    minSellTps,
    models: results,
    topSellable,
    localDraft,
  };
}
