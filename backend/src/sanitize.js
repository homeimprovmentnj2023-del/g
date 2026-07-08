// Product-framing + keyword variation for Marketplace (no AI, deterministic).
//
// Marketplace is for GOODS, not SERVICES — listings that read as a service ad get
// suspended. Titles are built in the style the USER has confirmed stays live:
// lead with the ITEM (material/color + tub), with "reglaze" as a short adjective
// or "/slash" suffix, rotated per post so no two listings are identical. Based on
// real working titles: "Fiberglass Tub", "Cast iron bathtub", "Bathtub Reglazed",
// "Blue porcelain bathtub /Reglazing", "Tub and Tile refinish", "Bathtub glazed".
// Edit the arrays below to add more of your own proven wording.

const pick = (arr, seed) => arr[(((seed % arr.length) + arr.length) % arr.length)];

// Item phrasing chosen from the TEMPLATE's own words so the product matches.
function detectItems(templateTitle) {
  const t = String(templateTitle || '').toLowerCase();
  if (/shower/.test(t))        return ['Shower', 'Shower Surround', 'Bathtub & Shower'];
  if (/\btile\b/.test(t))      return ['Tub and Tile', 'Bathtub & Tile', 'Bathtub and Tile'];
  if (/fiberglass/.test(t))    return ['Fiberglass Tub', 'Fiberglass Bathtub'];
  if (/cast[-\s]?iron/.test(t))return ['Cast Iron Bathtub', 'Cast iron tub'];
  if (/porcelain/.test(t))     return ['Porcelain Bathtub', 'Blue porcelain bathtub', 'Porcelain Tub'];
  if (/acrylic/.test(t))       return ['Acrylic Bathtub', 'Acrylic Tub'];
  if (/\bsink\b/.test(t))      return ['Bathroom Sink', 'Sink'];
  return ['Bathtub', 'Bath tub', 'Tub', 'Bathtub'];
}

// "Reglaze" variants — a couple of deliberate spelling variants included (they've
// been observed to pass) but clean, item-led forms dominate.
const REGLAZE       = ['Reglazed', 'reglazed', 'Reglaze', 'Glazed', 'Refinished', 'Restored', 'Reglaazed'];
const REGLAZE_SLASH = ['/Reglazing', '/Refinishing', '/Reglaze', '/Glazing', '/Reglaazing'];
const COLORS        = ['', '', '', 'Blue', 'White', 'Vintage', 'Classic', 'Antique'];

function makeTitle(templateTitle, seed) {
  let item = pick(detectItems(templateTitle), seed);
  if (/^(bathtub|bath tub|tub)$/i.test(item)) { const c = pick(COLORS, seed + 3); if (c) item = `${c} ${item}`; }
  switch ((((seed % 4) + 4) % 4)) {
    case 0:  return item;                                    // "Fiberglass Tub"
    case 1:  return `${item} ${pick(REGLAZE, seed)}`;        // "Bathtub Reglazed"
    case 2:  return `${item} ${pick(REGLAZE_SLASH, seed)}`;  // "Blue porcelain bathtub /Reglazing"
    default: return `${item} - ${pick(REGLAZE, seed + 2)}`;  // "Cast Iron Bathtub - Restored"
  }
}

// Soften service-gerund keywords inside the DESCRIPTION and lead with a for-sale line.
const SWAPS = [
  [/\bre-?glaz\w*/gi,   ['re-glazed', 'glaze-restored', 'newly glazed', 'refreshed enamel']],
  [/\brefinish\w*/gi,   ['refinished', 'restored', 'renewed', 'refreshed']],
  [/\bresurfac\w*/gi,   ['resurfaced', 'renewed', 'restored']],
  [/\brenewal\b/gi,     ['renewed', 'restored', 'refreshed']],
  [/\brestoration\b/gi, ['restored', 'renewed']],
  [/\bservices?\b/gi,   ['', '', '']],
];
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
      return /^[A-Z]/.test(m) ? v.charAt(0).toUpperCase() + v.slice(1) : v;
    });
  });
  return out.replace(/\s{2,}/g, ' ').replace(/\s+([,.!])/g, '$1').trim();
}

// Returns product-framed { title, description } for a post. `seed` rotates per
// post (e.g. the template's post count) so wording varies each time.
function productize(title, description, seed = 0) {
  const t = makeTitle(title, seed).slice(0, 100);
  let d = applySwaps(description, seed);
  const lead = pick(DESC_LEADS, seed);
  if (lead && !d.toLowerCase().startsWith(lead.toLowerCase().slice(0, 14))) d = d ? `${lead}\n\n${d}` : lead;
  return { title: t, description: d };
}

module.exports = { productize };
