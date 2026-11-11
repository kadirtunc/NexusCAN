#!/usr/bin/env bash
# Elle test: tek bir UDS isteği gönderip yanıtı yazdırır (çekirdek ISO-TP, can-utils).
# Kullanım: tests/hil/uds.sh "22 F1 90" [iface=vcan0] [req=7E0] [resp=7E8]
set -euo pipefail
REQ_HEX="${1:?kullanım: uds.sh \"22 F1 90\" [iface] [req] [resp]}"
IFACE="${2:-vcan0}"; TX="${3:-7E0}"; RX="${4:-7E8}"
OUT="$(mktemp)"; trap 'rm -f "$OUT"' EXIT
timeout 3 isotprecv -s "$TX" -d "$RX" "$IFACE" > "$OUT" &
RECV=$!; sleep 0.1
echo "$REQ_HEX" | isotpsend -s "$TX" -d "$RX" "$IFACE"
wait "$RECV" 2>/dev/null || true
RESP="$(head -n1 "$OUT")"
echo "TX: $REQ_HEX"
echo "RX: ${RESP:-<yanıt yok (3 sn)>}"
