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
    warrantyYears:   '2',
    // Potential lifespan. NEVER presented as the warranty term.
    durabilityYears: '8+',
    // Set active:false and the $25 line disappears everywhere at once.
    photoDiscount:   { active: true, amount: '$25' }
  },

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
    calendarUrl:  '',
    calendarHeight: 760
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
