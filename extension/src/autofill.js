// Fills the Facebook Marketplace create-listing form from a template object.
// fillAndPublish() drives the complete multi-step flow and returns the new listing ID.
window.FBMAutofill = {

  // ── Helpers ───────────────────────────────────────────────────────────────

  _setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  },

  _delay(ms) { return new Promise(r => setTimeout(r, ms)); },

  _waitFor(selector, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const el = document.querySelector(selector);
      if (el) return resolve(el);
      const obs = new MutationObserver(() => {
        const found = document.querySelector(selector);
        if (found) { obs.disconnect(); resolve(found); }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => { obs.disconnect(); reject(new Error(`Timeout waiting for: ${selector}`)); }, timeout);
    });
  },

  // Find a button/div by its visible text content (case-insensitive).
  _findByText(text, role = 'button') {
    const els = document.querySelectorAll(`[role="${role}"]`);
    const lower = text.toLowerCase();
    return [...els].find(el => el.textContent?.trim().toLowerCase() === lower) || null;
  },

  // Click the first matching element; try selector first, then text fallback.
  async _click(selector, textFallback, timeout = 8000) {
    let el;
    try { el = await this._waitFor(selector, timeout); } catch (_) {}
    if (!el && textFallback) el = this._findByText(textFallback);
    if (!el) throw new Error(`Cannot find button: ${selector} / "${textFallback}"`);
    el.click();
    await this._delay(600);
  },

  // ── Photo upload ──────────────────────────────────────────────────────────

  // Fetches photo URLs/base64 strings and injects them into FB's file input.
  async _uploadPhotos(photos) {
    if (!photos || !photos.length) return;
    const S = window.FBM_SELECTORS;

    // Collect File objects
    const files = [];
    for (const src of photos) {
      try {
        let blob;
        if (src.startsWith('data:')) {
          const res = await fetch(src);
          blob = await res.blob();
        } else {
          const res = await fetch(src);
          blob = await res.blob();
        }
        const name = src.split('/').pop().split('?')[0] || 'photo.jpg';
        files.push(new File([blob], name, { type: blob.type || 'image/jpeg' }));
      } catch (err) {
        console.warn('[FBM] Could not load photo:', src, err.message);
      }
    }
    if (!files.length) return;

    // Find the hidden file input (may require clicking the upload area first)
    let input = document.querySelector(S.photoUploadInput);
    if (!input) {
      // Click the visible upload area to reveal the input
      const area = document.querySelector(S.photoUploadArea);
      if (area) { area.click(); await this._delay(800); }
      input = document.querySelector(S.photoUploadInput);
    }
    if (!input) { console.warn('[FBM] No photo upload input found'); return; }

    const dt = new DataTransfer();
    files.forEach(f => dt.items.add(f));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await this._delay(1500); // wait for upload previews
  },

  // ── Field fill ────────────────────────────────────────────────────────────

  async _fillField(selector, value, timeout = 8000) {
    if (!value) return;
    const el = await this._waitFor(selector, timeout);
    el.focus();
    // Clear existing value first
    this._setNativeValue(el, '');
    await this._delay(100);
    this._setNativeValue(el, String(value));
    await this._delay(300);
  },

  async _fillLocation(location) {
    if (!location) return;
    const S = window.FBM_SELECTORS;
    try {
      const el = await this._waitFor(S.locationInput, 5000);
      el.focus();
      this._setNativeValue(el, location);
      await this._delay(1000);
      // Click first autocomplete suggestion
      const sug = document.querySelector(S.autocompleteSuggestion);
      if (sug) { sug.click(); await this._delay(500); }
    } catch (_) { /* location field absent on some listing types */ }
  },

  async _selectCategory(category) {
    if (!category) return;
    const S = window.FBM_SELECTORS;
    try {
      await this._click(S.categoryBtn, null, 4000);
      await this._delay(400);
      // Type into category search box
      const search = document.querySelector(S.categorySearch);
      if (search) {
        search.focus();
        this._setNativeValue(search, category);
        await this._delay(800);
        // Click first result
        const opt = document.querySelector('[role="option"]:first-child, li[role="option"]:first-child');
        if (opt) { opt.click(); await this._delay(400); }
      }
    } catch (_) { /* category may already be set or not present */ }
  },

  // ── Public API ────────────────────────────────────────────────────────────

  // Fill form fields only (used by sidebar Fill button).
  async fill(template) {
    const S = window.FBM_SELECTORS;
    try {
      await this._fillField(S.titleInput,       template.title);
      await this._fillField(S.priceInput,       template.price ? String(template.price).replace(/[^0-9.]/g, '') : '');
      await this._fillField(S.descriptionInput, template.description);
      await this._fillLocation(template.location);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  // Full automated post: fill → upload photos → Next → Publish → return new listing ID.
  async fillAndPublish(template) {
    const S = window.FBM_SELECTORS;
    try {
      // If we landed on /marketplace/create (type selector page), click "Item for sale"
      if (location.pathname.startsWith('/marketplace/create') && !location.pathname.includes('/item')) {
        try {
          await this._click(S.itemForSaleBtn, 'Item for sale', 5000);
          await this._delay(1000);
        } catch (_) { /* already on item form */ }
      }

      // Wait for the title field — confirms form is ready
      await this._waitFor(S.titleInput, 15000);

      // Fill core fields
      await this._fillField(S.titleInput,       template.title);
      await this._fillField(S.priceInput,       template.price ? String(template.price).replace(/[^0-9.]/g, '') : '');
      await this._fillField(S.descriptionInput, template.description);
      await this._selectCategory(template.category);
      await this._fillLocation(template.location);

      // Upload photos
      const photos = typeof template.photos === 'string' ? JSON.parse(template.photos || '[]') : (template.photos || []);
      await this._uploadPhotos(photos);

      // Click "Next" — may appear multiple times (multi-step forms)
      for (let step = 0; step < 3; step++) {
        const nextBtn = document.querySelector(S.nextBtn) || this._findByText('next');
        const publishBtn = document.querySelector(S.publishBtn) || this._findByText('publish');

        if (publishBtn) {
          publishBtn.click();
          await this._delay(3000);
          break;
        }
        if (nextBtn) {
          nextBtn.click();
          await this._delay(1500);
        } else {
          break;
        }
      }

      // After publish, FB redirects to /marketplace/item/{id}
      await this._delay(2000);
      const match = location.href.match(/\/marketplace\/item\/(\d+)/);
      const listingId = match ? match[1] : null;

      return { ok: true, listingId, url: location.href };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },
};
