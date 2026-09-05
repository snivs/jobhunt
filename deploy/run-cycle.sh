#!/usr/bin/env bash
# Runs ONE pipeline cycle headlessly with Claude Code.
# Usage: deploy/run-cycle.sh [scheduled|manual]
#
# Slash commands do not expand in `claude -p`, so we hand Claude the skill file and ask it to
# carry out its instructions. State lives in SQLite + the vault; the lock in SQLite prevents
# overlapping cycles even if the timer fires while a previous cycle is still running.
set -euo pipefail

TRIGGER="${1:-scheduled}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ -f .env ]]; then
  set -a; . ./.env; set +a
fi

# Make sure the MCP server is built and the schema is current before Claude starts.
if [[ ! -f dist/mcp/server.js ]] || [[ src -nt dist/mcp/server.js ]]; then
  npm run build --silent
fi
npm run jobhunt --silent -- db:migrate >/dev/null

STATUS="$(npm run jobhunt --silent -- schedule:status)"
echo "[jobhunt] schedule status: $(echo "$STATUS" | tr -d '\n' | cut -c1-300)"

PROMPT="You are running the Autonomous Job Hunter headlessly (trigger: ${TRIGGER}). \
Read the file .claude/skills/jobhunt-run/SKILL.md in the current project and carry out its instructions exactly, \
using the jobhunt-db MCP tools. Use trigger '${TRIGGER}' when calling create_search_run. \
If the run is skipped (no slot due or overlapping run), report the reason and stop. \
Write all user-facing text in Spanish (Mexico). Do not ask questions; if user input is required, \
record it with the tools and finish the cycle."

exec claude -p "$PROMPT" --dangerously-skip-permissions --output-format text
