// Authoritative US ZIP → { city, state, name } resolver for the brain.
//
// Why this exists: Facebook's location autocomplete is unreliable for a bare
// 5-digit ZIP (it returns same-ZIP cities in Brazil/Italy, jams the check-in
// count onto the state, throttles rapid lookups). Instead of parsing that mess,
// the system KNOWS the real city+state for every ZIP and tells the extension to
// type the exact "City, ST" — which Facebook autocompletes cleanly, every time.
//
// State is derived instantly from USPS 3-digit prefix ranges (offline, covers
// every US ZIP). City is fetched once from a free API and cached in the DB, so
// each ZIP hits the network at most once and is known forever after.
const db = require('./db');

// USPS ZIP 3-digit prefix → state (complete map of allocated ranges).
const PREFIX = [
  [5, 5, 'NY'], [10, 27, 'MA'], [28, 29, 'RI'], [30, 38, 'NH'], [39, 49, 'ME'], [50, 59, 'VT'],
  [60, 69, 'CT'], [70, 89, 'NJ'], [100, 149, 'NY'], [150, 196, 'PA'], [197, 199, 'DE'],
  [200, 205, 'DC'], [206, 219, 'MD'], [220, 246, 'VA'], [247, 268, 'WV'], [270, 289, 'NC'],
  [290, 299, 'SC'], [300, 319, 'GA'], [320, 349, 'FL'], [350, 369, 'AL'], [370, 385, 'TN'],
  [386, 397, 'MS'], [398, 399, 'GA'], [400, 427, 'KY'], [430, 459, 'OH'], [460, 479, 'IN'],
  [480, 499, 'MI'], [500, 528, 'IA'], [530, 549, 'WI'], [550, 567, 'MN'], [570, 577, 'SD'],
  [580, 588, 'ND'], [590, 599, 'MT'], [600, 629, 'IL'], [630, 658, 'MO'], [660, 679, 'KS'],
  [680, 693, 'NE'], [700, 714, 'LA'], [716, 729, 'AR'], [730, 749, 'OK'], [750, 799, 'TX'],
  [800, 816, 'CO'], [820, 831, 'WY'], [832, 838, 'ID'], [840, 847, 'UT'], [850, 865, 'AZ'],
  [870, 884, 'NM'], [885, 885, 'TX'], [889, 898, 'NV'], [900, 961, 'CA'], [967, 968, 'HI'],
  [970, 979, 'OR'], [980, 994, 'WA'], [995, 999, 'AK'],
];
const STATE_NAME = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho',
  IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
  ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada',
  NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina',
  ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas',
  UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia',
  WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia',
};

function normalizeZip(value) {
  const m = String(value || '').match(/\b\d{5}\b/);
  return m ? m[0] : '';
}

// State from ZIP, offline and authoritative. Never returns a foreign state.
function stateForZip(zip) {
  const p = parseInt(String(zip || '').slice(0, 3), 10);
  if (!Number.isFinite(p)) return '';
  const hit = PREFIX.find(([lo, hi]) => p >= lo && p <= hi);
  return hit ? hit[2] : '';
}

// Fetch the city for a ZIP from the free zippopotam.us API (no key). Uses the
// global fetch (Node 18+); returns '' on any failure so the caller falls back to
// state-only. The backend/worker can reach the internet even where the FB page
// context cannot reach localhost.
async function fetchCity(zip) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(`https://api.zippopotam.us/us/${zip}`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return { city: '', state: '' };
    const j = await res.json();
    const place = j && j.places && j.places[0];
    if (!place) return { city: '', state: '' };
    return { city: (place['place name'] || '').trim(), state: (place['state abbreviation'] || '').trim() };
  } catch (_) {
    return { city: '', state: '' };
  }
}

// Resolve a ZIP to { zip, city, state, name, full }. Cached in the DB after the
// first lookup. `state` always comes from the offline prefix table (trusted);
// the API only supplies the city. If the API's state disagrees with the prefix
// table, the prefix table wins (it never yields a foreign state).
async function resolveZip(value) {
  const zip = normalizeZip(value);
  if (!zip) return null;

  const cached = db.getZipInfo(zip);
  if (cached && cached.city) return cached;

  const prefixState = stateForZip(zip);
  const api = await fetchCity(zip);
  const state = prefixState || api.state || '';
  const info = {
    zip, city: api.city || '', state,
    name: STATE_NAME[state] || '',
    full: [api.city, state].filter(Boolean).join(', ') + (api.city || state ? ` ${zip}` : zip),
  };
  // Cache only when we have at least a state (so a transient API failure doesn't
  // poison the cache with an empty city we can never refresh).
  if (info.state) db.setZipInfo(zip, info);
  return info;
}

// Synchronous best-effort: cached info if present, else state-only (no network).
function knownZip(value) {
  const zip = normalizeZip(value);
  if (!zip) return null;
  const cached = db.getZipInfo(zip);
  if (cached) return cached;
  const state = stateForZip(zip);
  return state ? { zip, city: '', state, name: STATE_NAME[state] || '', full: `${zip}` } : null;
}

module.exports = { resolveZip, knownZip, stateForZip, normalizeZip, STATE_NAME };
