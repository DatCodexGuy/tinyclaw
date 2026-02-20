#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${TINYCLAW_REPO_DIR:-$SCRIPT_DIR}"
BRANCH="${1:-${TINYCLAW_UPDATE_BRANCH:-feat/team-autonomy-routing}}"

cd "$REPO_DIR"

echo "[1/6] Stashing local changes (if any)..."
git stash push -u -m "autostash-before-update-$(date +%s)" >/dev/null || true

echo "[2/6] Fetching latest..."
git fetch origin

echo "[3/6] Checking out $BRANCH..."
git checkout "$BRANCH"

echo "[4/6] Pulling..."
git pull --ff-only origin "$BRANCH"

echo "[5/6] Rebuilding..."
npm ci
npm run build

echo "[6/6] Restarting TinyClaw..."
./tinyclaw.sh restart

echo "Done."

