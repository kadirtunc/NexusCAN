---
name: nexuscan-vcan-hil
description: >-
  Virtual CAN (vcan0), SocketCAN simulation, stress benchmarking (1kHz-50kHz), and Hardware-in-the-Loop
  (HIL) test workflows for NexusCAN on Linux and WSL2. Use when setting up vcan0, running cangen/canplayer,
  diagnosing WSL2 missing kernel modules, or writing automated Rust throughput and DBC verification tests.
---

# NexusCAN Virtual CAN (`vcan0`) & Stress-Testing Workflow

Always validate NexusCAN changes deterministically — either via Linux `vcan0` kernel loopback or, when running inside restricted/WSL2 kernels without `vcan.ko`, via `mock0` (`MockCanAdapter`) and pure-Rust integration harnesses.

## 1. Setting Up `vcan0` on Linux

```bash
# Load virtual CAN kernel module and bring up vcan0 (supports both Classical CAN and CAN-FD!)
sudo modprobe vcan
sudo ip link add dev vcan0 type vcan 2>/dev/null || true
sudo ip link set vcan0 mtu 72   # MTU 72 enables CAN-FD (64-byte payloads); MTU 16 is Classical-only
sudo ip link set up vcan0
ip -details link show vcan0
```

> **WSL2 Fallback Check:** Standard Microsoft WSL2 kernels sometimes omit `CONFIG_CAN_VCAN=m`. Check `modprobe -n vcan` or `ls /sys/class/net/vcan0`. If `modprobe vcan` fails with *Module vcan not found*, do NOT block development — immediately verify via NexusCAN's built-in `mock0` driver (`src-tauri/src/hal/mock_drv.rs`) and `cargo test` pipeline benchmarks!

## 2. Generating Realistic Traffic with `can-utils`

```bash
# A. Targeted traffic matching sample_vehicle.dbc IDs (0x101 BMS, 0x102 Motor, 0x103 VCU)
cangen vcan0 -g 10 -I 101 -L 8 -D r &
cangen vcan0 -g 2  -I 102 -L 8 -D i &
cangen vcan0 -g 50 -I 103 -L 8 -D r &

# B. CAN-FD 64-byte BRS high-speed burst test (-f = CAN-FD, -b = Bit Rate Switch)
cangen vcan0 -f -b -g 1 -I 201 -L 64 -D r

# C. Replay recorded field log (.log / candump format) infinitely
canplayer -I scripts/sample_ev_drive.log -l i vcan0=can0
```

## 3. Physical SocketCAN Bring-Up & Bus-Off Recovery (`can0`)

When connecting real USB-CAN hardware (`gs_usb` / candleLight / PCAN-USB):
```bash
# Classical CAN @ 500 kbps with automatic 100ms Bus-Off recovery
sudo ip link set can0 down 2>/dev/null || true
sudo ip link set can0 type can bitrate 500000 restart-ms 100
sudo ip link set can0 txqueuelen 1024
sudo ip link set can0 up

# CAN-FD @ 500 kbps nominal / 2 Mbps data phase
sudo ip link set can0 type can bitrate 500000 dbitrate 2000000 fd on restart-ms 100

# Inspect error counters (TEC/REC), bus-off events, and dropped frames
ip -details -statistics link show can0
```

## 4. Performance & Correctness Acceptance Gates

Every pipeline or HAL change in NexusCAN should pass these benchmarks in `cargo test --release`:
1. **Zero-Drop Throughput Test:** Push `100,000` synthetic `RawCanFrame` items (`50,000 fps` burst) through `StateTable` + `CompiledDbc`:
   * `dropped_frames == 0`
   * Total aggregation + DBC decode wall time `< 25 ms` for 100k frames in `--release` mode.
2. **60Hz IPC Cadence Check:** Verify snapshot emitter fires at `16.6ms ± 2ms` (`58..62 Hz`) regardless of whether bus load is `0 fps`, `100 fps`, or `50,000 fps`.
3. **Byte-Change Mask Decay:** Verify `changed_bytes_mask` sets bit `i` immediately when `data[i]` mutates and clears bit `i` once `> 300_000 us` elapses with constant `data[i]`.
