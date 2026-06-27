// Fills the Facebook Marketplace create-listing form from a template object.
// fillAndPublish() drives the complete multi-step flow and returns the new listing ID.
//
// Field-finding is done by visible label text (Title / Price / Description …) rather
// than fragile CSS classes, so it survives Facebook DOM changes and language switches.
window.FBMAutofill = {

  // English + Spanish labels for each field (Facebook localizes the UI).
  LABELS: {
    title:       ['Title', 'Título', 'Titulo'],
    price:       ['Price', 'Precio'],
    description: ['Description', 'Descripción', 'Descripcion'],
    category:    ['Category', 'Categoría', 'Categoria'],
    condition:   ['Condition', 'Estado', 'Condición', 'Condicion'],
    location:    ['Location', 'Ubicación', 'Ubicacion'],
  },
  NEXT_WORDS:    ['next', 'siguiente'],
  PUBLISH_WORDS: ['publish', 'publicar'],

  // ── Low-level helpers ───────────────────────────────────────────────────────

  _setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  },

  _delay(ms) { return new Promise(r => setTimeout(r, ms)); },

  // Finds a text input / textarea by trying several strategies for each label.
  _findInput(labels) {
    for (const label of labels) {
      // 1. aria-label exactly on the input/textarea
      let el = document.querySelector(`input[aria-label="${label}" i], textarea[aria-label="${label}" i]`);
      if (el) return el;
      // 2. aria-label contains the word
      el = document.querySelector(`input[aria-label*="${label}" i], textarea[aria-label*="${label}" i]`);
      if (el) return el;
      // 3. placeholder contains the word
      el = document.querySelector(`input[placeholder*="${label}" i], textarea[placeholder*="${label}" i]`);
      if (el) return el;
    }
    // 4. A <label> element whose visible text starts with one of the names,
    //    then the input/textarea inside it.
    const lowers = labels.map(l => l.toLowerCase());
    for (const lab of document.querySelectorAll('label')) {
      const txt = (lab.textContent || '').trim().toLowerCase();
      if (lowers.some(l => txt === l || txt.startsWith(l))) {
        const input = lab.querySelector('input, textarea');
        if (input) return input;
      }
    }
    return null;
  },

  _waitForInput(labels, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const found = this._findInput(labels);
      if (found) return resolve(found);
      const obs = new MutationObserver(() => {
        const f = this._findInput(labels);
        if (f) { obs.disconnect(); resolve(f); }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => { obs.disconnect(); reject(new Error(`Could not find the "${labels[0]}" field`)); }, timeout);
    });
  },

  async _fill(labels, value, { required = false } = {}) {
    if (value === undefined || value === null || value === '') return;
    let el;
    try {
      el = await this._waitForInput(labels, required ? 15000 : 4000);
    } catch (err) {
      if (required) throw err;
      return; // optional field absent — skip
    }
    el.focus();
    this._setNativeValue(el, '');
    await this._delay(80);
    this._setNativeValue(el, String(value));
    await this._delay(250);
  },

  // Find a clickable element (button / option) by its exact visible text.
  _findByText(words, roles = ['button', 'option', 'menuitem', 'menuitemcheckbox', 'radio']) {
    const lowers = words.map(w => w.toLowerCase());
    for (const role of roles) {
      const els = document.querySelectorAll(`[role="${role}"]`);
      const hit = [...els].find(el => lowers.includes((el.textContent || '').trim().toLowerCase()));
      if (hit) return hit;
    }
    // Fallback: any clickable div/span whose exact text matches
    for (const el of document.querySelectorAll('div[tabindex], span[tabindex], a[role]')) {
      if (lowers.includes((el.textContent || '').trim().toLowerCase())) return el;
    }
    return null;
  },

  // ── Dropdowns (Category / Condition) — best effort ──────────────────────────

  async _selectDropdown(labels, optionText) {
    if (!optionText) return false;
    // Find the dropdown trigger: an element labeled with the field name that opens a menu.
    let trigger = null;
    for (const label of labels) {
      trigger = document.querySelector(`[aria-label="${label}" i][role], label[aria-label="${label}" i]`);
      if (trigger) break;
      // label element containing the word, then the clickable control inside
      for (const lab of document.querySelectorAll('label')) {
        const txt = (lab.textContent || '').trim().toLowerCase();
        if (txt.startsWith(label.toLowerCase())) {
          trigger = lab.querySelector('[role="button"], [role="combobox"]') || lab;
          break;
        }
      }
      if (trigger) break;
    }
    if (!trigger) return false;

    trigger.click();
    await this._delay(700);

    // If there's a search box in the popup, type into it
    const search = document.querySelector('input[type="search"], [role="dialog"] input, input[aria-label*="Search" i]');
    if (search) {
      this._setNativeValue(search, optionText);
      await this._delay(700);
    }

    // Click the first option that matches
    const lower = optionText.toLowerCase();
    const options = [...document.querySelectorAll('[role="option"], [role="menuitem"], [role="menuitemradio"]')];
    let opt = options.find(o => (o.textContent || '').trim().toLowerCase() === lower)
           || options.find(o => (o.textContent || '').trim().toLowerCase().includes(lower));
    if (opt) { opt.click(); await this._delay(400); return true; }
    return false;
  },

  // ── Photos ──────────────────────────────────────────────────────────────────

  async _uploadPhotos(photos) {
    if (!photos || !photos.length) return;
    const files = [];
    for (const src of photos) {
      try {
        const res = await fetch(src);
        const blob = await res.blob();
        const name = (src.split('/').pop() || 'photo.jpg').split('?')[0];
        files.push(new File([blob], name, { type: blob.type || 'image/jpeg' }));
      } catch (err) {
        console.warn('[FBM] Could not load photo:', src, err.message);
      }
    }
    if (!files.length) return;

    let input = document.querySelector('input[type="file"][accept*="image"]');
    if (!input) input = document.querySelector('input[type="file"]');
    if (!input) { console.warn('[FBM] No photo upload input found'); return; }

    const dt = new DataTransfer();
    files.forEach(f => dt.items.add(f));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await this._delay(1800);
  },

  // ── Public API ───────────────────────────────────────────────────────────────

  // Fill the visible fields only (sidebar "Fill Form" button).
  async fill(template) {
    try {
      await this._waitForInput(this.LABELS.title, 15000);
      await this._fill(this.LABELS.title,       template.title, { required: true });
      await this._fill(this.LABELS.price,       template.price ? String(template.price).replace(/[^0-9.]/g, '') : '');
      await this._fill(this.LABELS.description, template.description);
      await this._selectDropdown(this.LABELS.category,  template.category);
      await this._selectDropdown(this.LABELS.condition, template.condition || 'Used - Good');
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  // Full automated post: fill → photos → Next → Publish → return new listing ID.
  async fillAndPublish(template) {
    try {
      // If on the listing-type chooser, pick "Item for sale".
      if (location.pathname.includes('/create') && !location.pathname.includes('/item')) {
        const itemBtn = document.querySelector('a[href*="/marketplace/create/item"]')
          || this._findByText(['Item for sale', 'Artículo en venta'], ['button', 'link']);
        if (itemBtn) { itemBtn.click(); await this._delay(1500); }
      }

      // Wait for the form to be ready (Title field present).
      await this._waitForInput(this.LABELS.title, 20000);

      // Core fields
      await this._fill(this.LABELS.title,       template.title, { required: true });
      await this._fill(this.LABELS.price,       template.price ? String(template.price).replace(/[^0-9.]/g, '') : '');
      await this._fill(this.LABELS.description, template.description);

      // Dropdowns (required by FB before Next enables) — best effort
      await this._selectDropdown(this.LABELS.category,  template.category);
      await this._selectDropdown(this.LABELS.condition, template.condition || 'Used - Good');

      // Photos
      const photos = typeof template.photos === 'string'
        ? JSON.parse(template.photos || '[]')
        : (template.photos || []);
      await this._uploadPhotos(photos);

      await this._delay(800);

      // Click Next through any intermediate steps, then Publish.
      let published = false;
      for (let step = 0; step < 4; step++) {
        const publishBtn = this._findByText(this.PUBLISH_WORDS, ['button']);
        if (publishBtn && !publishBtn.getAttribute('aria-disabled')) {
          publishBtn.click();
          published = true;
          await this._delay(3500);
          break;
        }
        const nextBtn = this._findByText(this.NEXT_WORDS, ['button']);
        if (nextBtn && nextBtn.getAttribute('aria-disabled') !== 'true') {
          nextBtn.click();
          await this._delay(1800);
        } else {
          // Nothing clickable — likely a required field we couldn't auto-fill.
          break;
        }
      }

      await this._delay(1500);
      const match = location.href.match(/\/marketplace\/item\/(\d+)/);
      const listingId = match ? match[1] : null;

      if (!published && !listingId) {
        return { ok: false, error: 'Filled the fields, but could not finish publishing automatically — please pick Category/Condition manually and click Publish. (Facebook requires those.)' };
      }
      return { ok: true, listingId, url: location.href };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },
};
