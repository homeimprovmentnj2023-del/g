---
name: marketplace-bot
description: Facebook Marketplace autonomous posting + AI chatbot system at C:\Users\Luis\g (backend on localhost:3333, Chrome MV3 extension per FB account, n8n Marketplace Responder, brain decision engine). Use when working on the marketplace bot, extension, posting/autofill, the brain/orchestrator, accounts, photos, listing status, or the Marketplace chatbot bridge. Full reference in C:\Users\Luis\g\CLAUDE.md.
---

# Marketplace Bot — operational skill

Full architecture, data model, and gotchas live in **`C:\Users\Luis\g\CLAUDE.md`** — read it first when starting work. This skill is the quick operational layer.

## First moves each session
1. Backend up? `GET http://localhost:3333/api/settings`. If not: `node src/server.js` from `C:\Users\Luis\g\backend` (or `start.bat`); kill whatever holds port 3333 first.
2. Autonomy state = `settings.autonomous`. The brain only posts when this is `true`.
3. Dashboard/cockpit: `http://localhost:3333/brain.html`.

## The 3 reload rules (this catches everyone)
- **`background.js` changed** → in the profile, `chrome://extensions` → **toggle the extension OFF then ON** (plain reload keeps the stale service worker).
- **`autofill.js` / `marketplace-chat.js` changed** → nothing; they re-inject per job / on page load.
- **backend changed** → restart the backend.

## When something "can't reach the backend" on a profile
Symptom: false "Backend offline — run start.bat", photos fail with `needs_photo` and **zero page logs**, chat doesn't relay. Cause: that profile's PAGE context can't fetch `localhost` (the service worker still can). Fix: **route the call through the worker** — pattern already used for photos (worker pre-fetches → `data:` URLs) and chat (`bgFetch` → `BG_FETCH` in `background.js`). Any new page→backend call on the extension must go through the worker, not a direct `fetch`.

## Operations
| Task | How |
|---|---|
| Enable / disable autonomy | `PATCH /api/settings {"autonomous":true|false}` or the `brain.html` toggle |
| Post one now (paced) | `POST /api/brain/enqueue-now {"accountId":N}` |
| Post a specific template | `POST /api/publish {"templateId":N}` (bypasses pacing; routes by ZIP→account) |
| Post N for an account manually | queue several `POST /api/publish` for that account's ZIP templates; worker does one at a time |
| Inspect decisions | `GET /api/brain/{performance,coverage,plan,keepalive,actions}` |
| Restrict / clear an account | `POST /api/brain/accounts/:id/restrict` \| `/clear` |
| Delete a suspended listing | `POST /api/brain/delete-listing {"url":"…","accountId":N}` (delete-only job) |
| Watch a job to completion | poll `GET /api/publish/queue`, filter by id, read `status`/`result` |

## Safety + guarantees to preserve
- **Never modify** the `holi` chatbot / prompts / booking / sales / CRM / Calendar / Telegram. The Marketplace Responder (n8n) is the separate, editable one.
- Keep secrets local (`.env`, responder workflow json, shared secret) — never commit/push.
- Pacing lives in `brain.js` (25-min gap, 8/account/day, 6h cooldown). Warn the user that direct `/api/publish` and rapid manual batches bypass it, and that 4 accounts posting hard from one IP is the main ban risk.
- Listing-ID capture is by **title**; US-only location; each post rotates a library photo — don't regress these.

## Commit flow
Branch `claude/facebook-marketplace-integration-ctouzr`. Use `git commit -F <messagefile>` (PowerShell here-strings break on quotes). Syntax-check JS with `node --check <file>` before committing. Push, then tell the user which reload (if any) is needed.
