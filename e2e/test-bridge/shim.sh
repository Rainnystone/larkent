#!/usr/bin/env bash
# POSIX/bash-3.2 compatible (macOS ships bash 3.2). No mapfile or ${arr[@]:n}.
set -euo pipefail

if [ "${OS:-}" = "Windows_NT" ]; then
  echo "test-bridge shim is POSIX-only" >&2
  exit 2
fi

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${LARKENT_E2E_REPO_ROOT:-$(cd "$DIR/../.." && pwd)}"
TSX="${LARKENT_E2E_TSX:-$REPO/node_modules/.bin/tsx}"
FAULT_DIR="${LARKENT_E2E_FAULT_DIR:?LARKENT_E2E_FAULT_DIR is required}"
mkdir -p "$FAULT_DIR"
DECISION_FILE="$FAULT_DIR/last-decision-$$.txt"

cleanup_decision() {
  rm -f "$DECISION_FILE"
}
trap cleanup_decision EXIT

# Do not let the decision process consume the runner's stdin.
(
  cd "$REPO"
  "$TSX" "$DIR/decide.ts" --decision-file "$DECISION_FILE" -- "$@"
) < /dev/null

if [ ! -s "$DECISION_FILE" ]; then
  echo "shim decision file was empty" >&2
  exit 2
fi

# JSON decision keeps multiline prompts as one argv entry. exec-decision
# reconstructs the real CLI spawn from that object.
exec "$TSX" "$DIR/exec-decision.ts" "$DECISION_FILE"
