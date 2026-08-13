// Generates a small set of simple, consistent tags from a product title —
// e.g. "Toyota Hilux N90 Bracket" -> toyota, hilux, n90, bracket.
//
// This is inherently a curated/dictionary-driven process, not something
// that falls out of pure text processing: item-type words in particular
// often aren't literally in the title at all (a "Ford Ranger lightbar
// mounting kit" might really just be a bracket, and nothing in the text
// says "bracket"). Where the source gives a real category/product_type
// field, pass it in — it's a far more reliable signal for the item-type
// tag than guessing from title nouns, and takes priority. Title-only
// extraction is a fallback, and won't always get the item-type tag right
// when the title doesn't name it directly.
//
// Extend VEHICLE_BRANDS / VEHICLE_MODELS / STOPWORDS / COMPOUND_PHRASES
// as real titles surface gaps — this is meant to be tuned over time, not
// treated as a finished, closed list.

const VEHICLE_BRANDS = new Set([
  "toyota", "ford", "nissan", "isuzu", "mitsubishi", "holden", "mazda",
  "suzuki", "volkswagen", "vw", "jeep", "landrover", "gwm", "ldv",
  "mercedes", "chevrolet", "chevy", "ram", "dodge", "subaru", "hyundai",
  "kia", "bmw", "audi", "volvo", "renault", "peugeot", "citroen",
  "chrysler", "gmc", "honda", "byd",
]);

// Canonical (hyphen-free) model names — a word is checked against this
// set with its own hyphens stripped first (see stripHyphens), so "d-max",
// "dmax", and "d max" (already one token or not depending on the title)
// all resolve the same way instead of silently missing real titles that
// happen to punctuate a model name differently than this list does.
const VEHICLE_MODELS = new Set([
  "hilux", "ranger", "amarok", "navara", "dmax", "triton", "colorado",
  "landcruiser", "cruiser", "prado", "patrol", "wrangler", "defender",
  "bt50", "pajero", "everest", "raptor", "gladiator", "tacoma", "tundra",
  "silverado", "f150", "jimny", "fortuner", "rodeo", "hiace", "sahara",
  "rubicon", "discovery", "pathfinder", "terrain", "xterra", "frontier",
  "canyon", "sierra", "titan", "mux", "shark",
]);

// Filler/marketing words — dropped entirely, never become tags, UNLESS
// they're consumed as part of a COMPOUND_PHRASES match first (e.g. "next"
// and "gen" are filler on their own, but "next gen" together is a real
// generation qualifier and becomes the "next-gen" tag instead).
const STOPWORDS = new Set([
  "next", "gen", "generation", "series", "kit", "set", "pack", "style",
  "edition", "pair", "single", "new", "the", "a", "an", "for", "with",
  "and", "or", "to", "of", "in", "on", "genuine", "replacement",
  "upgrade", "suit", "suits", "fits", "fitting", "type", "model",
  "your", "our", "premium", "quality", "heavy", "duty", "super", "all",
  "inc", "includes", "included", "compatible",
]);

// Multi-word phrases collapsed into one hyphenated tag — checked before
// per-word splitting so they don't also produce separate single-word
// tags. Includes both physical-part phrases (behind-grill, bull-bar) and
// generation/trim qualifiers (next-gen, super-duty, 3rd-gen) — the
// latter matter because that's literally how TrailBait tells otherwise
// identically-named vehicle collections apart (Next Gen Ranger vs Ranger
// Super Duty vs an older Ranger).
//
// Multiple entries can share the same `tag` to cover spelling variants
// a source isn't consistent about — e.g. TrailBait's own site uses both
// "grill" and "grille" depending on the page.
const COMPOUND_PHRASES = [
  { words: ["behind", "grill"], tag: "behind-grill" },
  { words: ["behind", "grille"], tag: "behind-grill" },
  { words: ["bull", "bar"], tag: "bull-bar" },
  { words: ["roof", "rack"], tag: "roof-rack" },
  { words: ["number", "plate"], tag: "number-plate" },
  { words: ["rear", "bar"], tag: "rear-bar" },
  { words: ["side", "step"], tag: "side-step" },
  { words: ["rock", "slider"], tag: "rock-slider" },
  { words: ["snatch", "strap"], tag: "snatch-strap" },
  { words: ["recovery", "point"], tag: "recovery-point" },
  { words: ["tow", "point"], tag: "tow-point" },
  { words: ["light", "bar"], tag: "light-bar" },
  { words: ["next", "gen"], tag: "next-gen" },
  { words: ["super", "duty"], tag: "super-duty" },
  { words: ["all", "new"], tag: "all-new" },
  { words: ["3rd", "gen"], tag: "3rd-gen" },
  { words: ["2nd", "gen"], tag: "2nd-gen" },
  { words: ["first", "aid"], tag: "first-aid" },
  { words: ["fire", "extinguisher"], tag: "fire-extinguisher" },
];

// Chassis/generation codes vary per model and aren't practical to
// enumerate (N70, N80, N90, PX2, GU7, NP300...) — matched as a pattern
// instead: 1-3 letters, 1-3 digits, optional trailing letter.
const CHASSIS_CODE = /^[a-z]{1,3}\d{1,3}[a-z]?$/;

function stripHyphens(word) {
  return word.replace(/-/g, "");
}

function isVehicleWord(word) {
  const key = stripHyphens(word);
  return VEHICLE_BRANDS.has(key) || VEHICLE_MODELS.has(key);
}

function singularize(word) {
  if (word.endsWith("ies") && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith("ses") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss") && word.length > 3) return word.slice(0, -1);
  return word;
}

function tokenize(text) {
  return (text || "")
    .replace(/[™®©]/g, "")
    .replace(/[^a-zA-Z0-9\s-]/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

// Shopify smart collections apply one AND/OR mode to the WHOLE rule set —
// there's no way to express "vendor equals X AND (tag equals A OR tag
// equals B OR tag equals C)" in a single collection. So for categories
// that are naturally an OR of several item-type words (Electrical could
// be a fuse, an isolator, a harness...), a single consolidated category
// tag gets added whenever any trigger word is present, and the smart
// collection rule becomes a plain two-rule AND: vendor + this one tag.
const CATEGORY_TAG_RULES = [
  { category: "electrical", triggers: ["fuse", "isolator", "harness", "wiring", "switch"] },
  { category: "communication", triggers: ["uhf", "aerial", "radio"] },
  { category: "storage", triggers: ["maxtrax", "rack", "tub", "roof-rack"] },
  { category: "safety", triggers: ["first-aid", "fire-extinguisher", "recovery"] },
];

// productType: optional category/product-type string from the source
// (e.g. Shopify's product_type field) — used as the primary item-type
// tag signal when available, ahead of guessing from title nouns.
export function generateTags(title, { productType } = {}) {
  const tags = [];
  const seen = new Set();
  const add = (tag) => {
    const clean = (tag || "").toLowerCase().trim();
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      tags.push(clean);
    }
  };

  const words = tokenize(title);
  const consumed = new Array(words.length).fill(false);
  const brandTags = [];
  const modelTags = [];
  const codeTags = [];
  const otherTags = [];
  const compoundTags = [];

  for (const phrase of COMPOUND_PHRASES) {
    const hyphenatedForm = phrase.words.join("-");
    for (let i = 0; i < words.length; i++) {
      if (consumed[i]) continue;
      // Title already has it as one hyphenated token ("Behind-Grille") —
      // common in real titles, and word-pair matching alone would miss
      // it since there's no word boundary between "behind" and "grille".
      if (words[i] === hyphenatedForm) {
        compoundTags.push(phrase.tag);
        consumed[i] = true;
        continue;
      }
      if (i > words.length - phrase.words.length) continue;
      if (phrase.words.every((w, j) => words[i + j] === w)) {
        compoundTags.push(phrase.tag);
        phrase.words.forEach((_, j) => { consumed[i + j] = true; });
      }
    }
  }

  words.forEach((word, i) => {
    if (consumed[i] || STOPWORDS.has(word)) return;

    const key = stripHyphens(word);

    // Brand/model membership is checked first, regardless of length —
    // short brand codes like "vw" (2 chars) were previously being caught
    // by the short-token noise filter below (meant for things like the
    // "MV"/"MR" trim codes) before ever reaching this check, silently
    // dropping the vendor's own brand tag.
    if (VEHICLE_BRANDS.has(key)) { brandTags.push(key); return; }
    if (VEHICLE_MODELS.has(key)) { modelTags.push(key); return; }

    const isNumber = /^\d+$/.test(word);
    const adjacentToVehicleWord =
      (i > 0 && isVehicleWord(words[i - 1])) ||
      (i < words.length - 1 && isVehicleWord(words[i + 1]));

    // Bare numbers: a 3+ digit number reads as a year/series designator
    // (2026, 300, 250, 1500) and is kept as a code either way. A shorter
    // number (like the "6" in "Shark 6") is only meaningful sitting next
    // to a known brand/model word — on its own it's more likely a pack
    // count or similar noise, so it's dropped.
    if (isNumber) {
      if (word.length >= 3 || adjacentToVehicleWord) codeTags.push(word);
      return;
    }

    // Short 1-2 letter tokens (MV, MR, GU...) are noise UNLESS they sit
    // right next to a recognized brand/model word, in which case they're
    // almost always a trim/generation code (MV Triton, MR Triton).
    if (word.length <= 2) {
      if (adjacentToVehicleWord) codeTags.push(word);
      return;
    }

    if (CHASSIS_CODE.test(word)) { codeTags.push(word); return; }
    otherTags.push(singularize(word));
  });

  // Order: brand, model, chassis/generation code, item type, descriptors
  // — matches how these tags are actually used for filtering/collections,
  // and keeps output consistent across products regardless of how the
  // title happened to be worded.
  brandTags.forEach(add);
  modelTags.forEach(add);
  codeTags.forEach(add);

  if (productType) {
    tokenize(productType).forEach((w) => {
      if (!STOPWORDS.has(w) && w.length > 2) add(singularize(w));
    });
  } else {
    otherTags.forEach(add);
  }

  compoundTags.forEach(add);

  for (const rule of CATEGORY_TAG_RULES) {
    if (rule.triggers.some((t) => seen.has(t))) add(rule.category);
  }

  return tags;
}
