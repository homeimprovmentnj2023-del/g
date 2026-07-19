// Dispatch notifications: SMS via Twilio when configured, otherwise composed
// messages + click-to-send links (WhatsApp / sms:) the dashboard user taps.
//
// Twilio is OPTIONAL. Without TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN /
// TWILIO_FROM in backend/.env, sendSMS() returns { ok:false, manual:true } and
// callers fall back to the wa/sms links — nothing breaks, dispatch just needs
// one manual tap. Secrets stay in .env (never committed).

// ── Phone / link helpers ──────────────────────────────────────────────────────

// Normalize a US phone to E.164 (+1XXXXXXXXXX). Returns '' when hopeless.
function normPhone(p) {
  const raw = String(p || '').trim();
  const d = raw.replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d[0] === '1') return '+' + d;
  if (raw.startsWith('+') && d.length >= 8) return '+' + d;
  return '';
}

// Google Maps link for the job's full address (address, city, state zip).
function mapsLink(job) {
  const j = job || {};
  const full = [j.address, j.city, [j.state, j.zip].filter(Boolean).join(' ')]
    .map(s => String(s || '').trim()).filter(Boolean).join(', ');
  return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(full);
}

// Click-to-send links (used when Twilio isn't configured, or as a backup).
function waLink(phone, text) {
  const digits = String(normPhone(phone) || phone || '').replace(/\D/g, '');
  return 'https://wa.me/' + digits + '?text=' + encodeURIComponent(String(text || ''));
}
function smsLink(phone, text) {
  return 'sms:' + (normPhone(phone) || String(phone || '')) + '?&body=' + encodeURIComponent(String(text || ''));
}

// ── Message composition ───────────────────────────────────────────────────────

// 'Mon Jul 20, 10:00 AM' in server-local time ('' when unscheduled).
function fmtAppt(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  const wd = d.toLocaleDateString('en-US', { weekday: 'short' });
  const mo = d.toLocaleDateString('en-US', { month: 'short' });
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${wd} ${mo} ${d.getDate()}, ${time}`;
}

// Plain-text Job Card for the technician — clean label: value lines (WhatsApp-safe).
function composeTechMessage(job, tech) {
  const j = job || {};
  const fullAddr = [j.address, j.city, [j.state, j.zip].filter(Boolean).join(' ')]
    .map(s => String(s || '').trim()).filter(Boolean).join(', ');
  const lines = [];
  lines.push('NEW JOB' + (tech && tech.name ? ` — for ${tech.name}` : ''));
  lines.push(`Customer: ${j.customer_name || '-'}`);
  lines.push(`Phone: ${j.phone || '-'}`);
  lines.push(`Address: ${fullAddr || '-'}`);
  lines.push(`Services: ${j.services || '-'}`);
  if (j.price != null && j.price !== '') lines.push(`Price: $${j.price}`);
  lines.push(`Date/Time: ${fmtAppt(j.appointment_at) || 'to be scheduled'}`);
  const photos = Array.isArray(j.photos) ? j.photos.filter(Boolean) : [];
  if (photos.length) {
    lines.push('Photos:');
    photos.forEach(u => lines.push(String(u)));
  }
  if (j.notes) lines.push(`Notes: ${j.notes}`);
  lines.push(`Maps: ${mapsLink(j)}`);
  return lines.join('\n');
}

// Professional confirmation SMS for the customer.
function composeCustomerSMS(job) {
  const j = job || {};
  const first = String(j.customer_name || '').trim().split(/\s+/)[0] || 'there';
  const when = fmtAppt(j.appointment_at);
  return [
    `Hi ${first}, this is the Bathtub Reglazing Team.`,
    when
      ? `We have you scheduled for ${when} at ${[j.address, j.city].filter(Boolean).join(', ') || 'your address'}.`
      : `We are confirming your upcoming service appointment.`,
    `This is a scheduled service appointment, not an estimate.`,
    `Please reply YES to confirm your appointment.`,
    `— Bathtub Reglazing Team`,
  ].join(' ');
}

// ── Twilio sender (optional) ──────────────────────────────────────────────────

// Send an SMS through Twilio when configured. Not configured → { ok:false,
// manual:true } so the caller falls back to the click-to-send links above.
async function sendSMS(to, text) {
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from  = process.env.TWILIO_FROM;
  if (!sid || !token || !from) return { ok: false, manual: true };

  const dest = normPhone(to);
  if (!dest) return { ok: false, error: 'invalid phone: ' + to };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const body = new URLSearchParams({ To: dest, From: from, Body: String(text || '') });
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: (data && data.message) || `Twilio ${res.status}` };
    return { ok: true, sid: data.sid };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'Twilio timeout (10s)' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { sendSMS, normPhone, mapsLink, waLink, smsLink, composeTechMessage, composeCustomerSMS, fmtAppt };
