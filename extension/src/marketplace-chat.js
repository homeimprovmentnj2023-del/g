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
    debounceMs: 350,
    // Send recovery: how many times to retry a send that didn't go through.
    maxSendRetries: 3,
    retryBackoffMs: 1200,
    sendVerifyMs: 700,   // wait this long, then confirm the compose box cleared
  };

  const SEL = (window.FBM_SELECTORS && window.FBM_SELECTORS.chat) || {};
  const seen = new Set();           // message keys already forwarded
  const botSent = new Set();        // normalized texts WE sent — never treat as inbound
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
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

  // ── Robust reading via Facebook's accessibility labels ─────────────────────
  // FB's CSS classes are obfuscated and change constantly, but every message
  // exposes a stable aria-label like "Message sent 5:12 PM by <Name>: <text>".
  // We read those, and identify the buyer from the compose box's
  // "Write to <Buyer · Listing>" label — so we only reply to genuine Marketplace
  // chats and never to our own messages.

  function composeBox() {
    return document.querySelector(
      (SEL.composeBox || '') + (SEL.composeBox ? ',' : '') +
      'div[role="textbox"][contenteditable="true"],[contenteditable="true"][role="textbox"],div[aria-label^="Write to"]'
    );
  }

  // The open conversation: title ("Buyer · Listing") + buyer display name.
  function conversationInfo() {
    const box = composeBox();
    const al = box ? (box.getAttribute('aria-label') || '') : '';
    const m = al.match(/^\s*(?:Write to|Message)\s+(.+?)\s*$/i);
    const title = m ? m[1].trim() : '';                 // "Luis · Bathtub glaze"
    const buyer = (title.split('·')[0] || '').trim() || null;
    return { title, buyer, listing: (title.split('·')[1] || '').trim() || null };
  }

  function threadId() {
    const { title } = conversationInfo();
    if (title) return 'mp_' + title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    const m = location.pathname.match(/\/t\/(\d+)/);
    return m ? m[1] : (location.pathname || 'unknown');
  }

  function contactName() { return conversationInfo().buyer; }

  // All parsed messages in the open thread, in DOM order.
  function scanMessages() {
    const out = [];
    const seenLabels = new Set();
    document.querySelectorAll('[aria-label]').forEach(el => {
      const a = el.getAttribute('aria-label') || '';
      if (!/\bmessage\b/i.test(a)) return;
      const m = a.match(/\bby\s+(.+?):\s*([\s\S]+?)\s*$/i);   // "…by <Sender>: <text>"
      if (!m) return;
      if (seenLabels.has(a)) return; seenLabels.add(a);
      out.push({ el, sender: m[1].trim(), text: m[2].trim(), raw: a, bot: !!(el.dataset && el.dataset.fbmBot === '1') });
    });
    return out;
  }

  // Latest message ONLY IF it's the buyer's (so the bot answers, and never
  // replies to itself or to a thread where we had the last word).
  function latestInbound() {
    const msgs = scanMessages().filter(m => !m.bot && !botSent.has(norm(m.text)));
    if (!msgs.length) return null;
    const last = msgs[msgs.length - 1];
    const { buyer } = conversationInfo();
    const fromBuyer = buyer ? last.sender.toLowerCase().includes(buyer.toLowerCase()) : true;
    return (fromBuyer && last.text) ? { row: last.el, text: last.text, sender: last.sender } : null;
  }

  // ── Self-diagnostic: report what we see to the dashboard (so calibration can
  //    be verified live, no manual capture needed). Throttled + change-gated.
  let _diagAt = 0, _diagKey = '';
  function reportDiag(extra) {
    try {
      const msgs = scanMessages();
      const info = conversationInfo();
      const key = msgs.map(m => m.raw).join('|').slice(0, 800);
      if (key === _diagKey && Date.now() - _diagAt < 8000) return;
      _diagKey = key; _diagAt = Date.now();
      fetch(`${BACKEND}/api/debug`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'mp-bridge-diag', url: location.href, conversation: info,
          messages: msgs.slice(-8).map(m => ({ sender: m.sender, text: m.text.slice(0, 80), bot: m.bot, raw: m.raw })),
          ...(extra || {}),
        }),
      }).catch(() => {});
    } catch (_) {}
  }

  // ── Bridge core ───────────────────────────────────────────────────────────
  async function check() {
    reportDiag();
    // Marketplace-only lock: only act inside a real open Marketplace conversation
    // (the compose box reads "Write to <Buyer · Listing>"). Ignores everything else.
    if (!conversationInfo().title) return;

    const inbound = latestInbound();
    if (!inbound) return;

    const tid = threadId();
    const key = `${tid}::${inbound.text}`;
    if (seen.has(key)) return;                 // de-dupe (don't forward twice)
    seen.add(key);

    // On the very first scan, only react to messages that arrived after boot so
    // we don't reply to the whole back-history when the inbox first loads.
    if (Date.now() - booted < CONFIG.freshnessMs && seen.size > 3) return;

    // Conversation memory: send the recent thread (read from the DOM) so the bot
    // has context — Marketplace chats aren't stored in the bot's database.
    const { buyer } = conversationInfo();
    const roleOf = m => (m.bot || botSent.has(norm(m.text)) || !(buyer && m.sender.toLowerCase().includes(buyer.toLowerCase()))) ? 'You' : 'Customer';
    const history = scanMessages().slice(-13, -1).map(m => ({ role: roleOf(m), text: m.text }));

    const payload = {
      source: 'marketplace',
      sender_id: tid,                          // stable per-thread id
      thread_id: tid,
      sender_name: contactName(),
      text: inbound.text,
      timestamp: new Date().toISOString(),
      history,                                  // recent thread for context/memory
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

    botSent.add(norm(text));            // never answer our own reply (name-collision safe)
    for (let attempt = 1; attempt <= CONFIG.maxSendRetries; attempt++) {
      setStatus('busy', attempt === 1 ? 'Sending…' : `Sending… (retry ${attempt - 1})`);
      if (!stage(text)) { await sleep(CONFIG.retryBackoffMs); continue; }
      await sleep(450);                 // let Facebook swap the "like" thumb for the Send button
      pressSend(attempt);
      await sleep(CONFIG.sendVerifyMs);
      if (sendLooksConfirmed(text)) return true;  // box cleared / reply visible
      await sleep(CONFIG.retryBackoffMs * attempt);
    }
    return false;
  }

  // Put the reply text into the contenteditable compose box. Returns false if
  // the box can't be found (selector needs updating).
  function stage(text) {
    const box = composeBox();
    if (!box || !visible(box)) {
      console.warn('[FBM bridge] compose box not found — update selectors.chat.composeBox');
      return false;
    }
    box.focus();
    // Clear anything already typed, then insert. execCommand fires the input
    // events FB's Lexical/Draft editor listens for far more reliably than
    // setting textContent.
    try { document.execCommand('selectAll', false, null); document.execCommand('delete', false, null); } catch (_) {}
    // If the editor didn't clear, force it — otherwise a retry appends and the
    // reply gets duplicated inside one message ("texttext").
    if ((box.textContent || '').trim()) {
      try { box.textContent = ''; box.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' })); } catch (_) {}
    }
    if ((box.textContent || '').trim()) return false;   // still not empty — don't risk doubling
    document.execCommand('insertText', false, text);
    box.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
    return true;
  }

  // The composer toolbar — the ancestor that holds BOTH the action buttons (emoji,
  // attach, like…) and the text box. Scopes our search so we never grab header or
  // conversation-list buttons.
  function composerRoot() {
    const box = composeBox();
    const anchor = document.querySelector(
      '[aria-label="Choose an emoji"],[aria-label="Choose a GIF"],[aria-label="Choose a sticker"],' +
      '[aria-label="Attach a file up to 25 MB"],[aria-label="Send a like"],[aria-label="Send a voice clip"]'
    );
    if (anchor && box) { let el = anchor; for (let i = 0; i < 9 && el; i++) { if (el.contains(box)) return el; el = el.parentElement; } }
    return anchor ? anchor.parentElement : (box ? box.parentElement : null);
  }

  // Known composer icons that are NOT "send" — everything left over is the Send button.
  const NON_SEND = /voice clip|attach|sticker|gif|emoji|\blike\b|notification|new message|more|menu|info|call|video|search|settings|details|mark as/i;

  // Find Facebook's Send button. Synthetic Enter is untrusted and ignored, so we
  // must click the real button (the paper-plane that replaces the "like" thumb
  // once text is in the box).
  function findSendButton() {
    const root = composerRoot();
    if (!root) return null;
    const btns = Array.from(root.querySelectorAll('[role="button"]')).filter(b => visible(b) && b.querySelector('svg, i, image'));
    // 1) Explicit send label (EN/ES) if present.
    let send = btns.find(b => /^(send|enviar|press enter to send|send message|enviar mensaje)$/i.test((b.getAttribute('aria-label') || '').trim()));
    if (send) return send;
    // 2) Otherwise the composer icon that is NOT a known non-send action (right-most).
    const rest = btns.filter(b => { const a = b.getAttribute('aria-label') || ''; return a && !NON_SEND.test(a); });
    if (rest.length) { rest.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left); return rest[rest.length - 1]; }
    return null;
  }

  function clickEl(el) {
    ['pointerdown', 'mousedown', 'mouseup', 'click'].forEach(t =>
      el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })));
  }

  // One-time-ish report of the composer buttons, so the exact Send selector can
  // be confirmed from the dashboard if auto-send still misses.
  let _sentDbgAt = 0;
  function reportSendDebug(picked) {
    if (Date.now() - _sentDbgAt < 5000) return; _sentDbgAt = Date.now();
    try {
      const root = composerRoot();
      const btns = (root ? Array.from(root.querySelectorAll('[role="button"]')).filter(visible) : [])
        .map(b => ({ ariaLabel: b.getAttribute('aria-label') || '', text: (b.textContent || '').trim().slice(0, 20), svg: !!b.querySelector('svg, i, image') }));
      fetch(`${BACKEND}/api/debug`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'mp-send-debug', url: location.href, pickedAria: picked ? (picked.getAttribute('aria-label') || '(icon, no label)') : null, composerButtons: btns }),
      }).catch(() => {});
    } catch (_) {}
  }

  function pressSend(attempt) {
    const box = composeBox();
    if (box) box.focus();
    const btn = findSendButton();
    if (btn) clickEl(btn);
    else {
      // Last resort: Enter (works in some locales even if untrusted).
      const tgt = (box && document.activeElement && box.contains(document.activeElement)) ? document.activeElement : box;
      if (tgt) ['keydown', 'keypress', 'keyup'].forEach(t =>
        tgt.dispatchEvent(new KeyboardEvent(t, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true })));
    }
    reportSendDebug(btn);
  }

  // Heuristic confirmation: after a successful send FB clears the compose box,
  // so an empty box (and our text now appearing in the thread) means it went.
  function sendLooksConfirmed(text) {
    const box = composeBox();
    const boxEmpty = !box || !(box.textContent || '').trim();
    // Our text now visible as a sent message => it went (avoids re-sending = duplicates).
    const appeared = scanMessages().some(m => norm(m.text) === norm(text) || norm(m.text).includes(norm(text).slice(0, 40)));
    return boxEmpty || appeared;
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

  // Steady heartbeat re-scan so a new buyer message is picked up fast even if the
  // MutationObserver misses FB's virtualized DOM updates.
  setInterval(() => { if (active) schedule(); }, 2000);

  if (onChatPage()) activate();
})();
