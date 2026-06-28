# Marketplace Bot — Setup Checklist

One ordered page to connect **Facebook Marketplace** to your **existing**
chatbot. Follow top to bottom. Nothing here changes the chatbot, prompts, n8n
workflows, CRM, Google Calendar, follow-ups, or Telegram — Marketplace is added
purely as another message source.

> **Why these manual steps exist:** personal-profile Marketplace has no Meta API
> or webhook, so the bot acts through your logged-in browser. That means a Chrome
> window must stay open and logged in for it to send. See
> `docs/marketplace-integration-research.md` for the full reasoning.

How the pieces fit:

```
Marketplace chat (browser, extension)
  → backend relay /api/marketplace/incoming  (localhost:3333)
  → n8n adapter webhook  → [ your existing chatbot ] → reply
  → backend → extension types & sends the reply
```

---

## 0. Prerequisites
- [ ] Node.js 18+ installed.
- [ ] Google Chrome.
- [ ] Access to your existing n8n + chatbot workflow.
- [ ] Your Anthropic API key (for the listing-AI features; not required for the bridge).

## 1. Get the code
- [ ] Clone the repo and check out the branch:
  ```bash
  git clone https://github.com/homeimprovmentnj2023-del/g
  cd g
  git checkout claude/facebook-marketplace-integration-ctouzr
  ```

## 2. Configure & run the backend
- [ ] `cd backend && cp .env.example .env`
- [ ] Edit `.env`:
  - `ANTHROPIC_API_KEY` = your key
  - `N8N_SHARED_SECRET` = a long random string (save it — used again in step 4)
  - `N8N_WEBHOOK_URL` = leave blank for now (filled in step 4)
- [ ] Install and start:
  ```bash
  npm install
  node src/server.js
  ```
- [ ] Open `http://localhost:3333` → click the **Marketplace Bot** tab. It will
      say "No bridge activity yet" — that's expected until step 5.

## 3. Load the Chrome extension
- [ ] `chrome://extensions` → enable **Developer mode**.
- [ ] **Load unpacked** → select the `extension/` folder.
- [ ] Keep this Chrome window logged into the Facebook account that owns the
      listings. (It must stay open for the bot to send.)

## 4. Wire n8n to your EXISTING chatbot (reuse, no duplication)
Full detail + importable workflow JSON: `docs/n8n-marketplace-adapter.md`.
- [ ] In n8n: **Import** the starter workflow from the JSON block in that file.
- [ ] **Verify Secret** node → set the value to your `N8N_SHARED_SECRET`.
- [ ] **Existing Chatbot (sub-workflow)** node → select your real chatbot
      workflow. **Do not edit that workflow's logic.**
- [ ] **Normalize** node → rename the output fields to match the field names your
      chatbot already reads (check your existing Messenger trigger to find them).
- [ ] Ensure your chatbot returns reply text under `reply` / `text` / `output`
      (or adjust the Respond node).
- [ ] **Activate** the workflow, copy its **production webhook URL**.
- [ ] Paste that URL into `backend/.env` → `N8N_WEBHOOK_URL`, then **restart the
      backend** (`Ctrl+C`, `node src/server.js`).

> If your chatbot is one monolithic workflow ending in a Messenger Send API
> call, use the "single IF" approach in `docs/n8n-marketplace-adapter.md`
> instead — it's the smallest possible change and still touches no prompts/logic.

## 5. Calibrate selectors on a live inbox (the only trial-and-error step)
- [ ] Open `https://www.facebook.com/marketplace/inbox` in the logged-in Chrome.
- [ ] Confirm the bottom-left **status badge** shows "Bridge active · auto-reply on".
- [ ] Send a test message to one of your listings (use a second account or ask a
      friend). Watch the badge: **Asking chatbot… → Sending… → Sent ✓**.
- [ ] If the message isn't detected or the reply won't send:
  1. With the inbox open, click the sidebar's **Capture Form (debug)** button.
  2. Update the `FBM_SELECTORS.chat` block in `extension/src/selectors.js`
     (messageRow / messageText / composeBox / sendButton / contactName).
  3. Reload the extension (`chrome://extensions` → reload) and retry.
- [ ] Repeat until a test message receives an automatic reply.

## 6. Confirm end-to-end
- [ ] A test buyer message gets an **automatic** reply in the Marketplace chat.
- [ ] Dashboard → **Marketplace Bot** tab shows: Replies Sent, Last Activity,
      "Bridge healthy", and the activity row.

---

## Run mode & toggles
- **Fully automated (default):** the bot reads, replies, and sends with no clicks.
- **Review-before-send** (for calibration only): in the extension's
  service-worker console run `chrome.storage.local.set({ mpAutoSend: false })`;
  set back to `true` for full automation.

## Keeping it running unattended
- The logged-in Chrome window must stay **open on the Marketplace inbox** (e.g.
  on an always-on PC). Closing it stops sending — there's no server-side channel
  Meta allows for personal profiles.
- The backend (`node src/server.js`) must stay running.

## Troubleshooting (two monitoring surfaces)
| Symptom | Where | Likely cause / fix |
|---|---|---|
| Badge red: "Backend offline" | FB tab | Backend not running → start it. |
| Badge red: "Send failed" | FB tab | FB UI changed → update `selectors.chat`. |
| Badge red: "Backend 502/504" | FB tab | n8n URL/secret wrong or n8n down → check `.env` + n8n. |
| Dashboard shows errors | Marketplace Bot tab | Read the detail column — it names the cause. |
| Bot replies to old messages | — | Increase `freshnessMs` in `marketplace-chat.js`. |
| No activity at all | both | Confirm `N8N_WEBHOOK_URL` set + backend restarted. |

## What was NOT changed
Your chatbot, prompts, n8n conversation logic, booking logic, follow-ups, CRM,
Google Calendar, and Telegram are untouched. The integration adds only: a new
extension content script, additive chat selectors, one backend relay route, and
a read-only dashboard panel.
