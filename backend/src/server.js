// Load .env if dotenv is available (optional — AI features need ANTHROPIC_API_KEY).
try {
  require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
} catch (_) {
  // dotenv not installed — read .env manually so the server still starts.
  try {
    const fs = require('fs');
    const envPath = require('path').join(__dirname, '..', '.env');
    if (fs.existsSync(envPath)) {
      for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
        const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch (_) { /* no .env — fine */ }
}

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const db      = require('./db');
const ai      = require('./ai');

const app  = express();
const PORT = process.env.PORT || 3333;

// Allow requests from any origin. This server only ever listens on localhost,
// so it is not exposed to the network — and the extension's content script runs
// on facebook.com (and various FB country subdomains), so a fixed allow-list was
// too brittle. Reflecting the request origin makes the extension reach it reliably.
app.use(cors());
app.options('*', cors()); // answer CORS preflight for POST/PATCH/DELETE
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, '..', '..', 'dashboard')));

// Stored listing photos are served from here so the extension can fetch them
// from facebook.com (localhost is an allowed host in the extension manifest).
const fs = require('fs');
const PHOTO_DIR = path.join(__dirname, '..', 'data', 'photos');
fs.mkdirSync(PHOTO_DIR, { recursive: true });
app.use('/photos', express.static(PHOTO_DIR));

// ── Photo upload (base64 data URL → saved file → localhost URL) ────────────────
// Uses base64 JSON so we need no multipart/file-upload dependency.
app.post('/api/photos', (req, res) => {
  const { dataUrl } = req.body || {};
  const m = typeof dataUrl === 'string' && dataUrl.match(/^data:(image\/[\w+.-]+);base64,(.+)$/);
  if (!m) return res.status(400).json({ error: 'Send { dataUrl: "data:image/...;base64,..." }' });
  const ext  = m[1].split('/')[1].replace('jpeg', 'jpg').replace(/[^\w]/g, '') || 'jpg';
  const buf  = Buffer.from(m[2], 'base64');
  if (buf.length > 20 * 1024 * 1024) return res.status(413).json({ error: 'Image too large (max 20MB)' });
  const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  fs.writeFileSync(path.join(PHOTO_DIR, name), buf);
  res.json({ url: `http://localhost:${PORT}/photos/${name}` });
});

// Download a remote image (e.g. a Facebook CDN photo from an existing listing)
// server-side — no browser CORS — and store it locally for reuse.
async function downloadImage(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const ct = (r.headers.get('content-type') || '').toLowerCase();
  if (!ct.startsWith('image/')) throw new Error('not an image');
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 20 * 1024 * 1024) throw new Error('image too large');
  const ext = (ct.split('/')[1] || 'jpg').replace('jpeg', 'jpg').replace(/[^\w]/g, '') || 'jpg';
  const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  fs.writeFileSync(path.join(PHOTO_DIR, name), buf);
  return `http://localhost:${PORT}/photos/${name}`;
}

app.post('/api/photos/from-url', async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url required' });
  try { res.json({ url: await downloadImage(url) }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// ── Templates ─────────────────────────────────────────────────────────────────

app.get('/api/templates', (_req, res) => res.json(db.getTemplates()));

app.get('/api/templates/:id', (req, res) => {
  const t = db.getTemplate(req.params.id);
  t ? res.json(t) : res.status(404).json({ error: 'Not found' });
});

app.post('/api/templates', (req, res) => {
  const { title, price, location, category, description, photos } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });
  res.status(201).json(db.createTemplate({ title, price, location, category, description, photos }));
});

app.patch('/api/templates/:id', (req, res) => {
  const updated = db.updateTemplate(req.params.id, req.body || {});
  updated ? res.json(updated) : res.status(404).json({ error: 'Not found' });
});

// Build a template automatically with AI from competitor data + a short prompt.
app.post('/api/templates/from-ai', async (req, res) => {
  const { notes, title, category } = req.body || {};
  if (!notes && !title) return res.status(400).json({ error: 'Provide notes or a title (what you sell)' });
  try {
    const c = await ai.composeListing({ title, notes, category, competitors: db.getCompetitors() });
    const tpl = db.createTemplate({
      title: c.title, price: c.price, location: req.body.location || '',
      category: c.category, description: c.description, photos: [],
    });
    res.status(201).json({ template: tpl, ai: c._ai });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Build a template by copying an existing listing (title/price/description +
// its photos, downloaded and stored locally for reuse).
app.post('/api/templates/from-listing', async (req, res) => {
  const { title, price, description, category, location, photoUrls } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title required (could not read the listing)' });

  const stored = [];
  for (const url of (Array.isArray(photoUrls) ? photoUrls : []).slice(0, 10)) {
    try { stored.push(await downloadImage(url)); } catch (_) { /* skip unreachable images */ }
  }
  const tpl = db.createTemplate({
    title, price: price ? String(price).replace(/[^0-9.]/g, '') : '',
    description: description || '', category: category || '', location: location || '',
    photos: stored,
  });
  res.status(201).json({ template: tpl, photosSaved: stored.length });
});

app.delete('/api/templates/:id', (req, res) => {
  db.deleteTemplate(req.params.id);
  res.json({ ok: true });
});

// ── Listings ──────────────────────────────────────────────────────────────────

app.get('/api/listings', (_req, res) => res.json(db.getListings()));

app.post('/api/listings', (req, res) => {
  const l = req.body;
  if (!l.id) return res.status(400).json({ error: 'id required' });
  db.upsertListing({
    id: l.id, title: l.title || '', price: l.price || '', description: l.description || '',
    status: l.status || 'active', url: l.url || '',
    template_id: l.template_id != null ? l.template_id : null, // remember source template for auto-repost
  });
  res.json({ ok: true });
});

// Bulk upsert — sent by content script after scanning
app.post('/api/listings/bulk', (req, res) => {
  const listings = (req.body || []).map(l => ({
    id: l.id, title: l.title || '', price: l.price || '',
    description: l.description || '', status: 'active', url: l.url || '',
  }));
  db.upsertListings(listings);
  res.json({ ok: true, count: listings.length });
});

// Listings that haven't been checked in an hour — background script uses this
app.get('/api/listings/stale', (_req, res) => res.json(db.getStaleListings()));

app.get('/api/listings/:id', (req, res) => {
  const l = db.getListing(req.params.id);
  l ? res.json(l) : res.status(404).json({ error: 'Not found' });
});

app.get('/api/listings/:id/events', (req, res) => {
  res.json(db.getListingEvents(req.params.id));
});

app.patch('/api/listings/:id/status', (req, res) => {
  const { status } = req.body;
  if (!status) return res.status(400).json({ error: 'status required' });

  const before = db.getListing(req.params.id);
  // Capture the previous status BEFORE updating — `before` is a live reference
  // that updateListingStatus mutates in place.
  const wasActive = !!before && before.status === 'active';
  db.updateListingStatus(req.params.id, status);

  // Auto-repost: when a listing transitions to inactive (suspended/removed) and
  // it came from a template, queue a fresh post — so it comes back to life on
  // its own. A cooldown prevents an endless loop if Facebook keeps removing it.
  if (status === 'inactive' && wasActive) {
    maybeAutoRepost(before).catch(() => {}); // fire-and-forget (may call AI)
  }
  res.json({ ok: true });
});

const REPOST_COOLDOWN_SECONDS = 6 * 3600; // at most a few reposts per template per window
const REPOST_CAP_PER_WINDOW    = 2;

async function maybeAutoRepost(listing) {
  const settings = db.getSettings();
  if (!settings.auto_repost) return false;
  if (!listing.template_id) {
    db.addLog({ step: 'repost', status: 'warn', detail: `Listing ${listing.id} went inactive but has no template to repost from` });
    return false;
  }
  const recent = db.countRecentReposts(listing.template_id, REPOST_COOLDOWN_SECONDS);
  if (recent >= REPOST_CAP_PER_WINDOW) {
    db.addLog({ step: 'repost', status: 'warn', detail: `Repost cooldown hit for template #${listing.template_id} (Facebook may be repeatedly removing it — check the listing)` });
    return false;
  }
  const tpl = db.getTemplate(listing.template_id);
  if (!tpl) return false;

  await queueJobFromTemplate(tpl, { delete_url: listing.url || null });
  db.addRepost(tpl.id);
  db.addLog({ step: 'repost', status: 'info', detail: `"${listing.title}" was suspended/removed — queued a fresh post from template #${tpl.id}` });
  return true;
}

// Manual one-click repost of a listing from its source template (bypasses the
// cooldown — it's a deliberate user action).
app.post('/api/listings/:id/repost', async (req, res) => {
  const listing = db.getListing(req.params.id);
  if (!listing) return res.status(404).json({ error: 'Listing not found' });
  if (!listing.template_id) return res.status(400).json({ error: 'This listing has no source template to repost from.' });
  const tpl = db.getTemplate(listing.template_id);
  if (!tpl) return res.status(404).json({ error: 'Source template was deleted.' });

  const job = await queueJobFromTemplate(tpl, { delete_url: listing.url || null });
  db.addRepost(tpl.id);
  db.addLog({ step: 'repost', status: 'info', detail: `Manual repost of "${listing.title}" queued from template #${tpl.id}` });
  res.status(201).json(job);
});

// ── Settings ────────────────────────────────────────────────────────────────────

app.get('/api/settings', (_req, res) => res.json(db.getSettings()));
app.patch('/api/settings', (req, res) => res.json(db.setSettings(req.body || {})));

// ── Competitors ───────────────────────────────────────────────────────────────

app.get('/api/competitors', (_req, res) => res.json(db.getCompetitors()));

app.post('/api/competitors/bulk', (req, res) => {
  const comps = (req.body || []).map(c => ({
    id: c.id, title: c.title || '', price: c.price || '',
    location: c.location || '', url: c.url || '',
  }));
  db.upsertCompetitors(comps);
  res.json({ ok: true, count: comps.length });
});

// ── Publish Queue ─────────────────────────────────────────────────────────────

// Central job builder. When the ai_rewrite setting is on, it generates a fresh
// title + description variation so repeated posts aren't identical text.
async function queueJobFromTemplate(tpl, extra = {}) {
  let title = tpl.title;
  let description = tpl.description || '';
  if (db.getSettings().ai_rewrite) {
    try {
      const v = await ai.varyListing({ title, description, category: tpl.category, competitors: db.getCompetitors() });
      if (v.title) title = v.title;
      if (v.description) description = v.description;
      db.addLog({ step: 'ai-rewrite', status: 'info', detail: `Fresh wording generated for "${tpl.title}"` });
    } catch (_) { /* fall back to template text */ }
  }
  return db.createJob({
    template_id: tpl.id, title, price: tpl.price ? String(tpl.price) : '',
    description, location: tpl.location || '', category: tpl.category || '',
    condition: tpl.condition || '', photos: tpl.photos || '[]',
    delete_url: extra.delete_url || null,
  });
}

// Create a job from a template (extension calls this when user clicks Publish)
app.post('/api/publish', async (req, res) => {
  const { templateId } = req.body;
  if (!templateId) return res.status(400).json({ error: 'templateId required' });

  const template = db.getTemplate(templateId);
  if (!template) return res.status(404).json({ error: 'Template not found' });

  const job = await queueJobFromTemplate(template);
  res.status(201).json(job);
});

// Create a job with explicit fields (from dashboard)
app.post('/api/publish/custom', (req, res) => {
  const { templateId, title, price, description, location, category, photos } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });

  const job = db.createJob({
    template_id: templateId || null,
    title,
    price:       price ? String(price) : '',
    description: description || '',
    location:    location || '',
    category:    category || '',
    photos:      JSON.stringify(photos || []),
  });
  res.status(201).json(job);
});

// Background script polls this — 204 = nothing to do
app.get('/api/publish/next', (_req, res) => {
  const job = db.getNextJob();
  job ? res.json(job) : res.sendStatus(204);
});

app.get('/api/publish/queue', (_req, res) => res.json(db.getJobs()));

app.patch('/api/publish/:id', (req, res) => {
  const { status, result } = req.body;
  if (!status) return res.status(400).json({ error: 'status required' });
  db.updateJob(req.params.id, status, result);
  res.json({ ok: true });
});

// ── Logs (automation action + error log) ──────────────────────────────────────

// Accept a single log entry or an array (the extension batches them).
app.post('/api/logs', (req, res) => {
  const body = req.body;
  const entries = Array.isArray(body) ? body : [body];
  entries.forEach(e => db.addLog(e));
  res.json({ ok: true, count: entries.length });
});

app.get('/api/logs', (req, res) => res.json(db.getLogs(req.query.jobId)));

app.delete('/api/logs', (_req, res) => { db.clearLogs(); res.json({ ok: true }); });

// ── AI Suggestions ────────────────────────────────────────────────────────────

app.post('/api/suggest', async (req, res) => {
  const { listingId, templateId, type } = req.body;
  if (!type) return res.status(400).json({ error: 'type required' });

  const listing = listingId ? db.getListing(listingId) : db.getTemplate(templateId);
  if (!listing) return res.status(404).json({ error: 'Listing/template not found' });

  const competitors = db.getCompetitors();

  try {
    const suggestion = await ai.suggest({ listing, competitors, type });
    db.saveSuggestion(listingId || null, templateId || null, type, suggestion);
    res.json({ suggestion });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/suggestions', (_req, res) => res.json(db.getSuggestions()));

// Compose a full listing (title, description, category, condition, price) from
// minimal input, pricing against tracked competitors. Does not save.
app.post('/api/ai/compose', async (req, res) => {
  const { title, notes, category } = req.body || {};
  if (!title && !notes) return res.status(400).json({ error: 'Provide a title or notes' });
  try {
    const composed = await ai.composeListing({ title, notes, category, competitors: db.getCompetitors() });
    res.json(composed);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/ai/categories', (_req, res) => res.json(ai.FB_CATEGORIES));

// ── Schedules (recurring auto-posting) ─────────────────────────────────────────

app.get('/api/schedules', (_req, res) => res.json(db.getSchedules()));

app.post('/api/schedules', (req, res) => {
  const { name, template_ids, times, max_per_day, active } = req.body || {};
  if (!Array.isArray(template_ids) || !template_ids.length) return res.status(400).json({ error: 'template_ids required' });
  if (!Array.isArray(times) || !times.length) return res.status(400).json({ error: 'times required (e.g. ["09:00","18:00"])' });
  res.status(201).json(db.createSchedule({ name, template_ids, times, max_per_day, active }));
});

app.patch('/api/schedules/:id', (req, res) => {
  const updated = db.updateSchedule(req.params.id, req.body || {});
  updated ? res.json(updated) : res.status(404).json({ error: 'Not found' });
});

app.delete('/api/schedules/:id', (req, res) => { db.deleteSchedule(req.params.id); res.json({ ok: true }); });

// ── Analytics ─────────────────────────────────────────────────────────────────

app.get('/api/analytics', (_req, res) => {
  const listings   = db.getListings();
  const competitors = db.getCompetitors();

  const statusCounts = listings.reduce((acc, l) => {
    acc[l.status] = (acc[l.status] || 0) + 1;
    return acc;
  }, {});

  // Price distribution of competitors
  const prices = competitors
    .map(c => parseFloat(String(c.price).replace(/[^0-9.]/g, '')))
    .filter(p => !isNaN(p));
  const avgCompetitorPrice = prices.length ? (prices.reduce((a, b) => a + b, 0) / prices.length).toFixed(2) : null;

  res.json({
    totalListings: listings.length,
    statusCounts,
    totalCompetitors: competitors.length,
    avgCompetitorPrice,
  });
});

// ── Scheduler — enqueues publish jobs on each schedule's daily time slots ──────
// Runs every minute. The extension's background worker then posts queued jobs
// (one at a time, with throttling). Time slots use the machine's LOCAL time,
// which is the user's time since the backend runs on their PC.

function pad(n) { return String(n).padStart(2, '0'); }

async function tickScheduler() {
  const d = new Date();
  const today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const hhmm  = `${pad(d.getHours())}:${pad(d.getMinutes())}`;

  for (const s of db.getSchedules()) {
    if (!s.active || !s.template_ids.length || !s.times.length) continue;

    // Reset the per-day counter at midnight.
    if (s.today !== today) { s.today = today; s.posted_today = 0; s.fired = (s.fired || []).filter(f => f.startsWith(today)); }

    if (s.posted_today >= (s.max_per_day || s.times.length)) continue;

    for (const slot of s.times) {
      const key = `${today} ${slot}`;
      // Fire when the current time has reached the slot and it hasn't fired today.
      if (hhmm >= slot && !(s.fired || []).includes(key)) {
        const templateId = s.template_ids[s.cursor % s.template_ids.length];
        const tpl = db.getTemplate(templateId);
        if (tpl) {
          await queueJobFromTemplate(tpl);
          db.addLog({ job_id: null, step: 'scheduler', status: 'info', detail: `Schedule "${s.name}" queued template #${tpl.id} for slot ${slot}` });
          s.cursor = (s.cursor + 1) % s.template_ids.length;
          s.posted_today = (s.posted_today || 0) + 1;
        }
        s.fired = (s.fired || []).concat(key);
        db.updateSchedule(s.id, s);
        break; // one slot per tick
      }
    }
  }
}

setInterval(() => { tickScheduler().catch(() => {}); }, 60 * 1000);

// ── Serve dashboard for any unknown route ─────────────────────────────────────

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'dashboard', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n  FB Marketplace Manager backend running at http://localhost:${PORT}`);
  console.log(`  Dashboard: http://localhost:${PORT}`);
  console.log(`  Scheduler: active (checks every minute)\n`);
});
