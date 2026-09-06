/* ===========================================================================
   V2 behaviour. No dependencies, no build step.
   =========================================================================== */
(function () {
  'use strict';

  var CFG = window.SITE_CONFIG || {};
  var $  = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return [].slice.call((r || document).querySelectorAll(s)); };
  var IS_DEV = (CFG.env || 'development') !== 'production';

  function dig(p) { return p.split('.').reduce(function (o, k) { return (o && o[k] != null) ? o[k] : ''; }, CFG); }

  /* ---------------------------------------------------------------------
     Attribution — captured on landing, kept for the session, attached to
     every lead so a booked job can be traced back to the keyword that
     produced it.
     --------------------------------------------------------------------- */

  var ATTR_KEYS = ['gclid', 'gbraid', 'wbraid', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
  var ATTR = (function () {
    var qs = new URLSearchParams(location.search), s = {};
    try { s = JSON.parse(sessionStorage.getItem('v2_attr') || '{}'); } catch (e) { s = {}; }
    ATTR_KEYS.forEach(function (k) { var v = qs.get(k); if (v) s[k] = v; });
    if (!s.first_seen) s.first_seen = new Date().toISOString();
    if (!s.referrer)   s.referrer = document.referrer || '(direct)';
    try { sessionStorage.setItem('v2_attr', JSON.stringify(s)); } catch (e) {}
    return s;
  })();

  /* ---------------------------------------------------------------------
     Tracking

     Every event carries page_version so V1 and V2 can be separated in GA4
     without a second property.

     The Ads conversion is guarded TWICE — env must be 'production' AND
     adsConversionsEnabled must be true. A conversion fired from a review
     session would teach Smart Bidding from fake data, and that damage
     outlives the test, so the default is off and the guard is not one flag.
     --------------------------------------------------------------------- */

  var T = CFG.tracking || {};

  function track(name, params) {
    var p = Object.assign({ page_version: CFG.pageVersion || 'v2', env: CFG.env || 'development' }, params || {});
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push(Object.assign({ event: name }, p));
    if (typeof window.gtag === 'function') window.gtag('event', name, p);
    if (IS_DEV) console.debug('[v2 event]', name, p);
  }

  function adsConversion(label) {
    if (IS_DEV) { console.debug('[v2] Ads conversion SUPPRESSED (env=development):', label); return; }
    if (!T.adsConversionsEnabled) { console.debug('[v2] Ads conversion suppressed (adsConversionsEnabled=false)'); return; }
    if (!T.googleAdsId || !T.googleAdsConversionLabel) return;
    if (typeof window.gtag !== 'function') return;
    window.gtag('event', 'conversion', { send_to: T.googleAdsId + '/' + T.googleAdsConversionLabel });
  }

  /* Once a visitor converts by ANY route the recovery popup is retired for
     good — chasing someone who already called is the fastest way to look
     careless. */
  function markConverted(how) {
    try { sessionStorage.setItem('v2_converted', how); } catch (e) {}
  }
  function hasConverted() {
    try { return !!sessionStorage.getItem('v2_converted'); } catch (e) { return false; }
  }

  /* ---------------------------------------------------------------------
     Config binding
     --------------------------------------------------------------------- */

  function smsHref() {
    var n = dig('business.smsNumber') || dig('business.phoneHref');
    // Same shape as backend/src/notify.js smsLink() — '?&body=' is the form
    // that survives both iOS and Android SMS handlers.
    return 'sms:' + n + '?&body=' + encodeURIComponent(dig('business.smsPrefill'));
  }

  function bindConfig() {
    $$('[data-cfg]').forEach(function (el) { var v = dig(el.getAttribute('data-cfg')); if (v !== '') el.textContent = v; });
    $$('[data-cfg-tel]').forEach(function (el) { el.setAttribute('href', 'tel:' + dig('business.phoneHref')); });
    $$('[data-cfg-sms]').forEach(function (el) { el.setAttribute('href', smsHref()); });

    // Services come from the real list, so the form can never drift from it.
    var sel = $('#service');
    if (sel) (CFG.services || []).forEach(function (s) {
      var o = document.createElement('option'); o.value = s; o.textContent = s; sel.appendChild(o);
    });

    // The $25 line appears or vanishes everywhere from one flag.
    var d = (CFG.offer || {}).photoDiscount || {};
    $$('[data-discount]').forEach(function (el) {
      if (d.active) { el.textContent = 'Send a Photo + Save ' + d.amount; el.hidden = false; }
      else el.hidden = true;
    });

    var y = $('[data-year]'); if (y) y.textContent = new Date().getFullYear();
    if (IS_DEV) { var bar = $('.envbar'); if (bar) bar.hidden = false; }
  }

  /* ---------------------------------------------------------------------
     Hero video

     Autoplays muted (the only way browsers allow it) and loops. Sound is
     opt-in via an obvious button — but the button only appears once the clip
     actually carries the sales voiceover. Unmuting into raw on-site audio
     costs the lead, so `video.hasVoiceover` gates it.
     --------------------------------------------------------------------- */

  function wireVideo() {
    var v = $('#heroVideo'); if (!v) return;
    var btn = $('#soundBtn');
    var ph  = $('#videoPlaceholder');
    var started = false;

    // Point the sources at whatever config names, then load once.
    var mp4 = $('#heroSrcMp4'), webm = $('#heroSrcWebm');
    var srcMp4 = dig('video.src'), srcWebm = dig('video.webm'), poster = dig('video.poster');
    if (mp4 && srcMp4) mp4.src = srcMp4;
    if (webm) { if (srcWebm) webm.src = srcWebm; else webm.remove(); }
    if (poster) v.setAttribute('poster', poster);
    v.load();

    // If the real footage is not in place the poster would show as a broken
    // black box, which looks worse than an honest placeholder. Swap to the
    // instruction panel instead and hide the sound control with it.
    function fallback() {
      if (ph) ph.hidden = false;
      v.hidden = true;
      if (btn) btn.hidden = true;
    }
    v.addEventListener('error', fallback, true);
    $$('source', v).forEach(function (s) { s.addEventListener('error', function () {
      // Only give up once no source can play at all.
      if (v.networkState === 3 /* NETWORK_NO_SOURCE */) fallback();
    }); });
    // Belt and braces: if nothing is playable shortly after load, fall back.
    setTimeout(function () { if (v.readyState === 0 && !v.hidden) fallback(); }, 2500);

    v.addEventListener('playing', function () {
      if (started) return; started = true;
      track('video_started', { source: 'hero' });
    });

    var stages = dig('video.stages');
    if (stages && stages.length) {
      $$('.vid__stage').forEach(function (el, i) { if (stages[i]) el.textContent = stages[i]; });
    }

    if (!btn) return;
    if (!dig('video.hasVoiceover')) { btn.hidden = true; return; }
    btn.hidden = false;

    btn.addEventListener('click', function () {
      v.muted = !v.muted;
      if (!v.muted) {
        v.volume = 1;
        v.play().catch(function () {});
        btn.querySelector('.lbl').textContent = 'Sound on';
        track('video_sound_enabled', { source: 'hero' });
      } else {
        btn.querySelector('.lbl').textContent = 'Tap for sound';
      }
      btn.setAttribute('aria-pressed', String(!v.muted));
    });
  }

  /* ---------------------------------------------------------------------
     Quote form — one screen, four fields, no ZIP gate.
     --------------------------------------------------------------------- */

  function wireForm() {
    var form = $('#quoteForm'); if (!form) return;
    var card = $('#quoteCard');
    var started = false, sent = false;

    function err(el, msg) {
      var f = el.closest('.f'); if (!f) return;
      f.classList.add('err'); var e = $('.f__err', f); if (e) e.textContent = msg;
      el.setAttribute('aria-invalid', 'true');
    }
    function clear(el) {
      var f = el.closest('.f'); if (!f) return;
      f.classList.remove('err'); el.removeAttribute('aria-invalid');
    }

    function valid() {
      var ok = true;
      var name = $('#name'), zip = $('#zip'), phone = $('#phone'), svc = $('#service');
      [name, zip, phone, svc].forEach(clear);
      if (!name.value.trim())                        { err(name, 'Please tell us your name.'); ok = false; }
      if (!/^\d{5}$/.test(zip.value.trim()))         { err(zip, 'Enter a 5-digit ZIP code.'); ok = false; }
      if (phone.value.replace(/\D/g, '').length < 10){ err(phone, 'Enter a 10-digit phone number.'); ok = false; }
      if (!svc.value)                                { err(svc, 'Choose a service.'); ok = false; }
      return ok;
    }

    // free_quote_started fires on first real interaction, so the funnel
    // separates "saw the form" from "began filling it in".
    $$('input, select', form).forEach(function (el) {
      el.addEventListener('input', function () {
        clear(el);
        if (!started) { started = true; track('free_quote_started', { location: 'hero' }); }
      });
    });

    var zip = $('#zip');
    if (zip) zip.addEventListener('input', function () { zip.value = zip.value.replace(/\D/g, '').slice(0, 5); });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (sent || !valid()) return;

      var payload = {
        name:    $('#name').value.trim(),
        zip:     $('#zip').value.trim(),
        phone:   $('#phone').value.trim(),
        service: $('#service').value,
        source:  'landing_v2',
        page_version: CFG.pageVersion || 'v2',
        env:     CFG.env,
        page_url: location.href,
        submitted_at: new Date().toISOString()
      };
      Object.keys(ATTR).forEach(function (k) { payload[k] = ATTR[k]; });

      var done = function () {
        sent = true;
        markConverted('form');
        track('free_quote_submitted', { service: payload.service, zip: payload.zip });
        track('phone_captured', { source: 'quote_form' });
        adsConversion('lead');
        if (card) {
          card.innerHTML =
            '<div class="card__bd" style="text-align:center;padding:34px 24px">' +
            '<div style="font-size:2.6rem;line-height:1">✅</div>' +
            '<h3 style="margin:12px 0 8px">Thank you — we have your details.</h3>' +
            '<p style="color:var(--ink-2)">We will call you shortly with your free quote. ' +
            'Nothing to pay, and no obligation.</p>' +
            '<a class="btn btn--cta btn--lg" style="margin-top:20px" href="tel:' + dig('business.phoneHref') + '">' +
            'Or call us now</a></div>';
        }
      };

      var ep = dig('integrations.leadEndpoint');
      if (!ep) { console.warn('[v2] Demo mode — no integrations.leadEndpoint. Lead NOT saved:', payload); done(); return; }

      var btn = $('[data-submit]', form);
      if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }

      fetch(ep, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); done(); })
        .catch(function (e2) {
          console.error('[v2] Lead save failed:', e2);
          if (btn) { btn.disabled = false; btn.textContent = 'GET MY FREE QUOTE'; }
          var box = $('[data-submit-error]', form);
          if (box) { box.textContent = 'Could not send that. Please call ' + dig('business.phone') + ' and we will take your details.'; box.style.display = 'block'; }
          track('form_submit_error', { message: String(e2.message || e2) });
        });
    });
  }

  /* ---------------------------------------------------------------------
     Call and text
     --------------------------------------------------------------------- */

  function wireCallText() {
    $$('a[href^="tel:"]').forEach(function (a) {
      a.addEventListener('click', function () {
        markConverted('call');
        track('call_clicked', { location: a.getAttribute('data-loc') || 'unknown' });
        adsConversion('call');
      });
    });
    $$('a[href^="sms:"], [data-cfg-sms]').forEach(function (a) {
      a.addEventListener('click', function () {
        markConverted('sms');
        track('sms_quote_clicked', { location: a.getAttribute('data-loc') || 'unknown' });
        adsConversion('sms');
      });
    });
  }

  /* ---------------------------------------------------------------------
     Chat — Messenger-familiar shell in front of holi.

     Answers the question first, asks for details later. There is no opening
     ZIP question: the visitor came with a worry (will it peel? what does it
     cost?) and being interrogated before it is addressed is why people close
     these widgets.
     --------------------------------------------------------------------- */

  function wireChat() {
    var btn = $('#chatBtn'), panel = $('#chatPanel'), log = $('#chatLog'),
        form = $('#chatForm'), input = $('#chatInput'), chips = $('#chatChips');
    if (!btn || !panel) return;
    var opened = false, engaged = false;

    function add(text, who) {
      var d = document.createElement('div');
      d.className = 'msg msg--' + who; d.textContent = text;
      log.appendChild(d); log.scrollTop = log.scrollHeight;
      return d;
    }
    function typing() {
      var d = document.createElement('div');
      d.className = 'typing'; d.innerHTML = '<i></i><i></i><i></i>';
      log.appendChild(d); log.scrollTop = log.scrollHeight;
      return d;
    }

    function open() {
      panel.classList.add('on');
      btn.setAttribute('aria-expanded', 'true');
      if (!opened) {
        opened = true;
        track('chat_opened', {});
        add('Hi 👋 How can I help you?', 'bot');
      }
      setTimeout(function () { input && input.focus(); }, 120);
    }
    function close() { panel.classList.remove('on'); btn.setAttribute('aria-expanded', 'false'); }

    btn.addEventListener('click', function () { panel.classList.contains('on') ? close() : open(); });
    var x = $('#chatClose'); if (x) x.addEventListener('click', close);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && panel.classList.contains('on')) close(); });

    function send(text) {
      if (!text.trim()) return;
      add(text, 'user');
      if (!engaged) { engaged = true; track('chat_started', { first_message: text.slice(0, 60) }); }
      if (chips) chips.hidden = true;

      var t = typing();
      var ep = dig('integrations.chatEndpoint');

      if (!ep) {
        setTimeout(function () {
          t.remove();
          add('(Demo mode — no chatEndpoint configured yet, so I am not connected to the real assistant. ' +
              'Once holi\'s endpoint is set in config.js this reply comes from your existing assistant.)', 'bot');
        }, 700);
        return;
      }

      fetch(ep, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          source:  'landing_v2',
          page_version: CFG.pageVersion || 'v2',
          session_id: sessionId(),
          attribution: ATTR
        })
      })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          t.remove();
          add(d.reply || d.message || d.text || 'Sorry — I did not catch that. Could you say it another way?', 'bot');
        })
        .catch(function (e) {
          t.remove();
          console.error('[v2] chat failed:', e);
          add('Sorry, I am having trouble connecting. Please call ' + dig('business.phone') + ' and we will help right away.', 'bot');
        });
    }

    if (form) form.addEventListener('submit', function (e) {
      e.preventDefault(); var v = input.value; input.value = ''; send(v);
    });
    $$('.chip', chips).forEach(function (c) {
      c.addEventListener('click', function () { send(c.textContent.trim()); });
    });

    // Let any button on the page open the chat.
    $$('[data-open-chat]').forEach(function (b) {
      b.addEventListener('click', function (e) { e.preventDefault(); open(); });
    });
  }

  function sessionId() {
    var k = 'v2_sid', v;
    try { v = sessionStorage.getItem(k); } catch (e) {}
    if (!v) {
      v = 'v2-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
      try { sessionStorage.setItem(k, v); } catch (e) {}
    }
    return v;
  }

  /* ---------------------------------------------------------------------
     Section visibility events + calendar bridge
     --------------------------------------------------------------------- */

  function wireVisibility() {
    var map = [
      ['#work',       'real_work_viewed'],
      ['#calendar',   'calendar_viewed'],
      ['#durability', 'durability_section_viewed'],
      ['#warranty',   'warranty_viewed']
    ];
    if (!('IntersectionObserver' in window)) return;
    map.forEach(function (pair) {
      var el = $(pair[0]); if (!el) return;
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting) { track(pair[1], {}); io.disconnect(); }
        });
      }, { threshold: 0.3 });
      io.observe(el);
    });
  }

  /* The existing calendar is embedded, not rebuilt. If it posts messages out
     we relay them as V2 events; if it does not, calendar_viewed still fires
     and the deeper booking events simply stay silent rather than being faked. */
  function wireCalendar() {
    var url = dig('integrations.calendarUrl');
    var frame = $('#calFrame'), ph = $('#calPlaceholder');
    if (url && frame) {
      frame.src = url;
      frame.height = dig('integrations.calendarHeight') || 760;
      frame.hidden = false;
      if (ph) ph.hidden = true;
    }
    window.addEventListener('message', function (e) {
      var d = e.data; if (!d || typeof d !== 'object') return;
      var known = ['date_selected', 'time_selected', 'booking_started', 'booking_completed'];
      if (known.indexOf(d.type) === -1) return;
      track(d.type, d.payload || {});
      if (d.type === 'booking_completed') { markConverted('booking'); adsConversion('booking'); }
    });
  }

  /* ---------------------------------------------------------------------
     Recovery popup — late, quiet, and never shown to someone who already
     converted.
     --------------------------------------------------------------------- */

  function wirePopup() {
    var cfg = CFG.popup || {}; if (!cfg.enabled) return;
    var pop = $('#pop'); if (!pop) return;
    var scrolled = 0, shown = false;

    window.addEventListener('scroll', function () {
      var h = document.documentElement;
      scrolled = Math.max(scrolled, Math.round((h.scrollTop / (h.scrollHeight - h.clientHeight || 1)) * 100));
    }, { passive: true });

    setTimeout(function () {
      if (shown || hasConverted()) return;
      if (scrolled < (cfg.minScrollPct || 0)) return;
      shown = true; pop.classList.add('on');
      track('recovery_popup_shown', {});
      var i = $('#popPhone'); if (i) i.focus();
    }, cfg.delayMs || 75000);

    function close() { pop.classList.remove('on'); track('recovery_popup_dismissed', {}); }
    $('#popX').addEventListener('click', close);
    pop.addEventListener('click', function (e) { if (e.target === pop) close(); });

    $('#popForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var v = $('#popPhone').value.trim();
      if (v.replace(/\D/g, '').length < 10) { $('#popPhone').style.borderColor = 'var(--err)'; return; }
      markConverted('popup');
      track('phone_captured', { source: 'recovery_popup' });
      adsConversion('lead');

      var payload = Object.assign({
        phone: v, source: 'landing_v2_popup',
        page_version: CFG.pageVersion || 'v2', env: CFG.env,
        submitted_at: new Date().toISOString()
      }, ATTR);
      var ep = dig('integrations.leadEndpoint');
      if (ep) fetch(ep, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).catch(function () {});
      else console.warn('[v2] Demo mode — popup lead NOT saved:', payload);

      $('.pop__card').innerHTML = '<div style="padding:12px 0"><div style="font-size:2.4rem">✅</div>' +
        '<div class="pop__t" style="margin-top:10px">Got it.</div>' +
        '<p class="pop__s">We will text your free quote shortly.</p></div>';
      setTimeout(function () { pop.classList.remove('on'); }, 2400);
    });
  }


  /* ---------------------------------------------------------------------
     Warranty lockup

     The warranty is never rendered on its own. Every [data-warranty] element
     gets BOTH halves from config, so the pairing cannot drift and the 2-year
     written warranty can never be misread as an 8-year guarantee. They are
     different promises and the page always shows them as a pair.
     --------------------------------------------------------------------- */

  function warrantyHTML() {
    var w = dig('offer.warrantyLabel')   || '2-Year Written Warranty';
    var d = dig('offer.durabilityLabel') || '8+ Years Durability';
    return '<span class="wd__w">' + w + '</span>' +
           '<span class="wd__sep" aria-hidden="true">•</span>' +
           '<span class="wd__d">' + d + '</span>';
  }

  function renderWarranty() {
    $$('[data-warranty]').forEach(function (el) {
      el.classList.add('wd');
      if (el.hasAttribute('data-warranty-badge')) el.classList.add('wd--badge');
      if (el.hasAttribute('data-warranty-dark'))  el.classList.add('wd--on-dark');
      el.innerHTML = warrantyHTML();
    });
  }

  /* ---------------------------------------------------------------------
     Coverage / city detection

     Uses the same resolver rule as the backend: state from the offline USPS
     prefix table, city from the API. It exists only so the page can say the
     visitor's own town back to them — it never gates, rejects or hides
     anything. No ZIP is turned away.
     --------------------------------------------------------------------- */

  function wireCoverage() {
    var box = $('#coverage'); if (!box) return;
    var cov = CFG.coverage || {};
    var zip = $('#zip');

    function setAllZips() {
      box.className = 'cover';
      box.innerHTML = tick() + '<span>' + (cov.allZipsLine || 'We serve all ZIP codes') + '</span>';
    }

    /* City when the lookup gave us one, state otherwise — two separate
       strings, so a failed city lookup never renders "New Jersey, NJ". */
    function show(info) {
      var line = info.city
        ? (cov.cityLine  || 'Serving {city}, {state}')
        : (cov.stateLine || 'Serving all of {stateName}');
      box.className = 'cover cover--city';
      box.innerHTML = tick() + '<span>' + line
        .replace('{city}', info.city || '')
        .replace('{state}', info.state || '')
        .replace('{stateName}', info.name || info.state || '') + '</span>';
    }
    function tick() {
      return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
             'stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
             '<path d="M20 6 9 17l-5-5"/></svg>';
    }
    setAllZips();
    if (!zip || !window.ZIP) return;

    var last = '';
    zip.addEventListener('input', function () {
      var v = zip.value.trim();
      if (v.length < 5) { if (last) { last = ''; setAllZips(); } return; }
      if (v === last) return;
      last = v;

      // Instant, offline: the state is known before any network call returns,
      // so the visitor sees a real answer immediately either way.
      var k = window.ZIP.known(v);
      if (k && k.state) show(k);

      window.ZIP.resolve(v).then(function (info) {
        if (zip.value.trim() !== v) return;      // they kept typing
        if (!info || !info.state) { setAllZips(); return; }
        show(info);
        track('city_detected', { zip: info.zip, city: info.city, state: info.state });
      });
    });
  }

  /* ---------------------------------------------------------------------
     Trust + reviews
     --------------------------------------------------------------------- */

  function renderTrust() {
    var host = $('#trustGrid'); if (!host) return;
    (CFG.trust || []).forEach(function (t) {
      var d = document.createElement('div');
      d.className = 'tcard';
      // A trust card can carry the warranty lockup rather than plain text.
      var body = (t.d === 'WARRANTY_LOCKUP')
        ? '<span class="wd" style="justify-content:flex-start">' + warrantyHTML() + '</span>'
        : t.d;
      d.innerHTML =
        '<span class="tcard__ico" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" ' +
        'fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M20 6 9 17l-5-5"/></svg></span>' +
        '<span><span class="tcard__t">' + t.t + '</span><span class="tcard__d">' + body + '</span></span>';
      host.appendChild(d);
    });
  }

  function renderReviews() {
    var host = $('#revGrid'); if (!host) return;
    (CFG.reviews || []).forEach(function (r) {
      var d = document.createElement('div');
      var empty = !r.text;
      d.className = 'rev' + (empty ? ' rev--empty' : '');
      var stars = '★★★★★'.slice(0, Math.max(0, Math.min(5, r.stars || 5)));
      d.innerHTML =
        '<div class="rev__stars" aria-label="' + (r.stars || 5) + ' out of 5">' + stars + '</div>' +
        '<p class="rev__text">' + (r.text ||
          'Paste a genuine review from your Google profile here. Real reviews only — ' +
          'invented testimonials break FTC rules and put the Ads account at risk.') + '</p>' +
        '<div class="rev__by"><span class="rev__av">' + ((r.name || '?').charAt(0).toUpperCase()) + '</span>' +
        '<span><span class="rev__who">' + (r.name || 'Customer name') + '</span><br>' +
        '<span class="rev__where">' + (r.city || 'Town') + (r.source ? ' · ' + r.source : '') + '</span></span></div>';
      host.appendChild(d);
    });
  }

  function renderBookingMedia() {
    var host = $('#bookMedia'); if (!host) return;
    ((CFG.booking || {}).media || []).forEach(function (m, i) {
      var d = document.createElement('div');
      d.className = 'book-media__item';
      var inner = (m.type === 'video')
        ? '<video src="' + m.src + '" muted loop playsinline autoplay preload="metadata"></video>'
        : '<img src="' + m.src + '" alt="' + (m.cap || '') + '" loading="lazy">';
      d.innerHTML = inner + '<div class="book-media__cap">' + (m.cap || '') + '</div>';
      host.appendChild(d);

      // Swap to an honest placeholder if the real asset is not in place yet.
      var el = d.querySelector('img, video');
      el.addEventListener('error', function () {
        var ph = document.createElement('div');
        ph.className = 'book-media__ph';
        ph.innerHTML = '<span><b>Media ' + (i + 1) + '</b>' + m.src + '</span>';
        el.replaceWith(ph);
      }, true);
    });
  }

  /* --------------------------------------------------------------------- */

  document.addEventListener('DOMContentLoaded', function () {
    bindConfig();
    renderWarranty();
    renderTrust();
    renderReviews();
    renderBookingMedia();
    wireCoverage();
    wireVideo();
    wireForm();
    wireCallText();
    wireChat();
    wireVisibility();
    wireCalendar();
    wirePopup();

    $$('[data-scroll]').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.preventDefault();
        var t = $(b.getAttribute('data-scroll')); if (!t) return;
        t.scrollIntoView({ behavior: 'smooth', block: 'start' });
        track('cta_click', { target: b.getAttribute('data-scroll'), location: b.getAttribute('data-loc') || '' });
      });
    });

    track('page_view_v2', { env: CFG.env });
    if (IS_DEV) console.info('%c[v2] DEVELOPMENT — Google Ads conversions are suppressed.', 'color:#C4560A;font-weight:bold');
  });
})();
