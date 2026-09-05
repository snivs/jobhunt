#!/usr/bin/env bash
# One-shot setup for a workstation or VPS.
# Usage: bash scripts/setup.sh [/path/to/project]   (default: this repository)
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$ROOT"

echo "== 1. Node dependencies"
npm ci --silent || npm install --silent

echo "== 2. Environment"
if [[ ! -f .env ]]; then
  cp .env.example .env
  chmod 600 .env || true
  echo "   created .env from .env.example (edit OBSIDIAN_VAULT_PATH / API keys as needed)"
fi
set -a; . ./.env; set +a

echo "== 3. Build + migrate"
npm run build --silent
npm run jobhunt --silent -- db:migrate >/dev/null
npm run jobhunt --silent -- sources:sync >/dev/null
npm run jobhunt --silent -- config:check | head -20

echo "== 4. obsidian-second-brain plugin"
bash scripts/ensure-second-brain.sh

echo "== 5. Vault"
VAULT="${OBSIDIAN_VAULT_PATH:-$ROOT/vault}"
if [[ ! -f "$VAULT/_CLAUDE.md" ]]; then
  PLUGIN_ROOT="$(ls -d "$HOME"/.claude/plugins/cache/obsidian-second-brain/obsidian-second-brain/* 2>/dev/null | tail -1 || true)"
  if [[ -n "$PLUGIN_ROOT" ]]; then
    uv run --no-project python "$PLUGIN_ROOT/scripts/bootstrap_vault.py" --path "$VAULT" --name "${JOBHUNT_OWNER_NAME:-Owner}" --preset builder
    node scripts/init-vault.mjs "$VAULT"
  else
    echo "   plugin root not found; create the vault manually with bootstrap_vault.py"
  fi
else
  echo "   vault exists at $VAULT"
fi
if [[ ! -d "$VAULT/.git" ]]; then
  (cd "$VAULT" && git init -q && git add -A && git commit -qm "vault: initial structure" && echo "   vault git initialized")
fi

echo "== 6. Tests"
npm test --silent 2>&1 | tail -3

echo
echo "Done. Next: open Claude Code in $ROOT and run /jobhunt-interview (first time) or /loop /jobhunt-run."
