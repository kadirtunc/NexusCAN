#!/usr/bin/env bash
# Run ON the BeagleBone Black (as root): configure DCAN pins + SocketCAN for
# the nexus-ecu-sim HIL target (Layer 2). AM335x DCAN = classical CAN only.
#
#   sudo ./bbb_can_setup.sh [IFACE] [BITRATE] [--run [extra sim args...]]
#   sudo ./bbb_can_setup.sh can1 500000
#   sudo ./bbb_can_setup.sh can1 500000 --run --padding 0xAA --fault erase-time:2000
#
# Pin map (P9 header):
#   DCAN1: P9.24 = DCAN1_RX, P9.26 = DCAN1_TX   (default; used by most CAN capes)
#   DCAN0: P9.19 = DCAN0_RX, P9.20 = DCAN0_TX   (shares pins with I2C2, which
#          carries the cape EEPROM bus; only use if your cape is wired that way:
#          config-pin P9.19 can; config-pin P9.20 can)
# Interface naming: with both controllers enabled dcan0 -> can0, dcan1 -> can1;
# with only DCAN1 enabled some images name it can0 — check `ip link`.
#
# If config-pin is missing or reports the pin is not configurable, enable the
# overlay in /boot/uEnv.txt and reboot:
#   uboot_overlay_addr0=/lib/firmware/BB-CAN1-00A0.dtbo
#   (cape-universal images: enable_uboot_cape_universal=1 then use config-pin)
set -euo pipefail

IFACE=can1
BITRATE=500000
if [[ $# -gt 0 && $1 != --* ]]; then IFACE=$1; shift; fi
if [[ $# -gt 0 && $1 != --* ]]; then BITRATE=$1; shift; fi
RUN=0
if [ "${1:-}" = "--run" ]; then RUN=1; shift; fi

if [ "$(id -u)" -ne 0 ]; then
  echo "[ERR] run as root: sudo $0 $IFACE $BITRATE" >&2
  exit 1
fi

if command -v config-pin >/dev/null 2>&1; then
  case "$IFACE" in
    can0) PINS=(P9.19 P9.20) ;;
    *)    PINS=(P9.24 P9.26) ;;
  esac
  for p in "${PINS[@]}"; do
    config-pin "$p" can && echo "[OK] $p -> can ($(config-pin -q "$p" 2>/dev/null || true))" \
      || echo "[WARN] config-pin $p can failed (overlay already fixed the pinmux?)"
  done
else
  echo "[WARN] config-pin not found; assuming the pinmux comes from a uEnv.txt overlay."
fi

modprobe can 2>/dev/null || true
modprobe can_raw 2>/dev/null || true
modprobe c_can_platform 2>/dev/null || true
if ! modprobe can_isotp 2>/dev/null && ! modprobe can-isotp 2>/dev/null; then
  if ! grep -q can_isotp /proc/modules 2>/dev/null; then
    echo "[WARN] can_isotp module not available (kernel $(uname -r))."
    echo "       nexus-ecu-sim needs CONFIG_CAN_ISOTP (mainline >= 5.10). Use a"
    echo "       Debian 11/12 BBB image with a 5.10+ kernel (e.g. 5.10-ti / 6.1-ti)."
  fi
fi

if ! ip link show "$IFACE" >/dev/null 2>&1; then
  echo "[ERR] $IFACE does not exist. Available CAN interfaces:" >&2
  ip -br link show type can >&2 || true
  exit 1
fi

ip link set "$IFACE" down 2>/dev/null || true
# 500 kbit/s, automatic bus-off recovery after 100 ms. The DCAN controller
# does not support CAN FD — never pass `fd on` here.
ip link set "$IFACE" type can bitrate "$BITRATE" restart-ms 100
ip link set "$IFACE" txqueuelen 256
ip link set "$IFACE" up
echo
ip -details -statistics link show "$IFACE"

cat <<MSG

Bus checklist: 120 ohm termination at BOTH ends (BBB cape + CANable jumper),
common GND, CANH-CANH / CANL-CANL. ERROR-PASSIVE / BUS-OFF above usually means
missing termination, wrong bitrate or no other node ACKing.

Run the simulator:
  ./nexus-ecu-sim --iface $IFACE --rx 0x7E0 --tx 0x7E8 --padding 0xAA \\
      --mem-region 0x08000000:0x80000 --image-out flash_image.json --log jsonl
Compare after flashing:
  ./nexus-flash-compare --source firmware.hex --image flash_image.json
MSG

if [ "$RUN" = 1 ]; then
  SIM="$(dirname "$0")/nexus-ecu-sim"
  [ -x "$SIM" ] || SIM="$(command -v nexus-ecu-sim || true)"
  if [ -z "$SIM" ]; then echo "[ERR] nexus-ecu-sim binary not found next to this script" >&2; exit 1; fi
  echo "[RUN] $SIM --iface $IFACE --rx 0x7E0 --tx 0x7E8 --padding 0xAA $*"
  exec "$SIM" --iface "$IFACE" --rx 0x7E0 --tx 0x7E8 --padding 0xAA \
    --image-out flash_image.json --log jsonl "$@"
fi
