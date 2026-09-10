// Turns raw customer records into a Google Ads Customer Match upload.
//
// Order matters and each step is deliberate:
//   1. keep only jobs that actually completed  (a lead that never booked is not a customer)
//   2. keep only the requested window          (default: last 30 days)
//   3. dedupe                                  (one person = one list member)
//   4. normalize + SHA-256                     (Google matches on hashes of normalized values)
const N = require('./normalize');

// Words that mark a job as really done vs. one that never happened. These are
// substring matches against the status/stage column, lowercased.
const COMPLETED_WORDS = [
  'complete', 'completed', 'done', 'booked', 'won', 'closed won', 'closed-won',
  'paid', 'installed', 'finished', 'fulfilled', 'sold', 'job done', 'serviced',
];
const EXCLUDED_WORDS = [
  'lead', 'quote', 'quoted', 'estimate', 'estimating', 'pending', 'follow up', 'follow-up',
  'no answer', 'no-answer', 'noanswer', 'cancel', 'cancelled', 'canceled', 'lost',
  'no show', 'no-show', 'declined', 'rejected', 'refund', 'refunded', 'open', 'new',
];

function classify(status, { completedWords = COMPLETED_WORDS, excludedWords = EXCLUDED_WORDS } = {}) {
  const s = String(status || '').trim().toLowerCase();
  if (!s) return 'unknown';
  // Exclusions win: "quote completed" is still a quote, not a finished job.
  if (excludedWords.some(w => s.includes(w))) return 'excluded';
  if (completedWords.some(w => s.includes(w))) return 'completed';
  return 'unknown';
}

// Build the deduplication key. Phone is the strongest identity signal we have,
// so prefer it; fall back to name+ZIP only when there is no usable phone.
function dedupeKey(r) {
  if (r.phone_e164) return 'p:' + r.phone_e164;
  if (r.first && r.last && r.zip) return 'n:' + r.first + '|' + r.last + '|' + r.zip;
  return null;
}

/**
 * @param {Array} records  raw records from importers.js
 * @param {Object} opts
 *   days              window in days (default 30; 0 = no date filter)
 *   countryCode       ISO-2, default 'US'
 *   assumeCompleted   treat records with no status column as completed
 *   completedIfValue  treat a record with value > 0 as completed
 *   now               injectable clock, for tests
 */
function build(records, opts = {}) {
  const {
    days = 30, countryCode = 'US',
    assumeCompleted = false, completedIfValue = false,
    now = new Date(),
  } = opts;

  const cutoff = days > 0 ? new Date(now.getTime() - days * 86400000) : null;
  const stats = {
    input: records.length,
    droppedNotCompleted: 0, droppedUnknownStatus: 0,
    droppedOutOfWindow: 0, droppedNoDate: 0,
    droppedNoIdentifier: 0, droppedDuplicate: 0,
  };
  const rejects = [];
  const seen = new Map();
  const members = [];

  const anyStatus = records.some(r => String(r.status || '').trim() !== '');

  for (const r of records) {
    const value = N.parseMoney(r.value);

    // ── 1. completed only ────────────────────────────────────────────────────
    let verdict = classify(r.status, opts);
    if (verdict === 'unknown') {
      if (completedIfValue && value > 0) verdict = 'completed';
      else if (!anyStatus && assumeCompleted) verdict = 'completed';
    }
    if (verdict === 'excluded') { stats.droppedNotCompleted++; rejects.push({ row: r.row, why: `status "${r.status}" is not a completed job` }); continue; }
    if (verdict !== 'completed') { stats.droppedUnknownStatus++; rejects.push({ row: r.row, why: r.status ? `status "${r.status}" not recognized as completed` : 'no status column — cannot confirm the job completed' }); continue; }

    // ── 2. window ────────────────────────────────────────────────────────────
    const date = N.parseDate(r.date);
    if (cutoff) {
      if (!date) { stats.droppedNoDate++; rejects.push({ row: r.row, why: 'no usable date — cannot confirm it falls in the window' }); continue; }
      if (date < cutoff || date > now) { stats.droppedOutOfWindow++; rejects.push({ row: r.row, why: `date ${date.toISOString().slice(0, 10)} outside the last ${days} days` }); continue; }
    }

    // ── 3+4. identity ────────────────────────────────────────────────────────
    const phone_e164 = N.phoneE164(r.phone);
    const first = r.first ? N.normName(r.first) : null;
    const last  = r.last  ? N.normName(r.last)  : null;
    const email = N.normEmail(r.email);
    const zip   = N.normZip(r.zip);

    // Address matching needs first + last + country + ZIP together; any one
    // missing makes the whole address identifier inert.
    const addressUsable = Boolean(first && last && zip);
    if (!phone_e164 && !email && !addressUsable) {
      stats.droppedNoIdentifier++;
      rejects.push({ row: r.row, why: 'no usable phone, email, or complete name+ZIP' });
      continue;
    }

    const key = dedupeKey({ phone_e164, first, last, zip });
    if (key && seen.has(key)) {
      stats.droppedDuplicate++;
      // Same person, seen again. The identity hashes are identical either way,
      // so keep the member we already emitted but roll its date/value forward
      // to the most recent job — that is what the conversions path reads.
      const prev = seen.get(key);
      if (date && (!prev.date || date > prev.date)) { prev.date = date; prev.value = value; }
      continue;
    }

    const member = {
      phone_last4: phone_e164 ? phone_e164.slice(-4) : null,
      zip, countryCode,
      hasPhone: Boolean(phone_e164), hasEmail: Boolean(email), hasAddress: addressUsable,
      value, date,
      // Hashes are the only identity that leaves this machine.
      hashed: {
        phone: phone_e164 ? N.sha256(phone_e164) : null,
        email: email ? N.sha256(email) : null,
        first: addressUsable ? N.sha256(first) : null,
        last:  addressUsable ? N.sha256(last)  : null,
      },
      _key: key,
    };
    members.push(member);
    if (key) seen.set(key, member);
  }

  stats.output = members.length;
  return { members, stats, rejects };
}

// ── Google Ads API: OfflineUserDataJobService operations ─────────────────────
function toApiOperations(members, { countryCode = 'US' } = {}) {
  return members.map(m => {
    const userIdentifiers = [];
    if (m.hashed.phone) userIdentifiers.push({ hashedPhoneNumber: m.hashed.phone, userIdentifierSource: 'FIRST_PARTY' });
    if (m.hashed.email) userIdentifiers.push({ hashedEmail: m.hashed.email, userIdentifierSource: 'FIRST_PARTY' });
    if (m.hasAddress) {
      userIdentifiers.push({
        addressInfo: {
          hashedFirstName: m.hashed.first,
          hashedLastName:  m.hashed.last,
          countryCode:     m.countryCode || countryCode,  // plaintext, never hashed
          postalCode:      m.zip,                         // plaintext, never hashed
        },
        userIdentifierSource: 'FIRST_PARTY',
      });
    }
    // Google rejects a UserData carrying more than 5 identifiers.
    return { create: { userIdentifiers: userIdentifiers.slice(0, 5) } };
  });
}

// The three calls, in order, with the operations embedded — so the upload is a
// copy-paste away once the developer token clears.
function toApiPlan(members, opts = {}) {
  const { customerId = 'YOUR_CUSTOMER_ID', userListId = 'YOUR_USER_LIST_ID', apiVersion = 'v21', consent = 'GRANTED' } = opts;
  const base = `https://googleads.googleapis.com/${apiVersion}/customers/${customerId}`;
  return {
    notes: [
      'Run these three calls in order. Step 2 may be repeated; cap each batch at ~10k operations.',
      'Headers on every call: Authorization: Bearer <token>, developer-token: <token>, login-customer-id: <MCC id>.',
      'countryCode and postalCode are intentionally NOT hashed — hashing them yields a 0% match rate.',
    ],
    steps: [
      {
        step: 1, name: 'create job', method: 'POST', url: `${base}/offlineUserDataJobs:create`,
        body: {
          job: {
            type: 'CUSTOMER_MATCH_USER_LIST',
            customerMatchUserListMetadata: {
              userList: `customers/${customerId}/userLists/${userListId}`,
              consent: { adUserData: consent, adPersonalization: consent },
            },
          },
        },
      },
      {
        step: 2, name: 'add members', method: 'POST', url: `${base}/offlineUserDataJobs/{JOB_ID}:addOperations`,
        body: { enablePartialFailure: true, operations: toApiOperations(members, opts) },
      },
      {
        step: 3, name: 'run job', method: 'POST', url: `${base}/offlineUserDataJobs/{JOB_ID}:run`,
        body: {},
      },
    ],
  };
}

// ── Fallback path: hashed CSV for the Google Ads UI uploader ─────────────────
// Verify these headers against the template you download from
// Audience manager -> your list -> Upload, since Google rejects header drift.
function toCsv(members) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['Email', 'Phone', 'First Name', 'Last Name', 'Country', 'Zip'];
  const lines = members.map(m => [
    m.hashed.email || '', m.hashed.phone || '',
    m.hashed.first || '', m.hashed.last || '',
    m.hasAddress ? m.countryCode : '', m.hasAddress ? m.zip : '',
  ].map(esc).join(','));
  return [head.join(','), ...lines].join('\n') + '\n';
}

module.exports = { build, classify, toApiOperations, toApiPlan, toCsv, COMPLETED_WORDS, EXCLUDED_WORDS };
