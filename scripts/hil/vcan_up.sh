#!/usr/bin/env bash
# NexusCAN HIL Layer 1 — bring up vcan0 (+ kernel ISO-TP) for nexus-ecu-sim.
# Idempotent. Needs root (uses sudo when not root).
#
#   sudo scripts/hil/vcan_up.sh            # vcan0, classical + FD capable (MTU 72)
#   scripts/hil/vcan_up.sh vcan1           # other name
#
# No sudo? Use scripts/hil/run_hil_tests.sh, which creates vcan0 inside an
# unprivileged user+network namespace instead.
set -euo pipefail

IFACE="${1:-vcan0}"
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if sudo -n true 2>/dev/null; then SUDO="sudo -n"; else SUDO="sudo"; fi
fi

for m in can can_raw vcan can_isotp; do
  if ! lsmod | awk '{print $1}' | grep -qx "$m"; then
    $SUDO modprobe "$m" || {
      echo "[ERR] modprobe $m failed (kernel without CONFIG_${m^^}?)." >&2
      [ "$m" = "can_isotp" ] && echo "      nexus-ecu-sim needs CONFIG_CAN_ISOTP (mainline since 5.10)." >&2
      exit 1
    }
  fi
done

if ! ip link show "$IFACE" >/dev/null 2>&1; then
  $SUDO ip link add dev "$IFACE" type vcan
fi
$SUDO ip link set "$IFACE" mtu 72 2>/dev/null || true
$SUDO ip link set up "$IFACE"
echo "[OK] $IFACE up (vcan, can_isotp loaded):"
ip -details link show "$IFACE" | sed 's/^/     /'
