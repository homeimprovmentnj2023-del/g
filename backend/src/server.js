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

app.use(cors({ origin: ['https://www.facebook.com', 'http://localhost:3333', 'chrome-extension://*'] }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', '..', 'dashboard')));

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

app.delete('/api/templates/:id', (req, res) => {
  db.deleteTemplate(req.params.id);
  res.json({ ok: true });
});

// ── Listings ──────────────────────────────────────────────────────────────────

app.get('/api/listings', (_req, res) => res.json(db.getListings()));

app.post('/api/listings', (req, res) => {
  const l = req.body;
  if (!l.id) return res.status(400).json({ error: 'id required' });
  db.upsertListing({ id: l.id, title: l.title || '', price: l.price || '', description: l.description || '', status: l.status || 'active', url: l.url || '' });
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
  db.updateListingStatus(req.params.id, status);
  res.json({ ok: true });
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

// Create a job from a template (extension calls this when user clicks Publish)
app.post('/api/publish', (req, res) => {
  const { templateId } = req.body;
  if (!templateId) return res.status(400).json({ error: 'templateId required' });

  const template = db.getTemplate(templateId);
  if (!template) return res.status(404).json({ error: 'Template not found' });

  const job = db.createJob({
    template_id: template.id,
    title:       template.title,
    price:       template.price ? String(template.price) : '',
    description: template.description || '',
    location:    template.location || '',
    category:    template.category || '',
    photos:      template.photos || '[]',
  });
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

// ── Serve dashboard for any unknown route ─────────────────────────────────────

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'dashboard', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n  FB Marketplace Manager backend running at http://localhost:${PORT}\n`);
});
