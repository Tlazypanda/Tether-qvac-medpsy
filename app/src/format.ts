// Small display helpers shared across screens (kept identical to the originals in Rail/Marketplace).

export function fmt(n: string | number | undefined, dp = 2): string {
  const v = Number(n);
  return Number.isFinite(v) ? v.toFixed(dp) : '—';
}

export function short(a: string | null | undefined): string {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—';
}

// HEALTHCARE_4B_MEDICAL_Q4_K_M → "MedPsy 4B"; QWEN3_4B_INST_Q4_K_M → "Qwen3 4B"
// (size tokens like 4B/1.7B stay uppercase)
export function modelName(m: string | null | undefined): string {
  if (!m) return '—';
  // The registry constant for MedPsy is named after its domain, not its brand — map it back.
  const med = /^HEALTHCARE_([\d_]+B)_MEDICAL/i.exec(m);
  if (med) return `MedPsy ${med[1]!.replace(/_/g, '.').toUpperCase()}`;
  const base = m.replace(/_INST.*$/i, '').replace(/_Q\d.*$/i, '').replace(/_/g, ' ').trim();
  if (!base) return m;
  return base
    .toLowerCase()
    .split(' ')
    .map((w) => (/^[\d.]+[a-z]+$/i.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}
