// Normalization + hashing for Google Ads customer data uploads.
//
// Google matches on SHA-256 hashes of NORMALIZED values. If the normalization
// differs from theirs by even one character the hash differs and the record
// silently matches nothing — no error, just a zero match rate. So every rule
// here mirrors Google's documented normalization exactly.
const crypto = require('crypto');

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

// Strip accents so "José" and "Jose" hash alike.
const deaccent = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

const TITLES   = /^(mr|mrs|ms|miss|dr|prof|rev|sir|madam)\.?\s+/i;
const SUFFIXES = /\s+(jr|sr|ii|iii|iv|v|md|phd|esq)\.?$/i;

// ── Phone → E.164 ────────────────────────────────────────────────────────────
// "(973) 555-0142" → "+19735550142". Returns null if it can't be made valid,
// because a malformed number is worse than an absent one: it counts against
// the list's match rate.
function phoneE164(raw, defaultCountry = '1') {
  if (!raw) return null;
  let d = String(raw).trim();
  const hadPlus = d.startsWith('+');
  d = d.replace(/\D/g, '');
  if (!d) return null;

  if (!hadPlus) {
    // US/CA: 10 digits needs the country code; 11 starting with 1 already has it.
    if (d.length === 10) d = defaultCountry + d;
    else if (d.length === 11 && d.startsWith('1')) { /* already E.164 digits */ }
    else if (d.length < 10) return null;   // too short to be a real number
  }
  if (d.length < 8 || d.length > 15) return null;  // E.164 allows max 15 digits
  return '+' + d;
}

// ── Name ─────────────────────────────────────────────────────────────────────
function normName(raw) {
  if (!raw) return null;
  let s = deaccent(String(raw)).trim().replace(TITLES, '').replace(SUFFIXES, '');
  s = s.toLowerCase().replace(/[^a-z\s'-]/g, '').replace(/\s+/g, ' ').trim();
  return s || null;
}

// Split "John Smith" / "Smith, John" into first + last.
function splitName(raw) {
  if (!raw) return { first: null, last: null };
  let s = String(raw).trim();
  if (s.includes(',')) {
    const [last, first] = s.split(',', 2);
    return { first: normName(first), last: normName(last) };
  }
  const parts = normName(s)?.split(' ').filter(Boolean) || [];
  if (parts.length === 0) return { first: null, last: null };
  if (parts.length === 1) return { first: parts[0], last: null };
  return { first: parts[0], last: parts[parts.length - 1] };
}

// ── Email ────────────────────────────────────────────────────────────────────
function normEmail(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) ? s : null;
}

// ── ZIP / country ────────────────────────────────────────────────────────────
// NOTE: postal code and country code are sent to Google in PLAINTEXT. Hashing
// them is the single most common cause of a 0% match rate on address records.
function normZip(raw) {
  if (!raw) return null;
  const m = String(raw).match(/\d{5}/);
  return m ? m[0] : null;
}

// ── Conversion timestamp ─────────────────────────────────────────────────────
// Google requires "yyyy-MM-dd HH:mm:ss+|-HH:mm" — the offset is mandatory.
function gadsDateTime(d) {
  const pad = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const oh = pad(Math.floor(Math.abs(off) / 60));
  const om = pad(Math.abs(off) % 60);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${oh}:${om}`;
}

// Accepts ISO, US M/D/YYYY, and unix seconds/millis. Returns a Date or null.
function parseDate(raw) {
  if (raw == null || raw === '') return null;
  if (raw instanceof Date) return isNaN(raw) ? null : raw;
  const s = String(raw).trim();

  if (/^\d{10}$/.test(s)) return new Date(Number(s) * 1000);
  if (/^\d{13}$/.test(s)) return new Date(Number(s));

  const us = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})(.*)$/);
  if (us) {
    const yr = us[3].length === 2 ? 2000 + Number(us[3]) : Number(us[3]);
    const d = new Date(`${yr}-${String(us[1]).padStart(2, '0')}-${String(us[2]).padStart(2, '0')}${us[4] ? ' ' + us[4].trim() : ''}`);
    if (!isNaN(d)) return d;
  }
  const d = new Date(s);
  return isNaN(d) ? null : d;
}

// ── Money ────────────────────────────────────────────────────────────────────
function parseMoney(raw) {
  if (raw == null || raw === '') return null;
  const n = parseFloat(String(raw).replace(/[^0-9.-]/g, ''));
  return isNaN(n) ? null : n;
}

module.exports = { sha256, phoneE164, normName, splitName, normEmail, normZip, gadsDateTime, parseDate, parseMoney };
