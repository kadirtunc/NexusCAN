#!/usr/bin/env bash
# Optional second independent UDS target: driftregion/iso14229 (C, MIT).
#
# Builds the library's `examples/linux_rdbi_wdbi` server (kernel ISO-TP
# socket, vcan0, phys 0x7E0/0x7E8, functional 0x7DF) and runs a differential
# probe: the same generic requests go to iso14229 and to nexus-ecu-sim, and the
# answers are compared. Generic ISO 14229-1 behaviour (TesterPresent, NRC
# 0x11/0x12/0x13, SPRMIB suppression, DiagnosticSessionControl) must agree;
# DID payloads/timing legitimately differ and are only printed.
#
# TODO (Layer 1b): iso14229 ships no Linux flash server (fwupdate is
# Zephyr/MCUBoot-only). A 0x34/0x36/0x37 server needs C handlers for
# UDS_EVT_RequestDownload / UDS_EVT_TransferData / UDS_EVT_RequestTransferExit;
# once written, point the NexusCAN flasher at it as a second flash target.
#
# Needs: git, gcc, can-utils (isotpsend/isotprecv). Runs rootless via
# `unshare -rn` when vcan0 is absent and sudo is unavailable.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REV="${ISO14229_REV:-d018adc}"
WORK="${ISO14229_WORK:-${TMPDIR:-/tmp}/nexus-iso14229}"
TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/target}"

for t in git gcc isotpsend isotprecv; do
  command -v "$t" >/dev/null || { echo "[ERR] missing prerequisite: $t" >&2; exit 1; }
done

if [ "${1:-}" != "--inner" ]; then
  mkdir -p "$WORK"
  if [ ! -d "$WORK/src/.git" ]; then
    git clone --quiet https://github.com/driftregion/iso14229.git "$WORK/src"
  fi
  git -C "$WORK/src" fetch --quiet --depth 1 origin "$REV" 2>/dev/null || true
  git -C "$WORK/src" -c advice.detachedHead=false checkout --quiet "$REV" 2>/dev/null \
    || echo "[WARN] could not pin $REV, using $(git -C "$WORK/src" rev-parse --short HEAD)"
  EX="$WORK/src/examples/linux_rdbi_wdbi"
  mkdir -p "$WORK/build"
  gcc -DUDS_TP_ISOTP_SOCK -DUDS_LINES -DUDS_LOG_LEVEL=UDS_LOG_WARN -O1 \
    "$EX/iso14229.c" "$EX/server.c" -o "$WORK/build/iso14229-server"
  (cd "$ROOT" && cargo build --quiet -p nexus-ecu-sim --bins)
  export ISO_SERVER="$WORK/build/iso14229-server" SIM="$TARGET_DIR/debug/nexus-ecu-sim" WORK
  if ip link show vcan0 >/dev/null 2>&1; then exec "$0" --inner; fi
  if sudo -n true 2>/dev/null; then "$ROOT/scripts/hil/vcan_up.sh" vcan0; exec "$0" --inner; fi
  exec unshare -rn bash -c 'ip link add vcan0 type vcan && ip link set vcan0 up && exec "$0" --inner' "$0"
fi

# ---------------------------------------------------------------- inner
probe() { # $1 = hex request; prints the response or "<none>"
  local out
  out="$(mktemp)"
  timeout 0.6 isotprecv -s 7E0 -d 7E8 vcan0 >"$out" 2>/dev/null &
  local rp=$!
  sleep 0.1
  echo "$1" | isotpsend -s 7E0 -d 7E8 vcan0
  wait $rp 2>/dev/null || true
  local r
  r="$(head -1 "$out" | sed 's/ *$//')"
  rm -f "$out"
  echo "${r:-<none>}"
}

PROBES=("3E 00" "3E 80" "3E 01" "3E" "BA" "10 03" "10 7F" "22 F1 90")
# 1 = must agree. The rdbi_wdbi example registers no DiagnosticSessionControl
# handler (iso14229 answers 0x11 for the whole service), so 0x10 is info only.
GENERIC=(1 1 1 1 1 0 0 0)

run_set() { # $1 = label, rest = server command
  local label=$1; shift
  "$@" >/dev/null 2>&1 &
  local pid=$!
  sleep 0.5
  for p in "${PROBES[@]}"; do probe "$p"; done >"$WORK/xcheck-$label.txt"
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

run_set iso "$ISO_SERVER"
run_set sim "$SIM" --iface vcan0 --rx 0x7E0 --tx 0x7E8 --log off --image-out "$WORK/xcheck-image.json"

mapfile -t A <"$WORK/xcheck-iso.txt"
mapfile -t B <"$WORK/xcheck-sim.txt"
fail=0
printf '%-10s | %-28s | %-28s | %s\n' request iso14229 nexus-ecu-sim verdict
for i in "${!PROBES[@]}"; do
  v="info"
  if [ "${GENERIC[$i]}" = 1 ]; then
    a="${A[$i]}"; b="${B[$i]}"
    # 0x50 response timing bytes differ by configuration: compare first 2 bytes.
    if [ "$a" = "$b" ]; then v="AGREE"; else v="DIFFER"; fail=1; fi
  fi
  printf '%-10s | %-28s | %-28s | %s\n' "${PROBES[$i]}" "${A[$i]:0:28}" "${B[$i]:0:28}" "$v"
done
exit $fail
