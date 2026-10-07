#!/bin/sh
# One-shot verification entry point for operators/CI.
#
# Builds the images, starts the API stack, waits for the API health check,
# runs the `verify` service (build checks + unit tests + HTTP smoke tests
# against the live API), and propagates its exit code. Tears the stack
# down afterwards.
#
# Host port is configurable: PNG_AUDIT_PORT=9090 ./verify.sh
set -eu

COMPOSE="docker compose"

# Pick an explicit compose invocation if the plugin is unavailable.
if ! $COMPOSE version >/dev/null 2>&1; then
  if command -v docker-compose >/dev/null 2>&1; then
    COMPOSE="docker-compose"
  else
    echo "docker compose is required" >&2
    exit 127
  fi
fi

export PNG_AUDIT_PORT="${PNG_AUDIT_PORT:-8080}"

cleanup() {
  $COMPOSE down --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

echo "==> building images"
$COMPOSE build

echo "==> running one-shot verify (API health is awaited by Compose)"
set +e
$COMPOSE up --build --abort-on-container-exit --exit-code-from verify verify
rc=$?
set -e

if [ "$rc" -eq 0 ]; then
  echo "==> verify succeeded (exit 0)"
else
  echo "==> verify FAILED (exit $rc)" >&2
fi
exit "$rc"
