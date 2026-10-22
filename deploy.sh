#!/usr/bin/env sh
set -eu
if ! command -v go >/dev/null 2>&1; then
  echo "Go is required. Install Go 1.25+ and restart your terminal." >&2
  exit 1
fi
REPO_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$REPO_DIR/backend"
exec go run ./cmd/deploy
