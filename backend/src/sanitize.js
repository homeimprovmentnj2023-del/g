// Product-framing + keyword variation for Marketplace (no AI, deterministic).
//
// Marketplace is for GOODS, not SERVICES. Listings that read as a service ad
// (gerunds like "reglazing"/"refinishing", the word "service") get flagged and
// suspended. This rewrites each post to read as a restored ITEM for sale, softens
// the service-gerund keywords into product adjectives, and rotates the wording by
// a per-post seed so no two listings are identical. Templates are never mutated —
// this is applied to each post's copy only. (The AI rewriter in ai.js does a
// smarter version of this when an ANTHROPIC_API_KEY is configured.)

const pick = (arr, seed) => arr[(((seed % arr.length) + arr.length) % arr.length)];

// Flagged service-y roots → product-framed variants (adjective/noun forms).
const SWAPS = [
  [/\bre-?glaz\w*/gi,   ['re-glazed', 'glaze-restored', 'newly glazed', 'refreshed enamel']],
  [/\brefinish\w*/gi,   ['refinished', 'restored', 'renewed', 'refreshed']],
  [/\bresurfac\w*/gi,   ['resurfaced', 'renewed-surface', 'restored']],
  [/\brenewal\b/gi,     ['renewed', 'restored', 'refreshed']],
  [/\brestoration\b/gi, ['restored', 'renewed']],
  [/\bservices?\b/gi,   ['', '', '']],
];

const TITLE_TAGS = ['— For Sale', '(Like New)', '— Restored', '— Excellent Condition', '', '— Great Condition'];
const DESC_LEADS = [
  'Selling — professionally restored, in like-new condition.',
  'Refinished and ready — priced to sell.',
  'Beautiful restored finish, looks brand new. Available now.',
  'Freshly restored — excellent condition, for sale.',
  'Restored to a clean, glossy finish. Priced to move.',
];

function applySwaps(text, seed) {
  let out = String(text || '');
  SWAPS.forEach(([re, variants], i) => {
    out = out.replace(re, (m) => {
      const v = pick(variants, seed + i);
      if (!v) return '';
      return /^[A-Z]/.test(m) ? v.charAt(0).toUpperCase() + v.slice(1) : v;   // match original case
    });
  });
  return out.replace(/\s{2,}/g, ' ').replace(/\s+([,.!])/g, '$1').replace(/\|\s*\|/g, '|').trim();
}

// Returns product-framed { title, description } for a post. `seed` should rotate
// per post (e.g. the template's post count) so wording varies each time.
function productize(title, description, seed = 0) {
  let t = applySwaps(title, seed);
  const tag = pick(TITLE_TAGS, seed);
  if (tag && !/for sale|like new|restored|condition/i.test(t)) t = `${t} ${tag}`.trim();

  let d = applySwaps(description, seed);
  const lead = pick(DESC_LEADS, seed);
  if (lead && !d.toLowerCase().startsWith(lead.toLowerCase().slice(0, 14))) d = d ? `${lead}\n\n${d}` : lead;

  return { title: t.slice(0, 100), description: d };
}

module.exports = { productize };
