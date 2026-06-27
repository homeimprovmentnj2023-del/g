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
  competitors: [], ai_suggestions: [], post_queue: [], logs: [],
  counters: { templates: 0, listing_events: 0, ai_suggestions: 0, post_queue: 0, logs: 0 },
};

let data;
try {
  data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  for (const k of Object.keys(empty)) if (!(k in data)) data[k] = empty[k];
} catch (_) {
  data = JSON.parse(JSON.stringify(empty));
}

let saveTimer = null;
function save() {
  // Debounce writes so rapid bulk inserts don't thrash the disk.
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  }, 50);
}
function saveNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
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
      existing.last_seen = now();
    } else {
      data.listings.push({
        id: l.id, title: l.title || '', price: l.price || '',
        description: l.description || '', status: l.status || 'active',
        url: l.url || '', area: l.area || null, template_id: l.template_id || null,
        first_seen: now(), last_seen: now(), last_checked: now(),
      });
    }
    save();
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
  getStaleListings: () => data.listings.filter(l => l.status === 'active' && l.last_checked < now() - 3600),
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
      status: 'pending', result: null, created_at: now(), updated_at: now(),
    };
    data.post_queue.push(row);
    saveNow();
    return row;
  },
  getNextJob: () => [...data.post_queue].filter(j => j.status === 'pending').sort((a, b) => a.created_at - b.created_at)[0] || null,
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
};
