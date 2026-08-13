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
  "chrysler", "gmc", "honda",
]);

const VEHICLE_MODELS = new Set([
  "hilux", "ranger", "amarok", "navara", "dmax", "triton", "colorado",
  "landcruiser", "cruiser", "prado", "patrol", "wrangler", "defender",
  "bt50", "pajero", "everest", "raptor", "gladiator", "tacoma", "tundra",
  "silverado", "f150", "jimny", "fortuner", "rodeo", "hiace", "sahara",
  "rubicon", "discovery", "pathfinder", "terrain", "xterra", "frontier",
  "canyon", "sierra", "titan", "ranger-raptor", "landcruiser-79",
]);

// Filler/marketing words — dropped entirely, never become tags.
const STOPWORDS = new Set([
  "next", "gen", "generation", "series", "kit", "set", "pack", "style",
  "edition", "pair", "single", "new", "the", "a", "an", "for", "with",
  "and", "or", "to", "of", "in", "on", "genuine", "replacement",
  "upgrade", "suit", "suits", "fits", "fitting", "type", "model",
  "your", "our", "premium", "quality", "heavy", "duty", "inc",
  "includes", "included", "compatible",
]);

// Multi-word phrases collapsed into one hyphenated tag — checked before
// per-word splitting so they don't also produce separate single-word
// tags. Order in the output follows title position for these.
const COMPOUND_PHRASES = [
  ["behind", "grill"],
  ["bull", "bar"],
  ["roof", "rack"],
  ["number", "plate"],
  ["rear", "bar"],
  ["side", "step"],
  ["rock", "slider"],
  ["snatch", "strap"],
  ["recovery", "point"],
  ["tow", "point"],
  ["light", "bar"],
];

// Chassis/generation codes vary per model and aren't practical to
// enumerate (N70, N80, N90, PX2, GU7, NP300...) — matched as a pattern
// instead: 1-3 letters, 1-3 digits, optional trailing letter.
const CHASSIS_CODE = /^[a-z]{1,3}\d{1,3}[a-z]?$/;

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
    for (let i = 0; i <= words.length - phrase.length; i++) {
      if (consumed[i]) continue;
      if (phrase.every((w, j) => words[i + j] === w)) {
        compoundTags.push(phrase.join("-"));
        phrase.forEach((_, j) => { consumed[i + j] = true; });
      }
    }
  }

  words.forEach((word, i) => {
    if (consumed[i] || STOPWORDS.has(word) || word.length <= 2 || /^\d+$/.test(word)) return;
    if (VEHICLE_BRANDS.has(word)) { brandTags.push(word); return; }
    if (VEHICLE_MODELS.has(word)) { modelTags.push(word); return; }
    if (CHASSIS_CODE.test(word)) { codeTags.push(word); return; }
    otherTags.push(singularize(word));
  });

  // Order: brand, model, chassis code, item type, descriptors — matches
  // how these tags are actually used for filtering/collections, and
  // keeps output consistent across products regardless of how the title
  // happened to be worded.
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

  return tags;
}
