# Facebook Marketplace Automation

A lightweight system to manage, monitor, and optimize Facebook Marketplace listings using a Chrome extension and a local backend.

## Architecture

```
extension/   Chrome extension — runs on facebook.com/marketplace
backend/     Local Node.js server (port 3333) — storage, AI, scheduling
dashboard/   Web UI served by the backend
```

## How It Works

1. **Extension** injects a sidebar into Facebook Marketplace. It reads listing data directly from the page (no scraping API needed) and can auto-fill the create-listing form from saved templates.
2. **Backend** stores everything in a local SQLite database. It polls the extension (via background script) to detect listing status changes and sends browser notifications when something goes inactive.
3. **AI suggestions** call the Claude API to recommend better titles, descriptions, pricing, and posting times based on your listing history and competitor data.

## Setup

### Backend

```bash
cd backend
npm install
cp .env.example .env          # add your ANTHROPIC_API_KEY
node src/server.js
```

Dashboard opens at http://localhost:3333

### Extension

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** → select the `extension/` folder
4. Visit `facebook.com/marketplace` — the sidebar appears automatically

## Features

- **Templates** — save titles, descriptions, prices, and photos; publish in one click
- **Monitoring** — detects expired/removed listings and sends desktop notifications
- **Competitor analysis** — tracks visible competitor listings (price, title, category, activity)
- **AI suggestions** — better copy, pricing, and posting-time recommendations
- **Area analytics** — shows which ZIP codes generate the most inquiries
- **Listing history** — full log of every listing and status change

## Limitations

- Facebook Marketplace has no public API. This tool works through your logged-in browser session.
- Publishing to multiple ZIP codes requires navigating to each location in the FB UI; the extension automates this sequence.
- AI suggestions require an Anthropic API key (free tier is sufficient for low volume).
- Facebook may update their UI; if the extension stops reading data, check `extension/src/selectors.js` and update CSS selectors.
