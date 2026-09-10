// Readers that turn whatever you can export into raw customer records.
// Nothing here hashes or filters — that happens in customer-match.js. These
// only get the messy input into a common shape:
//   { name, first, last, phone, zip, value, date, status, source, raw }
const fs = require('fs');
const path = require('path');
const N = require('./normalize');

// ── CSV ──────────────────────────────────────────────────────────────────────
// Hand-rolled so the project stays dependency-free. Handles quoted fields,
// embedded commas/newlines, doubled quotes, CRLF and a UTF-8 BOM.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  const src = text.replace(/^﻿/, '');

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => String(c).trim() !== ''));
}

// Header aliases. Add to these rather than renaming columns in the export —
// the point is that you shouldn't have to reshape the spreadsheet by hand.
const COLUMN_ALIASES = {
  first:  ['first name', 'firstname', 'first', 'fname', 'given name'],
  last:   ['last name', 'lastname', 'last', 'lname', 'surname', 'family name'],
  name:   ['name', 'full name', 'customer', 'customer name', 'client', 'client name', 'contact'],
  phone:  ['phone', 'phone number', 'phone_number', 'mobile', 'cell', 'cell phone', 'telephone', 'tel', 'contact number'],
  email:  ['email', 'e-mail', 'email address'],
  zip:    ['zip', 'zipcode', 'zip code', 'postal', 'postal code', 'postcode'],
  value:  ['value', 'amount', 'revenue', 'price', 'total', 'job value', 'sale', 'sale amount', 'contract', 'invoice', 'paid'],
  date:   ['date', 'conversion time', 'close date', 'closed', 'completed', 'completion date', 'job date', 'sale date', 'created', 'created at', 'timestamp'],
  status: ['status', 'stage', 'job status', 'state', 'outcome', 'result'],
  gclid:  ['gclid', 'google click id', 'click id'],
  source: ['source', 'channel', 'lead source', 'origin'],
};

function mapHeaders(header) {
  const map = {};
  header.forEach((h, i) => {
    const key = String(h).trim().toLowerCase();
    for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
      if (aliases.includes(key) && map[field] === undefined) map[field] = i;
    }
  });
  return map;
}

function fromCsv(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { records: [], columns: {}, unmapped: [] };

  const header = rows[0];
  const map = mapHeaders(header);
  const unmapped = header.filter((h, i) => !Object.values(map).includes(i));

  const records = rows.slice(1).map((r, idx) => {
    const get = (f) => (map[f] !== undefined ? String(r[map[f]] ?? '').trim() : '');
    let first = get('first'), last = get('last');
    const name = get('name');
    if ((!first || !last) && name) {
      const s = N.splitName(name);
      first = first || s.first || '';
      last  = last  || s.last  || '';
    }
    return {
      row: idx + 2,                       // 1-indexed + header, so it matches the spreadsheet
      name: name || `${first} ${last}`.trim(),
      first, last,
      phone:  get('phone'),
      email:  get('email'),
      zip:    get('zip'),
      value:  get('value'),
      date:   get('date'),
      status: get('status'),
      gclid:  get('gclid'),
      source: get('source'),
    };
  });
  return { records, columns: map, unmapped };
}

// ── Telegram ─────────────────────────────────────────────────────────────────
// Telegram Desktop → Export chat history → JSON produces { messages: [...] },
// where `text` is either a string or an array of string/entity parts.
function telegramText(msg) {
  const t = msg.text;
  if (typeof t === 'string') return t;
  if (Array.isArray(t)) return t.map(p => (typeof p === 'string' ? p : (p && p.text) || '')).join('');
  return '';
}

const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
const ZIP_RE   = /\b\d{5}\b(?:-\d{4})?/g;

// Pull one candidate record per message that contains a phone number.
// Free-form chat has no schema, so this is deliberately conservative: it finds
// the phone and ZIP, takes a labelled name when the message has one, and hands
// everything else back for you to eyeball with --preview.
function fromTelegram(json, opts = {}) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  const msgs = data.messages || data || [];
  const records = [];

  for (const m of msgs) {
    if (m.type && m.type !== 'message') continue;
    const text = telegramText(m);
    if (!text) continue;

    const phones = text.match(PHONE_RE);
    if (!phones) continue;                       // no phone = not a customer record

    // A ZIP inside a phone number is a false positive, so search the text with
    // phone numbers removed first.
    const stripped = text.replace(PHONE_RE, ' ');
    const zips = stripped.match(ZIP_RE);

    // Labelled name ("Name: John Smith", "Customer - Jane Doe") if present,
    // otherwise the first Capitalized Two-Word run in the message.
    let nameGuess = '';
    const labelled = text.match(/(?:name|customer|client)\s*[:\-]\s*([A-Za-z'.\- ]{3,50})/i);
    if (labelled) nameGuess = labelled[1].trim();
    else {
      const cap = stripped.match(/\b([A-Z][a-z'-]{1,20}\s+[A-Z][a-z'-]{1,20})\b/);
      if (cap) nameGuess = cap[1];
    }

    const s = N.splitName(nameGuess);
    const money = text.match(/\$\s?([\d,]+(?:\.\d{2})?)/);

    records.push({
      row: m.id ?? records.length + 1,
      name: nameGuess,
      first: s.first || '',
      last:  s.last  || '',
      phone: phones[0],
      email: (text.match(/[^\s@]+@[^\s@]+\.[a-z]{2,}/i) || [''])[0],
      zip:   zips ? zips[0] : '',
      value: money ? money[1] : '',
      date:  m.date || m.date_unixtime || '',
      status: '',                                 // decided by keyword, see customer-match.js
      gclid: '',
      source: 'telegram',
      text: opts.keepText ? text : text.slice(0, 200),
    });
  }
  return { records, columns: {}, unmapped: [] };
}

// ── Dispatch on file type ────────────────────────────────────────────────────
function loadFile(file, opts = {}) {
  const raw = fs.readFileSync(file, 'utf8');
  const ext = path.extname(file).toLowerCase();
  if (ext === '.json') {
    const parsed = JSON.parse(raw);
    if (parsed.messages || (Array.isArray(parsed) && parsed[0] && parsed[0].text !== undefined)) {
      return fromTelegram(parsed, opts);
    }
    // A plain JSON array of customer objects: treat keys as CSV headers.
    const arr = Array.isArray(parsed) ? parsed : (parsed.customers || parsed.records || []);
    if (!arr.length) return { records: [], columns: {}, unmapped: [] };
    const keys = [...new Set(arr.flatMap(o => Object.keys(o)))];
    const csv = [keys.join(','), ...arr.map(o => keys.map(k => `"${String(o[k] ?? '').replace(/"/g, '""')}"`).join(','))].join('\n');
    return fromCsv(csv);
  }
  return fromCsv(raw);
}

module.exports = { parseCsv, fromCsv, fromTelegram, loadFile, COLUMN_ALIASES };
