// Mirror of src/core/medconsult.ts for the mobile bundle.
//
// KEEP IN SYNC with the engine's copy. It is duplicated rather than imported because Metro's project
// root is mobile/ and reaching outside it needs watchFolders + a shared tsconfig, which buys a
// fragile build for four constants. The same reasoning (and the same warning) applies to the topic
// hardcoded in worklets/consult-worklet.mjs: if these drift, a phone and a laptop stop meeting, or
// worse, the disclaimer wording differs between the two screens in the same demo.
export const MEDPSY_MODEL = 'HEALTHCARE_4B_MEDICAL_Q4_K_M';
export const MEDPSY_LABEL = 'QVAC MedPsy-4B';
export const MEDCONSULT_TOPIC = 'medconsult:demo:v1';

export const MEDICAL_DISCLAIMER =
  'AI-assisted draft, reviewed by a human health worker before sending. ' +
  'Not a substitute for professional medical care in an emergency.';

export const MEDICAL_DISCLAIMER_SHORT = 'AI-assisted · human-reviewed · not emergency care';

export const CONSULT_SYSTEM_PROMPT = [
  'You are assisting a qualified health worker who will review, edit and approve your draft before',
  'it reaches the patient. Draft a concise clinical response to the consult below.',
  '',
  'Structure your reply as:',
  'SEVERITY: one line — how urgent is this, and does it need in-person or emergency care?',
  'ASSESSMENT: two or three sentences on the most likely explanation.',
  'PLAN: 3-5 short bullets of concrete management or self-care steps.',
  'RED FLAGS: symptoms that mean the patient should seek urgent care immediately.',
  '',
  'Be direct and practical. Do not invent specifics the consult did not state.',
  'If the consult is too vague to answer safely, say what you would need to know.',
].join('\n');

export const CONSULT_PREDICT_TOKENS = 512;

/** Chain-aware testnet notice — never claim Sepolia while pointed at a local chain. */
const CHAIN_NAMES: Record<number, string> = {
  11155111: 'Sepolia',
  31337: 'a local Hardhat chain',
};

export function testnetNotice(chainId: number): string {
  const name = CHAIN_NAMES[chainId];
  if (name) return `Testnet demonstration only — test USD₮ on ${name}, no real funds.`;
  return `Demonstration only — test USD₮ on chain ${chainId}. Never point this at mainnet.`;
}

/** Micro-payments are fractions of a cent; two decimals would round them to "0.00". */
export function formatUsdt(baseUnits: string | number, decimals = 6): string {
  const n = Number(baseUnits) / 10 ** decimals;
  if (!Number.isFinite(n)) return '0';
  return n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}
