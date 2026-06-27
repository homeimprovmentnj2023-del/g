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

  // Phrases that mean Facebook has hard-blocked the listing — do NOT retry.
  const BLOCK_PHRASES = [
    "can't be listed", 'cannot be listed', 'violat', 'against our', 'community standards',
    'account restricted', 'temporarily blocked', 'not allowed', 'we removed', 'rejected',
    'no se puede publicar', 'restringid', 'infring',
  ];
  // Phrases that mean a transient glitch — safe to retry.
  const TRANSIENT_PHRASES = ['something went wrong', 'try again', 'algo salió mal', 'inténtalo de nuevo'];

  // ── Logging ─────────────────────────────────────────────────────────────────
  let currentJobId = null;
  const logBuffer = [];
  let flushTimer = null;

  function log(step, status, detail = '') {
    const entry = { job_id: currentJobId, step, status, detail: String(detail).slice(0, 500), at: Math.floor(Date.now() / 1000) };
    // Console for live debugging
    const tag = status === 'error' ? 'error' : status === 'warn' ? 'warn' : 'log';
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

  function findOption(text) {
    const lower = text.toLowerCase();
    const opts = [...document.querySelectorAll('[role="option"], [role="menuitem"], [role="menuitemradio"], [role="radio"]')];
    return opts.find(o => (o.textContent || '').trim().toLowerCase() === lower)
        || opts.find(o => (o.textContent || '').trim().toLowerCase().includes(lower));
  }

  // Try the preferred value, then fall back to any accepted alternative.
  async function selectFromList(labels, preferred, fallbacks, desc) {
    const candidates = [preferred, ...fallbacks].filter(Boolean);
    if (!candidates.length) return null;

    const opened = await openDropdown(labels, `open ${desc}`);
    if (!opened) { log(desc, 'warn', 'could not open dropdown — leaving for manual selection'); return null; }
    await sleep(600);

    // Optional search box inside the popup
    const search = document.querySelector('input[type="search"], [role="dialog"] input, input[aria-label*="Search" i]');

    for (const value of candidates) {
      try {
        if (search) { setNativeValue(search, value); await sleep(600); }
        const opt = await waitFor(() => findOption(value), { timeout: 2500 });
        opt.click();
        await sleep(400);
        log(desc, 'success', `selected "${value}"${value === preferred ? '' : ' (fallback)'}`);
        return value;
      } catch (_) {
        log(desc, 'warn', `"${value}" not available, trying next`);
      }
    }
    log(desc, 'warn', `none of [${candidates.join(', ')}] available — leaving for manual selection`);
    return null;
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

  // ── Block detection ──────────────────────────────────────────────────────────
  function detectBlock() {
    // Look inside dialogs/alerts first (most reliable), then whole page.
    const scopes = [...document.querySelectorAll('[role="dialog"], [role="alert"]')];
    const texts = scopes.map(s => (s.textContent || '').toLowerCase());
    texts.push((document.body.innerText || '').toLowerCase());
    for (const t of texts) {
      const hit = BLOCK_PHRASES.find(p => t.includes(p));
      if (hit) {
        // Grab a short reason snippet around the matched phrase.
        const idx = t.indexOf(hit);
        const reason = t.slice(Math.max(0, idx - 40), idx + 120).trim();
        return reason;
      }
    }
    return null;
  }

  // ── Publish with hard-stop on block ──────────────────────────────────────────
  async function publish() {
    const btn = await waitAndAct(
      () => findClickableByText(PUBLISH_WORDS, ['button']),
      el => el.click(),
      { timeout: 8000, retries: 3, desc: 'click Publish' },
    );
    void btn;

    // Race: success (redirect to your listings or item page) vs blocked (error dialog).
    const start = Date.now();
    while (Date.now() - start < 25000) {
      const blockReason = detectBlock();
      if (blockReason) {
        log('publish', 'block', blockReason);
        return { ok: false, blocked: true, error: 'Facebook blocked this listing: ' + blockReason };
      }
      if (/\/marketplace\/(item|you\/selling)/.test(location.href) && Date.now() - start > 1500) {
        const m = location.href.match(/\/marketplace\/item\/(\d+)/);
        log('publish', 'success', m ? `listing id ${m[1]}` : 'redirected to your listings');
        return { ok: true, listingId: m ? m[1] : null, url: location.href };
      }
      await sleep(500);
    }
    // No clear success or block — report unknown so the user can verify.
    log('publish', 'warn', 'no confirmation detected within timeout');
    const m = location.href.match(/\/marketplace\/item\/(\d+)/);
    return { ok: !!m, listingId: m ? m[1] : null, url: location.href,
             error: m ? undefined : 'Clicked Publish but could not confirm — please check Marketplace.' };
  }

  // ── Orchestration ────────────────────────────────────────────────────────────
  async function fillAndPublish(template) {
    currentJobId = template.__jobId != null ? template.__jobId : null;
    log('start', 'info', `auto-posting "${template.title}"`);

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

      // Step 2 — category (preferred + fallback tree) and condition
      const preferredCat = template.category || '';
      const catFallbacks = CATEGORY_FALLBACKS.filter(c => c.toLowerCase() !== preferredCat.toLowerCase());
      await selectFromList(LABELS.category, preferredCat, catFallbacks, 'category');
      await selectFromList(LABELS.condition, template.condition || 'Used - Good', ['Used - Good', 'Used - Fair', 'New', 'Used'], 'condition');

      // Step 3 — images (validated, with per-image fallback)
      const photos = typeof template.photos === 'string' ? safeJSON(template.photos) : (template.photos || []);
      await uploadImages(photos);

      await sleep(800);

      // Step 4 — advance through any Next steps
      for (let step = 0; step < 4; step++) {
        const block = detectBlock();
        if (block) { log('navigate', 'block', block); return { ok: false, blocked: true, error: 'Facebook blocked this listing: ' + block }; }

        if (findClickableByText(PUBLISH_WORDS, ['button'])) break; // ready to publish
        const next = findClickableByText(NEXT_WORDS, ['button']);
        if (next) {
          await waitAndAct(() => findClickableByText(NEXT_WORDS, ['button']), el => el.click(),
            { timeout: 5000, retries: 2, desc: `click Next (step ${step + 1})`, optional: true });
          await sleep(1500);
        } else break;
      }

      // Step 5 — publish (hard-stop on block)
      if (!findClickableByText(PUBLISH_WORDS, ['button'])) {
        const msg = 'Reached the form but the Publish button is not available — a required field (often Category or Condition) still needs your input. Everything else is filled; please complete it and press Publish.';
        log('publish', 'warn', msg);
        return { ok: false, needsHuman: true, error: msg };
      }
      const result = await publish();
      log('done', result.ok ? 'success' : 'error', result.error || 'published');
      await flushLogs();
      return result;
    } catch (err) {
      log('fatal', 'error', err.message);
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
