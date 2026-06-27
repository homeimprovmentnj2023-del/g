// Facebook Marketplace create-listing automation — built for reliability over speed.
//
// Principles:
//  - Never use fixed CSS classes. Find elements by role + visible label/text.
//  - Wait for elements to appear, and retry transient failures with backoff.
//  - Never abort the whole run because one OPTIONAL field failed.
//  - Category has a fallback tree: if the preferred one isn't offered, pick a
//    relevant alternative that the form actually accepts.
//  - Validate image uploads before continuing.
//  - On a hard Facebook block (rejection / account restriction) STOP, record the
//    reason, and report it — never try to work around it.
//  - Log every action and error to the backend for debugging.
window.FBMAutofill = (() => {
  const BACKEND = 'http://localhost:3333';

  // ── Localized labels / button words ─────────────────────────────────────────
  const LABELS = {
    title:       ['Title', 'Listing title', 'What are you selling', 'Título', 'Titulo'],
    price:       ['Price', 'Precio'],
    description: ['Description', 'Descripción', 'Descripcion'],
    category:    ['Category', 'Categoría', 'Categoria'],
    condition:   ['Condition', 'Estado', 'Condición', 'Condicion'],
    location:    ['Location', 'Ubicación', 'Ubicacion'],
  };
  const NEXT_WORDS    = ['next', 'continue', 'siguiente', 'continuar'];
  const PUBLISH_WORDS = ['publish', 'post', 'list', 'publicar'];

  // Fallback categories tried (in order) when the preferred one isn't available.
  // Broad, commonly-present Marketplace categories that accept most items/services.
  const CATEGORY_FALLBACKS = ['Miscellaneous', 'Other', 'Garage Sale', 'Home & Garden', 'Tools'];

  // Strong, specific phrases that indicate a REAL block/rejection — never the
  // generic "weapons, counterfeits … aren't allowed … see our commerce policies"
  // disclaimer that Facebook prints on every create form. Matched only inside
  // actual alert/dialog popups (see detectBlock), not the static page text.
  const BLOCK_PHRASES = [
    "goes against our commerce policies", "can't be published", 'cannot be published',
    "can't publish your listing", "couldn't publish your", "we couldn't create your listing",
    'this listing was rejected', 'listing has been rejected', 'we removed your',
    'your account has been restricted', 'account is restricted', "you're temporarily blocked",
    'temporarily blocked from', 'try again later because of',
    'no se puede publicar', 'tu cuenta ha sido restringida', 'infringe nuestras políticas',
  ];
  // Phrases that mean a transient glitch — safe to retry.
  const TRANSIENT_PHRASES = ['something went wrong', 'try again', 'algo salió mal', 'inténtalo de nuevo'];

  // ── Logging ─────────────────────────────────────────────────────────────────
  let currentJobId = null;
  const logBuffer = [];
  let flushTimer = null;

  function log(step, status, detail = '') {
    const entry = { job_id: currentJobId, step, status, detail: String(detail).slice(0, 500), at: Math.floor(Date.now() / 1000) };
    // Console for live debugging. Use warn/log only (never console.error) so our
    // normal progress logs don't show up in Chrome's extension "Errors" page.
    const tag = (status === 'error' || status === 'warn' || status === 'block') ? 'warn' : 'log';
    console[tag](`[FBM][${step}] ${status}${detail ? ' — ' + detail : ''}`);
    logBuffer.push(entry);
    if (!flushTimer) flushTimer = setTimeout(flushLogs, 400);
  }
  async function flushLogs() {
    flushTimer = null;
    if (!logBuffer.length) return;
    const batch = logBuffer.splice(0, logBuffer.length);
    try {
      await fetch(`${BACKEND}/api/logs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(batch),
      });
    } catch (_) { /* backend offline — keep going, logs are best-effort */ }
  }

  // ── Timing / retry primitives ───────────────────────────────────────────────
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // Poll selectorFn until it returns truthy or times out.
  function waitFor(selectorFn, { timeout = 12000, interval = 200 } = {}) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        let el = null;
        try { el = selectorFn(); } catch (_) {}
        if (el) return resolve(el);
        if (Date.now() - start > timeout) return reject(new Error('Timeout'));
        setTimeout(tick, interval);
      };
      tick();
    });
  }

  // Wait for an element then act on it, retrying transient failures with backoff.
  async function waitAndAct(selectorFn, actionFn, { timeout = 10000, retries = 3, desc = 'element', optional = false } = {}) {
    let lastErr;
    for (let i = 0; i < retries; i++) {
      try {
        const el = await waitFor(selectorFn, { timeout });
        await actionFn(el);
        log(desc, 'success');
        return el;
      } catch (err) {
        lastErr = err;
        log(desc, 'retry', `attempt ${i + 1}/${retries}: ${err.message}`);
        await maybeRecoverTransient();
        await sleep(800 * (i + 1));
      }
    }
    if (optional) { log(desc, 'warn', `skipped after ${retries} attempts: ${lastErr && lastErr.message}`); return null; }
    throw new Error(`${desc} failed after ${retries} attempts: ${lastErr && lastErr.message}`);
  }

  // If a transient "something went wrong" toast is present, wait it out.
  async function maybeRecoverTransient() {
    const txt = (document.body.innerText || '').toLowerCase();
    if (TRANSIENT_PHRASES.some(p => txt.includes(p))) {
      log('transient', 'retry', 'Facebook showed a temporary error — waiting before retry');
      await sleep(4000);
    }
  }

  // ── Element finders (role + text, never fixed classes) ──────────────────────
  function findInput(labels) {
    for (const label of labels) {
      let el = document.querySelector(`input[aria-label="${label}" i], textarea[aria-label="${label}" i]`);
      if (el) return el;
      el = document.querySelector(`input[aria-label*="${label}" i], textarea[aria-label*="${label}" i]`);
      if (el) return el;
      el = document.querySelector(`input[placeholder*="${label}" i], textarea[placeholder*="${label}" i]`);
      if (el) return el;
    }
    const lowers = labels.map(l => l.toLowerCase());
    for (const lab of document.querySelectorAll('label')) {
      const txt = (lab.textContent || '').trim().toLowerCase();
      if (lowers.some(l => txt === l || txt.startsWith(l))) {
        const input = lab.querySelector('input, textarea');
        if (input) return input;
      }
    }
    return null;
  }

  function findClickableByText(words, roles = ['button']) {
    const lowers = words.map(w => w.toLowerCase());
    for (const role of roles) {
      for (const el of document.querySelectorAll(`[role="${role}"]`)) {
        const txt = (el.textContent || '').trim().toLowerCase();
        if (lowers.includes(txt) && el.getAttribute('aria-disabled') !== 'true') return el;
      }
    }
    for (const el of document.querySelectorAll('div[tabindex], span[tabindex], a[role]')) {
      const txt = (el.textContent || '').trim().toLowerCase();
      if (lowers.includes(txt)) return el;
    }
    return null;
  }

  // ── React-aware value setter ─────────────────────────────────────────────────
  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function fillText(labels, value, { required = false, desc } = {}) {
    if (value === undefined || value === null || value === '') return;
    return waitAndAct(
      () => findInput(labels),
      el => { el.focus(); setNativeValue(el, ''); setNativeValue(el, String(value)); },
      { timeout: required ? 15000 : 5000, retries: required ? 3 : 2, desc: desc || `fill ${labels[0]}`, optional: !required },
    );
  }

  // ── Dropdown with fallback list (Category / Condition) ───────────────────────
  async function openDropdown(labels, desc) {
    return waitAndAct(
      () => {
        for (const label of labels) {
          const direct = document.querySelector(`[aria-label="${label}" i][role="button"], [aria-label="${label}" i][role="combobox"]`);
          if (direct) return direct;
          for (const lab of document.querySelectorAll('label')) {
            const txt = (lab.textContent || '').trim().toLowerCase();
            if (txt.startsWith(label.toLowerCase())) {
              return lab.querySelector('[role="button"], [role="combobox"]') || lab;
            }
          }
        }
        return null;
      },
      el => el.click(),
      { timeout: 6000, retries: 2, desc, optional: true },
    );
  }

  // Collect clickable option rows in whatever popup Facebook opened. FB doesn't
  // always use [role=option]; categories are often plain clickable rows inside a
  // menu/dialog/listbox, so we cast a wide net and keep only visible, short-text,
  // clickable elements.
  function collectOptions() {
    const direct = [
      ...document.querySelectorAll(
        '[role="listbox"] [role="option"], [role="menu"] [role="menuitem"], [role="menu"] [role="menuitemradio"], ' +
        'ul[role="listbox"] li, [role="option"], [role="menuitem"], [role="menuitemradio"], [role="radio"]',
      ),
    ];
    let opts = direct;
    if (!opts.length) {
      // Fallback: clickable rows inside any popup container.
      const popups = document.querySelectorAll('[role="dialog"], [role="menu"], [role="listbox"]');
      const rows = [];
      popups.forEach(p => rows.push(...p.querySelectorAll('div[role="button"], a[role], div[tabindex], li')));
      opts = rows;
    }
    const NON_OPTION = ['cancel', 'close', 'back', 'done', 'save', 'next', 'publish',
      'search', 'edit', 'remove', 'clear', 'x', '✕', 'siguiente', 'cancelar', 'cerrar', 'atrás'];
    const seen = new Set();
    return opts.filter(o => {
      if (seen.has(o)) return false; seen.add(o);
      if (o.getAttribute('aria-disabled') === 'true') return false;
      const txt = (o.textContent || '').trim();
      if (!txt || txt.length > 60) return false;
      if (NON_OPTION.includes(txt.toLowerCase())) return false;
      const al = (o.getAttribute('aria-label') || '').toLowerCase();
      if (NON_OPTION.some(w => al === w)) return false;
      const r = o.getBoundingClientRect();
      return r.width > 4 && r.height > 4;
    });
  }

  function matchOption(text) {
    if (!text) return null;
    const lower = text.toLowerCase();
    const opts = collectOptions();
    return opts.find(o => (o.textContent || '').trim().toLowerCase() === lower)
        || opts.find(o => (o.textContent || '').trim().toLowerCase().includes(lower));
  }

  // Has the picker closed? (no more option rows visible)
  function pickerOpen() { return collectOptions().length > 0; }

  // Try preferred + fallbacks, then — if pickFirst — ANY option. Keeps clicking
  // through sub-levels until the picker closes, so a required dropdown always
  // ends up with a value. Since any category/condition is acceptable, this never
  // needs a human.
  async function selectFromList(labels, preferred, fallbacks, desc, { pickFirst = false } = {}) {
    const candidates = [preferred, ...fallbacks].filter(Boolean);

    const opened = await openDropdown(labels, `open ${desc}`);
    if (!opened) { log(desc, 'warn', 'could not open dropdown'); return null; }
    await sleep(800);

    const search = document.querySelector('input[type="search"], [role="dialog"] input, input[aria-label*="Search" i]');

    // 1) Try to match a preferred/fallback value by typing (if searchable) or scanning.
    for (const value of candidates) {
      if (search) { setNativeValue(search, value); await sleep(700); }
      const opt = matchOption(value);
      if (opt) {
        const chosen = (opt.textContent || '').trim();
        opt.click();
        await sleep(700);
        // Drill through any sub-levels until the picker closes.
        await drillToClose(desc);
        log(desc, 'success', `selected "${chosen}"`);
        return chosen;
      }
    }

    // 2) pickFirst — click the first available option, repeatedly through sub-levels.
    if (pickFirst) {
      if (search) { setNativeValue(search, ''); await sleep(700); } // clear to reveal full list
      const chosen = await drillToClose(desc, /* clickFirstEachLevel */ true);
      if (chosen) { log(desc, 'success', `auto-selected "${chosen}"`); return chosen; }
      log(desc, 'warn', 'no options available to auto-select');
    }
    return null;
  }

  // Repeatedly click the first option until the picker closes (or we run out of
  // patience). Returns the text of the last option clicked.
  async function drillToClose(desc, clickFirstEachLevel = false) {
    let last = null;
    for (let level = 0; level < 5; level++) {
      if (!pickerOpen()) break;
      if (level === 0 && !clickFirstEachLevel) {
        // We already clicked an option above; just check if more levels appeared.
        await sleep(400);
        if (!pickerOpen()) break;
      }
      const opts = collectOptions();
      if (!opts.length) break;
      const opt = opts[0];
      last = (opt.textContent || '').trim();
      opt.click();
      log(desc, 'info', `clicked option "${last}" (level ${level + 1})`);
      await sleep(700);
    }
    return last;
  }

  // ── Images: upload from template, validate, fall back to other images ────────
  async function fetchImageFile(src) {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    if (!blob.type.startsWith('image/') && !/\.(jpe?g|png|webp|gif)$/i.test(src)) {
      throw new Error('not an image');
    }
    const name = (src.split('/').pop() || 'photo.jpg').split('?')[0];
    return new File([blob], name, { type: blob.type || 'image/jpeg' });
  }

  function countPhotoThumbs() {
    return document.querySelectorAll('img[src*="scontent"], img[src^="blob:"], div[aria-label="Photo" i]').length;
  }

  async function uploadImages(photos) {
    if (!photos || !photos.length) { log('images', 'info', 'no images in template — skipping'); return; }

    const input = await waitFor(() => document.querySelector('input[type="file"][accept*="image"]') || document.querySelector('input[type="file"]'), { timeout: 6000 })
      .catch(() => null);
    if (!input) { log('images', 'warn', 'no file input found — skipping images'); return; }

    // Try each approved image until at least one upload validates.
    for (let i = 0; i < photos.length; i++) {
      const src = photos[i];
      try {
        const before = countPhotoThumbs();
        const file = await fetchImageFile(src);
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        log('images', 'info', `uploading image ${i + 1}/${photos.length}: ${file.name}`);

        // Validate: a new thumbnail appears, or an error alert shows.
        await waitFor(() => countPhotoThumbs() > before || document.querySelector('[role="alert"]'), { timeout: 15000 });
        const alert = document.querySelector('[role="alert"]');
        if (alert && /(photo|image|upload|foto|imagen)/i.test(alert.textContent || '')) {
          throw new Error(alert.textContent.trim());
        }
        log('images', 'success', `image ${i + 1} uploaded`);
        return true; // one good image is enough to proceed
      } catch (err) {
        log('images', 'warn', `image ${i + 1} failed (${err.message}) — trying next approved image`);
      }
    }
    log('images', 'warn', 'all template images failed to upload — continuing without a photo');
    return false;
  }

  // ── Location / ZIP (with autocomplete selection) ────────────────────────────
  // Marketplace usually asks for the location on a later step. This types the ZIP
  // (or city) and picks the first autocomplete suggestion, which FB requires.
  // Fires a realistic mouse press on an element (some FB autocompletes dismiss
  // on blur before a plain .click() registers, so we send the full sequence).
  function realClick(el) {
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
  }

  // Shows a big, unmissable status banner at the top of the Facebook page so the
  // user sees exactly what happened without opening any dashboard or error page.
  function showBanner(message, kind = 'info') {
    try {
      let b = document.getElementById('fbm-banner');
      if (!b) { b = document.createElement('div'); b.id = 'fbm-banner'; document.documentElement.appendChild(b); }
      const bg = kind === 'ok' ? '#2e7d32' : kind === 'warn' ? '#b26a00' : kind === 'error' ? '#c62828' : '#1877f2';
      b.textContent = '📋 Auto-Post: ' + message;
      b.style.cssText = `position:fixed;top:0;left:0;right:0;z-index:2147483647;padding:14px 20px;` +
        `font:600 15px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#fff;text-align:center;` +
        `background:${bg};box-shadow:0 2px 10px rgba(0,0,0,.35);white-space:normal`;
    } catch (_) {}
  }

  // US state abbreviations and full names — used to keep only United States
  // location suggestions (the same ZIP can exist in other countries).
  const US_STATE_ABBR = ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
    'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND',
    'OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC'];
  const US_STATE_NAMES = ['alabama','alaska','arizona','arkansas','california','colorado','connecticut',
    'delaware','florida','georgia','hawaii','idaho','illinois','indiana','iowa','kansas','kentucky',
    'louisiana','maine','maryland','massachusetts','michigan','minnesota','mississippi','missouri',
    'montana','nebraska','nevada','new hampshire','new jersey','new mexico','new york','north carolina',
    'north dakota','ohio','oklahoma','oregon','pennsylvania','rhode island','south carolina','south dakota',
    'tennessee','texas','utah','vermont','virginia','washington','west virginia','wisconsin','wyoming',
    'district of columbia'];

  function isUSLocation(text) {
    const t = (text || '').trim();
    if (!t) return false;
    if (/\bunited states\b|\bu\.?s\.?a\.?\b/i.test(t)) return true;
    if (US_STATE_ABBR.some(a => new RegExp(`(,|\\s|·)\\s*${a}\\b`).test(t))) return true; // ", NY" / "· NJ"
    const low = t.toLowerCase();
    if (US_STATE_NAMES.some(n => low.includes(n))) return true;
    return false;
  }

  // Broadly find the location autocomplete suggestion rows, regardless of markup.
  function locationSuggestions() {
    const nodes = [
      ...document.querySelectorAll(
        '[role="listbox"] [role="option"], ul[role="listbox"] li, [role="option"], [role="menuitem"], [role="menuitemradio"]',
      ),
    ];
    const seen = new Set();
    const out = [];
    for (const n of nodes) {
      if (seen.has(n)) continue; seen.add(n);
      const txt = (n.textContent || '').trim();
      if (!txt || txt.length > 90) continue;
      const r = n.getBoundingClientRect();
      if (r.width < 6 || r.height < 6) continue;
      out.push(n);
    }
    return out;
  }

  async function fillLocation(value) {
    if (!value) return false;
    const el = findInput(LABELS.location);
    if (!el) return false; // location field not on this page

    const zip = (String(value).match(/\d{4,}/) || [])[0];

    // Type the ZIP/city.
    el.focus();
    setNativeValue(el, '');
    setNativeValue(el, String(value));
    el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: zip ? zip.slice(-1) : 'a' }));
    el.dispatchEvent(new KeyboardEvent('keyup',   { bubbles: true, key: zip ? zip.slice(-1) : 'a' }));
    await sleep(1800);

    // Strategy 1 — click the best US suggestion. We ONLY post in the United
    // States, so always prefer a US row even if a same-ZIP foreign one appears.
    let opts = locationSuggestions();
    if (!opts.length) { await sleep(1200); opts = locationSuggestions(); }
    if (opts.length) {
      const usOpts = opts.filter(o => isUSLocation(o.textContent || ''));
      const pick =
        (zip && usOpts.find(o => (o.textContent || '').includes(zip))) ||  // US row with the exact ZIP
        usOpts[0] ||                                                       // any US row
        (zip && opts.find(o => (o.textContent || '').includes(zip))) ||    // ZIP match (no US tag found)
        opts.find(o => /,\s*[A-Z]{2}\b/.test(o.textContent || '')) ||      // "City, ST"
        opts[0];                                                           // always something
      const chosen = (pick.textContent || '').trim();
      const usNote = isUSLocation(chosen) ? ' [US]' : ' [no US tag detected]';
      realClick(pick);
      if (pick.firstElementChild) realClick(pick.firstElementChild);
      await sleep(900);
      if (!locationSuggestions().length) {
        log('location', 'success', `selected "${chosen}"${usNote}`);
        return true;
      }
      log('location', 'retry', `clicked "${chosen}" but dropdown still open — trying keyboard`);
    }

    // Strategy 2 — keyboard: step through suggestions and pick the first US one.
    // Each ArrowDown highlights the next row; we Enter once we're on a US row.
    el.focus();
    const n = Math.max(1, opts.length);
    for (let i = 0; i < n; i++) {
      el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown', keyCode: 40, which: 40 }));
      el.dispatchEvent(new KeyboardEvent('keyup',   { bubbles: true, key: 'ArrowDown', keyCode: 40, which: 40 }));
      await sleep(350);
      // If the currently highlighted/aria-selected row is US, select it.
      const active = document.querySelector('[aria-selected="true"], [aria-activedescendant], .a11y-active') ;
      if (active && isUSLocation(active.textContent || '')) break;
    }
    el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', keyCode: 13, which: 13 }));
    el.dispatchEvent(new KeyboardEvent('keyup',   { bubbles: true, key: 'Enter', keyCode: 13, which: 13 }));
    await sleep(800);
    if (!locationSuggestions().length) {
      log('location', 'success', `selected a suggestion via keyboard for "${value}"`);
      return true;
    }

    log('location', 'warn', `typed "${value}" but could not lock in a US suggestion`);
    return false;
  }

  // ── Block detection ──────────────────────────────────────────────────────────
  function detectBlock() {
    // Only inspect actual popups (alert/dialog). The standard "counterfeits …
    // aren't allowed … commerce policies" disclaimer lives in the static form
    // body, so scoping to popups avoids false positives, and the phrases are
    // strong/specific enough to mean a genuine rejection.
    const scopes = [...document.querySelectorAll('[role="alert"], [role="dialog"]')];
    for (const s of scopes) {
      const t = (s.textContent || '').toLowerCase();
      const hit = BLOCK_PHRASES.find(p => t.includes(p));
      if (hit) {
        const idx = t.indexOf(hit);
        return t.slice(Math.max(0, idx - 30), idx + 140).trim();
      }
    }
    return null;
  }

  // ── Publish with hard-stop on block ──────────────────────────────────────────
  async function publish() {
    const startUrl = location.href;
    await waitAndAct(
      () => findClickableByText(PUBLISH_WORDS, ['button']),
      el => el.click(),
      { timeout: 8000, retries: 3, desc: 'click Publish' },
    );

    // Race: success (redirect) vs blocked (error dialog). Re-click Publish if a
    // confirmation dialog appears, so we never wait on a second human click.
    const start = Date.now();
    let reclicks = 0;
    while (Date.now() - start < 30000) {
      const blockReason = detectBlock();
      if (blockReason) {
        log('publish', 'block', blockReason);
        return { ok: false, blocked: true, error: 'Facebook blocked this listing: ' + blockReason };
      }

      // Success: URL changed to an item or "your listings" page.
      if (location.href !== startUrl && /\/marketplace\/(item|you\/selling)/.test(location.href) && Date.now() - start > 1500) {
        const m = location.href.match(/\/marketplace\/item\/(\d+)/);
        log('publish', 'success', m ? `listing id ${m[1]}` : 'redirected to your listings');
        return { ok: true, listingId: m ? m[1] : null, url: location.href };
      }

      // A confirmation "Publish/Post" button (often inside a dialog) — click it.
      const confirm = findClickableByText(PUBLISH_WORDS, ['button']);
      if (confirm && reclicks < 3 && Date.now() - start > 2000) {
        confirm.click();
        reclicks++;
        log('publish', 'retry', `clicked confirmation Publish (${reclicks})`);
        await sleep(2500);
        continue;
      }
      await sleep(500);
    }

    // No clear confirmation — report so the user can verify, but it may have posted.
    log('publish', 'warn', 'no confirmation detected within timeout');
    const m = location.href.match(/\/marketplace\/item\/(\d+)/);
    return { ok: !!m, listingId: m ? m[1] : null, url: location.href,
             error: m ? undefined : 'Clicked Publish but could not confirm the post — please check Marketplace once.' };
  }

  // ── Orchestration ────────────────────────────────────────────────────────────
  async function fillAndPublish(template) {
    currentJobId = template.__jobId != null ? template.__jobId : null;
    log('start', 'info', `auto-posting "${template.title}"`);
    showBanner(`Posting "${template.title}"… please don't touch the page`, 'info');

    try {
      // Step 0 — listing-type chooser
      if (location.pathname.includes('/create') && !location.pathname.includes('/item')) {
        await waitAndAct(
          () => document.querySelector('a[href*="/marketplace/create/item"]') || findClickableByText(['Item for sale', 'Artículo en venta'], ['button', 'link']),
          el => el.click(),
          { timeout: 6000, retries: 2, desc: 'choose Item for sale', optional: true },
        );
        await sleep(1200);
      }

      // Step 1 — wait for the form, then fill text fields (never abort on optional)
      await waitFor(() => findInput(LABELS.title), { timeout: 20000 });
      log('form', 'info', 'create form loaded');

      await fillText(LABELS.title,       template.title, { required: true, desc: 'fill Title' });
      await fillText(LABELS.price,       template.price ? String(template.price).replace(/[^0-9.]/g, '') : '', { desc: 'fill Price' });
      await fillText(LABELS.description, template.description, { desc: 'fill Description' });

      // Step 2 — category (preferred + fallback tree, guaranteed) and condition.
      // pickFirst:true means a required dropdown is NEVER left empty — if nothing
      // matches, it auto-selects the first valid option so Publish can enable.
      const preferredCat = template.category || '';
      const catFallbacks = CATEGORY_FALLBACKS.filter(c => c.toLowerCase() !== preferredCat.toLowerCase());
      await selectFromList(LABELS.category, preferredCat, catFallbacks, 'category', { pickFirst: true });
      await selectFromList(LABELS.condition, template.condition || 'Used - Good', ['Used - Good', 'Used - Fair', 'New', 'Used'], 'condition', { pickFirst: true });

      // Step 3 — images. Facebook REQUIRES at least one photo to publish.
      const photos = typeof template.photos === 'string' ? safeJSON(template.photos) : (template.photos || []);
      const photoOk = await uploadImages(photos);

      // Location on the first page (if present)
      await fillLocation(template.location);

      await sleep(800);

      // If no photo could be added and the template has none, we cannot publish —
      // Facebook won't allow it. Stop with a clear, one-time data fix message.
      if (!photoOk && countPhotoThumbs() === 0) {
        const msg = !photos.length
          ? 'Facebook requires at least one photo. Add a photo to this template in the dashboard, then publish again.'
          : 'The template photo(s) could not be uploaded. Use a different image in the dashboard, then publish again.';
        log('images', 'error', msg);
        showBanner(msg, 'warn');
        await flushLogs();
        return { ok: false, needsPhoto: true, error: msg };
      }

      // Step 4 — drive to the Publish button: click Next through intermediate
      // steps (filling the ZIP/location whenever that page appears), and if we
      // get stuck, re-satisfy required dropdowns. No human ever needed.
      for (let step = 0; step < 6; step++) {
        const block = detectBlock();
        if (block) { log('navigate', 'block', block); showBanner('Facebook blocked this listing: ' + block, 'error'); await flushLogs(); return { ok: false, blocked: true, error: 'Facebook blocked this listing: ' + block }; }

        // The location/ZIP step often appears after Next — fill it if shown.
        await fillLocation(template.location);

        if (findClickableByText(PUBLISH_WORDS, ['button'])) break; // ready to publish

        const next = findClickableByText(NEXT_WORDS, ['button']);
        if (next) {
          await waitAndAct(() => findClickableByText(NEXT_WORDS, ['button']), el => el.click(),
            { timeout: 5000, retries: 2, desc: `click Next (step ${step + 1})`, optional: true });
          await sleep(1500);
          continue;
        }

        // Neither Next nor Publish is enabled → a required field is still empty.
        // Force-fill the usual culprits (Category / Condition) with the first option.
        log('navigate', 'retry', 'Next/Publish not enabled — auto-filling required dropdowns');
        await selectFromList(LABELS.category,  preferredCat, catFallbacks, 'category',  { pickFirst: true });
        await selectFromList(LABELS.condition, template.condition || 'Used - Good', ['Used - Good', 'New', 'Used'], 'condition', { pickFirst: true });
        await sleep(1200);
      }

      // Step 5 — publish (publish() retries the click and hard-stops on a block)
      const result = await publish();
      log('done', result.ok ? 'success' : (result.blocked ? 'block' : 'error'), result.error || 'published');
      if (result.ok) showBanner('Published successfully! ✅', 'ok');
      else showBanner(result.error || 'Could not finish publishing', 'warn');
      await flushLogs();
      return result;
    } catch (err) {
      log('fatal', 'error', err.message);
      showBanner('Stopped: ' + err.message, 'error');
      await flushLogs();
      return { ok: false, error: err.message };
    }
  }

  // Fill the visible fields only (sidebar "Fill Form" button) — no publish.
  async function fill(template) {
    currentJobId = null;
    try {
      await waitFor(() => findInput(LABELS.title), { timeout: 15000 });
      await fillText(LABELS.title,       template.title, { required: true, desc: 'fill Title' });
      await fillText(LABELS.price,       template.price ? String(template.price).replace(/[^0-9.]/g, '') : '', { desc: 'fill Price' });
      await fillText(LABELS.description, template.description, { desc: 'fill Description' });
      await selectFromList(LABELS.category, template.category || '', CATEGORY_FALLBACKS, 'category');
      await selectFromList(LABELS.condition, template.condition || 'Used - Good', ['Used - Good', 'New', 'Used'], 'condition');
      await flushLogs();
      return { ok: true };
    } catch (err) {
      log('fill', 'error', err.message);
      await flushLogs();
      return { ok: false, error: err.message };
    }
  }

  function safeJSON(s) { try { return JSON.parse(s || '[]'); } catch (_) { return []; } }

  return { fill, fillAndPublish };
})();
