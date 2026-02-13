#!/usr/bin/env bash
set -euo pipefail

REMOTE_HOST="root@67.205.138.129"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"
REMOTE_DIR="/var/www/rwasonar"
LOCAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

DRY_RUN=""
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN="--dry-run"
fi

echo "Ensuring remote directory exists: ${REMOTE_DIR}"
ssh -i "$SSH_KEY" "$REMOTE_HOST" "mkdir -p '$REMOTE_DIR'"

echo "Deploying ${LOCAL_DIR} -> ${REMOTE_HOST}:${REMOTE_DIR}"
rsync -az --delete $DRY_RUN \
  --exclude ".git/" \
  --exclude ".DS_Store" \
  --exclude "deploy-to-server.sh" \
  -e "ssh -i $SSH_KEY" \
  "$LOCAL_DIR/" "$REMOTE_HOST:$REMOTE_DIR/"

echo "Done."
