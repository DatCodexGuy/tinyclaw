#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${1:-/root/tinyclaw}"
DEFAULT_BRANCH="${TINYCLAW_UPDATE_BRANCH:-feat/team-autonomy-routing}"
TARGET_FILE="$INSTALL_DIR/update.sh"

if [ ! -d "$INSTALL_DIR" ]; then
    echo "error: install directory not found: $INSTALL_DIR"
    echo "hint: pass the repo path explicitly, e.g. scripts/install-update-helper.sh /root/tinyclaw"
    exit 1
fi

cat >"$TARGET_FILE" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${TINYCLAW_REPO_DIR:-/root/tinyclaw}"
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
EOF

chmod +x "$TARGET_FILE"

echo "installed: $TARGET_FILE"
echo "default branch: $DEFAULT_BRANCH"
echo "usage: cd $INSTALL_DIR && ./update.sh [branch]"
echo "tip: export TINYCLAW_UPDATE_BRANCH=$DEFAULT_BRANCH"

