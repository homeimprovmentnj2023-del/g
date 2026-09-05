/* ---------------------------------------------------------------------------
   SITE CONFIG — edit this file first. Everything marked REPLACE must be
   changed to your real details before you send paid traffic to this page.
   The page reads these values at load and fills them in wherever they appear.
--------------------------------------------------------------------------- */

window.SITE_CONFIG = {

  business: {
    name:        'REPLACE Home Improvement',
    phone:       '(555) 555-0100',        // shown on the page
    phoneHref:   '+15555550100',          // used in tel: links — digits only, with +1
    email:       'quotes@example.com',
    // New Jersey requires a Home Improvement Contractor registration number on
    // all advertising. Put your real one here — this is a legal requirement,
    // not a trust badge.
    licenseLabel:  'NJ HIC Reg. #',
    licenseNumber: 'REPLACE 13VHXXXXXXXX',
    yearsInBusiness: 'REPLACE',           // e.g. '12'
    jobsCompleted:   'REPLACE',           // e.g. '2,400'
    ratingValue:     'REPLACE',           // e.g. '4.9' — must match your real profile
    ratingCount:     'REPLACE',           // e.g. '318'
    ratingSource:    'Google'
  },

  offer: {
    // The single promise in the headline. Keep it concrete and free.
    headlineOffer: 'Free In-Home Estimate',
    // Secondary incentive. Delete if you do not actually run one.
    incentive:     'REPLACE — e.g. $500 off projects over $5,000',
    // How long the quote stays valid. LeafFilter uses one year; it removes
    // the "I need to decide today" pressure that makes people bounce.
    quoteValidFor: '12 months',
    responseTime:  'within 24 hours'
  },

  form: {
    // Where leads go. Leave '' and the form runs in demo mode: it validates,
    // shows the thank-you state, logs the payload to the console, and sends
    // nothing. Set this to your endpoint (Formspree, Netlify, your CRM, or a
    // backend of your own) before launch.
    endpoint: '',
    method:   'POST',
    // Sent with every lead so you can tell v1 and v2 apart in your CRM.
    variant:  'v2'
  },

  tracking: {
    // Google Analytics 4 — 'G-XXXXXXXXXX'
    ga4MeasurementId: '',
    // Google Ads — 'AW-XXXXXXXXX' and the conversion label from the Ads UI
    googleAdsId:              '',
    googleAdsConversionLabel: '',
    // Fires a conversion when someone taps the phone number, not just on the
    // form. Home services leads arrive by phone more often than by form.
    trackPhoneClicks: true
  },

  serviceArea: {
    region:   'New Jersey',
    // Shown in the service-area section and used in the ZIP check below.
    counties: [
      'Bergen', 'Essex', 'Hudson', 'Passaic', 'Morris',
      'Union', 'Middlesex', 'Somerset', 'Monmouth', 'Ocean'
    ],
    // ZIP prefixes you actually serve. A ZIP outside these still submits —
    // it is routed as out-of-area rather than rejected, because turning away
    // a paid click outright is worse than a lead you can decline politely.
    zipPrefixes: ['07', '08'],
    outOfAreaMessage: 'We may not cover that ZIP yet — send it through anyway and we will tell you straight away.'
  },

  services: [
    { id: 'bath',     label: 'Bathroom remodel',    blurb: 'Full gut renovations and tub-to-shower conversions.' },
    { id: 'kitchen',  label: 'Kitchen remodel',     blurb: 'Cabinets, counters, layout changes, full rebuilds.' },
    { id: 'roofing',  label: 'Roofing',             blurb: 'Tear-offs, re-roofs, storm and leak repair.' },
    { id: 'siding',   label: 'Siding & gutters',    blurb: 'Vinyl, fiber cement, gutter and guard systems.' },
    { id: 'windows',  label: 'Windows & doors',     blurb: 'Replacement windows, entry and patio doors.' },
    { id: 'basement', label: 'Basement finishing',  blurb: 'Waterproofing and full basement build-outs.' },
    { id: 'addition', label: 'Addition or deck',    blurb: 'Extensions, dormers, decks and porches.' },
    { id: 'other',    label: 'Something else',      blurb: 'Tell us what you have in mind.' }
  ],

  timelines: [
    { id: 'asap',     label: 'As soon as possible' },
    { id: '1-3mo',    label: 'In the next 1–3 months' },
    { id: '3-6mo',    label: 'In 3–6 months' },
    { id: 'planning', label: 'Just planning for now' }
  ]
};
