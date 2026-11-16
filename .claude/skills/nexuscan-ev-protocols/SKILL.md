---
name: nexuscan-ev-protocols
description: >-
  Higher-layer EV Infrastructure and Industrial IoT CAN protocols in Rust for NexusCAN: SAE J1939
  (29-bit PGN/SPN/BAM), ISO-TP (ISO 15765-2 multi-frame transport), UDS (ISO 14229 diagnostics),
  EV BMS & DC fast-charging telemetry (CHAdeMO, GB/T 27930, CCS/DIN 70121), and CANopen (CiA 301/402).
  Use when adding protocol decoders, diagnostic consoles, or EV/IoT analyzers to NexusCAN.
---

# NexusCAN EV Infrastructure & Industrial IoT Protocols

When NexusCAN moves beyond raw DBC frame decoding into higher-layer EV charging, Battery Management Systems (BMS), heavy-duty EVs, or industrial automation, implement protocol layers cleanly on top of `RawCanFrame` in `src-tauri/src/protocols/`.

## 1. SAE J1939 (Heavy EVs, Commercial BMS, Industrial Chargers)

J1939 uses 29-bit Extended CAN IDs (`flags & EXTENDED != 0`):

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct J1939Header {
    pub priority: u8,       // Bits 26..=28 (3 bits)
    pub pgn: u32,           // 18-bit Parameter Group Number
    pub dest_addr: u8,      // PDU1 destination (0xFF = broadcast)
    pub source_addr: u8,    // Bits 0..=7 (ECU Node Address)
}

impl J1939Header {
    pub fn from_arb_id(id: u32) -> Self {
        let priority = ((id >> 26) & 0x07) as u8;
        let dp_edp = (id >> 24) & 0x03;
        let pf = ((id >> 16) & 0xFF) as u8;
        let ps = ((id >> 8) & 0xFF) as u8;
        let source_addr = (id & 0xFF) as u8;
        // PDU1 (pf < 240): PS is Destination Address, lower byte of PGN is 0x00
        // PDU2 (pf >= 240): PS is Group Extension, included in PGN
        let (pgn, dest_addr) = if pf < 240 {
            ((dp_edp << 16) | ((pf as u32) << 8), ps)
        } else {
            ((dp_edp << 16) | ((pf as u32) << 8) | (ps as u32), 0xFF)
        };
        Self { priority, pgn, dest_addr, source_addr }
    }
}
```
* **J1939 DBC Lookup:** In J1939 `.dbc` files, message IDs often include `0x8000_0000` extended marker and a default SA; match fallback by `(pgn)` when exact 29-bit `arb_id` misses due to different ECU Source Addresses.
* **Transport Protocol ( > 8 bytes):** Reassemble `TP.CM_BAM` (`PGN 0x00EC00`, control byte `32`) + `TP.DT` (`PGN 0x00EB00`, sequence `1..=N`, 7 payload bytes per frame) keyed by `(source_addr, target_pgn)`.

## 2. ISO-TP (`ISO 15765-2`) & UDS (`ISO 14229-1`) Diagnostics

Used for ECU/BMS diagnostics, reading DIDs (cell voltages, VIN, firmware version), and DTC fault codes:

* **PCI Frame Types (`byte[0] >> 4`):**
  * `0x0` **Single Frame (SF):** Classical CAN `len = byte[0] & 0x0F` (`1..=7`); CAN-FD escape (`byte[0] == 0x00`) -> `len = byte[1]` (`8..=62`).
  * `0x1` **First Frame (FF):** 12-bit length `(((byte[0] & 0x0F) as usize) << 8) | (byte[1] as usize)` (or 32-bit escape in bytes `2..6` if 12-bit == 0). Trigger Flow Control (`0x30`, BlockSize `0`, STmin `0..10ms`) when acting as active tester, or passively reassemble when sniffing!
  * `0x2` **Consecutive Frame (CF):** Sequence nibble `byte[0] & 0x0F` wraps `1..=15 -> 0..=15`.
  * `0x3` **Flow Control (FC):** `0 = ContinueToSend`, `1 = Wait`, `2 = Overflow/Abort`.
* **Core UDS SIDs:**
  * `0x10` DiagnosticSessionControl (`0x01` Default, `0x02` Programming, `0x03` Extended)
  * `0x22` ReadDataByIdentifier (2-byte DID -> positive response `0x62 + DID + payload`)
  * `0x19` ReadDTCInformation (`0x02` reportDTCByStatusMask) / `0x14` ClearDiagnosticInformation
  * `0x27` SecurityAccess (Seed/Key) | `0x31` RoutineControl | `0x3E` TesterPresent
  * `0x7F` Negative Response (`[0x7F, failed_sid, nrc]`; note NRC `0x78` = `responsePending` — extend timeout, do not fail!).

## 3. EV BMS & DC Charging Telemetry Patterns

* **BMS Multiplexed Cell Matrices:** High-voltage EV packs (96s–192s cells) multiplex cell voltages/temperatures across 1 or 2 CAN IDs using byte 0 as `mux_idx` (e.g., 4 cells x 16-bit mV per frame). In `StateTable`, store per-mux-branch values so all 96+ cells remain visible simultaneously instead of overwriting one another!
* **DC Fast Charging:**
  * **CHAdeMO (500 kbps, 11-bit CAN):** EV (`0x100`, `0x101`, `0x102`) <-> EVSE Charger (`0x108`, `0x109`) cyclical 100ms state machine + isolation check + current demand loop.
  * **GB/T 27930 (250 kbps, J1939-derived 29-bit CAN):** Handshake (`CHM 0x26`, `BHM 0x27`), Parameter Config (`CML`, `BCP`), Charging Loop (`BCL` voltage/current demand, `BCS` status, `CCS` output).

## 4. CANopen (`CiA 301` & `CiA 402` Industrial Drives/IoT)

11-bit `arb_id` splits into **4-bit Function Code** (`id >> 7`) + **7-bit Node-ID** (`id & 0x7F`, `1..=127`):
* `0x000`: NMT Network Management (`[cmd, target_node_id]`: `0x01` Operational, `0x02` Stop, `0x80` Pre-Op, `0x81` Reset)
* `0x080`: SYNC (`dlc == 0`) | `0x080 + Node`: EMCY Emergency (`[err_lo, err_hi, err_reg, ...]`)
* `0x180 / 0x280 / 0x380 / 0x480 + Node`: TPDO1..4 (real-time cyclic telemetry)
* `0x200 / 0x300 / 0x400 / 0x500 + Node`: RPDO1..4 (real-time actuator commands)
* `0x580 + Node` (TSDO) / `0x600 + Node` (RSDO): Object Dictionary (`[cs, idx_lo, idx_hi, sub_idx, d0..d3]`)
* `0x700 + Node`: NMT Heartbeat (`0x00` Boot-up, `0x04` Stopped, `0x05` Operational, `0x7F` Pre-Op)
