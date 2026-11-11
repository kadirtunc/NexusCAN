#!/usr/bin/env bash
# NexusCAN HIL bench: build the virtual ECU, verify it with an independent UDS client.
#
#   tests/hil/run.sh               # release build + ASan/UBSan build, full suite on both
#   tests/hil/run.sh --no-asan     # release build only
#   tests/hil/run.sh -- -k flash   # extra arguments after "--" go to pytest
#
# Env: ECUSIM_IFACE (default vcan0)
#      ECUSIM_REQ/ECUSIM_RESP/ECUSIM_FUNC  classic conformance ids (default 0x7E0/0x7E8/0x7DF);
#                                          move them when another ECU already answers there
#      NEXUS_BRIDGE_BIN (default target/release/nexus_bridge), NEXUS_TEST_BRIDGE_ADDR
#      (default 127.0.0.1:14298) for the product tests (test_product_*.py)
set -uo pipefail

HIL="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IFACE="${ECUSIM_IFACE:-vcan0}"
ASAN=1
PYTEST_ARGS=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        --no-asan) ASAN=0 ;;
        --) shift; PYTEST_ARGS=("$@"); break ;;
        -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
        *) echo "unknown option $1" >&2; exit 2 ;;
    esac
    shift
done

say() { printf '\n== %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 2; }

# ---------------------------------------------------------------- environment
say "environment"
ip link show "$IFACE" >/dev/null 2>&1 || die "$IFACE missing (see scripts/setup_vcan.sh)"
ip link show "$IFACE" | grep -q "UP" || die "$IFACE is down"
MTU=$(cat "/sys/class/net/$IFACE/mtu")
echo "$IFACE up, mtu $MTU"
[[ "$MTU" == "72" ]] || echo "WARNING: mtu $MTU != 72 - CAN-FD tests will fail"
isotp_ok() { python3 -c 'import socket; socket.socket(socket.AF_CAN, socket.SOCK_DGRAM, socket.CAN_ISOTP).close()' 2>/dev/null; }
if ! isotp_ok; then
    sudo -n modprobe can-isotp 2>/dev/null || true
    isotp_ok || die "kernel ISO-TP (can-isotp) unavailable and 'sudo -n modprobe can-isotp' failed"
fi
echo "kernel CAN_ISOTP sockets OK"
for t in candump isotpdump make gcc; do command -v "$t" >/dev/null || die "$t not found"; done

# ---------------------------------------------------------------- venv
say "python venv"
VENV="$HIL/.venv"
[[ -x "$VENV/bin/python" ]] || python3 -m venv "$VENV" || die "venv creation failed"
STAMP="$VENV/.requirements.sha256"
WANT=$(sha256sum "$HIL/requirements.txt" | cut -d' ' -f1)
if [[ "$(cat "$STAMP" 2>/dev/null)" != "$WANT" ]]; then
    "$VENV/bin/pip" install -q --disable-pip-version-check -r "$HIL/requirements.txt" || die "pip install failed"
    echo "$WANT" > "$STAMP"
fi
"$VENV/bin/python" -c 'import udsoncan, isotp, can, pytest; print("udsoncan", udsoncan.__version__ if hasattr(udsoncan,"__version__") else "?", "| python-can", can.__version__, "| pytest", pytest.__version__)'

# ---------------------------------------------------------------- build
say "build ecusim (-Wall -Wextra -Werror)"
make -C "$HIL/ecusim" -s || die "ecusim build failed"
if [[ $ASAN == 1 ]]; then
    make -C "$HIL/ecusim" -s asan || die "ecusim ASan build failed"
fi

# ---------------------------------------------------------------- product (D-003)
say "nexus_bridge (product tests: test_product_*.py)"
REPO="$(cd "$HIL/../.." && pwd)"
BRIDGE_BIN="${NEXUS_BRIDGE_BIN:-$REPO/target/release/nexus_bridge}"
if [[ ! -x "$BRIDGE_BIN" ]]; then
    ( cd "$REPO" && cargo build --release -q -p nexus-hal --bin nexus_bridge ) || die "nexus_bridge build failed"
fi
echo "$BRIDGE_BIN"
export NEXUS_BRIDGE_BIN="$BRIDGE_BIN"

# ---------------------------------------------------------------- tests
mkdir -p "$HIL/results"
declare -A RC
run_suite() {  # name binary
    say "pytest [$1] ($2)"
    ( cd "$HIL" && ECUSIM_BIN="$2" ECUSIM_IFACE="$IFACE" "$VENV/bin/pytest" -p no:cacheprovider \
        -rfE --junitxml="$HIL/results/junit-$1.xml" "${PYTEST_ARGS[@]}" )
    RC[$1]=$?
}
run_suite release "$HIL/ecusim/build/ecusim"
[[ $ASAN == 1 ]] && run_suite asan "$HIL/ecusim/build/asan/ecusim"

# ---------------------------------------------------------------- summary
say "summary"
FAIL=0
for name in release asan; do
    [[ -n "${RC[$name]+x}" ]] || continue
    x="$HIL/results/junit-$name.xml"
    stats=$(python3 - "$x" <<'EOF'
import sys, xml.etree.ElementTree as ET
r = ET.parse(sys.argv[1]).getroot()
s = r if r.tag == "testsuite" else r.find("testsuite")
t, f, e, k = (int(s.get(a, 0)) for a in ("tests", "failures", "errors", "skipped"))
print(f"{t - f - e - k} passed, {f} failed, {e} errors, {k} skipped")
EOF
)
    printf '  %-8s rc=%s  %s\n' "$name" "${RC[$name]}" "$stats"
    [[ "${RC[$name]}" == "0" ]] || FAIL=1
done
exit $FAIL
