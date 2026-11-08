#!/usr/bin/env bash
# NexusCAN — Virtual SocketCAN (vcan0 / vcan1) CAN + CAN-FD Setup & Traffic Helper
set -euo pipefail

MULTI_BUS=false
DEMO_TRAFFIC=false

for arg in "$@"; do
  case "$arg" in
    --multi-bus) MULTI_BUS=true ;;
    --demo-traffic) DEMO_TRAFFIC=true ;;
  esac
done

bring_up_vcan() {
  local iface="$1"
  sudo modprobe vcan
  if ! ip link show "$iface" >/dev/null 2>&1; then
    sudo ip link add dev "$iface" type vcan
  fi
  # MTU 72 enables both Classical CAN (16B struct / 8B data) and CAN-FD (72B struct / 64B data)
  sudo ip link set "$iface" mtu 72
  sudo ip link set up "$iface"
  echo "[OK] $iface aktif (CAN + CAN-FD MTU=72):"
  ip -details link show "$iface" | sed 's/^/     /'
}

bring_up_vcan "vcan0"

if [ "$MULTI_BUS" = true ]; then
  bring_up_vcan "vcan1"
fi

if [ "$DEMO_TRAFFIC" = true ]; then
  if ! command -v cangen >/dev/null 2>&1; then
    echo "[HATA] 'cangen' bulunamadı. Önce 'bash scripts/setup_linux_deps.sh' çalıştırın."
    exit 1
  fi
  echo "[TRAFİK] vcan0 üzerine BMS (0x101), Motor (0x102), VCU (0x103) ve CAN-FD (0x201) basılıyor (Durdurmak için Ctrl+C)..."
  trap 'kill 0' EXIT INT TERM
  cangen vcan0 -g 10 -I 101 -L 8 -D r &
  cangen vcan0 -g 2  -I 102 -L 8 -D i &
  cangen vcan0 -g 50 -I 103 -L 8 -D r &
  cangen vcan0 -f -b -g 5 -I 201 -L 64 -D r &
  wait
fi
