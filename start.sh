#!/usr/bin/env bash
# One-command start for Mac/Linux. Run: ./start.sh
set -e
cd "$(dirname "$0")/backend"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Get it from https://nodejs.org (LTS), then run ./start.sh again."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Installing backend dependencies (first run only)..."
  npm install
fi

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created backend/.env — add your ANTHROPIC_API_KEY there to enable AI suggestions (optional)."
fi

echo ""
echo "Starting backend. Dashboard will be at http://localhost:3333"
echo "Leave this window open. Press Ctrl+C to stop."
echo ""

# Open the dashboard in the default browser (best effort)
( sleep 2
  if command -v open >/dev/null 2>&1; then open http://localhost:3333
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open http://localhost:3333
  fi ) >/dev/null 2>&1 &

node src/server.js
