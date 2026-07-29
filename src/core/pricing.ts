// Pricing policy (v1: simple, fixed per model tier). Auction/reputation = roadmap.
// Prices in USD₮ base units (6 decimals): 10_000 = 0.01 USD₮.
import type { CapabilityProfile } from './prober';

/** A reviewed MedPsy consult: 0.01 USD₮. This is what the asker pays the health worker for the
 *  device time + the expert review, not for raw tokens. Same figure as upstream's 4B tier, so the
 *  escrow deposit/claim-threshold arithmetic in sell.ts + storefront.ts is unchanged. */
export const CONSULT_PRICE_BASE_UNITS = 10_000n;

export function priceFor(model: string): bigint {
  if (/HEALTHCARE_4B_MEDICAL/.test(model)) return CONSULT_PRICE_BASE_UNITS; // MedPsy-4B consult
  if (/_8B_/.test(model)) return 20_000n; // 0.02
  if (/_4B_/.test(model)) return 10_000n; // 0.01
  if (/1_7B|TOOL_CALLING_1B/.test(model)) return 5_000n; // 0.005
  return 2_000n; // 0.002
}

export interface Offer {
  model: string;
  priceBaseUnits: bigint;
  tps: number;
}

/** Turn a prober profile into the node's sell offer (its top sellable model + a tiered price). */
export function offerFromProfile(profile: CapabilityProfile): Offer | null {
  if (!profile?.topSellable) return null;
  const m = profile.models?.find((x) => x.id === profile.topSellable);
  return { model: profile.topSellable, priceBaseUnits: priceFor(profile.topSellable), tps: m?.tps ?? 0 };
}
