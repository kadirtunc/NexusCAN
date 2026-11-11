#!/usr/bin/env python3
"""Minimal UDS responder on a Linux kernel CAN_ISOTP socket with EXTENDED addressing.

Independent oracle for the crate's extended-addressing support (ecusim has no
extended addressing). Standard library only.

usage: isotp_ext_echo.py IFACE RX_ID TX_ID TX_EXT RX_EXT
  RX_ID/TX_ID : CAN IDs the responder receives on / transmits on
  TX_EXT      : first data byte the responder puts on its frames (tester address)
  RX_EXT      : first data byte the responder expects (its own address)
"""
import socket
import struct
import sys

SOL_CAN_ISOTP = 106          # SOL_CAN_BASE (100) + CAN_ISOTP (6)
CAN_ISOTP_OPTS = 1
CAN_ISOTP_EXTEND_ADDR = 0x002
CAN_ISOTP_TX_PADDING = 0x004
CAN_ISOTP_RX_EXT_ADDR = 0x200


def main() -> None:
    iface = sys.argv[1]
    rx_id, tx_id, tx_ext, rx_ext = (int(a, 0) for a in sys.argv[2:6])
    s = socket.socket(socket.AF_CAN, socket.SOCK_DGRAM, socket.CAN_ISOTP)
    flags = CAN_ISOTP_EXTEND_ADDR | CAN_ISOTP_RX_EXT_ADDR | CAN_ISOTP_TX_PADDING
    # struct can_isotp_options { u32 flags; u32 frame_txtime; u8 ext_address;
    #                            u8 txpad_content; u8 rxpad_content; u8 rx_ext_address; }
    s.setsockopt(SOL_CAN_ISOTP, CAN_ISOTP_OPTS,
                 struct.pack("=IIBBBB", flags, 0, tx_ext, 0x55, 0x00, rx_ext))
    s.bind((iface, rx_id, tx_id))
    print("ready", flush=True)
    while True:
        req = s.recv(4095)
        print("rx", req.hex(), flush=True)
        if req[:3] == b"\x22\xf1\x90":
            resp = b"\x62\xf1\x90" + b"EXTADDR0VIN000017"
        elif req[:2] == b"\x3e\x00":
            resp = b"\x7e\x00"
        else:
            resp = bytes([0x7F, req[0], 0x11])
        s.send(resp)
        print("tx", resp.hex(), flush=True)


if __name__ == "__main__":
    main()
