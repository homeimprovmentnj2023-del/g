# V2 — bathtub refinishing landing page (DEVELOPMENT)

A safe, independent copy. **Production V1 is not touched by anything in this
folder**, and V2 cannot reach production traffic, production conversions or
production DNS.

```
site/v2/
  index.html          PAGE 1 — hero, actual work, trust, reviews, booking CTA
  book.html           PAGE 2 — 3 proof items + 4 buttons + the calendar
  config.js           ← the only file you need to edit
  assets/styles.css   design system (18px base, 56px tap targets, 45+ audience)
  assets/chat.css     chat widget + recovery popup
  assets/zip.js       ZIP → city/state, ported from backend/src/zip.js
  assets/app.js       video, form, SMS, chat, calendar bridge, tracking
  media/              ← drop the real video and job photos here (see its README)
```

Run it: `cd site/v2 && python3 -m http.server 8802`

## Two pages

The calendar has moved off the landing page onto its own second page. Page 1
sells; page 2 books, and nothing on it competes with booking — three strong
pieces of proof, the four conversion buttons, the calendar, and a line making
clear that choosing a time costs nothing.

Every "See appointments" / "Book" control on page 1 goes to `book.html`. Both
pages carry the same header, the same sticky mobile bar, and the same chat
widget against the same holi backend.

## The warranty lockup — the rule that cannot be broken

The warranty is **never** written on its own. Every mention renders both halves
together:

> **2-Year Written Warranty • 8+ Years Durability**

Both strings live in `config.js` under `offer.warrantyLabel` /
`offer.durabilityLabel`, and the page renders them through one component
(`data-warranty`). Change them there and every instance changes at once. Never
type either half directly into the HTML — that is exactly how the two drift
apart and the warranty starts reading as an 8-year guarantee.

They are different promises: the warranty is a written 2-year commitment; the
8+ years is potential durability with proper care, depending on use and
conditions. The footer on both pages spells that distinction out in full.

## Coverage and city detection

`assets/zip.js` is a faithful port of `backend/src/zip.js` — the same USPS
3-digit prefix table, and the same rule that **state comes from the offline
table** (authoritative, never returns a foreign state) while the free
zippopotam.us API only ever supplies the city.

It exists so the page can say the visitor's own town back to them. It never
gates, rejects or hides anything — no ZIP is turned away:

| State | Line shown |
|---|---|
| No ZIP yet | "We serve all ZIP codes in our service area" |
| ZIP + city known | "Serving Hoboken, NJ — and every ZIP around it" |
| ZIP known, API down | "Serving all of New Jersey — every ZIP in it" |

The state answer is instant and offline, so something true is on screen before
any network call returns. Verified both with the API mocked and with it aborted.

## Trust and reviews

Six trust cards, driven from `config.trust`: licensed & insured,
professional-grade materials, no surprise charges, pay when it is finished,
real work and real reviews, and the warranty lockup.

The three review cards ship **empty and flagged with a red PASTE A REAL REVIEW
badge**. Paste genuine reviews from your existing profiles into
`config.reviews`. Invented testimonials break FTC rules and put the Ads account
at risk, so nothing plausible-looking is shipped that could go out by accident.

---

## The inspection, before anything was built

**1. Which route is production V1?** Not in this repository, and not reachable
from this session. This repo (all three branches) is the Facebook Marketplace
bot only. The landing page, `holi`, and the calendar live elsewhere — n8n cloud,
Supabase, and the Windows machine at `C:\Users\Luis\g`.

What the repo *did* tell us, from `CLAUDE.md` on
`claude/facebook-marketplace-integration-ctouzr`:

- the business is bathtub/tile reglazing ✓
- **`holi`** owns the chatbot, AI prompts, booking flow, sales flow, CRM,
  **Google Calendar**, Telegram and follow-ups
- there is a hard rule: **do not modify holi**. holi writes a Supabase
  `bookings` table; the dispatch system only ever *reads* it
- Twilio is **not configured** — the existing system falls back to one-tap
  `wa.me` / `sms:` links rather than sending automatically

**2. How V2 was copied safely.** It was not copied — there was nothing here to
copy. V2 is new files in a new folder on a feature branch. Nothing existing was
modified or deleted (verified with `git status`).

**3. Route/name.** `site/v2/` in this repo, `noindex, nofollow`. When it goes to
a host, put it on its own path or preview subdomain. Never over V1's route.

**4. What is reused.** Verified present and directly applicable:

| Existing thing | Reused for |
|---|---|
| `backend/src/notify.js` → `smsLink()` | The "text a photo" link. V2 builds `sms:<n>?&body=<text>` — the exact form that survives both iOS and Android. |
| `backend/src/notify.js` → `normPhone`, `waLink` | Phone normalising; WhatsApp fallback if you want it. |
| `backend/src/zip.js` → `normalizeZip`, `stateForZip`, `resolveZip` | ZIP validation and state routing for the quote form. |
| Supabase `dispatch_jobs` + n8n **Dispatch API** (`job.save`) | Where a V2 lead should land, so it appears as a job card like every other. |
| `holi` chat endpoint | `integrations.chatEndpoint`. **Frontend only** — V2 posts a message and renders the reply. |
| Your existing calendar | `integrations.calendarUrl`, embedded in an iframe. Not rebuilt. |
| `scheduling{earliest_date, lead_days}` contract | The V2 calendar inherits it automatically by embedding the real one. |

**Not reused, deliberately:** holi's prompts, booking flow, CRM, Google Calendar
and Telegram are untouched. The brief asked to "redesign the chatbot frontend",
which is compatible with the hard rule *only* because nothing server-side
changes. V2 is a new face on the same brain.

**5. How V1 is protected.** Separate folder, separate branch, no deploy step, no
DNS change, no Ads change. `noindex, nofollow` so it cannot compete in search.
Nothing in this folder imports from, writes to, or overwrites anything else.

**6. How V2 conversions are kept out of production.** This is the part that
would do real damage if it were wrong.

- `config.js` → `env: 'development'`. While that holds, **no Google Ads
  conversion fires**, whatever else is configured. Test submissions must never
  reach Smart Bidding — a few fake conversions teach the model the wrong thing
  and the damage outlives the test.
- A second independent flag, `tracking.adsConversionsEnabled` (default `false`).
  **Both** must be right before a conversion fires. One flag is not enough for
  something this expensive to get wrong.
- Every event and every lead carries `page_version: 'v2'`, so V1 and V2 split
  cleanly in one GA4 property.
- `gtag config` sends `traffic_type: 'internal'` while in development, so a GA4
  internal-traffic filter keeps review sessions out of production reporting.
- Use a separate **GTM environment** for V2 rather than a second container.
- An unmissable striped ribbon sits at the top of the page in development.

**7 & 8. Hero layout.** Built, not just proposed — see below.

---

## Hero layout

**Desktop (two columns).** Headline across the top. Left, the video at ~57%
width, bright and undimmed, with the stage strip (Before → Refinishing → Glossy
finish) underneath and the four trust pills below that. Right, the conversion
column in priority order: the big **CALL NOW** block, the four-field quote form,
then text-a-photo.

The video carries **no dark scrim**. Dimming the transformation to make overlaid
text readable is exactly what V1 does wrong — so no text sits on the video at
all. It goes beside and beneath it.

**Mobile (single column, reordered).** DOM order would bury the phone and the
form under the headline, subheading and video, so below 1000px every wrapper
dissolves (`display:contents`) and the children are ordered directly:

> headline → video → **CALL NOW** → quote form → text-a-photo → stage strip →
> trust pills → subheading

Verified in Chromium at 430×932, 390×844, 375×667 and 360×640: the video **and**
the full-width CALL NOW block are on the first screen at every size, with no
horizontal overflow. The subheading moves to the bottom — it supports the
decision, it does not make it.

---

## Before this can be reviewed properly

Everything below is a real asset or endpoint you already have. Nothing was
invented to fill a gap.

1. **`media/hero-refinishing.mp4` + `hero-poster.jpg`** — the real footage. Until
   it exists the page shows an honest placeholder rather than a broken black box.
   See `media/README.md` for the encode command and the voiceover script points.
2. **`business.phone` / `smsNumber`** — the existing production number.
3. **`integrations.leadEndpoint`** — until set, the form validates and shows its
   success state but **saves nothing**, and says so in the console.
   ⚠ Do not put the n8n access key in `config.js` — this file ships to the
   browser. Keep the key server-side behind a proxy route.
4. **`integrations.chatEndpoint`** — holi's endpoint.
5. **`integrations.calendarUrl`** — the existing calendar.
6. **`media/work-1…6`** — six real before/afters and clips for page 1, plus
   **`media/book-1…3`** — the three strongest for the booking page. There are
   ~47 real photos in `backend/data/photos/` on the Windows machine already.
7. **Real reviews** into `config.reviews` — see above.
8. **Voiceover.** Leave `video.hasVoiceover: false` until the sales voiceover
   replaces the original on-site audio. While false the 🔊 button stays hidden,
   because unmuting into hammering and echo costs you the lead.

## Claims — the two that must not blur

The page, the footer and the voiceover all say it the same way:

- **2-year warranty. Included.**
- **8+ years** — *potential* lifespan with proper care, depending on use and
  conditions.

Never "guaranteed for 8 years". Never "never peels". The durability section
(stub 4) is laid out to show the two side by side precisely so they cannot be
read as one number.

## Events

`page_view_v2`, `free_quote_started`, `free_quote_submitted`, `phone_captured`,
`call_clicked`, `sms_quote_clicked`, `chat_opened`, `chat_started`,
`video_started`, `video_sound_enabled`, `real_work_viewed`, `calendar_viewed`,
`durability_section_viewed`, `warranty_viewed`, `city_detected`,
`recovery_popup_shown`, `recovery_popup_dismissed`, `cta_click`,
`form_submit_error`.

`date_selected`, `time_selected`, `booking_started` and `booking_completed` are
relayed from the embedded calendar via `postMessage`. If your calendar does not
emit them they stay silent rather than being faked — `calendar_viewed` still
fires either way.

`gclid`, `gbraid`, `wbraid` and the UTM set are captured on landing, held for
the session, and attached to every lead and chat message.

## Recovery popup

Fires once at ~75s, and only if the visitor scrolled at least 15%. Permanently
suppressed for anyone who already submitted, called, texted or booked — chasing
someone who already called is the fastest way to look careless. Phone field only,
one button.

## Not built yet, on purpose

Durability/process, refinish-vs-replace, see-the-work-before-you-pay and the FAQ
are visible stubs on page 1. The brief said get the top of the page excellent
first and not to overbuild below, so they are placeholders rather than weak copy.
