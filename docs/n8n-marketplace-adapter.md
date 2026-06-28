# n8n Marketplace Adapter — reuse the existing chatbot, no duplication

This is the **only** n8n change needed to bring Marketplace into your existing
chatbot. It is a **thin adapter workflow** that:

1. receives the Marketplace message from the local backend bridge,
2. normalizes it into the **same payload shape** your Messenger trigger already
   produces,
3. hands it to your **existing chatbot logic** (called as a sub-workflow — your
   prompts, booking, CRM, Calendar, follow-ups, Telegram run unchanged), and
4. returns the bot's reply text to the bridge, which types it into the
   Marketplace chat.

**Nothing in your current workflow is rewritten.** You add one new workflow and,
at most, make one tiny change to where replies are sent (see "If your chatbot is
one monolithic workflow" below).

---

## Data flow

```
Marketplace chat (browser)
   → extension marketplace-chat.js
   → POST localhost:3333 /api/marketplace/incoming   (backend relay)
   → POST n8n  /webhook/marketplace-incoming          (THIS adapter)
        → normalize → [ your existing chatbot brain ] → reply text
   → Respond to Webhook (reply)
   → backend returns reply → extension types it into the chat
```

The bridge sends this JSON to the adapter webhook:

```json
{
  "source": "marketplace",
  "sender_id": "<marketplace thread id>",
  "thread_id": "<marketplace thread id>",
  "sender_name": "<buyer name or null>",
  "text": "<the buyer's message>",
  "timestamp": "<ISO-8601>"
}
```

Header `X-Bridge-Secret: <N8N_SHARED_SECRET>` is included if you set the secret.

---

## Recommended structure (cleanest, zero edits to the brain)

Best case: your existing chatbot's "brain" (intent → prompt → booking/CRM/
calendar logic) is, or can be, a **callable sub-workflow** that takes a message +
conversation id and returns reply text. Then the adapter is 4 nodes:

1. **Webhook** (POST, path `marketplace-incoming`, "Respond using Respond to
   Webhook" mode).
2. **IF / Code — verify secret** (optional): compare
   `{{$json.headers["x-bridge-secret"]}}` to your secret; reject otherwise.
3. **Set — normalize**: map the bridge payload to the exact field names your
   chatbot expects. Examples (rename right-hand side to match YOUR workflow):
   - `senderId`      = `{{$json.body.sender_id}}`
   - `conversationId`= `{{$json.body.thread_id}}`
   - `messageText`   = `{{$json.body.text}}`
   - `channel`       = `marketplace`  ← tag for CRM/reporting only
4. **Execute Workflow** → your existing chatbot workflow (returns reply text).
5. **Respond to Webhook**: body `{ "reply": "{{ $json.reply }}" }`.

Because you call the existing workflow with **Execute Workflow**, the prompts and
logic are reused verbatim — nothing is copied.

---

## If your chatbot is ONE monolithic workflow that ends by calling Messenger Send API

Marketplace has no Messenger thread, so the Send API step can't deliver the
reply. The **smallest possible** change that keeps everything else intact:

- Add an **IF node right before the final "send" step**, keyed on
  `channel === "marketplace"` (the tag you set in step 3 / the bridge's
  `source`):
  - **false (Messenger):** → existing Messenger Send API node (unchanged).
  - **true (Marketplace):** → **Respond to Webhook** with the reply text.

That single IF is the only structural change. Prompts, booking logic,
conversation logic, follow-ups, CRM, and Calendar/Telegram nodes are untouched —
you're only choosing *how the already-computed reply leaves the workflow*.

> Tip: if you'd rather not touch the monolith at all, extract its core into a
> sub-workflow once and have BOTH the Messenger trigger and this adapter call it.
> Same prompts, called from two entry points — still no duplication.

---

## Importable starter (the adapter workflow)

Import this in n8n (Workflows → Import from File/Clipboard), then point the
**Execute Workflow** node at your existing chatbot and fix the field names in the
**Set** node to match it.

```json
{
  "name": "Marketplace Adapter (bridge → existing chatbot)",
  "nodes": [
    {
      "parameters": {
        "httpMethod": "POST",
        "path": "marketplace-incoming",
        "responseMode": "responseNode",
        "options": {}
      },
      "id": "webhook",
      "name": "Marketplace Webhook",
      "type": "n8n-nodes-base.webhook",
      "typeVersion": 2,
      "position": [240, 300]
    },
    {
      "parameters": {
        "conditions": {
          "options": { "caseSensitive": true },
          "combinator": "and",
          "conditions": [
            {
              "leftValue": "={{ $json.headers['x-bridge-secret'] }}",
              "rightValue": "REPLACE_WITH_N8N_SHARED_SECRET",
              "operator": { "type": "string", "operation": "equals" }
            }
          ]
        },
        "options": {}
      },
      "id": "verify",
      "name": "Verify Secret",
      "type": "n8n-nodes-base.if",
      "typeVersion": 2,
      "position": [460, 300]
    },
    {
      "parameters": {
        "assignments": {
          "assignments": [
            { "id": "a1", "name": "conversationId", "value": "={{ $json.body.thread_id }}", "type": "string" },
            { "id": "a2", "name": "senderId", "value": "={{ $json.body.sender_id }}", "type": "string" },
            { "id": "a3", "name": "senderName", "value": "={{ $json.body.sender_name }}", "type": "string" },
            { "id": "a4", "name": "messageText", "value": "={{ $json.body.text }}", "type": "string" },
            { "id": "a5", "name": "channel", "value": "marketplace", "type": "string" }
          ]
        },
        "options": {}
      },
      "id": "normalize",
      "name": "Normalize → chatbot shape",
      "type": "n8n-nodes-base.set",
      "typeVersion": 3.4,
      "position": [680, 240]
    },
    {
      "parameters": {
        "source": "database",
        "workflowId": "REPLACE_WITH_EXISTING_CHATBOT_WORKFLOW_ID",
        "options": {}
      },
      "id": "callbrain",
      "name": "Existing Chatbot (sub-workflow)",
      "type": "n8n-nodes-base.executeWorkflow",
      "typeVersion": 1.2,
      "position": [900, 240]
    },
    {
      "parameters": {
        "respondWith": "json",
        "responseBody": "={{ { \"reply\": $json.reply || $json.text || $json.output } }}",
        "options": {}
      },
      "id": "respond",
      "name": "Respond to bridge",
      "type": "n8n-nodes-base.respondToWebhook",
      "typeVersion": 1.1,
      "position": [1120, 240]
    },
    {
      "parameters": {
        "respondWith": "json",
        "responseCode": 401,
        "responseBody": "={{ { \"error\": \"unauthorized\" } }}",
        "options": {}
      },
      "id": "reject",
      "name": "Reject",
      "type": "n8n-nodes-base.respondToWebhook",
      "typeVersion": 1.1,
      "position": [680, 420]
    }
  ],
  "connections": {
    "Marketplace Webhook": { "main": [[{ "node": "Verify Secret", "type": "main", "index": 0 }]] },
    "Verify Secret": {
      "main": [
        [{ "node": "Normalize → chatbot shape", "type": "main", "index": 0 }],
        [{ "node": "Reject", "type": "main", "index": 0 }]
      ]
    },
    "Normalize → chatbot shape": { "main": [[{ "node": "Existing Chatbot (sub-workflow)", "type": "main", "index": 0 }]] },
    "Existing Chatbot (sub-workflow)": { "main": [[{ "node": "Respond to bridge", "type": "main", "index": 0 }]] }
  },
  "settings": {}
}
```

After importing:
1. **Verify Secret** node → set `rightValue` to your `N8N_SHARED_SECRET`.
2. **Existing Chatbot** node → select your real chatbot workflow.
3. **Normalize** node → rename the output fields to whatever your chatbot
   actually reads, and make sure the chatbot returns reply text under
   `reply` / `text` / `output` (or adjust the Respond node).
4. Activate the workflow and copy its **production webhook URL** into
   `backend/.env` → `N8N_WEBHOOK_URL`.

---

## Setup checklist

1. `backend/.env`: set `N8N_WEBHOOK_URL` and `N8N_SHARED_SECRET`, restart the
   backend.
2. n8n: import + wire the adapter above (or add the single IF if monolithic).
3. Extension: reload it (`chrome://extensions` → reload). Open the Marketplace
   inbox. The bridge starts in **suggest mode** — it types the reply but doesn't
   send. Verify a real thread end-to-end.
4. When satisfied, enable auto-send: in the extension service-worker console run
   `chrome.storage.local.set({ mpAutoSend: true })` (or flip `CONFIG.autoSend`
   in `marketplace-chat.js`).
5. If messages aren't detected, open the Marketplace inbox and use the sidebar's
   **Capture Form (debug)** button, then adjust `window.FBM_SELECTORS.chat` in
   `extension/src/selectors.js`.

## Operating notes / limits

- A **logged-in browser session must stay open** for the bridge to work; replies
  only happen while the inbox page is open.
- Keep cadence human-like; this automates a **personal** account, so respect
  Facebook's anti-spam/automation policies. No bulk outreach.
- Marketplace chat DOM changes often → `selectors.js` is the single fix point.
- The chatbot itself, its prompts, booking, follow-ups, CRM, Calendar, and
  Telegram are never modified by any of this.
