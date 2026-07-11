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
  // These are REAL Marketplace category names (the templates say "Home Improvement",
  // Facebook calls it "Home Improvement Supplies" — matchOption's substring match
  // bridges that, and the rest are genuine fallbacks that accept our items).
  const CATEGORY_FALLBACKS = ['Home Improvement Supplies', 'Tools', 'Home Goods',
    'Garden & Outdoor', 'Household Supplies', 'Miscellaneous', 'Other'];

  // NEVER auto-pick these when falling back to "first available option": they
  // change the whole create form (or are plainly wrong for our items), which is
  // how a listing ends up mis-categorised or the form gets stuck.
  const AUTO_PICK_AVOID = ['vehicles', 'property rentals', 'property for sale', 'home sales',
    'homes for sale', 'classifieds', 'buy and sell groups', 'jobs', 'free stuff', 'rentals'];

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
      if (isInNav(o)) return false;                 // never Facebook's own search/nav suggestions
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

  // Facebook's top bar / site search (and its suggestion dropdown) must never be
  // mistaken for a picker: its rows are role=option too, and its input is
  // input[type=search] — typing a category into it navigates away from the form.
  function isInNav(el) {
    return !!(el && el.closest && el.closest('[role="banner"], [role="navigation"], [aria-label="Facebook"]'));
  }

  // The search box BELONGING TO the open picker (dialog/menu/listbox) — not the
  // page's nav search bar.
  function pickerSearchInput() {
    const scopes = [...document.querySelectorAll('[role="dialog"], [role="menu"], [role="listbox"]')].filter(s => !isInNav(s));
    for (let i = scopes.length - 1; i >= 0; i--) {
      const inp = scopes[i].querySelector('input[type="search"], input[aria-label*="Search" i], input[placeholder*="Search" i], input[type="text"]');
      if (inp && !isInNav(inp)) { const r = inp.getBoundingClientRect(); if (r.width > 4 && r.height > 4) return inp; }
    }
    return null;
  }

  function matchOption(text) {
    if (!text) return null;
    const lower = text.toLowerCase();
    const opts = collectOptions();
    return opts.find(o => (o.textContent || '').trim().toLowerCase() === lower)
        || opts.find(o => (o.textContent || '').trim().toLowerCase().includes(lower));
  }

  // Facebook VIRTUALISES the long category list — the row you want ("Home
  // Improvement Supplies") often isn't rendered until you scroll to it, which is
  // why matching used to silently fall through to a fallback like "Tools". Scroll
  // the picker and re-scan before giving up.
  // Scroll the open picker and collect every option label it renders (the list is
  // virtualised, so this reveals options not initially in the DOM).
  async function scrollAndCollect(tries = 12) {
    const seen = new Set();
    const grab = () => collectOptions().forEach(o => { const t = (o.textContent || '').trim(); if (t) seen.add(t); });
    grab();
    const scopes = [...document.querySelectorAll('[role="dialog"], [role="menu"], [role="listbox"]')].filter(s => !isInNav(s));
    const scope = scopes[scopes.length - 1];
    const scrollers = scope ? [scope, ...scope.querySelectorAll('div')].filter(e => e.scrollHeight > e.clientHeight + 20) : [];
    for (let i = 0; i < tries; i++) { scrollers.forEach(s => { s.scrollTop += 350; }); await sleep(280); grab(); }
    scrollers.forEach(s => { s.scrollTop = 0; }); await sleep(200);
    return [...seen];
  }

  async function matchOptionScrolling(text, tries = 8) {
    let opt = matchOption(text);
    if (opt) return opt;
    const scopes = [...document.querySelectorAll('[role="dialog"], [role="menu"], [role="listbox"]')].filter(s => !isInNav(s));
    const scope = scopes[scopes.length - 1];
    if (!scope) return null;
    const scrollers = [scope, ...scope.querySelectorAll('div')].filter(e => e.scrollHeight > e.clientHeight + 20);
    for (let i = 0; i < tries; i++) {
      scrollers.forEach(s => { s.scrollTop += 400; });
      await sleep(320);
      opt = matchOption(text);
      if (opt) return opt;
    }
    return null;
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

    // Calibration: record what Facebook ACTUALLY offers, so category/condition can
    // be matched by their real names instead of my guesses.
    if (desc === 'category') {
      const seen = await scrollAndCollect(20);
      log('category', 'info', 'FB options: ' + seen.slice(0, 24).join(' | '));
    }

    const search = pickerSearchInput();   // scoped to the picker — never FB's nav search

    // 1) Try to match a preferred/fallback value by typing (if searchable) or scanning.
    for (const value of candidates) {
      if (search) { setNativeValue(search, value); await sleep(900); }
      const opt = await matchOptionScrolling(value);
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
      // When auto-picking, skip categories that would rewrite the whole form
      // (Vehicles, Property Rentals, …) rather than blindly taking options[0].
      const safe = opts.filter(o => !AUTO_PICK_AVOID.includes((o.textContent || '').trim().toLowerCase()));
      const opt = (clickFirstEachLevel ? safe[0] : null) || opts[0];
      if (!opt) break;
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
    const isData = /^data:/i.test(src);
    if (!blob.type.startsWith('image/') && !isData && !/\.(jpe?g|png|webp|gif)$/i.test(src)) {
      throw new Error('not an image');
    }
    const name = isData ? `photo-${Date.now()}.jpg` : (src.split('/').pop() || 'photo.jpg').split('?')[0];
    return new File([blob], name, { type: blob.type || 'image/jpeg' });
  }

  // Make a photo subtly unique so Facebook's duplicate-image detection doesn't
  // flag it as the same picture used before (or in another area). The change is
  // invisible to a human: tiny random edge crop, a small brightness/contrast
  // shift, sparse low-amplitude noise, a 1px nudge, and JPEG re-encode at a
  // random quality. Each call produces a different fingerprint.
  async function uniquifyImageFile(file) {
    try {
      const bitmap = await createImageBitmap(file);
      const clamp = v => (v < 0 ? 0 : v > 255 ? 255 : v);

      // Larger random crop (0–7% per side) → bigger change to the perceptual hash.
      const cx = Math.floor(bitmap.width  * (Math.random() * 0.07));
      const cy = Math.floor(bitmap.height * (Math.random() * 0.07));
      const w = Math.max(1, bitmap.width  - cx * 2);
      const h = Math.max(1, bitmap.height - cy * 2);

      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#f2f2f2';
      ctx.fillRect(0, 0, w, h);   // fallback fill so rotation corners never show gaps

      // Stronger, still-natural color changes: brightness/contrast + saturation +
      // a small hue rotation. Hue shift in particular moves the color hash.
      const bright   = 1 + (Math.random() * 0.08 - 0.04);
      const contrast = 1 + (Math.random() * 0.06 - 0.03);
      const sat      = 1 + (Math.random() * 0.10 - 0.05);
      const hue      = (Math.random() * 16 - 8).toFixed(1);   // ±8°
      ctx.filter = `brightness(${bright.toFixed(3)}) contrast(${contrast.toFixed(3)}) saturate(${sat.toFixed(3)}) hue-rotate(${hue}deg)`;

      // Slight rotation (±2.5°) + occasional horizontal mirror, drawn with 6%
      // overscan so the rotated corners stay covered. Rotation + mirror change the
      // perceptual hash far more than brightness alone, while still looking natural.
      const deg = Math.random() * 5 - 2.5;
      const mirror = Math.random() < 0.5;
      const zoom = 1.06;
      ctx.translate(w / 2, h / 2);
      ctx.rotate(deg * Math.PI / 180);
      if (mirror) ctx.scale(-1, 1);
      ctx.drawImage(bitmap, cx, cy, w, h, -(w * zoom) / 2, -(h * zoom) / 2, w * zoom, h * zoom);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.filter = 'none';

      // Sparse, low-amplitude noise (every ~60–180th pixel, ±4 levels).
      try {
        const imgData = ctx.getImageData(0, 0, w, h);
        const d = imgData.data;
        const step = (60 + Math.floor(Math.random() * 120)) * 4;
        for (let i = 0; i < d.length; i += step) {
          const n = (Math.random() * 8 - 4) | 0;
          d[i] = clamp(d[i] + n); d[i + 1] = clamp(d[i + 1] + n); d[i + 2] = clamp(d[i + 2] + n);
        }
        ctx.putImageData(imgData, 0, 0);
      } catch (_) { /* getImageData can fail on huge canvases — skip noise */ }

      const quality = 0.80 + Math.random() * 0.16; // random re-encode quality
      const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', quality));
      if (!blob) return file;
      const base = (file.name || 'photo').replace(/\.\w+$/, '');
      log('images', 'info', `uniquified image (${w}x${h}, rot ${deg.toFixed(1)}°${mirror ? ' +mirror' : ''}, hue ${hue}°, q${quality.toFixed(2)})`);
      return new File([blob], `${base}-${Date.now()}.jpg`, { type: 'image/jpeg' });
    } catch (err) {
      log('images', 'warn', `could not uniquify image (${err.message}) — using original`);
      return file;
    }
  }

  function countPhotoThumbs() {
    // Broad match — the check is relative (thumbs after upload > before), so extra
    // matches don't cause false positives, but missing the new thumb caused false
    // "upload failed". Cover blob:/data:/scontent thumbnails and FB's media nodes.
    return document.querySelectorAll(
      'img[src*="scontent"], img[src^="blob:"], img[src^="data:"], ' +
      'div[aria-label="Photo" i], [aria-label*="photo" i] img, ' +
      '[data-visualcompletion="media-vc-image"]'
    ).length;
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
        const original = await fetchImageFile(src);
        const file = await uniquifyImageFile(original); // defeat duplicate-image detection
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        log('images', 'info', `uploading image ${i + 1}/${photos.length}: ${file.name}`);

        // Validate: a new thumbnail appears, or an error alert shows.
        await waitFor(() => countPhotoThumbs() > before || document.querySelector('[role="alert"]'), { timeout: 20000 });
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

  // ZIP → state, by USPS 3-digit prefix ranges. This lets us VERIFY that the row
  // Facebook offers is in the state the ZIP really belongs to, without needing the
  // ZIP to be printed in the suggestion text (FB often shows just "Brooklyn, NY").
  const ZIP_PREFIX_STATE = [
    [5, 5, 'NY'], [10, 27, 'MA'], [28, 29, 'RI'], [30, 38, 'NH'], [39, 49, 'ME'], [50, 59, 'VT'],
    [60, 69, 'CT'], [70, 89, 'NJ'], [100, 149, 'NY'], [150, 196, 'PA'], [197, 199, 'DE'],
    [200, 205, 'DC'], [206, 219, 'MD'], [220, 246, 'VA'], [247, 268, 'WV'], [270, 289, 'NC'],
    [290, 299, 'SC'], [300, 319, 'GA'], [320, 349, 'FL'], [350, 369, 'AL'], [370, 385, 'TN'],
    [386, 397, 'MS'], [398, 399, 'GA'], [400, 427, 'KY'], [430, 459, 'OH'], [460, 479, 'IN'],
    [480, 499, 'MI'], [500, 528, 'IA'], [530, 549, 'WI'], [550, 567, 'MN'], [570, 577, 'SD'],
    [580, 588, 'ND'], [590, 599, 'MT'], [600, 629, 'IL'], [630, 658, 'MO'], [660, 679, 'KS'],
    [680, 693, 'NE'], [700, 714, 'LA'], [716, 729, 'AR'], [730, 749, 'OK'], [750, 799, 'TX'],
    [800, 816, 'CO'], [820, 831, 'WY'], [832, 838, 'ID'], [840, 847, 'UT'], [850, 865, 'AZ'],
    [870, 884, 'NM'], [885, 885, 'TX'], [889, 898, 'NV'], [900, 961, 'CA'], [967, 968, 'HI'],
    [970, 979, 'OR'], [980, 994, 'WA'], [995, 999, 'AK'],
  ];
  function stateForZip(zip) {
    const p = parseInt(String(zip || '').slice(0, 3), 10);
    if (!Number.isFinite(p)) return '';
    const hit = ZIP_PREFIX_STATE.find(([lo, hi]) => p >= lo && p <= hi);
    return hit ? hit[2] : '';
  }
  // 2-letter abbr → full state name, so we can match a suggestion whether Facebook
  // prints "Forest Hills, NY" OR "Forest Hills, New York".
  const STATE_ABBR_TO_NAME = {
    AL:'alabama',AK:'alaska',AZ:'arizona',AR:'arkansas',CA:'california',CO:'colorado',CT:'connecticut',
    DE:'delaware',FL:'florida',GA:'georgia',HI:'hawaii',ID:'idaho',IL:'illinois',IN:'indiana',IA:'iowa',
    KS:'kansas',KY:'kentucky',LA:'louisiana',ME:'maine',MD:'maryland',MA:'massachusetts',MI:'michigan',
    MN:'minnesota',MS:'mississippi',MO:'missouri',MT:'montana',NE:'nebraska',NV:'nevada',NH:'new hampshire',
    NJ:'new jersey',NM:'new mexico',NY:'new york',NC:'north carolina',ND:'north dakota',OH:'ohio',
    OK:'oklahoma',OR:'oregon',PA:'pennsylvania',RI:'rhode island',SC:'south carolina',SD:'south dakota',
    TN:'tennessee',TX:'texas',UT:'utah',VT:'vermont',VA:'virginia',WA:'washington',WV:'west virginia',
    WI:'wisconsin',WY:'wyoming',DC:'district of columbia',
  };
  // Is this suggestion in state `st`? Matches the abbreviation ("· NY") OR the full
  // name ("New York") — FB uses either depending on the row.
  function suggestionInState(text, st) {
    if (!st) return false;
    const t = String(text || '');
    if (new RegExp(`(^|[,·\\s])${st}\\b`).test(t)) return true;
    const full = STATE_ABBR_TO_NAME[st];
    return !!full && t.toLowerCase().includes(full);
  }

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

  // The location we already set THIS RUN. fillLocation is called again on every
  // step of the publish loop; without this guard it re-types into the field and can
  // replace an already-correct pick with a wrong one.
  let locationDone = '';

  async function fillLocation(value) {
    if (!value) return false;
    if (locationDone && locationDone === String(value).trim()) return true;   // already set — don't clobber
    const el = findInput(LABELS.location);
    if (!el) return false; // location field not on this page

    const raw = String(value).trim();
    const zip = (raw.match(/\b\d{5}\b/) || [])[0] || '';

    const typeIn = async (text, waitMs) => {
      el.focus();
      setNativeValue(el, '');
      await sleep(150);
      setNativeValue(el, text);
      const k = text.slice(-1) || 'a';
      el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: k }));
      el.dispatchEvent(new KeyboardEvent('keyup',   { bubbles: true, key: k }));
      await sleep(waitMs);
    };

    // We ONLY post in the United States, in the state the ZIP actually belongs to.
    // Accept a suggestion only when it can be VERIFIED:
    //   • it contains the ZIP we asked for, or
    //   • it sits in the state that ZIP belongs to (e.g. 11234 → "Brooklyn, NY"), or
    //   • it is the ONLY US suggestion offered (unambiguous).
    // Otherwise do NOT guess — blindly taking the first US row (the old `us[0]`) is
    // exactly how listings landed in the wrong state. A foreign row is never confirmed.
    const expectState = stateForZip(zip);
    const pickVerified = () => {
      const us = locationSuggestions().filter(o => isUSLocation(o.textContent || ''));
      if (!us.length) return null;
      if (zip) { const exact = us.find(o => (o.textContent || '').includes(zip)); if (exact) return exact; }
      if (expectState) { const inState = us.find(o => suggestionInState(o.textContent || '', expectState)); if (inState) return inState; }
      return us.length === 1 ? us[0] : null;
    };

    // Wait for Facebook to actually return suggestions instead of sleeping a fixed
    // amount — a slow autocomplete was making good ZIPs (e.g. 20814) fail at random.
    const waitForSuggestions = async (ms) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (locationSuggestions().length) return true;
        await sleep(200);
      }
      return false;
    };

    // Re-type (progressively more patient) rather than appending a ", United States"
    // hint — that hint ended up typed into the box and skewed the suggestions.
    // Extra attempts + backoff because rapid back-to-back lookups get throttled by
    // Facebook's autocomplete, which is what makes a good ZIP fail intermittently.
    let lastSeen = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      await typeIn(raw, 400 + attempt * 200);
      await waitForSuggestions(3000 + attempt * 1500);
      let pick = pickVerified();
      if (!pick) { await sleep(1200); pick = pickVerified(); }
      if (pick) {
        const chosen = (pick.textContent || '').trim();
        realClick(pick);
        if (pick.firstElementChild) realClick(pick.firstElementChild);
        await sleep(900);
        locationDone = raw;
        log('location', 'success', `selected US location "${chosen}" for "${raw}"`);
        return true;
      }
      lastSeen = locationSuggestions().map(o => (o.textContent || '').trim().slice(0, 40)).filter(Boolean);
      if (attempt < 3) await sleep(1500 + attempt * 1000);   // back off before retrying a throttled field
    }

    // Log what FB actually offered so a persistent miss can be diagnosed precisely.
    log('location', 'error', `no US suggestion for "${raw}" (expected ${expectState || '?'}) — saw: [${lastSeen.slice(0, 6).join(' | ') || 'nothing'}]`);
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

  // After publishing, Facebook usually lands on "your listings" (not the item
  // page), so the new item's id isn't in the URL. Find it by matching the title
  // to a listing card on that page, so the backend can track + replace it later.
  // Broad match: any anchor whose href contains /item/<digits> (covers
  // /marketplace/item/, /item/, and query-string variants).
  function findPostedListing(title) {
    const want = String(title || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 24);
    const items = [];
    for (const a of document.querySelectorAll('a[href]')) {
      const m = (a.getAttribute('href') || '').match(/\/(?:marketplace\/)?item\/(\d+)/);
      if (m) items.push({ a, id: m[1] });
    }
    // Match by TITLE only. Do NOT fall back to "first item on the page" — on rapid
    // back-to-back posts that first item is a PREVIOUS listing, which assigns a
    // wrong id and merges records. Better to return null (the status monitor will
    // pick the listing up on its next scan) than a confidently-wrong id.
    if (want) {
      for (const it of items) {
        const scope = it.a.closest('[role="listitem"], [role="article"], li') || it.a.parentElement || it.a;
        const txt = (scope.textContent || '').toLowerCase().replace(/\s+/g, ' ');
        if (txt.includes(want.slice(0, 18))) return { id: it.id, url: `https://www.facebook.com/marketplace/item/${it.id}/` };
      }
    }
    return null;
  }

  // If we still can't find it, snapshot the page's links so the selector can be
  // calibrated from the real "your listings" DOM (same pattern as the inbox).
  async function captureSellingDebug(title) {
    try {
      const hrefs = [...document.querySelectorAll('a[href]')].map(a => a.getAttribute('href') || '');
      await fetch(`${BACKEND}/api/debug`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'mp-selling-debug', url: location.href, title,
          anchorCount: hrefs.length,
          itemLinks: hrefs.filter(h => /\/item\//.test(h)).slice(0, 20),
          marketplaceLinks: hrefs.filter(h => /\/marketplace\//.test(h)).slice(0, 25),
        }),
      });
    } catch (_) {}
  }

  // ── Publish with hard-stop on block ──────────────────────────────────────────
  async function publish(title) {
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
        if (m) { log('publish', 'success', `listing id ${m[1]}`); return { ok: true, listingId: m[1], url: location.href }; }
        // Landed on "your listings" — poll for the new listing's id/url so it's
        // trackable. Scroll each pass to trigger Facebook's lazy list rendering.
        let found = null;
        for (let k = 0; k < 12 && !found; k++) {
          found = findPostedListing(title);
          if (!found) { try { window.scrollTo(0, document.body.scrollHeight); } catch (_) {} await sleep(1000); }
        }
        if (found) { log('publish', 'success', `listing id ${found.id} (from your-listings)`); return { ok: true, listingId: found.id, url: found.url }; }
        await captureSellingDebug(title);
        log('publish', 'success', 'published (listing id not captured — snapshot saved for calibration)');
        return { ok: true, listingId: null, url: location.href };
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
    if (m) return { ok: true, listingId: m[1], url: location.href };
    const found = findPostedListing(title);
    if (found) { log('publish', 'success', `listing id ${found.id} (recovered after timeout)`); return { ok: true, listingId: found.id, url: found.url }; }
    return { ok: false, listingId: null, url: location.href,
             error: 'Clicked Publish but could not confirm the post — please check Marketplace once.' };
  }

  // ── Delete an existing listing (so a repost isn't rejected as a duplicate) ────
  // Runs on the listing's own page. Opens the manage/more menu if needed, clicks
  // Delete, and confirms. Best-effort: if the listing is already gone, returns
  // gracefully so the repost can still proceed.
  const DELETE_WORDS  = ['delete listing', 'delete', 'remove listing', 'remove',
    'eliminar publicación', 'eliminar', 'borrar', 'quitar'];
  const MENU_WORDS    = ['more', 'more options', 'manage', 'options', 'menu', 'edit listing',
    'más', 'mas', 'más opciones', 'opciones', 'administrar', 'editar'];
  const CONFIRM_WORDS = ['delete', 'confirm', 'remove', 'ok', 'eliminar', 'borrar', 'aceptar', 'confirmar'];

  function findDeleteControl() {
    let el = findClickableByText(DELETE_WORDS, ['button', 'menuitem', 'menuitemradio']);
    if (el) return el;
    const opts = collectOptions();
    return opts.find(o => /delete|remove|eliminar|borrar|quitar/i.test(o.textContent || '')) || null;
  }

  // When we can't find a Delete control, snapshot the page so the selector (or the
  // reason — suspended-listing notice, buyer view, not-owner) can be seen.
  async function captureDeleteDebug() {
    try {
      const controls = [...document.querySelectorAll('[role="button"],[role="menuitem"],button,a[href]')]
        .filter(el => (el.offsetWidth || el.offsetHeight))
        .slice(0, 45)
        .map(el => ({ tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '',
          aria: (el.getAttribute('aria-label') || '').slice(0, 40),
          text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40) }));
      await fetch(`${BACKEND}/api/debug`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'mp-delete-debug', url: location.href,
          bodySnippet: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 320), controls }),
      });
    } catch (_) {}
  }

  async function deleteListing() {
    log('delete', 'info', 'attempting to delete old listing before reposting');
    try {
      await sleep(1500);

      // If the page says the listing is unavailable, treat as already deleted.
      const body = (document.body.innerText || '').toLowerCase();
      if (/no longer available|isn'?t available|page not found|content not found|contenido no disponible/.test(body)) {
        log('delete', 'success', 'listing already gone — nothing to delete');
        return { ok: true, alreadyGone: true };
      }

      // Try to find a Delete control directly; otherwise open a More/Manage menu.
      let del = findDeleteControl();
      if (!del) {
        const more = findClickableByText(MENU_WORDS, ['button', 'menuitem'])
          || document.querySelector('[aria-label="More options" i], [aria-label="Más opciones" i], [aria-haspopup="menu"]');
        if (more) { realClick(more); await sleep(1300); del = findDeleteControl(); }
      }
      if (!del) { await captureDeleteDebug(); log('delete', 'warn', 'no Delete control found — snapshot saved for calibration'); return { ok: false, noControl: true }; }

      realClick(del);
      await sleep(1300);

      // Confirm in the dialog (prefer a button inside an actual dialog).
      let confirm = null;
      const dialog = document.querySelector('[role="dialog"]');
      if (dialog) {
        const lowers = CONFIRM_WORDS;
        confirm = [...dialog.querySelectorAll('[role="button"], button')]
          .find(b => lowers.includes((b.textContent || '').trim().toLowerCase()));
      }
      if (!confirm) confirm = findClickableByText(CONFIRM_WORDS, ['button']);
      if (confirm) { realClick(confirm); await sleep(1800); }

      log('delete', 'success', 'old listing deleted');
      return { ok: true };
    } catch (err) {
      log('delete', 'warn', `delete failed (${err.message}) — continuing to post`);
      return { ok: false, error: err.message };
    }
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
      const result = await publish(template.title);
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

  // Read the current create/edit FORM's field VALUES (reliable: real inputs with
  // values), to copy an existing listing into a template. Use on the Edit page.
  function readForm() {
    const get = (labels) => {
      const el = findInput(labels);
      if (!el) return '';
      return (el.value || el.textContent || '').trim();
    };
    // Category/Condition show their chosen value as the labelled control's text.
    const chosen = (labels) => {
      for (const label of labels) {
        for (const lab of document.querySelectorAll('label, [role="button"], [role="combobox"]')) {
          const txt = (lab.textContent || '').trim();
          if (txt.toLowerCase().startsWith(label.toLowerCase()) && txt.length > label.length + 1) {
            return txt.slice(label.length).replace(/^[:\s-]+/, '').trim().slice(0, 60);
          }
        }
      }
      return '';
    };
    const photoUrls = [...new Set(
      [...document.querySelectorAll('img[src*="scontent"], img[src*="fbcdn"]')]
        .filter(i => (i.naturalWidth || i.width || 0) > 150)
        .map(i => i.currentSrc || i.src),
    )].slice(0, 10);

    return {
      title:       get(LABELS.title),
      price:       get(LABELS.price).replace(/[^0-9.]/g, ''),
      description: get(LABELS.description),
      category:    chosen(LABELS.category),
      location:    get(LABELS.location),
      photoUrls,
      url:         location.href,
    };
  }

  return { fill, fillAndPublish, deleteListing, readForm };
})();
