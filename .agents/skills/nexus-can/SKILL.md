---
name: nexus-can
description: >-
  Master router and architectural orchestrator for the NexusCAN (CanScope) project — a high-throughput
  Rust Workspace + Tauri v2 CAN / CAN-FD analyzer, multi-format network database engine (nexus-netdb:
  .dbc / .kcd), EV infrastructure, and Industrial IoT telemetry client. Activate FIRST on every prompt
  when `nexus-can` is invoked or any NexusCAN task is requested, then route to the exact sub-skills.
---

# `nexus-can` — Master Skill Router & Architectural Orchestrator

You are orchestrating **NexusCAN**, a modular **Rust Cargo Workspace + Tauri v2 + React/TypeScript/TailwindCSS** CAN / CAN-FD telemetry and analysis platform defined in [README.md](../../../README.md) and [project_details.md](../../../project_details.md).

Because development proceeds **incrementally step by step** through `nexus-can`, execute this router protocol on every prompt before writing code.

---

## 1. Router Execution Protocol (Every Prompt)

1. **Classify Intent & Workspace Crate:** Map the user's request to the target workspace layer (`crates/nexus-core`, `crates/nexus-hal`, `crates/nexus-netdb`, `crates/nexus-protocols`, `src-tauri`, `src/`, or `scripts/`) using **Section 3 (Master Routing Matrix)**.
2. **Progressive Disclosure (`read_file`):** Read **only** the **1–3 Primary Sub-Skills** matched for the current task. Load Secondary / Deep Reference skills only when hitting specialized protocol or compliance edge cases.
   * If the user asks a pure planning question or asks to update `nexus-can` routing itself, handle it directly without loading unnecessary sub-skills.
3. **Enforce the 5 Strict Architectural Guardrails (Section 2).**
4. **Step-by-Step Scoped Delivery:** Implement **only** what the current step asks for — complete, production-grade code with zero `todo!()` placeholders, without prematurely building unrequested phases.
5. **Verify Before Concluding:** Run `cargo check` / `cargo test` for touched Rust crates and TypeScript/build checks for touched `src/` files.

---

## 2. Five Non-Negotiable Architectural Guardrails

Every routed task MUST uphold the architecture in [project_details.md](../../../project_details.md):

1. **Zero-Allocation 80-Byte Frame (`crates/nexus-core`):**
   * `RawCanFrame` is `#[repr(C)]`, `Copy`, exact 80 bytes with `bus_id: u8` and stack `data: [u8; 64]` (8B CAN + 64B CAN-FD). **Never** allocate `Vec<u8>` per frame on the hot path.
2. **Two-Layer Multi-Bus HAL (`crates/nexus-hal`):**
   * Separate discovery (`AdapterDriver`) from hot-path batch I/O (`CanChannel::recv_batch` / `send_frame`). Pipeline and UI remain 100% decoupled from `SocketCAN`, `mock0`, `gs_usb`, `SLCAN`, or `PCAN`.
3. **3-Stage Standalone Signal DB Compiler (`crates/nexus-netdb`):**
   * Zero Tauri/UI dependencies. `Stage 1: DatabaseFormatParser (.dbc, .kcd, Windows-1252 safe, fault-tolerant ParseDiagnostic)` → `Stage 2: Canonical NetworkDatabase IR` → `Stage 3: CompiledDatabase (512-bit CAN-FD safe Intel/Motorola/Float/Signed RX extractor & TX encoder + cascaded SG_MUL_VAL_ MuxDecisionTree + J1939 PGN mask)`.
4. **Zero-Bottleneck 60Hz Decimation (`src-tauri/src/pipeline/`):**
   * **Never** emit per-frame IPC events. `Reader Thread` → `Bounded Lock-Free Channel` → `StateTable (EMA dt_ms, CycleHealth, 64-bit 300ms changed_bytes_mask, Retained Mux State across all mux banks)` → strictly **60Hz (`16.6ms`) `tauri::ipc::Channel`**.
5. **Two-Plane UI Data Contract (`src-tauri` ↔ `src/`):**
   * **Schema Plane (`DatabaseSchemaDto`):** Sent **once** on DB load (ECUs, messages, comments, units, `VAL_` enums, pre-computed `BitLayoutMatrix` cells).
   * **Telemetry Plane (`TelemetrySnapshotDto`):** Streamed at **60Hz** carrying compact numeric values keyed by dense `SignalId` — zero repeated string serialization on the hot path.

---

## 3. Master Routing Matrix

### A. Rust Workspace Core, `nexus-netdb`, `nexus-hal` & Tauri v2

| Target Layer / Trigger Keywords & Paths | Primary Route (Read First) | Secondary / Deep Reference |
| :--- | :--- | :--- |
| **`nexus-core` & `nexus-hal`: `RawCanFrame`, `AdapterDriver`, `CanChannel`, SocketCAN (`can0`/`vcan0`), `mock0`, USB-CAN (`gs_usb`), SLCAN, PCAN**<br>`crates/nexus-core/**`, `crates/nexus-hal/**` | [`nexuscan-hal-drivers`](../nexuscan-hal-drivers/SKILL.md) | [`can-bus-industrial`](../can-bus-industrial/SKILL.md)<br>[`canbus-integration`](../canbus-integration/SKILL.md)<br>[`connectivity-usb-can`](../connectivity-usb-can/SKILL.md) |
| **`nexus-netdb` & 60Hz Pipeline: `.dbc`/`.kcd` Parsers, Canonical IR, Intel/Motorola/Float/Mux Codec, TX Encoder, `StateTable`, Two-Plane DTOs**<br>`crates/nexus-netdb/**`, `src-tauri/src/pipeline/**` | [`nexuscan-dbc-pipeline`](../nexuscan-dbc-pipeline/SKILL.md) | [`rust-concurrency`](../rust-concurrency/SKILL.md)<br>[`automotive-embedded-skills`](../automotive-embedded-skills/SKILL.md) |
| **Tauri v2 App Setup, `tauri::ipc::Channel`, `#[tauri::command]`, App State, Capabilities/ACL, Desktop Bundling**<br>`src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs` | [`tauri-v2`](../tauri-v2/SKILL.md)<br>[`tauri-ipc`](../tauri-ipc/SKILL.md) | [`tauri`](../tauri/SKILL.md)<br>[`tauri-security`](../tauri-security/SKILL.md)<br>[`tauri-build`](../tauri-build/SKILL.md) |
| **Rust Workspace Architecture, Zero-Copy Parsing (`winnow`/`nom`), Lock-Free Concurrency, Profiling & Idioms**<br>`Cargo.toml`, `crates/**/*.rs` | [`rust-skill`](../rust-skill/SKILL.md)<br>[`rust-concurrency`](../rust-concurrency/SKILL.md) | — |

### B. Higher-Layer CAN Protocols, Reverse Engineering & EV / Industrial IoT

| Target Layer / Trigger Keywords & Paths | Primary Route (Read First) | Secondary / Deep Reference |
| :--- | :--- | :--- |
| **J1939 (29-bit PGN/BAM), ISO-TP (`ISO 15765-2`), UDS (`ISO 14229`), CANopen (`CiA 301/402`), CHAdeMO / GB/T**<br>`crates/nexus-protocols/**` | [`nexuscan-ev-protocols`](../nexuscan-ev-protocols/SKILL.md) | [`canopen-integration`](../canopen-integration/SKILL.md)<br>[`can-bus-industrial`](../can-bus-industrial/SKILL.md)<br>[`automotive-embedded-skills`](../automotive-embedded-skills/SKILL.md) |
| **EV BMS Telemetry, Cell Balancing, SOC/SOH, DC Fast Charging, ISO 15118 / V2G / OCPP** | [`nexuscan-ev-protocols`](../nexuscan-ev-protocols/SKILL.md) | [`automotive-battery-bms-engineer`](../automotive-battery-bms-engineer/SKILL.md)<br>[`automotive-battery-charging-engineer`](../automotive-battery-charging-engineer/SKILL.md)<br>[`automotive-ev-systems-charging-infrastructure-engineer`](../automotive-ev-systems-charging-infrastructure-engineer/SKILL.md) |
| **Unknown CAN Signal Reverse Engineering, Log Correlation, Bit Search, Building/Merging `.dbc` Files**<br>`*.dbc`, `*.kcd`, `*.mf4`, `*.blf`, `*.csv` | [`cansub-reverse-engineering`](../cansub-reverse-engineering/SKILL.md)<br>[`combine-dbc`](../combine-dbc/SKILL.md) | [`cansub-knowledge`](../cansub-knowledge/SKILL.md)<br>[`re-automotive`](../re-automotive/SKILL.md)<br>[`matlab-use-vehicle-network`](../matlab-use-vehicle-network/SKILL.md)<br>[`matlab-import-export-vehicle-data`](../matlab-import-export-vehicle-data/SKILL.md) |
| **AUTOSAR, MISRA, Functional Safety (`ISO 26262`), Cybersecurity (`ISO 21434`), Fault Injection & CAPL Reference** | [`automotive-embedded-skills`](../automotive-embedded-skills/SKILL.md) | *(180+ granular rule files under `rules/` — load only specific files on demand)* |

### C. Simulation, Benchmarks & 60FPS Dark Industrial Frontend

| Target Layer / Trigger Keywords & Paths | Primary Route (Read First) | Secondary / Deep Reference |
| :--- | :--- | :--- |
| **Virtual CAN (`vcan0` MTU 72), `cangen`/`canplayer`, 50kfps Stress Benchmarks, WSL2 Fallbacks, HIL Testing**<br>`scripts/**`, `tests/**`, `benches/**` | [`nexuscan-vcan-hil`](../nexuscan-vcan-hil/SKILL.md) | [`automotive-testing-hil-test-engineer`](../automotive-testing-hil-test-engineer/SKILL.md)<br>[`re-automotive`](../re-automotive/SKILL.md) |
| **Dark Industrial React / TS / Tailwind UI (`TopBar`, `FixedTraceTable`, `BitLayoutMatrix`, `DatabaseExplorer`, `SignalInspector`, Stores)**<br>`src/**/*.tsx`, `src/**/*.ts`, `src/**/*.css` | Global `ui-ux-pro-max` *(if available)* + [`tauri-ipc`](../tauri-ipc/SKILL.md) | Enforce `bg-[#0B0F17]`, `border-slate-800`, `font-mono tabular-nums`, O(1) `databaseStore` `SignalId` joins, 60FPS zero-thrash rendering |

---

## 4. Phase-Based Multi-Skill Recipes

* **Faz 1 (`Cargo` Workspace + `nexus-core` + `nexus-netdb` `.dbc`/`.kcd` Compiler & Codec + Tests):**
  Activate [`nexuscan-dbc-pipeline`](../nexuscan-dbc-pipeline/SKILL.md) + [`rust-skill`](../rust-skill/SKILL.md).
* **Faz 2 (`nexus-hal` + `socketcan`/`mock0` + 60Hz `StateTable` + Tauri v2 `Channel`):**
  Activate [`nexuscan-hal-drivers`](../nexuscan-hal-drivers/SKILL.md) + [`nexuscan-dbc-pipeline`](../nexuscan-dbc-pipeline/SKILL.md) + [`tauri-v2`](../tauri-v2/SKILL.md) + [`tauri-ipc`](../tauri-ipc/SKILL.md).
* **Faz 3 (60FPS Industrial Dark UI + `DatabaseExplorer` + `BitLayoutMatrix` + TX Composer):**
  Activate `ui-ux-pro-max` + [`tauri-ipc`](../tauri-ipc/SKILL.md).

---

## 5. Step-by-Step Router Extension Protocol ("Adım Adım Ekleme")

Whenever the user requests adding a new capability or domain skill (e.g., `.blf`/`.mf4` Trace Logger, WebGL Signal Oscilloscope, Periodic TX Sequencer, UDS Diagnostic Console, Remote WebTransport Bridge):

1. Create `.agents/skills/nexuscan-<module>/SKILL.md` with clear `name` + `description` frontmatter, zero-allocation Rust/TS contracts, and verification commands.
2. Register a new row in **Section 3 (Master Routing Matrix)** above with its trigger keywords, target paths, and relative link.
3. Keep `nexus-can/SKILL.md` concise as pure routing + invariants; store bulky protocol tables or scripts inside the sub-skill's `references/` or `scripts/` directory.
