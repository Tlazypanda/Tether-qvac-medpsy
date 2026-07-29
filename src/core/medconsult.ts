// Med-consult fork constants — the single source of truth for the model, the DHT topic, the
// clinical system prompt, and the disclaimer copy. Everything user-visible about the medical
// framing lives here so the CLI, the engine and both UIs cannot drift apart.
//
// Fork note (vs upstream Conduit): upstream serves general-purpose Qwen3 tiers on the
// `conduit:market:v1` topic. We serve exactly one model — QVAC MedPsy-4B — on our own topic.

/**
 * QVAC MedPsy-4B, Q4_K_M (imatrix). Preconfigured in `@qvac/sdk`'s model registry as
 * `HEALTHCARE_4B_MEDICAL_Q4_K_M` → `registry://hf/qvac/MedPsy-4B-GGUF/…/medpsy-4b-q4_k_m-imat.gguf`
 * (~2.7 GB on disk). The registry constant is preferred over a raw Hugging Face URL because it
 * carries a pinned commit sha + sha256 checksum, so every device fetches byte-identical weights.
 *
 * Requires @qvac/sdk >= 0.16.0 (the constant does not exist in the 0.12.x upstream Conduit pinned).
 */
export const MEDPSY_MODEL = 'HEALTHCARE_4B_MEDICAL_Q4_K_M';

/** Human-facing model name for UI/CLI copy (the registry constant is an implementation detail). */
export const MEDPSY_LABEL = 'QVAC MedPsy-4B';

/**
 * Our own Hyperswarm topic. Deliberately NOT `conduit:market:v1` — a distinct topic keeps our
 * testing off the live Conduit marketplace (and keeps real Conduit buyers away from a node that
 * only speaks the consult protocol).
 */
export const MEDCONSULT_TOPIC = 'medconsult:demo:v1';

/**
 * The disclaimer shown on the health worker's approval screen and on the asker's answer screen.
 * Mirrors the tone of QVAC MedPsy's own model card: an assistant, not a doctor.
 */
export const MEDICAL_DISCLAIMER =
  'AI-assisted draft, reviewed by a human health worker before sending. ' +
  'Not a substitute for professional medical care in an emergency.';

/** Shorter variant for tight spaces (CLI banners, chips). */
export const MEDICAL_DISCLAIMER_SHORT = 'AI-assisted · human-reviewed · not emergency care';

/** Testnet framing, carried over from upstream Conduit — no real money, ever. */
export const TESTNET_NOTICE = 'Testnet demonstration only — test USD₮ on Sepolia, no real funds.';

/**
 * System prompt for the draft. Asks for the two things the health worker actually reviews —
 * a severity read and a management plan — and explicitly tells the model a human will check it.
 * Kept deliberately short: MedPsy-4B follows a tight instruction better than a long persona.
 */
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

/** Token budget for a draft — enough for the four sections, short enough to stay fast on camera. */
export const CONSULT_PREDICT_TOKENS = 512;
