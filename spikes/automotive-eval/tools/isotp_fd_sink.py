#!/usr/bin/env python3
"""CAN-FD kernel CAN_ISOTP responder: answers [SID+0x40, byte1] and logs the PDU length.

Independent oracle for ISO-TP PDUs > 4095 bytes (FirstFrame 32-bit escape),
which ecusim cannot receive (UDS_TP_MTU = 4095). Standard library only.

usage: isotp_fd_sink.py IFACE RX_ID TX_ID
"""
import socket
import struct
import sys

SOL_CAN_ISOTP = 106
CAN_ISOTP_OPTS = 1
CAN_ISOTP_LL_OPTS = 5
CAN_ISOTP_TX_PADDING = 0x004
CANFD_MTU = 72
CANFD_BRS = 0x01


def main() -> None:
    iface = sys.argv[1]
    rx_id, tx_id = (int(a, 0) for a in sys.argv[2:4])
    s = socket.socket(socket.AF_CAN, socket.SOCK_DGRAM, socket.CAN_ISOTP)
    s.setsockopt(SOL_CAN_ISOTP, CAN_ISOTP_OPTS,
                 struct.pack("=IIBBBB", CAN_ISOTP_TX_PADDING, 0, 0, 0xAA, 0, 0))
    # struct can_isotp_ll_options { u8 mtu; u8 tx_dl; u8 tx_flags; }
    s.setsockopt(SOL_CAN_ISOTP, CAN_ISOTP_LL_OPTS, struct.pack("=BBB", CANFD_MTU, 64, CANFD_BRS))
    s.bind((iface, rx_id, tx_id))
    print("ready", flush=True)
    while True:
        req = s.recv(65536)
        ok = all(b == ((i + 2) & 0xFF) for i, b in enumerate(req[2:]))  # PDU[j] == j & 0xFF
        print(f"rx len={len(req)} sid={req[0]:02x} pattern_ok={ok}", flush=True)
        s.send(bytes([req[0] + 0x40, req[1]]))


if __name__ == "__main__":
    main()
