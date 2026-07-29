// `npm run bench` — run the capability prober on this machine and write a profile.
//
//   MIN_SELL_TPS=15 npm run bench         # raise the sellable-speed bar
//   BENCH_LADDER=A,B npm run bench        # benchmark a custom set of model constants
//
// Fork note: upstream benchmarked a ladder of general-purpose Qwen3/Llama tiers. This fork probes
// the one model a health worker serves — MedPsy-4B (~2.7 GB on first run) — to prove the device
// can run it fast enough to advertise consults.
import { writeFile } from 'node:fs/promises';
import { probe, DEFAULT_LADDER, type CapabilityProfile } from '../core/prober';

const ladder = process.env.BENCH_LADDER
  ? process.env.BENCH_LADDER.split(',').map((s) => s.trim()).filter(Boolean)
  : [...DEFAULT_LADDER];
const minSellTps = Number(process.env.MIN_SELL_TPS ?? 10);

console.log('=== med-consult bench — capability prober ===');
console.log('ladder:           ' + ladder.join(' → '));
console.log('min sellable tps: ' + minSellTps);
console.log('');

const profile: CapabilityProfile = await probe({ ladder, minSellTps, log: (m) => console.log(m) });

console.log('\n=== CAPABILITY PROFILE ===');
console.table(
  profile.models.map((m) => ({
    model: m.id,
    loaded: m.loaded,
    backend: m.backend ?? '-',
    ttft_ms: m.ttftMs != null ? Math.round(m.ttftMs) : '-',
    tps: m.tps != null ? Number(m.tps.toFixed(1)) : '-',
    load_s: m.loadMs != null ? Number((m.loadMs / 1000).toFixed(1)) : '-',
    note: m.error ?? '',
  })),
);
console.log('backend:              ' + profile.backend);
console.log('→ consult model:      ' + (profile.topSellable ? profile.topSellable : '(none cleared the bar)'));

const outPath = new URL('../../bench-profile.json', import.meta.url).pathname;
await writeFile(outPath, JSON.stringify(profile, null, 2));
console.log('\nwrote ' + outPath);

// Force a clean exit (dodge the QVAC Bare-worker teardown double-free polluting the exit code).
try {
  const sdk: any = await import('@qvac/sdk');
  await sdk.close();
} catch {
  /* ignore */
}
setTimeout(() => process.exit(0), 200);
