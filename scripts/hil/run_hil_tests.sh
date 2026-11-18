#!/usr/bin/env bash
# Runs the nexus-ecu-sim Layer-1 HIL integration tests (vcan0).
#
# Strategy (first that works):
#   1. vcan0 already exists               -> run directly
#   2. passwordless sudo                  -> scripts/hil/vcan_up.sh, run
#   3. unprivileged user+net namespace    -> `unshare -rn`, create vcan0
#      inside the namespace (no root, nothing changes on the host), run
#
# Extra args are passed to the test binary, e.g.:
#   scripts/hil/run_hil_tests.sh fault_drop -- --nocapture
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

echo "[1/2] building nexus-ecu-sim + tests"
cargo build -p nexus-ecu-sim --bins
cargo test -p nexus-ecu-sim --no-run

TEST_CMD=(env NEXUS_HIL_REQUIRE=1 cargo test --offline -p nexus-ecu-sim --test hil_vcan -- --ignored --test-threads=16 "$@")

if ip link show vcan0 >/dev/null 2>&1; then
  echo "[2/2] vcan0 present on host — running HIL tests"
  exec "${TEST_CMD[@]}"
fi

if sudo -n true 2>/dev/null; then
  echo "[2/2] creating vcan0 with sudo"
  "$ROOT/scripts/hil/vcan_up.sh" vcan0
  exec "${TEST_CMD[@]}"
fi

if unshare -rn true 2>/dev/null; then
  echo "[2/2] no sudo: running inside an unprivileged user+net namespace with its own vcan0"
  # The vcan / can_isotp modules are auto-loaded by the kernel on first use.
  exec unshare -rn bash -c '
    set -e
    ip link add dev vcan0 type vcan
    ip link set vcan0 mtu 72 2>/dev/null || true
    ip link set up vcan0
    ip -details link show vcan0 | head -2
    exec "$@"
  ' _ "${TEST_CMD[@]}"
fi

cat >&2 <<MSG
[ERR] cannot create vcan0: no passwordless sudo and unprivileged user
      namespaces are disabled. Run once:
          sudo $ROOT/scripts/hil/vcan_up.sh
      then re-run this script.
MSG
exit 1
