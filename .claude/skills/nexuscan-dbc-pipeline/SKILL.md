---
name: nexuscan-dbc-pipeline
description: >-
  3-stage Signal Database Compiler & Codec Library (crates/nexus-netdb: .dbc & .kcd parsers, Canonical IR,
  Intel/Motorola/Float/Cascaded-Mux codec, TX encoder, DatabaseSchemaDto) and 60Hz Two-Plane Telemetry
  Pipeline (src-tauri/src/pipeline/) for NexusCAN. Use whenever working on crates/nexus-netdb/ or
  src-tauri/src/pipeline/.
---

# NexusCAN Signal Database Engine (`nexus-netdb`) & 60Hz Two-Plane Pipeline

NexusCAN separates signal database intelligence into a standalone, zero-Tauri-dependency crate (`crates/nexus-netdb`) and pairs it with a lock-free 60Hz `StateTable` pipeline in `src-tauri`.

## 1. 3-Stage Compiler Architecture (`crates/nexus-netdb`)

Never couple runtime decoding or React UI components directly to `.dbc` or `.kcd` syntax quirks:

1. **Stage 1 — Pluggable Format Frontends (`formats/`, `DatabaseFormatParser` trait):**
   * **Character Encoding (`encoding.rs`):** Auto-detect and transcode non-UTF-8 industrial files (`Windows-1252` / `ISO-8859-1` with `°C`, `µA`, `Ω`, umlauts/Turkish chars) via `encoding_rs` without failing.
   * **Full Vector `.dbc` Frontend (`formats/dbc/`):** Fast `winnow`/`nom` parser covering `BU_`, `BO_`, `BO_TX_BU_`, `SG_`, extended mux `SG_MUL_VAL_`, float types `SIG_VALTYPE_` (`1`=f32, `2`=f64), `VAL_TABLE_` & `VAL_`, multi-target `CM_`, attributes (`BA_DEF_`, `BA_DEF_DEF_`, `BA_` for `GenMsgCycleTime`, `GenSigStartValue`, `VFrameFormat`, `SystemSignalLongSymbol`), `SIG_GROUP_`, and `VECTOR__INDEPENDENT_SIG_MSG` (`0xC0000000` isolation).
   * **Kayak `.kcd` Frontend (`formats/kcd/`):** Streaming `quick-xml` parser mapping `<Bus>`, `<Node>`, `<Message>`, `<Multiplex>`, `<Signal>`, `<Value>`, and `<LabelSet>` into the exact same IR.
   * **Fault-Tolerant Diagnostics (`ParseDiagnostic`):** Emit non-fatal line/column warnings (e.g., bit span exceeding DLC, overlapping bits, `min == max == 0`) rather than rejecting real-world OEM files.
2. **Stage 2 — Canonical IR (`ir/NetworkDatabase`):**
   * Format-independent `CanIdKey` (`Standard(u16)` vs `Extended(u32)` — never collide!), `FrameProtocol` (`ClassicalCan`, `CanFd`, `J1939Pg`), `MuxRole` (`Static`, `MasterSwitch`, `Multiplexed { switch_signal, ranges, is_sub_switch }`), `SignalValueType` (`Unsigned`, `Signed`, `Float32`, `Float64`), ECU topology, comments, and `VAL_` enum maps.
3. **Stage 3 — Compiled Runtime Plan (`compiler/CompiledDatabase`):**
   * O(1) `FxHashMap<CanIdKey, CompiledMessage>` + J1939 PGN masked index (`0x03FF_FF00` PDU1/PDU2 aware) for `VFrameFormat == "J1939PG"`.
   * Cycle-checked `MuxDecisionTree` (`mux_tree.rs`) supporting standard (`m0`), cascaded (`m2M`), and range (`SG_MUL_VAL_ 0-3, 10-15`) multiplexing.

## 2. 512-Bit CAN-FD Safe Bitwise Codec (`codec/extractor.rs` & `codec/encoder.rs`)

**STRICT RULE:** Never cast payloads to a single `u64` — CAN-FD frames carry up to **64 bytes (512 bits)**! Operate directly on `&[u8]` (`0..64` bytes) for arbitrary `start_bit: 0..511` and `bit_len: 1..=64`:

* **Intel / Little-Endian (`@1`):** `start_bit` is LSB; bit `k` (`0..bit_len`) resides at `pos = start_bit + k`, `byte = pos / 8`, `bit_in_byte = pos % 8`.
* **Motorola / Big-Endian (`@0` — Vector Sawtooth):** `start_bit` is MSB (`byte = start_bit / 8`, `bit_in_byte = start_bit % 8` where `7` is MSB and `0` is LSB). Step MSB → LSB: decrement `bit_in_byte`; when `bit_in_byte == 0`, jump to `byte + 1`, `bit_in_byte = 7`.
* **Value Types:**
  * `Unsigned`: `raw as f64 * factor + offset`
  * `Signed`: Two's complement sign extension `let shift = 64 - bit_len; (((raw << shift) as i64) >> shift) as f64 * factor + offset`
  * `Float32` (`bit_len == 32`): `(f32::from_bits(raw as u32) as f64) * factor + offset`
  * `Float64` (`bit_len == 64`): `f64::from_bits(raw) * factor + offset`
* **Bidirectional TX Packing (`encoder.rs`):** Invert `raw = ((physical - offset) / factor).round()`, clamp to type/bit bounds, auto-populate parent `MuxSwitch` selector values when encoding a muxed signal, and pack bits cleanly into `[u8; 64]`.

## 3. Two-Plane UI Data Contract & 60Hz `StateTable` (`src-tauri/src/pipeline/`)

Never serialize signal names, units, comments, or enum strings at 60Hz! Split communication into two planes:

1. **Plane 1 — Control / Schema Plane (`DatabaseSchemaDto`, sent ONCE on DB load):**
   * Contains `DatabaseInfoDto` (with `ParseDiagnosticDto[]`), `EcuNodeDto[]`, `MessageSchemaDto[]`, `SignalSchemaDto[]` (indexed by dense `signalId: u32`), and **pre-computed `bitLayout: BitCellDto[]`** so the React `BitLayoutMatrix` (`8x8` / `64x8`) renders Intel & Motorola spans without bit-math in JS.
2. **Plane 2 — Live Telemetry Plane (`TelemetrySnapshotDto`, streamed at 60Hz via `tauri::ipc::Channel`):**
   * Keyed by `(bus_id, can_id_key)`. Tracks `smoothed_cycle_ms` (`0.85 * old + 0.15 * dt`), `CycleHealth` (`Nominal` | `Late` | `Timeout` vs `GenMsgCycleTime`), `changed_bytes_mask: u64` (300ms highlight window across all 64 CAN-FD bytes), and `estimated_bus_load_pct`.
   * **Retained Mux State (Crucial for EV BMS):** Retain last-known values + `last_updated_us` for **all** multiplexer branches of a message (e.g. 96 BMS cell voltages across `Mux 0..23`), flagging `active_in_last_frame: true` on the branch updated most recently so non-current mux banks never vanish or flicker in the UI.

## Verification Gates
1. `cargo test -p nexus-netdb` covers Intel/Motorola cross-byte spans, 64-byte CAN-FD offsets (`byte > 8`), negative signed ints, `f32`/`f64`, cascaded `SG_MUL_VAL_`, Windows-1252 `.dbc`, `.kcd` parity, and roundtrip `encode -> extract`.
2. Verify 50,000 fps burst into `StateTable` emits strictly 60Hz snapshots over `tauri::ipc::Channel` with zero dropped frames.
