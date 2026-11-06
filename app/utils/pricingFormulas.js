// One pricing formula per source, extracted from each source's own route
// file into a single shared module. Two places need the exact same
// formula: each source's own "Pricing formula" card (on its tab), and
// the consolidated Settings page — keeping them as separate copies would
// risk the two drifting apart over time. Every export here is used by
// both.

export const DEFAULT_SETTINGS = {
  ALTIQ: { retailMultiplier: 24.5, costRatio: 0.6 },
  TRAILBAIT: { sourceMultiplier: 24, costRatio: 0.6 },
  BUSHDOOF: { costMultiplier: 13.5, retailMarkup: 1.3 },
  STEDI: { sourceMultiplier: 24, costRatio: 0.6 },
  MODS300: { retailMultiplier: 24.5, costRatio: 0.6 },
  ULTRA_VISION: { srpMultiplier: 18 },
  // RMB → ZAR has no public exchange-rate feed behind it (same as every
  // other source's multiplier) — rmbMultiplier is Coenraad's own
  // all-in landed factor (covers FX + shipping + duty), not a live FX
  // rate, and is editable from the Settings page same as any other
  // source's numbers.
  MAGICSTAR: { rmbMultiplier: 6, retailMarkup: 1.5 },
};

// Retail = AUD price x multiplier, rounded up to nearest R99.
// Cost = Retail x costRatio.
export function altiqPricing(priceForeign, settings) {
  const raw = priceForeign * settings.retailMultiplier;
  const retailZar = Math.ceil((raw + 1) / 100) * 100 - 1;
  const costZar = Math.round(retailZar * settings.costRatio * 100) / 100;
  return { retailZar, costZar, priceIsEstimated: true };
}

// Same shape as ALTIQ's, different field name for the multiplier.
export function trailbaitPricing(priceForeign, settings) {
  const raw = priceForeign * settings.sourceMultiplier;
  const retailZar = Math.ceil((raw + 1) / 100) * 100 - 1; // round up to nearest R99
  const costZar = Math.round(retailZar * settings.costRatio * 100) / 100;
  return { retailZar, costZar, priceIsEstimated: true };
}

// Cost-first shape (unlike the others): cost = AUD price x costMultiplier,
// retail = cost x retailMarkup, rounded to the *nearest* R99 (not always
// rounded up).
export function bushdoofPricing(priceForeign, settings) {
  const costZar = Math.round(priceForeign * settings.costMultiplier * 100) / 100;
  const rawRetail = costZar * settings.retailMarkup;
  const retailZar = Math.round((rawRetail + 1) / 100) * 100 - 1; // nearest X99
  return { retailZar, costZar, priceIsEstimated: true };
}

// Same shape as ALTIQ/TrailBait's.
export function stediPricing(priceForeign, settings) {
  const raw = priceForeign * settings.sourceMultiplier;
  const retailZar = Math.ceil((raw + 1) / 100) * 100 - 1;
  const costZar = Math.round(retailZar * settings.costRatio * 100) / 100;
  return { retailZar, costZar, priceIsEstimated: true };
}

// Same shape as ALTIQ's.
export function mods300Pricing(priceForeign, settings) {
  const raw = priceForeign * settings.retailMultiplier;
  const retailZar = Math.ceil((raw + 1) / 100) * 100 - 1;
  const costZar = Math.round(retailZar * settings.costRatio * 100) / 100;
  return { retailZar, costZar, priceIsEstimated: true };
}

// Estimate-only fallback (no landed-cost data — see Ultra Vision's own
// notes): retail = AUD SRP x multiplier, rounded to nearest R x90.
export function ultraVisionPricing(srpForeign, settings) {
  const raw = srpForeign * settings.srpMultiplier;
  const retailZar = Math.round((raw + 10) / 100) * 100 - 10;
  return { retailZar, costZar: null, priceIsEstimated: true };
}

// Cost = RMB price x rmbMultiplier (Coenraad's own landed-cost factor —
// covers FX + shipping/duty, not a live exchange rate).
// Retail = Cost x retailMarkup, rounded to the *nearest* R99 (not always
// rounded up — same rounding style as Bushdoof's formula above).
export function magicstarPricing(priceForeign, settings) {
  const costZar = Math.round(priceForeign * settings.rmbMultiplier * 100) / 100;
  const rawRetail = costZar * settings.retailMarkup;
  const retailZar = Math.round((rawRetail + 1) / 100) * 100 - 1;
  return { retailZar, costZar, priceIsEstimated: false };
}

export const PRICING_FUNCTIONS = {
  ALTIQ: altiqPricing,
  TRAILBAIT: trailbaitPricing,
  BUSHDOOF: bushdoofPricing,
  STEDI: stediPricing,
  MODS300: mods300Pricing,
  ULTRA_VISION: ultraVisionPricing,
  MAGICSTAR: magicstarPricing,
};
