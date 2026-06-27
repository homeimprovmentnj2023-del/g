const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'fbm.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS templates (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    title     TEXT NOT NULL,
    price     REAL,
    location  TEXT,
    description TEXT,
    photos    TEXT DEFAULT '[]',
    created_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS listings (
    id         TEXT PRIMARY KEY,
    title      TEXT,
    price      TEXT,
    description TEXT,
    status     TEXT DEFAULT 'active',
    url        TEXT,
    area       TEXT,
    template_id INTEGER REFERENCES templates(id),
    first_seen INTEGER DEFAULT (unixepoch()),
    last_seen  INTEGER DEFAULT (unixepoch()),
    last_checked INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS listing_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    listing_id TEXT NOT NULL REFERENCES listings(id),
    event      TEXT NOT NULL,
    detail     TEXT,
    at         INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS competitors (
    id         TEXT PRIMARY KEY,
    title      TEXT,
    price      TEXT,
    location   TEXT,
    url        TEXT,
    category   TEXT,
    first_seen INTEGER DEFAULT (unixepoch()),
    last_seen  INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS ai_suggestions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    listing_id   TEXT,
    template_id  INTEGER,
    type         TEXT,
    suggestion   TEXT,
    created_at   INTEGER DEFAULT (unixepoch())
  );
`);

// ── Templates ─────────────────────────────────────────────────────────────────

const stmt = {
  insertTemplate: db.prepare('INSERT INTO templates (title, price, location, description, photos) VALUES (?, ?, ?, ?, ?)'),
  getTemplates:   db.prepare('SELECT * FROM templates ORDER BY created_at DESC'),
  getTemplate:    db.prepare('SELECT * FROM templates WHERE id = ?'),
  deleteTemplate: db.prepare('DELETE FROM templates WHERE id = ?'),

  upsertListing: db.prepare(`
    INSERT INTO listings (id, title, price, description, status, url, last_seen)
    VALUES (@id, @title, @price, @description, @status, @url, unixepoch())
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      price = excluded.price,
      status = excluded.status,
      last_seen = unixepoch()
  `),
  getListings:   db.prepare('SELECT * FROM listings ORDER BY last_seen DESC'),
  getListing:    db.prepare('SELECT * FROM listings WHERE id = ?'),
  updateStatus:  db.prepare('UPDATE listings SET status = ?, last_checked = unixepoch() WHERE id = ?'),
  getStale:      db.prepare(`SELECT * FROM listings WHERE status = 'active' AND last_checked < unixepoch() - 3600`),

  insertEvent: db.prepare('INSERT INTO listing_events (listing_id, event, detail) VALUES (?, ?, ?)'),
  getEvents:   db.prepare('SELECT * FROM listing_events WHERE listing_id = ? ORDER BY at DESC'),

  upsertCompetitor: db.prepare(`
    INSERT INTO competitors (id, title, price, location, url, last_seen)
    VALUES (@id, @title, @price, @location, @url, unixepoch())
    ON CONFLICT(id) DO UPDATE SET title = excluded.title, price = excluded.price, last_seen = unixepoch()
  `),
  getCompetitors: db.prepare('SELECT * FROM competitors ORDER BY last_seen DESC LIMIT 200'),

  insertSuggestion: db.prepare('INSERT INTO ai_suggestions (listing_id, template_id, type, suggestion) VALUES (?, ?, ?, ?)'),
  getSuggestions:   db.prepare('SELECT * FROM ai_suggestions ORDER BY created_at DESC LIMIT 50'),
};

module.exports = {
  // Templates
  createTemplate: (t) => {
    const info = stmt.insertTemplate.run(t.title, t.price || null, t.location || null, t.description || null, JSON.stringify(t.photos || []));
    return stmt.getTemplate.get(info.lastInsertRowid);
  },
  getTemplates: () => stmt.getTemplates.all(),
  getTemplate:  (id) => stmt.getTemplate.get(id),
  deleteTemplate: (id) => stmt.deleteTemplate.run(id),

  // Listings
  upsertListing: (l) => stmt.upsertListing.run(l),
  upsertListings: db.transaction((listings) => listings.forEach(l => stmt.upsertListing.run(l))),
  getListings: () => stmt.getListings.all(),
  getListing:  (id) => stmt.getListing.get(id),
  updateListingStatus: (id, status) => {
    stmt.updateStatus.run(status, id);
    stmt.insertEvent.run(id, 'status_change', status);
  },
  getStaleListings: () => stmt.getStale.all(),
  getListingEvents: (id) => stmt.getEvents.all(id),

  // Competitors
  upsertCompetitors: db.transaction((comps) => comps.forEach(c => stmt.upsertCompetitor.run(c))),
  getCompetitors: () => stmt.getCompetitors.all(),

  // AI suggestions
  saveSuggestion: (listingId, templateId, type, text) => stmt.insertSuggestion.run(listingId, templateId, type, text),
  getSuggestions: () => stmt.getSuggestions.all(),
};
