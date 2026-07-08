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
const brain   = require('./brain');
const sanitize = require('./sanitize');

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

// Draw varied, on-theme, policy-safe titles/descriptions from the curated keyword
// library (ai.LISTING_KEYWORDS), blended with anything the user typed. Every result
// also passes through ai.policySanitize as a safety net.
function pickN(arr, n) { return [...arr].sort(() => Math.random() - 0.5).slice(0, n); }

function genTitle(bases, words) {
  const K = ai.LISTING_KEYWORDS;
  // Title subjects = the user's seeds blended with the primary keyword library.
  const subjects = [...new Set([...bases.map(s => titleCase(String(s).trim())).filter(Boolean), ...K.primary])];
  const base = subjects[Math.floor(Math.random() * subjects.length)] || 'Bathtub Resurfacing';
  // Modifiers = appearance + quality + home-improvement themes + any user words.
  const mods = [...new Set([
    ...words.map(w => titleCase(String(w).trim())).filter(Boolean),
    ...K.appearance, ...K.quality, ...K.themes,
  ])];
  if (!mods.length || Math.random() < 0.18) return ai.policySanitize(base, { isTitle: true });
  const mod = mods[Math.floor(Math.random() * mods.length)];
  const formats = [`${base} - ${mod}`, `${mod} ${base}`, `${base} | ${mod}`, `${base} ${mod}`];
  return ai.policySanitize(formats[Math.floor(Math.random() * formats.length)], { isTitle: true });
}

function genDesc(words) {
  const K = ai.LISTING_KEYWORDS;
  const cap = s => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  const appearance = pickN(K.appearance, 2).map(s => s.toLowerCase());
  const userWords = words.map(x => String(x).trim()).filter(Boolean);
  const lead = [...appearance, ...pickN(userWords, 1)].filter(Boolean).join(', ');
  const benefit = pickN(K.benefits, 1)[0];
  const quality = pickN(K.quality, 1)[0];
  const theme = Math.random() < 0.5 ? ` A simple ${pickN(K.themes, 1)[0].toLowerCase()}.` : '';
  const closers = ['Message for more information.', 'Message with any questions.', 'Serious inquiries welcome.',
    'Details available on request.', 'Message to learn more.'];
  const closer = closers[Math.floor(Math.random() * closers.length)];
  return ai.policySanitize(`${cap(lead)}. ${cap(benefit)}.${theme} ${quality}. ${closer}`);
}

app.post('/api/templates/generate', (req, res) => {
  const { titles = [], prices = [], descWords = [], photos = [], location = '', locations = [], category = 'Home Improvement', count = 10 } = req.body || {};
  // Title seeds the user typed; if none, generate straight from the keyword library.
  let bases = titles.map(t => String(t).trim()).filter(Boolean);
  if (!bases.length) bases = ai.LISTING_KEYWORDS.primary.slice();
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

app.get('/api/listings', (req, res) => {
  let listings = db.getListings();
  // owned=1 → only the user's own listings (scanned from "Your Listings" or
  // published from one of their templates). Keeps other people's listings out.
  if (req.query.owned === '1' || req.query.owned === 'true') {
    listings = listings.filter(l => l.owned === true || l.template_id != null);
  }
  res.json(listings);
});

app.post('/api/listings', (req, res) => {
  const l = req.body;
  if (!l.id) return res.status(400).json({ error: 'id required' });
  db.upsertListing({
    id: l.id, title: l.title || '', price: l.price || '', description: l.description || '',
    status: l.status || 'active', url: l.url || '',
    template_id: l.template_id != null ? l.template_id : null, // remember source template for auto-repost
    owned: l.owned === true,
  });
  res.json({ ok: true });
});

// Bulk upsert — sent by content script after scanning
app.post('/api/listings/bulk', (req, res) => {
  const listings = (req.body || []).map(l => ({
    id: l.id, title: l.title || '', price: l.price || '',
    description: l.description || '', status: l.status || 'active', url: l.url || '',
    owned: l.owned === true,
  }));
  db.upsertListings(listings);
  res.json({ ok: true, count: listings.length });
});

// Delete one of the user's own listings from the dashboard (keeps its template +
// photos so it can be republished later).
app.delete('/api/listings/:id', (req, res) => {
  db.deleteListing(req.params.id);
  res.json({ ok: true });
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

  const { source = 'marketplace', account_id, sender_id, thread_id, sender_name, text, timestamp, history } = req.body || {};
  if (!text || !String(text).trim()) return res.status(400).json({ error: 'text required' });

  const payload = {
    source, account_id: account_id != null ? account_id : null, // which FB account (multi-account)
    sender_id, thread_id, sender_name,
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
    db.addLog({ step: 'marketplace-bridge', status: 'info', detail: `Acct ${account_id || '-'} · Thread ${thread_id || '?'}: relayed inbound, got ${String(reply).length} char reply` });
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
  // Product-frame + vary the copy (unless AI already rewrote it, or it's disabled).
  if (db.getSettings().product_framing !== false) {
    const seed = db.countRecentReposts(tpl.id, 365 * 24 * 3600);
    const copy = sanitize.productize(title, description, seed);
    title = copy.title; description = copy.description;
  }
  // Route the job to the account that owns this ZIP (if multi-account is set up).
  const acct = db.findAccountForZip(tpl.location);
  return db.createJob({
    template_id: tpl.id, title, price: tpl.price ? String(tpl.price) : '',
    description, location: tpl.location || '', category: tpl.category || '',
    condition: tpl.condition || '', photos: photosForJob(tpl),
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
  const job = db.getJob(req.params.id);
  db.updateJob(req.params.id, status, result);
  // Feed the outcome back to the brain's account health (failover + pacing).
  if (job && job.account_id != null) {
    if (status === 'done') {
      db.recordAccountPost(job.account_id, brain.todayStr());
    } else if (status === 'blocked') {
      db.markAccountRestricted(job.account_id, 'Facebook blocked a listing');
      db.recordBrainAction({ kind: 'failover', account_id: job.account_id, template_id: job.template_id,
        reason: 'listing blocked → account restricted, brain will fail over to another account' });
      db.addLog({ job_id: job.id, step: 'brain', status: 'block', detail: `Account ${job.account_id} restricted after a block; excluded from posting until cleared` });
    }
  }
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

// ── Autonomous brain (READ-ONLY: observe + recommend, never posts) ─────────────
// These endpoints let you watch the brain's decisions before actuation is
// enabled. None of them enqueue a job or touch Facebook.
app.get('/api/brain/performance', (_req, res) => res.json(brain.performance()));
app.get('/api/brain/coverage',    (_req, res) => res.json(brain.coverage()));
app.get('/api/brain/plan',        (_req, res) => res.json(brain.plan()));
app.get('/api/brain/keepalive',   (_req, res) => res.json(brain.keepAlive()));
app.get('/api/brain/actions',     (req, res) => res.json(db.getBrainActions(Number(req.query.limit) || 200)));

// Mark / clear an account restriction (used by failover; also manual override).
app.post('/api/brain/accounts/:id/restrict', (req, res) => {
  const a = db.markAccountRestricted(Number(req.params.id), (req.body && req.body.reason) || 'manual');
  a ? res.json(a) : res.status(404).json({ error: 'Not found' });
});
app.post('/api/brain/accounts/:id/clear', (req, res) => {
  const a = db.clearAccountRestriction(Number(req.params.id));
  a ? res.json(a) : res.status(404).json({ error: 'Not found' });
});

// Manually enqueue ONE real post from the current plan — for testing the
// autofill end-to-end without turning on full autonomy. Optional body {accountId}
// picks that account's proposal; otherwise the top-ranked proposal is used.
app.post('/api/brain/enqueue-now', (req, res) => {
  const accountId = req.body && req.body.accountId != null ? Number(req.body.accountId) : null;
  const proposals = brain.plan().proposals;
  const p = accountId != null ? proposals.find(x => x.account_id === accountId) : proposals[0];
  if (!p) return res.status(404).json({ error: accountId != null ? 'No eligible proposal for that account (restricted, capped, cooling down, or all ZIPs live)' : 'No proposals right now' });
  if (pendingCountForAccount(p.account_id) > 0) return res.status(409).json({ error: `Account ${p.account_id} already has a pending job` });
  const job = enqueueProposal(p, 'manual-test');
  res.status(201).json({ enqueued: job, proposal: p });
});

// Enqueue a delete-only job: the assigned account's profile opens the listing and
// deletes it (used to clean up suspended/old listings). Routes to Account A (1)
// by default — deletion only works from the profile logged into the owning acct.
app.post('/api/brain/delete-listing', (req, res) => {
  const { listingId, url, accountId } = req.body || {};
  let delUrl = url || null;
  if (!delUrl && listingId != null) {
    const l = db.getListings().find(x => String(x.id) === String(listingId));
    if (l) delUrl = l.url;
  }
  if (!delUrl) return res.status(400).json({ error: 'url (or a listingId with a known url) required' });
  const job = db.createJob({ delete_url: delUrl, delete_only: true, title: 'delete listing',
    account_id: accountId != null ? Number(accountId) : 1 });
  db.recordBrainAction({ kind: 'delete', account_id: job.account_id, reason: `delete-only: ${delUrl.slice(0, 60)}` });
  db.addLog({ job_id: job.id, step: 'brain', status: 'info', detail: `delete-only job queued for ${delUrl}` });
  res.status(201).json({ enqueued: job });
});

// ── Scheduler — enqueues publish jobs on each schedule's daily time slots ──────
// Runs every minute. The extension's background worker then posts queued jobs
// (one at a time, with throttling). Time slots use the machine's LOCAL time,
// which is the user's time since the backend runs on their PC.

// ── Listing sync (from the extension's background "Your Listings" scan) ────────
// Match a scraped listing to its source template by title (our posts use the
// template's title verbatim), so coverage + keep-alive know what's actually live.
function matchTemplateByTitle(title) {
  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const want = norm(title);
  if (!want) return null;
  const tpls = db.getTemplates();
  return tpls.find((t) => norm(t.title) === want)
      || tpls.find((t) => { const n = norm(t.title); return n.length > 8 && (want.includes(n) || n.includes(want.slice(0, 18))); })
      || null;
}

app.post('/api/listings/sync', (req, res) => {
  const { accountId, cards } = req.body || {};
  if (!Array.isArray(cards)) return res.status(400).json({ error: 'cards[] required' });
  let matched = 0;
  for (const c of cards) {
    if (!c || !c.id) continue;
    const tpl = matchTemplateByTitle(c.title);
    if (tpl) matched++;
    db.upsertListing({
      id: String(c.id), title: c.title || '', price: c.price || '',
      url: c.url || '', status: c.status || 'active', owned: true, checked: true,
      template_id: tpl ? tpl.id : undefined,
      account_id: accountId != null ? Number(accountId) : undefined,
    });
  }
  db.addLog({ step: 'sync', status: 'info', detail: `Account ${accountId}: synced ${cards.length} listings (${matched} matched to templates)` });
  res.json({ ok: true, synced: cards.length, matched });
});

// ── Alerting (Telegram) + down-detector ───────────────────────────────────────
// Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in backend/.env to receive alerts.
// Without them, alerts are logged only (no-op delivery).
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT  = process.env.TELEGRAM_CHAT_ID || '';
const alertLog = new Map();          // key → last-sent ms (dedup)
const heartbeats = new Map();        // accountId → { at, name }

async function sendTelegram(text) {
  if (!TG_TOKEN || !TG_CHAT) return false;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text, disable_web_page_preview: true }),
    });
    return true;
  } catch (e) { console.warn('[alert] telegram send failed:', e.message); return false; }
}
// Fire an alert at most once per cooldown window (minutes) per key.
function alertOnce(key, text, cooldownMin = 30) {
  if (Date.now() - (alertLog.get(key) || 0) < cooldownMin * 60000) return;
  alertLog.set(key, Date.now());
  db.addLog({ step: 'alert', status: 'warn', detail: text });
  sendTelegram('⚠️ Marketplace bot: ' + text);
}

// Each Chrome profile pings this so the backend knows it's alive.
app.post('/api/heartbeat', (req, res) => {
  const id = req.body && req.body.accountId;
  if (id != null && id !== '') {
    const a = db.getAccount(Number(id));
    heartbeats.set(String(id), { at: Date.now(), name: a ? a.name : `Account ${id}` });
  }
  res.json({ ok: true });
});

// Verify the Telegram config end-to-end.
app.post('/api/alert/test', async (req, res) => {
  if (!TG_TOKEN || !TG_CHAT) return res.status(400).json({ error: 'Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in backend/.env, then restart.' });
  const ok = await sendTelegram('✅ Test alert from your Marketplace bot — alerts are working.');
  ok ? res.json({ ok: true }) : res.status(502).json({ error: 'Telegram send failed — check the token / chat id.' });
});

// Every 2 min: alert on a profile that went silent, or an account Facebook restricted.
setInterval(() => {
  try {
    const now = Date.now();
    for (const [id, hb] of heartbeats) {
      if (now - hb.at > 15 * 60000) {
        alertOnce(`silent-${id}`, `${hb.name}'s browser stopped reporting (~${Math.round((now - hb.at) / 60000)} min ago). Is that Chrome profile open? Its posting & chatbot are paused until it is.`, 60);
      }
    }
    for (const a of db.getAccounts()) {
      if (a.health && a.health.status === 'restricted') {
        alertOnce(`restricted-${a.id}`, `${a.name} was restricted by Facebook and is excluded from posting (reason: ${a.health.last_reason || 'a block'}). Check it and clear the restriction when resolved.`, 240);
      }
    }
  } catch (e) { console.warn('[alert] monitor', e.message); }
}, 2 * 60 * 1000);

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

// ── Autonomous orchestrator: turns the brain's plan into real publish jobs ──────
// GATED by settings.autonomous (default OFF). When off, this does nothing, so the
// brain stays observe-only. When on, it enqueues at most ONE job per account per
// tick and only when that account is idle — the caps/pacing/cooldown that make it
// safe live in brain.plan(); this just executes the already-vetted proposals.

function pendingCountForAccount(accountId) {
  return db.getJobs().filter(j => String(j.account_id) === String(accountId)
    && (j.status === 'pending' || j.status === 'running')).length;
}

// Build a publish job from a template for a specific account, mark a cooldown so
// the same template isn't re-enqueued next tick, and log the decision.
// All photo URLs in the shared library (data/photos), served over localhost.
function libraryPhotoUrls() {
  try {
    return fs.readdirSync(PHOTO_DIR)
      .filter(f => /\.(jpe?g|png|webp|gif)$/i.test(f))
      .map(f => `http://localhost:${PORT}/photos/${f}`);
  } catch (_) { return []; }
}

// Choose the photos for a post: LEAD with a rotating library image (so each
// post/repost uses a DIFFERENT real picture → avoids duplicate suspensions),
// then include the template's own photo and a few more library images as
// FALLBACKS (if one upload fails, the extension tries the next). Falls back to
// the template's own photo(s) when the library is empty.
function photosForJob(tpl) {
  let own = [];
  try { own = JSON.parse(tpl.photos || '[]'); if (!Array.isArray(own)) own = []; } catch (_) {}
  const lib = libraryPhotoUrls();
  if (!lib.length) return JSON.stringify(own);
  // Offset by template id AND repost count so DIFFERENT templates lead with
  // different photos, and REPOSTS of one template rotate to new photos.
  const idx = (Number(tpl.id) + db.countRecentReposts(tpl.id, 365 * 24 * 3600)) % lib.length;
  const rotated = lib.slice(idx).concat(lib.slice(0, idx));
  const set = [];
  const push = (u) => { if (u && !set.includes(u)) set.push(u); };
  push(rotated[0]);                    // variety: a different library photo each time
  own.forEach(push);                   // the template's own photo(s)
  rotated.slice(1, 4).forEach(push);   // extra fallbacks for reliable upload
  return JSON.stringify(set.slice(0, 5));
}

function enqueueProposal(p, kind) {
  const tpl = db.getTemplate(p.template_id);
  if (!tpl) return null;
  const photos = photosForJob(tpl);
  // Product-frame + vary the copy per post so it reads as an item for sale (not a
  // service ad) and no two listings are identical. Seed rotates by post count.
  const seed = db.countRecentReposts(tpl.id, 365 * 24 * 3600);
  const copy = db.getSettings().product_framing !== false
    ? sanitize.productize(tpl.title, tpl.description || '', seed)
    : { title: tpl.title, description: tpl.description || '' };
  const job = db.createJob({
    template_id: tpl.id, account_id: p.account_id,
    title: copy.title, price: tpl.price != null ? String(tpl.price) : '',
    description: copy.description, location: tpl.location || '',
    category: tpl.category || '', condition: tpl.condition || '',
    photos, delete_url: p.delete_url || null,
  });
  db.addRepost(tpl.id);                                   // cooldown window
  db.recordBrainAction({ kind: kind || 'enqueue', account_id: p.account_id, zip: p.zip || null,
    template_id: tpl.id, reason: p.reason, score: p.score != null ? p.score : null });
  db.addLog({ job_id: job.id, step: 'brain', status: 'info',
    detail: `${kind || 'enqueue'}: account ${p.account_id} → template #${tpl.id}${p.zip ? ' (ZIP ' + p.zip + ')' : ''} — ${p.reason || ''}` });
  return job;
}

function brainTick() {
  const s = db.getSettings();
  if (!s.autonomous) return;                              // master switch OFF → do nothing

  // 1) Keep-alive first: replace listings that went inactive (highest priority).
  for (const r of brain.keepAlive().replacements) {
    const acct = db.findAccountForZip(r.zip);
    if (!acct || acct.health?.status === 'restricted') continue;
    if (pendingCountForAccount(acct.id) > 0) continue;    // one at a time per account
    enqueueProposal({ account_id: acct.id, template_id: r.template_id, zip: r.zip,
      delete_url: r.delete_url || null, reason: r.reason, score: r.score }, 'keepalive');
  }

  // 2) New posts from the ranked plan — one per idle account.
  for (const p of brain.plan().proposals) {
    if (pendingCountForAccount(p.account_id) > 0) continue;
    enqueueProposal(p, 'enqueue');
  }
}

setInterval(() => { try { brainTick(); } catch (e) { console.warn('[brain]', e.message); } }, 60 * 1000);

// ── Serve dashboard for any unknown route ─────────────────────────────────────

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'dashboard', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n  FB Marketplace Manager backend running at http://localhost:${PORT}`);
  console.log(`  Dashboard: http://localhost:${PORT}`);
  console.log(`  Scheduler: active (checks every minute)\n`);
});
