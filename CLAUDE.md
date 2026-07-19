# Facebook Marketplace Bot — Project Reference

Autonomous Facebook Marketplace posting + AI chatbot for a bathtub/tile reglazing
business. Runs locally on the user's Windows PC across multiple Chrome profiles
(one per Facebook account). Backend on `http://localhost:3333`.

## ⚠️ Hard rules
- **Do NOT modify the `holi` chatbot, its AI prompts, booking flow, sales flow,
  CRM, Google Calendar, Telegram, or follow-ups** without the user's explicit
  ask. The Marketplace chatbot is a **separate** n8n "Marketplace Responder"
  workflow — that one is fair game.
- **Secrets stay local, never commit/push:** `backend/.env`,
  `marketplace-responder.workflow.json`, `marketplace-adapter.import.json`,
  anything with the n8n shared secret or API keys. (They're gitignored.)
- Work happens on git branch **`claude/facebook-marketplace-integration-ctouzr`**.
  Commit with `git commit -F <file>` (PowerShell here-strings break on quotes).
  Git binary: `C:\Users\Luis\AppData\Local\Programs\Git\cmd\git.exe`.

## Architecture

```
Chrome profile (per FB account)                Backend (localhost:3333)         n8n cloud
├─ background.js  (service worker) ───────────► /api/publish/next  (queue)
│   • publish-queue worker (opens create tab,    /api/publish/:id  (result)
│     injects autofill, reports result)          /api/listings     (track)
│   • status monitor (verify MY stale listings)  /api/marketplace/incoming ───► "Marketplace
│   • pre-fetches photos → data URLs             /api/brain/*  (decisions)        Responder"
│   • BG_FETCH relay (page→worker→backend)       /api/settings (autonomous...)    (webhook →
├─ autofill.js  (injected per job)                                                classify →
│   • fills create-listing form, uploads photo   brain.js  (decides account→        gpt-4o
│     (uniquify), publishes, captures id            zip→template, coverage,          agent →
│   • deleteListing / deleteFromSelling            plan, keepAlive)                  reply)
│   • US-only fillLocation                       server.js (API, scheduler,
├─ marketplace-chat.js  (content script)            brainTick orchestrator,
│   • chatbot bridge: detect inbound → relay        photosForJob rotation)
│     via BG_FETCH → type+send reply             db.js (JSON store: data/fbm.json)
└─ popup.js  (per-profile account selector →     ai.js (Claude listing text —
     chrome.storage.local.fbmAccountId)             needs ANTHROPIC_API_KEY, currently
                                                    a placeholder → AI features off)
Dashboard: http://localhost:3333/  (index.html) and /brain.html (brain control panel)
```

### Key files
| File | Role |
|---|---|
| `backend/src/server.js` | Express API, per-account publish queue, `brainTick()` orchestrator (gated by `settings.autonomous`), `photosForJob()` library rotation, `queueJobFromTemplate()`, `/api/brain/*` endpoints. |
| `backend/src/brain.js` | **Read-only** decision brain: `performance()`, `coverage()`, `plan()` (ranked next posts, fills ZIP gaps first), `keepAlive()`. Caps/pacing live here. |
| `backend/src/db.js` | JSON store `data/fbm.json`. Templates, listings, accounts (+`health`), post_queue, schedules, `brain_actions`, settings. |
| `backend/src/ai.js` | Claude (`claude-haiku-4-5`) listing text + policy rewrite. **Inactive** until a real `ANTHROPIC_API_KEY` is in `.env`. |
| `extension/src/background.js` | MV3 service worker: queue worker, status monitor, photo pre-fetch, delete-only jobs, `BG_FETCH` relay. |
| `extension/src/autofill.js` | Create-listing automation, `uniquifyImageFile`, `findPostedListing` (title match), `deleteListing`, US-only `fillLocation`. Re-injected each job. |
| `extension/src/marketplace-chat.js` | Chatbot bridge (relay via `bgFetch`→worker), watchdog, badge. Content script. |
| `dashboard/brain.html` | Brain control panel: autonomy toggle, account health, plan, coverage, safety settings, decision log. |

### Data model (in `data/fbm.json`)
- **accounts**: `{id, name, zips[], active, health:{status:'ok'|'restricted', posts_today, last_post_at, blocks, last_reason}}`. 4 accounts A/B/C/D, ~12 ZIPs each (round-robin across ~9 metros). Chrome profile → account via popup (`fbmAccountId`).
- **templates**: `{id, title, price, location:"City, ST 00000", category, condition, description, photos:[url]}`. ~49 templates, ZIP derived from `location`. (Currently 1 photo each.)
- **listings**: `{id (FB item id), status:'active'|'inactive'|..., owned, template_id, url, first_seen, last_checked}`.
- **post_queue (jobs)**: `{id, template_id, account_id, photos, delete_url, delete_only, status:'pending'|'running'|'done'|'blocked'|'needs_photo'|'failed'|'canceled'}`.
- **settings**: `{autonomous:false, brain_max_per_account_per_day:8, brain_min_gap_minutes:25, brain_cooldown_hours:6, brain_quiet_hours:[]}`.
- **photo library**: ~47 images in `backend/data/photos/`, served at `/photos/<name>`.

## Gotchas (hard-won — read before debugging)
1. **Extension reloads:** a `background.js` (service worker) change needs **toggle OFF then ON** in `chrome://extensions` (a plain reload often keeps the old worker). `autofill.js` / `marketplace-chat.js` are content scripts — they re-inject on page load / per job, **no reload** needed. Backend changes need a **backend restart**.
2. **Some profiles' PAGE context can't reach `localhost:3333`** (photos, logs, chat fail with a false "Backend offline — run start.bat"). The **service worker CAN** reach it. Fix pattern: **route backend calls through the worker** — photos are pre-fetched by the worker and passed as `data:` URLs; the chat bridge uses `bgFetch` → `BG_FETCH` handler in background.js.
3. **Chrome throttles background/hidden tabs** — page timers run ~1/min or freeze, and Memory Saver discards inactive tabs. Consequence: the chatbot only worked in the profile the user was LOOKING at. Fix pattern (same "route through the worker" idea as #2): the SW's `mpChatTick` alarm (30s) pings each inbox tab (`MP_TICK` → sweep; message EVENTS aren't throttled, timers are), marks tabs `autoDiscardable:false`, reloads tabs that don't ack; content-script `sleep()` goes through the SW (`BG_SLEEP`) so in-sweep waits aren't stretched in hidden tabs. Never rely on `setInterval`/`setTimeout` in a content script for anything that must run unattended.
3. **Listing-ID capture** matches the just-posted listing by **title** on the "Your Listings" page. Never fall back to "first item on the page" — on rapid posts that grabs a *previous* listing and merges records.
4. **Deleting** a listing: Facebook shows "Delete" only on the **Your Listings** page, not the item page. Delete-only jobs (`delete_only:true`) open the listing and delete; a full "Your Listings" delete flow is still WIP.
5. **US-only location:** `fillLocation` must never confirm a foreign row (the same 5-digit ZIP exists in Brazil/Italy/etc. and FB often lists those FIRST). Templates store a **bare ZIP** (no state), so it verifies by **ZIP→state** (USPS 3-digit prefix table `stateForZip`) and accepts a suggestion only if it's in that state or contains the ZIP — never guesses `us[0]`. Gotchas baked into the matcher (all real, seen in logs): FB writes the state as **abbr OR full name** ("Forest Hills, NY" vs "…, New York"), and **jams the check-in count onto the abbr** ("Los Gatos, CA1 person checked in here") so a plain `\b` fails — match `ST(?=\d|[^A-Za-z]|$)`. It polls for suggestions (fixed sleeps flaked under FB autocomplete throttling), retries 4× with backoff, is **idempotent per job** (the publish loop calls it ~7×; without the `locationDone` guard a later call overwrites a good pick), and logs the suggestions it saw on failure.
6. **Pacing/duplicates:** the brain enforces 25-min gap, 8/account/day, 6h per-template cooldown. Direct `/api/publish` **bypasses** pacing. Each post leads with a **rotating library photo** (`photosForJob`) + fallbacks; `uniquifyImageFile` (crop/rotate/mirror/hue) defeats duplicate-image detection.
7. **Status monitor** only verifies **owned** listings, capped at 5/cycle — else it opens a tab per listing (incl. scraped competitors) = tab storm.
8. **Load the extension from `C:\Users\Luis\g\extension`** — not the stale Desktop copy `C:\Users\Luis\Desktop\g-claude-facebook-marketplace-automation-kx13yt\extension`.
9. **PowerShell:** no heredoc (`<<`); no `&&`/`||` chaining; use `git commit -F <file>`; `2>$null` not `2>&1` on native exes.

## Common operations
- **Restart backend:** kill port 3333, then `node src/server.js` from `C:\Users\Luis\g\backend` (or `start.bat`). Verify: `GET http://localhost:3333/api/settings`.
- **Autonomy on/off:** `PATCH /api/settings {"autonomous":true|false}` or the toggle on `brain.html`.
- **Manual post:** `POST /api/publish {"templateId":N}` (routes by ZIP→account) or `POST /api/brain/enqueue-now {"accountId":N}` (top plan proposal, respects pacing).
- **Watch the brain:** `GET /api/brain/{performance,coverage,plan,keepalive,actions}`.
- **Account failover:** `POST /api/brain/accounts/:id/restrict` / `.../clear`.
- **Delete a listing:** `POST /api/brain/delete-listing {"url":"...","accountId":N}` (queues a delete-only job).
- **Per-profile setup:** in each Chrome profile, load the extension from `C:\Users\Luis\g\extension`, open the popup, select the account. Only a profile with `fbmAccountId` set polls that account's jobs.

## Dispatch subsystem (scheduling & job cards)
- **Job Cards** (`dispatch_jobs` in fbm.json): customer, phone, address, city/state/**zip (autofilled via `zip.resolveZip`)**, services, price, photos[], `appointment_at` (ISO), `fb_url` (conversation link, sent by the bridge), notes, `tech_id`, status `new→scheduled→confirmed→dispatched→completed/canceled`, `customer_confirmed`.
- **Technicians** (`technicians`): name, phone, `states[]` (2-letter). Suggestion = active techs covering the job's state (fallback `zip.stateForZip`).
- **Dashboard**: `http://localhost:3333/dispatch.html` — filters (state/tech/date/status/search), card editor, techs manager, assign + notify buttons.
- **Messaging** (`backend/src/notify.js`): `composeTechMessage` (full job summary + Google Maps link) and `composeCustomerSMS` ("scheduled service appointment, not an estimate — reply YES"). **Auto-SMS only if `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`/`TWILIO_FROM` in `backend/.env`**; otherwise endpoints return `manual:true` + `wa.me`/`sms:` click-to-send links.
- **API**: `/api/techs` CRUD; `/api/dispatch` CRUD + `/:id/assign`, `/:id/notify-customer`, `/:id/confirm`. n8n can POST `/api/dispatch` to auto-create cards from bookings.
- **Chatbot dates**: `/api/marketplace/incoming` injects `scheduling{today, weekday, now, earliest_date, earliest_weekday, lead_days}` (`settings.booking_lead_days`, default 2). The n8n **Marketplace Responder** prompt must reference these to offer dates ≥ earliest_date (never "tomorrow"). holi untouched.
- **Gotcha (nested migration)**: `loadFrom` merges missing top-level keys AND missing `counters` keys — adding a table without its counter used to yield `NaN` ids on existing data files.

## Status posture
Autonomous posting is functional across profiles. Known open items: add multiple real photos per template; the "Your Listings" delete flow; and (from the audit) a Telegram down-alert + atomic DB saves for true unattended reliability. Real `ANTHROPIC_API_KEY` would enable the AI listing-text/policy features.
