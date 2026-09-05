# v2 landing page

A second landing page for Google Ads traffic, built to run **alongside v1** so the
two can be tested against each other. Nothing in v1 was changed, moved or deleted.

Design brief: **LeafFilter's structure wearing Palmetto's clothes.** LeafFilter is
the most heavily tested direct-response page in home improvement, so the skeleton
comes from there. Palmetto is what stops it looking like a discount contractor, so
the surface comes from there.

```
site/v2/
  index.html          the page
  config.js           ← edit this first: phone, licence, endpoint, tracking IDs
  assets/styles.css   layout and design tokens
  assets/form.css     the multi-step quote form
  assets/app.js       form logic, validation, tracking, click attribution
  images/             drop your real job photos here
```

No build step, no dependencies. Open `index.html` and it runs.

---

## Before you send a single paid click

Work top to bottom through `config.js` — every value marked `REPLACE` is either a
legal requirement or a claim a customer can check.

1. **`business.phone` / `phoneHref`** — the whole page reads from here, so there is
   only ever one number to change.
2. **`business.licenseNumber`** — New Jersey requires your HIC registration number
   on all advertising. This is a legal obligation, not a trust badge.
3. **`form.endpoint`** — until this is set the form runs in **demo mode**: it
   validates, shows the thank-you state, logs the payload to the console and
   **sends nothing**. An orange banner sits on the form the whole time this is
   true, so a console log can never be mistaken for a delivered lead.
4. **`tracking.*`** — GA4 and Google Ads IDs. Without the conversion label the page
   still tracks internally but reports nothing back to Ads, so Smart Bidding stays
   blind.

Then in `index.html`, replace everything still flagged. Anything carrying the
`is-placeholder` class renders a **red REPLACE badge** on the page — it is designed
to be impossible to deploy by accident. Search the file for `REPLACE` to find the
rest.

### Two things to be careful with

**Reviews are empty on purpose.** The three testimonial cards contain bracketed
instructions, not invented quotes. Publishing fabricated testimonials breaks FTC
rules and is one of the faster ways to lose a Google Ads account. Paste in real
reviews and delete `is-placeholder` from the card.

**The trust-strip numbers are empty for the same reason.** Years in business,
projects completed, star rating and review count are claims a customer can verify.
Put real figures in or delete the tile — an empty strip beats an invented one.

`aggregateRating` is deliberately left out of the JSON-LD block for the same
reason. Only add it once it reflects genuine, verifiable reviews.

---

## Why the page is shaped the way it is

**Step 1 asks for a ZIP and nothing else.** This is the single highest-leverage
decision on the page. Single-field forms convert around 13.4%; nine-field forms
around 3.6%. Multi-step forms beat single-page forms containing the same total
fields by roughly 21%, and by 30–60% on mobile, because the perceived cost of
starting is so much lower. The remaining questions get asked once the visitor has
already committed.

**One goal, no navigation.** There is no menu, no About link, no blog. Pages built
around a single repeated call to action beat pages with competing ones by 20–30%.
Every button on the page either opens the form or dials the phone.

**The phone is a first-class conversion.** Click-to-call above the fold produces
2–3× the phone leads of a buried number, and in home services the phone routinely
outperforms the form. It sits in the header, in the form, in the thank-you state,
in the footer, and in a sticky bar on mobile — and every one of those is tracked.

**The offer is in the headline.** Dedicated landing pages with a specific offer
convert at 12–22% against 3–6% for a generic homepage. "A free estimate today. A
fixed price you can hold us to." is the offer, not a description of the company.

**The quote holds for 12 months.** Lifted from LeafFilter. It removes the "decide
tonight" pressure that makes cautious homeowners — the ones with the biggest
projects — bounce.

**Out-of-area ZIPs warn but never block.** Turning away a click you already paid
for is worse than a lead you decline politely by phone.

---

## Click attribution

`gclid`, `gbraid`, `wbraid` and the full UTM set are captured on landing, held in
`sessionStorage`, and submitted with every lead alongside `variant: "v2"`.

This matters more than it looks. Without `gclid` on the lead record you cannot
import offline conversions back into Google Ads, which means Ads never learns
which keywords produce jobs that actually close — only which produce form fills.
Those are very different lists.

`variant` is what lets you split v1 and v2 in your CRM without any extra tooling.

## Events emitted

Sent to both `dataLayer` and `gtag` if present:

| Event | Fires when |
|---|---|
| `form_view` | form renders |
| `form_step` | each step advance (carries step number) |
| `form_step_error` | validation blocks a step — shows you *where* people stall |
| `zip_out_of_area` | ZIP outside your prefixes |
| `generate_lead` | successful submission |
| `phone_click` | any `tel:` link, with its page location |
| `cta_click` | any scroll-to-form button, with its location |
| `scroll_depth` | 25 / 50 / 75 / 90% |
| `form_submit_error` | endpoint returned non-2xx |

`form_step_error` and the per-step `form_step` events are the useful pair: they
turn the form into a diagnostic. If people stall between steps 2 and 3, the
project-detail question is the problem, and you will know rather than guess.

---

## Running it

```bash
cd site/v2
python3 -m http.server 8801
# http://127.0.0.1:8801
```

## Deploying

It is static, so anything will host it — Netlify, Vercel, Cloudflare Pages, S3, or
a folder on your existing host. Upload `site/v2/` as-is.

To A/B against v1, point a second Google Ads ad group at the v2 URL, keep budget
and keywords identical, and compare cost per lead. Give it enough conversions to
mean something before calling it — a 30% difference on nine leads is noise.

## Known gaps

- **Photography.** The gallery is six placeholder slots. Real job photos beat
  stock decisively — homeowners can tell instantly — so this is worth doing
  properly before launch.
- **No backend.** The form posts JSON to whatever `form.endpoint` you set. If you
  would rather store leads yourself, the repo already has Express + SQLite in
  `backend/`, though that server is the Facebook Marketplace tool and a separate
  lead service would be cleaner than coupling the two.
- **Privacy policy link** in the form's fine print points at `#` and needs a real
  destination before launch.
- **Google Fonts** load from Google. If you would rather self-host them (faster,
  and simpler under GDPR), download Fraunces and Inter into `assets/` and swap the
  `<link>` for `@font-face` rules.
