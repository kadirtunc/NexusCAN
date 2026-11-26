//! Persistent `./traces/` file storage, multi-format CAN / CAN-FD trace parser
//! (`.trc` v1.1/v2.1, Vector `.asc`, Vector `.blf`, ASAM `.mf4`, Linux `candump .log`, NexusCAN `.csv`),
//! and deterministic zero-allocation ID-filtered Restbus `nexus-trace-replay` worker engine.

use super::{blf, mf4, ConnectedBusHandle, TxDispatchRequest};
use crate::dto::{
    ChronologicalFrameDto, LoadedTraceFileDto, StartTraceReplayArgsDto, TraceFileSummaryDto,
    TraceReplayControlArgsDto, TraceReplayStatusDto, TraceStorageInfoDto,
};
use crate::error::{AdapterError, HalError};
use crate::error_frame::decode_can_error_summary;
use crossbeam_channel::{bounded, Receiver, Sender, TrySendError};
use nexus_core::{
    now_monotonic_us, BusId, CanIdKey, RawCanFrame, EXT_CAN_ID_MASK, FLAG_ERROR, FLAG_ESI, FLAG_TX,
    MAX_CAN_FD_DLC, MAX_CLASSICAL_CAN_DLC, STD_CAN_ID_MASK,
};
use parking_lot::{Mutex, RwLock};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU64, AtomicU8, AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Positive monotonic baseline (`1.0 s`) added when projecting normalized trace entries
/// back into `ChronologicalFrameDto` rows for `TraceView`.
pub const SYNTHETIC_TRACE_ORIGIN_US: u64 = 1_000_000;

const STATE_IDLE: u8 = 0;
const STATE_PLAYING: u8 = 1;
const STATE_PAUSED: u8 = 2;
const STATE_COMPLETED: u8 = 3;
const NO_BUS_OVERRIDE: u16 = u16::MAX;

/// Fixed 88-byte, `Copy`, zero-allocation pre-compiled replay entry (`8B rel_us + 80B RawCanFrame`).
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CompiledReplayEntry {
    /// Microsecond offset relative to the first frame in the trace (`0..=duration_us`).
    pub rel_us: u64,
    /// Pre-packed 80-byte zero-allocation CAN / CAN-FD frame.
    pub frame: RawCanFrame,
}

const _: () = {
    assert!(std::mem::size_of::<CompiledReplayEntry>() == 88);
    assert!(std::mem::align_of::<CompiledReplayEntry>() == 8);
};
const fn _assert_replay_entry_traits<T: Copy + Clone + Send + Sync + Sized>() {}
const _: () = _assert_replay_entry_traits::<CompiledReplayEntry>();

/// Validates and normalizes a user-supplied trace file name, preserving `.trc`, `.asc`,
/// `.log`, `.csv`, `.blf`, or `.mf4` extensions (defaulting to `.trc`; extension lower-cased).
///
/// WP-8 / HIGH-09: path-like input (separators, `..`, leading `.`, `:`, control characters)
/// and names that normalize to nothing or to a Windows reserved device name are **errors**;
/// they are never rewritten into a different / shared default name. The only normalization is
/// whitespace and single interior dots -> `_` and dropping other punctuation; callers get the
/// final name back in the returned summary.
pub fn sanitize_trace_filename(raw: &str) -> Result<String, HalError> {
    crate::storage::reject_path_like_name("trace file name", raw)?;
    let base_segment = raw.trim();

    let (raw_stem, ext) = split_supported_trace_ext(base_segment);

    let mut clean_stem = String::with_capacity(raw_stem.len().min(120));
    let mut last_underscore = false;
    for ch in raw_stem.chars() {
        if clean_stem.len() >= 120 {
            break;
        }
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
            clean_stem.push(ch);
            last_underscore = ch == '_';
        } else if (ch.is_whitespace() || ch == '.') && !last_underscore && !clean_stem.is_empty() {
            clean_stem.push('_');
            last_underscore = true;
        }
    }

    let final_stem = clean_stem.trim_matches(|c| c == '_' || c == '-');
    if final_stem.is_empty() {
        return Err(HalError::InvalidInput(format!(
            "Invalid trace file name '{}': use letters, digits, '-' or '_'",
            raw.trim()
        )));
    }
    if crate::storage::is_windows_reserved_stem(final_stem) {
        return Err(HalError::InvalidInput(format!(
            "Invalid trace file name '{final_stem}': reserved device name"
        )));
    }

    Ok(format!("{final_stem}.{ext}"))
}

/// Strict variant for names that must already exist on disk (load / delete / replay): the
/// name must be exactly what [`sanitize_trace_filename`] produces, so nothing is rewritten.
pub fn validate_existing_trace_filename(raw: &str) -> Result<String, HalError> {
    let safe = sanitize_trace_filename(raw)?;
    if safe != raw.trim() {
        return Err(HalError::InvalidInput(format!(
            "Invalid trace file name '{}': expected '{safe}'",
            raw.trim().escape_debug()
        )));
    }
    Ok(safe)
}

/// Display-only name for stateless parsing of in-memory content (never used for disk paths).
fn trace_display_name(raw: &str) -> String {
    sanitize_trace_filename(raw)
        .unwrap_or_else(|_| format!("untitled_trace.{}", trace_format_from_filename(raw)))
}

/// Returns the canonical format tag (`"trc"`, `"asc"`, `"log"`, `"csv"`, `"blf"`, or `"mf4"`) for a trace file name.
pub fn trace_format_from_filename(file_name: &str) -> &'static str {
    split_supported_trace_ext(file_name).1
}

fn split_supported_trace_ext(segment: &str) -> (&str, &'static str) {
    let s = segment.trim();
    if let Some((stem, ext_raw)) = s.rsplit_once('.') {
        if ext_raw.eq_ignore_ascii_case("trc") {
            return (stem, "trc");
        }
        if ext_raw.eq_ignore_ascii_case("asc") {
            return (stem, "asc");
        }
        if ext_raw.eq_ignore_ascii_case("log") {
            return (stem, "log");
        }
        if ext_raw.eq_ignore_ascii_case("csv") {
            return (stem, "csv");
        }
        if ext_raw.eq_ignore_ascii_case("blf") {
            return (stem, "blf");
        }
        if ext_raw.eq_ignore_ascii_case("mf4") {
            return (stem, "mf4");
        }
    }
    (s, "trc")
}

fn is_supported_trace_file(file_name: &str) -> bool {
    if let Some((_, ext_raw)) = file_name.rsplit_once('.') {
        ext_raw.eq_ignore_ascii_case("trc")
            || ext_raw.eq_ignore_ascii_case("asc")
            || ext_raw.eq_ignore_ascii_case("log")
            || ext_raw.eq_ignore_ascii_case("csv")
            || ext_raw.eq_ignore_ascii_case("blf")
            || ext_raw.eq_ignore_ascii_case("mf4")
    } else {
        false
    }
}

#[inline]
fn effective_trace_format(file_name: &str, raw_bytes: &[u8]) -> &'static str {
    if blf::is_blf_bytes(raw_bytes) {
        "blf"
    } else if mf4::is_mf4_bytes(raw_bytes) {
        "mf4"
    } else {
        trace_format_from_filename(file_name)
    }
}

/// Routes BLF and MF4 to binary readers and text formats to [`parse_trace_text`].
pub fn parse_trace_entries_from_bytes(
    file_name: &str,
    raw_bytes: &[u8],
) -> Result<Vec<CompiledReplayEntry>, HalError> {
    match effective_trace_format(file_name, raw_bytes) {
        "blf" => blf::parse_blf_bytes(raw_bytes),
        "mf4" => mf4::parse_mf4_bytes(raw_bytes),
        _ => {
            let content = String::from_utf8_lossy(raw_bytes);
            parse_trace_text(file_name, &content)
        }
    }
}

fn canonical_path_string(path: &Path) -> String {
    fs::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .to_string()
}

fn system_time_to_iso8601_utc(st: SystemTime) -> String {
    let dur = st.duration_since(UNIX_EPOCH).unwrap_or_default();
    let total_secs = dur.as_secs();
    let millis = dur.subsec_millis();
    let days = (total_secs / 86_400) as i64;
    let rem_secs = total_secs % 86_400;
    let hour = rem_secs / 3_600;
    let minute = (rem_secs % 3_600) / 60;
    let second = rem_secs % 60;

    // Howard Hinnant civil-from-days (proleptic Gregorian calendar, UTC)
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

/// In-memory frame-count / duration cache for traces this engine has saved, loaded or
/// replayed. `cmd_list_traces` never parses file bodies; it reports cached stats when the
/// file's size + mtime still match, else `frameCount = 0`, `durationUs = 0`,
/// `statsKnown = false`.
#[derive(Default)]
pub struct TraceStatsCache {
    inner: Mutex<BTreeMap<String, CachedTraceStats>>,
}

#[derive(Clone, Copy)]
struct CachedTraceStats {
    size_bytes: u64,
    modified: Option<SystemTime>,
    frame_count: usize,
    duration_us: u64,
}

impl TraceStatsCache {
    /// Records stats for `file_name` against the file's current size + mtime.
    pub fn record(
        &self,
        file_name: &str,
        meta: &fs::Metadata,
        frame_count: usize,
        duration_us: u64,
    ) {
        let mut inner = self.inner.lock();
        if inner.len() >= crate::storage::MAX_LISTED_ENTRIES && !inner.contains_key(file_name) {
            inner.clear();
        }
        inner.insert(
            file_name.to_string(),
            CachedTraceStats {
                size_bytes: meta.len(),
                modified: meta.modified().ok(),
                frame_count,
                duration_us,
            },
        );
    }

    fn lookup(&self, file_name: &str, meta: &fs::Metadata) -> Option<(usize, u64)> {
        let inner = self.inner.lock();
        let c = inner.get(file_name)?;
        (c.size_bytes == meta.len() && c.modified == meta.modified().ok())
            .then_some((c.frame_count, c.duration_us))
    }

    pub fn forget(&self, file_name: &str) {
        self.inner.lock().remove(file_name);
    }
}

/// Lists all persistent `.trc`, `.asc`, `.log`, `.csv`, `.blf`, and `.mf4` trace files in `traces_dir`
/// (creating `traces_dir` if absent), sorted newest-first.
///
/// WP-8 / HIGH-10: metadata only (name, size, mtime, format from the extension + a BLF header
/// sniff of the first bytes). File bodies are never read or parsed; symlinks and non-regular
/// entries are skipped.
pub fn list_trace_files(
    traces_dir: &Path,
    stats: Option<&TraceStatsCache>,
) -> Result<TraceStorageInfoDto, HalError> {
    crate::storage::create_private_dir_all(traces_dir)
        .map_err(|e| HalError::Adapter(AdapterError::Io(e)))?;
    let canonical_dir = canonical_path_string(traces_dir);
    let canonical_base = fs::canonicalize(traces_dir).unwrap_or_else(|_| traces_dir.to_path_buf());

    let dir_entries =
        fs::read_dir(traces_dir).map_err(|e| HalError::Adapter(AdapterError::Io(e)))?;

    let mut files = Vec::new();
    for entry in dir_entries
        .flatten()
        .take(crate::storage::MAX_LISTED_ENTRIES)
    {
        // `DirEntry::file_type` does not follow symlinks.
        match entry.file_type() {
            Ok(ft) if ft.is_file() => {}
            _ => continue,
        }
        let raw_name = entry.file_name().to_string_lossy().to_string();
        if raw_name.starts_with('.') || !is_supported_trace_file(&raw_name) {
            continue;
        }
        // Only list names that load / delete accept verbatim (no rewriting on the way back).
        if validate_existing_trace_filename(&raw_name).is_err() {
            continue;
        }
        let path = canonical_base.join(&raw_name);
        let meta = match fs::symlink_metadata(&path) {
            Ok(m) if m.is_file() => m,
            _ => continue,
        };
        let format = if trace_format_from_filename(&raw_name) == "blf" {
            "blf"
        } else {
            // A BLF stream saved with a text extension is still reported as BLF.
            let prefix = crate::storage::read_regular_file_prefix(&path, blf::BLF_FILE_HEADER_SIZE)
                .unwrap_or_default();
            effective_trace_format(&raw_name, &prefix)
        };
        let updated_at = meta
            .modified()
            .map(system_time_to_iso8601_utc)
            .unwrap_or_else(|_| "1970-01-01T00:00:00.000Z".to_string());
        let cached = stats.and_then(|c| c.lookup(&raw_name, &meta));

        files.push(TraceFileSummaryDto {
            file_name: raw_name.clone(),
            file_path: path.to_string_lossy().to_string(),
            format: format.to_string(),
            size_bytes: meta.len(),
            frame_count: cached.map_or(0, |c| c.0),
            duration_us: cached.map_or(0, |c| c.1),
            updated_at,
            stats_known: cached.is_some(),
        });
    }

    files.sort_by(|a, b| {
        b.updated_at
            .cmp(&a.updated_at)
            .then_with(|| a.file_name.cmp(&b.file_name))
    });

    Ok(TraceStorageInfoDto {
        traces_dir: canonical_dir,
        files,
    })
}

/// Sanitizes `file_name`, validates binary `.blf` / `.mf4` or text trace `raw_bytes`, writes them
/// (temp file + rename, symlinks refused) to `traces_dir/<safe_name>`, and returns its
/// [`TraceFileSummaryDto`].
pub fn save_trace_file_bytes(
    traces_dir: &Path,
    file_name: &str,
    raw_bytes: &[u8],
) -> Result<TraceFileSummaryDto, HalError> {
    save_trace_file_bytes_cached(traces_dir, file_name, raw_bytes, None)
}

pub(crate) fn save_trace_file_bytes_cached(
    traces_dir: &Path,
    file_name: &str,
    raw_bytes: &[u8],
    stats: Option<&TraceStatsCache>,
) -> Result<TraceFileSummaryDto, HalError> {
    let safe_name = sanitize_trace_filename(file_name)?;
    let entries = parse_trace_entries_from_bytes(&safe_name, raw_bytes)?;
    let duration_us = entries.last().map_or(0, |e| e.rel_us);

    let target_path = crate::storage::resolve_in_dir(traces_dir, &safe_name)?;
    crate::storage::write_regular_file_atomic(&target_path, raw_bytes)?;

    let meta = fs::symlink_metadata(&target_path).ok();
    if let (Some(cache), Some(meta)) = (stats, meta.as_ref()) {
        cache.record(&safe_name, meta, entries.len(), duration_us);
    }
    let updated_at = meta
        .and_then(|m| m.modified().ok())
        .map(system_time_to_iso8601_utc)
        .unwrap_or_else(|| system_time_to_iso8601_utc(SystemTime::now()));

    Ok(TraceFileSummaryDto {
        file_name: safe_name.clone(),
        file_path: target_path.to_string_lossy().to_string(),
        format: effective_trace_format(&safe_name, raw_bytes).to_string(),
        size_bytes: raw_bytes.len() as u64,
        frame_count: entries.len(),
        duration_us,
        updated_at,
        stats_known: true,
    })
}

/// Sanitizes `file_name`, writes text `content` to `traces_dir/<safe_name>`, and returns its [`TraceFileSummaryDto`].
pub fn save_trace_file(
    traces_dir: &Path,
    file_name: &str,
    content: &str,
) -> Result<TraceFileSummaryDto, HalError> {
    save_trace_file_bytes(traces_dir, file_name, content.as_bytes())
}

/// Resolves + reads `traces_dir/<safe_name>` (regular file only, size-capped).
pub(crate) fn read_trace_file_bytes(
    traces_dir: &Path,
    file_name: &str,
) -> Result<(String, std::path::PathBuf, Vec<u8>), HalError> {
    let safe_name = validate_existing_trace_filename(file_name)?;
    let target_path = crate::storage::resolve_in_dir(traces_dir, &safe_name)?;
    if !crate::storage::is_regular_file(&target_path) {
        return Err(HalError::InvalidInput(format!(
            "Trace file '{safe_name}' does not exist in traces directory"
        )));
    }
    let raw_bytes =
        crate::storage::read_regular_file(&target_path, crate::storage::MAX_TRACE_FILE_BYTES)?;
    Ok((safe_name, target_path, raw_bytes))
}

/// Loads and parses `traces_dir/<safe_name>` (binary `.blf` / `.mf4` or text trace) into a [`LoadedTraceFileDto`].
pub fn load_trace_file(traces_dir: &Path, file_name: &str) -> Result<LoadedTraceFileDto, HalError> {
    load_trace_file_cached(traces_dir, file_name, None)
}

pub(crate) fn load_trace_file_cached(
    traces_dir: &Path,
    file_name: &str,
    stats: Option<&TraceStatsCache>,
) -> Result<LoadedTraceFileDto, HalError> {
    let (safe_name, target_path, raw_bytes) = read_trace_file_bytes(traces_dir, file_name)?;
    let meta =
        fs::symlink_metadata(&target_path).map_err(|e| HalError::Adapter(AdapterError::Io(e)))?;
    let entries = parse_trace_entries_from_bytes(&safe_name, &raw_bytes)?;
    let duration_us = entries.last().map_or(0, |e| e.rel_us);
    if let Some(cache) = stats {
        cache.record(&safe_name, &meta, entries.len(), duration_us);
    }
    let updated_at = meta
        .modified()
        .map(system_time_to_iso8601_utc)
        .unwrap_or_else(|_| system_time_to_iso8601_utc(SystemTime::now()));

    let summary = TraceFileSummaryDto {
        file_name: safe_name.clone(),
        file_path: target_path.to_string_lossy().to_string(),
        format: effective_trace_format(&safe_name, &raw_bytes).to_string(),
        size_bytes: raw_bytes.len() as u64,
        frame_count: entries.len(),
        duration_us,
        updated_at,
        stats_known: true,
    };
    let frames = entries_to_chronological_dtos(&entries);

    Ok(LoadedTraceFileDto { summary, frames })
}

/// Deletes `traces_dir/<safe_name>` (regular files only; symlinks are refused).
pub fn delete_trace_file(traces_dir: &Path, file_name: &str) -> Result<(), HalError> {
    let safe_name = validate_existing_trace_filename(file_name)?;
    let target_path = crate::storage::resolve_in_dir(traces_dir, &safe_name)?;
    if !crate::storage::is_regular_file(&target_path) {
        return Err(HalError::InvalidInput(format!(
            "Trace file '{safe_name}' does not exist in traces directory"
        )));
    }
    crate::storage::remove_regular_file(&target_path)
}

/// Statelessly parses binary `.blf` / `.mf4` or text (`.trc`, `.asc`, `.log`, `.csv`) bytes without writing to disk.
pub fn parse_trace_bytes(
    file_name: &str,
    raw_bytes: &[u8],
) -> Result<LoadedTraceFileDto, HalError> {
    let safe_name = trace_display_name(file_name);
    let entries = parse_trace_entries_from_bytes(&safe_name, raw_bytes)?;
    let duration_us = entries.last().map_or(0, |e| e.rel_us);

    let summary = TraceFileSummaryDto {
        file_name: safe_name.clone(),
        file_path: String::new(),
        format: effective_trace_format(&safe_name, raw_bytes).to_string(),
        size_bytes: raw_bytes.len() as u64,
        frame_count: entries.len(),
        duration_us,
        updated_at: system_time_to_iso8601_utc(SystemTime::now()),
        stats_known: true,
    };
    let frames = entries_to_chronological_dtos(&entries);

    Ok(LoadedTraceFileDto { summary, frames })
}

/// Statelessly parses raw text trace content (`.trc`, `.asc`, `.log`, `.csv`) without writing to disk.
pub fn parse_trace_content(file_name: &str, content: &str) -> Result<LoadedTraceFileDto, HalError> {
    parse_trace_bytes(file_name, content.as_bytes())
}

/// Converts normalized [`CompiledReplayEntry`] records into [`ChronologicalFrameDto`] rows
/// anchored at [`SYNTHETIC_TRACE_ORIGIN_US`] (`1,000,000 us`) so relative deltas are preserved verbatim.
pub fn entries_to_chronological_dtos(
    entries: &[CompiledReplayEntry],
) -> Vec<ChronologicalFrameDto> {
    let mut out = Vec::with_capacity(entries.len());
    for entry in entries {
        let f = &entry.frame;
        if f.is_error() {
            let err_mask = f.arb_id & EXT_CAN_ID_MASK;
            let payload = f.payload();
            out.push(ChronologicalFrameDto {
                timestamp_us: SYNTHETIC_TRACE_ORIGIN_US.saturating_add(entry.rel_us),
                bus_id: f.bus_id,
                message_key: format!("ERR:0x{err_mask:08X}"),
                arb_id: err_mask,
                is_extended: f.is_extended(),
                is_fd: f.is_fd(),
                is_brs: f.is_brs(),
                is_tx: f.is_tx(),
                is_error: true,
                error_summary: Some(decode_can_error_summary(err_mask, payload)),
                dlc: f.dlc,
                raw_bytes: payload.to_vec(),
            });
        } else {
            let can_id = f.can_id_key();
            out.push(ChronologicalFrameDto {
                timestamp_us: SYNTHETIC_TRACE_ORIGIN_US.saturating_add(entry.rel_us),
                bus_id: f.bus_id,
                message_key: can_id.schema_key(),
                arb_id: can_id.raw_id(),
                is_extended: f.is_extended(),
                is_fd: f.is_fd(),
                is_brs: f.is_brs(),
                is_tx: f.is_tx(),
                is_error: false,
                error_summary: None,
                dlc: f.dlc,
                raw_bytes: f.payload().to_vec(),
            });
        }
    }
    out
}

/// Compiles in-memory [`ChronologicalFrameDto`] frames into origin-normalized, stably-sorted [`CompiledReplayEntry`] records.
pub fn compile_chronological_frames(frames: &[ChronologicalFrameDto]) -> Vec<CompiledReplayEntry> {
    if frames.is_empty() {
        return Vec::new();
    }

    let mut raw: Vec<(u64, RawCanFrame)> = Vec::with_capacity(frames.len());
    for dto in frames {
        if dto.is_error || dto.message_key.starts_with("ERR:") {
            let mut frame = RawCanFrame::zeroed();
            frame.timestamp_us = dto.timestamp_us;
            frame.bus_id = dto.bus_id;
            frame.arb_id = dto.arb_id & EXT_CAN_ID_MASK;
            let len = dto.raw_bytes.len().min(MAX_CLASSICAL_CAN_DLC);
            frame.dlc = dto.dlc.min(MAX_CLASSICAL_CAN_DLC as u8).max(len as u8);
            frame.data[..len].copy_from_slice(&dto.raw_bytes[..len]);
            frame.flags = FLAG_ERROR | if dto.is_tx { FLAG_TX } else { 0 };
            raw.push((dto.timestamp_us, frame));
            continue;
        }

        let can_id = CanIdKey::new_masked(dto.arb_id, dto.is_extended);
        let len = dto.raw_bytes.len().min(MAX_CAN_FD_DLC);
        let slice = &dto.raw_bytes[..len];
        let use_fd = dto.is_fd || len > MAX_CLASSICAL_CAN_DLC;

        let frame_res = if use_fd {
            RawCanFrame::new_fd(dto.bus_id, can_id, slice, dto.is_brs, dto.timestamp_us)
        } else {
            RawCanFrame::new_classical(dto.bus_id, can_id, slice, dto.timestamp_us)
        };

        if let Ok(mut frame) = frame_res {
            if dto.is_tx {
                frame.flags |= FLAG_TX;
            }
            raw.push((dto.timestamp_us, frame));
        }
    }

    raw.sort_by_key(|(ts, _)| *ts);
    let Some(&(origin_us, _)) = raw.first() else {
        return Vec::new();
    };

    raw.into_iter()
        .map(|(ts, mut frame)| {
            let rel_us = ts.saturating_sub(origin_us);
            frame.timestamp_us = SYNTHETIC_TRACE_ORIGIN_US.saturating_add(rel_us);
            CompiledReplayEntry { rel_us, frame }
        })
        .collect()
}

// =============================================================================
// MULTI-FORMAT TRACE PARSER (.trc v1.1 & v2.1, Vector .asc, candump .log, .csv)
// =============================================================================

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DetectedFormat {
    Trc,
    Asc,
    Log,
    Csv,
}

fn detect_format(file_name: &str, content: &str) -> DetectedFormat {
    for raw_line in content.lines().take(32) {
        let line = raw_line.trim().trim_start_matches('\u{feff}');
        if line.is_empty() {
            continue;
        }
        let lower = line.to_ascii_lowercase();
        if lower.starts_with("index,time_s,bus,protocol,id_hex") {
            return DetectedFormat::Csv;
        }
        if lower.starts_with(";$fileversion=") || line.starts_with(";---+--") {
            return DetectedFormat::Trc;
        }
        if lower.starts_with("date ")
            || lower.starts_with("base hex")
            || lower.starts_with("base dec")
            || lower.starts_with("begin triggerblock")
        {
            return DetectedFormat::Asc;
        }
        if line.starts_with('(') && (line.contains('#') || line.contains(" [")) {
            return DetectedFormat::Log;
        }
    }

    match trace_format_from_filename(file_name) {
        "asc" => DetectedFormat::Asc,
        "log" => DetectedFormat::Log,
        "csv" => DetectedFormat::Csv,
        _ => DetectedFormat::Trc,
    }
}

/// Parses `.trc` (v1.1 & v2.1), Vector `.asc` (CAN & CANFD), Linux `candump .log`, or NexusCAN `.csv`
/// into origin-normalized (`rel_us` starting at `0`) [`CompiledReplayEntry`] records.
pub fn parse_trace_text(
    file_name: &str,
    content: &str,
) -> Result<Vec<CompiledReplayEntry>, HalError> {
    let trimmed_content = content.trim_start_matches('\u{feff}');
    if trimmed_content.trim().is_empty() {
        return Ok(Vec::new());
    }

    let fmt = detect_format(file_name, trimmed_content);
    let mut raw_entries: Vec<(i128, RawCanFrame)> = Vec::new();

    match fmt {
        DetectedFormat::Trc => parse_pcan_trc_lines(trimmed_content, &mut raw_entries),
        DetectedFormat::Asc => parse_vector_asc_lines(trimmed_content, &mut raw_entries),
        DetectedFormat::Log => parse_candump_log_lines(trimmed_content, &mut raw_entries),
        DetectedFormat::Csv => parse_nexus_csv_lines(trimmed_content, &mut raw_entries),
    }

    if raw_entries.is_empty() {
        return Ok(Vec::new());
    }

    raw_entries.sort_by_key(|(ts, _)| *ts);
    let origin_us = raw_entries[0].0;

    let mut compiled = Vec::with_capacity(raw_entries.len());
    for (ts, mut frame) in raw_entries {
        // Finite-but-huge text timestamps saturate `f64 as i128` to i128::MIN/MAX (WP-6 fuzz).
        let delta = ts.saturating_sub(origin_us).max(0);
        let rel_us = u64::try_from(delta).unwrap_or(u64::MAX);
        frame.timestamp_us = SYNTHETIC_TRACE_ORIGIN_US.saturating_add(rel_us);
        compiled.push(CompiledReplayEntry { rel_us, frame });
    }

    Ok(compiled)
}

#[inline]
fn parse_id_token_radix(id_tok: &str, radix: u32) -> Option<CanIdKey> {
    let t = id_tok.trim();
    if t.is_empty() {
        return None;
    }
    let has_ext_suffix = t.ends_with('x') || t.ends_with('X');
    let no_suffix = if has_ext_suffix { &t[..t.len() - 1] } else { t };
    let clean = no_suffix
        .strip_prefix("0x")
        .or_else(|| no_suffix.strip_prefix("0X"))
        .unwrap_or(no_suffix);
    if clean.is_empty() {
        return None;
    }

    let effective_radix = if no_suffix.starts_with("0x") || no_suffix.starts_with("0X") {
        16
    } else {
        radix
    };
    let arb_id = u32::from_str_radix(clean, effective_radix).ok()?;
    let is_extended =
        has_ext_suffix || (effective_radix == 16 && clean.len() > 4) || arb_id > STD_CAN_ID_MASK;
    Some(CanIdKey::new_masked(arb_id, is_extended))
}

#[inline]
fn parse_byte_token_radix(tok: &str, radix: u32) -> Option<u8> {
    let clean = tok
        .trim()
        .strip_prefix("0x")
        .or_else(|| tok.trim().strip_prefix("0X"))
        .unwrap_or_else(|| tok.trim());
    if clean.is_empty() || (radix == 16 && clean.len() > 2) {
        return None;
    }
    u8::from_str_radix(clean, radix).ok()
}

#[inline]
#[allow(clippy::too_many_arguments)]
fn build_frame_from_parts(
    bus_id: BusId,
    can_id: CanIdKey,
    is_fd: bool,
    is_brs: bool,
    is_esi: bool,
    is_tx: bool,
    is_rtr: bool,
    rtr_dlc: u8,
    payload: &[u8],
) -> Option<RawCanFrame> {
    let mut frame = if is_rtr {
        RawCanFrame::new_rtr(bus_id, can_id, rtr_dlc.min(8), 0).ok()?
    } else if is_fd || payload.len() > MAX_CLASSICAL_CAN_DLC {
        RawCanFrame::new_fd(bus_id, can_id, payload, is_brs, 0).ok()?
    } else {
        RawCanFrame::new_classical(bus_id, can_id, payload, 0).ok()?
    };

    if is_esi {
        frame.flags |= FLAG_ESI;
    }
    if is_tx {
        frame.flags |= FLAG_TX;
    }
    Some(frame)
}

#[inline]
fn build_error_frame(bus_id: BusId, err_mask: u32, is_tx: bool, payload: &[u8]) -> RawCanFrame {
    let mut frame = RawCanFrame::zeroed();
    frame.bus_id = bus_id;
    frame.arb_id = err_mask & EXT_CAN_ID_MASK;
    let len = payload.len().min(MAX_CLASSICAL_CAN_DLC);
    frame.dlc = (len as u8).max(if payload.is_empty() { 0 } else { len as u8 });
    frame.data[..len].copy_from_slice(&payload[..len]);
    frame.flags = FLAG_ERROR | if is_tx { FLAG_TX } else { 0 };
    frame
}

#[inline]
fn parse_err_mask_token(tok: &str, radix: u32) -> Option<u32> {
    let t = tok
        .trim()
        .strip_prefix("ERR:")
        .or_else(|| tok.trim().strip_prefix("err:"))
        .unwrap_or_else(|| tok.trim());
    let no_suffix = t.strip_suffix(['x', 'X']).unwrap_or(t);
    let clean = no_suffix
        .strip_prefix("0x")
        .or_else(|| no_suffix.strip_prefix("0X"))
        .unwrap_or(no_suffix);
    if clean.is_empty() {
        return None;
    }
    let effective_radix = if no_suffix.starts_with("0x") || no_suffix.starts_with("0X") {
        16
    } else {
        radix
    };
    u32::from_str_radix(clean, effective_radix)
        .ok()
        .map(|v| v & EXT_CAN_ID_MASK)
}

#[inline]
fn is_trc_error_token(tok: &str) -> bool {
    tok.eq_ignore_ascii_case("Error")
        || tok.eq_ignore_ascii_case("Err")
        || tok.eq_ignore_ascii_case("ER")
}

fn parse_pcan_trc_lines(content: &str, out: &mut Vec<(i128, RawCanFrame)>) {
    let mut is_v1 = false;
    let mut payload_buf = [0u8; MAX_CAN_FD_DLC];

    for raw_line in content.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }
        if line.starts_with(';') {
            let upper = line.to_ascii_uppercase();
            if upper.starts_with(";$FILEVERSION=1.") {
                is_v1 = true;
            } else if upper.starts_with(";$FILEVERSION=2.") {
                is_v1 = false;
            }
            continue;
        }

        let mut iter = line.split_whitespace();
        let Some(tok0) = iter.next() else {
            continue;
        };

        if is_v1 || tok0.ends_with(')') {
            // PCAN-Trace v1.1 / v1.3:
            // v1.1: `<idx>) <time_ms> <Rx|Tx|Error> <id_hex> <dlc> <XX ...>`
            // v1.3: `<idx>) <time_ms> <bus_1based> <Rx|Tx|Error> <id_hex> [-] <dlc> <XX ...>`
            let Some(time_tok) = iter.next() else {
                continue;
            };
            let Ok(time_ms) = time_tok.parse::<f64>() else {
                continue;
            };
            if !time_ms.is_finite() {
                continue;
            }
            let ts_us = (time_ms * 1_000.0).round() as i128;

            let Some(tok2) = iter.next() else {
                continue;
            };
            let (bus_id, dir_tok, id_tok) = if tok2.eq_ignore_ascii_case("Rx")
                || tok2.eq_ignore_ascii_case("Tx")
                || is_trc_error_token(tok2)
            {
                let id_t = iter.next().unwrap_or("0080");
                (0u8, tok2, id_t)
            } else if let Ok(bus_1based) = tok2.parse::<u16>() {
                let Some(dir_t) = iter.next() else {
                    continue;
                };
                if !dir_t.eq_ignore_ascii_case("Rx")
                    && !dir_t.eq_ignore_ascii_case("Tx")
                    && !is_trc_error_token(dir_t)
                {
                    continue;
                }
                let id_t = iter.next().unwrap_or("0080");
                ((bus_1based.saturating_sub(1)).min(255) as u8, dir_t, id_t)
            } else {
                continue;
            };

            if is_trc_error_token(dir_tok) || is_trc_error_token(id_tok) {
                let err_mask = parse_err_mask_token(id_tok, 16)
                    .unwrap_or(crate::error_frame::CAN_ERR_BUSERROR);
                let mut count = 0usize;
                if let Some(mut next_tok) = iter.next() {
                    if next_tok == "-" {
                        next_tok = iter.next().unwrap_or("");
                    }
                    // Optional DLC token followed by hex bytes, or directly hex bytes
                    if next_tok.parse::<u8>().is_err() {
                        if let Some(b) = parse_byte_token_radix(next_tok, 16) {
                            payload_buf[count] = b;
                            count += 1;
                        }
                    }
                    for b_tok in iter {
                        if count >= MAX_CLASSICAL_CAN_DLC {
                            break;
                        }
                        if let Some(b) = parse_byte_token_radix(b_tok, 16) {
                            payload_buf[count] = b;
                            count += 1;
                        }
                    }
                }
                out.push((
                    ts_us,
                    build_error_frame(bus_id, err_mask, false, &payload_buf[..count]),
                ));
                continue;
            }

            let Some(can_id) = parse_id_token_radix(id_tok, 16) else {
                continue;
            };
            let is_tx = dir_tok.eq_ignore_ascii_case("Tx");

            let Some(mut dlc_or_dash) = iter.next() else {
                continue;
            };
            if dlc_or_dash == "-" {
                let Some(next_tok) = iter.next() else {
                    continue;
                };
                dlc_or_dash = next_tok;
            }

            let dlc_val = dlc_or_dash.parse::<u8>().unwrap_or(0);
            let mut count = 0usize;
            let mut is_rtr = false;
            for b_tok in iter {
                if b_tok.eq_ignore_ascii_case("RTR") || b_tok.eq_ignore_ascii_case("R") {
                    is_rtr = true;
                    break;
                }
                if count >= MAX_CAN_FD_DLC {
                    break;
                }
                let Some(byte) = parse_byte_token_radix(b_tok, 16) else {
                    break;
                };
                payload_buf[count] = byte;
                count += 1;
            }

            if let Some(frame) = build_frame_from_parts(
                bus_id,
                can_id,
                count > MAX_CLASSICAL_CAN_DLC,
                false,
                false,
                is_tx,
                is_rtr,
                dlc_val,
                &payload_buf[..count],
            ) {
                out.push((ts_us, frame));
            }
        } else {
            // PCAN-Trace v2.0 / v2.1 (`N,O,T,B,I,d,L,D`):
            // `<idx> <time_ms> <DT|FD|FB|FE|BI|RR|ER> <bus_1based> <id_hex> <Rx|Tx> <dlc_or_len> <XX ...>`
            if tok0.parse::<u64>().is_err() {
                continue;
            }
            let Some(time_tok) = iter.next() else {
                continue;
            };
            let Ok(time_ms) = time_tok.parse::<f64>() else {
                continue;
            };
            if !time_ms.is_finite() {
                continue;
            }
            let ts_us = (time_ms * 1_000.0).round() as i128;

            let Some(type_tok) = iter.next() else {
                continue;
            };
            let type_upper = type_tok.to_ascii_uppercase();
            if matches!(type_upper.as_str(), "ER" | "ERR" | "ERROR") {
                let bus_id = iter
                    .next()
                    .and_then(|b| b.parse::<u16>().ok())
                    .map_or(0u8, |b| (b.saturating_sub(1)).min(255) as u8);
                let id_tok = iter.next().unwrap_or("0080");
                let err_mask = parse_err_mask_token(id_tok, 16)
                    .unwrap_or(crate::error_frame::CAN_ERR_BUSERROR);
                let mut is_tx = false;
                if let Some(dir_or_len) = iter.next() {
                    if dir_or_len.eq_ignore_ascii_case("Tx") {
                        is_tx = true;
                        let _ = iter.next(); // consume dlc_or_len
                    } else if dir_or_len.eq_ignore_ascii_case("Rx") || dir_or_len == "-" {
                        let _ = iter.next(); // consume dlc_or_len
                    }
                }
                let mut count = 0usize;
                for b_tok in iter {
                    if count >= MAX_CLASSICAL_CAN_DLC {
                        break;
                    }
                    if let Some(byte) = parse_byte_token_radix(b_tok, 16) {
                        payload_buf[count] = byte;
                        count += 1;
                    }
                }
                out.push((
                    ts_us,
                    build_error_frame(bus_id, err_mask, is_tx, &payload_buf[..count]),
                ));
                continue;
            }

            let (is_fd, is_brs, is_esi, mut is_rtr) = match type_upper.as_str() {
                "DT" => (false, false, false, false),
                "RR" => (false, false, false, true),
                "FD" => (true, false, false, false),
                "FB" => (true, true, false, false),
                "FE" => (true, false, true, false),
                "BI" => (true, true, true, false),
                _ => continue,
            };

            let Some(bus_tok) = iter.next() else {
                continue;
            };
            let Ok(bus_1based) = bus_tok.parse::<u16>() else {
                continue;
            };
            let bus_id = (bus_1based.saturating_sub(1)).min(255) as u8;

            let Some(id_tok) = iter.next() else {
                continue;
            };
            let Some(can_id) = parse_id_token_radix(id_tok, 16) else {
                continue;
            };

            let Some(dir_tok) = iter.next() else {
                continue;
            };
            if !dir_tok.eq_ignore_ascii_case("Rx") && !dir_tok.eq_ignore_ascii_case("Tx") {
                continue;
            }
            let is_tx = dir_tok.eq_ignore_ascii_case("Tx");

            let Some(len_tok) = iter.next() else {
                continue;
            };
            let dlc_val = len_tok.parse::<u8>().unwrap_or(0);

            let mut count = 0usize;
            for b_tok in iter {
                if b_tok.eq_ignore_ascii_case("RTR") {
                    is_rtr = true;
                    break;
                }
                if count >= MAX_CAN_FD_DLC {
                    break;
                }
                let Some(byte) = parse_byte_token_radix(b_tok, 16) else {
                    break;
                };
                payload_buf[count] = byte;
                count += 1;
            }

            if let Some(frame) = build_frame_from_parts(
                bus_id,
                can_id,
                is_fd,
                is_brs,
                is_esi,
                is_tx,
                is_rtr,
                dlc_val,
                &payload_buf[..count],
            ) {
                out.push((ts_us, frame));
            }
        }
    }
}

fn parse_vector_asc_lines(content: &str, out: &mut Vec<(i128, RawCanFrame)>) {
    let mut radix = 16u32;
    let mut payload_buf = [0u8; MAX_CAN_FD_DLC];

    for raw_line in content.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with("//") || line.starts_with(';') {
            continue;
        }
        let lower = line.to_ascii_lowercase();
        if lower.starts_with("base ") {
            if lower.contains("dec") {
                radix = 10;
            } else if lower.contains("hex") {
                radix = 16;
            }
            continue;
        }
        if lower.starts_with("date ")
            || lower.starts_with("internal events")
            || lower.starts_with("no internal events")
            || lower.starts_with("begin triggerblock")
            || lower.starts_with("end triggerblock")
            || lower.starts_with("version ")
        {
            continue;
        }

        let tokens: Vec<&str> = line.split_whitespace().collect();
        if tokens.len() < 3 {
            continue;
        }

        let Ok(time_sec) = tokens[0].parse::<f64>() else {
            continue;
        };
        if !time_sec.is_finite() {
            continue;
        }
        let ts_us = (time_sec * 1_000_000.0).round() as i128;

        // Vector `.asc` CAN / CAN-FD ErrorFrame:
        // - `<time_sec> <ch> ErrorFrame [<id_hex> [<dlc>] <bytes...>]`
        // - `<time_sec> ErrorFrame ...`
        // - `<time_sec> CANFD <ch> ErrorFrame ...`
        if tokens[1].eq_ignore_ascii_case("ErrorFrame")
            || tokens
                .get(2)
                .is_some_and(|t| t.eq_ignore_ascii_case("ErrorFrame"))
            || (tokens[1].eq_ignore_ascii_case("CANFD")
                && tokens
                    .get(3)
                    .is_some_and(|t| t.eq_ignore_ascii_case("ErrorFrame")))
        {
            let (bus_id, tail_start) = if tokens[1].eq_ignore_ascii_case("ErrorFrame") {
                (0u8, 2usize)
            } else if tokens[1].eq_ignore_ascii_case("CANFD") {
                let ch = tokens[2].parse::<u16>().unwrap_or(1);
                ((ch.saturating_sub(1)).min(255) as u8, 4usize)
            } else {
                let ch = tokens[1].parse::<u16>().unwrap_or(1);
                ((ch.saturating_sub(1)).min(255) as u8, 3usize)
            };

            let mut err_mask = crate::error_frame::CAN_ERR_BUSERROR;
            let mut count = 0usize;
            if let Some(&first_tail) = tokens.get(tail_start) {
                if let Some(parsed_mask) = parse_err_mask_token(first_tail, 16) {
                    err_mask = parsed_mask;
                    let bytes_start = if tokens
                        .get(tail_start + 1)
                        .and_then(|t| t.parse::<u8>().ok())
                        .is_some()
                        && tokens.len() > tail_start + 2
                    {
                        tail_start + 2
                    } else {
                        tail_start + 1
                    };
                    for &b_tok in &tokens[bytes_start..] {
                        if count >= MAX_CLASSICAL_CAN_DLC {
                            break;
                        }
                        if let Some(b) = parse_byte_token_radix(b_tok, 16) {
                            payload_buf[count] = b;
                            count += 1;
                        } else {
                            break;
                        }
                    }
                }
            }

            out.push((
                ts_us,
                build_error_frame(bus_id, err_mask, false, &payload_buf[..count]),
            ));
            continue;
        }

        if tokens.len() < 5 {
            continue;
        }

        if tokens[1].eq_ignore_ascii_case("CANFD") {
            // `<time_sec> CANFD <ch> <Rx|Tx> <id_hex[x]> [sym_name] <brs> <esi> <dlc> <data_len> <bytes...>`
            if tokens.len() < 9 {
                continue;
            }
            let Ok(ch_1based) = tokens[2].parse::<u16>() else {
                continue;
            };
            let bus_id = (ch_1based.saturating_sub(1)).min(255) as u8;

            let dir_tok = tokens[3];
            if !dir_tok.eq_ignore_ascii_case("Rx") && !dir_tok.eq_ignore_ascii_case("Tx") {
                continue;
            }
            let is_tx = dir_tok.eq_ignore_ascii_case("Tx");

            let Some(can_id) = parse_id_token_radix(tokens[4], radix) else {
                continue;
            };

            let brs_idx = if matches!(tokens[5], "0" | "1") && matches!(tokens[6], "0" | "1") {
                5usize
            } else if tokens.len() >= 10
                && matches!(tokens[6], "0" | "1")
                && matches!(tokens[7], "0" | "1")
            {
                6usize
            } else {
                continue;
            };

            if tokens.len() <= brs_idx + 3 {
                continue;
            }
            let is_brs = tokens[brs_idx] == "1";
            let is_esi = tokens[brs_idx + 1] == "1";
            let Ok(data_len) = tokens[brs_idx + 3].parse::<usize>() else {
                continue;
            };
            let target_len = data_len.min(MAX_CAN_FD_DLC);

            let mut count = 0usize;
            for &b_tok in &tokens[(brs_idx + 4)..] {
                if count >= target_len {
                    break;
                }
                let Some(byte) = parse_byte_token_radix(b_tok, radix) else {
                    break;
                };
                payload_buf[count] = byte;
                count += 1;
            }

            if let Some(frame) = build_frame_from_parts(
                bus_id,
                can_id,
                true,
                is_brs,
                is_esi,
                is_tx,
                false,
                0,
                &payload_buf[..count],
            ) {
                out.push((ts_us, frame));
            }
        } else if let Ok(ch_1based) = tokens[1].parse::<u16>() {
            // Classical CAN: `<time_sec> <ch> <id_hex[x]> <Rx|Tx> <d|r> [dlc] <bytes...>`
            let bus_id = (ch_1based.saturating_sub(1)).min(255) as u8;
            let Some(can_id) = parse_id_token_radix(tokens[2], radix) else {
                continue;
            };
            let dir_tok = tokens[3];
            if !dir_tok.eq_ignore_ascii_case("Rx") && !dir_tok.eq_ignore_ascii_case("Tx") {
                continue;
            }
            let is_tx = dir_tok.eq_ignore_ascii_case("Tx");

            let kind = tokens[4];
            if kind.eq_ignore_ascii_case("r") {
                let rtr_dlc = tokens
                    .get(5)
                    .and_then(|t| u8::from_str_radix(t, radix).ok().or_else(|| t.parse().ok()))
                    .unwrap_or(0);
                if let Some(frame) = build_frame_from_parts(
                    bus_id,
                    can_id,
                    false,
                    false,
                    false,
                    is_tx,
                    true,
                    rtr_dlc,
                    &[],
                ) {
                    out.push((ts_us, frame));
                }
            } else if kind.eq_ignore_ascii_case("d") {
                if tokens.len() < 6 {
                    continue;
                }
                let dlc_len = usize::from(
                    tokens[5]
                        .parse::<u8>()
                        .or_else(|_| u8::from_str_radix(tokens[5], radix))
                        .unwrap_or(0),
                )
                .min(MAX_CAN_FD_DLC);

                let mut count = 0usize;
                for &b_tok in &tokens[6..] {
                    if count >= dlc_len {
                        break;
                    }
                    let Some(byte) = parse_byte_token_radix(b_tok, radix) else {
                        break;
                    };
                    payload_buf[count] = byte;
                    count += 1;
                }

                if let Some(frame) = build_frame_from_parts(
                    bus_id,
                    can_id,
                    count > MAX_CLASSICAL_CAN_DLC,
                    false,
                    false,
                    is_tx,
                    false,
                    0,
                    &payload_buf[..count],
                ) {
                    out.push((ts_us, frame));
                }
            }
        }
    }
}

fn extract_iface_bus_id(iface: &str) -> BusId {
    // Byte-wise scan: the last byte of a multi-byte UTF-8 char is a non-ASCII-digit continuation
    // byte, so `idx + 1` is always a char boundary (char-wise `rfind` + 1 was not; WP-6 fuzz).
    let digits_start = iface
        .bytes()
        .rposition(|b| !b.is_ascii_digit())
        .map_or(0, |idx| idx + 1);
    let suffix = &iface[digits_start..];
    if suffix.is_empty() {
        0
    } else {
        suffix.parse::<u16>().unwrap_or(0).min(255) as u8
    }
}

fn decode_compact_hex_pairs(hex_str: &str, out_buf: &mut [u8; MAX_CAN_FD_DLC]) -> Option<usize> {
    let clean = hex_str.trim();
    if clean.is_empty() {
        return Some(0);
    }
    let bytes = clean.as_bytes();
    if !bytes.len().is_multiple_of(2) {
        return None;
    }
    let pair_count = (bytes.len() / 2).min(MAX_CAN_FD_DLC);
    for i in 0..pair_count {
        let pair = std::str::from_utf8(&bytes[i * 2..i * 2 + 2]).ok()?;
        out_buf[i] = u8::from_str_radix(pair, 16).ok()?;
    }
    Some(pair_count)
}

fn parse_candump_log_lines(content: &str, out: &mut Vec<(i128, RawCanFrame)>) {
    let mut payload_buf = [0u8; MAX_CAN_FD_DLC];
    let mut synthetic_ts_us = 0i128;

    for raw_line in content.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }

        let tokens: Vec<&str> = line.split_whitespace().collect();
        if tokens.len() < 2 {
            continue;
        }

        let (ts_us, idx_iface) = if tokens[0].starts_with('(') && tokens[0].ends_with(')') {
            let inner = &tokens[0][1..tokens[0].len() - 1];
            let Ok(sec) = inner.parse::<f64>() else {
                continue;
            };
            if !sec.is_finite() {
                continue;
            }
            (((sec * 1_000_000.0).round() as i128), 1usize)
        } else if let Ok(sec) = tokens[0].parse::<f64>() {
            if !sec.is_finite() {
                continue;
            }
            (((sec * 1_000_000.0).round() as i128), 1usize)
        } else {
            let cur = synthetic_ts_us;
            synthetic_ts_us += 1_000;
            (cur, 0usize)
        };

        if tokens.len() <= idx_iface + 1 {
            continue;
        }

        let bus_id = extract_iface_bus_id(tokens[idx_iface]);
        let frame_tok = tokens[idx_iface + 1];

        if frame_tok.eq_ignore_ascii_case("ERRORFRAME") {
            let err_mask = tokens
                .get(idx_iface + 2)
                .and_then(|t| parse_err_mask_token(t, 16))
                .unwrap_or(crate::error_frame::CAN_ERR_BUSERROR);
            out.push((ts_us, build_error_frame(bus_id, err_mask, false, &[])));
            continue;
        }

        if let Some((id_part, fd_rhs)) = frame_tok.split_once("##") {
            // Compact CAN-FD: `<id>##<flags_nibble><hex_bytes>`
            let Some(can_id) = parse_id_token_radix(id_part, 16) else {
                continue;
            };
            let rhs = fd_rhs.trim();
            let (flags_nibble, hex_payload) = if rhs.is_empty() {
                (0u8, "")
            } else if rhs.len() % 2 == 1 {
                // `get(..1)` is `None` when `rhs` starts with a multi-byte char (WP-6 fuzz);
                // on success the first byte is ASCII, so `&rhs[1..]` below is a char boundary.
                let Some(nib) = rhs.get(..1).and_then(|s| u8::from_str_radix(s, 16).ok()) else {
                    continue;
                };
                (nib, &rhs[1..])
            } else {
                (0u8, rhs)
            };

            let Some(count) = decode_compact_hex_pairs(hex_payload, &mut payload_buf) else {
                continue;
            };
            let is_brs = (flags_nibble & 0x01) != 0;
            let is_esi = (flags_nibble & 0x02) != 0;

            if let Some(frame) = build_frame_from_parts(
                bus_id,
                can_id,
                true,
                is_brs,
                is_esi,
                false,
                false,
                0,
                &payload_buf[..count],
            ) {
                out.push((ts_us, frame));
            }
        } else if let Some((id_part, cc_rhs)) = frame_tok.split_once('#') {
            // Compact Classical CAN (`<id>#<hex_bytes | R[dlc]>`) OR SocketCAN Error Frame
            // (`2000000C#0020881900008800` where bit 29 = `CAN_ERR_FLAG` and bit 31 = 0).
            let id_clean = id_part
                .trim()
                .strip_prefix("0x")
                .or_else(|| id_part.trim().strip_prefix("0X"))
                .unwrap_or_else(|| id_part.trim());
            let raw_id_u32 = u32::from_str_radix(id_clean, 16).ok();
            let is_socketcan_err =
                raw_id_u32.is_some_and(|raw| (raw & 0x2000_0000) != 0 && (raw & 0x8000_0000) == 0);

            let rhs = cc_rhs.trim();
            if is_socketcan_err {
                let cleaned_rhs: String;
                let hex_ref = if rhs.contains('.') {
                    cleaned_rhs = rhs.replace('.', "");
                    cleaned_rhs.as_str()
                } else {
                    rhs
                };
                let count = decode_compact_hex_pairs(hex_ref, &mut payload_buf).unwrap_or(0);
                let err_mask = raw_id_u32.unwrap_or(0) & EXT_CAN_ID_MASK;
                out.push((
                    ts_us,
                    build_error_frame(bus_id, err_mask, false, &payload_buf[..count]),
                ));
                continue;
            }

            let Some(can_id) = parse_id_token_radix(id_part, 16) else {
                continue;
            };
            if let Some(rtr_rest) = rhs.strip_prefix('R').or_else(|| rhs.strip_prefix('r')) {
                let rtr_dlc = rtr_rest.parse::<u8>().unwrap_or(0);
                if let Some(frame) = build_frame_from_parts(
                    bus_id,
                    can_id,
                    false,
                    false,
                    false,
                    false,
                    true,
                    rtr_dlc,
                    &[],
                ) {
                    out.push((ts_us, frame));
                }
            } else {
                // Allow optional dot separators used by `candump -L` on some versions (`11.22.33`)
                let cleaned_rhs: String;
                let hex_ref = if rhs.contains('.') {
                    cleaned_rhs = rhs.replace('.', "");
                    cleaned_rhs.as_str()
                } else {
                    rhs
                };
                let Some(count) = decode_compact_hex_pairs(hex_ref, &mut payload_buf) else {
                    continue;
                };
                if let Some(frame) = build_frame_from_parts(
                    bus_id,
                    can_id,
                    count > MAX_CLASSICAL_CAN_DLC,
                    false,
                    false,
                    false,
                    false,
                    0,
                    &payload_buf[..count],
                ) {
                    out.push((ts_us, frame));
                }
            }
        } else {
            // Bracketed candump: `[ts] <iface> [RX|TX] <id> <[len]> <XX XX ...>`
            let (id_idx, is_tx) =
                if frame_tok.eq_ignore_ascii_case("RX") || frame_tok.eq_ignore_ascii_case("TX") {
                    (idx_iface + 2, frame_tok.eq_ignore_ascii_case("TX"))
                } else {
                    (idx_iface + 1, false)
                };

            if tokens.len() <= id_idx + 1 {
                continue;
            }
            let Some(can_id) = parse_id_token_radix(tokens[id_idx], 16) else {
                continue;
            };

            let len_tok = tokens[id_idx + 1];
            let is_fd_double_bracket = len_tok.starts_with("[[") && len_tok.ends_with("]]");
            let inner_len = len_tok.trim_matches(|c| c == '[' || c == ']');
            let Ok(declared_len) = inner_len.parse::<usize>() else {
                continue;
            };
            let max_len = declared_len.min(MAX_CAN_FD_DLC);

            let data_start = id_idx + 2;
            if tokens
                .get(data_start)
                .is_some_and(|t| t.eq_ignore_ascii_case("remote") || t.eq_ignore_ascii_case("RTR"))
            {
                if let Some(frame) = build_frame_from_parts(
                    bus_id,
                    can_id,
                    false,
                    false,
                    false,
                    is_tx,
                    true,
                    max_len as u8,
                    &[],
                ) {
                    out.push((ts_us, frame));
                }
                continue;
            }

            let mut count = 0usize;
            for &b_tok in &tokens[data_start..] {
                if count >= max_len {
                    break;
                }
                let Some(byte) = parse_byte_token_radix(b_tok, 16) else {
                    break;
                };
                payload_buf[count] = byte;
                count += 1;
            }

            let is_fd = is_fd_double_bracket
                || declared_len > MAX_CLASSICAL_CAN_DLC
                || count > MAX_CLASSICAL_CAN_DLC;
            if let Some(frame) = build_frame_from_parts(
                bus_id,
                can_id,
                is_fd,
                false,
                false,
                is_tx,
                false,
                0,
                &payload_buf[..count],
            ) {
                out.push((ts_us, frame));
            }
        }
    }
}

fn split_csv_row(line: &str) -> Vec<String> {
    let mut fields = Vec::with_capacity(10);
    let mut current = String::new();
    let mut chars = line.chars().peekable();
    let mut in_quotes = false;

    while let Some(ch) = chars.next() {
        if in_quotes {
            if ch == '"' {
                if chars.peek() == Some(&'"') {
                    current.push('"');
                    let _ = chars.next();
                } else {
                    in_quotes = false;
                }
            } else {
                current.push(ch);
            }
        } else if ch == '"' {
            in_quotes = true;
        } else if ch == ',' {
            fields.push(std::mem::take(&mut current));
        } else {
            current.push(ch);
        }
    }
    fields.push(current);
    fields
}

fn parse_nexus_csv_lines(content: &str, out: &mut Vec<(i128, RawCanFrame)>) {
    let mut payload_buf = [0u8; MAX_CAN_FD_DLC];

    for (line_idx, raw_line) in content.lines().enumerate() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }
        if line_idx == 0 && line.to_ascii_lowercase().starts_with("index,") {
            continue;
        }

        let cols = split_csv_row(line);
        if cols.len() < 9 {
            continue;
        }

        let Ok(time_sec) = cols[1].trim().parse::<f64>() else {
            continue;
        };
        if !time_sec.is_finite() {
            continue;
        }
        let ts_us = (time_sec * 1_000_000.0).round() as i128;

        let bus_1based = cols[2].trim().parse::<u16>().unwrap_or(1);
        let bus_id = (bus_1based.saturating_sub(1)).min(255) as u8;

        let proto = cols[3].trim();
        let is_err = proto.eq_ignore_ascii_case("ERR")
            || proto.eq_ignore_ascii_case("ERROR")
            || cols[4].trim().starts_with("ERR:");
        let is_tx = cols[5].trim().eq_ignore_ascii_case("Tx");

        let mut count = 0usize;
        for b_tok in cols[8].split_whitespace() {
            if count >= MAX_CAN_FD_DLC {
                break;
            }
            let Some(byte) = parse_byte_token_radix(b_tok, 16) else {
                break;
            };
            payload_buf[count] = byte;
            count += 1;
        }

        if is_err {
            let err_mask =
                parse_err_mask_token(&cols[4], 16).unwrap_or(crate::error_frame::CAN_ERR_BUSERROR);
            out.push((
                ts_us,
                build_error_frame(bus_id, err_mask, is_tx, &payload_buf[..count]),
            ));
            continue;
        }

        let is_fd = proto.eq_ignore_ascii_case("FD") || proto.eq_ignore_ascii_case("CANFD");
        let Some(can_id) = parse_id_token_radix(&cols[4], 16) else {
            continue;
        };

        if let Some(frame) = build_frame_from_parts(
            bus_id,
            can_id,
            is_fd,
            false,
            false,
            is_tx,
            false,
            0,
            &payload_buf[..count],
        ) {
            out.push((ts_us, frame));
        }
    }
}

// =============================================================================
// DETERMINISTIC ZERO-ALLOCATION REPLAY WORKER (`nexus-trace-replay`)
// =============================================================================

/// Restbus ID filter mode applied in `O(log N)` without heap allocations on the replay hot path.
#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReplayFilterMode {
    /// Pass all CAN IDs (`"all"`).
    All = 0,
    /// Pass ONLY frames whose `CanIdKey` is in `compiled_filter_keys` (`"include"`).
    Include = 1,
    /// Pass all frames EXCEPT those whose `CanIdKey` is in `compiled_filter_keys` (`"exclude"`).
    Exclude = 2,
}

impl ReplayFilterMode {
    pub fn from_str_checked(raw: &str) -> Result<Self, HalError> {
        let trimmed = raw.trim();
        if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("all") {
            Ok(Self::All)
        } else if trimmed.eq_ignore_ascii_case("include") {
            Ok(Self::Include)
        } else if trimmed.eq_ignore_ascii_case("exclude") {
            Ok(Self::Exclude)
        } else {
            Err(HalError::InvalidInput(format!(
                "Unsupported replay filterMode '{trimmed}' (expected 'all', 'include', or 'exclude')"
            )))
        }
    }

    #[inline]
    fn from_u8(code: u8) -> Self {
        match code {
            1 => Self::Include,
            2 => Self::Exclude,
            _ => Self::All,
        }
    }

    #[inline]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::All => "all",
            Self::Include => "include",
            Self::Exclude => "exclude",
        }
    }
}

/// Direction filter (`"all"` | `"rx"` | `"tx"`) evaluated against each trace entry's recorded direction.
#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DirectionFilter {
    /// Replay both RX and TX frames (`"all"`).
    All = 0,
    /// Replay only RX frames (`!frame.is_tx()`, `"rx"`).
    RxOnly = 1,
    /// Replay only TX frames (`frame.is_tx()`, `"tx"`).
    TxOnly = 2,
}

impl DirectionFilter {
    pub fn from_str_checked(raw: &str) -> Result<Self, HalError> {
        let trimmed = raw.trim();
        if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("all") {
            Ok(Self::All)
        } else if trimmed.eq_ignore_ascii_case("rx") {
            Ok(Self::RxOnly)
        } else if trimmed.eq_ignore_ascii_case("tx") {
            Ok(Self::TxOnly)
        } else {
            Err(HalError::InvalidInput(format!(
                "Unsupported replay directionFilter '{trimmed}' (expected 'all', 'rx', or 'tx')"
            )))
        }
    }

    #[inline]
    fn from_u8(code: u8) -> Self {
        match code {
            1 => Self::RxOnly,
            2 => Self::TxOnly,
            _ => Self::All,
        }
    }

    #[inline]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::All => "all",
            Self::RxOnly => "rx",
            Self::TxOnly => "tx",
        }
    }
}

/// Parses canonical CAN ID filter keys (e.g. `"STD:0x101"`, `"EXT:0x18FF50E5"`, case-insensitive)
/// into a sorted, deduplicated `Box<[CanIdKey]>` for zero-allocation `binary_search` on the hot path
/// alongside normalized canonical strings (`CanIdKey::schema_key()`).
pub fn compile_filter_keys(
    raw_keys: &[String],
) -> Result<(Box<[CanIdKey]>, Vec<String>), HalError> {
    let mut keys = Vec::with_capacity(raw_keys.len());
    for raw in raw_keys {
        if let Some(key) = parse_single_filter_key(raw)? {
            keys.push(key);
        }
    }
    keys.sort_unstable();
    keys.dedup();
    let normalized = keys.iter().copied().map(CanIdKey::schema_key).collect();
    Ok((keys.into_boxed_slice(), normalized))
}

fn parse_single_filter_key(raw: &str) -> Result<Option<CanIdKey>, HalError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    if let Some((prefix_raw, rest_raw)) = trimmed.split_once(':') {
        let prefix = prefix_raw.trim();
        let rest = rest_raw.trim();
        let after_0x = rest
            .strip_prefix("0x")
            .or_else(|| rest.strip_prefix("0X"))
            .unwrap_or(rest);
        let hex_digits = after_0x.strip_suffix(['x', 'X']).unwrap_or(after_0x).trim();
        if hex_digits.is_empty() {
            return Err(HalError::InvalidInput(format!(
                "Invalid CAN ID filter key '{trimmed}'"
            )));
        }
        let parsed = u32::from_str_radix(hex_digits, 16).map_err(|_| {
            HalError::InvalidInput(format!("Invalid hex CAN ID in filter key '{trimmed}'"))
        })?;

        if prefix.eq_ignore_ascii_case("STD") {
            let key = u16::try_from(parsed)
                .ok()
                .and_then(CanIdKey::new_standard)
                .ok_or_else(|| {
                    HalError::InvalidInput(format!(
                        "Standard 11-bit CAN ID filter key '{trimmed}' exceeds 0x7FF"
                    ))
                })?;
            Ok(Some(key))
        } else if prefix.eq_ignore_ascii_case("EXT") {
            let key = CanIdKey::new_extended(parsed).ok_or_else(|| {
                HalError::InvalidInput(format!(
                    "Extended 29-bit CAN ID filter key '{trimmed}' exceeds 0x1FFFFFFF"
                ))
            })?;
            Ok(Some(key))
        } else {
            Err(HalError::InvalidInput(format!(
                "Unsupported CAN ID filter key prefix '{prefix}' in '{trimmed}' (expected 'STD:' or 'EXT:')"
            )))
        }
    } else {
        let after_0x = trimmed
            .strip_prefix("0x")
            .or_else(|| trimmed.strip_prefix("0X"))
            .unwrap_or(trimmed);
        let (hex_digits, explicit_ext) = match after_0x.strip_suffix(['x', 'X']) {
            Some(s) => (s.trim(), true),
            None => (after_0x.trim(), false),
        };
        if hex_digits.is_empty() {
            return Err(HalError::InvalidInput(format!(
                "Invalid CAN ID filter key '{trimmed}'"
            )));
        }
        let parsed = u32::from_str_radix(hex_digits, 16).map_err(|_| {
            HalError::InvalidInput(format!("Invalid hex CAN ID in filter key '{trimmed}'"))
        })?;
        if explicit_ext || parsed > STD_CAN_ID_MASK || hex_digits.len() == 8 {
            let key = CanIdKey::new_extended(parsed).ok_or_else(|| {
                HalError::InvalidInput(format!(
                    "Extended 29-bit CAN ID filter key '{trimmed}' exceeds 0x1FFFFFFF"
                ))
            })?;
            Ok(Some(key))
        } else {
            let key = CanIdKey::new_standard(parsed as u16).ok_or_else(|| {
                HalError::InvalidInput(format!(
                    "Standard 11-bit CAN ID filter key '{trimmed}' exceeds 0x7FF"
                ))
            })?;
            Ok(Some(key))
        }
    }
}

#[inline]
fn clamp_replay_speed(raw: f64) -> f64 {
    if !raw.is_finite() || raw <= 0.0 {
        1.0
    } else {
        raw.clamp(0.05, 100.0)
    }
}

#[inline]
fn state_code_to_str(code: u8) -> &'static str {
    match code {
        STATE_PLAYING => "playing",
        STATE_PAUSED => "paused",
        STATE_COMPLETED => "completed",
        _ => "idle",
    }
}

struct ReplayStartSession {
    source_name: String,
    entries: Box<[CompiledReplayEntry]>,
    speed_factor: f64,
    loop_playback: bool,
    bus_override: Option<u8>,
    transmit_to_hardware: bool,
    filter_mode: ReplayFilterMode,
    compiled_filter_keys: Box<[CanIdKey]>,
    normalized_filter_keys: Vec<String>,
    direction_filter: DirectionFilter,
}

enum ReplayCommand {
    Start(ReplayStartSession, Sender<TraceReplayStatusDto>),
    Control(
        TraceReplayControlArgsDto,
        Sender<Result<TraceReplayStatusDto, HalError>>,
    ),
    StopSync(Sender<()>),
    Shutdown,
}

struct ReplaySharedStatus {
    state_code: AtomicU8,
    source_name: RwLock<String>,
    current_index: AtomicUsize,
    total_frames: AtomicUsize,
    elapsed_us: AtomicU64,
    duration_us: AtomicU64,
    speed_bits: AtomicU64,
    loop_playback: AtomicBool,
    bus_override: AtomicU16,
    transmit_to_hardware: AtomicBool,
    filter_mode: AtomicU8,
    filter_keys: RwLock<Vec<String>>,
    direction_filter: AtomicU8,
    dispatched_frames: AtomicU64,
    filtered_out_frames: AtomicU64,
    hw_tx_frames: Arc<AtomicU64>,
}

impl ReplaySharedStatus {
    fn new() -> Self {
        Self {
            state_code: AtomicU8::new(STATE_IDLE),
            source_name: RwLock::new(String::new()),
            current_index: AtomicUsize::new(0),
            total_frames: AtomicUsize::new(0),
            elapsed_us: AtomicU64::new(0),
            duration_us: AtomicU64::new(0),
            speed_bits: AtomicU64::new(1.0f64.to_bits()),
            loop_playback: AtomicBool::new(false),
            bus_override: AtomicU16::new(NO_BUS_OVERRIDE),
            transmit_to_hardware: AtomicBool::new(false),
            filter_mode: AtomicU8::new(ReplayFilterMode::All as u8),
            filter_keys: RwLock::new(Vec::new()),
            direction_filter: AtomicU8::new(DirectionFilter::All as u8),
            dispatched_frames: AtomicU64::new(0),
            filtered_out_frames: AtomicU64::new(0),
            hw_tx_frames: Arc::new(AtomicU64::new(0)),
        }
    }

    #[inline]
    fn set_bus_override(&self, ov: Option<u8>) {
        let encoded = ov.map_or(NO_BUS_OVERRIDE, u16::from);
        self.bus_override.store(encoded, Ordering::Release);
    }

    #[inline]
    fn get_bus_override(&self) -> Option<u8> {
        let v = self.bus_override.load(Ordering::Acquire);
        if v == NO_BUS_OVERRIDE {
            None
        } else {
            Some((v & 0xFF) as u8)
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn sync_all(
        &self,
        state_code: u8,
        current_index: usize,
        total_frames: usize,
        elapsed_us: u64,
        duration_us: u64,
        speed_factor: f64,
        loop_playback: bool,
        bus_override: Option<u8>,
        transmit_to_hardware: bool,
        filter_mode: ReplayFilterMode,
        normalized_filter_keys: Vec<String>,
        direction_filter: DirectionFilter,
    ) {
        self.current_index.store(current_index, Ordering::Release);
        self.total_frames.store(total_frames, Ordering::Release);
        self.elapsed_us.store(elapsed_us, Ordering::Release);
        self.duration_us.store(duration_us, Ordering::Release);
        self.speed_bits
            .store(speed_factor.to_bits(), Ordering::Release);
        self.loop_playback.store(loop_playback, Ordering::Release);
        self.set_bus_override(bus_override);
        self.transmit_to_hardware
            .store(transmit_to_hardware, Ordering::Release);
        self.filter_mode.store(filter_mode as u8, Ordering::Release);
        *self.filter_keys.write() = normalized_filter_keys;
        self.direction_filter
            .store(direction_filter as u8, Ordering::Release);
        self.dispatched_frames.store(0, Ordering::Release);
        self.filtered_out_frames.store(0, Ordering::Release);
        self.hw_tx_frames.store(0, Ordering::Release);
        self.state_code.store(state_code, Ordering::Release);
    }

    fn snapshot(&self) -> TraceReplayStatusDto {
        TraceReplayStatusDto {
            state: state_code_to_str(self.state_code.load(Ordering::Acquire)).to_string(),
            source_name: self.source_name.read().clone(),
            current_index: self.current_index.load(Ordering::Acquire),
            total_frames: self.total_frames.load(Ordering::Acquire),
            elapsed_us: self.elapsed_us.load(Ordering::Acquire),
            duration_us: self.duration_us.load(Ordering::Acquire),
            speed_factor: f64::from_bits(self.speed_bits.load(Ordering::Acquire)),
            loop_playback: self.loop_playback.load(Ordering::Acquire),
            bus_override: self.get_bus_override(),
            transmit_to_hardware: self.transmit_to_hardware.load(Ordering::Acquire),
            filter_mode: ReplayFilterMode::from_u8(self.filter_mode.load(Ordering::Acquire))
                .as_str()
                .to_string(),
            filter_keys: self.filter_keys.read().clone(),
            direction_filter: DirectionFilter::from_u8(
                self.direction_filter.load(Ordering::Acquire),
            )
            .as_str()
            .to_string(),
            dispatched_frames: self.dispatched_frames.load(Ordering::Acquire),
            filtered_out_frames: self.filtered_out_frames.load(Ordering::Acquire),
            hw_tx_frames: self.hw_tx_frames.load(Ordering::Acquire),
        }
    }
}

/// Thread-safe handle managing the `nexus-trace-replay` worker thread.
pub(crate) struct ReplayController {
    shared: Arc<ReplaySharedStatus>,
    ctrl_tx: Sender<ReplayCommand>,
    tx_panic_latched: Arc<AtomicBool>,
    worker_join: Mutex<Option<JoinHandle<()>>>,
}

impl ReplayController {
    pub(crate) fn spawn(
        frame_tx: Sender<RawCanFrame>,
        dropped_frames: Arc<AtomicU64>,
        buses: Arc<Mutex<BTreeMap<BusId, ConnectedBusHandle>>>,
        tx_panic_latched: Arc<AtomicBool>,
        engine_stop: Arc<AtomicBool>,
    ) -> Self {
        let shared = Arc::new(ReplaySharedStatus::new());
        let (ctrl_tx, ctrl_rx) = bounded::<ReplayCommand>(32);

        let worker_shared = Arc::clone(&shared);
        let worker_panic = Arc::clone(&tx_panic_latched);

        let handle = thread::Builder::new()
            .name("nexus-trace-replay".to_string())
            .spawn(move || {
                run_replay_worker_loop(
                    ctrl_rx,
                    worker_shared,
                    frame_tx,
                    dropped_frames,
                    buses,
                    worker_panic,
                    engine_stop,
                );
            })
            .expect("failed to spawn nexus-trace-replay thread");

        Self {
            shared,
            ctrl_tx,
            tx_panic_latched,
            worker_join: Mutex::new(Some(handle)),
        }
    }

    /// Lock-free / wait-free snapshot of replay status read at 60Hz by `emit_snapshot_now`.
    #[inline]
    pub(crate) fn status_snapshot(&self) -> TraceReplayStatusDto {
        self.shared.snapshot()
    }

    /// Immediately disarms physical hardware TX output during `cmd_panic_stop_tx` without stopping virtual replay.
    #[inline]
    pub(crate) fn disarm_hardware_tx(&self) {
        self.shared
            .transmit_to_hardware
            .store(false, Ordering::Release);
    }

    /// Synchronously stops any active replay before `reset_telemetry_first` drains `frame_rx`.
    pub(crate) fn stop_sync(&self) {
        let (tx, rx) = bounded(1);
        if self.ctrl_tx.send(ReplayCommand::StopSync(tx)).is_ok() {
            let _ = rx.recv_timeout(Duration::from_millis(50));
        }
    }

    pub(crate) fn start_compiled(
        &self,
        source_name: String,
        entries: Vec<CompiledReplayEntry>,
        args: &StartTraceReplayArgsDto,
    ) -> Result<TraceReplayStatusDto, HalError> {
        if entries.is_empty() {
            return Err(HalError::InvalidInput(
                "Trace kaydında oynatılacak çerçeve bulunamadı".to_string(),
            ));
        }

        let filter_mode = ReplayFilterMode::from_str_checked(&args.filter_mode)?;
        let direction_filter = DirectionFilter::from_str_checked(&args.direction_filter)?;
        let (compiled_filter_keys, normalized_filter_keys) =
            compile_filter_keys(&args.filter_keys)?;

        let effective_hw_tx =
            args.transmit_to_hardware && !self.tx_panic_latched.load(Ordering::Acquire);
        let session = ReplayStartSession {
            source_name,
            entries: entries.into_boxed_slice(),
            speed_factor: clamp_replay_speed(args.speed_factor),
            loop_playback: args.loop_playback,
            bus_override: args.bus_override,
            transmit_to_hardware: effective_hw_tx,
            filter_mode,
            compiled_filter_keys,
            normalized_filter_keys,
            direction_filter,
        };

        let (reply_tx, reply_rx) = bounded(1);
        self.ctrl_tx
            .send(ReplayCommand::Start(session, reply_tx))
            .map_err(|_| HalError::InvalidInput("Trace replay thread stopped".to_string()))?;

        reply_rx
            .recv_timeout(Duration::from_millis(250))
            .map_err(|_| {
                HalError::InvalidInput("Timed out waiting for trace replay start".to_string())
            })
    }

    pub(crate) fn control(
        &self,
        ctrl: TraceReplayControlArgsDto,
    ) -> Result<TraceReplayStatusDto, HalError> {
        let (reply_tx, reply_rx) = bounded(1);
        self.ctrl_tx
            .send(ReplayCommand::Control(ctrl, reply_tx))
            .map_err(|_| HalError::InvalidInput("Trace replay thread stopped".to_string()))?;

        reply_rx
            .recv_timeout(Duration::from_millis(250))
            .map_err(|_| {
                HalError::InvalidInput("Timed out waiting for trace replay control".to_string())
            })?
    }

    pub(crate) fn shutdown(&self) {
        self.disarm_hardware_tx();
        let _ = self.ctrl_tx.try_send(ReplayCommand::Shutdown);
        if let Some(handle) = self.worker_join.lock().take() {
            let _ = handle.join();
        }
    }
}

struct WorkerState {
    entries: Box<[CompiledReplayEntry]>,
    playing: bool,
    completed: bool,
    cursor: usize,
    duration_us: u64,
    base_elapsed_us: u64,
    anchor_instant: Instant,
    speed_factor: f64,
    loop_playback: bool,
    bus_override: Option<u8>,
    filter_mode: ReplayFilterMode,
    compiled_filter_keys: Box<[CanIdKey]>,
    direction_filter: DirectionFilter,
}

impl WorkerState {
    fn new() -> Self {
        Self {
            entries: Box::new([]),
            playing: false,
            completed: false,
            cursor: 0,
            duration_us: 0,
            base_elapsed_us: 0,
            anchor_instant: Instant::now(),
            speed_factor: 1.0,
            loop_playback: false,
            bus_override: None,
            filter_mode: ReplayFilterMode::All,
            compiled_filter_keys: Box::new([]),
            direction_filter: DirectionFilter::All,
        }
    }

    #[inline]
    fn current_elapsed_us(&self, now: Instant) -> u64 {
        if self.playing {
            let wall_secs = now
                .saturating_duration_since(self.anchor_instant)
                .as_secs_f64();
            let scaled_us = (wall_secs * self.speed_factor * 1_000_000.0) as u64;
            self.base_elapsed_us.saturating_add(scaled_us)
        } else if self.completed {
            self.duration_us
        } else {
            self.base_elapsed_us
        }
    }
}

fn run_replay_worker_loop(
    ctrl_rx: Receiver<ReplayCommand>,
    shared: Arc<ReplaySharedStatus>,
    frame_tx: Sender<RawCanFrame>,
    dropped_frames: Arc<AtomicU64>,
    buses: Arc<Mutex<BTreeMap<BusId, ConnectedBusHandle>>>,
    tx_panic_latched: Arc<AtomicBool>,
    engine_stop: Arc<AtomicBool>,
) {
    let mut st = WorkerState::new();
    let max_idle_wait = Duration::from_millis(2);

    while !engine_stop.load(Ordering::Acquire) {
        // 1. Drain all pending control messages immediately (< 2ms responsiveness)
        while let Ok(cmd) = ctrl_rx.try_recv() {
            if handle_worker_command(
                cmd,
                &mut st,
                &shared,
                &frame_tx,
                &dropped_frames,
                &buses,
                &tx_panic_latched,
            ) {
                return;
            }
        }

        if engine_stop.load(Ordering::Acquire) {
            break;
        }

        if !st.playing || st.entries.is_empty() {
            if let Ok(cmd) = ctrl_rx.recv_timeout(max_idle_wait) {
                if handle_worker_command(
                    cmd,
                    &mut st,
                    &shared,
                    &frame_tx,
                    &dropped_frames,
                    &buses,
                    &tx_panic_latched,
                ) {
                    return;
                }
            }
            continue;
        }

        // 2. Zero-allocation hot playback dispatch
        dispatch_due_frames(
            &mut st,
            &shared,
            &frame_tx,
            &dropped_frames,
            &buses,
            &tx_panic_latched,
        );

        if !st.playing {
            continue;
        }

        // 3. Compute exact sleep window up to next frame (capped at 2ms for instant Pause/Stop/Seek)
        let wait = if st.cursor < st.entries.len() {
            let now = Instant::now();
            let elapsed_us = st.current_elapsed_us(now);
            let next_rel_us = st.entries[st.cursor].rel_us;
            if next_rel_us <= elapsed_us {
                Duration::ZERO
            } else {
                let rem_trace_us = next_rel_us - elapsed_us;
                let rem_wall_secs = (rem_trace_us as f64) / (st.speed_factor * 1_000_000.0);
                Duration::from_secs_f64(rem_wall_secs.max(0.0)).min(max_idle_wait)
            }
        } else {
            max_idle_wait
        };

        if !wait.is_zero() {
            if let Ok(cmd) = ctrl_rx.recv_timeout(wait) {
                if handle_worker_command(
                    cmd,
                    &mut st,
                    &shared,
                    &frame_tx,
                    &dropped_frames,
                    &buses,
                    &tx_panic_latched,
                ) {
                    return;
                }
            }
        }
    }
}

/// Returns `true` if `ReplayCommand::Shutdown` was received.
fn handle_worker_command(
    cmd: ReplayCommand,
    st: &mut WorkerState,
    shared: &ReplaySharedStatus,
    frame_tx: &Sender<RawCanFrame>,
    dropped_frames: &AtomicU64,
    buses: &Mutex<BTreeMap<BusId, ConnectedBusHandle>>,
    tx_panic_latched: &AtomicBool,
) -> bool {
    match cmd {
        ReplayCommand::Shutdown => return true,
        ReplayCommand::StopSync(ack_tx) => {
            reset_worker_to_idle(st, shared);
            let _ = ack_tx.send(());
        }
        ReplayCommand::Start(session, reply_tx) => {
            st.duration_us = session.entries.last().map_or(0, |e| e.rel_us);
            st.entries = session.entries;
            st.cursor = 0;
            st.base_elapsed_us = 0;
            st.anchor_instant = Instant::now();
            st.speed_factor = session.speed_factor;
            st.loop_playback = session.loop_playback;
            st.bus_override = session.bus_override;
            st.filter_mode = session.filter_mode;
            st.compiled_filter_keys = session.compiled_filter_keys;
            st.direction_filter = session.direction_filter;
            st.playing = true;
            st.completed = false;

            *shared.source_name.write() = session.source_name;
            shared.sync_all(
                STATE_PLAYING,
                0,
                st.entries.len(),
                0,
                st.duration_us,
                st.speed_factor,
                st.loop_playback,
                st.bus_override,
                session.transmit_to_hardware,
                st.filter_mode,
                session.normalized_filter_keys,
                st.direction_filter,
            );

            // Dispatch initial `rel_us == 0` frames immediately so callers see instant playback start
            dispatch_due_frames(
                st,
                shared,
                frame_tx,
                dropped_frames,
                buses,
                tx_panic_latched,
            );
            let _ = reply_tx.send(shared.snapshot());
        }
        ReplayCommand::Control(ctrl, reply_tx) => {
            let res = apply_control_action(ctrl, st, shared, tx_panic_latched);
            let _ = reply_tx.send(res);
        }
    }
    false
}

fn reset_worker_to_idle(st: &mut WorkerState, shared: &ReplaySharedStatus) {
    st.playing = false;
    st.completed = false;
    st.cursor = 0;
    st.duration_us = 0;
    st.base_elapsed_us = 0;
    st.entries = Box::new([]);
    st.filter_mode = ReplayFilterMode::All;
    st.compiled_filter_keys = Box::new([]);
    st.direction_filter = DirectionFilter::All;
    shared.source_name.write().clear();
    shared.sync_all(
        STATE_IDLE,
        0,
        0,
        0,
        0,
        st.speed_factor,
        st.loop_playback,
        st.bus_override,
        false,
        ReplayFilterMode::All,
        Vec::new(),
        DirectionFilter::All,
    );
}

fn apply_control_action(
    ctrl: TraceReplayControlArgsDto,
    st: &mut WorkerState,
    shared: &ReplaySharedStatus,
    tx_panic_latched: &AtomicBool,
) -> Result<TraceReplayStatusDto, HalError> {
    let now = Instant::now();
    match ctrl.action.trim().to_ascii_lowercase().as_str() {
        "pause" => {
            if st.playing {
                let clamped = st.current_elapsed_us(now).min(st.duration_us);
                st.base_elapsed_us = clamped;
                st.playing = false;
                shared.elapsed_us.store(clamped, Ordering::Release);
                shared.state_code.store(STATE_PAUSED, Ordering::Release);
            }
            Ok(shared.snapshot())
        }
        "resume" => {
            if !st.entries.is_empty() && !st.playing {
                if st.completed || st.base_elapsed_us >= st.duration_us {
                    st.cursor = 0;
                    st.base_elapsed_us = 0;
                }
                st.anchor_instant = now;
                st.playing = true;
                st.completed = false;
                shared.current_index.store(st.cursor, Ordering::Release);
                shared
                    .elapsed_us
                    .store(st.base_elapsed_us, Ordering::Release);
                shared.state_code.store(STATE_PLAYING, Ordering::Release);
            }
            Ok(shared.snapshot())
        }
        "stop" => {
            reset_worker_to_idle(st, shared);
            Ok(shared.snapshot())
        }
        "seek" => {
            if !st.entries.is_empty() {
                let target_us = ctrl.seek_us.unwrap_or(0).min(st.duration_us);
                st.cursor = st.entries.partition_point(|e| e.rel_us < target_us);
                st.base_elapsed_us = target_us;
                st.anchor_instant = now;
                if st.completed && target_us < st.duration_us {
                    st.completed = false;
                    shared.state_code.store(STATE_PAUSED, Ordering::Release);
                }
                shared.current_index.store(st.cursor, Ordering::Release);
                shared.elapsed_us.store(target_us, Ordering::Release);
            }
            Ok(shared.snapshot())
        }
        "configure" => {
            // Validate all Restbus filter inputs upfront before mutating live worker state
            let parsed_filter_mode = match ctrl.filter_mode.as_deref() {
                Some(raw_mode) => Some(ReplayFilterMode::from_str_checked(raw_mode)?),
                None => None,
            };
            let parsed_dir_filter = match ctrl.direction_filter.as_deref() {
                Some(raw_dir) => Some(DirectionFilter::from_str_checked(raw_dir)?),
                None => None,
            };
            let parsed_keys = if ctrl.update_filter_keys || ctrl.filter_keys.is_some() {
                let slice = ctrl.filter_keys.as_deref().unwrap_or(&[]);
                Some(compile_filter_keys(slice)?)
            } else {
                None
            };

            if let Some(new_speed) = ctrl.speed_factor {
                if st.playing {
                    st.base_elapsed_us = st.current_elapsed_us(now).min(st.duration_us);
                    st.anchor_instant = now;
                    shared
                        .elapsed_us
                        .store(st.base_elapsed_us, Ordering::Release);
                }
                st.speed_factor = clamp_replay_speed(new_speed);
                shared
                    .speed_bits
                    .store(st.speed_factor.to_bits(), Ordering::Release);
            }
            if let Some(lp) = ctrl.loop_playback {
                st.loop_playback = lp;
                shared.loop_playback.store(lp, Ordering::Release);
            }
            if ctrl.update_bus_override || ctrl.bus_override.is_some() {
                st.bus_override = ctrl.bus_override;
                shared.set_bus_override(st.bus_override);
            }
            if let Some(hw_tx) = ctrl.transmit_to_hardware {
                let allowed = hw_tx && !tx_panic_latched.load(Ordering::Acquire);
                shared
                    .transmit_to_hardware
                    .store(allowed, Ordering::Release);
            }
            if let Some(fm) = parsed_filter_mode {
                st.filter_mode = fm;
                shared.filter_mode.store(fm as u8, Ordering::Release);
            }
            if let Some((compiled_keys, normalized_keys)) = parsed_keys {
                st.compiled_filter_keys = compiled_keys;
                *shared.filter_keys.write() = normalized_keys;
            }
            if let Some(df) = parsed_dir_filter {
                st.direction_filter = df;
                shared.direction_filter.store(df as u8, Ordering::Release);
            }
            Ok(shared.snapshot())
        }
        other => Err(HalError::InvalidInput(format!(
            "Unsupported trace replay control action: '{other}'"
        ))),
    }
}

#[inline]
fn dispatch_due_frames(
    st: &mut WorkerState,
    shared: &ReplaySharedStatus,
    frame_tx: &Sender<RawCanFrame>,
    dropped_frames: &AtomicU64,
    buses: &Mutex<BTreeMap<BusId, ConnectedBusHandle>>,
    tx_panic_latched: &AtomicBool,
) {
    let now = Instant::now();
    let elapsed_us = st.current_elapsed_us(now);
    let hw_tx_enabled = shared.transmit_to_hardware.load(Ordering::Acquire)
        && !tx_panic_latched.load(Ordering::Acquire);

    // Zero heap allocations inside this hot loop: `CompiledReplayEntry` & `RawCanFrame` are `Copy`,
    // and ID filtering runs via `O(log N)` binary search over `st.compiled_filter_keys`.
    let mut batch_guard = 0usize;
    while st.cursor < st.entries.len()
        && st.entries[st.cursor].rel_us <= elapsed_us
        && batch_guard < 8_192
    {
        let entry = st.entries[st.cursor];
        st.cursor += 1;
        batch_guard += 1;

        // 1. Direction filter (`"all"` | `"rx"` | `"tx"`)
        let dir_pass = match st.direction_filter {
            DirectionFilter::All => true,
            DirectionFilter::RxOnly => !entry.frame.is_tx(),
            DirectionFilter::TxOnly => entry.frame.is_tx(),
        };
        if !dir_pass {
            shared.filtered_out_frames.fetch_add(1, Ordering::Relaxed);
            continue;
        }

        // 2. Restbus CAN ID filter (`"all"` | `"include"` | `"exclude"`)
        let id_pass = match st.filter_mode {
            ReplayFilterMode::All => true,
            ReplayFilterMode::Include => st
                .compiled_filter_keys
                .binary_search(&entry.frame.can_id_key())
                .is_ok(),
            ReplayFilterMode::Exclude => st
                .compiled_filter_keys
                .binary_search(&entry.frame.can_id_key())
                .is_err(),
        };
        if !id_pass {
            shared.filtered_out_frames.fetch_add(1, Ordering::Relaxed);
            continue;
        }

        shared.dispatched_frames.fetch_add(1, Ordering::Relaxed);

        let mut out_frame = entry.frame;
        out_frame.timestamp_us = now_monotonic_us().max(1);
        if let Some(ov_bus) = st.bus_override {
            out_frame.bus_id = ov_bus;
        }

        // Virtual injection into StateTable preserves the entry's recorded RX/TX direction flag
        if let Err(TrySendError::Full(_)) = frame_tx.try_send(out_frame) {
            dropped_frames.fetch_add(1, Ordering::Relaxed);
        }

        // Physical Restbus TX onto connected hardware (strictly enforcing Listen-Only, tx_armed & Panic Stop,
        // and NEVER transmitting recorded CAN error frames onto a physical bus!)
        if hw_tx_enabled && !out_frame.is_error() && !tx_panic_latched.load(Ordering::Acquire) {
            let guard = buses.lock();
            if let Some(bus) = guard.get(&out_frame.bus_id) {
                // Epoch captured under the buses lock, before the arm check: a racing Panic
                // Stop either disarms here or invalidates the epoch at the bus-io gate.
                let epoch = bus.tx_epoch.load(Ordering::Acquire);
                if bus.is_connected()
                    && !bus.listen_only
                    && !tx_panic_latched.load(Ordering::Acquire)
                    && bus.tx_armed.load(Ordering::Acquire)
                {
                    let mut hw_frame = out_frame;
                    hw_frame.flags &= !FLAG_TX;
                    let _ = bus.tx_sender.try_send(TxDispatchRequest {
                        frame: hw_frame,
                        ack: None,
                        suppress_echo: true,
                        hw_tx_counter: Some(Arc::clone(&shared.hw_tx_frames)),
                        origin: super::diag_tap::TxOrigin::Other,
                        epoch,
                    });
                }
            }
        }
    }

    if st.cursor >= st.entries.len() {
        if st.loop_playback {
            st.cursor = 0;
            st.base_elapsed_us = 0;
            st.anchor_instant = if st.duration_us == 0 {
                // Prevent tight spin on degenerate 0us single-frame looped traces
                Instant::now() + Duration::from_millis(1)
            } else {
                Instant::now()
            };
            shared.current_index.store(0, Ordering::Release);
            shared.elapsed_us.store(0, Ordering::Release);
        } else {
            st.playing = false;
            st.completed = true;
            st.base_elapsed_us = st.duration_us;
            shared
                .current_index
                .store(st.entries.len(), Ordering::Release);
            shared.elapsed_us.store(st.duration_us, Ordering::Release);
            shared.state_code.store(STATE_COMPLETED, Ordering::Release);
        }
    } else {
        shared.current_index.store(st.cursor, Ordering::Relaxed);
        shared
            .elapsed_us
            .store(elapsed_us.min(st.duration_us), Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::drivers::mock_drv::MOCK0_DEVICE_ID;
    use crate::dto::ChannelConfigDto;
    use crate::pipeline::PipelineEngine;
    use crate::registry::DriverRegistry;

    #[test]
    fn sanitize_trace_filename_blocks_path_traversal_and_preserves_extensions() {
        let ok = |raw: &str| sanitize_trace_filename(raw).expect(raw);
        assert_eq!(ok("evil.trc"), "evil.trc");
        assert_eq!(ok("dyno run 01.ASC"), "dyno_run_01.asc");
        assert_eq!(ok("vcan_capture.LOG"), "vcan_capture.log");
        assert_eq!(ok("bms_export.CSV"), "bms_export.csv");
        assert_eq!(ok("Vector_CANFD_01.BLF"), "Vector_CANFD_01.blf");
        assert_eq!(ok("run.2024.unknown"), "run_2024_unknown.trc");
        assert_eq!(ok("capture"), "capture.trc");

        // WP-8: path-like, empty, dotted and reserved names are errors, never rewritten.
        for bad in [
            "../evil.trc",
            "..\\..\\etc\\passwd",
            "../../logs/dyno run 01.ASC",
            "/etc/passwd",
            "C:evil.trc",
            "..",
            ".",
            "",
            "   ",
            ".hidden.trc",
            "bad..double..dots.unknown",
            "x\0y.trc",
            "line\nbreak.trc",
            "!!!.trc",
            "CON.trc",
            "nul.asc",
        ] {
            assert!(
                sanitize_trace_filename(bad).is_err(),
                "{bad:?} must be rejected"
            );
        }

        // Strict variant used for load / delete: no normalization at all.
        assert_eq!(
            validate_existing_trace_filename("evil.trc").unwrap(),
            "evil.trc"
        );
        assert!(validate_existing_trace_filename("dyno run.asc").is_err());
        assert!(validate_existing_trace_filename("upper.TRC").is_err());
        assert!(validate_existing_trace_filename("noext").is_err());
    }

    #[test]
    fn multi_format_parsers_trc_asc_candump_log_and_csv_bit_exact() {
        // 1. PCAN-Trace v2.1 (Classical + CAN-FD + Extended 29-bit + Multi-Bus)
        let trc_v21 = "\
;$FILEVERSION=2.1
;$STARTTIME=45969.5000000000
;$COLUMNS=N,O,T,B,I,d,L,D
;---+--   ----+----  --+--  -+---  +  -+ -- -- -- -- -- -- --
     1      10.000  DT     1  0101      Rx  8  80 1A 00 00 00 00 00 00
     2      22.500  FB     2  0201      Rx  12 11 22 33 44 55 66 77 88 99 AA BB CC
     3      35.250  DT     1  18FF50E5  Tx  8  AA BB CC DD EE FF 00 11
";
        let trc_entries = parse_trace_text("capture.trc", trc_v21).expect("parse trc v2.1");
        assert_eq!(trc_entries.len(), 3);
        assert_eq!(trc_entries[0].rel_us, 0);
        assert_eq!(trc_entries[0].frame.bus_id, 0);
        assert_eq!(trc_entries[0].frame.arb_id, 0x101);
        assert!(!trc_entries[0].frame.is_extended());
        assert!(!trc_entries[0].frame.is_fd());
        assert_eq!(
            trc_entries[0].frame.payload(),
            &[0x80, 0x1A, 0, 0, 0, 0, 0, 0]
        );

        assert_eq!(trc_entries[1].rel_us, 12_500);
        assert_eq!(trc_entries[1].frame.bus_id, 1);
        assert_eq!(trc_entries[1].frame.arb_id, 0x201);
        assert!(trc_entries[1].frame.is_fd());
        assert!(trc_entries[1].frame.is_brs());
        assert_eq!(trc_entries[1].frame.dlc, 12);
        assert_eq!(
            trc_entries[1].frame.payload(),
            &[0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xAA, 0xBB, 0xCC]
        );

        assert_eq!(trc_entries[2].rel_us, 25_250);
        assert_eq!(trc_entries[2].frame.bus_id, 0);
        assert_eq!(trc_entries[2].frame.arb_id, 0x18FF_50E5);
        assert!(trc_entries[2].frame.is_extended());
        assert!(trc_entries[2].frame.is_tx());

        // 1b. PCAN-Trace v1.1
        let trc_v11 = "\
;$FILEVERSION=1.1
1)       5.000  Rx         0101  8  01 02 03 04 05 06 07 08
2)      15.500  Tx     18F00900  4  DE AD BE EF
";
        let v11_entries = parse_trace_text("legacy.trc", trc_v11).expect("parse trc v1.1");
        assert_eq!(v11_entries.len(), 2);
        assert_eq!(v11_entries[0].rel_us, 0);
        assert_eq!(v11_entries[0].frame.arb_id, 0x101);
        assert_eq!(v11_entries[1].rel_us, 10_500);
        assert!(v11_entries[1].frame.is_extended());
        assert_eq!(v11_entries[1].frame.payload(), &[0xDE, 0xAD, 0xBE, 0xEF]);

        // 2. Vector ASCII .asc (Classical CAN + CANFD)
        let asc_text = "\
date Sun Nov 08 12:00:00.000 2026
base hex  timestamps absolute
internal events logged
Begin Triggerblock Sun Nov 08 12:00:00.000 2026
   0.100000 1  101             Rx   d 8 10 20 30 40 50 60 70 80
   0.115500 CANFD 2 Rx 18FF50E5x 1 0 a 16 01 02 03 04 05 06 07 08 09 0A 0B 0C 0D 0E 0F 10
End TriggerBlock
";
        let asc_entries = parse_trace_text("vector.asc", asc_text).expect("parse asc");
        assert_eq!(asc_entries.len(), 2);
        assert_eq!(asc_entries[0].rel_us, 0);
        assert_eq!(asc_entries[0].frame.bus_id, 0);
        assert_eq!(asc_entries[0].frame.arb_id, 0x101);
        assert!(!asc_entries[0].frame.is_fd());
        assert_eq!(asc_entries[1].rel_us, 15_500);
        assert_eq!(asc_entries[1].frame.bus_id, 1);
        assert_eq!(asc_entries[1].frame.arb_id, 0x18FF_50E5);
        assert!(asc_entries[1].frame.is_extended());
        assert!(asc_entries[1].frame.is_fd());
        assert!(asc_entries[1].frame.is_brs());
        assert_eq!(asc_entries[1].frame.dlc, 16);

        // 3. Linux candump .log (compact `#`, CAN-FD `##`, and bracketed `[8]`)
        let log_text = "\
(1700000000.100000) vcan0 123#DEADBEEF
(1700000000.125000) can1 18FF50E5##1112233445566778899AABBCCDDEEFF00
(1700000000.150000) can2 301 [8] 01 AA BB CC DD EE FF 99
";
        let log_entries = parse_trace_text("candump.log", log_text).expect("parse candump log");
        assert_eq!(log_entries.len(), 3);
        assert_eq!(log_entries[0].rel_us, 0);
        assert_eq!(log_entries[0].frame.bus_id, 0);
        assert_eq!(log_entries[0].frame.arb_id, 0x123);
        assert_eq!(log_entries[0].frame.payload(), &[0xDE, 0xAD, 0xBE, 0xEF]);

        assert_eq!(log_entries[1].rel_us, 25_000);
        assert_eq!(log_entries[1].frame.bus_id, 1);
        assert_eq!(log_entries[1].frame.arb_id, 0x18FF_50E5);
        assert!(log_entries[1].frame.is_extended());
        assert!(log_entries[1].frame.is_fd());
        assert!(log_entries[1].frame.is_brs());
        assert_eq!(log_entries[1].frame.dlc, 16);
        assert_eq!(log_entries[1].frame.payload()[0], 0x11);
        assert_eq!(log_entries[1].frame.payload()[15], 0x00);

        assert_eq!(log_entries[2].rel_us, 50_000);
        assert_eq!(log_entries[2].frame.bus_id, 2);
        assert_eq!(log_entries[2].frame.arb_id, 0x301);
        assert_eq!(log_entries[2].frame.dlc, 8);

        // 4. NexusCAN .csv export format (with quoted commas inside Decoded_Signals)
        let csv_text = "\
Index,Time_s,Bus,Protocol,ID_Hex,Direction,DLC,Symbol,Data_Hex,Decoded_Signals
1,0.000000,1,CC,0x101,Rx,8,\"INV_MotorStatus\",\"E8 03 00 00 00 00 00 00\",\"MotorSpeedRpm=500.0 rpm, Gear=3\"
2,0.040000,2,FD,0x18FF50E5,Tx,12,\"DCFC_Status\",\"01 02 03 04 05 06 07 08 09 0A 0B 0C\",\"V=802.5, I=120.0\"
";
        let csv_entries = parse_trace_text("session.csv", csv_text).expect("parse csv");
        assert_eq!(csv_entries.len(), 2);
        assert_eq!(csv_entries[0].rel_us, 0);
        assert_eq!(csv_entries[0].frame.bus_id, 0);
        assert_eq!(csv_entries[0].frame.arb_id, 0x101);
        assert!(!csv_entries[0].frame.is_extended());
        assert_eq!(csv_entries[1].rel_us, 40_000);
        assert_eq!(csv_entries[1].frame.bus_id, 1);
        assert_eq!(csv_entries[1].frame.arb_id, 0x18FF_50E5);
        assert!(csv_entries[1].frame.is_extended());
        assert!(csv_entries[1].frame.is_fd());
        assert!(csv_entries[1].frame.is_tx());
    }

    #[test]
    fn traces_storage_crud_and_path_traversal_isolation() {
        let tmp_root = std::env::temp_dir().join(format!(
            "nexuscan-traces-crud-{}-{}",
            std::process::id(),
            now_monotonic_us()
        ));
        let traces_dir = tmp_root.join("traces");
        let _ = fs::remove_dir_all(&tmp_root);

        let trc_payload = "\
;$FILEVERSION=2.1
;$COLUMNS=N,O,T,B,I,d,L,D
1 0.000 DT 1 0101 Rx 8 10 27 00 00 00 00 00 00
2 25.000 DT 1 0101 Rx 8 20 4E 00 00 00 00 00 00
";

        // WP-8: path traversal is an error, nothing is written anywhere.
        assert!(save_trace_file(&traces_dir, "../evil.trc", trc_payload).is_err());
        assert!(!tmp_root.join("evil.trc").exists());

        let saved = save_trace_file(&traces_dir, "evil.trc", trc_payload).expect("save evil.trc");
        assert_eq!(saved.file_name, "evil.trc");
        assert_eq!(saved.format, "trc");
        assert_eq!(saved.frame_count, 2);
        assert_eq!(saved.duration_us, 25_000);
        assert!(!tmp_root.join("evil.trc").exists());
        assert!(traces_dir.join("evil.trc").is_file());

        let listed = list_trace_files(&traces_dir, None).expect("list traces");
        assert_eq!(listed.files.len(), 1);
        assert_eq!(listed.files[0].file_name, "evil.trc");
        assert!(!listed.traces_dir.is_empty());

        assert!(load_trace_file(&traces_dir, "../evil.trc").is_err());
        let loaded = load_trace_file(&traces_dir, "evil.trc").expect("load evil.trc");
        assert_eq!(loaded.summary.frame_count, 2);
        assert_eq!(loaded.frames.len(), 2);
        assert_eq!(
            loaded.frames[1].timestamp_us - loaded.frames[0].timestamp_us,
            25_000
        );

        delete_trace_file(&traces_dir, "evil.trc").expect("delete evil.trc");
        assert!(list_trace_files(&traces_dir, None)
            .expect("list empty")
            .files
            .is_empty());

        let _ = fs::remove_dir_all(&tmp_root);
    }

    #[test]
    fn pipeline_engine_trace_replay_decoding_seek_pause_panic_disarm_and_stop() {
        let tmp_root = std::env::temp_dir().join(format!(
            "nexuscan-replay-engine-{}-{}",
            std::process::id(),
            now_monotonic_us()
        ));
        let projects_dir = tmp_root.join("projects");
        let traces_dir = tmp_root.join("traces");
        let _ = fs::remove_dir_all(&tmp_root);

        let engine = PipelineEngine::with_storage_dirs(
            DriverRegistry::with_builtin_drivers(),
            projects_dir,
            traces_dir,
        );

        let schema = engine
            .cmd_load_preset_databases()
            .expect("load preset databases");
        let rpm_sig_id = schema
            .signals
            .iter()
            .find(|s| s.name == "MotorSpeedRpm")
            .expect("MotorSpeedRpm in preset schema")
            .signal_id;

        // Empty replay must return exact Turkish validation error
        let empty_err = engine
            .cmd_start_trace_replay(StartTraceReplayArgsDto {
                source_name: "empty.trc".to_string(),
                frames: Some(Vec::new()),
                ..StartTraceReplayArgsDto::default()
            })
            .expect_err("empty trace must fail");
        assert!(empty_err
            .to_string()
            .contains("Trace kaydında oynatılacak çerçeve bulunamadı"));

        // Save a 5-frame `.trc` file spanning 200ms (`0ms, 50ms, 100ms, 150ms, 200ms`)
        // MotorSpeedRpm factor = 0.5 -> raw 0x0FA0 (4000) => 2000.0 rpm on frame #1!
        let trc_content = "\
;$FILEVERSION=2.1
;$COLUMNS=N,O,T,B,I,d,L,D
1   0.000 DT 1 0101 Tx 8 A0 0F 00 00 00 00 00 00
2  50.000 DT 1 0101 Rx 8 B0 0F 00 00 00 00 00 00
3 100.000 DT 1 0101 Rx 8 C0 0F 00 00 00 00 00 00
4 150.000 DT 1 0101 Rx 8 D0 0F 00 00 00 00 00 00
5 200.000 DT 1 0101 Rx 8 E0 0F 00 00 00 00 00 00
";
        let summary = engine
            .cmd_save_trace_file(
                "drive_test.trc".to_string(),
                Some(trc_content.to_string()),
                None,
            )
            .expect("save trace file");
        assert_eq!(summary.frame_count, 5);
        assert_eq!(summary.duration_us, 200_000);

        // Connect mock0 on Bus 0 in Listen-Only mode to verify hardware TX safety lock is respected
        engine
            .cmd_connect_bus(
                MOCK0_DEVICE_ID.to_string(),
                ChannelConfigDto {
                    bus_id: 0,
                    listen_only: true,
                    ..ChannelConfigDto::default()
                },
            )
            .expect("connect listen-only bus 0");

        // Start replay on BusOverride = 1 (isolated from mock0 on Bus 0) with transmit_to_hardware = true
        let start_status = engine
            .cmd_start_trace_replay(StartTraceReplayArgsDto {
                source_name: "drive_test.trc".to_string(),
                file_name: Some("drive_test.trc".to_string()),
                speed_factor: 0.5, // 200ms trace takes 400ms wall time so we can pause/seek deterministically
                loop_playback: false,
                bus_override: Some(1),
                transmit_to_hardware: true,
                reset_telemetry_first: true,
                ..StartTraceReplayArgsDto::default()
            })
            .expect("start trace replay");
        assert_eq!(start_status.state, "playing");
        assert_eq!(start_status.total_frames, 5);
        assert_eq!(start_status.duration_us, 200_000);
        assert_eq!(start_status.bus_override, Some(1));
        assert!(start_status.transmit_to_hardware);

        // Frame #1 (`rel_us == 0`) was injected immediately onto Bus 1 preserving its recorded Tx flag and decoded!
        let snap1 = engine.flush_snapshot_now().expect("flush snapshot 1");
        assert_eq!(snap1.replay.state, "playing");
        let bus1_row = snap1
            .frames
            .iter()
            .find(|r| r.bus_id == 1 && r.arb_id == 0x101)
            .expect("replayed 0x101 row on bus 1");
        assert!(
            bus1_row.is_tx,
            "replayed frame #1 must preserve its recorded Tx direction flag"
        );
        let decoded_rpm = bus1_row
            .signals
            .iter()
            .find(|s| s.signal_id == rpm_sig_id)
            .expect("decoded MotorSpeedRpm")
            .physical_value;
        assert!((decoded_rpm - 2_000.0).abs() < 1e-6);

        // Pause playback -> state becomes "paused"
        let paused = engine
            .cmd_control_trace_replay(TraceReplayControlArgsDto {
                action: "pause".to_string(),
                ..TraceReplayControlArgsDto::default()
            })
            .expect("pause replay");
        assert_eq!(paused.state, "paused");

        // Seek to 150_000 us -> cursor jumps via partition_point to index 3 (4th frame, rel_us == 150_000)
        let sought = engine
            .cmd_control_trace_replay(TraceReplayControlArgsDto {
                action: "seek".to_string(),
                seek_us: Some(150_000),
                ..TraceReplayControlArgsDto::default()
            })
            .expect("seek replay");
        assert_eq!(sought.current_index, 3);
        assert_eq!(sought.elapsed_us, 150_000);

        // Panic Stop must immediately disarm `transmit_to_hardware`!
        let _ = engine.cmd_panic_stop_tx();
        let snap_after_panic = engine.flush_snapshot_now().expect("flush after panic");
        assert!(!snap_after_panic.replay.transmit_to_hardware);

        // Configure fast speed (20x) + Resume -> finishes remaining 50ms in ~2.5ms -> "completed"!
        let _ = engine
            .cmd_control_trace_replay(TraceReplayControlArgsDto {
                action: "configure".to_string(),
                speed_factor: Some(20.0),
                loop_playback: Some(false),
                ..TraceReplayControlArgsDto::default()
            })
            .expect("configure 20x");
        let resumed = engine
            .cmd_control_trace_replay(TraceReplayControlArgsDto {
                action: "resume".to_string(),
                ..TraceReplayControlArgsDto::default()
            })
            .expect("resume replay");
        assert_eq!(resumed.state, "playing");

        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let snap_done = loop {
            thread::sleep(Duration::from_millis(10));
            let snap = engine.flush_snapshot_now().expect("flush completed");
            if snap.replay.state == "completed" || std::time::Instant::now() >= deadline {
                break snap;
            }
        };
        assert_eq!(snap_done.replay.state, "completed");
        assert_eq!(snap_done.replay.current_index, 5);
        assert_eq!(snap_done.replay.elapsed_us, 200_000);
        let final_bus1_row = snap_done
            .frames
            .iter()
            .find(|r| r.bus_id == 1 && r.arb_id == 0x101)
            .expect("final 0x101 row on bus 1");
        assert!(
            !final_bus1_row.is_tx,
            "frame #5 was Rx so final row direction must be !is_tx"
        );

        // Stop -> returns cleanly to "idle"
        let stopped = engine
            .cmd_control_trace_replay(TraceReplayControlArgsDto {
                action: "stop".to_string(),
                ..TraceReplayControlArgsDto::default()
            })
            .expect("stop replay");
        assert_eq!(stopped.state, "idle");
        assert_eq!(stopped.total_frames, 0);

        let _ = fs::remove_dir_all(&tmp_root);
    }

    #[test]
    fn blf_save_load_and_export_ipc_roundtrip() {
        let tmp_root = std::env::temp_dir().join(format!(
            "nexuscan-blf-ipc-{}-{}",
            std::process::id(),
            now_monotonic_us()
        ));
        let projects_dir = tmp_root.join("projects");
        let traces_dir = tmp_root.join("traces");
        let _ = fs::remove_dir_all(&tmp_root);

        let engine = PipelineEngine::with_storage_dirs(
            DriverRegistry::with_builtin_drivers(),
            projects_dir,
            traces_dir,
        );

        let frames = vec![
            ChronologicalFrameDto {
                timestamp_us: 5_000_000,
                bus_id: 0,
                message_key: "STD:0x101".to_string(),
                arb_id: 0x101,
                is_extended: false,
                is_fd: false,
                is_brs: false,
                is_tx: false,
                is_error: false,
                error_summary: None,
                dlc: 8,
                raw_bytes: vec![0x80, 0x0C, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66],
            },
            ChronologicalFrameDto {
                timestamp_us: 5_012_500,
                bus_id: 1,
                message_key: "EXT:0x18FF50E5".to_string(),
                arb_id: 0x18FF_50E5,
                is_extended: true,
                is_fd: true,
                is_brs: true,
                is_tx: true,
                is_error: false,
                error_summary: None,
                dlc: 64,
                raw_bytes: (0u8..64).map(|i| i.wrapping_mul(5)).collect(),
            },
        ];

        let b64 = engine
            .cmd_export_trace_blf("dyno_capture.blf".to_string(), frames.clone())
            .expect("export BLF base64");
        assert!(!b64.is_empty());

        let saved_summary = engine
            .cmd_save_trace_file("dyno_capture.BLF".to_string(), None, Some(b64.clone()))
            .expect("save binary BLF via content_base64");
        assert_eq!(saved_summary.file_name, "dyno_capture.blf");
        assert_eq!(saved_summary.format, "blf");
        assert_eq!(saved_summary.frame_count, 2);
        assert_eq!(saved_summary.duration_us, 12_500);

        let listed = engine.cmd_list_traces().expect("list traces");
        assert_eq!(listed.files.len(), 1);
        assert_eq!(listed.files[0].format, "blf");

        let loaded = engine
            .cmd_load_trace_file("dyno_capture.blf".to_string())
            .expect("load saved BLF");
        assert_eq!(loaded.summary.format, "blf");
        assert_eq!(loaded.frames.len(), 2);
        assert_eq!(loaded.frames[0].arb_id, 0x101);
        assert!(!loaded.frames[0].is_brs);
        assert!(!loaded.frames[0].is_tx);
        assert_eq!(loaded.frames[1].arb_id, 0x18FF_50E5);
        assert!(loaded.frames[1].is_extended);
        assert!(loaded.frames[1].is_fd);
        assert!(
            loaded.frames[1].is_brs,
            "CAN-FD BRS flag (0x2000) must survive ChronologicalFrameDto -> BLF -> ChronologicalFrameDto roundtrip"
        );
        assert!(loaded.frames[1].is_tx);
        assert_eq!(loaded.frames[1].dlc, 64);
        assert_eq!(loaded.frames[1].raw_bytes, frames[1].raw_bytes);
        assert_eq!(
            loaded.frames[1].timestamp_us - loaded.frames[0].timestamp_us,
            12_500
        );

        let parsed_inline = engine
            .cmd_parse_trace_content("inline.blf".to_string(), None, Some(b64))
            .expect("stateless parse BLF via content_base64");
        assert_eq!(parsed_inline.frames.len(), 2);
        assert_eq!(parsed_inline.frames[1].dlc, 64);
        assert!(
            parsed_inline.frames[1].is_brs,
            "cmd_parse_trace_content must preserve CAN-FD BRS flag (0x2000)"
        );

        // Verify starting replay directly from disk `.blf` works without UTF-8 corruption
        let replay_status = engine
            .cmd_start_trace_replay(StartTraceReplayArgsDto {
                source_name: "dyno_capture.blf".to_string(),
                file_name: Some("dyno_capture.blf".to_string()),
                speed_factor: 50.0,
                reset_telemetry_first: true,
                ..StartTraceReplayArgsDto::default()
            })
            .expect("start replay from disk BLF");
        assert_eq!(replay_status.total_frames, 2);
        // Poll instead of a fixed sleep: Windows timer granularity (~15.6 ms) and slow CI runners
        // can leave a 2-frame replay still "playing" after 20 ms.
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let snap = loop {
            thread::sleep(Duration::from_millis(10));
            let snap = engine.flush_snapshot_now().expect("flush BLF replay");
            if snap.replay.state == "completed" || std::time::Instant::now() >= deadline {
                break snap;
            }
        };
        assert_eq!(snap.replay.state, "completed");
        assert_eq!(snap.replay.dispatched_frames, 2);

        let _ = fs::remove_dir_all(&tmp_root);
    }

    #[test]
    fn restbus_id_filter_include_exclude_and_live_reconfigure() {
        // Verify case-insensitive canonical filter key compilation & deduplication
        let (compiled, normalized) = compile_filter_keys(&[
            "ext:0x18ff50e5".to_string(),
            "std:0x102".to_string(),
            "STD:0x102".to_string(),
            "0x101".to_string(),
        ])
        .expect("compile filter keys");
        assert_eq!(compiled.len(), 3);
        assert_eq!(
            normalized,
            vec![
                "STD:0x101".to_string(),
                "STD:0x102".to_string(),
                "EXT:0x18FF50E5".to_string()
            ]
        );

        let tmp_root = std::env::temp_dir().join(format!(
            "nexuscan-restbus-filter-{}-{}",
            std::process::id(),
            now_monotonic_us()
        ));
        let projects_dir = tmp_root.join("projects");
        let traces_dir = tmp_root.join("traces");
        let _ = fs::remove_dir_all(&tmp_root);

        let engine = PipelineEngine::with_storage_dirs(
            DriverRegistry::with_builtin_drivers(),
            projects_dir,
            traces_dir,
        );

        // Connect mock0 on Bus 0 with Listen-Only = false and arm active TX!
        // Note: mock0 natively generates 0x101, 0x201, 0x301, 0x18FF50E5, so 0x102 & 0x103 are purely from replay!
        engine
            .cmd_connect_bus(
                MOCK0_DEVICE_ID.to_string(),
                ChannelConfigDto {
                    bus_id: 0,
                    listen_only: false,
                    ..ChannelConfigDto::default()
                },
            )
            .expect("connect active bus 0");
        engine
            .cmd_arm_active_bus(0, true)
            .expect("arm active bus 0");

        // Build a trace containing 0x101 (Rx), 0x102 (Rx), 0x103 (Rx), 0x102 (Tx) on Bus 1 (isolated for clean StateTable assertions, then also test armed Bus 0 HW TX!)
        let trc_content = "\
;$FILEVERSION=2.1
;$COLUMNS=N,O,T,B,I,d,L,D
1   0.000 DT 1 0101 Rx 8 11 00 00 00 00 00 00 00
2   5.000 DT 1 0102 Rx 8 22 00 00 00 00 00 00 00
3  10.000 DT 1 0103 Rx 8 33 00 00 00 00 00 00 00
4 2000.000 DT 1 0102 Rx 8 44 00 00 00 00 00 00 00
5 2010.000 DT 1 0102 Tx 8 55 00 00 00 00 00 00 00
6 2020.000 DT 1 0103 Rx 8 66 00 00 00 00 00 00 00
";

        // Start replay on armed Bus 0 (`bus_override = Some(0)`) with `Exclude: ["std:0x102"]` and `transmit_to_hardware: true`!
        let status = engine
            .cmd_start_trace_replay(StartTraceReplayArgsDto {
                source_name: "restbus_test.trc".to_string(),
                content: Some(trc_content.to_string()),
                speed_factor: 1.0,
                loop_playback: false,
                bus_override: Some(0),
                transmit_to_hardware: true,
                reset_telemetry_first: true,
                filter_mode: "exclude".to_string(),
                filter_keys: vec!["std:0x102".to_string()],
                direction_filter: "all".to_string(),
                ..StartTraceReplayArgsDto::default()
            })
            .expect("start filtered restbus replay");
        assert_eq!(status.filter_mode, "exclude");
        assert_eq!(status.filter_keys, vec!["STD:0x102".to_string()]);
        assert_eq!(status.direction_filter, "all");
        assert!(status.transmit_to_hardware);

        // Wait until frames #1 (0ms, 0x101), #2 (5ms, 0x102 - excluded!), #3 (10ms, 0x103) are
        // processed while #4..#6 (2000ms+) remain pending. Polled rather than a fixed sleep: macOS
        // CI VMs oversleep short sleeps by 100ms+, which used to let #4 slip through early.
        let mid_deadline = std::time::Instant::now() + Duration::from_millis(1500);
        let snap_mid = loop {
            let snap = engine.flush_snapshot_now().expect("flush mid replay");
            // Counters move before the aggregator ingests the frame, so also wait for the rows.
            let has = |id: u32| snap.frames.iter().any(|r| r.bus_id == 0 && r.arb_id == id);
            let early_done = snap.replay.dispatched_frames >= 2
                && snap.replay.filtered_out_frames >= 1
                && snap.replay.hw_tx_frames >= 2
                && has(0x101)
                && has(0x103);
            if early_done || std::time::Instant::now() >= mid_deadline {
                break snap;
            }
            thread::sleep(Duration::from_millis(5));
        };
        assert_eq!(snap_mid.replay.dispatched_frames, 2);
        assert_eq!(snap_mid.replay.filtered_out_frames, 1);
        assert!(
            snap_mid.replay.hw_tx_frames >= 2,
            "armed mock0 bus must transmit passed restbus frames to hardware (got {})",
            snap_mid.replay.hw_tx_frames
        );
        assert!(
            snap_mid
                .frames
                .iter()
                .any(|r| r.bus_id == 0 && r.arb_id == 0x101),
            "0x101 must be present in StateTable"
        );
        assert!(
            snap_mid
                .frames
                .iter()
                .any(|r| r.bus_id == 0 && r.arb_id == 0x103),
            "0x103 must be present in StateTable"
        );
        assert!(
            !snap_mid
                .frames
                .iter()
                .any(|r| r.bus_id == 0 && r.arb_id == 0x102),
            "excluded ECU under test ID 0x102 must NOT enter StateTable"
        );

        // Live reconfigure mid-playback: switch to `Include: ["STD:0x102"]` + `direction_filter: "rx"` + speed 10x!
        // Remaining frames are #4 (0x102 Rx -> PASS, payload 0x44), #5 (0x102 Tx -> FILTERED OUT by rx direction!), #6 (0x103 Rx -> FILTERED OUT by Include 0x102!)
        let reconfigured = engine
            .cmd_control_trace_replay(TraceReplayControlArgsDto {
                action: "configure".to_string(),
                speed_factor: Some(10.0),
                filter_mode: Some("include".to_string()),
                update_filter_keys: true,
                filter_keys: Some(vec!["STD:0x102".to_string()]),
                direction_filter: Some("rx".to_string()),
                ..TraceReplayControlArgsDto::default()
            })
            .expect("live reconfigure filter");
        assert_eq!(reconfigured.filter_mode, "include");
        assert_eq!(reconfigured.filter_keys, vec!["STD:0x102".to_string()]);
        assert_eq!(reconfigured.direction_filter, "rx");

        // Trigger Panic Stop -> must immediately disarm `transmit_to_hardware` while virtual playback finishes!
        let _ = engine.cmd_panic_stop_tx();
        assert!(
            !engine
                .flush_snapshot_now()
                .expect("flush panic")
                .replay
                .transmit_to_hardware
        );

        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let snap_end = loop {
            thread::sleep(Duration::from_millis(10));
            let snap = engine.flush_snapshot_now().expect("flush end replay");
            // "completed" can be published just before the aggregator has ingested the last
            // dispatched frame, so also wait for the 0x102 row.
            let has_102 = snap
                .frames
                .iter()
                .any(|r| r.bus_id == 0 && r.arb_id == 0x102);
            if (snap.replay.state == "completed" && has_102)
                || std::time::Instant::now() >= deadline
            {
                break snap;
            }
        };
        assert_eq!(snap_end.replay.state, "completed");
        assert_eq!(snap_end.replay.dispatched_frames, 3); // #1, #3, and #4
        assert_eq!(snap_end.replay.filtered_out_frames, 3); // #2, #5, and #6
        let row_102 = snap_end
            .frames
            .iter()
            .find(|r| r.bus_id == 0 && r.arb_id == 0x102)
            .expect("0x102 Rx frame #4 must appear after live Include reconfigure");
        assert!(!row_102.is_tx);
        assert_eq!(row_102.raw_bytes[0], 0x44);

        let _ = fs::remove_dir_all(&tmp_root);
    }
}
