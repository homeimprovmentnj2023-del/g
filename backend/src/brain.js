// The autonomous posting brain — OBSERVE + RECOMMEND layer.
//
// This module is deliberately side-effect free: it reads the data store and
// returns decisions/scores. It never posts, never writes, never enqueues. The
// server exposes it read-only so you can watch what it *would* do before the
// actuation loop (a later, deliberately-gated step) is switched on.
//
// Design notes grounded in the real schema:
//   - Accounts own zips[] and carry health{} (status/posts_today/last_post_at…).
//   - Templates carry a `location` string; the ZIP is derived from it.
//   - Listings link to template_id, have a status + first_seen, and a
//     listing_events history — so we can measure how long listings stay live
//     and how often they're removed (the core performance signal).
//   - Jobs carry template_id + account_id + status — the account success signal.

const db = require('./db');

const HOUR = 3600;
const nowS = () => Math.floor(Date.now() / 1000);
const pad = (n) => String(n).padStart(2, '0');
function todayStr(d = new Date()) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
const zipOf = (s) => (String(s || '').match(/\b(\d{5})\b/) || [])[1] || null;
const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const INACTIVE = new Set(['removed', 'expired', 'pending', 'sold', 'attention']);

// ── Performance: per-template longevity + removal rate → a 0-100 score ─────────
function templateScores() {
  const templates = db.getTemplates();
  const listings = db.getListings();
  const out = {};
  for (const t of templates) {
    out[t.id] = {
      id: t.id, title: t.title, zip: zipOf(t.location), price: t.price,
      live: 0, posted: 0, removed: 0, lifetimesH: [], lastSeen: 0,
    };
  }
  for (const l of listings) {
    const t = l.template_id != null ? out[l.template_id] : null;
    if (!t) continue;
    t.posted += 1;
    if (l.status === 'active') t.live += 1;
    if (INACTIVE.has(l.status)) t.removed += 1;
    t.lastSeen = Math.max(t.lastSeen, l.last_seen || 0);
    // Lifetime: from first_seen to the first removal/expiry event, else "still alive".
    const evs = db.getListingEvents(l.id).sort((a, b) => a.at - b.at);
    const start = l.first_seen || (evs[0] && evs[0].at) || 0;
    const dead = evs.find((e) => e.detail === 'removed' || e.detail === 'expired');
    if (start && dead) t.lifetimesH.push((dead.at - start) / HOUR);
    else if (start && l.status === 'active') t.lifetimesH.push((nowS() - start) / HOUR);
  }
  for (const t of Object.values(out)) {
    const lifeH = median(t.lifetimesH);
    const normLife = Math.min(1, lifeH / (7 * 24));           // cap benefit at ~1 week alive
    const removalRate = t.posted ? t.removed / t.posted : 0;
    // No history yet → neutral 50 so a fresh template still gets tried.
    t.score = t.posted ? Math.round(100 * (0.6 * normLife + 0.4 * (1 - removalRate))) : 50;
    t.medianLifetimeH = Math.round(lifeH);
    t.removalRate = Math.round(removalRate * 100) / 100;
  }
  return out;
}

// ── Account health + publish reliability from job history ─────────────────────
function accountStats() {
  const jobs = db.getJobs();
  const map = {};
  for (const a of db.getAccounts()) {
    const h = a.health || {};
    map[a.id] = {
      id: a.id, name: a.name, active: a.active, zips: (a.zips || []).map(String),
      status: h.status || 'ok',
      postsToday: h.posts_today_date === todayStr() ? (h.posts_today || 0) : 0,
      lastPostAt: h.last_post_at || 0, lastBlockAt: h.last_block_at || 0,
      blocks: h.blocks || 0, lastReason: h.last_reason || '',
      jobsDone: 0, jobsError: 0,
    };
  }
  for (const j of jobs) {
    const a = map[j.account_id];
    if (!a) continue;
    if (j.status === 'done') a.jobsDone += 1;
    else if (j.status === 'error') a.jobsError += 1;
  }
  for (const a of Object.values(map)) {
    const tot = a.jobsDone + a.jobsError;
    a.successRate = tot ? Math.round((a.jobsDone / tot) * 100) / 100 : null;
  }
  return map;
}

// Templates that belong to a ZIP (by their location string). Templates with no
// ZIP in their location are treated as usable for any ZIP (fallback pool).
function templatesForZip(zip, scored) {
  const z = String(zip).match(/\d{5}/)?.[0];
  const all = Object.values(scored);
  const matched = all.filter((t) => t.zip === z);
  return matched.length ? matched : all.filter((t) => !t.zip);
}

// ── Coverage matrix: for each account's ZIP, is a listing live right now? ──────
function coverage() {
  const scored = templateScores();
  const accounts = db.getAccounts();
  const liveZips = new Set();
  for (const l of db.getListings()) {
    if (l.status !== 'active') continue;
    const t = l.template_id != null ? scored[l.template_id] : null;
    const z = (t && t.zip) || zipOf(l.area) || zipOf(l.title);
    if (z) liveZips.add(z);
  }
  const cells = [];
  for (const a of accounts) {
    for (const zip of (a.zips || []).map(String)) {
      const z = zip.match(/\d{5}/)?.[0] || zip;
      const pool = templatesForZip(z, scored);
      cells.push({
        account_id: a.id, account: a.name, zip: z,
        live: liveZips.has(z), gap: !liveZips.has(z),
        templates: pool.length, bestTemplate: pool.sort((x, y) => y.score - x.score)[0]?.id || null,
      });
    }
  }
  const gaps = cells.filter((c) => c.gap).length;
  return { generatedAt: nowS(), totalCells: cells.length, gaps, cells };
}

// Is this account allowed to post right now (health + caps + pacing + quiet hours)?
function accountEligibility(a, cfg) {
  const reasons = [];
  if (!a.active) reasons.push('inactive');
  if (a.status === 'restricted') reasons.push('restricted');
  if (a.postsToday >= cfg.maxPerDay) reasons.push(`daily cap ${cfg.maxPerDay} reached`);
  const gapS = cfg.minGapMin * 60;
  if (a.lastPostAt && nowS() - a.lastPostAt < gapS) reasons.push(`min gap ${cfg.minGapMin}m`);
  const hr = new Date().getHours();
  if (Array.isArray(cfg.quietHours) && cfg.quietHours.includes(hr)) reasons.push('quiet hours');
  return { eligible: reasons.length === 0, reasons };
}

function config() {
  const s = db.getSettings();
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };  // respects 0
  return {
    autonomous: !!s.autonomous,
    maxPerDay: num(s.brain_max_per_account_per_day, 8),
    minGapMin: num(s.brain_min_gap_minutes, 25),
    cooldownH: num(s.brain_cooldown_hours, 6),
    quietHours: Array.isArray(s.brain_quiet_hours) ? s.brain_quiet_hours.map(Number) : [],
  };
}

// ── The plan: ranked, explainable proposals for what to post next ─────────────
// Priority: fill an empty ZIP (a coverage gap) first, using that ZIP's
// best-scoring template that isn't inside its cooldown window.
function plan() {
  const cfg = config();
  const scored = templateScores();
  const accounts = Object.values(accountStats());
  const cov = coverage();
  const gapZips = new Set(cov.cells.filter((c) => c.gap).map((c) => c.zip));

  const proposals = [];
  const eligibility = [];
  for (const a of accounts.sort((x, y) => x.id - y.id)) {
    const el = accountEligibility(a, cfg);
    eligibility.push({ account_id: a.id, account: a.name, ...el, postsToday: a.postsToday, status: a.status });
    if (!el.eligible) continue;

    // Consider this account's ZIPs: gaps first, then everything, best template each.
    const zips = a.zips.map((z) => z.match(/\d{5}/)?.[0] || z);
    const ordered = [...zips].sort((x, y) => (gapZips.has(y) ? 1 : 0) - (gapZips.has(x) ? 1 : 0));
    for (const zip of ordered) {
      const pool = templatesForZip(zip, scored)
        .filter((t) => db.countRecentReposts(t.id, cfg.cooldownH * HOUR) === 0)
        .sort((x, y) => y.score - x.score);
      if (!pool.length) continue;
      const t = pool[0];
      const isGap = gapZips.has(zip);
      proposals.push({
        account_id: a.id, account: a.name, zip, template_id: t.id, template: t.title,
        score: t.score, gap: isGap,
        // Rank score: strongly prefer filling gaps, then template quality.
        rank: (isGap ? 1000 : 0) + t.score,
        reason: isGap ? `ZIP ${zip} has no live listing — fill the gap` : `keep ZIP ${zip} fresh with best template`,
      });
      break; // one proposal per account per plan pass (respects pacing intent)
    }
  }
  proposals.sort((a, b) => b.rank - a.rank);
  return { generatedAt: nowS(), autonomous: cfg.autonomous, config: cfg, proposals, eligibility };
}

// ── Keep-alive: which of MY listings went inactive and want a replacement ─────
function keepAlive() {
  const cfg = config();
  const scored = templateScores();
  const out = [];
  for (const l of db.getListings()) {
    if (!l.owned) continue;
    if (!INACTIVE.has(l.status)) continue;
    if (l.template_id == null) continue;
    const t = scored[l.template_id];
    if (!t) continue;
    if (db.countRecentReposts(l.template_id, cfg.cooldownH * HOUR) > 0) continue; // cooldown
    out.push({
      listing_id: l.id, status: l.status, template_id: l.template_id,
      template: t.title, zip: t.zip, score: t.score,
      reason: `listing ${l.status} — replace to keep ZIP ${t.zip || '?'} covered`,
    });
  }
  return { generatedAt: nowS(), replacements: out };
}

function performance() {
  return {
    generatedAt: nowS(),
    accounts: Object.values(accountStats()),
    templates: Object.values(templateScores()).sort((a, b) => b.score - a.score),
    coverage: coverage(),
  };
}

module.exports = { performance, coverage, plan, keepAlive, config, todayStr, zipOf };
