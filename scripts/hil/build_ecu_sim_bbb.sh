#!/usr/bin/env bash
# Cross-compile nexus-ecu-sim + nexus-flash-compare for the BeagleBone Black
# (AM335x Cortex-A8, ARMv7 hard-float).
#
#   scripts/hil/build_ecu_sim_bbb.sh            # auto: musl static > cross > gnueabihf+gcc
#   scripts/hil/build_ecu_sim_bbb.sh --musl     # static musl, linked by rust-lld (no gcc needed)
#   scripts/hil/build_ecu_sim_bbb.sh --cross    # armv7-unknown-linux-gnueabihf via `cross` (Docker/Podman)
#   scripts/hil/build_ecu_sim_bbb.sh --gnu      # armv7-unknown-linux-gnueabihf via arm-linux-gnueabihf-gcc
#
# Why musl is the default: a gnueabihf binary linked on a recent distro needs
# that distro's glibc (e.g. GLIBC_2.39) and fails on older BBB Debian images
# ("version `GLIBC_2.3x' not found"). The simulator has no C dependencies, so
# a fully static musl binary linked by the rust-lld shipped with rustup works
# on every BBB image. `cross` images use an old glibc and are also safe.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
MODE="${1:-auto}"
TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/target}"
MUSL=armv7-unknown-linux-musleabihf
GNU=armv7-unknown-linux-gnueabihf
missing=()

have() { command -v "$1" >/dev/null 2>&1; }
target_installed() { rustup target list --installed 2>/dev/null | grep -qx "$1"; }
container_ok() { { have docker && docker info >/dev/null 2>&1; } || { have podman && podman info >/dev/null 2>&1; }; }

done_msg() {
  local t="$1"
  local out="$TARGET_DIR/$t/release"
  echo
  echo "[OK] built for $t:"
  for b in nexus-ecu-sim nexus-flash-compare; do
    ls -la "$out/$b"
    have file && file "$out/$b" | sed 's/^/     /'
  done
  cat <<MSG

Deploy to the BeagleBone Black (default user 'debian'):
  scp $out/nexus-ecu-sim $out/nexus-flash-compare scripts/hil/bbb_can_setup.sh debian@beaglebone.local:~/
  ssh debian@beaglebone.local 'sudo ./bbb_can_setup.sh can1 500000 --run'
MSG
}

build_musl() {
  if ! have rustup; then missing+=("rustup (https://rustup.rs)"); return 1; fi
  if ! target_installed "$MUSL"; then
    echo "[..] installing Rust std for $MUSL (rustup target add $MUSL)"
    rustup target add "$MUSL" || { missing+=("rustup target add $MUSL"); return 1; }
  fi
  CARGO_TARGET_ARMV7_UNKNOWN_LINUX_MUSLEABIHF_LINKER=rust-lld \
    cargo build --release -p nexus-ecu-sim --bins --target "$MUSL"
  done_msg "$MUSL"
}

build_cross() {
  if ! have cross; then missing+=("cross: cargo install cross --git https://github.com/cross-rs/cross"); return 1; fi
  if ! container_ok; then missing+=("a running Docker or Podman engine for cross"); return 1; fi
  cross build --release -p nexus-ecu-sim --bins --target "$GNU"
  done_msg "$GNU"
}

build_gnu() {
  local ok=1
  if ! target_installed "$GNU"; then missing+=("rustup target add $GNU"); ok=0; fi
  if ! have arm-linux-gnueabihf-gcc; then
    missing+=("arm-linux-gnueabihf-gcc: sudo apt install gcc-arm-linux-gnueabihf")
    ok=0
  fi
  [ "$ok" = 1 ] || return 1
  echo "[WARN] gnueabihf binary will require the host cross glibc version on the BBB:"
  arm-linux-gnueabihf-gcc -print-file-name=libc.so.6 | xargs -r strings 2>/dev/null | grep -m1 -E '^GNU C Library' || true
  CARGO_TARGET_ARMV7_UNKNOWN_LINUX_GNUEABIHF_LINKER=arm-linux-gnueabihf-gcc \
    cargo build --release -p nexus-ecu-sim --bins --target "$GNU"
  done_msg "$GNU"
}

case "$MODE" in
  --musl) build_musl && exit 0 ;;
  --cross) build_cross && exit 0 ;;
  --gnu) build_gnu && exit 0 ;;
  auto) build_musl && exit 0
        echo "[..] musl path unavailable, trying cross"; build_cross && exit 0
        echo "[..] cross unavailable, trying gnueabihf + gcc"; build_gnu && exit 0 ;;
  *) echo "usage: $0 [--musl|--cross|--gnu]" >&2; exit 2 ;;
esac

echo >&2
echo "[ERR] no cross-compilation path available. Missing prerequisites:" >&2
for m in "${missing[@]}"; do echo "      - $m" >&2; done
exit 1
