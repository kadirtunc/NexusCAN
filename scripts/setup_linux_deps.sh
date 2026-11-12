#!/usr/bin/env bash
# NexusCAN — Linux / WSL2 System Dependencies, USB-CAN udev Rules & vcan0 Setup
set -euo pipefail

echo "=================================================================="
echo " NexusCAN — Endüstriyel Sistem Bağımlılıkları Kurulumu (Ubuntu/Debian)"
echo "=================================================================="

sudo apt-get update
sudo apt-get install -y \
  build-essential \
  pkg-config \
  curl \
  file \
  patchelf \
  can-utils \
  iproute2 \
  libwebkit2gtk-4.1-dev \
  libssl-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  libxdo-dev \
  libudev-dev \
  libusb-1.0-0-dev

echo ""
echo "[1/3] USB-CAN Donanımları (gs_usb/candleLight, CANable, PCAN, Kvaser, SLCAN) için udev kuralları yazılıyor..."
sudo tee /etc/udev/rules.d/99-nexuscan-usb.rules >/dev/null <<'EOF'
# OpenMoko / Geschwister Schneider gs_usb & candleLight (CANable, CANtact, etc.)
SUBSYSTEM=="usb", ATTR{idVendor}=="1d50", ATTR{idProduct}=="606f", MODE="0660", GROUP="plugdev", TAG+="uaccess"
# Microchip / CANable DFU & gs_usb variants
SUBSYSTEM=="usb", ATTR{idVendor}=="04d8", ATTR{idProduct}=="0053", MODE="0660", GROUP="plugdev", TAG+="uaccess"
# PEAK-System PCAN-USB / PCAN-USB FD
SUBSYSTEM=="usb", ATTR{idVendor}=="0c72", MODE="0660", GROUP="plugdev", TAG+="uaccess"
# Kvaser Leaf / Memorator USB-CAN
SUBSYSTEM=="usb", ATTR{idVendor}=="0bfd", MODE="0660", GROUP="plugdev", TAG+="uaccess"
# STMicroelectronics Virtual COM Port (SLCAN adapters)
SUBSYSTEM=="tty", ATTRS{idVendor}=="0483", ATTRS{idProduct}=="5740", MODE="0660", GROUP="dialout", TAG+="uaccess"
EOF

sudo udevadm control --reload-rules 2>/dev/null || true
sudo udevadm trigger 2>/dev/null || true

echo "[2/3] Sanal CAN/CAN-FD (vcan0 & vcan1, MTU=72) arayüzleri hazırlanıyor..."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "$SCRIPT_DIR/setup_vcan.sh" --multi-bus || echo "Not: vcan modülü yüklenemediyse NexusCAN dahili mock0 sürücüsü ile sorunsuz çalışacaktır."

echo "[3/3] pkg-config ve can-utils doğrulanıyor..."
echo "  pkg-config : $(command -v pkg-config) ($(pkg-config --version))"
echo "  webkit2gtk : $(pkg-config --modversion webkit2gtk-4.1)"
echo "  candump    : $(command -v candump)"
echo "  cangen     : $(command -v cangen)"

echo ""
echo "=================================================================="
echo " TAMAMLANDI! Artık 'agy --agent team-lead' ile başlayabilirsiniz."
echo "=================================================================="
