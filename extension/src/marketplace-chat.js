// Marketplace → existing Messenger chatbot BRIDGE (read/reply loop).
//
// Personal-profile Marketplace chats have NO Meta API and NO webhook, so this
// content script bridges them at the browser layer:
//
//   inbound Marketplace message (DOM)
//        → POST localhost backend /api/marketplace/incoming
//        → backend relays to the EXISTING n8n chatbot webhook (server-side)
//        → reply text comes back
//        → injected into the Marketplace compose box (optionally auto-sent)
//
// It does NOT touch the chatbot, prompts, workflows, CRM, calendar, follow-ups,
// or Telegram. The chatbot is reused exactly as-is; this only forwards messages
// to it and types the answer back.
//
// Selectors live in selectors.js (window.FBM_SELECTORS.chat) — the single place
// to fix when Facebook changes its UI.

(function initChatBridge() {
  // Facebook is a single-page app: navigating into the inbox usually does NOT
  // reload the page, so we can't just check the URL once at injection time.
  // Instead we load on any /marketplace* page and activate/deactivate as the
  // path changes (see the SPA watcher at the bottom).
  const onChatPage = () => /\/marketplace\/(inbox|t\/)/.test(location.pathname);

  const BACKEND = 'http://localhost:3333';

  const CONFIG = {
    // FULLY AUTOMATED: the bot types AND sends the reply with no human action.
    // Set chrome.storage key `mpAutoSend` to false if you ever want to switch to
    // review-before-send (the reply is staged in the box but not sent).
    autoSend: true,
    // Ignore messages older than this on first load so we don't reply to history.
    freshnessMs: 2 * 60 * 1000,
    debounceMs: 800,
    // Send recovery: how many times to retry a send that didn't go through.
    maxSendRetries: 3,
    retryBackoffMs: 1200,
    sendVerifyMs: 700,   // wait this long, then confirm the compose box cleared
  };

  const SEL = (window.FBM_SELECTORS && window.FBM_SELECTORS.chat) || {};
  const seen = new Set();           // message keys already forwarded
  let booted = Date.now();
  let timer = null;
  let sentCount = 0;

  chrome.storage?.local?.get?.(['mpAutoSend'], v => {
    if (typeof v?.mpAutoSend === 'boolean') CONFIG.autoSend = v.mpAutoSend;
  });

  // ── Status badge (so you can confirm it's running unattended) ───────────────
  const badge = document.createElement('div');
  badge.id = 'fbm-bridge-badge';
  badge.style.cssText = [
    'position:fixed', 'bottom:16px', 'left:16px', 'z-index:2147483647',
    'font:600 12px/1.3 -apple-system,Segoe UI,Roboto,sans-serif',
    'padding:7px 11px', 'border-radius:9px', 'color:#fff',
    'background:#1f2937', 'box-shadow:0 2px 10px rgba(0,0,0,.3)',
    'display:flex', 'align-items:center', 'gap:7px', 'cursor:default',
    'max-width:300px', 'user-select:none',
  ].join(';');
  const dot = document.createElement('span');
  dot.style.cssText = 'width:9px;height:9px;border-radius:50%;flex:0 0 auto;background:#22c55e';
  const label = document.createElement('span');
  badge.append(dot, label);
  const mountBadge   = () => { if (document.body && !document.getElementById('fbm-bridge-badge')) document.body.appendChild(badge); };
  const unmountBadge = () => { badge.remove(); };

  const COLORS = { ok: '#22c55e', busy: '#f59e0b', err: '#ef4444', idle: '#22c55e' };
  function setStatus(kind, text) {
    dot.style.background = COLORS[kind] || COLORS.idle;
    if (kind === 'busy') { dot.style.animation = 'fbmPulse 1s infinite'; } else { dot.style.animation = 'none'; }
    label.textContent = text;
  }
  // keyframes for the pulse
  const kf = document.createElement('style');
  kf.textContent = '@keyframes fbmPulse{0%,100%{opacity:1}50%{opacity:.35}}';
  (document.head || document.documentElement).appendChild(kf);

  // ── DOM helpers ───────────────────────────────────────────────────────────
  const $  = (s, root = document) => (s ? root.querySelector(s) : null);
  const $$ = (s, root = document) => (s ? Array.from(root.querySelectorAll(s)) : []);
  const visible = el => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 1 && r.height > 1; };

  function threadId() {
    const m = location.pathname.match(/\/marketplace\/t\/(\d+)/) || location.pathname.match(/\/t\/(\d+)/);
    return m ? m[1] : (location.pathname || 'unknown');
  }

  function contactName() {
    const el = $(SEL.contactName);
    return (el?.textContent || '').trim() || null;
  }

  // The latest INBOUND (from the buyer, not "You") message bubble + its text.
  function latestInbound() {
    const rows = $$(SEL.messageRow).filter(visible);
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      if (isOutbound(row)) continue;          // skip our own messages
      const text = readText(row);
      if (text) return { row, text };
    }
    return null;
  }

  // Outbound detection: Facebook aligns the sender's own messages differently.
  // We treat a row as outbound if it matches the outbound marker selector, or
  // if it carries our injected marker (so we never echo the bot's own reply).
  function isOutbound(row) {
    if (row.dataset && row.dataset.fbmBot === '1') return true;
    if (SEL.outboundMarker && row.querySelector(SEL.outboundMarker)) return true;
    if (SEL.outboundRowMatch) { try { if (row.matches(SEL.outboundRowMatch)) return true; } catch (_) {} }
    return false;
  }

  function readText(row) {
    const el = SEL.messageText ? row.querySelector(SEL.messageText) : row;
    return (el?.textContent || '').trim();
  }

  // ── Bridge core ───────────────────────────────────────────────────────────
  async function check() {
    const inbound = latestInbound();
    if (!inbound) return;

    const tid = threadId();
    const key = `${tid}::${inbound.text}`;
    if (seen.has(key)) return;                 // de-dupe (don't forward twice)
    seen.add(key);

    // On the very first scan, only react to messages that arrived after boot so
    // we don't reply to the whole back-history when the inbox first loads.
    if (Date.now() - booted < CONFIG.freshnessMs && seen.size > 3) return;

    const payload = {
      source: 'marketplace',
      sender_id: tid,                          // stable per-thread id
      thread_id: tid,
      sender_name: contactName(),
      text: inbound.text,
      timestamp: new Date().toISOString(),
    };

    let reply;
    try {
      setStatus('busy', 'Asking chatbot…');
      const res = await fetch(`${BACKEND}/api/marketplace/incoming`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        console.warn('[FBM bridge] backend error', res.status, data);
        setStatus('err', `Backend ${res.status} — see dashboard Logs`);
        seen.delete(key);                       // allow a retry on the next tick
        return;
      }
      reply = data && (data.reply || data.text || data.message);
    } catch (err) {
      console.warn('[FBM bridge] cannot reach backend — keep start.bat running.', err.message);
      setStatus('err', 'Backend offline — run start.bat');
      seen.delete(key);
      return;
    }

    if (!reply) { setStatus('err', 'Empty reply from chatbot'); return; }

    const ok = await deliverReply(String(reply));
    if (ok) {
      sentCount++;
      setStatus('ok', `Sent ✓ ${sentCount} · ${new Date().toLocaleTimeString()}`);
    } else {
      setStatus('err', 'Send failed — check selectors.chat');
      seen.delete(key);                          // let it try again next tick
    }
  }

  // Type the reply into the compose box and (if autoSend) send it, verifying it
  // actually went out and retrying a few times before giving up.
  async function deliverReply(text) {
    if (!CONFIG.autoSend) {
      const staged = stage(text);
      setStatus(staged ? 'busy' : 'err', staged ? 'Reply staged — press Enter' : 'Compose box not found');
      return staged; // "delivered" in suggest mode = successfully staged
    }

    for (let attempt = 1; attempt <= CONFIG.maxSendRetries; attempt++) {
      setStatus('busy', attempt === 1 ? 'Sending…' : `Sending… (retry ${attempt - 1})`);
      if (!stage(text)) { await sleep(CONFIG.retryBackoffMs); continue; }
      pressSend();
      await sleep(CONFIG.sendVerifyMs);
      if (sendLooksConfirmed(text)) return true;  // box cleared / reply visible
      await sleep(CONFIG.retryBackoffMs * attempt);
    }
    return false;
  }

  // Put the reply text into the contenteditable compose box. Returns false if
  // the box can't be found (selector needs updating).
  function stage(text) {
    const box = $(SEL.composeBox);
    if (!box || !visible(box)) {
      console.warn('[FBM bridge] compose box not found — update selectors.chat.composeBox');
      return false;
    }
    box.focus();
    // Clear anything already typed, then insert. execCommand fires the input
    // events FB's Lexical/Draft editor listens for far more reliably than
    // setting textContent.
    try { document.execCommand('selectAll', false, null); document.execCommand('delete', false, null); } catch (_) {}
    document.execCommand('insertText', false, text);
    box.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
    return true;
  }

  function pressSend() {
    const btn = $(SEL.sendButton);
    if (btn && visible(btn)) { btn.click(); return; }
    const box = $(SEL.composeBox);
    box?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
  }

  // Heuristic confirmation: after a successful send FB clears the compose box,
  // so an empty box (and our text now appearing in the thread) means it went.
  function sendLooksConfirmed(text) {
    const box = $(SEL.composeBox);
    const boxEmpty = !box || !(box.textContent || '').trim();
    const inThread = $$(SEL.messageRow).some(r => (r.textContent || '').includes(text.slice(0, 40)));
    return boxEmpty || inThread;
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ── Observe the thread for new messages ─────────────────────────────────────
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => check().catch(e => console.warn('[FBM bridge]', e)), CONFIG.debounceMs);
  }

  // ── Activate / deactivate as the SPA navigates ─────────────────────────────
  let active = false;
  let observer = null;

  function activate() {
    if (active) return;
    active = true;
    booted = Date.now();
    seen.clear();
    mountBadge();
    setStatus('idle', CONFIG.autoSend ? 'Bridge active · auto-reply on' : 'Bridge active · review mode');
    const target = $(SEL.messageList) || document.body;
    observer = new MutationObserver(schedule);
    observer.observe(target, { childList: true, subtree: true });
    schedule();
    console.info('[FBM bridge] active on', location.pathname, '(autoSend:', CONFIG.autoSend, ')');
  }

  function deactivate() {
    if (!active) return;
    active = false;
    clearTimeout(timer);
    observer?.disconnect();
    observer = null;
    unmountBadge();
  }

  // Watch for SPA path changes (Facebook doesn't reload when you open a chat).
  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      if (onChatPage()) { deactivate(); activate(); } else { deactivate(); }
    } else if (onChatPage() && !active) {
      activate();           // first time the inbox DOM becomes available
    }
  }, 1000);

  if (onChatPage()) activate();
})();
