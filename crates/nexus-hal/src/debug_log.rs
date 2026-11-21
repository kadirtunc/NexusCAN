//! Central `DebugEventHub` & non-blocking `.jsonl` session audit writer for NexusCAN's
//! Global & Multi-Window Tear-Off Debug & System Audit Console.
//!
//! ### Architectural Guarantees
//! - **Zero Hot-Path Cost**: Never called from `CanChannel::recv_batch` or `StateTable::ingest_frame`.
//! - **Bounded Memory (`5,000` entries)**: Oldest events evict in `O(1)` from a `VecDeque`.
//! - **1,000 ms Burst Coalescing**: Repeated identical `(category, bus_id, action, title)` events
//!   within `1,000 ms` increment `repeat_count` in-place instead of flooding the audit ring.
//! - **Non-Blocking Disk Persistence**: Session `.jsonl` writes flow over a bounded channel
//!   (`2,048` lines) via `try_send`, never blocking IPC or 60Hz aggregator threads, and flush +
//!   join in `< 15 ms` on `Drop`.

use crate::dto::{
    AppendDebugEventInputDto, DebugEventBatchDto, DebugEventDto, DebugWindowStateDto,
};
use crate::error::HalError;
use crossbeam_channel::{bounded, Receiver, Sender};
use nexus_core::now_monotonic_us;
use parking_lot::Mutex;
use std::collections::VecDeque;
use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::thread::{self, JoinHandle};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::broadcast;

/// Maximum number of structured audit events retained in memory.
pub const DEBUG_RING_CAPACITY: usize = 5_000;

/// Coalescing window (`1,000 ms`) for consecutive identical `(category, bus_id, action, title)` events.
pub const BURST_COALESCE_WINDOW_MS: u64 = 1_000;

const JSONL_CHANNEL_CAPACITY: usize = 2_048;
const DEBUG_BROADCAST_CAPACITY: usize = 256;
const MAX_SESSION_LOG_FILES: usize = 24;
const MAX_EVENT_TITLE_CHARS: usize = 512;
const MAX_EVENT_DETAILS_CHARS: usize = 4_096;

struct DebugRingState {
    next_seq: u64,
    events: VecDeque<DebugEventDto>,
    window_state: DebugWindowStateDto,
}

/// Thread-safe audit event ring buffer, multi-window state coordinator, and non-blocking `.jsonl` logger.
pub struct DebugEventHub {
    inner: Mutex<DebugRingState>,
    bcast_tx: broadcast::Sender<DebugEventBatchDto>,
    jsonl_tx: Mutex<Option<Sender<String>>>,
    writer_join: Mutex<Option<JoinHandle<()>>>,
}

impl Default for DebugEventHub {
    fn default() -> Self {
        Self::new_in_memory()
    }
}

impl DebugEventHub {
    /// Creates an in-memory [`DebugEventHub`] without a background `.jsonl` file writer.
    pub fn new_in_memory() -> Self {
        Self::with_logs_dir(None)
    }

    /// Creates a [`DebugEventHub`], optionally starting a non-blocking background writer for
    /// `<logs_dir>/session_<unix_sec>.jsonl`.
    pub fn with_logs_dir(logs_dir: Option<PathBuf>) -> Self {
        let (bcast_tx, _) = broadcast::channel(DEBUG_BROADCAST_CAPACITY);
        let (session_log_path, jsonl_tx, writer_join) = match logs_dir {
            Some(dir) => match spawn_session_jsonl_writer(&dir) {
                Some((path_str, tx, join)) => (Some(path_str), Some(tx), Some(join)),
                None => (None, None, None),
            },
            None => (None, None, None),
        };

        let window_state = DebugWindowStateDto {
            detached_open: false,
            always_on_top: false,
            re_dock_requested: false,
            session_log_path,
        };

        Self {
            inner: Mutex::new(DebugRingState {
                next_seq: 0,
                events: VecDeque::with_capacity(256),
                window_state,
            }),
            bcast_tx,
            jsonl_tx: Mutex::new(jsonl_tx),
            writer_join: Mutex::new(writer_join),
        }
    }

    /// Subscribes to live [`DebugEventBatchDto`] updates (`"append"`, `"cleared"`, `"windowState"`).
    pub fn subscribe(&self) -> broadcast::Receiver<DebugEventBatchDto> {
        self.bcast_tx.subscribe()
    }

    /// Returns a point-in-time `"snapshot"` batch containing all buffered events and current window state.
    pub fn snapshot_batch(&self) -> DebugEventBatchDto {
        let guard = self.inner.lock();
        let events: Vec<DebugEventDto> = guard.events.iter().cloned().collect();
        let total_buffered = events.len();
        let window_state = guard.window_state.clone();
        DebugEventBatchDto {
            kind: "snapshot".to_string(),
            events,
            total_buffered,
            window_state,
        }
    }

    /// Returns the current [`DebugWindowStateDto`].
    pub fn window_state(&self) -> DebugWindowStateDto {
        self.inner.lock().window_state.clone()
    }

    /// Updates the tear-off window state and broadcasts a `"windowState"` batch to all subscribers.
    ///
    /// `re_dock_requested` is a one-shot edge trigger emitted on this `"windowState"` broadcast
    /// (and returned to the caller), then immediately reset to `false` inside `DebugRingState` so
    /// subsequent `"append"`, `"cleared"`, and `"snapshot"` batches never re-open a closed dock.
    pub fn set_window_state(
        &self,
        detached_open: bool,
        always_on_top: bool,
        re_dock_requested: bool,
    ) -> DebugWindowStateDto {
        let (emitted_ws, total_buffered) = {
            let mut guard = self.inner.lock();
            guard.window_state.detached_open = detached_open;
            guard.window_state.always_on_top = if detached_open { always_on_top } else { false };
            let mut emitted = guard.window_state.clone();
            emitted.re_dock_requested = re_dock_requested;
            guard.window_state.re_dock_requested = false;
            (emitted, guard.events.len())
        };

        let _ = self.bcast_tx.send(DebugEventBatchDto {
            kind: "windowState".to_string(),
            events: Vec::new(),
            total_buffered,
            window_state: emitted_ws.clone(),
        });
        emitted_ws
    }

    /// Invoked when the OS `"debug-console"` window fires `WindowEvent::Destroyed`:
    /// if `detached_open` was still `true`, transitions `detached_open -> false` (preserving any
    /// `re_dock_requested` flag) and broadcasts `"windowState"`.
    pub fn notify_external_window_destroyed(&self) -> Option<DebugWindowStateDto> {
        let maybe_update = {
            let mut guard = self.inner.lock();
            if !guard.window_state.detached_open {
                None
            } else {
                guard.window_state.detached_open = false;
                guard.window_state.always_on_top = false;
                Some((guard.window_state.clone(), guard.events.len()))
            }
        };

        if let Some((ws, total_buffered)) = maybe_update {
            let _ = self.bcast_tx.send(DebugEventBatchDto {
                kind: "windowState".to_string(),
                events: Vec::new(),
                total_buffered,
                window_state: ws.clone(),
            });
            Some(ws)
        } else {
            None
        }
    }

    /// Records a backend/OS/protocol structured audit event (coalescing identical bursts within `1,000 ms`).
    #[allow(clippy::too_many_arguments)]
    pub fn record(
        &self,
        severity: &str,
        category: &str,
        source: &str,
        bus_id: Option<u8>,
        action: &str,
        title: impl Into<String>,
        details: Option<String>,
    ) -> DebugEventDto {
        let now_ms = current_epoch_ms();
        let mono_us = now_monotonic_us().max(1);
        self.record_with_timestamps(
            now_ms,
            mono_us,
            severity,
            category,
            source,
            bus_id,
            action,
            title.into(),
            details,
        )
    }

    /// Appends an event originating from `cmd_append_debug_event` (defaults `source` to `"ui"`).
    pub fn append_input(&self, input: AppendDebugEventInputDto) -> DebugEventDto {
        let src = input
            .source
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("ui");
        self.record(
            &input.severity,
            &input.category,
            src,
            input.bus_id,
            &input.action,
            input.title,
            input.details,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn record_with_timestamps(
        &self,
        timestamp_ms: u64,
        monotonic_us: u64,
        severity_raw: &str,
        category_raw: &str,
        source_raw: &str,
        bus_id: Option<u8>,
        action_raw: &str,
        title_raw: impl AsRef<str>,
        details_raw: Option<String>,
    ) -> DebugEventDto {
        let severity = normalize_severity(severity_raw).to_string();
        let category = normalize_category(category_raw).to_string();
        let source = normalize_source(source_raw).to_string();
        let action = truncate_chars(action_raw.trim(), 128);
        let title = truncate_chars(title_raw.as_ref().trim(), MAX_EVENT_TITLE_CHARS);
        let details = details_raw
            .map(|d| truncate_chars(d.trim(), MAX_EVENT_DETAILS_CHARS))
            .filter(|d| !d.is_empty());

        let (emitted, total_buffered, window_state) = {
            let mut guard = self.inner.lock();
            let coalesce_hit = guard.events.back().is_some_and(|last| {
                last.category == category
                    && last.bus_id == bus_id
                    && last.action == action
                    && last.title == title
                    && timestamp_ms.saturating_sub(last.timestamp_ms) <= BURST_COALESCE_WINDOW_MS
            });

            let dto = if coalesce_hit {
                let last = guard.events.back_mut().expect("checked back().is_some()");
                last.repeat_count = last.repeat_count.saturating_add(1);
                last.timestamp_ms = timestamp_ms;
                last.monotonic_us = monotonic_us;
                last.severity = severity;
                if details.is_some() {
                    last.details = details;
                }
                last.clone()
            } else {
                guard.next_seq = guard.next_seq.saturating_add(1);
                if guard.events.len() >= DEBUG_RING_CAPACITY {
                    guard.events.pop_front();
                }
                let entry = DebugEventDto {
                    seq: guard.next_seq,
                    timestamp_ms,
                    monotonic_us,
                    severity,
                    category,
                    source,
                    bus_id,
                    action,
                    title,
                    details,
                    repeat_count: 1,
                };
                guard.events.push_back(entry.clone());
                entry
            };

            (dto, guard.events.len(), guard.window_state.clone())
        };

        // Non-blocking session `.jsonl` persistence (never stalls caller if disk channel is full)
        if let Some(ref tx) = *self.jsonl_tx.lock() {
            if let Ok(line) = serde_json::to_string(&emitted) {
                let _ = tx.try_send(line);
            }
        }

        let _ = self.bcast_tx.send(DebugEventBatchDto {
            kind: "append".to_string(),
            events: vec![emitted.clone()],
            total_buffered,
            window_state,
        });

        emitted
    }

    /// Clears all buffered in-memory events and broadcasts a `"cleared"` batch.
    pub fn clear(&self) {
        let ws = {
            let mut guard = self.inner.lock();
            guard.events.clear();
            guard.window_state.clone()
        };
        let _ = self.bcast_tx.send(DebugEventBatchDto {
            kind: "cleared".to_string(),
            events: Vec::new(),
            total_buffered: 0,
            window_state: ws,
        });
    }

    /// Formats all buffered audit events as `"jsonl"`, `"log"` (human-readable industrial table),
    /// or `"csv"` (RFC-4180 escaped).
    pub fn export_formatted(&self, format: &str) -> Result<String, HalError> {
        let events: Vec<DebugEventDto> = {
            let guard = self.inner.lock();
            guard.events.iter().cloned().collect()
        };

        let fmt = format.trim().to_ascii_lowercase();
        match fmt.as_str() {
            "jsonl" | "ndjson" => {
                let mut out = String::with_capacity(events.len().saturating_mul(180));
                for ev in &events {
                    if let Ok(line) = serde_json::to_string(ev) {
                        out.push_str(&line);
                        out.push('\n');
                    }
                }
                Ok(out)
            }
            "log" | "txt" => {
                let mut out = String::with_capacity(events.len().saturating_mul(140));
                for ev in &events {
                    let iso = epoch_ms_to_iso8601_utc(ev.timestamp_ms);
                    let sev = ev.severity.to_ascii_uppercase();
                    let bus_tag = match ev.bus_id {
                        Some(b) => format!("Bus {}", u16::from(b) + 1),
                        None => "SYS".to_string(),
                    };
                    let repeat_suffix = if ev.repeat_count > 1 {
                        format!(" (x{})", ev.repeat_count)
                    } else {
                        String::new()
                    };
                    match ev.details.as_deref() {
                        Some(det) if !det.is_empty() => {
                            out.push_str(&format!(
                                "[{iso}] [#{:04}] [{sev:<7}] [{:<9}] [{bus_tag}] {}{repeat_suffix} | {det}\n",
                                ev.seq, ev.category, ev.title
                            ));
                        }
                        _ => {
                            out.push_str(&format!(
                                "[{iso}] [#{:04}] [{sev:<7}] [{:<9}] [{bus_tag}] {}{repeat_suffix}\n",
                                ev.seq, ev.category, ev.title
                            ));
                        }
                    }
                }
                Ok(out)
            }
            "csv" => {
                let mut out = String::with_capacity(events.len().saturating_mul(160) + 128);
                out.push_str("seq,timestamp_iso,timestamp_ms,monotonic_us,severity,category,source,bus,action,title,details,repeat_count\r\n");
                for ev in &events {
                    let iso = epoch_ms_to_iso8601_utc(ev.timestamp_ms);
                    let bus_label = ev
                        .bus_id
                        .map_or_else(String::new, |b| format!("Bus {}", u16::from(b) + 1));
                    let details = ev.details.as_deref().unwrap_or("");
                    out.push_str(&format!(
                        "{},{},{},{},{},{},{},{},{},{},{},{}\r\n",
                        ev.seq,
                        csv_escape(&iso),
                        ev.timestamp_ms,
                        ev.monotonic_us,
                        csv_escape(&ev.severity),
                        csv_escape(&ev.category),
                        csv_escape(&ev.source),
                        csv_escape(&bus_label),
                        csv_escape(&ev.action),
                        csv_escape(&ev.title),
                        csv_escape(details),
                        ev.repeat_count,
                    ));
                }
                Ok(out)
            }
            other => Err(HalError::InvalidInput(format!(
                "Unsupported debug export format '{other}' (expected 'jsonl', 'log', or 'csv')"
            ))),
        }
    }
}

impl Drop for DebugEventHub {
    fn drop(&mut self) {
        // Dropping the bounded sender causes the writer thread's `rx.recv()` to wake immediately
        // (< 1 ms), flush any buffered lines, and exit cleanly well within the < 15 ms budget.
        let _ = self.jsonl_tx.lock().take();
        if let Some(handle) = self.writer_join.lock().take() {
            let _ = handle.join();
        }
    }
}

fn spawn_session_jsonl_writer(logs_dir: &Path) -> Option<(String, Sender<String>, JoinHandle<()>)> {
    if crate::storage::create_private_dir_all(logs_dir).is_err() {
        return None;
    }
    prune_old_session_logs(logs_dir);

    let unix_sec = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    let file_name = format!("session_{unix_sec}.jsonl");
    let file_path = logs_dir.join(file_name);

    // Refuse symlink targets before opening
    if let Ok(meta) = fs::symlink_metadata(&file_path) {
        if meta.file_type().is_symlink() || !meta.is_file() {
            return None;
        }
    }

    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&file_path)
        .ok()?;
    let display_path = fs::canonicalize(&file_path)
        .unwrap_or(file_path)
        .to_string_lossy()
        .to_string();

    let (tx, rx) = bounded::<String>(JSONL_CHANNEL_CAPACITY);
    let join = thread::Builder::new()
        .name("nexus-debug-jsonl".to_string())
        .spawn(move || run_jsonl_writer_loop(file, rx))
        .ok()?;

    Some((display_path, tx, join))
}

fn run_jsonl_writer_loop(file: File, rx: Receiver<String>) {
    let mut writer = BufWriter::with_capacity(16 * 1024, file);
    while let Ok(first_line) = rx.recv() {
        let _ = writer.write_all(first_line.as_bytes());
        let _ = writer.write_all(b"\n");
        let mut burst = 0usize;
        while burst < 256 {
            match rx.try_recv() {
                Ok(line) => {
                    let _ = writer.write_all(line.as_bytes());
                    let _ = writer.write_all(b"\n");
                    burst += 1;
                }
                Err(_) => break,
            }
        }
        let _ = writer.flush();
    }
    let _ = writer.flush();
}

fn prune_old_session_logs(logs_dir: &Path) {
    let Ok(entries) = fs::read_dir(logs_dir) else {
        return;
    };
    let mut session_files: Vec<(String, PathBuf)> = entries
        .flatten()
        .filter_map(|e| {
            let ft = e.file_type().ok()?;
            if !ft.is_file() {
                return None;
            }
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with("session_") && name.ends_with(".jsonl") {
                Some((name, e.path()))
            } else {
                None
            }
        })
        .collect();

    if session_files.len() >= MAX_SESSION_LOG_FILES {
        session_files.sort_by(|a, b| a.0.cmp(&b.0));
        let remove_count = session_files.len() + 1 - MAX_SESSION_LOG_FILES;
        for (_, path) in session_files.into_iter().take(remove_count) {
            let _ = fs::remove_file(path);
        }
    }
}

#[inline]
fn normalize_severity(raw: &str) -> &'static str {
    match raw.trim().to_ascii_lowercase().as_str() {
        "success" => "success",
        "warn" | "warning" => "warn",
        "error" | "err" => "error",
        "safety" => "safety",
        _ => "info",
    }
}

#[inline]
fn normalize_category(raw: &str) -> &'static str {
    match raw.trim().to_ascii_uppercase().as_str() {
        "CONN" => "CONN",
        "SAFETY" => "SAFETY",
        "TX" => "TX",
        "NETDB" => "NETDB",
        "TRACE" => "TRACE",
        "BUS_ERR" => "BUS_ERR",
        "DIAG" => "DIAG",
        "WORKBENCH" => "WORKBENCH",
        "RE" => "RE",
        // In-app MCP server audit trail (`nexus-mcp`).
        "MCP" => "MCP",
        _ => "WORKBENCH",
    }
}

#[inline]
fn normalize_source(raw: &str) -> &'static str {
    match raw.trim().to_ascii_lowercase().as_str() {
        "ui" => "ui",
        "os" => "os",
        "protocol" => "protocol",
        "mcp" => "mcp",
        _ => "backend",
    }
}

fn truncate_chars(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        s.to_string()
    } else {
        s.chars().take(max_chars).collect()
    }
}

#[inline]
fn current_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// Formats Unix epoch milliseconds into RFC-3339 / ISO-8601 UTC (`YYYY-MM-DDTHH:MM:SS.mmmZ`).
fn epoch_ms_to_iso8601_utc(epoch_ms: u64) -> String {
    let total_secs = epoch_ms / 1_000;
    let millis = epoch_ms % 1_000;
    let days = (total_secs / 86_400) as i64;
    let rem_secs = total_secs % 86_400;
    let hour = rem_secs / 3_600;
    let minute = (rem_secs % 3_600) / 60;
    let second = rem_secs % 60;

    // Howard Hinnant civil-from-days algorithm (proleptic Gregorian UTC)
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };

    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

/// RFC-4180 CSV field escaping (quotes fields containing `,`, `"`, `\r`, or `\n`).
fn csv_escape(val: &str) -> String {
    if val.contains([',', '"', '\r', '\n']) {
        let doubled = val.replace('"', "\"\"");
        format!("\"{doubled}\"")
    } else {
        val.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn ring_eviction_5000_burst_coalescing_exports_and_fast_jsonl_shutdown() {
        let tmp_logs = std::env::temp_dir().join(format!(
            "nexuscan-debug-hub-{}-{}",
            std::process::id(),
            now_monotonic_us()
        ));
        let _ = fs::remove_dir_all(&tmp_logs);

        let hub = DebugEventHub::with_logs_dir(Some(tmp_logs.clone()));
        let ws0 = hub.window_state();
        assert!(
            ws0.session_log_path.is_some(),
            "persistent logs_dir must populate session_log_path"
        );

        // 1. Burst coalescing within 1,000 ms on identical (category, bus_id, action, title)
        let e1 = hub.record_with_timestamps(
            1_700_000_000_000,
            1_000,
            "warn",
            "BUS_ERR",
            "backend",
            Some(0),
            "bus.error_frames",
            "CAN Error Frame burst on Bus 1",
            Some("delta=4, latest=NO-ACK".to_string()),
        );
        assert_eq!(e1.seq, 1);
        assert_eq!(e1.repeat_count, 1);

        let e2 = hub.record_with_timestamps(
            1_700_000_000_450,
            451_000,
            "error",
            "BUS_ERR",
            "backend",
            Some(0),
            "bus.error_frames",
            "CAN Error Frame burst on Bus 1",
            Some("delta=9, latest=CRTL[TX-Passive] | TEC=128 REC=0".to_string()),
        );
        assert_eq!(e2.seq, 1, "must coalesce into existing seq within 1,000 ms");
        assert_eq!(e2.repeat_count, 2);
        assert_eq!(e2.severity, "error");
        assert_eq!(hub.snapshot_batch().total_buffered, 1);

        // Outside 1,000 ms window -> creates a distinct entry (`seq == 2`)
        let e3 = hub.record_with_timestamps(
            1_700_000_001_600,
            1_601_000,
            "error",
            "BUS_ERR",
            "backend",
            Some(0),
            "bus.error_frames",
            "CAN Error Frame burst on Bus 1",
            Some("delta=1".to_string()),
        );
        assert_eq!(e3.seq, 2);
        assert_eq!(e3.repeat_count, 1);
        assert_eq!(hub.snapshot_batch().total_buffered, 2);

        // 2. Verify `.jsonl`, `.log`, and RFC-4180 `.csv` exports
        hub.record_with_timestamps(
            1_700_000_002_000,
            2_000_000,
            "safety",
            "SAFETY",
            "ui",
            None,
            "safety.panic_stop",
            "Panic Stop, \"Quoted\" test",
            Some("disarmed=2, jobs=1".to_string()),
        );

        let jsonl = hub.export_formatted("jsonl").expect("jsonl export");
        assert_eq!(jsonl.lines().count(), 3);

        let log_txt = hub.export_formatted("log").expect("log export");
        assert!(log_txt.contains("[#0001]"));
        assert!(log_txt.contains("(x2)"));
        assert!(log_txt.contains("[Bus 1]"));
        assert!(log_txt.contains("[SYS]"));

        let csv_txt = hub.export_formatted("csv").expect("csv export");
        assert!(csv_txt.starts_with("seq,timestamp_iso,timestamp_ms,"));
        assert!(
            csv_txt.contains("\"Panic Stop, \"\"Quoted\"\" test\""),
            "CSV must escape quotes & commas per RFC-4180: {csv_txt}"
        );
        assert!(hub.export_formatted("xml").is_err());

        // 3. Verify 5,000-entry ring buffer eviction
        for i in 0..5_010u32 {
            hub.record_with_timestamps(
                1_700_000_010_000 + u64::from(i) * 2_000,
                10_000_000 + u64::from(i) * 1_000,
                "info",
                "TX",
                "backend",
                Some(1),
                "tx.single_shot",
                format!("Frame #{i}"),
                None,
            );
        }
        let snap = hub.snapshot_batch();
        assert_eq!(snap.total_buffered, DEBUG_RING_CAPACITY);
        assert_eq!(snap.events.len(), DEBUG_RING_CAPACITY);
        assert_eq!(snap.events.first().unwrap().title, "Frame #10");
        assert_eq!(snap.events.last().unwrap().title, "Frame #5009");

        // 4. Verify clear() and window state transitions
        let ws_open = hub.set_window_state(true, true, false);
        assert!(ws_open.detached_open && ws_open.always_on_top && !ws_open.re_dock_requested);
        let ws_destroyed = hub
            .notify_external_window_destroyed()
            .expect("should transition detached_open -> false");
        assert!(!ws_destroyed.detached_open && !ws_destroyed.always_on_top);
        assert!(hub.notify_external_window_destroyed().is_none());

        hub.clear();
        assert_eq!(hub.snapshot_batch().total_buffered, 0);

        // 5. Verify clean `< 15 ms` writer thread shutdown & flushed `.jsonl` file on disk
        let log_file_path = PathBuf::from(ws0.session_log_path.unwrap());
        let t_drop = Instant::now();
        drop(hub);
        assert!(
            t_drop.elapsed() < nexus_core::testing::scaled(Duration::from_millis(15)),
            "DebugEventHub Drop exceeded 15ms budget: {:?}",
            t_drop.elapsed()
        );
        let persisted = fs::read_to_string(&log_file_path).expect("read session jsonl");
        assert!(persisted.lines().count() >= 10);

        let _ = fs::remove_dir_all(&tmp_logs);
    }

    #[test]
    fn window_state_transitions_and_external_destroy_notification() {
        let hub = DebugEventHub::new_in_memory();
        let mut rx = hub.subscribe();

        // 1. Open detached window with always-on-top
        let ws_open = hub.set_window_state(true, true, false);
        assert!(ws_open.detached_open);
        assert!(ws_open.always_on_top);
        assert!(!ws_open.re_dock_requested);
        let b_open = rx.try_recv().expect("windowState open batch");
        assert_eq!(b_open.kind, "windowState");
        assert!(b_open.window_state.detached_open);
        assert!(!b_open.window_state.re_dock_requested);

        // 2. Re-dock (`re_dock_requested = true`): MUST be a one-shot edge trigger on the
        //    `"windowState"` broadcast, then immediately reset to `false` in `DebugRingState`!
        let ws_redock = hub.set_window_state(false, false, true);
        assert!(!ws_redock.detached_open);
        assert!(!ws_redock.always_on_top);
        assert!(ws_redock.re_dock_requested);

        let b_redock = rx.try_recv().expect("windowState redock batch");
        assert_eq!(b_redock.kind, "windowState");
        assert!(!b_redock.window_state.detached_open);
        assert!(
            b_redock.window_state.re_dock_requested,
            "one-shot windowState broadcast must carry re_dock_requested == true"
        );

        // Subsequent OS Destroyed event after explicit redock close must be a no-op
        assert!(hub.notify_external_window_destroyed().is_none());

        // Subsequent snapshot, append, and cleared batches MUST have `re_dock_requested == false`!
        assert!(
            !hub.window_state().re_dock_requested,
            "stored window_state must immediately reset re_dock_requested to false"
        );
        assert!(!hub.snapshot_batch().window_state.re_dock_requested);

        hub.record(
            "info",
            "CONN",
            "backend",
            Some(0),
            "bus.connected",
            "Connected Bus 1",
            None,
        );
        let b_append = rx.try_recv().expect("append batch");
        assert_eq!(b_append.kind, "append");
        assert!(
            !b_append.window_state.re_dock_requested,
            "append batch must NOT carry sticky re_dock_requested == true"
        );

        hub.clear();
        let b_cleared = rx.try_recv().expect("cleared batch");
        assert_eq!(b_cleared.kind, "cleared");
        assert!(
            !b_cleared.window_state.re_dock_requested,
            "cleared batch must NOT carry sticky re_dock_requested == true"
        );

        // 3. Open again and close via OS titlebar X (`notify_external_window_destroyed`)
        let _ = hub.set_window_state(true, false, false);
        let _ = rx.try_recv().expect("reopen batch");
        let destroyed = hub
            .notify_external_window_destroyed()
            .expect("OS window close must transition detached_open -> false");
        assert!(!destroyed.detached_open);
        assert!(!destroyed.re_dock_requested);
        let b_destroyed = rx.try_recv().expect("destroyed windowState batch");
        assert_eq!(b_destroyed.kind, "windowState");
        assert!(!b_destroyed.window_state.detached_open);
        assert!(!b_destroyed.window_state.re_dock_requested);
    }
}
