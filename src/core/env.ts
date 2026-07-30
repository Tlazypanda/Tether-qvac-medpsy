// Minimal .env loader (no dependency). Reads KEY=VALUE lines, strips surrounding quotes.
import { readFileSync } from 'node:fs';

/**
 * Parse a `.env` file AND merge it into `process.env`, without overriding anything already set.
 *
 * WHY THE MERGE. This used to only return the parsed object, and `loadConfig()` picked four keys out
 * of it (mnemonic, RPC, USD₮, chain id). Every OTHER setting is read straight off `process.env` by
 * whichever module needs it — `CONDUIT_ESCROW` in src/node/sell.ts, `MEDCONSULT_BOOTSTRAP` in
 * src/core/swarm.ts, `HW_UI_PORT`/`HW_UI_HOST`, `MAX_PER_CALL`/`MAX_BUDGET`, `CONSULT`,
 * `CONDUIT_AUDIT_LOG` … none of which were ever populated. So putting them in `.env` did nothing at
 * all: they only worked if you happened to `export` them in the shell.
 *
 * That is how the health worker ended up advertising an offer with no escrow support while `.env`
 * plainly said `CONDUIT_ESCROW=1`, and the asker was told "this health worker does not accept payment
 * channels" — a confusing message for a setting the operator had clearly configured.
 *
 * Shell wins over the file, matching dotenv's long-standing behaviour, so
 * `MEDCONSULT_BOOTSTRAP=… npm run sell` still overrides whatever `.env` says.
 */
export function loadEnv(path = '.env'): Record<string, string> {
  const out: Record<string, string> = {};
  let txt = '';
  try {
    txt = readFileSync(path, 'utf8');
  } catch {
    return out;
  }
  for (const line of txt.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const i = t.indexOf('=');
    const key = t.slice(0, i).trim();
    const value = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    out[key] = value;
    // An explicit empty value in `.env` means "unset", not "set to empty string" — otherwise a
    // blank `CONDUIT_SEED=` would read as a configured-but-empty seed.
    if (value !== '' && process.env[key] === undefined) process.env[key] = value;
  }
  return out;
}
