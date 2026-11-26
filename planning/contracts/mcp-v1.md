# MCP v1 — In-App Model Context Protocol Server (team-lead contract)

Status: M1, M1.1, UI Bridge, M2, M3 DONE (46 baseline tools). M4-ARM adds the 47th tool. Next: M3.5. Later phases: see §7.
Out of scope forever: `crates/nexus-cli/` is NOT touched by MCP work.

## 1. Architecture
- `crates/nexus-mcp` (rmcp 3.11, Streamable HTTP server) holds `Arc<PipelineEngine>`; no tauri dependency.
- Started/stopped from `src-tauri` (`cmd_mcp_start/stop/status`, permission set `mcp`); off by default, not persisted, stopped when the main window closes.
- Bind `127.0.0.1` only, path `/mcp`, `DEFAULT_PORT = 17800` (below all ephemeral ranges; WSL2 mirrored mode reserves e.g. 44620–48715 on Windows → AddrInUse). Busy port → explicit error, never silent fallback.
- Auth: per-start 32-byte `getrandom` token, `Authorization: Bearer`, constant-time compare. Host/Origin must be loopback (`127.0.0.1`/`localhost`), checked before the token.
- Engine calls run in `spawn_blocking`. MCP never touches the RX reader / aggregator / 60Hz StateTable path.
- Browser mode (Vite + `nexus_bridge`): MCP unavailable; UI shows "desktop app only" and never invokes `cmd_mcp_*`.

## 2. Safety invariants
- Analysis and UI tools are available alongside the single operator-approved bus mode change specified in §10.
- Future bus-affecting tools (M4) require: bus already Armed by the user + `ui_confirm` approval + clamp + rate limit; Panic Stop always wins. Flash/seed-key stay closed permanently.
- Every tool call is audited to the Debug Console (category `MCP`, source `mcp`), rate-limited (≤10 individual events/s, rest summarised).

## 3. DTOs
```rust
#[serde(rename_all = "camelCase")]
pub struct McpServerStatusDto { running: bool, port: Option<u16>, endpoint_url: Option<String>,
  token: Option<String>, connected_clients: u32, total_calls: u64, read_only: bool,
  last_error: Option<String>, ui_attached: bool }
#[serde(rename_all = "camelCase")]
pub struct UiRequestDto { request_id: u64, kind: String, args: serde_json::Value }
```
Commands: `cmd_mcp_start(port: Option<u16>)`, `cmd_mcp_stop()`, `cmd_mcp_status()`,
`cmd_mcp_ui_attach(on_request: Channel<UiRequestDto>)`, `cmd_mcp_ui_respond(request_id, ok, result, error)`.

## 4. Tools
| Tool | Phase | Notes |
| :--- | :--- | :--- |
| `db_info`, `db_search_signals`, `db_get_message`, `db_decode_frame` | M1 (+`bus_id` in M1.1) | DB resolution rule below |
| `trace_list`, `trace_summary`, `trace_query`, `trace_signal_series` | M1 | times relative to first frame (µs); cursor = frame index |
| `db_list`, `db_get_ecu`, `db_diagnostics`, `db_encode_frame` | M1.1 | encode = clamp + report, **never transmits** |
| `ui_get_state`, `ui_navigate`, `ui_select_message`, `ui_trace_filter`, `ui_plot_signals`, `ui_notify`, `ui_confirm` | UI Bridge | timeout 5 s (confirm 60 s); not attached → explicit error |

DB resolution: explicit `bus_id` → that bus; else global; else the single bus DB; else error listing bus ids. Responses state which DB was used.
ID rule: value > 0x7FF or 8-hex-digit spelling (`0x000001A0`) ⇒ extended; explicit `is_extended` wins.
UI views: `start|connections|rxtx|trace|plotter|symbols|panels|diagnostics|re`; diagnostics subTabs `ecu_registry|workbench|session|ecu_graph|dtc|live_pids|uds_console|did_inspector|flow|uds_panel`; symbols subTabs `messages|ecus|diagnostics`.

## 5. Checklist (verify BEFORE handing in — derived from QA findings MCP-QA-01..06)
- [ ] Every response ≤ 16 KB incl. **error paths** and rmcp schema/deserialize errors (`sanitize_call_response`); `truncated: true` when clipped.
- [ ] User input echoed in errors is clipped (≤64 chars), error text ≤512 chars.
- [ ] Every cache/buffer has an explicit budget (frames/bytes/entries) + eviction; released on server stop.
- [ ] Concurrent identical expensive work is single-flight; guards only remove their *own* entry (`Arc::ptr_eq`); panic-safe.
- [ ] List/limit params have a max and clamp; cursor pagination is gap/duplicate free.
- [ ] CAN ID filters respect the extended flag (rule above); CAN-FD 64-byte payloads supported.
- [ ] Path-like inputs resolved only via engine listings (no traversal).
- [ ] Audit + rate limit applied to new tools; background tasks aborted on stop (no `Arc<PipelineEngine>` leak).
- [ ] Tool descriptions say what the tool does NOT do (e.g. "does NOT transmit").
- [ ] Hot path untouched; new engine accessors take read locks only and clone `Arc`s.

## 6. Verification (quiet)
```
cargo fmt --all --check
cargo clippy -q -p nexus-mcp -p nexus-hal --all-targets -- -D warnings
cargo test -q -p nexus-mcp | grep -E "test result|FAILED|panicked"
(cd src-tauri && cargo check -q && cargo clippy -q --all-targets -- -D warnings)
npx tsc -p tsconfig.app.json --noEmit
```
Full gate (phase end only): `cargo nextest run --workspace --status-level fail`, `cargo test --release -p nexus-mcp --test qa_hotpath_mcp -- --ignored --nocapture` (dropped == 0, 60Hz cadence unchanged).
Windows: `npm run tauri build -- --runner cargo-xwin --target x86_64-pc-windows-msvc --no-bundle`.

## 7. Roadmap
| Phase | Scope |
| :--- | :--- |
| M2 | `app_status`, `project_list/get`, `device_list`, `driver_probe`, `bus_status`, `live_message_table`, `live_signal_values`, `periodic_tx_list`, `signal_stats`, `trace_compare`, `live_trace_window`, `debug_events_query` (live data read from snapshots only) |
| M3 | Read-only diagnostics, RE and workspace-history tools — see §9 (UDS reads 0x22/0x19, `re_session`, `re_scan` moved to M4: they transmit or mutate user state) |
| M3.5 | UI-state tools for frontend-only data (simulation panels, ECU registry, UDS panel) via UI Bridge |
| M4-ARM | Operator-approved Arm Active Bus for one connected bus, see §10. |
| M4-RE | `re_hunt` / `re_labels_get` over recorded traces, every run behind `ui_confirm` — see `re-hunt-v1.md` §6 |
| M4 | Gated actions with Armed + `ui_confirm`: bus (`tx_send`, active ECU discovery, UDS reads 0x22/0x19 on a user-opened session) and user-state (`re_session` start/stop/phase/mark, `re_scan` first/next/undo/reset, passive discovery start/stop) |
Target total ≈ 45–50 tools; group related operations behind an `op` parameter instead of adding tools.

## 8. M2 — Live data + workspace (DONE — 32 tools)
Data source for live tools: `PipelineEngine::latest_snapshot() -> Option<TelemetrySnapshotDto>` (already produced at 60Hz for
the UI: `buses: Vec<BusHealthDto>`, `frames: Vec<FrameTelemetryDto>` with per-signal state, `recent_chronological`,
fps/bus load/dropped/err counters, `replay`, `tx_panic_latched`). MCP only reads/clones the latest snapshot — never
subscribes per frame, never adds work to the aggregator. If no snapshot exists (no bus / no UI subscriber), return an
explicit `{ "live": false, "message": ... }` instead of an error. Signal names resolved via `dbsel` (§4) per bus.
Router split (no edits to `server.rs` needed; skeletons exist):
| File | Agent | Tools |
| :--- | :--- | :--- |
| `src/server/live.rs` (+ optional `src/tools_live.rs`) | backend-A | `app_status` (buses, DBs per bus, replay, panic latch, fps, dropped, MCP/UI attached), `device_list`, `driver_probe`, `bus_status { bus_id? }` (mode Listen-Only/Armed, bus_state, TEC/REC, load, enforcement), `live_message_table { bus_id?, ids?, sort?: "rate"|"id"|"age", limit≤100 }` (id, name, count, rate Hz, last data hex, changed-bytes, age ms), `live_signal_values { names[]≤32, bus_id? }` (physical, unit, raw, enum label, age ms, out_of_range), `periodic_tx_list` (read only), `signal_stats { names[]≤8, window_ms≤10000 }` (min/max/mean/last over repeated snapshot sampling — sample ≤ 60 Hz inside the call, bounded duration), `live_trace_window { last_ms≤5000, ids?, limit≤200 }` (from `recent_chronological`) |
| `src/server/workspace.rs` (+ optional `src/tools_workspace.rs`) | backend-B | `project_list`, `project_get { name }` (summary: buses, DB bindings, panels count — never the raw file dump > cap), `trace_compare { a, b, top_n≤50 }` (IDs only in A/B, rate change %, DLC change, signal min/max change if DB), `debug_events_query { level?, category?, since_ms?, text?, limit≤100 }` |
Both: every tool read-only (`read_only_hint = true`), audited, ≤16 KB, §5 checklist applies. Do NOT edit
`tests/qa_m1_gate.rs` (team-lead updates the tool list) or `server.rs` instructions text (team-lead).

Approved deviation (M2): `signal_stats` / `live_trace_window` additionally read the 60 Hz snapshot stream via `engine.subscribe()` (tokio `broadcast`: sender never blocks, laggers get `Lagged`) for a bounded window (≤10 s / ≤5 s), max 2 concurrent samplers per engine — `recent_chronological` only covers the last tick (~17 ms).

## 9. M3 — Diagnostics / RE / workspace history (read-only, DONE)
Skeletons exist (team-lead): `src/server/{diag,re,runs}.rs` (`#[tool_router(..., allow_empty)]` — remove `allow_empty`
once a tool exists) and `src/tools_{diag,re,runs}.rs`; `server.rs` / `lib.rs` already wire them. Agents do NOT edit
`server.rs`, `lib.rs`, `tests/qa_m1_gate.rs`, other agents' files. All tools: `read_only_hint = true`, `run(...)` audited,
§5 checklist, ≤16 KB. None may open/close a diag session, send UDS, start/stop discovery/RE/scan, or write files.

| File | Agent | Tools |
| :--- | :--- | :--- |
| `server/diag.rs`, `tools_diag.rs`, + read-only accessor in `nexus-hal/src/pipeline/diag_session.rs` (and `diag_passive.rs` if needed) | backend-A | `diag_session_info { bus_id?, request_id?, response_id?, is_extended? }`: no addressing → list all sessions known to the engine (`PipelineEngine::diag_session_list() -> Vec<DiagSessionInfoDto>`, new, read lock + clone only; ≤32 entries); with addressing → that one (`cmd_diag_session_info`). `diag_conversation { session selector, since_seq?, limit≤100 }` (`cmd_diag_get_conversation`, next cursor = `last_seq`). `diag_isotp_frames { selector, since_seq?, limit≤200 }` (`cmd_diag_get_isotp_frames`, hex payloads, CAN-FD 64B). `diag_passive_discovery { bus_id? }`: snapshot only (`cmd_diag_passive_discovery_snapshot`; all buses with a scan when omitted); never starts/stops. Selector resolution: `bus_id` + `request_id` (+ optional `response_id`) matched against `diag_session_list()`; ambiguous/none → error listing candidates (≤8). |
| `server/re.rs`, `tools_re.rs` | backend-B | `re_status`: `re_status()` + `cmd_re_focus_status()` + `cmd_re_scan_status()` + `cmd_re_markers()` (markers newest-first ≤50) in one object. `re_series { bus_id, id, is_extended?, candidates[]≤5, reference?, from_us?, to_us?, max_points≤500 }`: calls `cmd_re_series`, **decodes the NRS1 binary** (re_focus.rs §6.3 layout) into JSON `[{label, points:[[t_us, value]]}]`; never returns raw bytes. `re_correlate { …, top_n≤20 }` (`cmd_re_correlate`). `re_scan_results { offset?, limit≤100, sort? "id"|"changes"|"width" }`. `re_row_detail { bus_id, id, is_extended? }` (`cmd_re_row_detail` + `cmd_re_classify`). `re_dbc_generate { drafts[], base_db_id? }`: pure `re_dbc_generate`, returns DBC text + diagnostics (text clipped → `truncated: true`); never saves/loads. RE disabled → `{ "enabled": false, ... }` not an error. Focus required by series/correlate → explicit error saying the user must focus the target in the RE view (MCP never calls `cmd_re_focus_set`). |
| `server/runs.rs`, `tools_runs.rs` | backend-C | `run_query { project_id, ecu_id?, flow_id?, status?, from?, to?, limit≤50 }` (`cmd_run_query`; summarised records: id, time, ecu, flow, status, duration, step counts — no raw step payload dumps > cap). `run_latest { project_id }` (`cmd_run_latest`, ≤50). `flowlib_list { include_deleted? }` (`cmd_flowlib_list`, ≤200, + revision count). `flowlib_get { id, revision? }`: metadata + revisions (`cmd_flowlib_revisions`) + structural summary (kind, node/step count, referenced services/DIDs) and the raw JSON only if it fits (else `truncated: true`). `id` validated against `cmd_flowlib_list(true)` (no path traversal). |

M3 safety additions to §5 checklist:
- [ ] Diag payload redaction: SecurityAccess (0x27 / 0x67) and Authentication (0x29 / 0x69) request/response data bytes beyond SID+subFunction are replaced by `"<redacted>"` with `redacted: true` in conversation and ISO-TP frame outputs (ISO-TP: redact the reassembled PDU's frames by matching conversation seq, or redact all data bytes of frames whose first PDU byte is one of those SIDs).
- [ ] No tool calls a `cmd_diag_open/close/send/read_*`, `cmd_*_start/stop`, `cmd_re_focus_set`, `cmd_re_scan_first/next/undo/reset`, `cmd_flowlib_save/delete`, `cmd_run_append`.
- [ ] Binary engine outputs decoded with bounds checks (truncated buffer → error, never panic).
- [ ] Redaction fails closed: data that cannot be proven harmless (ISO-TP CF whose FF is not on the page, unparsable flow JSON) is hidden, not shown.
- [ ] Secret redaction in structured data is allowlist-based for security blocks (`uds_security_access`, `*seed*`, `*auth*`, `*key*` types: only structural config fields visible) plus a normalised name denylist (camelCase/snake_case) elsewhere (QA-M3-01).
- [ ] MCP never cancels or overrides user-started work (e.g. use `cmd_re_correlate_observer`, not `cmd_re_correlate`); user actions always win over MCP calls.

M3 implementation notes (team-lead): 46 tools. Deviations accepted: `re_dbc_generate` rejects `base_db_id` (no engine IR accessor — backlog `PipelineEngine::database_ir`); `re_series` max 4 candidates + 1 reference (engine limit); nexus-mcp reads session DTOs via serde (no `nexus-protocols` dep).


## 10. M4-ARM — Operator-approved Arm Active Bus

Goal: let an MCP assistant request Active Bus during a reverse-engineering session. The desktop operator approves each transition for a single currently connected bus. Opening and inspecting a passive RE session remains independent of arming.

- The `ui_request_bus_arm` tool takes an explicit zero-based `bus_id`. The backend resolves the current adapter, channel and connection instance and builds the confirmation from those values. The dialog states that active mode can acknowledge CAN frames and enables transmission from the application.
- Use a dedicated, action-bound confirmation through the desktop UI Bridge. The generic `ui_confirm` response is insufficient. Approval is single-use, expires after at most 60 seconds, and is bound to the originating request, the connection instance and the exact action. Cancelled calls, rejected or expired prompts, and a detached UI leave the bus unchanged.
- Immediately before applying the mode change, the backend validates the connection instance and the Panic Stop state in the same synchronization boundary as the transition. A disconnect/reconnect, changed operating state, or Panic Stop after the prompt invalidates the approval. MCP never clears the Panic Stop latch.
- Apply the existing HAL mode transition and publish the resulting bus state through the normal telemetry path. Arming via MCP is session-only and leaves the saved profile's Listen-Only setting intact. An approval authorizes only this mode transition. TX tools require their own authorization.
- Audit the request, operator decision and transition result. Rate-limit prompts and allow a single pending Active Bus request per MCP server. An already armed bus returns its current state without another transition.

Acceptance: exercise approval, rejection, expiry, cancellation, replayed approval, a missing UI, reconnect on the same bus ID and Panic Stop during confirmation. Verify that only explicit approval arms the original connection, that arming sends no application frame and that saved profile settings remain intact. Start with `mock0` and run the confirmation flow through the Tauri desktop application.
