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

// Photo library — list and delete stored photos.
app.get('/api/photos/list', (_req, res) => {
  let files = [];
  try {
    files = fs.readdirSync(PHOTO_DIR)
      .filter(f => /\.(jpe?g|png|webp|gif)$/i.test(f))
      .map(f => ({ name: f, url: `http://localhost:${PORT}/photos/${f}`, at: fs.statSync(path.join(PHOTO_DIR, f)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
  } catch (_) {}
  res.json(files);
});

app.delete('/api/photos/:name', (req, res) => {
  const name = path.basename(req.params.name); // prevent path traversal
  try { fs.unlinkSync(path.join(PHOTO_DIR, name)); res.json({ ok: true }); }
  catch (err) { res.status(404).json({ error: 'not found' }); }
});

// Content hashes of every stored photo — used by the dashboard to detect exact
// duplicate images before adding/publishing. Additive; nothing else relies on it.
const crypto = require('crypto');
app.get('/api/photos/hashes', (_req, res) => {
  let out = [];
  try {
    out = fs.readdirSync(PHOTO_DIR)
      .filter(f => /\.(jpe?g|png|webp|gif)$/i.test(f))
      .map(f => {
        const buf = fs.readFileSync(path.join(PHOTO_DIR, f));
        return {
          name: f,
          url: `http://localhost:${PORT}/photos/${f}`,
          hash: crypto.createHash('sha256').update(buf).digest('hex'),
          at: fs.statSync(path.join(PHOTO_DIR, f)).mtimeMs,
        };
      });
  } catch (_) {}
  res.json(out);
});

// ── Templates ─────────────────────────────────────────────────────────────────

app.get('/api/templates', (_req, res) => res.json(db.getTemplates()));

app.get('/api/templates/:id', (req, res) => {
  const t = db.getTemplate(req.params.id);
  t ? res.json(t) : res.status(404).json({ error: 'Not found' });
});

app.post('/api/templates', (req, res) => {
  const { title, price, location, category, condition, description, photos } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });
  res.status(201).json(db.createTemplate({ title, price, location, category, condition, description, photos }));
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

// Bulk-generate varied templates from seed titles + prices + description words,
// rotating through chosen library photos. Each template gets a unique
// title/price/description/photo combo to reduce duplicate/spam flagging.
function titleCase(s) { return String(s).replace(/\w\S*/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase()); }

// Neutral, policy-conscious modifiers/closers — no service-ad, hype, urgency, or
// contact cues. Every result also passes through ai.policySanitize as a safety net.
function genTitle(bases, words) {
  const base = titleCase(bases[Math.floor(Math.random() * bases.length)].trim());
  const defaults = ['Like New', 'Quality Finish', 'Professional', 'White Finish', 'Durable', 'Refinished', 'Restored', 'Clean'];
  const pool = [...new Set([...words.map(w => titleCase(w.trim())).filter(Boolean), ...defaults])];
  if (!pool.length || Math.random() < 0.2) return ai.policySanitize(base, { isTitle: true });
  const mod = pool[Math.floor(Math.random() * pool.length)];
  const formats = [`${base} - ${mod}`, `${mod} ${base}`, `${base} | ${mod}`, `${base} ${mod}`];
  return ai.policySanitize(formats[Math.floor(Math.random() * formats.length)], { isTitle: true });
}

function genDesc(words) {
  const w = (words.length ? words : ['like new', 'quality finish', 'durable', 'white', 'professional']).map(x => x.trim()).filter(Boolean);
  const shuffled = [...w].sort(() => Math.random() - 0.5);
  const pick = shuffled.slice(0, Math.min(4, Math.max(2, Math.floor(Math.random() * w.length) + 1)));
  const closers = ['Message for more information.', 'Message with any questions.', 'Serious inquiries welcome.',
    'Details available on request.', 'Message to learn more.'];
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  return ai.policySanitize(`${cap(pick.join(', '))}. ${closers[Math.floor(Math.random() * closers.length)]}`);
}

app.post('/api/templates/generate', (req, res) => {
  const { titles = [], prices = [], descWords = [], photos = [], location = '', locations = [], category = 'Home Improvement', count = 10 } = req.body || {};
  const bases = titles.map(t => String(t).trim()).filter(Boolean);
  if (!bases.length) return res.status(400).json({ error: 'Provide at least one title seed' });
  const priceList = (prices.length ? prices : ['99']).map(p => String(p).replace(/[^0-9.]/g, '')).filter(Boolean);
  const photoList = Array.isArray(photos) ? photos : [];
  // ZIP/locations to rotate through (one template per area, cycling).
  const locs = (Array.isArray(locations) && locations.length) ? locations.map(String) : (location ? [String(location)] : []);
  const n = Math.min(Math.max(parseInt(count, 10) || 10, 1), 200);

  const created = [];
  const seen = new Set();
  let attempts = 0;
  while (created.length < n && attempts < n * 40) {
    attempts++;
    const loc = locs.length ? locs[created.length % locs.length] : '';
    const title = genTitle(bases, descWords);
    // Allow the same title in different ZIPs, but not duplicate title+ZIP pairs.
    const key = `${title.toLowerCase()}|${loc}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const tpl = db.createTemplate({
      title,
      price: priceList[Math.floor(Math.random() * priceList.length)] || '',
      location: loc, category,
      description: genDesc(descWords),
      photos: photoList.length ? [photoList[created.length % photoList.length]] : [],
    });
    created.push(tpl);
  }
  res.status(201).json({ created: created.length, templates: created });
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

// ── Debug DOM snapshots ─────────────────────────────────────────────────────────
app.post('/api/debug', (req, res) => { db.addDebug(req.body || {}); res.json({ ok: true }); });
app.get('/api/debug', (_req, res) => res.json(db.getDebug()));
app.delete('/api/debug', (_req, res) => { db.clearDebug(); res.json({ ok: true }); });

// ── Marketplace → existing chatbot bridge relay ────────────────────────────────
// Personal-profile Marketplace chats have no Meta API/webhook, so the extension
// content script (marketplace-chat.js) forwards each inbound message here. This
// route relays it to the EXISTING n8n chatbot webhook server-side (so the n8n
// URL + shared secret never live in the extension) and returns the bot's reply.
//
// It does NOT touch the chatbot — it just calls the workflow you already run and
// passes the reply text back to the page. Configure in .env:
//   N8N_WEBHOOK_URL    = https://<your-n8n>/webhook/marketplace-incoming
//   N8N_SHARED_SECRET  = <any long random string, also set on the n8n side>
app.post('/api/marketplace/incoming', async (req, res) => {
  const url = process.env.N8N_WEBHOOK_URL;
  if (!url) {
    return res.status(503).json({ error: 'N8N_WEBHOOK_URL not set in backend/.env — see docs/n8n-marketplace-adapter.md' });
  }

  const { source = 'marketplace', sender_id, thread_id, sender_name, text, timestamp, history } = req.body || {};
  if (!text || !String(text).trim()) return res.status(400).json({ error: 'text required' });

  const payload = {
    source, sender_id, thread_id, sender_name,
    text: String(text), timestamp: timestamp || new Date().toISOString(),
    history: Array.isArray(history) ? history : [],   // recent thread for context/memory
  };

  // Abort if n8n is slow so the content script never hangs the page.
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (process.env.N8N_SHARED_SECRET) headers['X-Bridge-Secret'] = process.env.N8N_SHARED_SECRET;

    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: ctrl.signal });
    const raw = await r.text();
    if (!r.ok) {
      db.addLog({ step: 'marketplace-bridge', status: 'error', detail: `n8n responded ${r.status}: ${raw.slice(0, 300)}` });
      return res.status(502).json({ error: `n8n responded ${r.status}` });
    }
    // n8n's "Respond to Webhook" node may return JSON {reply|text|message} or a
    // bare string — accept either.
    let reply = raw;
    try { const j = JSON.parse(raw); reply = j.reply ?? j.text ?? j.message ?? j.output ?? raw; } catch (_) {}
    db.addLog({ step: 'marketplace-bridge', status: 'info', detail: `Thread ${thread_id || '?'}: relayed inbound, got ${String(reply).length} char reply` });
    res.json({ reply: String(reply) });
  } catch (err) {
    const msg = err.name === 'AbortError' ? 'n8n timed out (30s)' : err.message;
    db.addLog({ step: 'marketplace-bridge', status: 'error', detail: msg });
    res.status(504).json({ error: msg });
  } finally {
    clearTimeout(t);
  }
});

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
  // Route the job to the account that owns this ZIP (if multi-account is set up).
  const acct = db.findAccountForZip(tpl.location);
  return db.createJob({
    template_id: tpl.id, title, price: tpl.price ? String(tpl.price) : '',
    description, location: tpl.location || '', category: tpl.category || '',
    condition: tpl.condition || '', photos: tpl.photos || '[]',
    delete_url: extra.delete_url || null,
    account_id: acct ? acct.id : null,
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

// Background script polls this — 204 = nothing to do. accountId filters jobs to
// the Chrome profile's assigned Facebook account.
app.get('/api/publish/next', (req, res) => {
  const job = db.getNextJob(req.query.accountId);
  job ? res.json(job) : res.sendStatus(204);
});

// ── Accounts (multi Facebook account / Chrome profile support) ─────────────────
app.get('/api/accounts', (_req, res) => {
  const jobs = db.getJobs();
  const accounts = db.getAccounts().map(a => ({
    ...a,
    pending: jobs.filter(j => String(j.account_id) === String(a.id) && j.status === 'pending').length,
  }));
  res.json(accounts);
});
app.post('/api/accounts', (req, res) => {
  const { name, zips } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  res.status(201).json(db.createAccount({ name, zips }));
});
app.patch('/api/accounts/:id', (req, res) => {
  const a = db.updateAccount(req.params.id, req.body || {});
  a ? res.json(a) : res.status(404).json({ error: 'Not found' });
});
app.delete('/api/accounts/:id', (req, res) => { db.deleteAccount(req.params.id); res.json({ ok: true }); });

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
