// The ASKER node — a community member or health worker whose phone carries NO medical model.
//
// Discovers a health worker on the DHT, opens (or resumes) an escrow payment channel, sends a
// health question over the E2E link, and waits — possibly minutes — for a human to review the
// MedPsy draft on the other device. Prints the approved answer and what it cost.
//
// Fork note (vs upstream Conduit's buy.ts): upstream ran quote → on-chain pay → grant → and then
// delegated inference back to itself through the QVAC provider. There is no delegation here and no
// local model; the answer is drafted, reviewed by a person, and sent as text. See core/protocol.ts.
//
// Run:  CONSULT="my symptoms…" npm run ask
import { loadEnv } from '../core/env';
import { randomSeedHex, publicKeyHexFromSeed } from '../core/identity';
import { MEDCONSULT_TOPIC, MEDICAL_DISCLAIMER, testnetNotice } from '../core/medconsult';
import { discoveryMode } from '../core/swarm';

// Merge `.env` into process.env FIRST. Ordering is load-bearing: CONSULT and CONSUMER_SEED are read
// a few lines below, long before loadConfig() would otherwise have done it, so without this a
// perfectly good `.env` setting is silently ignored.
loadEnv();

void MEDCONSULT_TOPIC; // the topic itself is joined inside the storefront

const CONSULT = process.env.CONSULT || process.env.PROMPT ||
  'I have had a sore throat for four days with a fever of 38.5C and painful swollen glands under my jaw. It hurts to swallow. What should I do?';

// This process's QVAC consumer identity — set before the SDK touches the swarm.
const consumerSeed = process.env.CONSUMER_SEED || randomSeedHex();
const consumerPub = publicKeyHexFromSeed(consumerSeed);
process.env.QVAC_HYPERSWARM_SEED = consumerSeed;

const { loadConfig } = await import('../core/config');
const { getAccount } = await import('../core/wallet');
const { createStorefront } = await import('../buy/storefront');
const { createMarketAgent } = await import('../buy/market-agent');
const { SpendPolicy } = await import('../buy/policy');
const { loadEscrowDeployment } = await import('../core/escrow');
const { makeAudit } = await import('../core/audit');

const cfg = loadConfig();
if (!cfg.mnemonic) {
  console.error('[asker] no wallet mnemonic — set CONDUIT_WALLET_MNEMONIC in .env (TESTNET ONLY)');
  process.exit(1);
}

const escrowDep = loadEscrowDeployment();
if (!escrowDep) {
  console.error('[asker] no escrow deployment — a consult settles over a payment channel.');
  console.error('        set CONDUIT_ESCROW_ADDRESS (+ CONDUIT_CHAIN_ID), or use contracts/deployed.sepolia.json');
  process.exit(1);
}

const asker = await getAccount(cfg.mnemonic, cfg.rpcUrl, 0); // asker wallet = account 0
const audit = makeAudit(process.env.CONDUIT_AUDIT_LOG || 'AUDIT_LOG.asker.jsonl');

// The spend policy survives from upstream unchanged: the only thing that authorises a payment.
const policy = new SpendPolicy(
  BigInt(process.env.MAX_PER_CALL || '100000'),   // 0.1 USD₮ per consult
  BigInt(process.env.MAX_BUDGET || '1000000'),    // 1 USD₮ this session
);

console.log('=== med-consult — ASKER ===');
console.log(testnetNotice(cfg.chainId)); // names the chain we are actually on, not a hardcoded one
console.log(`wallet ${asker.address}`);
console.log('this device carries no medical model — the consult is answered by a health worker peer');
console.log(`discovery: ${discoveryMode()}\n`);

const storefront = await createStorefront({
  buyer: asker,
  signerPhrase: cfg.mnemonic,
  consumerPub,
  rpcUrl: cfg.rpcUrl,
  escrow: escrowDep,
  log: (m) => console.log(m),
  onAwaitingReview: () => console.log('[asker] a health worker is reviewing the draft — waiting for their decision…'),
});

const agent = createMarketAgent({ policy, storefront, log: (m) => console.log(m) });

// Give discovery a moment: the health worker must announce itself on the topic before we can ask.
console.log('[asker] searching for a health worker on the consult topic…');
const DISCOVERY_MS = Number(process.env.DISCOVERY_MS || 30_000);
const t0 = Date.now();
while (!storefront.getActive() && Date.now() - t0 < DISCOVERY_MS) {
  await new Promise((r) => setTimeout(r, 500));
}
const worker = storefront.getActive();
if (!worker) {
  console.error(`[asker] no health worker found in ${DISCOVERY_MS / 1000}s — is \`npm run sell\` running on the other device?`);
  await storefront.close();
  process.exit(1);
}
console.log(`[asker] found health worker ${worker.sellerWallet.slice(0, 10)}… serving ${worker.model} @ ${worker.priceBaseUnits} base-units\n`);
console.log('[asker] consult: ' + CONSULT + '\n');

const res = await agent.ask(CONSULT);

if (res.source === 'consult') {
  console.log('\n' + '─'.repeat(74));
  console.log(res.answer);
  console.log('─'.repeat(74));
  console.log(`⚕ ${MEDICAL_DISCLAIMER}`);
  console.log(
    `\n[asker] approved by a human: ${res.approvedByHuman ? 'YES' : 'no'}` +
    `${res.edited ? ' (they edited the draft before sending)' : ' (sent as drafted)'}` +
    ` · review time ${((res.reviewMs ?? 0) / 1000).toFixed(1)}s · draft time ${((res.draftMs ?? 0) / 1000).toFixed(1)}s`,
  );
  console.log(`[asker] paid ${res.cost} base-units to ${res.healthWorker} · prompt bytes to cloud: 0`);
  audit.log('consult_received', {
    model: res.model,
    role: 'asker',
    approved_by_human: res.approvedByHuman === true,
    edited_by_human: res.edited === true,
    review_ms: res.reviewMs ?? null,
    draft_ms: res.draftMs ?? null,
    cost_base_units: res.cost.toString(),
    health_worker: res.healthWorker,
    cloud_bytes: 0,
  });
  console.log('CONSULT_OK');
} else {
  console.log(`\n[asker] no answer — ${res.reason}: ${res.note}`);
  audit.log('consult_declined', { role: 'asker', reason: res.reason, note: res.note, cost_base_units: '0', cloud_bytes: 0 });
  console.log('CONSULT_DECLINED');
}

await storefront.close();
setTimeout(() => process.exit(res.source === 'consult' ? 0 : 2), 300);
