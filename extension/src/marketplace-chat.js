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

  // Call the backend THROUGH the background service worker, which can always
  // reach localhost — some Chrome profiles' page context can't fetch localhost
  // directly (CSP/permission), which broke the relay with a false "backend
  // offline". Returns { ok, status, data, error }.
  function bgFetch(path, { method = 'GET', body = null, timeoutMs = 35000 } = {}) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'BG_FETCH', path, method, body, timeoutMs }, (resp) => {
          if (chrome.runtime.lastError) { resolve({ ok: false, status: 0, error: chrome.runtime.lastError.message }); return; }
          resolve(resp || { ok: false, status: 0, error: 'no response' });
        });
      } catch (e) { resolve({ ok: false, status: 0, error: e.message }); }
    });
  }

  const CONFIG = {
    // FULLY AUTOMATED: the bot types AND sends the reply with no human action.
    // Set chrome.storage key `mpAutoSend` to false if you ever want to switch to
    // review-before-send (the reply is staged in the box but not sent).
    autoSend: true,
    debounceMs: 350,
    // Send recovery: how many times to retry a send that didn't go through.
    maxSendRetries: 3,
    retryBackoffMs: 1200,
    sendVerifyMs: 700,       // wait this long, then confirm the compose box cleared
    settleMs: 1500,          // let a freshly-opened thread render before acting
    minReplyGapMs: 3000,     // min gap between sends (anti-spam + human cadence)
    fetchTimeoutMs: 35000,   // hard timeout so a stalled request can't hang the monitor
    watchdogMs: 2500,        // master health/scan loop interval
    staleScanMs: 15000,      // no scan in this long → show "Reconnecting" + self-heal
    stuckMs: 20000,          // pending on ONE chat this long w/o replying → skip it, scan inbox
    // Facebook's realtime push can silently drop in a long-running tab, so the
    // inbox stops receiving new messages until a reload. Reloading is disruptive
    // (FB restores the last-open chat), so we only do it as a RARE last resort:
    // when the tab has been idle AND no new message has been seen for a long time
    // (realtime likely died). Normal operation relies on realtime + the observer.
    reloadIdleStaleMs: 600000,  // only reload after 10 min idle + no new message
  };

  const SEL = (window.FBM_SELECTORS && window.FBM_SELECTORS.chat) || {};
  const seen = new Set();           // message keys already forwarded
  const botSent = new Set();        // normalized texts WE sent — never treat as inbound
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  let booted = Date.now();
  let timer = null;
  let sentCount = 0;
  let currentAccountId = '';          // which Facebook account THIS Chrome profile is
  // Health / monitoring state — the watchdog uses these to detect a stalled listener.
  let lastScanAt = 0, lastReplyAt = 0, lastActionAt = 0, lastDetectAt = 0, tickStartedAt = 0;
  let lastReloadAt = Date.now();      // page load counts as the last inbox re-sync

  chrome.storage?.local?.get?.(['mpAutoSend', 'fbmAccountId'], v => {
    if (typeof v?.mpAutoSend === 'boolean') CONFIG.autoSend = v.mpAutoSend;
    if (v?.fbmAccountId) currentAccountId = String(v.fbmAccountId);
  });
  // Keep the account in sync if it's changed in the popup while the page is open.
  chrome.storage?.onChanged?.addListener?.((changes, area) => {
    if (area === 'local' && changes.fbmAccountId) currentAccountId = String(changes.fbmAccountId.newValue || '');
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

  // The OPEN conversation's message-thread region (role="log", "Messages in
  // conversation titled …"). Scoping to this excludes the inbox-list previews,
  // which otherwise leak other conversations' messages into scanMessages() and
  // make the bot think the open chat is already answered. Picks the largest
  // visible log when several exist.
  function convLog() {
    const logs = [...document.querySelectorAll('[role="log"]')].filter(visible);
    if (logs.length) return logs.sort((a, b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height)[0];
    return document.querySelector('[aria-label^="Messages in conversation" i]') || null;
  }

  // The open conversation: title ("Buyer · Listing") + buyer display name. Prefer
  // the message-log's own aria-label (always matches the messages shown); fall
  // back to the compose box, which can be a stale/other conversation's box.
  function conversationInfo() {
    let title = '';
    const log = convLog();
    if (log) {
      const m = (log.getAttribute('aria-label') || '').match(/conversation(?:\s+titled|\s+with)?\s+(.+?)\s*$/i);
      if (m) title = m[1].trim();
    }
    if (!title) {
      const box = composeBox();
      const m = (box ? (box.getAttribute('aria-label') || '') : '').match(/^\s*(?:Write to|Message)\s+(.+?)\s*$/i);
      title = m ? m[1].trim() : '';
    }
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

  // All parsed messages in the open thread, in DOM order. Scoped to the open
  // conversation's message log so we DON'T pick up the inbox-list previews (each
  // list row carries an aria-label with another conversation's last message —
  // scanning the whole document mixed those in and broke buyer detection).
  function scanMessages() {
    const out = [];
    const seenLabels = new Set();
    const scope = convLog() || document;
    scope.querySelectorAll('[aria-label]').forEach(el => {
      const a = el.getAttribute('aria-label') || '';
      const isMedia = /\b(photo|image|picture|attachment|file|sticker|gif|video|voice|clip|audio)\b/i.test(a);
      if (!/\bmessage\b/i.test(a) && !isMedia) return;   // text messages OR media only
      if (seenLabels.has(a)) return; seenLabels.add(a);
      const bot = !!(el.dataset && el.dataset.fbmBot === '1');
      const m = a.match(/\bby\s+(.+?):\s*([\s\S]+?)\s*$/i);   // "…by <Sender>: <text>"
      if (m && m[2].trim()) {
        out.push({ el, sender: m[1].trim(), text: m[2].trim(), raw: a, bot });
        return;
      }
      // Media message (photo/attachment/sticker/gif/video): no text after the
      // colon. Its label may lack the word "message", so pull the sender from
      // "by X", "X sent…", or "from X". Treat as a "[photo]" inbound so the bot
      // still replies ("thanks for the picture — we can work with that").
      if (isMedia) {
        const sender = ((a.match(/\bby\s+(.+?)\s*:?\s*$/i) || [])[1]
                     || (a.match(/^\s*(.+?)\s+sent\b/i) || [])[1]
                     || (a.match(/\bfrom\s+(.+?)\s*[:.]?\s*$/i) || [])[1] || '').trim();
        out.push({ el, sender, text: '[Customer sent a photo]', raw: a, media: true, bot });
      }
    });
    return out;
  }

  // Latest message ONLY IF it's the buyer's (so the bot answers, and never
  // replies to itself or to a thread where we had the last word).
  function latestInbound() {
    const msgs = scanMessages();
    if (!msgs.length) return null;
    const last = msgs[msgs.length - 1];          // the ACTUAL last message in the thread
    // If WE had the last word (our reply / a text we sent), the thread is
    // answered — nothing pending. (The old code filtered our reply out first, so
    // an already-answered message looked pending forever → stuck on that chat.)
    if (last.bot || botSent.has(norm(last.text))) return null;
    // A message is the customer's unless WE sent it. Our messages are labelled
    // "by You" (English) / "by Tú" (Spanish). Don't require the sender to match
    // the compose-box name — that box can belong to another conversation.
    const s = (last.sender || '').trim();
    const isOurs = /^(you|t[úu])\b/i.test(s);
    return (!isOurs && last.text) ? { row: last.el, text: last.text, sender: last.sender } : null;
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
      let inbox = null;
      try { const rs = conversationRows(); inbox = { rows: rs.length, unread: rs.filter(rowIsUnread).length }; } catch (_) {}
      bgFetch('/api/debug', { method: 'POST', body: {
        kind: 'mp-bridge-diag', url: location.href, conversation: info, inbox,
        messages: msgs.slice(-8).map(m => ({ sender: m.sender, text: m.text.slice(0, 80), bot: m.bot, raw: m.raw })),
        ...(extra || {}),
      } });
    } catch (_) {}
  }

  // ── Inbox-level thread state. A thread is NEVER permanently marked "done":
  //    we only remember when we last OPENED it (a short re-open cooldown), so
  //    follow-up messages always re-enter monitoring. ──────────────────────────
  const threadState = new Map();         // rowKey -> last time we opened that row
  const answered = new Map();            // rowKey -> when we opened it and found NOTHING to reply
  let lastOpenedKey = '', lastOpenAt = 0; // gate: open ONE chat at a time, let it load + get answered
  const OPEN_GAP_MS = 5000;              // min ms between opening chats (so each can be replied to)
  const ANSWERED_COOLDOWN_MS = 90000;    // don't re-open a checked/answered chat for 90s
  const keyOf = t => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 48);
  function rowKey(row) {
    const a = (row.tagName === 'A' && row.getAttribute('href')) ? row : row.querySelector('a[href*="/t/"]');
    const m = a && (a.getAttribute('href') || '').match(/\/t\/(\d+)/);
    if (m) return 't' + m[1];            // most stable when available
    return keyOf(row.getAttribute('aria-label') || row.textContent);
  }
  const blog = (...a) => { try { console.info('[FBM bridge]', ...a); } catch (_) {} };

  // ── Reply to the currently OPEN conversation. Returns true if it just replied,
  //    false if there's nothing to do here (so the caller can move to the next).
  async function handleOpenConversation() {
    // Marketplace-only lock: only act inside a real open Marketplace conversation
    // (the compose box reads "Write to <Buyer · Listing>"). Ignores everything else.
    if (!conversationInfo().title) return false;

    const inbound = latestInbound();
    if (!inbound) return false;                // buyer has no new message here → idle

    const tid = threadId();
    const key = `${tid}::${inbound.text}`;
    if (seen.has(key)) return false;           // already handled this message
    // Let a freshly-opened thread settle before acting (avoids a half-loaded DOM).
    if (Date.now() - booted < CONFIG.settleMs) return false;
    seen.add(key);
    lastDetectAt = Date.now();                 // a real new buyer message was detected

    // Conversation memory: send the recent thread (read from the DOM) so the bot
    // has context — Marketplace chats aren't stored in the bot's database.
    // Our messages are "by You"/"Tú" (or ones we just sent); everything else in
    // the (log-scoped) thread is the customer.
    const roleOf = m => (m.bot || botSent.has(norm(m.text)) || /^(you|t[úu])\b/i.test((m.sender || '').trim())) ? 'You' : 'Customer';
    const history = scanMessages().slice(-13, -1).map(m => ({ role: roleOf(m), text: m.text }));

    // Namespace the thread id by account so threads from different Facebook
    // accounts never collide and each account's memory stays separate.
    const nsTid = currentAccountId ? ('a' + currentAccountId + '_' + tid) : tid;

    const payload = {
      source: 'marketplace',
      account_id: currentAccountId || null,    // which FB account received this message
      sender_id: nsTid,                        // stable per-thread id (account-namespaced)
      thread_id: nsTid,
      sender_name: contactName(),
      text: inbound.text,
      timestamp: new Date().toISOString(),
      history,                                  // recent thread for context/memory
    };

    let reply;
    setStatus('busy', 'Asking chatbot…');
    // Routed through the background worker (see bgFetch) so it works even where
    // the page can't reach localhost. The worker enforces the timeout.
    const res = await bgFetch('/api/marketplace/incoming', { method: 'POST', body: payload, timeoutMs: CONFIG.fetchTimeoutMs });
    if (!res.ok) {
      console.warn('[FBM bridge] backend request failed:', res.status, res.error || res.data);
      setStatus('err',
        res.status ? `Backend ${res.status} — see dashboard Logs`
        : res.error === 'timeout' ? 'Backend slow/timeout — will retry'
        : 'Backend offline — run start.bat');
      seen.delete(key);                         // allow a retry on the next tick
      return false;
    }
    reply = res.data && (res.data.reply || res.data.text || res.data.message);

    if (!reply) { setStatus('err', 'Empty reply from chatbot'); return false; }

    const ok = await deliverReply(String(reply));
    if (ok) {
      sentCount++;
      blog('replied', keyOf(conversationInfo().title || tid), '· total', sentCount);
      setStatus('ok', `Sent ✓ ${sentCount} · ${new Date().toLocaleTimeString()}`);
      return true;
    }
    setStatus('err', 'Send failed — check selectors.chat');
    seen.delete(key);                            // let it try again next tick
    return false;
  }

  // ── Inbox watcher: enumerate conversation rows in the left list (never the
  //    open thread's DOM). Robust to FB layout variance.
  function listPaneRight() {
    const box = composeBox();
    return box ? box.getBoundingClientRect().left : window.innerWidth;   // composer marks where the list ends
  }
  // A listing/product link — clicking this opens the WRONG page. Never our target.
  const LISTING_HREF = /\/marketplace\/item|\/item\/|\/commerce\/|\/groups\//i;
  // Marketplace navigation / category / menu links — NOT conversations.
  const NAV_HREF = /^\/$|^\/marketplace\/?$|\/marketplace\/(jobs|notifications|inbox|status|you|create|category|learn|saved|buying|selling)\b|\/search\b|category_id=/i;
  const isListingLink = el => !!(el && el.tagName === 'A' && LISTING_HREF.test(el.getAttribute('href') || ''));
  const isNavLike = el => {
    if (!el) return false;
    if (el.getAttribute && el.getAttribute('role') === 'menuitem') return true;
    const a = el.tagName === 'A' ? el : (el.closest && el.closest('a[href]'));
    return !!(a && NAV_HREF.test(a.getAttribute('href') || ''));
  };

  // A conversation row = a clickable list entry with a person name + message
  // preview, in the CHAT LIST — not the nav sidebar, a menu item, or a listing.
  function looksLikeConversation(el) {
    if (!visible(el) || isListingLink(el) || isNavLike(el)) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 150 || r.height < 44 || r.height > 130) return false;
    if (!el.querySelector('img, image, svg')) return false;          // avatar present
    const txt = (el.textContent || '').trim();
    return txt.length > 3 && txt.length < 200;                        // name + short preview
  }

  function conversationRows() {
    if (SEL.conversationRow) return $$(SEL.conversationRow).filter(visible);
    let rows = $$('[role="row"],[role="gridcell"],[role="listitem"],div[role="button"],a[role="link"]').filter(looksLikeConversation);
    // Keep the outermost element per row (drop nested duplicates).
    rows = rows.filter((el, i) => !rows.some((o, j) => j !== i && o.contains(el) && o !== el));
    return rows;
  }

  // Open the CONVERSATION for a row — never the listing/product page. Prefer a
  // real /t/ conversation link, then a non-listing role=button/link, else click
  // the row CONTAINER itself (FB's row onClick opens the chat; we never dispatch
  // on the listing thumbnail <a>, which is what was opening the product page).
  function clickConversation(row) {
    const convLink = (row.matches && row.matches('a[href*="/t/"]')) ? row : (row.querySelector && row.querySelector('a[href*="/t/"]'));
    if (convLink) { blog('click convLink', convLink.getAttribute('href')); clickEl(convLink); return; }
    const inner = [...(row.querySelectorAll ? row.querySelectorAll('[role="button"],[role="link"]') : [])]
      .find(c => !isListingLink(c) && !(c.closest && isListingLink(c.closest('a[href]'))));
    if (inner) { blog('click inner button/link'); clickEl(inner); return; }
    // Click the row itself, but if the row IS/inside a listing link, step out to a
    // non-listing ancestor so we don't navigate to the product page.
    let target = row;
    if (isListingLink(target) || (target.closest && isListingLink(target.closest('a[href]')))) {
      const up = target.closest('[role="row"],[role="gridcell"],[role="listitem"]');
      if (up && !isListingLink(up)) target = up;
    }
    blog('click row container');
    clickEl(target);
  }

  // Is this conversation row unread (has a new customer message)? Several
  // independent signals so one FB style change can't blind us.
  function rowIsUnread(row) {
    if (SEL.unreadHint) { try { if (row.matches(SEL.unreadHint) || row.querySelector(SEL.unreadHint)) return true; } catch (_) {} }
    const al = row.getAttribute('aria-label') || '';
    if (/\bunread\b/i.test(al)) return true;
    if (row.querySelector('[aria-label*="nread" i]')) return true;
    // Blue unread dot: a small round element with a Facebook-blue background.
    let dot = false;
    row.querySelectorAll('div, span, i').forEach(e => {
      if (dot) return;
      const r = e.getBoundingClientRect();
      if (r.width > 2 && r.width <= 16 && Math.abs(r.width - r.height) <= 5) {
        const m = (getComputedStyle(e).backgroundColor || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (m && +m[3] > 170 && +m[3] - +m[1] > 55 && +m[3] - +m[2] > 25) dot = true; // blue-ish
      }
    });
    if (dot) return true;
    // Bold name/preview (FB renders unread rows bold).
    let bold = false;
    row.querySelectorAll('span, div').forEach(s => {
      if (bold) return;
      const t = (s.textContent || '').trim();
      if (t.length > 1 && parseInt(getComputedStyle(s).fontWeight, 10) >= 600) bold = true;
    });
    return bold;
  }

  // A conversation NEEDS a reply if the buyer had the last word. Facebook shows a
  // "You:" / "You sent…" prefix on the row preview when WE sent the last message,
  // so the absence of that (on a real conversation row) means the customer's
  // message is newest → open it. This is far more reliable than bold/blue-dot
  // unread styling (which Facebook renders inconsistently), so multi-chat threads
  // are detected even when FB doesn't visibly mark the row unread.
  function rowNeedsReply(row) {
    const txt = (row.textContent || '').replace(/\s+/g, ' ').trim();
    if (!txt) return false;
    if (/(^|\s|·)(you|t[úu]):\s|\byou sent\b|\byou replied\b|\byou reacted\b|\benviaste\b|\bhas enviado\b|\bt[úu] enviaste\b/i.test(txt)) return false;
    // Must still look like a conversation (name + a message preview).
    return txt.length > 3;
  }

  // Compact description of a candidate row (for calibration diagnostics).
  function rowInfo(r) {
    const hrefs = [...(r.querySelectorAll ? r.querySelectorAll('a[href]') : [])].map(a => a.getAttribute('href') || '');
    if (r.tagName === 'A' && r.getAttribute('href')) hrefs.unshift(r.getAttribute('href'));
    // Unread-signal detail so I can see EXACTLY how FB marks an unread row.
    let fw = 0, dot = false, dotColor = '';
    (r.querySelectorAll ? r.querySelectorAll('span, div') : []).forEach(s => {
      const t = (s.textContent || '').trim(); if (!t) return;
      const w = parseInt(getComputedStyle(s).fontWeight, 10) || 0; if (w > fw) fw = w;
    });
    (r.querySelectorAll ? r.querySelectorAll('div, span, i') : []).forEach(e => {
      if (dot) return; const rr = e.getBoundingClientRect();
      if (rr.width > 2 && rr.width <= 18 && Math.abs(rr.width - rr.height) <= 6) {
        const bg = getComputedStyle(e).backgroundColor || '';
        const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/);
        if (m && (+(m[4] || 1)) > 0.2 && +m[3] > 120) { dot = true; dotColor = bg; }
      }
    });
    return {
      tag: (r.tagName || '').toLowerCase(), role: r.getAttribute('role') || '',
      hrefs: hrefs.slice(0, 3).map(h => h.slice(0, 44)),
      hasConvLink: hrefs.some(h => /\/t\/\d/.test(h)),
      hasListing: hrefs.some(h => LISTING_HREF.test(h)),
      aria: (r.getAttribute('aria-label') || '').slice(0, 48),
      text: (r.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 48),
      unread: rowIsUnread(r), key: rowKey(r),
      fw, dot, dotColor: dotColor.slice(0, 24),      // font-weight + any colored dot
    };
  }
  // Deep scan: candidate conversation rows are clickable blocks with an avatar
  // image + text (name + preview), anywhere, excluding nav/menus/listings — so I
  // can see the real chat list even when it's not where position heuristics guess.
  function rawInboxCandidates() {
    const out = []; const seen = new Set();
    $$('div, li, a').forEach(el => {
      if (out.length >= 24 || !visible(el)) return;
      if (isNavLike(el) || isListingLink(el)) return;
      const r = el.getBoundingClientRect();
      if (r.width < 150 || r.height < 44 || r.height > 130) return;
      if (!el.querySelector('img, image, svg')) return;         // avatar
      const txt = (el.textContent || '').trim();
      if (txt.length < 4 || txt.length > 220) return;
      const sig = Math.round(r.left) + 'x' + Math.round(r.top) + 'x' + Math.round(r.height);
      if (seen.has(sig)) return; seen.add(sig);
      out.push(Object.assign(rowInfo(el), { rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] }));
    });
    return out;
  }

  // Page regions (grid/list/main + labelled containers) so I can locate the chat
  // list vs the nav sidebar vs the open conversation by aria-label + x position.
  function inboxRegions() {
    return $$('[role="grid"],[role="list"],[role="feed"],[role="main"],[role="navigation"],[role="complementary"],[aria-label]')
      .filter(el => { const r = el.getBoundingClientRect(); return visible(el) && r.height > 200; })
      .slice(0, 14)
      .map(el => { const r = el.getBoundingClientRect(); return { role: el.getAttribute('role') || '', aria: (el.getAttribute('aria-label') || '').slice(0, 40), x: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) }; });
  }

  // Build the queue of thread keys that currently need a reply (unread rows).
  function refreshQueue() {
    const rows = conversationRows();
    // Queue anything that looks unread OR whose last message isn't ours — the
    // latter catches new messages in other chats even when FB doesn't bold them.
    const unread = rows.filter(r => rowIsUnread(r) || rowNeedsReply(r));
    for (const row of unread) {
      const k = rowKey(row);
      if (!k) continue;
      const opened = threadState.get(k);
      if (opened && Date.now() - opened < 15000) continue;     // just opened → let FB update the row
      const ans = answered.get(k);
      if (ans && Date.now() - ans < ANSWERED_COOLDOWN_MS) continue;  // already checked, nothing to reply
      if (!messageQueue.includes(k)) { messageQueue.push(k); blog('queued', k, 'queueLen=', messageQueue.length); }
    }
    return {
      rows: rows.length, unread: unread.length, queue: messageQueue.length,
      sample: rows.slice(0, 24).map(rowInfo),
      candidates: rawInboxCandidates(),          // raw DOM for calibration
      regions: inboxRegions(),
    };
  }

  // Dispatcher: open the next queued conversation (that isn't already open) so the
  // reply path can answer it on the next tick. Row refs are re-resolved by key.
  const messageQueue = [];
  function dispatchNext() {
    if (!messageQueue.length) return false;
    // Open ONE chat at a time: wait for the last-opened chat to load and be
    // answered before opening another, so we don't race through chats unanswered.
    if (Date.now() - lastOpenAt < OPEN_GAP_MS) return false;
    for (let i = 0; i < messageQueue.length; i++) {
      const k = messageQueue[i];
      let row = null;
      for (const r of conversationRows()) { if (rowKey(r) === k) { row = r; break; } }
      if (!row || (!rowIsUnread(row) && !rowNeedsReply(row))) { messageQueue.splice(i, 1); i--; continue; }  // gone/answered → drop
      threadState.set(k, Date.now());
      lastOpenedKey = k; lastOpenAt = Date.now();
      messageQueue.splice(i, 1);                 // remove; will re-queue if still unread later
      blog('→ open', k, 'queueLen=', messageQueue.length);
      setStatus('busy', 'Opening next chat…');
      clickConversation(row);                    // click the real clickable target
      return true;
    }
    return false;
  }

  // ── Reset after a reply: detach from the conversation and return to clean
  //    inbox monitoring. SPA-safe — never forces a full page reload. ───────────
  function returnToInbox() {
    // After a reply, the tick loop opens the next waiting customer on its own,
    // PACED (one chat per OPEN_GAP_MS) so each gets answered before the next opens.
    // Optionally deselect/close the current chat if FB offers a control.
    const close = document.querySelector('div[aria-label="Close chat"][role="button"], div[aria-label="Close"][role="button"], div[aria-label="Back"][role="button"]');
    if (close && visible(close)) { blog('reset → closed chat view'); clickEl(close); return; }
    blog('reset → monitoring inbox');
  }

  // Close / deselect the currently open conversation (best effort — two-pane
  // inboxes have no close button, in which case opening the next chat deselects).
  function closeChat() {
    const close = document.querySelector(
      '[aria-label="Close chat"][role="button"], [aria-label="Close"][role="button"], ' +
      '[aria-label="Back"][role="button"], [aria-label="Cerrar chat"][role="button"], ' +
      '[aria-label="Cerrar"][role="button"]');
    if (close && visible(close)) { clickEl(close); return true; }
    return false;
  }

  // ── Sequential inbox processor. Take the most recent chats and, for EACH ONE,
  //    OPEN → REPLY (only if the customer had the last word) → CLOSE — fully,
  //    before moving to the next. It never opens the next until the current is
  //    done, so it can't race through chats leaving them unanswered.
  const MAX_CHATS_PER_CYCLE = 5;     // the last N conversations
  const CYCLE_GAP_MS = 8000;         // rest between full sweeps
  const RECENT_OPEN_MS = 25000;      // don't reopen a just-handled chat while its row preview lags
  let ticking = false;
  let lastCycleAt = 0;
  async function check() {
    if (ticking) return;
    if (Date.now() - lastCycleAt < CYCLE_GAP_MS) return;   // rest between sweeps
    ticking = true; tickStartedAt = Date.now();
    try {
      lastScanAt = Date.now();
      if (!onChatPage()) return;
      const all = conversationRows();
      // Only open chats that ACTUALLY need a reply: the row preview shows the
      // customer had the last word (no "You:" prefix) or it's marked unread. Once
      // we've replied, FB shows "You:" on that row → it's skipped → no more
      // constant re-opening of already-answered chats. Also skip a chat we opened
      // in the last RECENT_OPEN_MS so a lagging row preview (FB is slow to switch
      // it to "You:") can't make us reopen a chat we just handled.
      const rows = all.filter(r => {
        if (!(rowIsUnread(r) || rowNeedsReply(r))) return false;
        const t = threadState.get(rowKey(r));
        return !(t && Date.now() - t < RECENT_OPEN_MS);
      }).slice(0, MAX_CHATS_PER_CYCLE);
      reportDiag({ inbox: { rows: all.length, needsReply: rows.length }, openThread: keyOf(conversationInfo().title) });
      if (!rows.length) { setStatus('ok', 'Monitoring inbox'); return; }   // nothing waiting → stay idle
      for (const row of rows) {
        if (!onChatPage()) break;
        setStatus('busy', 'Checking chat…');
        threadState.set(rowKey(row), Date.now());        // remember we handled this chat
        clickConversation(row);                          // open this conversation
        await sleep(CONFIG.settleMs + 1200);             // WAIT for it to fully load before acting
        try {
          const replied = await handleOpenConversation(); // replies iff the customer had the last word
          if (replied) { lastReplyAt = Date.now(); await sleep(1200); }
        } catch (e) { console.warn('[FBM bridge] reply', e && e.message); }
        closeChat();                                     // always close / deselect
        await sleep(700);
      }
      pruneMemory();
    } catch (e) { console.warn('[FBM bridge]', e); }
    finally { ticking = false; lastCycleAt = Date.now(); tickStartedAt = 0; }
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
    setStatus('busy', 'Sending…');

    // Type the reply ONCE.
    if (!stage(text)) { await sleep(CONFIG.retryBackoffMs); if (!stage(text)) return false; }
    await sleep(450);                   // let Facebook swap the "like" thumb for the Send button
    const clickedReal = pressSend();    // true = clicked a real Send button
    await sleep(CONFIG.sendVerifyMs);
    if (sendLooksConfirmed(text)) return true;

    if (clickedReal) {
      // A real Send button was clicked. Do NOT re-type — re-typing is what sent the
      // message twice. Click once more (a no-op if it already sent) and trust it.
      pressSend();
      await sleep(CONFIG.sendVerifyMs);
      return true;
    }

    // No Send button found (Enter fallback) — nothing was sent yet, so re-typing is
    // safe. Retry a couple of times.
    for (let attempt = 2; attempt <= CONFIG.maxSendRetries; attempt++) {
      setStatus('busy', `Sending… (retry ${attempt - 1})`);
      if (!stage(text)) { await sleep(CONFIG.retryBackoffMs); continue; }
      await sleep(300);
      if (pressSend()) { await sleep(CONFIG.sendVerifyMs); if (sendLooksConfirmed(text)) return true; return true; }
      await sleep(CONFIG.sendVerifyMs);
      if (sendLooksConfirmed(text)) return true;
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
    // Select everything currently in the box, then insert. execCommand('insertText')
    // REPLACES the selection (so the box ends up with exactly one copy) AND fires the
    // input events Facebook's Lexical editor needs.
    //
    // IMPORTANT: do NOT dispatch a synthetic InputEvent afterwards. Lexical processes
    // that second 'input' (data: text, inputType: insertText) and inserts the reply a
    // SECOND time — the cause of "text text" appearing inside one message bubble.
    try { document.execCommand('selectAll', false, null); } catch (_) {}
    document.execCommand('insertText', false, text);
    // NOTE: do NOT dispatch a synthetic InputEvent here. execCommand('insertText')
    // already fires the input events Facebook's Lexical editor needs; an extra
    // InputEvent makes Lexical insert the text AGAIN (the "same message repeated N
    // times in one bubble" bug). selectAll above means each stage() REPLACES the
    // box contents, so retries never accumulate copies either.
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
    const box = composeBox();
    // Search a scope a few levels up from the box (the whole composer row/panel),
    // which is more reliable than an emoji-anchored root that can miss the button.
    let scope = composerRoot();
    if (box) { let s = box; for (let i = 0; i < 5 && s.parentElement; i++) s = s.parentElement; if (!scope || (scope.contains && !scope.contains(box))) scope = s; }
    if (!scope) return null;
    const boxRect = box ? box.getBoundingClientRect() : null;
    const btns = Array.from(scope.querySelectorAll('[role="button"], button')).filter(b =>
      visible(b) && b !== box && !(box && b.contains(box)) && b.querySelector('svg, i, image'));
    // 1) Explicit send label (EN/ES) if present.
    let send = btns.find(b => /^(send|enviar|press enter to send|send message|enviar mensaje)$/i.test((b.getAttribute('aria-label') || '').trim()));
    if (send) return send;
    // 2) A composer-row icon that is NOT a known non-send action → the paper-plane.
    //    Prefer buttons on the same row as the box (the Send button sits beside it).
    let rest = btns.filter(b => { const a = b.getAttribute('aria-label') || ''; return !a || !NON_SEND.test(a); });
    if (boxRect) {
      const sameRow = rest.filter(b => { const r = b.getBoundingClientRect(); return Math.abs(r.top - boxRect.top) < 90 && r.left >= boxRect.left - 4; });
      if (sameRow.length) rest = sameRow;
    }
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
    if (Date.now() - _sentDbgAt < 3000) return; _sentDbgAt = Date.now();
    try {
      const box = composeBox();
      const boxRect = box ? box.getBoundingClientRect() : null;
      // Scope = a few levels up from the box (the whole composer), so we see the
      // Send button even if it lives outside the emoji-anchored root.
      let scope = box; for (let i = 0; i < 5 && scope && scope.parentElement; i++) scope = scope.parentElement;
      const btns = (scope ? Array.from(scope.querySelectorAll('[role="button"], button')).filter(visible) : [])
        .slice(0, 24)
        .map(b => { const r = b.getBoundingClientRect(); return {
          ariaLabel: b.getAttribute('aria-label') || '', title: b.getAttribute('title') || '',
          text: (b.textContent || '').trim().slice(0, 16), svg: !!b.querySelector('svg, i, image'),
          rightOfBox: boxRect ? Math.round(r.left - boxRect.right) : null, x: Math.round(r.left),
        }; });
      bgFetch('/api/debug', { method: 'POST', body: {
        kind: 'mp-send-debug', url: location.href,
        boxFound: !!box, boxAria: box ? (box.getAttribute('aria-label') || '') : null,
        boxText: box ? (box.textContent || '').trim().slice(0, 50) : null,   // did typing land?
        pickedAria: picked ? (picked.getAttribute('aria-label') || '(icon, no label)') : null,
        composerButtons: btns,
      } });
    } catch (_) {}
  }

  // Returns true if it clicked a real Send button (so the caller knows not to
  // re-type, which would duplicate the message).
  function pressSend() {
    const box = composeBox();
    if (box) box.focus();
    const btn = findSendButton();
    reportSendDebug(btn);
    if (btn) { clickEl(btn); return true; }
    // No Send button (e.g. empty box, or locale variance): fall back to Enter.
    const tgt = (box && document.activeElement && box.contains(document.activeElement)) ? document.activeElement : box;
    if (tgt) ['keydown', 'keypress', 'keyup'].forEach(t =>
      tgt.dispatchEvent(new KeyboardEvent(t, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true })));
    return false;
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

  // ── Monitoring lifecycle + self-healing watchdog ────────────────────────────
  let active = false;
  let observer = null;
  let lastPath = location.pathname;

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => check(), CONFIG.debounceMs);
  }

  function attachObserver() {
    try { observer && observer.disconnect(); } catch (_) {}
    // Observe document.body (which is NEVER replaced) with subtree:true, so the
    // listener can't go stale when Facebook swaps out the conversation panel —
    // the #1 cause of "stops detecting until refresh".
    observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    blog('observer attached (document.body)');
  }

  function activate() {
    if (active) return;
    active = true;
    booted = Date.now();
    seen.clear();
    mountBadge();
    attachObserver();
    schedule();
    console.info('[FBM bridge] active on', location.pathname);
  }

  function deactivate() {
    if (!active) return;
    active = false;
    clearTimeout(timer);
    try { observer && observer.disconnect(); } catch (_) {}
    observer = null;
    unmountBadge();
    blog('observer detached / deactivated');
  }

  // Cap the de-dupe sets so they can't grow unbounded over many hours/conversations.
  function pruneMemory() {
    const cap = (set, n) => { if (set.size > n) { const keep = [...set].slice(-Math.floor(n / 2)); set.clear(); keep.forEach(x => set.add(x)); } };
    cap(seen, 600); cap(botSent, 400);
    if (threadState.size > 300) { const e = [...threadState.entries()].sort((a, b) => a[1] - b[1]).slice(-150); threadState.clear(); e.forEach(([k, v]) => threadState.set(k, v)); }
    // Drop expired answered-cooldowns so a chat with a genuine new message can reopen.
    for (const [k, t] of answered) { if (Date.now() - t > ANSWERED_COOLDOWN_MS) answered.delete(k); }
  }

  function timeAgo(t) {
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 60) return s + 's ago';
    const m = Math.round(s / 60); if (m < 60) return m + 'm ago';
    return Math.round(m / 60) + 'h ago';
  }

  // The badge reflects the REAL monitoring state, not just the last action — so a
  // stalled listener shows "Reconnecting…", never a false-healthy green.
  function updateBadgeHealth() {
    if (!onChatPage()) { setStatus('idle', 'Open your Marketplace inbox'); return; }
    if (ticking) {                                  // a tick is working → let it own the badge,
      if (tickStartedAt && Date.now() - tickStartedAt > 8000) setStatus('busy', 'Working… (slow)');
      return;                                       // unless it has clearly stalled
    }
    if (Date.now() - lastScanAt > CONFIG.staleScanMs) { setStatus('err', 'Reconnecting…'); return; }
    const tail = lastReplyAt ? ` · last reply ${timeAgo(lastReplyAt)}` : '';
    setStatus('ok', `Monitoring ✓ · ${sentCount} sent${tail}`);
  }

  // Idle = safe to reload (not mid-tick, nothing pending in the open thread, no
  // unread queued). We only ever auto-refresh when idle, so a reply is never cut off.
  function inboxIsIdle() {
    if (ticking) return false;
    if (messageQueue.length) return false;
    if (conversationInfo().title && latestInbound()) return false;
    return true;
  }

  // Reload is a RARE last resort. Facebook restores the last-open chat on reload,
  // which fights with clean inbox monitoring, so we avoid it during normal use and
  // only reload when the tab has been idle AND no new message has been seen for a
  // long time — i.e. realtime push has most likely died and nothing else will
  // recover it. When realtime is healthy (messages keep arriving), we never reload.
  function maybeAutoRefresh() {
    if (!onChatPage() || !inboxIsIdle()) return;
    const now = Date.now();
    const sinceReload = now - lastReloadAt;
    const sinceInbound = lastDetectAt ? now - lastDetectAt : (now - booted);
    if (sinceReload < CONFIG.reloadIdleStaleMs) return;   // don't reload often
    if (sinceInbound < CONFIG.reloadIdleStaleMs) return;  // recent activity → realtime OK, skip
    lastReloadAt = now;                                   // (reset on the fresh page load anyway)
    blog('safety reload (idle+stale)', 'noNewMsgFor=' + Math.round(sinceInbound / 1000) + 's');
    setStatus('busy', 'Re-syncing inbox…');
    location.reload();
  }

  // Master watchdog: ALWAYS runs (independent of `active`), so monitoring recovers
  // on its own — no page refresh needed. Handles SPA navigation, re-activates if
  // needed, re-attaches a dead observer, frees a stuck tick, drives a guaranteed
  // scan every cycle (polling floor), and keeps the badge honest.
  setInterval(() => {
    try {
      if (location.pathname !== lastPath) { lastPath = location.pathname; deactivate(); }
      if (onChatPage() && !active) activate();
      if (!onChatPage()) { if (active) deactivate(); updateBadgeHealth(); return; }

      // Self-heal: a tick stuck (e.g. a request that never settled) — free it.
      if (ticking && tickStartedAt && Date.now() - tickStartedAt > 60000) { ticking = false; tickStartedAt = 0; }
      // Self-heal: observer missing/disconnected — re-attach it.
      if (active && !observer) attachObserver();
      // Self-heal: scans stalled for too long → force a full re-init (no refresh).
      if (active && lastScanAt && Date.now() - lastScanAt > CONFIG.staleScanMs * 2) { deactivate(); activate(); }
      // Guaranteed scan every cycle — detection never depends on FB firing mutations.
      if (active) schedule();
      // Periodically reload the inbox to re-sync if Facebook's realtime dropped.
      maybeAutoRefresh();

      updateBadgeHealth();
    } catch (e) { console.warn('[FBM bridge] watchdog', e); }
  }, CONFIG.watchdogMs);

  if (onChatPage()) activate();
})();
