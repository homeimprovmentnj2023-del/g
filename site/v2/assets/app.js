/* =========================================================================
   v2 landing page behaviour
   No dependencies and no build step — this file runs as-is.
   ========================================================================= */
(function () {
  'use strict';

  var CFG = window.SITE_CONFIG || {};
  var $  = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  /* ---------------------------------------------------------------------
     Config binding — fills [data-cfg] text and [data-cfg-tel] links so the
     phone number and licence number live in exactly one place.
     --------------------------------------------------------------------- */

  function dig(path) {
    return path.split('.').reduce(function (o, k) {
      return (o && o[k] !== undefined && o[k] !== null) ? o[k] : '';
    }, CFG);
  }

  function bindConfig() {
    $$('[data-cfg]').forEach(function (el) {
      var v = dig(el.getAttribute('data-cfg'));
      if (v !== '') el.textContent = v;
    });
    $$('[data-cfg-tel]').forEach(function (el) {
      var n = dig('business.phoneHref');
      if (n) el.setAttribute('href', 'tel:' + n);
    });
    var y = $('[data-year]');
    if (y) y.textContent = new Date().getFullYear();
  }

  /* ---------------------------------------------------------------------
     Tracking
     Every step advance is reported separately. That is what turns the form
     into a diagnostic: if step 2 → 3 is where people leave, you know the
     project-detail question is the problem rather than guessing at the page.
     --------------------------------------------------------------------- */

  var T = CFG.tracking || {};

  function track(name, params) {
    var payload = params || {};
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push(Object.assign({ event: name }, payload));
    if (typeof window.gtag === 'function') window.gtag('event', name, payload);
  }

  function trackConversion() {
    if (typeof window.gtag !== 'function') return;
    if (!T.googleAdsId || !T.googleAdsConversionLabel) return;
    window.gtag('event', 'conversion', {
      send_to: T.googleAdsId + '/' + T.googleAdsConversionLabel
    });
  }

  /* ---------------------------------------------------------------------
     Click attribution
     gclid and the UTM set are captured on landing, kept for the session, and
     submitted with the lead. Without this you cannot tie a closed job back to
     the keyword that produced it, which is the whole point of running Ads.
     --------------------------------------------------------------------- */

  var ATTR_KEYS = ['gclid', 'gbraid', 'wbraid', 'utm_source', 'utm_medium',
                   'utm_campaign', 'utm_term', 'utm_content'];
  var ATTR_STORE = 'lp_attr_v2';

  function captureAttribution() {
    var qs = new URLSearchParams(window.location.search);
    var stored = {};
    try { stored = JSON.parse(sessionStorage.getItem(ATTR_STORE) || '{}'); } catch (e) { stored = {}; }

    ATTR_KEYS.forEach(function (k) {
      var v = qs.get(k);
      if (v) stored[k] = v;
    });
    if (!stored.landing_page) stored.landing_page = window.location.pathname;
    if (!stored.referrer)     stored.referrer = document.referrer || '(direct)';
    if (!stored.first_seen)   stored.first_seen = new Date().toISOString();

    try { sessionStorage.setItem(ATTR_STORE, JSON.stringify(stored)); } catch (e) { /* private mode */ }
    return stored;
  }

  var ATTRIBUTION = captureAttribution();

  /* ---------------------------------------------------------------------
     Phone clicks
     Counted as conversions because in home services the phone usually
     outperforms the form, and an untracked call looks like a wasted click.
     --------------------------------------------------------------------- */

  function wirePhones() {
    if (T.trackPhoneClicks === false) return;
    $$('a[href^="tel:"]').forEach(function (a) {
      a.addEventListener('click', function () {
        track('phone_click', { location: a.getAttribute('data-loc') || 'unknown' });
        trackConversion();
      });
    });
  }

  /* ---------------------------------------------------------------------
     Multi-step form
     --------------------------------------------------------------------- */

  function QuoteForm(root) {
    if (!root) return;

    var form   = $('form', root);
    var steps  = $$('.qf__step', root);
    var bars   = $$('.qf__bar i', root);
    var idx    = 0;
    var sent   = false;
    var DRAFT  = 'lp_draft_v2';

    /* -- validation -------------------------------------------------- */

    function fieldOf(el) { return el.closest('.f'); }

    function setErr(el, msg) {
      var f = fieldOf(el);
      if (!f) return;
      f.classList.add('err');
      var e = $('.f__err', f);
      if (e) e.textContent = msg;
      el.setAttribute('aria-invalid', 'true');
    }

    function clearErr(el) {
      var f = fieldOf(el);
      if (!f) return;
      f.classList.remove('err');
      el.removeAttribute('aria-invalid');
    }

    function validZip(v)   { return /^\d{5}$/.test(v.trim()); }
    function validEmail(v) { return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(v.trim()); }
    function validPhone(v) { return v.replace(/\D/g, '').length >= 10; }

    // Soft area check: an out-of-area ZIP warns but never blocks. Rejecting a
    // paid click outright is worse than a lead you decline by phone.
    function checkArea(v) {
      var area = CFG.serviceArea || {};
      var pre  = area.zipPrefixes || [];
      var note = $('#zipNote');
      if (!note) return;
      var out = pre.length && !pre.some(function (p) { return v.indexOf(p) === 0; });
      note.textContent = out ? (area.outOfAreaMessage || '') : '';
      note.style.display = out ? 'block' : 'none';
      if (out) track('zip_out_of_area', { zip: v });
    }

    function validateStep(i) {
      var scope = steps[i];
      var ok = true;

      $$('input, textarea', scope).forEach(function (el) {
        if (el.type === 'radio' || el.type === 'hidden') return;
        var v = el.value.trim();
        clearErr(el);

        if (el.hasAttribute('required') && !v) {
          setErr(el, 'This one is required.'); ok = false; return;
        }
        if (!v) return;
        if (el.dataset.validate === 'zip'   && !validZip(v))   { setErr(el, 'Enter a 5-digit ZIP code.'); ok = false; }
        if (el.dataset.validate === 'email' && !validEmail(v)) { setErr(el, 'Check that email address.'); ok = false; }
        if (el.dataset.validate === 'phone' && !validPhone(v)) { setErr(el, 'Enter a 10-digit phone number.'); ok = false; }
      });

      // Radio groups marked required must have a selection.
      $$('[data-required-group]', scope).forEach(function (g) {
        var name = g.getAttribute('data-required-group');
        if (!$('input[name="' + name + '"]:checked', scope)) {
          ok = false;
          var e = $('.f__err', g);
          if (e) { e.textContent = 'Pick one to continue.'; e.style.display = 'block'; }
        } else {
          var e2 = $('.f__err', g);
          if (e2) e2.style.display = 'none';
        }
      });

      return ok;
    }

    /* -- navigation --------------------------------------------------- */

    function show(i, opts) {
      steps.forEach(function (s, n) { s.classList.toggle('on', n === i); });
      bars.forEach(function (b, n) { b.classList.toggle('on', n <= i); });
      idx = i;

      if (!opts || !opts.silent) {
        var focusable = $('input:not([type=hidden]), textarea', steps[i]);
        if (focusable) focusable.focus({ preventScroll: true });
      }
      saveDraft();
    }

    function next() {
      if (!validateStep(idx)) {
        track('form_step_error', { step: idx + 1 });
        return;
      }
      if (idx < steps.length - 1) {
        show(idx + 1);
        track('form_step', { step: idx + 2, variant: (CFG.form || {}).variant || 'v2' });
      }
    }

    function back() { if (idx > 0) show(idx - 1); }

    /* -- draft persistence -------------------------------------------- */

    function saveDraft() {
      try {
        var d = { step: idx, values: {} };
        $$('input, textarea', form).forEach(function (el) {
          if (el.type === 'hidden') return;
          if (el.type === 'radio') { if (el.checked) d.values[el.name] = el.value; }
          else if (el.value) d.values[el.name] = el.value;
        });
        localStorage.setItem(DRAFT, JSON.stringify(d));
      } catch (e) { /* storage unavailable — the form still works */ }
    }

    function loadDraft() {
      var d;
      try { d = JSON.parse(localStorage.getItem(DRAFT) || 'null'); } catch (e) { return; }
      if (!d || !d.values) return;
      Object.keys(d.values).forEach(function (k) {
        var els = $$('[name="' + k + '"]', form);
        els.forEach(function (el) {
          if (el.type === 'radio') { if (el.value === d.values[k]) el.checked = true; }
          else el.value = d.values[k];
        });
      });
      if (d.step > 0 && d.step < steps.length) show(d.step, { silent: true });
    }

    function clearDraft() { try { localStorage.removeItem(DRAFT); } catch (e) {} }

    /* -- submit -------------------------------------------------------- */

    function collect() {
      var out = {};
      $$('input, textarea', form).forEach(function (el) {
        if (!el.name) return;
        if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; }
        else out[el.name] = el.value.trim();
      });
      out.variant       = (CFG.form || {}).variant || 'v2';
      out.submitted_at  = new Date().toISOString();
      out.page_url      = window.location.href;
      Object.keys(ATTRIBUTION).forEach(function (k) { out[k] = ATTRIBUTION[k]; });
      return out;
    }

    function succeed(payload) {
      sent = true;
      root.classList.remove('busy');
      root.classList.add('done');
      clearDraft();
      track('generate_lead', {
        variant: payload.variant,
        service: payload.service || '',
        zip:     payload.zip || ''
      });
      trackConversion();
      root.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    function submit(e) {
      e.preventDefault();
      if (sent) return;
      if (!validateStep(idx)) return;

      var payload  = collect();
      var endpoint = (CFG.form || {}).endpoint;

      // No endpoint configured — validate and show the success state, but be
      // explicit that nothing was delivered anywhere.
      if (!endpoint) {
        console.warn('[v2] Demo mode: no form.endpoint set in config.js. Lead was NOT sent.', payload);
        succeed(payload);
        return;
      }

      root.classList.add('busy');
      var btn = $('[data-submit]', form);
      var label = btn ? btn.textContent : '';
      if (btn) { btn.textContent = 'Sending…'; btn.disabled = true; }

      fetch(endpoint, {
        method:  (CFG.form || {}).method || 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body:    JSON.stringify(payload)
      })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          succeed(payload);
        })
        .catch(function (err) {
          console.error('[v2] Lead submission failed:', err);
          root.classList.remove('busy');
          if (btn) { btn.textContent = label; btn.disabled = false; }
          var box = $('[data-submit-error]', form);
          if (box) {
            box.textContent = 'Something went wrong sending that. Please call us on '
              + (CFG.business || {}).phone + ' and we will take the details directly.';
            box.style.display = 'block';
          }
          track('form_submit_error', { message: String(err && err.message || err) });
        });
    }

    /* -- wiring -------------------------------------------------------- */

    $$('[data-next]', root).forEach(function (b) { b.addEventListener('click', next); });
    $$('[data-back]', root).forEach(function (b) { b.addEventListener('click', back); });
    form.addEventListener('submit', submit);

    // Enter advances rather than submitting a half-finished form.
    form.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      if (e.target.tagName === 'TEXTAREA') return;
      if (idx < steps.length - 1) { e.preventDefault(); next(); }
    });

    // Picking a service card moves straight on — one tap, not tap-then-next.
    $$('input[name="service"]', root).forEach(function (r) {
      r.addEventListener('change', function () { setTimeout(next, 180); });
    });

    var zip = $('[data-validate="zip"]', root);
    if (zip) {
      zip.addEventListener('input', function () {
        zip.value = zip.value.replace(/\D/g, '').slice(0, 5);
        if (zip.value.length === 5) { clearErr(zip); checkArea(zip.value); }
      });
    }

    $$('input, textarea', form).forEach(function (el) {
      el.addEventListener('input',  function () { clearErr(el); });
      el.addEventListener('change', saveDraft);
    });

    // Demo-mode banner, so a console log is never mistaken for a real lead.
    if (!(CFG.form || {}).endpoint) {
      var d = document.createElement('div');
      d.className = 'qf__demo';
      d.textContent = 'Demo mode — set form.endpoint in config.js before running ads to this page.';
      root.insertBefore(d, root.firstChild);
    }

    loadDraft();
    track('form_view', { variant: (CFG.form || {}).variant || 'v2' });
  }

  /* ---------------------------------------------------------------------
     Scroll-depth — tells you whether people are reading past the hero.
     --------------------------------------------------------------------- */

  function wireScrollDepth() {
    var hits = {};
    var marks = [25, 50, 75, 90];
    window.addEventListener('scroll', function () {
      var h = document.documentElement;
      var pct = Math.round((h.scrollTop / (h.scrollHeight - h.clientHeight)) * 100);
      marks.forEach(function (m) {
        if (pct >= m && !hits[m]) { hits[m] = true; track('scroll_depth', { percent: m }); }
      });
    }, { passive: true });
  }

  /* --------------------------------------------------------------------- */

  document.addEventListener('DOMContentLoaded', function () {
    bindConfig();
    wirePhones();
    wireScrollDepth();
    QuoteForm($('#quote'));

    $$('[data-scroll-to]').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.preventDefault();
        var t = $(b.getAttribute('data-scroll-to'));
        if (!t) return;
        t.scrollIntoView({ behavior: 'smooth', block: 'start' });
        var f = $('input:not([type=hidden])', t);
        if (f) setTimeout(function () { f.focus({ preventScroll: true }); }, 420);
        track('cta_click', { location: b.getAttribute('data-loc') || 'unknown' });
      });
    });
  });
})();
