/* ===========================================================================
   V2 (development) — Pristine bathtub refinishing landing page
   PRODUCTION V1 IS NOT TOUCHED BY ANYTHING IN THIS FOLDER.

   Edit this file only. Every integration seam is here so the page never has a
   hard-coded phone number, endpoint or asset path.
   =========================================================================== */

window.SITE_CONFIG = {

  /* -- 1. environment ---------------------------------------------------
     THE MOST IMPORTANT FLAG ON THE PAGE.

     While `env` is 'development' the page will NOT fire a Google Ads
     conversion, no matter what else is configured. Test submissions during
     review must never reach Smart Bidding — a handful of fake conversions
     teaches the bidding model the wrong thing and the damage outlives the
     test. GA4 still receives everything, tagged as v2, so the page stays
     measurable while it is being reviewed.

     Flip to 'production' only when V2 is approved and actually taking ads. */
  env: 'development',          // 'development' | 'production'
  pageVersion: 'v2',           // stamped on every event and every lead

  business: {
    name:         'REPLACE — business name',
    // Existing production number. Used for tap-to-call everywhere.
    phone:        '(555) 555-0100',
    phoneHref:    '+15555550100',
    // The number that receives photo texts. Usually the same line.
    smsNumber:    '+15555550100',
    // Prefilled body for the "text a photo" link. Kept short — long bodies
    // get truncated by some Android SMS apps.
    smsPrefill:   'Hi! Here is a photo of my bathtub — can I get a free quote?',
    serviceArea:  'REPLACE — e.g. North Jersey & NYC metro'
  },

  offer: {
    /* THE WARRANTY LOCKUP.
       The warranty is never stated on its own anywhere on the site — every
       mention carries the durability line with it, in this exact pairing:

           2-Year Written Warranty • 8+ Years Durability

       Both halves live here so they cannot drift apart, and the page renders
       them through one component (`data-warranty`). Never edit one half in
       the HTML: change it here and it changes everywhere at once.

       They mean different things and must never be merged: the warranty is a
       written 2-year commitment; the 8+ years is potential durability with
       proper care, depending on use and conditions. */
    warrantyLabel:   '2-Year Written Warranty',
    durabilityLabel: '8+ Years Durability',
    warrantyYears:   '2',
    durabilityYears: '8+',

    // Set active:false and the $25 line disappears everywhere at once.
    photoDiscount:   { active: true, amount: '$25' }
  },

  /* -- coverage ---------------------------------------------------------
     No ZIP is ever turned away. The form resolves the ZIP to a city purely
     so the page can say the town's name back to the visitor — it is never
     used to gate, reject or hide anything. */
  coverage: {
    allZips:      true,
    allZipsLine:  'We serve all ZIP codes in our service area',
    // Shown once a ZIP resolves. {city} and {state} are substituted.
    cityLine:     'Serving {city}, {state} — and every ZIP around it',
    // Used when the city lookup is unavailable but the state is known from the
    // offline table. Separate string so it never reads "New Jersey, NJ".
    stateLine:    'Serving all of {stateName} — every ZIP in it',
    fallbackLine: 'Tell us your ZIP and we will confirm your appointment window'
  },

  /* -- trust ------------------------------------------------------------
     Claims a customer can check. Anything you cannot stand behind, delete —
     do not soften it. */
  trust: [
    { t: 'Licensed & insured',            d: 'Fully licensed and insured for every job we take.' },
    { t: 'Professional-grade materials',  d: 'Commercial refinishing systems, not hardware-store tub paint.' },
    { t: 'No surprise charges',           d: 'The price we quote is the price you pay. No add-ons on the day.' },
    { t: 'Pay when it is finished',       d: 'No payment until the work is complete and you are satisfied.' },
    { t: 'Real work, real reviews',       d: 'Every photo and review on this page is from an actual customer job.' },
    { t: 'Written warranty',              d: 'WARRANTY_LOCKUP' }   // rendered as the lockup
  ],

  /* -- reviews ----------------------------------------------------------
     ⚠ REAL REVIEWS ONLY. Paste genuine ones from your existing profiles.
     Invented testimonials break FTC rules and put the Ads account at risk,
     so these ship empty and the page flags them until you replace them. */
  reviews: [
    { name: '', city: '', stars: 5, text: '', source: 'Google' },
    { name: '', city: '', stars: 5, text: '', source: 'Google' },
    { name: '', city: '', stars: 5, text: '', source: 'Google' }
  ],

  /* -- 2. hero video ----------------------------------------------------
     The real refinishing footage. This is the main selling element, not a
     background texture, so it is never dimmed or overlaid with heavy scrim.

     `src`      : your uploaded MP4 (H.264 + AAC plays everywhere)
     `webm`     : optional smaller alternative, served first when supported
     `poster`   : first frame — shown before the video paints. Use a GLOSSY
                  FINISHED tub, not a dirty before-shot; it is what a visitor
                  on a slow connection sees first.
     `hasVoiceover`: false while the clip still carries original on-site audio.
                  While false the sound button stays hidden, because unmuting
                  into hammering and echo actively costs you the lead.
                  Flip to true once the sales voiceover is laid in. */
  video: {
    src:          'media/hero-refinishing.mp4',
    webm:         '',
    poster:       'media/hero-poster.jpg',
    hasVoiceover: false,
    // Caption strip under the video. Tells the story even with sound off.
    stages:       ['Before', 'Refinishing', 'Glossy finish']
  },

  /* -- 3. services (real list) ------------------------------------------ */
  services: [
    'Bathtub Refinishing',
    'Tub + Tile Refinishing',
    'Tile Refinishing',
    'Caulking',
    'Crack Repair',
    'Fiberglass Repair'
  ],

  /* -- 4. integrations --------------------------------------------------
     All blank = safe demo mode. The page validates and shows its success
     states but sends nothing anywhere, and says so on screen. */
  integrations: {
    // Where a V2 lead is saved. Point at the n8n Dispatch API (action
    // job.save) or a thin proxy in front of it.
    // ⚠ Do NOT paste the n8n access key here — this file ships to the
    // browser. Put the key server-side and expose an unauthenticated-but-
    // rate-limited proxy route, or sign requests from your backend.
    leadEndpoint: '',

    // holi's chat. The V2 chat widget is a NEW FRONTEND ONLY — it posts to
    // holi and renders the reply. holi's prompts, booking flow, CRM, Google
    // Calendar and Telegram are not touched by anything here, per the hard
    // rule in CLAUDE.md.
    chatEndpoint: '',

    // The calendar you already built. Embedded in an iframe so V2 reuses the
    // real availability rather than building a second calendar.
    //
    // NOTE: many booking platforms send X-Frame-Options: DENY or a CSP
    // frame-ancestors rule, which makes an embed render as a blank box with no
    // error. The page handles that: if the frame does not confirm it loaded
    // within a few seconds it swaps itself for a large "Open booking calendar"
    // button that opens the real page in a new tab. Either way the visitor can
    // always reach it. If it does turn out to be blocked, allowing this page's
    // origin in frame-ancestors on the booking host is the fix.
    calendarUrl:  'https://book.pristinebathrefinishing.com',
    calendarHeight: 820
  },

  /* -- booking page -----------------------------------------------------
     book.html is deliberately sparse: three strong pieces of proof, the four
     conversion buttons, and the calendar. Nothing else competes with booking.
     Use your three BEST results — this is the last thing someone sees before
     choosing a time. */
  booking: {
    media: [
      { type: 'image', src: 'media/book-1.jpg', cap: 'Before → after, full refinish' },
      { type: 'video', src: 'media/book-2.mp4', cap: 'Professional spray application' },
      { type: 'image', src: 'media/book-3.jpg', cap: 'Finished gloss, ready to use' }
    ]
  },

  /* -- 5. tracking ------------------------------------------------------ */
  tracking: {
    ga4MeasurementId:         '',   // same property as V1 is fine — events carry page_version
    gtmContainerId:           '',   // use a separate GTM *environment* for V2
    clarityProjectId:         '',
    googleAdsId:              '',
    googleAdsConversionLabel: '',
    // Belt and braces alongside env: both must be true for a conversion to
    // fire. Leave false until V2 is approved.
    adsConversionsEnabled:    false
  },

  /* -- 6. recovery popup ------------------------------------------------
     Deliberately late and easily dismissed. Suppressed permanently for this
     visitor once they convert by any route. */
  popup: {
    enabled:     true,
    delayMs:     75000,          // ~75s, inside the 60–90s window
    minScrollPct: 15             // and only if they actually engaged
  }
};
