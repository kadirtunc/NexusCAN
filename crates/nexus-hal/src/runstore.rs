//! Diagnostics Workspace run store (contract `planning/contracts/diag-workspace-v1.md` §10).
//!
//! Rust mirror of the frozen TS contract `src/types/runRecord.ts` (`RunRecordV1`,
//! `RunFileRefV1`, `RunQueryFilterDto`). IPC fields are camelCase.
//!
//! On-disk layout under the data root (append-only, one JSON line per record):
//!
//! ```text
//! <data_root>/runs/<projectId>/<YYYY-MM>.jsonl     month taken from `startedAt` (UTC)
//! ```
//!
//! Lines are only ever appended (`O_APPEND`, flush + `sync_data`); nothing is rewritten or
//! deleted. Corrupt lines (e.g. a torn write after a crash) are skipped and counted on read.
//! All appends are serialized by the [`RunStore`] mutex.

use crate::storage::create_private_dir_all;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use thiserror::Error;

/// Max serialized size of one record line (without the trailing newline).
pub const MAX_RUN_RECORD_BYTES: usize = 256 * 1024;

/// Max number of `logExcerpt` lines.
pub const MAX_LOG_EXCERPT_LINES: usize = 200;

/// Max characters per `logExcerpt` line.
pub const MAX_LOG_EXCERPT_LINE_CHARS: usize = 512;

/// Max `durationMs` (`Number.MAX_SAFE_INTEGER` = 2^53 - 1): exact in JS and in cloud hashing.
pub const MAX_DURATION_MS: u64 = (1 << 53) - 1;

/// `cmd_run_query` limit bounds.
pub const MIN_QUERY_LIMIT: u32 = 1;
pub const MAX_QUERY_LIMIT: u32 = 5000;

/// Max length of a uuid-safe id (`[A-Za-z0-9-]{1,64}`).
pub const MAX_RUN_ID_LEN: usize = 64;

/// Reverse reader block size.
const READ_BLOCK: usize = 64 * 1024;

/// A line longer than this is corrupt by definition (records are capped at 256 KiB).
const MAX_SCANNED_LINE_BYTES: usize = MAX_RUN_RECORD_BYTES + 1024;

/// Max month files considered per project.
const MAX_MONTH_FILES: usize = 4096;

// ─── Errors ─────────────────────────────────────────────────────────────────

/// Wire codes of [`RunStoreError`] (`RunStoreErrorCode` in the TS contract).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStoreErrorCode {
    Invalid,
    TooLarge,
    Io,
}

impl RunStoreErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Invalid => "invalid",
            Self::TooLarge => "too_large",
            Self::Io => "io",
        }
    }
}

/// Run store error; reaches the HMI as `"[runstore:<code>] <message>"`
/// ([`RunStoreError::to_ipc_string`], parsed by `parseRunStoreError`).
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum RunStoreError {
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    TooLarge(String),
    #[error("{0}")]
    Io(String),
}

impl RunStoreError {
    pub fn code(&self) -> RunStoreErrorCode {
        match self {
            Self::Invalid(_) => RunStoreErrorCode::Invalid,
            Self::TooLarge(_) => RunStoreErrorCode::TooLarge,
            Self::Io(_) => RunStoreErrorCode::Io,
        }
    }

    /// `"[runstore:<code>] <message>"`.
    pub fn to_ipc_string(&self) -> String {
        format!("[runstore:{}] {}", self.code().as_str(), self)
    }
}

fn io_error(context: &str, e: impl std::fmt::Display) -> RunStoreError {
    RunStoreError::Io(format!("{context}: {e}"))
}

// ─── DTOs (mirror src/types/runRecord.ts) ───────────────────────────────────

/// `RunOutcome`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunOutcome {
    Ok,
    Fail,
    Error,
    Aborted,
    PanicStop,
}

/// `RunFileRefV1`: firmware / file inputs appear only as `{ key, name, size, crc32 }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunFileRefV1 {
    pub key: String,
    pub name: String,
    pub size: u64,
    /// 8 hex digits.
    pub crc32: String,
}

/// `RunValue` map: values restricted to string / number / bool / null (validated on append).
pub type RunValueMap = BTreeMap<String, serde_json::Value>;

/// `RunRecordV1`: immutable run event.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRecordV1 {
    pub schema_version: u32,
    pub run_id: String,
    pub parent_run_id: Option<String>,
    pub queue_id: Option<String>,
    pub project_id: String,
    pub vehicle_id: Option<String>,
    pub ecu_id: Option<String>,
    pub ecu_name: Option<String>,
    pub ecu_snapshot_hash: Option<String>,
    pub flow_id: String,
    pub flow_revision: u32,
    pub flow_content_hash: String,
    pub flow_name: String,
    pub params: RunValueMap,
    pub files: Vec<RunFileRefV1>,
    pub started_at: String,
    pub ended_at: String,
    /// Integer milliseconds (canonical wire form `5`, never `5.0`). Negative or fractional
    /// values fail deserialization; values above [`MAX_DURATION_MS`] fail validation.
    pub duration_ms: u64,
    pub outcome: RunOutcome,
    pub output_name: Option<String>,
    pub outputs: RunValueMap,
    pub nrc: Option<u8>,
    pub error_message: Option<String>,
    pub log_excerpt: Vec<String>,
    pub operator: Option<String>,
    pub device_id: String,
    pub app_version: String,
}

/// `RunQueryFilterDto`. `null` and a missing key both mean "no filter" for that field.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunQueryFilterDto {
    #[serde(default)]
    pub ecu_id: Option<String>,
    #[serde(default)]
    pub flow_id: Option<String>,
    #[serde(default)]
    pub queue_id: Option<String>,
    #[serde(default)]
    pub outcome: Option<RunOutcome>,
    /// ISO-8601, inclusive.
    #[serde(default)]
    pub since: Option<String>,
    /// ISO-8601, exclusive.
    #[serde(default)]
    pub until: Option<String>,
    /// Only records with `parentRunId === null`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub top_level_only: Option<bool>,
}

// ─── Validation helpers ─────────────────────────────────────────────────────

/// `true` for `[A-Za-z0-9-]{1,64}` (uuid-safe, never path-like).
pub fn is_uuid_safe(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_RUN_ID_LEN
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

fn check_uuid_safe(field: &str, id: &str) -> Result<(), RunStoreError> {
    if is_uuid_safe(id) {
        Ok(())
    } else {
        Err(RunStoreError::Invalid(format!(
            "invalid {field} '{}': expected [A-Za-z0-9-]{{1,64}}",
            id.escape_debug()
        )))
    }
}

fn check_opt_uuid_safe(field: &str, id: Option<&str>) -> Result<(), RunStoreError> {
    id.map_or(Ok(()), |id| check_uuid_safe(field, id))
}

/// A parsed RFC 3339 instant, normalized to UTC (comparable).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct UtcInstant {
    secs: i64,
    nanos: u32,
}

impl UtcInstant {
    /// `YYYY-MM` of this instant (UTC).
    fn month_key(self) -> String {
        let (y, m, _) = civil_from_days(self.secs.div_euclid(86_400));
        format!("{y:04}-{m:02}")
    }
}

/// Parses `YYYY-MM-DDTHH:MM:SS[.fraction](Z|±HH:MM)`; returns the instant and the offset in
/// minutes. `t`/`z` and a space separator are not accepted (strict RFC 3339 profile).
fn parse_rfc3339(s: &str) -> Option<(UtcInstant, i32)> {
    let b = s.as_bytes();
    if b.len() < 20 || b.len() > 40 {
        return None;
    }
    let num = |from: usize, len: usize| -> Option<u32> {
        let part = b.get(from..from + len)?;
        if !part.iter().all(u8::is_ascii_digit) {
            return None;
        }
        Some(
            part.iter()
                .fold(0u32, |acc, d| acc * 10 + u32::from(d - b'0')),
        )
    };
    let sep = |i: usize, c: u8| b.get(i) == Some(&c);
    if !(sep(4, b'-') && sep(7, b'-') && sep(10, b'T') && sep(13, b':') && sep(16, b':')) {
        return None;
    }
    let (year, month, day) = (num(0, 4)?, num(5, 2)?, num(8, 2)?);
    let (hour, minute, second) = (num(11, 2)?, num(14, 2)?, num(17, 2)?);
    if !(1..=12).contains(&month)
        || day == 0
        || day > days_in_month(year, month)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return None;
    }
    let mut i = 19;
    let mut nanos: u32 = 0;
    if sep(i, b'.') {
        i += 1;
        let start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        let digits = i - start;
        if digits == 0 || digits > 9 {
            return None;
        }
        let frac = num(start, digits)?;
        nanos = frac * 10u32.pow(9 - digits as u32);
    }
    let offset_min: i32 = match b.get(i)? {
        b'Z' if i + 1 == b.len() => 0,
        sign @ (b'+' | b'-') if i + 6 == b.len() && sep(i + 3, b':') => {
            let (oh, om) = (num(i + 1, 2)?, num(i + 4, 2)?);
            if oh > 23 || om > 59 {
                return None;
            }
            let total = (oh * 60 + om) as i32;
            if *sign == b'-' {
                -total
            } else {
                total
            }
        }
        _ => return None,
    };
    let days = days_from_civil(i64::from(year), month, day);
    let local = days * 86_400 + i64::from(hour * 3600 + minute * 60 + second);
    let secs = local - i64::from(offset_min) * 60;
    Some((UtcInstant { secs, nanos }, offset_min))
}

fn is_leap(y: u32) -> bool {
    (y.is_multiple_of(4) && !y.is_multiple_of(100)) || y.is_multiple_of(400)
}

fn days_in_month(y: u32, m: u32) -> u32 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap(y) => 29,
        2 => 28,
        _ => 0,
    }
}

/// Days since 1970-01-01 (H. Hinnant's algorithm).
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let m = i64::from(m);
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + i64::from(d) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Record timestamps: RFC 3339 in UTC (`Z` or `+00:00`).
fn parse_utc_timestamp(field: &str, s: &str) -> Result<UtcInstant, RunStoreError> {
    match parse_rfc3339(s) {
        Some((t, 0)) => Ok(t),
        Some(_) => Err(RunStoreError::Invalid(format!(
            "{field} '{}' must be UTC (suffix 'Z')",
            s.escape_debug()
        ))),
        None => Err(RunStoreError::Invalid(format!(
            "{field} '{}' is not an RFC 3339 timestamp",
            s.escape_debug()
        ))),
    }
}

/// Filter bounds: any RFC 3339 offset is accepted and normalized to UTC.
fn parse_filter_timestamp(field: &str, s: &str) -> Result<UtcInstant, RunStoreError> {
    parse_rfc3339(s).map(|(t, _)| t).ok_or_else(|| {
        RunStoreError::Invalid(format!(
            "filter.{field} '{}' is not an RFC 3339 timestamp",
            s.escape_debug()
        ))
    })
}

fn is_scalar(v: &serde_json::Value) -> bool {
    !matches!(
        v,
        serde_json::Value::Array(_) | serde_json::Value::Object(_)
    )
}

/// Validates `record` and returns its `startedAt` instant.
pub fn validate_record(record: &RunRecordV1) -> Result<UtcInstant, RunStoreError> {
    if record.schema_version != 1 {
        return Err(RunStoreError::Invalid(format!(
            "unsupported schemaVersion {} (expected 1)",
            record.schema_version
        )));
    }
    check_uuid_safe("runId", &record.run_id)?;
    check_uuid_safe("projectId", &record.project_id)?;
    check_opt_uuid_safe("parentRunId", record.parent_run_id.as_deref())?;
    check_opt_uuid_safe("queueId", record.queue_id.as_deref())?;
    check_opt_uuid_safe("vehicleId", record.vehicle_id.as_deref())?;
    check_opt_uuid_safe("ecuId", record.ecu_id.as_deref())?;
    if record.flow_id.is_empty() {
        return Err(RunStoreError::Invalid("flowId is empty".to_string()));
    }
    let started = parse_utc_timestamp("startedAt", &record.started_at)?;
    parse_utc_timestamp("endedAt", &record.ended_at)?;
    if record.duration_ms > MAX_DURATION_MS {
        return Err(RunStoreError::Invalid(format!(
            "durationMs {} exceeds {MAX_DURATION_MS} (2^53 - 1)",
            record.duration_ms
        )));
    }
    for (field, map) in [("params", &record.params), ("outputs", &record.outputs)] {
        if let Some((k, _)) = map.iter().find(|(_, v)| !is_scalar(v)) {
            return Err(RunStoreError::Invalid(format!(
                "{field}.{} must be a string, number, boolean or null",
                k.escape_debug()
            )));
        }
    }
    for f in &record.files {
        if f.crc32.len() != 8 || !f.crc32.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(RunStoreError::Invalid(format!(
                "files[{}].crc32 '{}' must be 8 hex digits",
                f.key.escape_debug(),
                f.crc32.escape_debug()
            )));
        }
    }
    if record.log_excerpt.len() > MAX_LOG_EXCERPT_LINES {
        return Err(RunStoreError::Invalid(format!(
            "logExcerpt has {} lines (limit {MAX_LOG_EXCERPT_LINES})",
            record.log_excerpt.len()
        )));
    }
    if let Some((i, line)) = record
        .log_excerpt
        .iter()
        .enumerate()
        .find(|(_, l)| l.chars().count() > MAX_LOG_EXCERPT_LINE_CHARS)
    {
        return Err(RunStoreError::Invalid(format!(
            "logExcerpt[{i}] has {} characters (limit {MAX_LOG_EXCERPT_LINE_CHARS})",
            line.chars().count()
        )));
    }
    Ok(started)
}

// ─── Query helpers ──────────────────────────────────────────────────────────

struct CompiledFilter<'a> {
    filter: &'a RunQueryFilterDto,
    since: Option<UtcInstant>,
    until: Option<UtcInstant>,
}

impl<'a> CompiledFilter<'a> {
    fn new(filter: &'a RunQueryFilterDto) -> Result<Self, RunStoreError> {
        let since = filter
            .since
            .as_deref()
            .map(|s| parse_filter_timestamp("since", s))
            .transpose()?;
        let until = filter
            .until
            .as_deref()
            .map(|s| parse_filter_timestamp("until", s))
            .transpose()?;
        Ok(Self {
            filter,
            since,
            until,
        })
    }

    fn matches(&self, r: &RunRecordV1, started: UtcInstant) -> bool {
        let f = self.filter;
        f.ecu_id
            .as_ref()
            .is_none_or(|e| r.ecu_id.as_ref() == Some(e))
            && f.flow_id.as_ref().is_none_or(|x| *x == r.flow_id)
            && f.queue_id
                .as_ref()
                .is_none_or(|q| r.queue_id.as_ref() == Some(q))
            && f.outcome.is_none_or(|o| o == r.outcome)
            && self.since.is_none_or(|s| started >= s)
            && self.until.is_none_or(|u| started < u)
            && (f.top_level_only != Some(true) || r.parent_run_id.is_none())
    }
}

/// Reads lines of a file from the end towards the start without loading it completely.
/// Over-long lines (no newline within [`MAX_SCANNED_LINE_BYTES`]) are yielded as `None`.
struct ReverseLines {
    file: File,
    pos: u64,
    carry: Vec<u8>,
    skipping: bool,
}

impl ReverseLines {
    fn open(path: &Path) -> io::Result<Self> {
        let file = File::open(path)?;
        let pos = file.metadata()?.len();
        Ok(Self {
            file,
            pos,
            carry: Vec::new(),
            skipping: false,
        })
    }

    /// `Ok(Some(Some(line)))` = a line, `Ok(Some(None))` = an over-long (corrupt) line,
    /// `Ok(None)` = start of file reached. Memory is bounded by
    /// `MAX_SCANNED_LINE_BYTES + READ_BLOCK`.
    fn next_line(&mut self) -> io::Result<Option<Option<Vec<u8>>>> {
        loop {
            if let Some(i) = self.carry.iter().rposition(|&b| b == b'\n') {
                let line = self.carry.split_off(i + 1);
                self.carry.truncate(i);
                if std::mem::take(&mut self.skipping) {
                    // `line` is only the head of the over-long line: discard it.
                    return Ok(Some(None));
                }
                return Ok(Some(Some(line)));
            }
            if self.pos == 0 {
                if std::mem::take(&mut self.skipping) {
                    self.carry.clear();
                    return Ok(Some(None));
                }
                if self.carry.is_empty() {
                    return Ok(None);
                }
                return Ok(Some(Some(std::mem::take(&mut self.carry))));
            }
            if self.carry.len() > MAX_SCANNED_LINE_BYTES {
                // Keep scanning backwards for the start of this line, discarding its bytes.
                self.skipping = true;
                self.carry.clear();
            }
            let n = (READ_BLOCK as u64).min(self.pos);
            self.pos -= n;
            self.file.seek(SeekFrom::Start(self.pos))?;
            // `n <= READ_BLOCK`, so the cast cannot truncate.
            let mut chunk = vec![0u8; n as usize];
            self.file.read_exact(&mut chunk)?;
            chunk.extend_from_slice(&self.carry);
            self.carry = chunk;
        }
    }
}

// ─── Store ──────────────────────────────────────────────────────────────────

/// Result of a scan: records plus the number of skipped corrupt lines.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RunScan {
    pub records: Vec<RunRecordV1>,
    pub corrupt_lines: usize,
}

/// Append-only run store rooted at `<data_root>/runs`.
#[derive(Debug)]
pub struct RunStore {
    dir: PathBuf,
    lock: Mutex<()>,
}

impl RunStore {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self {
            dir: dir.into(),
            lock: Mutex::new(()),
        }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// `cmd_run_append`: validates and appends one line to `<projectId>/<YYYY-MM>.jsonl`.
    pub fn append(&self, record: &RunRecordV1) -> Result<(), RunStoreError> {
        let started = validate_record(record)?;
        let mut line = serde_json::to_vec(record)
            .map_err(|e| RunStoreError::Invalid(format!("record serialization failed: {e}")))?;
        if line.len() > MAX_RUN_RECORD_BYTES {
            return Err(RunStoreError::TooLarge(format!(
                "run record is too large: {} bytes (limit {MAX_RUN_RECORD_BYTES} bytes)",
                line.len()
            )));
        }
        line.push(b'\n');

        let _guard = self.lock.lock();
        let project_dir = self.ensure_project_dir(&record.project_id)?;
        let path = project_dir.join(format!("{}.jsonl", started.month_key()));
        match fs::symlink_metadata(&path) {
            Ok(m) if m.file_type().is_symlink() || !m.is_file() => {
                return Err(RunStoreError::Io(format!(
                    "'{}' is not a regular file",
                    path.display()
                )))
            }
            _ => {}
        }
        let mut opts = OpenOptions::new();
        opts.read(true).append(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut file = opts.open(&path).map_err(|e| io_error("open run file", e))?;
        // A torn previous write leaves no trailing newline; start on a fresh line so this
        // record is not glued to the corrupt tail.
        let len = file
            .metadata()
            .map_err(|e| io_error("stat run file", e))?
            .len();
        if len > 0 {
            let mut last = [0u8; 1];
            file.seek(SeekFrom::Start(len - 1))
                .and_then(|_| file.read_exact(&mut last))
                .map_err(|e| io_error("read run file", e))?;
            if last[0] != b'\n' {
                line.insert(0, b'\n');
            }
        }
        file.write_all(&line)
            .and_then(|()| file.flush())
            .and_then(|()| file.sync_data())
            .map_err(|e| io_error("append run record", e))
    }

    /// `cmd_run_query`: newest first (month files descending, lines in reverse), filtered,
    /// at most `limit` records.
    pub fn query(
        &self,
        project_id: &str,
        filter: &RunQueryFilterDto,
        limit: u32,
    ) -> Result<RunScan, RunStoreError> {
        check_uuid_safe("projectId", project_id)?;
        if !(MIN_QUERY_LIMIT..=MAX_QUERY_LIMIT).contains(&limit) {
            return Err(RunStoreError::Invalid(format!(
                "limit {limit} out of range {MIN_QUERY_LIMIT}..={MAX_QUERY_LIMIT}"
            )));
        }
        let compiled = CompiledFilter::new(filter)?;
        let since_month = compiled.since.map(UtcInstant::month_key);
        let mut scan = RunScan::default();
        self.scan_newest_first(
            project_id,
            since_month.as_deref(),
            |rec, started| {
                if compiled.matches(&rec, started) {
                    scan.records.push(rec);
                }
                scan.records.len() < limit as usize
            },
            &mut scan.corrupt_lines,
        )?;
        Ok(scan)
    }

    /// `cmd_run_latest`: latest top-level record per `(ecuId, flowId)` (`ecuId: null` is its
    /// own key), newest first.
    pub fn latest(&self, project_id: &str) -> Result<RunScan, RunStoreError> {
        check_uuid_safe("projectId", project_id)?;
        let mut seen: HashSet<(Option<String>, String)> = HashSet::new();
        let mut scan = RunScan::default();
        self.scan_newest_first(
            project_id,
            None,
            |rec, _| {
                if rec.parent_run_id.is_none()
                    && seen.insert((rec.ecu_id.clone(), rec.flow_id.clone()))
                {
                    scan.records.push(rec);
                }
                true
            },
            &mut scan.corrupt_lines,
        )?;
        Ok(scan)
    }

    // ─── internals ──────────────────────────────────────────────────────────

    fn ensure_project_dir(&self, project_id: &str) -> Result<PathBuf, RunStoreError> {
        create_private_dir_all(&self.dir).map_err(|e| io_error("create run store directory", e))?;
        let path = self.dir.join(project_id);
        match fs::symlink_metadata(&path) {
            Ok(m) if m.file_type().is_symlink() => Err(RunStoreError::Io(format!(
                "refusing to follow symbolic link for project '{project_id}'"
            ))),
            Ok(m) if !m.is_dir() => Err(RunStoreError::Io(format!(
                "run store entry '{project_id}' is not a directory"
            ))),
            Ok(_) => Ok(path),
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                create_private_dir_all(&path)
                    .map_err(|e| io_error("create project run directory", e))?;
                Ok(path)
            }
            Err(e) => Err(io_error("stat project run directory", e)),
        }
    }

    /// Month files (`YYYY-MM.jsonl`, regular files only) of a project, newest first.
    fn month_files(&self, project_id: &str) -> Result<Vec<(String, PathBuf)>, RunStoreError> {
        let dir = self.dir.join(project_id);
        match fs::symlink_metadata(&dir) {
            Ok(m) if m.is_dir() && !m.file_type().is_symlink() => {}
            Ok(_) => {
                return Err(RunStoreError::Io(format!(
                    "run store entry '{project_id}' is not a directory"
                )))
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(io_error("stat project run directory", e)),
        }
        let rd = fs::read_dir(&dir).map_err(|e| io_error("list project run directory", e))?;
        let mut out = Vec::new();
        for entry in rd.flatten().take(MAX_MONTH_FILES) {
            match entry.file_type() {
                Ok(ft) if ft.is_file() => {}
                _ => continue,
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if let Some(month) = name.strip_suffix(".jsonl").filter(|m| is_month_key(m)) {
                out.push((month.to_string(), entry.path()));
            }
        }
        out.sort_by(|a, b| b.0.cmp(&a.0));
        Ok(out)
    }

    /// Visits records newest first until `visit` returns `false`. Lines that do not parse as a
    /// [`RunRecordV1`] (or have an invalid `startedAt`) are skipped and counted. Month files
    /// older than `since_month` are not opened.
    fn scan_newest_first(
        &self,
        project_id: &str,
        since_month: Option<&str>,
        mut visit: impl FnMut(RunRecordV1, UtcInstant) -> bool,
        corrupt: &mut usize,
    ) -> Result<(), RunStoreError> {
        // Readers do not take the append lock: appends are single `write` calls on an
        // O_APPEND handle and a torn tail line is skipped as corrupt.
        'files: for (month, path) in self.month_files(project_id)? {
            if since_month.is_some_and(|s| month.as_str() < s) {
                break;
            }
            let mut lines = ReverseLines::open(&path).map_err(|e| io_error("open run file", e))?;
            while let Some(line) = lines
                .next_line()
                .map_err(|e| io_error("read run file", e))?
            {
                let Some(line) = line else {
                    *corrupt += 1;
                    continue;
                };
                let line = line.strip_suffix(b"\r").unwrap_or(&line);
                if line.iter().all(u8::is_ascii_whitespace) {
                    continue;
                }
                let parsed = serde_json::from_slice::<RunRecordV1>(line)
                    .ok()
                    .and_then(|r| parse_rfc3339(&r.started_at).map(|(t, _)| (r, t)));
                match parsed {
                    Some((rec, started)) => {
                        if !visit(rec, started) {
                            break 'files;
                        }
                    }
                    None => *corrupt += 1,
                }
            }
        }
        if *corrupt > 0 {
            eprintln!(
                "[runstore] warning: skipped {} corrupt line(s) in runs/{project_id}",
                *corrupt
            );
        }
        Ok(())
    }
}

/// `YYYY-MM` with month 01..=12.
fn is_month_key(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 7
        && b[4] == b'-'
        && b[..4].iter().all(u8::is_ascii_digit)
        && b[5..].iter().all(u8::is_ascii_digit)
        && matches!(
            &s[5..],
            "01" | "02" | "03" | "04" | "05" | "06" | "07" | "08" | "09" | "10" | "11" | "12"
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const PROJECT: &str = "3f2b8c1e-7d4a-4e9b-9c0d-112233445566";

    fn tmp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "nexuscan-runstore-{tag}-{}-{}",
            std::process::id(),
            nexus_core::now_monotonic_us()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn record(run_id: &str, started_at: &str) -> RunRecordV1 {
        RunRecordV1 {
            schema_version: 1,
            run_id: run_id.to_string(),
            parent_run_id: None,
            queue_id: None,
            project_id: PROJECT.to_string(),
            vehicle_id: Some("veh-1".to_string()),
            ecu_id: Some("ecu-a".to_string()),
            ecu_name: Some("BMS".to_string()),
            ecu_snapshot_hash: None,
            flow_id: "read_vin".to_string(),
            flow_revision: 1,
            flow_content_hash: "a".repeat(64),
            flow_name: "Read VIN".to_string(),
            params: BTreeMap::new(),
            files: Vec::new(),
            started_at: started_at.to_string(),
            ended_at: started_at.to_string(),
            duration_ms: 12,
            outcome: RunOutcome::Ok,
            output_name: None,
            outputs: BTreeMap::new(),
            nrc: None,
            error_message: None,
            log_excerpt: Vec::new(),
            operator: None,
            device_id: "dev-1".to_string(),
            app_version: "0.1.0".to_string(),
        }
    }

    fn ids(scan: &RunScan) -> Vec<&str> {
        scan.records.iter().map(|r| r.run_id.as_str()).collect()
    }

    fn all() -> RunQueryFilterDto {
        RunQueryFilterDto::default()
    }

    #[test]
    fn error_wire_format() {
        assert_eq!(
            RunStoreError::Invalid("a".into()).to_ipc_string(),
            "[runstore:invalid] a"
        );
        assert_eq!(
            RunStoreError::TooLarge("b".into()).to_ipc_string(),
            "[runstore:too_large] b"
        );
        assert_eq!(
            RunStoreError::Io("c".into()).to_ipc_string(),
            "[runstore:io] c"
        );
    }

    #[test]
    fn full_record_round_trips_and_matches_ts_shape() {
        let base = tmp_dir("roundtrip");
        let store = RunStore::new(base.join("runs"));
        let mut r = record("run-full", "2026-11-18T10:00:00.123Z");
        r.parent_run_id = None;
        r.queue_id = Some("queue-1".into());
        r.ecu_snapshot_hash = Some("b".repeat(64));
        r.params = BTreeMap::from([
            ("text".to_string(), json!("abc")),
            ("int".to_string(), json!(42)),
            ("float".to_string(), json!(1.5)),
            ("neg".to_string(), json!(-7)),
            ("flag".to_string(), json!(true)),
            ("none".to_string(), json!(null)),
        ]);
        r.files = vec![RunFileRefV1 {
            key: "firmware".into(),
            name: "app.hex".into(),
            size: 123_456,
            crc32: "DEADBEEF".into(),
        }];
        r.ended_at = "2026-11-18T10:00:01.500Z".into();
        r.duration_ms = 1377;
        r.outcome = RunOutcome::PanicStop;
        r.output_name = Some("done".into());
        r.outputs = BTreeMap::from([("vin".to_string(), json!("WVWZZZ1JZXW000001"))]);
        r.nrc = Some(0x31);
        r.error_message = Some("requestOutOfRange".into());
        r.log_excerpt = vec!["TX 22 F1 90".into(), "RX 7F 22 31 ünicode".into()];
        r.operator = Some("tester".into());
        store.append(&r).unwrap();

        let out = store.query(PROJECT, &all(), 10).unwrap();
        assert_eq!(out.records, vec![r.clone()]);
        assert_eq!(out.corrupt_lines, 0);

        // Wire shape: camelCase keys, snake_case outcome, nullable keys present as null.
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["outcome"], "panic_stop");
        assert_eq!(v["schemaVersion"], 1);
        assert!(v["parentRunId"].is_null());
        assert_eq!(v["files"][0]["crc32"], "DEADBEEF");
        assert_eq!(v.as_object().unwrap().len(), 27);
        let back: RunRecordV1 = serde_json::from_value(v).unwrap();
        assert_eq!(back, r);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn duration_ms_is_a_canonical_integer() {
        let base = tmp_dir("duration");
        let store = RunStore::new(base.join("runs"));
        let mut r = record("dur", "2026-11-18T10:00:00Z");
        r.duration_ms = 5;
        let line = serde_json::to_string(&r).unwrap();
        assert!(line.contains(r#""durationMs":5,"#), "{line}");
        assert!(!line.contains("5.0"), "{line}");

        // Stored line on disk is canonical too, and round-trips.
        store.append(&r).unwrap();
        let text = fs::read_to_string(base.join(format!("runs/{PROJECT}/2026-11.jsonl"))).unwrap();
        assert!(text.contains(r#""durationMs":5,"#), "{text}");
        assert_eq!(
            store.query(PROJECT, &all(), 1).unwrap().records,
            vec![r.clone()]
        );

        // Wire input: negative / fractional / non-number rejected at deserialization.
        let mut v = serde_json::to_value(&r).unwrap();
        for bad in [json!(-1), json!(5.5), json!(5.0), json!("5"), json!(null)] {
            v["durationMs"] = bad.clone();
            assert!(
                serde_json::from_value::<RunRecordV1>(v.clone()).is_err(),
                "durationMs {bad} must be rejected"
            );
        }
        // > 2^53 - 1 rejected by validation; the boundary is accepted.
        r.duration_ms = MAX_DURATION_MS + 1;
        assert_eq!(
            store.append(&r).unwrap_err().code(),
            RunStoreErrorCode::Invalid
        );
        r.duration_ms = u64::MAX;
        assert_eq!(
            store.append(&r).unwrap_err().code(),
            RunStoreErrorCode::Invalid
        );
        r.duration_ms = MAX_DURATION_MS;
        store.append(&r).unwrap();
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn append_and_query_newest_first_across_months() {
        let base = tmp_dir("months");
        let store = RunStore::new(base.join("runs"));
        store.append(&record("r1", "2026-10-30T23:59:59Z")).unwrap();
        store.append(&record("r2", "2026-10-31T08:00:00Z")).unwrap();
        store.append(&record("r3", "2026-11-01T00:00:00Z")).unwrap();
        store
            .append(&record("r4", "2026-11-02T09:30:00.5Z"))
            .unwrap();
        assert!(base.join(format!("runs/{PROJECT}/2026-10.jsonl")).is_file());
        assert!(base.join(format!("runs/{PROJECT}/2026-11.jsonl")).is_file());
        let text = fs::read_to_string(base.join(format!("runs/{PROJECT}/2026-10.jsonl"))).unwrap();
        assert_eq!(text.lines().count(), 2);
        assert!(text.ends_with('\n'));

        let out = store.query(PROJECT, &all(), 5000).unwrap();
        assert_eq!(ids(&out), vec!["r4", "r3", "r2", "r1"]);
        // `+00:00` is UTC too; month from startedAt.
        store
            .append(&record("r5", "2026-12-01T00:00:00+00:00"))
            .unwrap();
        assert_eq!(
            ids(&store.query(PROJECT, &all(), 2).unwrap()),
            vec!["r5", "r4"]
        );
        // Unknown project → empty.
        assert!(store
            .query("00000000-0000-0000-0000-000000000000", &all(), 10)
            .unwrap()
            .records
            .is_empty());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn every_filter_and_top_level_only() {
        let base = tmp_dir("filters");
        let store = RunStore::new(base.join("runs"));
        let mut a = record("a", "2026-10-15T10:00:00Z");
        a.queue_id = Some("q1".into());
        let mut b = record("b", "2026-11-01T00:00:00Z");
        b.ecu_id = Some("ecu-b".into());
        b.outcome = RunOutcome::Fail;
        b.queue_id = Some("q1".into());
        let mut c = record("c", "2026-11-10T12:00:00Z");
        c.flow_id = "flash".into();
        c.parent_run_id = Some("b".into());
        c.outcome = RunOutcome::Error;
        let mut d = record("d", "2026-11-20T00:00:00Z");
        d.ecu_id = None;
        d.outcome = RunOutcome::Aborted;
        for r in [&a, &b, &c, &d] {
            store.append(r).unwrap();
        }
        let q = |f: RunQueryFilterDto| ids(&store.query(PROJECT, &f, 100).unwrap()).join(",");

        assert_eq!(q(all()), "d,c,b,a");
        assert_eq!(
            q(RunQueryFilterDto {
                ecu_id: Some("ecu-a".into()),
                ..all()
            }),
            "c,a"
        );
        assert_eq!(
            q(RunQueryFilterDto {
                flow_id: Some("flash".into()),
                ..all()
            }),
            "c"
        );
        assert_eq!(
            q(RunQueryFilterDto {
                queue_id: Some("q1".into()),
                ..all()
            }),
            "b,a"
        );
        assert_eq!(
            q(RunQueryFilterDto {
                outcome: Some(RunOutcome::Fail),
                ..all()
            }),
            "b"
        );
        assert_eq!(
            q(RunQueryFilterDto {
                outcome: Some(RunOutcome::PanicStop),
                ..all()
            }),
            ""
        );
        // since inclusive, until exclusive.
        assert_eq!(
            q(RunQueryFilterDto {
                since: Some("2026-11-01T00:00:00Z".into()),
                ..all()
            }),
            "d,c,b"
        );
        assert_eq!(
            q(RunQueryFilterDto {
                until: Some("2026-11-01T00:00:00Z".into()),
                ..all()
            }),
            "a"
        );
        assert_eq!(
            q(RunQueryFilterDto {
                since: Some("2026-11-01T00:00:00Z".into()),
                until: Some("2026-11-20T00:00:00Z".into()),
                ..all()
            }),
            "c,b"
        );
        // Offsets are normalized: 2026-11-01T01:00+01:00 == 2026-11-01T00:00Z.
        assert_eq!(
            q(RunQueryFilterDto {
                since: Some("2026-11-01T01:00:00+01:00".into()),
                ..all()
            }),
            "d,c,b"
        );
        // since in an earlier month at UTC: 2026-10-31T23:30-01:00 == 2026-11-01T00:30Z.
        assert_eq!(
            q(RunQueryFilterDto {
                since: Some("2026-10-31T23:30:00-01:00".into()),
                ..all()
            }),
            "d,c"
        );
        assert_eq!(
            q(RunQueryFilterDto {
                top_level_only: Some(true),
                ..all()
            }),
            "d,b,a"
        );
        assert_eq!(
            q(RunQueryFilterDto {
                top_level_only: Some(false),
                ..all()
            }),
            "d,c,b,a"
        );
        assert_eq!(
            q(RunQueryFilterDto {
                ecu_id: Some("ecu-a".into()),
                top_level_only: Some(true),
                ..all()
            }),
            "a"
        );

        // Filter DTO wire format: all keys optional, null = no filter.
        let f: RunQueryFilterDto = serde_json::from_str("{}").unwrap();
        assert_eq!(f, all());
        let f: RunQueryFilterDto =
            serde_json::from_str(r#"{"ecuId":null,"outcome":"panic_stop","topLevelOnly":true}"#)
                .unwrap();
        assert_eq!(f.outcome, Some(RunOutcome::PanicStop));
        assert_eq!(f.top_level_only, Some(true));

        // Malformed bounds.
        let err = store
            .query(
                PROJECT,
                &RunQueryFilterDto {
                    since: Some("yesterday".into()),
                    ..all()
                },
                1,
            )
            .unwrap_err();
        assert_eq!(err.code(), RunStoreErrorCode::Invalid);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn limit_bounds() {
        let base = tmp_dir("limit");
        let store = RunStore::new(base.join("runs"));
        for i in 0..5 {
            store
                .append(&record(
                    &format!("r{i}"),
                    &format!("2026-11-0{}T00:00:00Z", i + 1),
                ))
                .unwrap();
        }
        for bad in [0, 5001, u32::MAX] {
            let err = store.query(PROJECT, &all(), bad).unwrap_err();
            assert_eq!(err.code(), RunStoreErrorCode::Invalid, "{bad}");
        }
        assert_eq!(ids(&store.query(PROJECT, &all(), 1).unwrap()), vec!["r4"]);
        assert_eq!(store.query(PROJECT, &all(), 3).unwrap().records.len(), 3);
        assert_eq!(store.query(PROJECT, &all(), 5000).unwrap().records.len(), 5);
        assert_eq!(
            store.query("../etc", &all(), 1).unwrap_err().code(),
            RunStoreErrorCode::Invalid
        );
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn corrupt_lines_are_skipped_and_counted() {
        let base = tmp_dir("corrupt");
        let store = RunStore::new(base.join("runs"));
        store.append(&record("r1", "2026-11-01T00:00:00Z")).unwrap();
        let path = base.join(format!("runs/{PROJECT}/2026-11.jsonl"));
        {
            let mut f = OpenOptions::new().append(true).open(&path).unwrap();
            f.write_all(b"{ not json\n\n").unwrap();
            f.write_all(br#"{"schemaVersion":1,"runId":"x"}"#).unwrap();
            f.write_all(b"\n").unwrap();
            // Over-long line without a newline in the middle.
            f.write_all(&vec![b'x'; MAX_SCANNED_LINE_BYTES + 3 * READ_BLOCK])
                .unwrap();
            f.write_all(b"\n").unwrap();
            // Torn tail: no trailing newline.
            f.write_all(br#"{"schemaVersion":1,"ru"#).unwrap();
        }
        // The next append starts on a fresh line, so it is not glued to the torn tail.
        store.append(&record("r2", "2026-11-02T00:00:00Z")).unwrap();
        let out = store.query(PROJECT, &all(), 100).unwrap();
        assert_eq!(ids(&out), vec!["r2", "r1"]);
        assert_eq!(out.corrupt_lines, 4);
        let latest = store.latest(PROJECT).unwrap();
        assert_eq!(ids(&latest), vec!["r2"]);
        assert_eq!(latest.corrupt_lines, 4);

        // CRLF line endings are tolerated.
        let crlf = base.join(format!("runs/{PROJECT}/2026-09.jsonl"));
        let mut line = serde_json::to_vec(&record("r0", "2026-09-01T00:00:00Z")).unwrap();
        line.extend_from_slice(b"\r\n");
        fs::write(&crlf, line).unwrap();
        assert_eq!(
            ids(&store.query(PROJECT, &all(), 100).unwrap()),
            vec!["r2", "r1", "r0"]
        );
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn latest_per_ecu_and_flow_including_null_ecu() {
        let base = tmp_dir("latest");
        let store = RunStore::new(base.join("runs"));
        let mk = |id: &str, ts: &str, ecu: Option<&str>, flow: &str, parent: Option<&str>| {
            let mut r = record(id, ts);
            r.ecu_id = ecu.map(str::to_string);
            r.flow_id = flow.to_string();
            r.parent_run_id = parent.map(str::to_string);
            r
        };
        for r in [
            mk("a1", "2026-10-01T00:00:00Z", Some("ecu-a"), "f1", None),
            mk("n1", "2026-10-02T00:00:00Z", None, "f1", None),
            mk("a2", "2026-11-01T00:00:00Z", Some("ecu-a"), "f1", None),
            mk("b1", "2026-11-02T00:00:00Z", Some("ecu-b"), "f1", None),
            mk("a3", "2026-11-03T00:00:00Z", Some("ecu-a"), "f2", None),
            // Child frames never count, even when newer.
            mk(
                "c1",
                "2026-11-04T00:00:00Z",
                Some("ecu-a"),
                "f1",
                Some("a2"),
            ),
            mk("c2", "2026-11-05T00:00:00Z", None, "f9", Some("a2")),
        ] {
            store.append(&r).unwrap();
        }
        let out = store.latest(PROJECT).unwrap();
        assert_eq!(ids(&out), vec!["a3", "b1", "a2", "n1"]);
        assert!(store.latest("bad/id").is_err());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn oversize_record_is_rejected() {
        let base = tmp_dir("oversize");
        let store = RunStore::new(base.join("runs"));
        let mut r = record("big", "2026-11-01T00:00:00Z");
        r.error_message = Some("x".repeat(MAX_RUN_RECORD_BYTES));
        let err = store.append(&r).unwrap_err();
        assert_eq!(err.code(), RunStoreErrorCode::TooLarge);
        assert!(err.to_ipc_string().starts_with("[runstore:too_large] "));
        assert!(!base.join(format!("runs/{PROJECT}")).exists());

        // logExcerpt limits.
        let mut r = record("log", "2026-11-01T00:00:00Z");
        r.log_excerpt = vec!["l".into(); MAX_LOG_EXCERPT_LINES + 1];
        assert_eq!(
            store.append(&r).unwrap_err().code(),
            RunStoreErrorCode::Invalid
        );
        r.log_excerpt = vec!["ü".repeat(MAX_LOG_EXCERPT_LINE_CHARS + 1)];
        assert_eq!(
            store.append(&r).unwrap_err().code(),
            RunStoreErrorCode::Invalid
        );
        r.log_excerpt = vec!["ü".repeat(MAX_LOG_EXCERPT_LINE_CHARS); MAX_LOG_EXCERPT_LINES];
        store.append(&r).unwrap();
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn invalid_ids_timestamps_and_values_are_rejected() {
        let base = tmp_dir("invalid");
        let store = RunStore::new(base.join("runs"));
        let ok = record("ok", "2026-11-01T00:00:00Z");
        let check = |r: RunRecordV1, what: &str| {
            let err = store.append(&r).unwrap_err();
            assert_eq!(err.code(), RunStoreErrorCode::Invalid, "{what}: {err}");
            assert!(err.to_ipc_string().starts_with("[runstore:invalid] "));
        };
        let long = "a".repeat(65);
        for bad in ["", "../x", "a/b", "a_b", "a.b", "a b", &long] {
            check(
                RunRecordV1 {
                    run_id: bad.into(),
                    ..ok.clone()
                },
                "runId",
            );
            check(
                RunRecordV1 {
                    project_id: bad.into(),
                    ..ok.clone()
                },
                "projectId",
            );
            check(
                RunRecordV1 {
                    parent_run_id: Some(bad.into()),
                    ..ok.clone()
                },
                "parent",
            );
            check(
                RunRecordV1 {
                    queue_id: Some(bad.into()),
                    ..ok.clone()
                },
                "queue",
            );
            check(
                RunRecordV1 {
                    vehicle_id: Some(bad.into()),
                    ..ok.clone()
                },
                "vehicle",
            );
            check(
                RunRecordV1 {
                    ecu_id: Some(bad.into()),
                    ..ok.clone()
                },
                "ecu",
            );
        }
        for bad in [
            "",
            "2026-11-01",
            "2026-11-01 00:00:00Z",
            "2026-11-01T00:00:00",
            "2026-11-01T00:00:00+02:00",
            "2026-11-01T00:00:00.Z",
            "2026-11-01T00:00:00.1234567890Z",
            "2026-13-01T00:00:00Z",
            "2026-02-29T00:00:00Z",
            "2026-04-31T00:00:00Z",
            "2026-11-01T24:00:00Z",
            "2026-11-01T00:60:00Z",
            "2026-11-01T00:00:60Z",
            "2026-11-01T00:00:00z",
            "2026-11-01T00:00:00Zjunk",
            "+2026-11-01T00:00:00Z",
        ] {
            check(
                RunRecordV1 {
                    started_at: bad.into(),
                    ..ok.clone()
                },
                bad,
            );
            check(
                RunRecordV1 {
                    ended_at: bad.into(),
                    ..ok.clone()
                },
                bad,
            );
        }
        store
            .append(&RunRecordV1 {
                started_at: "2028-02-29T23:59:59.999999999Z".into(),
                ..ok.clone()
            })
            .unwrap();
        check(
            RunRecordV1 {
                schema_version: 2,
                ..ok.clone()
            },
            "schema",
        );
        check(
            RunRecordV1 {
                duration_ms: MAX_DURATION_MS + 1,
                ..ok.clone()
            },
            "duration",
        );
        check(
            RunRecordV1 {
                flow_id: String::new(),
                ..ok.clone()
            },
            "flowId",
        );
        let mut r = ok.clone();
        r.params.insert("arr".into(), json!([1]));
        check(r, "params array");
        let mut r = ok.clone();
        r.outputs.insert("obj".into(), json!({"a":1}));
        check(r, "outputs object");
        for crc in ["DEADBEE", "DEADBEEF0", "XYZ12345", ""] {
            let mut r = ok.clone();
            r.files.push(RunFileRefV1 {
                key: "fw".into(),
                name: "a.bin".into(),
                size: 1,
                crc32: crc.into(),
            });
            check(r, crc);
        }
        // Unknown outcome / wrong types fail deserialization (IPC layer).
        let mut v = serde_json::to_value(&ok).unwrap();
        v["outcome"] = json!("crashed");
        assert!(serde_json::from_value::<RunRecordV1>(v).is_err());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn rfc3339_parser_and_civil_conversions() {
        let (t, off) = parse_rfc3339("1970-01-01T00:00:00Z").unwrap();
        assert_eq!((t.secs, t.nanos, off), (0, 0, 0));
        let (t, _) = parse_rfc3339("2000-03-01T00:00:00.5Z").unwrap();
        assert_eq!((t.secs, t.nanos), (951_868_800, 500_000_000));
        let (t, off) = parse_rfc3339("2026-11-18T12:00:00+03:00").unwrap();
        assert_eq!(off, 180);
        assert_eq!(t, parse_rfc3339("2026-11-18T09:00:00Z").unwrap().0);
        assert_eq!(t.month_key(), "2026-11");
        assert_eq!(
            parse_rfc3339("2026-12-01T00:30:00+01:00")
                .unwrap()
                .0
                .month_key(),
            "2026-11"
        );
        for days in [-1_000_000i64, -1, 0, 59, 60, 10_957, 20_775, 2_932_896] {
            let (y, m, d) = civil_from_days(days);
            assert_eq!(days_from_civil(y, m, d), days);
        }
        assert!(is_month_key("2026-01"));
        assert!(!is_month_key("2026-13"));
        assert!(!is_month_key("2026-1"));
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_project_directory_is_refused() {
        let base = tmp_dir("symlink");
        let store = RunStore::new(base.join("runs"));
        fs::create_dir_all(base.join("runs")).unwrap();
        fs::create_dir_all(base.join("outside")).unwrap();
        std::os::unix::fs::symlink(base.join("outside"), base.join(format!("runs/{PROJECT}")))
            .unwrap();
        let err = store
            .append(&record("r1", "2026-11-01T00:00:00Z"))
            .unwrap_err();
        assert_eq!(err.code(), RunStoreErrorCode::Io);
        assert!(store.query(PROJECT, &all(), 1).is_err());
        assert_eq!(fs::read_dir(base.join("outside")).unwrap().count(), 0);
        let _ = fs::remove_dir_all(&base);
    }
}
