// Fills the Facebook Marketplace create-listing form from a template object.
window.FBMAutofill = {
  // Simulates a realistic user input event so React's controlled inputs respond.
  _setNativeValue(el, value) {
    const nativeInput = Object.getOwnPropertyDescriptor(el.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype, 'value');
    nativeInput.set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  },

  _waitFor(selector, timeout = 8000) {
    return new Promise((resolve, reject) => {
      const el = document.querySelector(selector);
      if (el) return resolve(el);
      const obs = new MutationObserver(() => {
        const found = document.querySelector(selector);
        if (found) { obs.disconnect(); resolve(found); }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => { obs.disconnect(); reject(new Error(`Timeout: ${selector}`)); }, timeout);
    });
  },

  async fill(template) {
    const S = window.FBM_SELECTORS;
    const delay = ms => new Promise(r => setTimeout(r, ms));

    try {
      // Title
      if (template.title) {
        const el = await this._waitFor(S.titleInput);
        el.focus();
        this._setNativeValue(el, template.title);
        await delay(300);
      }

      // Price
      if (template.price) {
        const el = await this._waitFor(S.priceInput);
        el.focus();
        this._setNativeValue(el, String(template.price).replace(/[^0-9.]/g, ''));
        await delay(300);
      }

      // Description
      if (template.description) {
        const el = await this._waitFor(S.descriptionInput);
        el.focus();
        this._setNativeValue(el, template.description);
        await delay(300);
      }

      // Location/ZIP — type into the location field
      if (template.location) {
        try {
          const el = await this._waitFor(S.locationInput, 3000);
          el.focus();
          this._setNativeValue(el, template.location);
          await delay(800);
          // Click first autocomplete suggestion if present
          const suggestion = document.querySelector('ul[role="listbox"] li:first-child');
          if (suggestion) suggestion.click();
          await delay(400);
        } catch (_) { /* location field may not be present on all listing types */ }
      }

      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },
};
