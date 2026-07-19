// Pure-JavaScript JSON-file data store. No native modules, no compilation —
// works on any Node version without build tools. Data lives in data/fbm.json.
//
// Exposes the same interface the rest of the app expects, so server.js does
// not need to change if storage is swapped out later.
const path = require('path');
const fs = require('fs');

const DATA_DIR  = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'fbm.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

const now = () => Math.floor(Date.now() / 1000);

// ── Load / persist ──────────────────────────────────────────────────────────

const empty = {
  templates: [], listings: [], listing_events: [],
  competitors: [], ai_suggestions: [], post_queue: [], logs: [], schedules: [],
  repost_history: [], debug_snapshots: [], accounts: [], brain_actions: [],
  dispatch_jobs: [], technicians: [],   // scheduling & dispatch: Job Cards + the techs they're sent to
  zip_cache: {},   // "95032" -> { city:"Los Gatos", state:"CA", name:"California" } — resolved once, known forever
  settings: {
    auto_repost: false, ai_rewrite: false,
    // Autonomous orchestrator master switch — OFF by default. When false the
    // brain only observes and recommends; it never enqueues a post on its own.
    autonomous: false,
    brain_max_per_account_per_day: 8,   // hard daily cap per Facebook account
    brain_min_gap_minutes: 25,          // min minutes between posts on one account
    brain_cooldown_hours: 6,            // don't re-post the same template within N hours
    brain_zip_cooldown_hours: 20,       // don't re-post the same ZIP within N hours (anti-duplicate)
    brain_quiet_hours: [],              // e.g. [0,1,2,3,4,5] to pause overnight (local hours)
    product_framing: true,              // rewrite each post's title/desc to read as an item for sale (anti service-ad suspension)
    booking_lead_days: 2,               // chatbot offers appointments starting today+N days
  },
  counters: { templates: 0, listing_events: 0, ai_suggestions: 0, post_queue: 0, logs: 0, schedules: 0, accounts: 0, brain_actions: 0, dispatch_jobs: 0, technicians: 0 },
};

const BAK_FILE = DATA_FILE + '.bak';
let data;
function loadFrom(file) {
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const k of Object.keys(empty)) if (!(k in d)) d[k] = empty[k];
  // NESTED migration: an existing file already has `counters`, so the top-level
  // merge above skips it — any counter added later would be undefined and
  // ++undefined = NaN ids (rows without ids, broken /:id routes). Merge per key.
  for (const k of Object.keys(empty.counters)) if (!(k in d.counters)) d.counters[k] = 0;
  return d;
}
try {
  data = loadFrom(DATA_FILE);
} catch (_) {
  // Main file missing/corrupt — recover from the last good backup before giving up.
  try { data = loadFrom(BAK_FILE); console.warn('[db] recovered from', BAK_FILE); }
  catch (_2) { data = JSON.parse(JSON.stringify(empty)); }
}

// Atomic write: serialize to a temp file, keep a .bak of the last good copy, then
// rename temp → main (rename is atomic on the same volume). A crash mid-write can
// never leave a half-written/corrupt fbm.json.
function writeAtomic() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  try { if (fs.existsSync(DATA_FILE)) fs.copyFileSync(DATA_FILE, BAK_FILE); } catch (_) {}
  fs.renameSync(tmp, DATA_FILE);
}

let saveTimer = null;
function save() {
  // Debounce writes so rapid bulk inserts don't thrash the disk.
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; writeAtomic(); }, 50);
}
function saveNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  writeAtomic();
}

const nextId = (table) => ++data.counters[table];
const byCreatedDesc = (a, b) => b.created_at - a.created_at;

module.exports = {
  // ── Templates ──────────────────────────────────────────────────────────────
  createTemplate: (t) => {
    const row = {
      id:          nextId('templates'),
      title:       t.title,
      price:       t.price != null && t.price !== '' ? Number(t.price) : null,
      location:    t.location || null,
      category:    t.category || null,
      condition:   t.condition || null,
      description: t.description || null,
      photos:      JSON.stringify(t.photos || []),
      created_at:  now(),
    };
    data.templates.push(row);
    saveNow();
    return row;
  },
  getTemplates: () => [...data.templates].sort(byCreatedDesc),
  getTemplate:  (id) => data.templates.find(t => t.id === Number(id)) || null,
  updateTemplate: (id, patch) => {
    const t = data.templates.find(x => x.id === Number(id));
    if (!t) return null;
    if (patch.title       !== undefined) t.title       = patch.title;
    if (patch.price       !== undefined) t.price       = patch.price !== '' && patch.price != null ? Number(patch.price) : null;
    if (patch.location    !== undefined) t.location    = patch.location || null;
    if (patch.category    !== undefined) t.category    = patch.category || null;
    if (patch.condition   !== undefined) t.condition   = patch.condition || null;
    if (patch.description !== undefined) t.description = patch.description || null;
    if (patch.photos      !== undefined) t.photos      = JSON.stringify(patch.photos || []);
    saveNow();
    return t;
  },
  deleteTemplate: (id) => {
    data.templates = data.templates.filter(t => t.id !== Number(id));
    saveNow();
  },

  // ── Listings ───────────────────────────────────────────────────────────────
  upsertListing: (l) => {
    const existing = data.listings.find(x => x.id === l.id);
    if (existing) {
      existing.title     = l.title;
      existing.price     = l.price;
      existing.status    = l.status || existing.status;
      if (l.description) existing.description = l.description; // keep details for republish
      if (l.template_id != null) existing.template_id = l.template_id; // keep source template
      if (l.account_id != null) existing.account_id = l.account_id;    // which account owns it
      if (l.owned != null) existing.owned = !!l.owned;        // only your own listings
      if (l.checked) existing.last_checked = now();           // a fresh scrape counts as a check
      existing.last_seen = now();
    } else {
      data.listings.push({
        id: l.id, title: l.title || '', price: l.price || '',
        description: l.description || '', status: l.status || 'active',
        url: l.url || '', area: l.area || null, template_id: l.template_id || null,
        account_id: l.account_id != null ? l.account_id : null,
        owned: l.owned === true,
        first_seen: now(), last_seen: now(), last_checked: now(),
      });
    }
    save();
  },
  deleteListing: (id) => {
    data.listings = data.listings.filter(l => l.id !== id);
    data.listing_events = data.listing_events.filter(e => e.listing_id !== id);
    saveNow();
  },
  upsertListings(listings) { listings.forEach(l => this.upsertListing(l)); saveNow(); },
  getListings: () => [...data.listings].sort((a, b) => b.last_seen - a.last_seen),
  getListing:  (id) => data.listings.find(l => l.id === id) || null,
  updateListingStatus: (id, status) => {
    const l = data.listings.find(x => x.id === id);
    if (l) { l.status = status; l.last_checked = now(); }
    data.listing_events.push({
      id: nextId('listing_events'), listing_id: id,
      event: 'status_change', detail: status, at: now(),
    });
    saveNow();
  },
  // Only MY OWN active listings that haven't been checked in an hour, capped so
  // the status monitor never opens a storm of verify tabs. Competitor/browse
  // listings the scraper saw are NOT mine and must never be opened/verified.
  getStaleListings: () => data.listings
    .filter(l => l.owned === true && l.status === 'active' && l.last_checked < now() - 3600)
    .sort((a, b) => (a.last_checked || 0) - (b.last_checked || 0))
    .slice(0, 5),
  getListingEvents: (id) => data.listing_events.filter(e => e.listing_id === id).sort((a, b) => b.at - a.at),

  // ── Competitors ──────────────────────────────────────────────────────────────
  upsertCompetitors: (comps) => {
    comps.forEach(c => {
      const existing = data.competitors.find(x => x.id === c.id);
      if (existing) {
        existing.title = c.title; existing.price = c.price; existing.last_seen = now();
      } else {
        data.competitors.push({
          id: c.id, title: c.title || '', price: c.price || '',
          location: c.location || '', url: c.url || '', category: c.category || null,
          first_seen: now(), last_seen: now(),
        });
      }
    });
    saveNow();
  },
  getCompetitors: () => [...data.competitors].sort((a, b) => b.last_seen - a.last_seen).slice(0, 200),

  // ── AI suggestions ────────────────────────────────────────────────────────────
  saveSuggestion: (listingId, templateId, type, text) => {
    data.ai_suggestions.push({
      id: nextId('ai_suggestions'), listing_id: listingId || null,
      template_id: templateId || null, type, suggestion: text, created_at: now(),
    });
    saveNow();
  },
  getSuggestions: () => [...data.ai_suggestions].sort(byCreatedDesc).slice(0, 50),

  // ── Publish queue ─────────────────────────────────────────────────────────────
  createJob: (j) => {
    const row = {
      id: nextId('post_queue'), template_id: j.template_id || null,
      title: j.title, price: j.price || '', description: j.description || '',
      location: j.location || '', category: j.category || '', photos: j.photos || '[]',
      // Authoritative place for this ZIP so the extension types the exact "City, ST"
      // instead of gambling on Facebook's bare-ZIP autocomplete.
      location_city: j.location_city || '', location_state: j.location_state || '', location_full: j.location_full || '',
      delete_url: j.delete_url || null,   // if set, delete this old listing before posting
      delete_only: j.delete_only === true, // if true, just delete delete_url and do NOT post
      account_id: j.account_id != null ? j.account_id : null, // which FB account/profile posts it
      status: 'pending', result: null, created_at: now(), updated_at: now(),
    };
    data.post_queue.push(row);
    saveNow();
    return row;
  },
  // Next pending job. With an accountId, returns only that account's jobs (plus
  // unassigned ones). Without, returns only unassigned jobs (single-account mode).
  getNextJob: (accountId) => {
    const pend = [...data.post_queue].filter(j => j.status === 'pending').sort((a, b) => a.created_at - b.created_at);
    if (accountId != null && accountId !== '') {
      return pend.find(j => String(j.account_id) === String(accountId) || j.account_id == null) || null;
    }
    return pend.find(j => j.account_id == null) || null;
  },
  getJobs:    () => [...data.post_queue].sort(byCreatedDesc).slice(0, 100),
  getJob:     (id) => data.post_queue.find(j => j.id === Number(id)) || null,
  updateJob:  (id, status, result) => {
    const j = data.post_queue.find(x => x.id === Number(id));
    if (j) { j.status = status; j.result = result || null; j.updated_at = now(); }
    saveNow();
  },

  // ── Logs (action + error log from the automation) ─────────────────────────────
  addLog: (entry) => {
    const row = {
      id:      nextId('logs'),
      job_id:  entry.job_id != null ? entry.job_id : null,
      step:    entry.step || '',
      status:  entry.status || 'info',   // info | success | retry | warn | error | block
      detail:  entry.detail || '',
      at:      entry.at || now(),
    };
    data.logs.push(row);
    // Keep only the most recent 2000 log lines.
    if (data.logs.length > 2000) data.logs = data.logs.slice(-2000);
    save();
    return row;
  },
  getLogs: (jobId) => {
    let rows = data.logs;
    if (jobId != null) rows = rows.filter(l => String(l.job_id) === String(jobId));
    return [...rows].sort((a, b) => b.id - a.id).slice(0, 500);
  },
  clearLogs: () => { data.logs = []; saveNow(); },

  // ── Schedules (recurring auto-posting) ────────────────────────────────────────
  createSchedule: (s) => {
    const row = {
      id:           nextId('schedules'),
      name:         s.name || 'Daily auto-post',
      template_ids: Array.isArray(s.template_ids) ? s.template_ids.map(Number) : [],
      times:        Array.isArray(s.times) ? s.times : [],   // ["09:00","18:00"]
      max_per_day:  s.max_per_day != null ? Number(s.max_per_day) : (Array.isArray(s.times) ? s.times.length : 1),
      active:       s.active !== false,
      cursor:       0,            // rotation index into template_ids
      fired:        [],           // ["YYYY-MM-DD HH:MM"] slots already enqueued
      posted_today: 0,
      today:        '',
      created_at:   now(),
    };
    data.schedules.push(row);
    saveNow();
    return row;
  },
  getSchedules: () => [...data.schedules].sort((a, b) => b.created_at - a.created_at),
  getSchedule:  (id) => data.schedules.find(s => s.id === Number(id)) || null,
  updateSchedule: (id, patch) => {
    const s = data.schedules.find(x => x.id === Number(id));
    if (!s) return null;
    Object.assign(s, patch);
    saveNow();
    return s;
  },
  deleteSchedule: (id) => { data.schedules = data.schedules.filter(s => s.id !== Number(id)); saveNow(); },
  saveSchedules: () => saveNow(),

  // ── ZIP cache (authoritative city/state per ZIP; resolved once, kept forever) ──
  getZipInfo: (zip) => { const z = String(zip || '').trim(); return (z && data.zip_cache[z]) || null; },
  setZipInfo: (zip, info) => { const z = String(zip || '').trim(); if (z && info) { data.zip_cache[z] = info; saveNow(); } return info; },
  getZipCache: () => ({ ...data.zip_cache }),

  // ── Settings ──────────────────────────────────────────────────────────────────
  getSettings: () => ({ ...empty.settings, ...data.settings }),
  setSettings: (patch) => { data.settings = { ...data.settings, ...patch }; saveNow(); return module.exports.getSettings(); },

  // ── Repost history (cooldown so we don't loop on a repeatedly-removed item) ────
  addRepost: (templateId) => { data.repost_history.push({ template_id: Number(templateId), at: now() }); saveNow(); },
  countRecentReposts: (templateId, sinceSeconds) =>
    data.repost_history.filter(r => r.template_id === Number(templateId) && r.at >= now() - sinceSeconds).length,

  // ── Debug DOM snapshots (to capture Facebook's real form markup once) ──────────
  addDebug: (snap) => {
    data.debug_snapshots.unshift({ at: now(), ...snap });
    data.debug_snapshots = data.debug_snapshots.slice(0, 60);
    saveNow();
  },
  getDebug: () => data.debug_snapshots,
  clearDebug: () => { data.debug_snapshots = []; saveNow(); },

  // ── Accounts (each = a Facebook account / Chrome profile, owns a ZIP group) ────
  createAccount: (a) => {
    const row = { id: nextId('accounts'), name: a.name || `Account ${data.counters.accounts}`,
      zips: Array.isArray(a.zips) ? a.zips.map(String) : [], active: a.active !== false,
      // Per-account health the brain reads to decide who may post next.
      health: { status: 'ok', last_post_at: 0, last_block_at: 0, posts_today: 0, posts_today_date: '', blocks: 0, last_reason: '' },
      created_at: now() };
    data.accounts.push(row);
    saveNow();
    return row;
  },
  getAccounts: () => [...data.accounts].sort((x, y) => x.id - y.id),
  getAccount:  (id) => data.accounts.find(a => a.id === Number(id)) || null,
  updateAccount: (id, patch) => {
    const a = data.accounts.find(x => x.id === Number(id));
    if (!a) return null;
    if (!a.health) a.health = { status: 'ok', last_post_at: 0, last_block_at: 0, posts_today: 0, posts_today_date: '', blocks: 0, last_reason: '' };
    if (patch.name !== undefined) a.name = patch.name;
    if (patch.zips !== undefined) a.zips = (Array.isArray(patch.zips) ? patch.zips : []).map(String);
    if (patch.active !== undefined) a.active = !!patch.active;
    if (patch.health !== undefined) a.health = { ...a.health, ...patch.health };
    saveNow();
    return a;
  },
  deleteAccount: (id) => { data.accounts = data.accounts.filter(a => a.id !== Number(id)); saveNow(); },
  // Which account owns a given ZIP (first match).
  findAccountForZip: (zip) => {
    if (!zip) return null;
    const z = String(zip).match(/\d{5}/)?.[0];
    if (!z) return null;
    return data.accounts.find(a => a.active && (a.zips || []).some(x => String(x).includes(z))) || null;
  },

  // ── Account health helpers (the brain's memory of each account) ───────────────
  // Count a successful post: bumps today's tally (resetting at date rollover).
  recordAccountPost: (id, dateStr) => {
    const a = data.accounts.find(x => x.id === Number(id));
    if (!a) return;
    if (!a.health) a.health = { status: 'ok', posts_today: 0 };
    if (a.health.posts_today_date !== dateStr) { a.health.posts_today = 0; a.health.posts_today_date = dateStr; }
    a.health.posts_today += 1;
    a.health.last_post_at = now();
    saveNow();
  },
  // Mark an account restricted/blocked so the brain stops using it and fails over.
  markAccountRestricted: (id, reason) => {
    const a = data.accounts.find(x => x.id === Number(id));
    if (!a) return null;
    if (!a.health) a.health = {};
    a.health.status = 'restricted';
    a.health.last_block_at = now();
    a.health.blocks = (a.health.blocks || 0) + 1;
    a.health.last_reason = reason || '';
    saveNow();
    return a;
  },
  clearAccountRestriction: (id) => {
    const a = data.accounts.find(x => x.id === Number(id));
    if (!a) return null;
    if (!a.health) a.health = {};
    a.health.status = 'ok';
    a.health.last_reason = '';
    saveNow();
    return a;
  },

  // ── Brain decision log (audit trail + learning substrate) ─────────────────────
  recordBrainAction: (entry) => {
    const row = {
      id: nextId('brain_actions'),
      kind: entry.kind || 'decision',        // decision | enqueue | keepalive | failover | skip
      account_id: entry.account_id != null ? entry.account_id : null,
      zip: entry.zip || null,
      template_id: entry.template_id != null ? entry.template_id : null,
      reason: entry.reason || '',
      score: entry.score != null ? entry.score : null,
      at: now(),
    };
    data.brain_actions.push(row);
    if (data.brain_actions.length > 2000) data.brain_actions = data.brain_actions.slice(-2000);
    save();
    return row;
  },
  getBrainActions: (limit = 200) => [...data.brain_actions].sort((a, b) => b.id - a.id).slice(0, limit),

  // ── Dispatch jobs (Job Cards: a booked appointment routed to a technician) ────
  createDispatchJob: (j) => {
    const row = {
      id:             nextId('dispatch_jobs'),
      customer_name:  j.customer_name || '',
      phone:          j.phone || '',
      address:        j.address || '',
      city:           j.city || '',
      state:          j.state || '',
      zip:            j.zip || '',
      services:       j.services || '',
      price:          j.price != null && j.price !== '' ? Number(j.price) : null,
      photos:         Array.isArray(j.photos) ? j.photos : [],
      appointment_at: j.appointment_at || '',      // ISO string or '' (unscheduled)
      fb_url:         j.fb_url || '',              // link back to the Marketplace conversation
      notes:          j.notes || '',
      tech_id:        j.tech_id != null ? Number(j.tech_id) : null,
      status:         j.status || 'new',           // new | scheduled | confirmed | dispatched | done | canceled
      customer_confirmed: false,
      confirmed_at:   null,
      created_at:     now(),
      updated_at:     now(),
    };
    data.dispatch_jobs.push(row);
    saveNow();
    return row;
  },
  updateDispatchJob: (id, patch) => {
    const row = data.dispatch_jobs.find(x => x.id === Number(id));
    if (!row) return null;
    const p = patch || {};
    if (p.customer_name  !== undefined) row.customer_name  = p.customer_name || '';
    if (p.phone          !== undefined) row.phone          = p.phone || '';
    if (p.address        !== undefined) row.address        = p.address || '';
    if (p.city           !== undefined) row.city           = p.city || '';
    if (p.state          !== undefined) row.state          = String(p.state || '').toUpperCase();
    if (p.zip            !== undefined) row.zip            = p.zip || '';
    if (p.services       !== undefined) row.services       = p.services || '';
    if (p.price          !== undefined) row.price          = p.price !== '' && p.price != null ? Number(p.price) : null;
    if (p.photos         !== undefined) row.photos         = Array.isArray(p.photos) ? p.photos : [];
    if (p.appointment_at !== undefined) row.appointment_at = p.appointment_at || '';
    if (p.fb_url         !== undefined) row.fb_url         = p.fb_url || '';
    if (p.notes          !== undefined) row.notes          = p.notes || '';
    if (p.tech_id        !== undefined) row.tech_id        = p.tech_id != null && p.tech_id !== '' ? Number(p.tech_id) : null;
    if (p.status         !== undefined) row.status         = p.status || row.status;
    if (p.customer_confirmed !== undefined) row.customer_confirmed = !!p.customer_confirmed;
    if (p.confirmed_at   !== undefined) row.confirmed_at   = p.confirmed_at;
    if (p.confirmation_sms_sent_at !== undefined) row.confirmation_sms_sent_at = p.confirmation_sms_sent_at;
    row.updated_at = now();
    saveNow();
    return row;
  },
  // Soonest appointment first; unscheduled ('' appointment) last, newest of those first.
  getDispatchJobs: () => [...data.dispatch_jobs].sort((a, b) => {
    if (a.appointment_at && b.appointment_at) return a.appointment_at < b.appointment_at ? -1 : (a.appointment_at > b.appointment_at ? 1 : 0);
    if (a.appointment_at) return -1;
    if (b.appointment_at) return 1;
    return b.created_at - a.created_at;
  }),
  getDispatchJob: (id) => data.dispatch_jobs.find(x => x.id === Number(id)) || null,
  deleteDispatchJob: (id) => { data.dispatch_jobs = data.dispatch_jobs.filter(x => x.id !== Number(id)); saveNow(); },

  // ── Technicians (who gets dispatched, by state coverage) ──────────────────────
  addTechnician: (t) => {
    const row = {
      id:     nextId('technicians'),
      name:   t.name || '',
      phone:  t.phone || '',
      states: (Array.isArray(t.states) ? t.states : []).map(s => String(s).trim().toUpperCase()).filter(s => /^[A-Z]{2}$/.test(s)),
      active: t.active !== false,
      notes:  t.notes || '',
      created_at: now(),
    };
    data.technicians.push(row);
    saveNow();
    return row;
  },
  updateTechnician: (id, patch) => {
    const t = data.technicians.find(x => x.id === Number(id));
    if (!t) return null;
    const p = patch || {};
    if (p.name   !== undefined) t.name   = p.name || '';
    if (p.phone  !== undefined) t.phone  = p.phone || '';
    if (p.states !== undefined) t.states = (Array.isArray(p.states) ? p.states : []).map(s => String(s).trim().toUpperCase()).filter(s => /^[A-Z]{2}$/.test(s));
    if (p.active !== undefined) t.active = !!p.active;
    if (p.notes  !== undefined) t.notes  = p.notes || '';
    saveNow();
    return t;
  },
  getTechnicians: () => [...data.technicians].sort((a, b) => a.id - b.id),
  deleteTechnician: (id) => { data.technicians = data.technicians.filter(x => x.id !== Number(id)); saveNow(); },
};
