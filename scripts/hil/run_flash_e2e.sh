#!/usr/bin/env bash
# End-to-end flasher HIL: the real NexusCAN stack (crates/nexus-hal PipelineEngine + SocketCAN
# driver + nexus-protocols UDS/ISO-TP/flash engine) against the independent nexus-ecu-sim on
# vcan0 (0x7E0 / 0x7E8). Each test case spawns its own simulator with the fault flags it needs
# (crates/nexus-hal/tests/flash_e2e_vcan.rs).
#
# Rootless: runs inside a user + network + MOUNT namespace (`unshare -rnm`) with its own vcan0
# and a remounted /sys. The mount namespace is required: NexusCAN's SocketCAN driver discovers
# interfaces through /sys/class/net, which under a plain `unshare -rn` still shows the host's
# interfaces. The namespace is preferred even when the host has vcan0, so the 0x7E0 / 0x7E8
# traffic never collides with a manual ECU on the host bus. NEXUS_FLASH_E2E_HOST=1 uses the
# host's vcan0 instead.
#
# False-pass guard: NEXUS_HIL_REQUIRE=1 turns every skip into a failure, and this script also
# requires the expected number of tests to have run and passed (unless a filter is given).
#
#   scripts/hil/run_flash_e2e.sh                    # whole matrix
#   scripts/hil/run_flash_e2e.sh fault_nrc          # one case (filter)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
TEST_FILE=crates/nexus-hal/tests/flash_e2e_vcan.rs

echo "[1/3] building nexus-ecu-sim binaries + flash_e2e_vcan test"
cargo build -p nexus-ecu-sim --bins
cargo test -p nexus-hal --test flash_e2e_vcan --no-run
TARGET_DIR="$(cargo metadata --format-version 1 --no-deps | python3 -c 'import json,sys;print(json.load(sys.stdin)["target_directory"])')"
export NEXUS_ECU_SIM_DIR="$TARGET_DIR/debug"
for b in nexus-ecu-sim nexus-flash-compare; do
  [[ -x "$NEXUS_ECU_SIM_DIR/$b" ]] || { echo "[ERR] $NEXUS_ECU_SIM_DIR/$b missing" >&2; exit 1; }
done

FILTER=()
if [[ $# -gt 0 && "$1" != "--" ]]; then FILTER=("$1"); shift; fi
[[ "${1:-}" == "--" ]] && shift
TEST_CMD=(env NEXUS_HIL_REQUIRE=1 NEXUS_ECU_SIM_DIR="$NEXUS_ECU_SIM_DIR"
  cargo test --offline -p nexus-hal --test flash_e2e_vcan -- --ignored --test-threads=1 --nocapture
  "${FILTER[@]}" "$@")

LOG="$(mktemp -t nexus-flash-e2e.XXXXXX.log)"
run() {
  set +e
  "$@" 2>&1 | tee "$LOG"
  local rc=${PIPESTATUS[0]}
  set -e
  return "$rc"
}

echo "[2/3] running (log: $LOG)"
if [[ "${NEXUS_FLASH_E2E_HOST:-0}" == "1" ]] && ip link show vcan0 >/dev/null 2>&1; then
  run "${TEST_CMD[@]}" || rc=$?
elif unshare -rnm true 2>/dev/null; then
  run unshare -rnm bash -c '
    set -e
    mount -t sysfs sysfs /sys
    ip link add dev vcan0 type vcan
    ip link set vcan0 mtu 72
    ip link set up vcan0
    ip -details link show vcan0 | head -1
    exec "$@"
  ' _ "${TEST_CMD[@]}" || rc=$?
elif sudo -n true 2>/dev/null; then
  "$ROOT/scripts/hil/vcan_up.sh" vcan0
  run "${TEST_CMD[@]}" || rc=$?
else
  echo "[ERR] cannot create vcan0: no unprivileged user namespaces and no passwordless sudo" >&2
  exit 1
fi
rc=${rc:-0}

echo "[3/3] false-pass guard"
if grep -q "SKIP (flash e2e HIL)" "$LOG"; then
  echo "[FAIL] a test skipped" >&2; exit 1
fi
passed=$(grep -Eo 'test result: [a-zA-Z]+\. [0-9]+ passed' "$LOG" | grep -Eo '[0-9]+ passed' | grep -Eo '[0-9]+' | tail -1 || echo 0)
if [[ ${#FILTER[@]} -eq 0 ]]; then
  expected=$(grep -c '^#\[ignore = "needs vcan0' "$TEST_FILE")
  if [[ "$rc" -eq 0 && "$passed" -ne "$expected" ]]; then
    echo "[FAIL] expected $expected tests to pass, saw $passed" >&2; exit 1
  fi
elif [[ "$rc" -eq 0 && "$passed" -eq 0 ]]; then
  echo "[FAIL] filter '${FILTER[0]}' ran no test" >&2; exit 1
fi
grep -o 'EVIDENCE.*' "$LOG" || true
echo "exit=$rc passed=$passed"
exit "$rc"
