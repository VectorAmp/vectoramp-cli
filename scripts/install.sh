#!/usr/bin/env bash
set -euo pipefail
PACKAGE="${VECTORAMP_CLI_PACKAGE:-@vectoramp/cli}"
if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required to install VectorAmp CLI. Install Node.js 18+ first." >&2
  exit 1
fi
npm install -g "$PACKAGE"
echo "Installed VectorAmp CLI. Run: vectoramp --help"
