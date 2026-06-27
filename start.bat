@echo off
REM One-command start for Windows. Double-click this file or run: start.bat
cd /d "%~dp0backend"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get it from https://nodejs.org ^(LTS^), then run start.bat again.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing backend dependencies ^(first run only^)...
  call npm install
)

if not exist .env (
  copy .env.example .env >nul
  echo Created backend\.env - add your ANTHROPIC_API_KEY there to enable AI suggestions ^(optional^).
)

echo.
echo Starting backend. Dashboard will be at http://localhost:3333
echo Leave this window open. Press Ctrl+C to stop.
echo.

start "" http://localhost:3333
node src\server.js
