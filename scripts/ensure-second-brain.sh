#!/usr/bin/env bash
# Installs (or verifies) the obsidian-second-brain Claude Code plugin at user scope. Idempotent.
set -euo pipefail

if claude plugin list 2>/dev/null | grep -q "obsidian-second-brain@obsidian-second-brain"; then
  echo "[second-brain] plugin already installed"
  exit 0
fi

echo "[second-brain] adding marketplace and installing plugin..."
claude plugin marketplace add eugeniughelbur/obsidian-second-brain >/dev/null 2>&1 || true
claude plugin install obsidian-second-brain@obsidian-second-brain --scope user
claude plugin list | grep -A3 "obsidian-second-brain" || true
