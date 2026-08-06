// Shared text helpers for product titles across all sources.

// Common acronyms/codes seen in these catalogs that a pure heuristic can't
// reliably distinguish from ordinary words (e.g. RGBW vs MOUNT are both
// "short-ish all-caps" but only one is a code). Checked case-insensitively
// against a word's letters-only core.
const KNOWN_ACRONYMS = new Set([
  "led", "leds", "rgb", "rgbw", "rgba", "uhf", "usb", "gvm", "arb", "diy",
  "oem", "gps", "hid", "pwm", "can", "lcd", "uv", "ac", "dc", "fcs", "ip",
]);

function capitalizeRun(run) {
  if (KNOWN_ACRONYMS.has(run.toLowerCase())) return run.toUpperCase();
  if (run === run.toUpperCase() && run.length <= 3) return run;
  return run.charAt(0).toUpperCase() + run.slice(1).toLowerCase();
}

// Title-cases a string while preserving likely acronyms/codes (LED, RGBW,
// 12V, UHF, etc.). Operates on each contiguous run of letters within a
// token rather than the token as a whole, so punctuation-joined titles
// ("'Angry Eye™'", "Jimny/Tray") capitalize every real word instead of
// just the token's first character. A whole token is left untouched if
// it contains a digit (12V, 2018+, CX6™ all stay exactly as scraped).
export function toTitleCase(str) {
  return (str || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => (/\d/.test(word) ? word : word.replace(/[A-Za-z]+/g, capitalizeRun)))
    .join(" ");
}

// Formats a scraped/fetched product title as "<BRAND> Title Cased Rest".
// Strips any existing brand-name prefix first (case-insensitive, and
// tolerant of a trademark symbol like "ALTIQ™" or "ALTIQ®" directly after
// the name) so a re-fetch doesn't produce "STEDI Stedi Duel Connector..."
// or leave a stray symbol behind as "ALTIQ ™ Rogue...".
export function formatProductTitle(brandCaps, rawTitle) {
  const cased = toTitleCase(rawTitle);
  const escaped = brandCaps.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const withoutPrefix = cased.replace(new RegExp(`^${escaped}[™®©]?\\s*`, "i"), "").trim();
  return withoutPrefix ? `${brandCaps} ${withoutPrefix}` : brandCaps;
}
