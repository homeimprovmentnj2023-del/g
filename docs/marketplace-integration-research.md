# Facebook Marketplace → Existing Messenger Chatbot: Integration Research

**Goal:** Let Facebook Marketplace conversations be handled by the *existing*
Messenger chatbot (n8n + Meta Graph API + CRM + Calendar + Telegram), with the
fewest possible changes and **zero** modifications to the chatbot, prompts,
workflows, automations, or integrations that already work.

This document is research and recommendation only. It does not change any
chatbot logic.

---

## TL;DR (the short answer)

- **There is no first‑class "Marketplace API".** Marketplace has no public
  messaging API of its own. Whether the existing chatbot can pick up
  Marketplace chats depends entirely on **whether those chats land in a
  Facebook *Page* inbox**.
- **If you list/sell as a Page** (Page‑routed Marketplace), the messages
  arrive on the *same* Messenger Platform webhook you already use → the
  existing chatbot handles them with **no chatbot changes and no new
  webhook**. This is the simplest and most reliable path. ✅
- **If you list as a personal profile** (the normal way most people use
  Marketplace), those chats live in your personal Messenger and are **not
  available through any official Meta API or webhook**. There is no supported
  server‑side way in. The only reliable bridge is a **browser‑side forwarder**
  (the same pattern as the Chrome extension already in this repo) that posts
  Marketplace messages into your existing n8n webhook and types the bot's reply
  back into the page. ✅ (fallback)
- Either way, the chatbot brain is **reused, not duplicated**. The only new
  piece is a thin **adapter/normalizer** in front of n8n.

---

## 1. Background: how Marketplace messaging actually works

| Aspect | Reality |
|---|---|
| Dedicated Marketplace messaging API | **Does not exist.** No public Graph API endpoint for Marketplace inboxes. |
| Where Marketplace chats go | Into **Messenger** — but *which* Messenger inbox depends on who owns the listing. |
| Listing owned by a **personal profile** | Chat goes to that person's **personal Messenger** (`facebook.com/messages` / Chats). **No API, no webhook access.** |
| Listing owned/routed via a **Facebook Page** (Commerce/eligible categories, e.g. some vehicles/rentals/business listings) | Chat appears in the **Page inbox** and is delivered to the standard **Messenger Platform `messages` webhook**. |

The single most important question for this project is therefore:

> **Are the Marketplace listings managed under a Facebook Page, or under a
> personal profile?**

The answer selects the architecture. Both options below reuse the existing
chatbot unchanged.

---

## 2. Option A — Page‑routed Marketplace (preferred, if eligible)

**Idea:** Make Marketplace inquiries arrive in the **Page inbox** that the
chatbot already serves. Then a Marketplace message is, technically, just
another Page Messenger conversation.

### Why this is best
- Marketplace messages use the **same Messenger webhook** you already have.
- **No new webhook, no duplicated workflow, no second bot.**
- The existing prompts, booking logic, CRM, Calendar, Telegram, and follow‑ups
  all fire exactly as they do for Messenger today.

### What's required (Meta / Facebook Business side)
1. The business has a **Facebook Page** (the one the chatbot is already
   subscribed to).
2. Listings are created/managed so they route to the Page — i.e. through
   **Commerce Manager / catalog** or an eligible Marketplace‑for‑business
   category. (Eligibility is category‑ and region‑dependent; verify in
   Commerce Manager whether your listing type qualifies for Page routing.)
3. The Page's Messenger app already has these — confirm they're present
   (they will be, since the chatbot works):
   - `pages_messaging` permission
   - Page subscribed to the app for the **`messages`** (and ideally
     `messaging_postbacks`) webhook fields
   - A valid **Page Access Token**

### Routing changes required
**None to the chatbot.** Optionally, add **source tagging** in n8n (see §4) so
you can report on Marketplace vs Messenger volume — this is additive and does
not change conversation/booking logic.

### Limitation
Page routing is **not available for every category or region**. General
local‑goods selling is usually personal‑profile only. If you cannot make
listings route to the Page, use Option B.

---

## 3. Option B — Browser‑bridge forwarder (fallback for personal‑profile Marketplace)

**Idea:** Since personal Marketplace chats have **no API**, bridge them at the
**browser layer** — the exact technique this repo's Chrome extension already
uses to read the Marketplace DOM. The bridge **forwards** each incoming
Marketplace message into the **existing n8n webhook** and **types the bot's
reply back** into the Marketplace chat box. The chatbot itself is untouched.

```
Marketplace chat (personal profile, in browser)
        │  content script reads new inbound message (DOM)
        ▼
Bridge (extension) ──HTTP POST──► n8n adapter endpoint
        ▲                              │ normalizes to Messenger-shaped payload
        │                              ▼
        │                     EXISTING chatbot workflow (unchanged)
        │                       (prompts, booking, CRM, Calendar, Telegram)
        │                              │
        └──────reply text◄─────────────┘
   bridge injects reply into the chat box
```

### Why use the existing extension pattern
- This repo already contains a working content‑script + selectors framework
  (`extension/src/content.js`, `scraper.js`, `selectors.js`,
  `autofill.js`) that reads and writes the Marketplace UI. Adding a
  "read inbound chat → POST to n8n → type reply" loop is an **extension of an
  existing capability**, not a new system.

### What's required
1. **n8n:** one **new inbound webhook node** that accepts the bridge's POST and
   **maps it into the same payload shape** the Messenger trigger already
   produces (sender id, text, timestamp), then hands off to the **existing**
   workflow. No prompt/booking/CRM/Calendar/Telegram changes.
2. **Bridge (extension):** detect new inbound Marketplace messages, POST to the
   n8n endpoint, receive the reply, inject it into the compose box.
3. A shared secret/token on the webhook so only your bridge can call it.

### Limitations / restrictions
- Depends on a **logged‑in browser session** staying open (same constraint the
  README already notes for this tool).
- **DOM‑dependent**: if Facebook changes the Marketplace UI, update
  `selectors.js` (already the documented maintenance path).
- This is **automation of your own logged‑in account**. Keep volume/cadence
  human‑like to respect Facebook's automation and spam policies. Do not use it
  for bulk/mass messaging.
- No delivery/read receipts or rich Messenger features — it's plain chat text.

---

## 4. Identifying the conversation source (Marketplace vs Messenger)

Meta does **not** put a reliable "this came from Marketplace" flag on standard
Messenger webhook events, so identify source by **how it arrived**, then attach
a tag as metadata — without branching the conversation logic:

- **Option A (Page‑routed):** Marketplace‑origin threads sometimes carry a
  referral/`ad_id`/thread context, but this is not guaranteed. The robust
  approach is to add a small **tagging step** in n8n (e.g. set
  `source = "marketplace" | "messenger"` based on available thread metadata)
  **before** the existing workflow runs. Metadata only — booking/CRM logic
  unchanged.
- **Option B (bridge):** the bridge **stamps `source: "marketplace"`** on every
  payload it sends, so the source is known with certainty.

Use the tag only for reporting/CRM labeling, not to alter the conversation
flow.

---

## 5. Meta API limitations & Marketplace‑specific restrictions (summary)

- ❌ **No public Marketplace messaging API** and **no webhook** for
  **personal‑profile** Marketplace chats. This is the hard blocker that forces
  Option B in the common case.
- ✅ **Page** Messenger conversations (incl. Page‑routed Marketplace) are fully
  supported via the standard Messenger Platform webhook + Graph API Send API.
- ⏳ **24‑hour standard messaging window:** outside 24h since the user's last
  message, you can only send within approved message tags / one‑time notify
  rules. (This already applies to the existing chatbot — no new constraint, but
  it also governs Marketplace follow‑ups.)
- 🔁 Page must be **subscribed** to the app and have a valid **Page Access
  Token** and `pages_messaging`.
- 📉 Meta periodically deprecates commerce/catalog endpoints and changes
  Marketplace‑for‑business eligibility — verify current eligibility in Commerce
  Manager before committing to Option A.
- 🤖 Automating a **personal account** (Option B) must stay within Facebook's
  automation/anti‑spam policies: reasonable volume, no mass outreach.

---

## 6. Recommended implementation (decision + steps)

### Decision flow
```
Can the listings route to a Facebook PAGE inbox? (Commerce Manager / eligible category)
        │ yes                                  │ no
        ▼                                      ▼
   OPTION A                                OPTION B
  (zero chatbot changes,            (browser bridge → existing n8n webhook;
   reuse existing webhook)           one new inbound node; chatbot unchanged)
```

**Recommendation:** Try **Option A** first (cleanest, fully supported, no new
webhook). If listings can't be Page‑routed, implement **Option B** using this
repo's existing extension framework.

### Option A — steps
1. Confirm the listings can be created/managed under the existing **Page**
   (check category/region eligibility in **Commerce Manager**).
2. Confirm the Page is subscribed to the app's **`messages`** webhook field and
   the token has **`pages_messaging`** (it already is, since Messenger works).
3. Send a test Marketplace inquiry → verify it appears as a normal Messenger
   event and the **existing** chatbot handles it. Done.
4. *(Optional, additive)* Add a **source‑tagging** step in n8n for reporting.

### Option B — steps
1. In **n8n**, add **one inbound webhook node** + a small **mapper** that
   normalizes the bridge payload into the Messenger‑shaped payload the existing
   workflow expects, then connects to the **existing** workflow entry point.
   Protect it with a shared secret.
2. Extend the **existing Chrome extension** (reuse `content.js` + `selectors.js`)
   to: detect new inbound Marketplace messages → POST to the n8n endpoint →
   receive reply → inject into the compose box. Stamp `source: "marketplace"`.
3. Test end‑to‑end on a real Marketplace thread; tune selectors and reply
   cadence to stay human‑like.
4. Keep the logged‑in browser session running for the bridge to operate.

---

## 7. Deliverables — direct answers

1. **Best integration method:** Route Marketplace into the **Page inbox**
   (Option A) so it uses the existing Messenger webhook unchanged. If
   personal‑profile only, use a **browser bridge** that forwards to the
   existing n8n webhook (Option B). Either way the chatbot is reused, not
   duplicated.
2. **Required Meta/Facebook settings:** Existing **Page** with `pages_messaging`,
   subscribed to the **`messages`** webhook field, valid **Page Access Token**;
   for Option A, listings routed to the Page via **Commerce Manager**/eligible
   category. No new app for Option B (just a secured n8n inbound endpoint).
3. **Can Marketplace use the existing Messenger webhook?** **Yes — for
   Page‑routed Marketplace** (Option A). **No — for personal‑profile
   Marketplace**, which has no webhook/API and needs the browser bridge
   (Option B) into the existing n8n workflow.
4. **Routing changes required?** **None to the chatbot.** Option A: optionally
   add additive source‑tagging. Option B: add **one** inbound webhook +
   normalizer node that feeds the **existing** workflow. No changes to prompts,
   booking, conversation logic, follow‑ups, CRM, Calendar, or Telegram.
5. **Marketplace limitations/restrictions:** No Marketplace messaging API; no
   API/webhook for personal‑profile chats; 24‑hour messaging window applies;
   Page‑routing eligibility is category/region‑limited and subject to Meta
   deprecations; personal‑account automation must respect anti‑spam policies
   and DOM selectors may need maintenance.
6. **Recommended steps:** See §6 — try Option A first; fall back to Option B
   using this repo's existing extension framework. Add Marketplace strictly as
   another **message source** feeding the unchanged chatbot.
