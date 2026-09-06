/* ===========================================================================
   ZIP → { zip, city, state } for the browser.

   A faithful port of backend/src/zip.js so V2 can never disagree with V1 about
   where a ZIP is. Same USPS 3-digit prefix table, same rule: STATE comes from
   the offline table (authoritative, never returns a foreign state) and the free
   zippopotam.us API only ever supplies the CITY. If the API disagrees about
   state, the table wins.

   Results are cached in localStorage, so a ZIP hits the network at most once
   per visitor. Every failure path returns state-only rather than nothing.
   =========================================================================== */
window.ZIP = (function () {
  'use strict';

  var PREFIX = [
    [5,5,'NY'],[10,27,'MA'],[28,29,'RI'],[30,38,'NH'],[39,49,'ME'],[50,59,'VT'],
    [60,69,'CT'],[70,89,'NJ'],[100,149,'NY'],[150,196,'PA'],[197,199,'DE'],
    [200,205,'DC'],[206,219,'MD'],[220,246,'VA'],[247,268,'WV'],[270,289,'NC'],
    [290,299,'SC'],[300,319,'GA'],[320,349,'FL'],[350,369,'AL'],[370,385,'TN'],
    [386,397,'MS'],[398,399,'GA'],[400,427,'KY'],[430,459,'OH'],[460,479,'IN'],
    [480,499,'MI'],[500,528,'IA'],[530,549,'WI'],[550,567,'MN'],[570,577,'SD'],
    [580,588,'ND'],[590,599,'MT'],[600,629,'IL'],[630,658,'MO'],[660,679,'KS'],
    [680,693,'NE'],[700,714,'LA'],[716,729,'AR'],[730,749,'OK'],[750,799,'TX'],
    [800,816,'CO'],[820,831,'WY'],[832,838,'ID'],[840,847,'UT'],[850,865,'AZ'],
    [870,884,'NM'],[885,885,'TX'],[889,898,'NV'],[900,961,'CA'],[967,968,'HI'],
    [970,979,'OR'],[980,994,'WA'],[995,999,'AK']
  ];

  var STATE_NAME = {
    AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',CO:'Colorado',
    CT:'Connecticut',DE:'Delaware',FL:'Florida',GA:'Georgia',HI:'Hawaii',ID:'Idaho',
    IL:'Illinois',IN:'Indiana',IA:'Iowa',KS:'Kansas',KY:'Kentucky',LA:'Louisiana',
    ME:'Maine',MD:'Maryland',MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',
    MS:'Mississippi',MO:'Missouri',MT:'Montana',NE:'Nebraska',NV:'Nevada',
    NH:'New Hampshire',NJ:'New Jersey',NM:'New Mexico',NY:'New York',NC:'North Carolina',
    ND:'North Dakota',OH:'Ohio',OK:'Oklahoma',OR:'Oregon',PA:'Pennsylvania',
    RI:'Rhode Island',SC:'South Carolina',SD:'South Dakota',TN:'Tennessee',TX:'Texas',
    UT:'Utah',VT:'Vermont',VA:'Virginia',WA:'Washington',WV:'West Virginia',
    WI:'Wisconsin',WY:'Wyoming',DC:'District of Columbia'
  };

  var CACHE_KEY = 'v2_zipcache';

  function normalize(v) { var m = String(v || '').match(/\b\d{5}\b/); return m ? m[0] : ''; }

  function stateFor(zip) {
    var p = parseInt(String(zip || '').slice(0, 3), 10);
    if (!isFinite(p)) return '';
    for (var i = 0; i < PREFIX.length; i++) {
      if (p >= PREFIX[i][0] && p <= PREFIX[i][1]) return PREFIX[i][2];
    }
    return '';
  }

  function readCache() { try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); } catch (e) { return {}; } }
  function writeCache(c) { try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch (e) {} }

  /* Synchronous, no network: cached entry if we have one, else state-only. */
  function known(v) {
    var zip = normalize(v); if (!zip) return null;
    var c = readCache();
    if (c[zip]) return c[zip];
    var st = stateFor(zip);
    return st ? { zip: zip, city: '', state: st, name: STATE_NAME[st] || '' } : null;
  }

  /* Async: fills in the city. Resolves to state-only on any failure — the
     network is never allowed to block or break the form. */
  function resolve(v) {
    var zip = normalize(v);
    if (!zip) return Promise.resolve(null);

    var cache = readCache();
    if (cache[zip] && cache[zip].city) return Promise.resolve(cache[zip]);

    var prefixState = stateFor(zip);
    var fallback = prefixState
      ? { zip: zip, city: '', state: prefixState, name: STATE_NAME[prefixState] || '' }
      : null;

    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 6000);

    return fetch('https://api.zippopotam.us/us/' + zip, ctrl ? { signal: ctrl.signal } : undefined)
      .then(function (r) { clearTimeout(timer); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        var place = j && j.places && j.places[0];
        var city  = place ? String(place['place name'] || '').trim() : '';
        // Prefix table wins on state, exactly as the backend does.
        var state = prefixState || (place ? String(place['state abbreviation'] || '').trim() : '');
        var info  = { zip: zip, city: city, state: state, name: STATE_NAME[state] || '' };
        if (info.state) { cache[zip] = info; writeCache(cache); }
        return info;
      })
      .catch(function () { clearTimeout(timer); return fallback; });
  }

  return { normalize: normalize, stateFor: stateFor, known: known, resolve: resolve, STATE_NAME: STATE_NAME };
})();
