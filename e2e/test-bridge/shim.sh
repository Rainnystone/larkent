#!/usr/bin/env bash
set -euo pipefail

if [[ "${OS:-}" == "Windows_NT" ]]; then
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

if [[ ! -s "$DECISION_FILE" ]]; then
  echo "shim decision file was empty" >&2
  exit 2
fi

mapfile -t LINES < "$DECISION_FILE"
ACTION="${LINES[0]:-}"

case "$ACTION" in
  EXEC)
    TARGET="${LINES[1]:-}"
    if [[ -z "$TARGET" ]]; then
      echo "shim exec is missing a target" >&2
      exit 2
    fi
    exec "$TARGET" "${LINES[@]:2}"
    ;;
  FAULT)
    MODE="${LINES[1]:-}"
    TARGET="${LINES[2]:-}"
    trap 'exit 143' TERM
    trap 'exit 130' INT
    trap 'exit 129' HUP
    if [[ "$MODE" == delay:* ]]; then
      SECONDS_STR="${MODE#delay:}"
      sleep "$SECONDS_STR"
      exec "$TARGET" "${LINES[@]:3}"
    fi
    if [[ "$MODE" == hang ]]; then
      while true; do sleep 3600; done
    fi
    exec "$TSX" "$DIR/run-fault.ts" --mode "$MODE" -- "$TARGET" "${LINES[@]:3}"
    ;;
  *)
    echo "unknown shim action: $ACTION" >&2
    exit 2
    ;;
esac
