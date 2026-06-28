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
  // Only run on the Marketplace inbox / a conversation thread.
  if (!/\/marketplace\/(inbox|t\/)/.test(location.pathname)) return;

  const BACKEND = 'http://localhost:3333';

  const CONFIG = {
    // SAFETY: default is "suggest" mode — the bot's reply is typed into the
    // compose box but NOT sent, so you can review before hitting Enter. Flip to
    // true (or toggle via chrome.storage key `mpAutoSend`) once you trust it.
    autoSend: false,
    // Ignore messages older than this on first load so we don't reply to history.
    freshnessMs: 2 * 60 * 1000,
    debounceMs: 800,
  };

  const SEL = (window.FBM_SELECTORS && window.FBM_SELECTORS.chat) || {};
  const seen = new Set();           // message keys already forwarded
  let booted = Date.now();
  let timer = null;

  chrome.storage?.local?.get?.(['mpAutoSend'], v => {
    if (typeof v?.mpAutoSend === 'boolean') CONFIG.autoSend = v.mpAutoSend;
  });

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
      const res = await fetch(`${BACKEND}/api/marketplace/incoming`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) { console.warn('[FBM bridge] backend error', res.status, data); return; }
      reply = data && (data.reply || data.text || data.message);
    } catch (err) {
      console.warn('[FBM bridge] cannot reach backend — keep start.bat running.', err.message);
      return;
    }

    if (reply) await deliverReply(String(reply));
  }

  // Type the reply into the compose box; send only if autoSend is on.
  async function deliverReply(text) {
    const box = $(SEL.composeBox);
    if (!box) { console.warn('[FBM bridge] compose box not found — update selectors.chat.composeBox'); return; }

    box.focus();
    // Facebook uses a contenteditable Lexical/Draft field; insertText fires the
    // input events FB listens for far more reliably than setting textContent.
    document.execCommand('insertText', false, text);
    box.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));

    if (!CONFIG.autoSend) {
      console.info('[FBM bridge] reply staged (suggest mode). Press Enter to send, or enable autoSend.');
      return;
    }

    // Auto-send: prefer the explicit send button, fall back to Enter.
    const btn = $(SEL.sendButton);
    if (btn && visible(btn)) {
      btn.click();
    } else {
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    }
  }

  // ── Observe the thread for new messages ─────────────────────────────────────
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => check().catch(e => console.warn('[FBM bridge]', e)), CONFIG.debounceMs);
  }

  const target = $(SEL.messageList) || document.body;
  new MutationObserver(schedule).observe(target, { childList: true, subtree: true });

  // Re-baseline when navigating between threads (FB is a SPA).
  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname !== lastPath) { lastPath = location.pathname; booted = Date.now(); seen.clear(); schedule(); }
  }, 1000);

  schedule();
  console.info('[FBM bridge] Marketplace → chatbot bridge active (autoSend:', CONFIG.autoSend, ')');
})();
