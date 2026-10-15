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

ACTION=""
MODE=""
TARGET=""
set --
line_no=0
while IFS= read -r line || [ -n "$line" ]; do
  line_no=$((line_no + 1))
  if [ "$line_no" -eq 1 ]; then
    ACTION=$line
  elif [ "$line_no" -eq 2 ]; then
    if [ "$ACTION" = "EXEC" ]; then
      TARGET=$line
    else
      MODE=$line
    fi
  elif [ "$line_no" -eq 3 ] && [ "$ACTION" = "FAULT" ]; then
    TARGET=$line
  else
    set -- "$@" "$line"
  fi
done < "$DECISION_FILE"

case "$ACTION" in
  EXEC)
    if [ -z "$TARGET" ]; then
      echo "shim exec is missing a target" >&2
      exit 2
    fi
    exec "$TARGET" "$@"
    ;;
  FAULT)
    trap 'exit 143' TERM
    trap 'exit 130' INT
    trap 'exit 129' HUP
    case "$MODE" in
      delay:*)
        SECONDS_STR="${MODE#delay:}"
        sleep "$SECONDS_STR"
        exec "$TARGET" "$@"
        ;;
      hang)
        while true; do sleep 3600; done
        ;;
      *)
        exec "$TSX" "$DIR/run-fault.ts" --mode "$MODE" -- "$TARGET" "$@"
        ;;
    esac
    ;;
  *)
    echo "unknown shim action: $ACTION" >&2
    exit 2
    ;;
esac
