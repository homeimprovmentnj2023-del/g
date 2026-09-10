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

## Google Ads Customer Match export

Turns a customer export into a Google Ads Customer Match upload: keeps only
jobs that actually completed, trims to a date window, removes duplicates, and
SHA-256 hashes every identifier before anything is written to disk.

```bash
cd backend
node src/bin/build-customer-match.js customers.csv --days 30 --preview
```

`--preview` writes nothing and prints which rows were dropped and why. Run it
first — a mis-detected status column or an unparsed date format shows up there
rather than in a bad upload. Drop `--preview` to write the files.

Accepts a CSV/JSON export (column names are auto-detected — `Phone Number`,
`Job Status`, `Completion Date` and many aliases) or a Telegram Desktop JSON
chat export, from which it extracts one candidate record per message containing
a phone number.

| Flag | |
|---|---|
| `--days N` | window in days (default 30, `0` for no date filter) |
| `--preview` | report only, write nothing |
| `--out DIR` | output dir (default `backend/data/customer-match`) |
| `--completed-if-value` | treat any record with a value > 0 as a completed job |
| `--assume-completed` | treat every record as completed (only when the export has no status column at all) |
| `--customer-id` / `--user-list-id` | fill into the generated API plan |
| `--country` | ISO-2 country for address matching (default `US`) |

Four files are written:

- `*.api.json` — the three Google Ads API calls in order (create job → add members → run)
- `*.operations.json` — just the `addOperations` body
- `*.csv` — hashed CSV for the Google Ads UI uploader, if you'd rather not use the API
- `*.report.json` — counts and the full list of dropped rows with reasons

### Notes

- **Only completed jobs are included.** Rows whose status reads as a quote,
  lead, cancellation or no-show are excluded, and a row whose status can't be
  recognized is dropped rather than guessed at.
- **`countryCode` and `postalCode` are sent unhashed** — that is what Google
  expects. Hashing them produces a 0% match rate with no error message.
- **Address matching needs first name, last name, country and ZIP together.**
  Any one missing makes that identifier inert, so those rows fall back to phone.
- **Customer Match lists need roughly 1,000 matched members before they serve**,
  and only a fraction of any list matches. A 30-day window from a small
  operation will not reach it — widen `--days` for the list itself.
- Output goes under `backend/data/`, which is gitignored. The CSV contains
  hashes only; raw phone numbers and names never leave the machine.

## Limitations

- Facebook Marketplace has no public API. This tool works through your logged-in browser session.
- Publishing to multiple ZIP codes requires navigating to each location in the FB UI; the extension automates this sequence.
- AI suggestions require an Anthropic API key (free tier is sufficient for low volume).
- Facebook may update their UI; if the extension stops reading data, check `extension/src/selectors.js` and update CSS selectors.
