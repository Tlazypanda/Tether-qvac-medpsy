// Conduit buyer — delegated-inference consumer. Connects to the seller's provider by pubkey and
// runs the real completion ON the seller's GPU over an E2E-encrypted P2P link (weights never move).
// Run as a subprocess:  env CONSUMER_SEED, PROVIDER_PUBKEY, MODEL (constant name), PROMPT, LABEL.
import { randomSeedHex } from '../core/identity';
import { MEDPSY_MODEL } from '../core/medconsult';

const seedHex = process.env.CONSUMER_SEED || randomSeedHex();
const providerPub = (process.env.PROVIDER_PUBKEY || '').trim();
const modelName = process.env.MODEL || MEDPSY_MODEL;
const prompt = process.env.PROMPT || 'In one sentence, what is a stablecoin?';
const fallback = process.env.FALLBACK === '1';
const label = process.env.LABEL || 'buyer';

if (!providerPub) {
  console.log(`RESULT label=${label} outcome=ERROR error="missing PROVIDER_PUBKEY"`);
  process.exit(1);
}
process.env.QVAC_HYPERSWARM_SEED = seedHex;

const sdk: any = await import('@qvac/sdk');
const { loadModel, completion, close } = sdk;
const modelSrc = sdk[modelName];

const t0 = Date.now();
try {
  const modelId = await loadModel({
    modelSrc,
    modelType: 'llm',
    delegate: { providerPublicKey: providerPub, timeout: 60000, fallbackToLocal: fallback },
  });
  const run = completion({ modelId, history: [{ role: 'user', content: prompt }], stream: true });
  let text = '';
  process.stdout.write('answer: ');
  for await (const ev of run.events) {
    if (ev.type === 'contentDelta') {
      text += ev.text;
      process.stdout.write(ev.text);
    }
  }
  process.stdout.write('\n');
  const final = await run.final.catch(() => null);
  const ttft = final?.stats?.timeToFirstToken ?? '';
  const tps = final?.stats?.tokensPerSecond ?? '';
  const totalTokens = final?.stats?.totalTokens ?? '';
  console.log(
    `RESULT label=${label} outcome=GRANTED_SERVED ms=${Date.now() - t0} ttftMs=${ttft} tps=${tps} totalTokens=${totalTokens} answerChars=${text.length}`,
  );
} catch (e: any) {
  const msg = String(e?.message ?? e);
  const rejected = /timeout|connect|firewall|handshake|denied|PEER_CONNECTION|not.*allow/i.test(msg);
  console.log(`RESULT label=${label} outcome=${rejected ? 'REJECTED' : 'ERROR'} ms=${Date.now() - t0} error=${JSON.stringify(msg.slice(0, 140))}`);
} finally {
  try { await close(); } catch {}
  setTimeout(() => process.exit(0), 300);
}
