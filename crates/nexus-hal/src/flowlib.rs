//! Diagnostics Workspace flow library (contract `planning/contracts/diag-workspace-v1.md` §9).
//!
//! Rust mirror of the frozen TS contract `src/types/flowLibrary.ts` (`FlowLibEntryDto`,
//! `FlowLibRevisionDto`, `NxFlowFileV1` envelope header). IPC fields are camelCase.
//!
//! On-disk layout under the data root:
//!
//! ```text
//! <data_root>/flowlib/index.json              cache (rebuilt from revision files when missing / corrupt)
//! <data_root>/flowlib/<id>/r<revision>.json   immutable revision files (raw `fileJson` bytes as saved)
//! <data_root>/flowlib/<id>/deleted            soft-delete marker (mirrors the index flag, survives a rebuild)
//! ```
//!
//! Invariants:
//! - A revision file is created with create-new semantics (temp file + `hard_link`, which fails
//!   when the target exists) and is never overwritten or deleted.
//! - `revision` of a save must be `latest + 1` (first save = 1), else `[flowlib:conflict]`.
//! - The `kind` of an id never changes between revisions.
//! - Soft-deleted ids stay loadable (pinned `FlowRefV1` references keep working); saving a new
//!   revision of a deleted id un-deletes it.
//! - All operations are serialized by the [`FlowLibrary`] mutex.

use crate::storage::{
    create_private_dir_all, is_regular_file, read_regular_file, write_regular_file_atomic,
};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use thiserror::Error;

/// Max size of one flow / custom block file (`fileJson`).
pub const MAX_FLOW_FILE_BYTES: usize = 2 * 1024 * 1024;

/// Max length of `flow.name` in characters.
pub const MAX_FLOW_NAME_CHARS: usize = 200;

/// Max length of a library id (`[A-Za-z0-9_-]{1,64}`).
pub const MAX_FLOW_ID_LEN: usize = 64;

/// Max size of `index.json` read from disk (larger = treated as corrupt and rebuilt).
const MAX_INDEX_FILE_BYTES: u64 = 64 * 1024 * 1024;

/// Max number of library ids / revisions per id considered during an index rebuild.
const MAX_SCAN_ENTRIES: usize = 100_000;

const INDEX_FILE_NAME: &str = "index.json";
const DELETED_MARKER: &str = "deleted";
const INDEX_SCHEMA_VERSION: u32 = 1;

// ─── Errors ─────────────────────────────────────────────────────────────────

/// Wire codes of [`FlowLibError`] (`FlowLibErrorCode` in the TS contract).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FlowLibErrorCode {
    Invalid,
    Conflict,
    NotFound,
    TooLarge,
    Io,
}

impl FlowLibErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Invalid => "invalid",
            Self::Conflict => "conflict",
            Self::NotFound => "not_found",
            Self::TooLarge => "too_large",
            Self::Io => "io",
        }
    }
}

/// Flow library error; reaches the HMI as `"[flowlib:<code>] <message>"`
/// ([`FlowLibError::to_ipc_string`], parsed by `parseFlowLibError`).
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum FlowLibError {
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    Conflict(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    TooLarge(String),
    #[error("{0}")]
    Io(String),
}

impl FlowLibError {
    pub fn code(&self) -> FlowLibErrorCode {
        match self {
            Self::Invalid(_) => FlowLibErrorCode::Invalid,
            Self::Conflict(_) => FlowLibErrorCode::Conflict,
            Self::NotFound(_) => FlowLibErrorCode::NotFound,
            Self::TooLarge(_) => FlowLibErrorCode::TooLarge,
            Self::Io(_) => FlowLibErrorCode::Io,
        }
    }

    /// `"[flowlib:<code>] <message>"`.
    pub fn to_ipc_string(&self) -> String {
        format!("[flowlib:{}] {}", self.code().as_str(), self)
    }
}

fn io_error(context: &str, e: impl std::fmt::Display) -> FlowLibError {
    FlowLibError::Io(format!("{context}: {e}"))
}

// ─── DTOs (mirror src/types/flowLibrary.ts) ─────────────────────────────────

/// `FlowLibKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum FlowLibKind {
    #[serde(rename = "nexuscan.flow")]
    Flow,
    #[serde(rename = "nexuscan.block")]
    Block,
}

impl FlowLibKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Flow => "nexuscan.flow",
            Self::Block => "nexuscan.block",
        }
    }

    fn parse(raw: &str) -> Option<Self> {
        match raw {
            "nexuscan.flow" => Some(Self::Flow),
            "nexuscan.block" => Some(Self::Block),
            _ => None,
        }
    }
}

/// `FlowOrigin`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FlowOrigin {
    User,
    Template,
    Ai,
    Import,
}

/// `FlowLibEntryDto`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowLibEntryDto {
    pub id: String,
    pub kind: FlowLibKind,
    pub name: String,
    pub latest_revision: u32,
    pub updated_at: String,
    pub origin: FlowOrigin,
    pub ai_reviewed: bool,
    pub content_hash: String,
    pub tags: Vec<String>,
    pub deleted: bool,
}

/// `FlowLibRevisionDto`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowLibRevisionDto {
    pub revision: u32,
    pub updated_at: String,
    pub content_hash: String,
}

/// Parsed header of an `NxFlowFileV1` envelope. Only the fields the library needs are typed;
/// every other field (`blocks`, `connections`, future additions) is ignored (forward compat).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowFileHeader {
    pub schema_version: u64,
    pub kind: String,
    pub flow: FlowBodyHeader,
    pub content_hash: String,
}

/// Header fields of `NxFlowBodyV1`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowBodyHeader {
    pub id: String,
    pub revision: u64,
    pub name: String,
    pub updated_at: String,
    pub origin: FlowOrigin,
    pub ai_reviewed: bool,
    pub tags: Vec<String>,
}

/// Envelope header after validation.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ValidatedHeader {
    id: String,
    kind: FlowLibKind,
    revision: u32,
    name: String,
    updated_at: String,
    origin: FlowOrigin,
    ai_reviewed: bool,
    tags: Vec<String>,
    content_hash: String,
}

impl ValidatedHeader {
    fn to_entry(&self, deleted: bool) -> FlowLibEntryDto {
        FlowLibEntryDto {
            id: self.id.clone(),
            kind: self.kind,
            name: self.name.clone(),
            latest_revision: self.revision,
            updated_at: self.updated_at.clone(),
            origin: self.origin,
            ai_reviewed: self.ai_reviewed,
            content_hash: self.content_hash.clone(),
            tags: self.tags.clone(),
            deleted,
        }
    }

    fn to_revision(&self) -> FlowLibRevisionDto {
        FlowLibRevisionDto {
            revision: self.revision,
            updated_at: self.updated_at.clone(),
            content_hash: self.content_hash.clone(),
        }
    }
}

// ─── Validation ─────────────────────────────────────────────────────────────

/// `true` for `[A-Za-z0-9_-]{1,64}` (never path-like: no `.`, separators or control chars).
pub fn is_valid_flow_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_FLOW_ID_LEN
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn check_id(id: &str) -> Result<(), FlowLibError> {
    if is_valid_flow_id(id) {
        Ok(())
    } else {
        Err(FlowLibError::Invalid(format!(
            "invalid flow id '{}': expected [A-Za-z0-9_-]{{1,64}}",
            id.escape_debug()
        )))
    }
}

fn is_hex_sha256(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Parses and validates the envelope header of `file_json`.
fn parse_header(file_json: &str) -> Result<ValidatedHeader, FlowLibError> {
    let raw: FlowFileHeader = serde_json::from_str(file_json)
        .map_err(|e| FlowLibError::Invalid(format!("invalid flow file envelope: {e}")))?;
    validate_header(raw)
}

fn validate_header(raw: FlowFileHeader) -> Result<ValidatedHeader, FlowLibError> {
    if raw.schema_version != 1 {
        return Err(FlowLibError::Invalid(format!(
            "unsupported schemaVersion {} (expected 1)",
            raw.schema_version
        )));
    }
    let kind = FlowLibKind::parse(&raw.kind).ok_or_else(|| {
        FlowLibError::Invalid(format!(
            "invalid kind '{}': expected 'nexuscan.flow' or 'nexuscan.block'",
            raw.kind.escape_debug()
        ))
    })?;
    check_id(&raw.flow.id)?;
    let revision = u32::try_from(raw.flow.revision)
        .ok()
        .filter(|r| *r >= 1)
        .ok_or_else(|| {
            FlowLibError::Invalid(format!(
                "invalid revision {}: expected an integer >= 1",
                raw.flow.revision
            ))
        })?;
    if raw.flow.name.trim().is_empty() {
        return Err(FlowLibError::Invalid("flow name is empty".to_string()));
    }
    let name_chars = raw.flow.name.chars().count();
    if name_chars > MAX_FLOW_NAME_CHARS {
        return Err(FlowLibError::Invalid(format!(
            "flow name is too long: {name_chars} characters (limit {MAX_FLOW_NAME_CHARS})"
        )));
    }
    if !is_hex_sha256(&raw.content_hash) {
        return Err(FlowLibError::Invalid(
            "contentHash must be 64 hex characters (sha-256)".to_string(),
        ));
    }
    Ok(ValidatedHeader {
        id: raw.flow.id,
        kind,
        revision,
        name: raw.flow.name,
        updated_at: raw.flow.updated_at,
        origin: raw.flow.origin,
        ai_reviewed: raw.flow.ai_reviewed,
        tags: raw.flow.tags,
        content_hash: raw.content_hash,
    })
}

// ─── Index ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IndexEntry {
    entry: FlowLibEntryDto,
    /// Ascending by `revision`.
    revisions: Vec<FlowLibRevisionDto>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FlowLibIndex {
    schema_version: u32,
    /// Keyed by library id.
    entries: BTreeMap<String, IndexEntry>,
}

impl FlowLibIndex {
    fn empty() -> Self {
        Self {
            schema_version: INDEX_SCHEMA_VERSION,
            entries: BTreeMap::new(),
        }
    }

    /// Structural sanity check of an index read from disk.
    fn is_consistent(&self) -> bool {
        self.schema_version == INDEX_SCHEMA_VERSION
            && self.entries.iter().all(|(id, e)| {
                is_valid_flow_id(id)
                    && e.entry.id == *id
                    && e.revisions.last().map(|r| r.revision) == Some(e.entry.latest_revision)
                    && e.revisions
                        .windows(2)
                        .all(|w| w[0].revision < w[1].revision)
            })
    }
}

// ─── Library ────────────────────────────────────────────────────────────────

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Flow library rooted at `<data_root>/flowlib`. All operations take the internal mutex.
#[derive(Debug)]
pub struct FlowLibrary {
    dir: PathBuf,
    lock: Mutex<()>,
}

impl FlowLibrary {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self {
            dir: dir.into(),
            lock: Mutex::new(()),
        }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// `cmd_flowlib_list`: entries sorted by name (case-insensitive), then id.
    pub fn list(&self, include_deleted: bool) -> Result<Vec<FlowLibEntryDto>, FlowLibError> {
        let _guard = self.lock.lock();
        let index = self.load_index()?;
        let mut out: Vec<FlowLibEntryDto> = index
            .entries
            .into_values()
            .filter(|e| include_deleted || !e.entry.deleted)
            .map(|e| e.entry)
            .collect();
        out.sort_by(|a, b| {
            a.name
                .to_lowercase()
                .cmp(&b.name.to_lowercase())
                .then_with(|| a.id.cmp(&b.id))
        });
        Ok(out)
    }

    /// `cmd_flowlib_revisions`: ascending by revision (deleted ids included).
    pub fn revisions(&self, id: &str) -> Result<Vec<FlowLibRevisionDto>, FlowLibError> {
        check_id(id)?;
        let _guard = self.lock.lock();
        let mut index = self.load_index()?;
        index
            .entries
            .remove(id)
            .map(|e| e.revisions)
            .ok_or_else(|| not_found_id(id))
    }

    /// `cmd_flowlib_load`: raw file JSON of `revision` (`None` = latest). Soft-deleted ids are
    /// still loadable so pinned references keep working.
    pub fn load(&self, id: &str, revision: Option<u32>) -> Result<String, FlowLibError> {
        check_id(id)?;
        let _guard = self.lock.lock();
        let revision = match revision {
            Some(r) => r,
            None => {
                let index = self.load_index()?;
                index
                    .entries
                    .get(id)
                    .map(|e| e.entry.latest_revision)
                    .ok_or_else(|| not_found_id(id))?
            }
        };
        let path = self.revision_path(id, revision);
        if !is_regular_file(&path) {
            return Err(FlowLibError::NotFound(format!(
                "flow '{id}' revision {revision} not found"
            )));
        }
        let bytes = read_regular_file(&path, MAX_FLOW_FILE_BYTES as u64)
            .map_err(|e| io_error(&format!("read flow '{id}' revision {revision}"), e))?;
        String::from_utf8(bytes).map_err(|_| {
            FlowLibError::Io(format!(
                "flow '{id}' revision {revision} is not valid UTF-8"
            ))
        })
    }

    /// `cmd_flowlib_save`: validates the envelope, writes `r<revision>.json` (create-new, raw
    /// bytes as received) and updates the index atomically.
    pub fn save(&self, file_json: &str) -> Result<FlowLibEntryDto, FlowLibError> {
        if file_json.len() > MAX_FLOW_FILE_BYTES {
            return Err(FlowLibError::TooLarge(format!(
                "flow file is too large: {} bytes (limit {MAX_FLOW_FILE_BYTES} bytes)",
                file_json.len()
            )));
        }
        let header = parse_header(file_json)?;
        let id = header.id.clone();

        let _guard = self.lock.lock();
        let mut index = self.load_index()?;

        // The index is a cache: if it disagrees with the revision files of this id (e.g. a
        // crash between revision write and index write), rebuild it from disk first.
        let disk_latest = self.disk_latest_revision(&id)?;
        let indexed_latest = index.entries.get(&id).map(|e| e.entry.latest_revision);
        if disk_latest != indexed_latest {
            eprintln!(
                "[flowlib] warning: index out of date for '{id}' (index {indexed_latest:?}, disk {disk_latest:?}); rebuilding"
            );
            index = self.rebuild_index()?;
        }

        let latest = disk_latest.unwrap_or(0);
        if let Some(existing) = index.entries.get(&id) {
            if existing.entry.kind != header.kind {
                return Err(FlowLibError::Invalid(format!(
                    "kind of '{id}' cannot change from '{}' to '{}'",
                    existing.entry.kind.as_str(),
                    header.kind.as_str()
                )));
            }
        }
        let expected = latest.checked_add(1).ok_or_else(|| {
            FlowLibError::Conflict(format!("flow '{id}' has reached the maximum revision"))
        })?;
        if header.revision != expected {
            return Err(FlowLibError::Conflict(format!(
                "flow '{id}': revision {} does not follow latest revision {latest} (expected {expected})",
                header.revision
            )));
        }

        let id_dir = self.ensure_id_dir(&id)?;
        create_new_file_atomic(
            &id_dir,
            &revision_file_name(header.revision),
            file_json.as_bytes(),
        )
        .map_err(|e| {
            if e.kind() == io::ErrorKind::AlreadyExists {
                FlowLibError::Conflict(format!(
                    "flow '{id}' revision {} already exists",
                    header.revision
                ))
            } else {
                io_error(
                    &format!("write flow '{id}' revision {}", header.revision),
                    e,
                )
            }
        })?;

        // Saving un-deletes the id.
        let marker = id_dir.join(DELETED_MARKER);
        if is_regular_file(&marker) {
            if let Err(e) = fs::remove_file(&marker) {
                eprintln!("[flowlib] warning: could not remove delete marker of '{id}': {e}");
            }
        }

        let entry = header.to_entry(false);
        let slot = index
            .entries
            .entry(id.clone())
            .or_insert_with(|| IndexEntry {
                entry: entry.clone(),
                revisions: Vec::new(),
            });
        slot.entry = entry.clone();
        slot.revisions.push(header.to_revision());

        // The revision is durable at this point; an index write failure must not report the
        // save as failed (a retry would conflict). Drop the stale index so it is rebuilt.
        if let Err(e) = self.write_index(&index) {
            eprintln!("[flowlib] warning: index update failed after saving '{id}': {e}");
            let _ = fs::remove_file(self.index_path());
        }
        Ok(entry)
    }

    /// `cmd_flowlib_delete`: soft delete (index flag + marker file). Idempotent for an already
    /// deleted id; `not_found` for an unknown id.
    pub fn delete(&self, id: &str) -> Result<(), FlowLibError> {
        check_id(id)?;
        let _guard = self.lock.lock();
        let mut index = self.load_index()?;
        let Some(slot) = index.entries.get_mut(id) else {
            return Err(not_found_id(id));
        };
        slot.entry.deleted = true;
        let id_dir = self.ensure_id_dir(id)?;
        let marker = id_dir.join(DELETED_MARKER);
        if !is_regular_file(&marker) {
            write_regular_file_atomic(&marker, b"")
                .map_err(|e| io_error(&format!("mark flow '{id}' deleted"), e))?;
        }
        self.write_index(&index)
    }

    // ─── internals ──────────────────────────────────────────────────────────

    fn index_path(&self) -> PathBuf {
        self.dir.join(INDEX_FILE_NAME)
    }

    fn revision_path(&self, id: &str, revision: u32) -> PathBuf {
        self.dir.join(id).join(revision_file_name(revision))
    }

    fn ensure_root(&self) -> Result<(), FlowLibError> {
        create_private_dir_all(&self.dir).map_err(|e| io_error("create flow library directory", e))
    }

    /// Creates `<dir>/<id>` (refusing a symlink or non-directory in its place).
    fn ensure_id_dir(&self, id: &str) -> Result<PathBuf, FlowLibError> {
        self.ensure_root()?;
        let path = self.dir.join(id);
        match fs::symlink_metadata(&path) {
            Ok(m) if m.file_type().is_symlink() => Err(FlowLibError::Io(format!(
                "refusing to follow symbolic link for flow '{id}'"
            ))),
            Ok(m) if !m.is_dir() => Err(FlowLibError::Io(format!(
                "flow library entry '{id}' is not a directory"
            ))),
            Ok(_) => Ok(path),
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                create_private_dir_all(&path)
                    .map_err(|e| io_error(&format!("create directory of flow '{id}'"), e))?;
                Ok(path)
            }
            Err(e) => Err(io_error(&format!("stat flow '{id}'"), e)),
        }
    }

    /// Real (non-symlink) directory of `id`, if present.
    fn id_dir_if_exists(&self, id: &str) -> Option<PathBuf> {
        let path = self.dir.join(id);
        match fs::symlink_metadata(&path) {
            Ok(m) if m.is_dir() && !m.file_type().is_symlink() => Some(path),
            _ => None,
        }
    }

    /// Revision numbers present on disk for `id` (by canonical file name `r<N>.json`, N >= 1).
    fn disk_revision_numbers(&self, id: &str) -> Result<Vec<u32>, FlowLibError> {
        let Some(dir) = self.id_dir_if_exists(id) else {
            return Ok(Vec::new());
        };
        let rd = fs::read_dir(&dir).map_err(|e| io_error(&format!("list flow '{id}'"), e))?;
        let mut out = Vec::new();
        for entry in rd.flatten().take(MAX_SCAN_ENTRIES) {
            match entry.file_type() {
                Ok(ft) if ft.is_file() => {}
                _ => continue,
            }
            if let Some(n) = parse_revision_file_name(&entry.file_name().to_string_lossy()) {
                out.push(n);
            }
        }
        out.sort_unstable();
        Ok(out)
    }

    fn disk_latest_revision(&self, id: &str) -> Result<Option<u32>, FlowLibError> {
        Ok(self.disk_revision_numbers(id)?.last().copied())
    }

    /// Reads the index; rebuilds (and persists, best effort) when missing or corrupt.
    fn load_index(&self) -> Result<FlowLibIndex, FlowLibError> {
        self.ensure_root()?;
        let path = self.index_path();
        if is_regular_file(&path) {
            match read_regular_file(&path, MAX_INDEX_FILE_BYTES) {
                Ok(bytes) => match serde_json::from_slice::<FlowLibIndex>(&bytes) {
                    Ok(index) if index.is_consistent() => return Ok(index),
                    Ok(_) => {
                        eprintln!("[flowlib] warning: index.json is inconsistent; rebuilding")
                    }
                    Err(e) => {
                        eprintln!("[flowlib] warning: index.json is corrupt ({e}); rebuilding")
                    }
                },
                Err(e) => eprintln!("[flowlib] warning: index.json unreadable ({e}); rebuilding"),
            }
        } else if fs::symlink_metadata(&path).is_ok() {
            eprintln!("[flowlib] warning: index.json is not a regular file; rebuilding");
        }
        self.rebuild_index()
    }

    /// Scans every `<id>/r<N>.json`; unparsable or mismatching files are skipped with a
    /// warning. Persists the result (best effort).
    fn rebuild_index(&self) -> Result<FlowLibIndex, FlowLibError> {
        self.ensure_root()?;
        let mut index = FlowLibIndex::empty();
        let rd = fs::read_dir(&self.dir).map_err(|e| io_error("list flow library", e))?;
        for dir_entry in rd.flatten().take(MAX_SCAN_ENTRIES) {
            match dir_entry.file_type() {
                Ok(ft) if ft.is_dir() => {}
                _ => continue,
            }
            let id = dir_entry.file_name().to_string_lossy().into_owned();
            if !is_valid_flow_id(&id) {
                continue;
            }
            if let Some(slot) = self.scan_id(&id)? {
                index.entries.insert(id, slot);
            }
        }
        if let Err(e) = self.write_index(&index) {
            eprintln!("[flowlib] warning: could not persist rebuilt index: {e}");
        }
        Ok(index)
    }

    fn scan_id(&self, id: &str) -> Result<Option<IndexEntry>, FlowLibError> {
        let mut valid: Vec<ValidatedHeader> = Vec::new();
        for n in self.disk_revision_numbers(id)? {
            let path = self.revision_path(id, n);
            let header = read_regular_file(&path, MAX_FLOW_FILE_BYTES as u64)
                .map_err(|e| e.to_string())
                .and_then(|b| String::from_utf8(b).map_err(|_| "not valid UTF-8".to_string()))
                .and_then(|s| parse_header(&s).map_err(|e| e.to_string()));
            match header {
                Ok(h) if h.id == id && h.revision == n => {
                    if valid.first().is_some_and(|first| first.kind != h.kind) {
                        eprintln!(
                            "[flowlib] warning: skipping {id}/{}: kind differs from earlier revisions",
                            revision_file_name(n)
                        );
                        continue;
                    }
                    valid.push(h);
                }
                Ok(h) => eprintln!(
                    "[flowlib] warning: skipping {id}/{}: header names '{}' revision {}",
                    revision_file_name(n),
                    h.id,
                    h.revision
                ),
                Err(e) => eprintln!(
                    "[flowlib] warning: skipping unparsable {id}/{}: {e}",
                    revision_file_name(n)
                ),
            }
        }
        let Some(latest) = valid.last() else {
            return Ok(None);
        };
        let deleted = self
            .id_dir_if_exists(id)
            .is_some_and(|d| is_regular_file(&d.join(DELETED_MARKER)));
        Ok(Some(IndexEntry {
            entry: latest.to_entry(deleted),
            revisions: valid.iter().map(ValidatedHeader::to_revision).collect(),
        }))
    }

    fn write_index(&self, index: &FlowLibIndex) -> Result<(), FlowLibError> {
        let bytes = serde_json::to_vec_pretty(index)
            .map_err(|e| io_error("serialize flow library index", e))?;
        write_regular_file_atomic(&self.index_path(), &bytes)
            .map_err(|e| io_error("write flow library index", e))
    }
}

fn not_found_id(id: &str) -> FlowLibError {
    FlowLibError::NotFound(format!("flow '{id}' not found"))
}

fn revision_file_name(revision: u32) -> String {
    format!("r{revision}.json")
}

/// `r<N>.json` with canonical decimal `N >= 1` (no sign, no leading zeros).
fn parse_revision_file_name(name: &str) -> Option<u32> {
    let digits = name.strip_prefix('r')?.strip_suffix(".json")?;
    if digits.is_empty() || digits.starts_with('0') || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse::<u32>().ok()
}

/// Writes `bytes` to a `create_new` temp file in `dir`, syncs it, then hard-links it to
/// `dir/name` (fails with `AlreadyExists` when the target exists: never overwrites) and removes
/// the temp file. Falls back to a direct `create_new` write when the filesystem does not
/// support hard links.
fn create_new_file_atomic(dir: &Path, name: &str, bytes: &[u8]) -> io::Result<()> {
    let target = dir.join(name);
    if fs::symlink_metadata(&target).is_ok() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!("'{name}' already exists"),
        ));
    }
    let tmp = dir.join(format!(
        ".{name}.{}.{}.tmp",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let write_new = |path: &Path| -> io::Result<()> {
        let mut opts = OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(path)?;
        f.write_all(bytes)?;
        f.sync_all()
    };
    if let Err(e) = write_new(&tmp) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    let linked = fs::hard_link(&tmp, &target);
    let _ = fs::remove_file(&tmp);
    match linked {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => Err(e),
        // FAT / some network filesystems: no hard links. `create_new` still never overwrites.
        Err(_) => write_new(&target).inspect_err(|e| {
            if e.kind() != io::ErrorKind::AlreadyExists {
                let _ = fs::remove_file(&target);
            }
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tmp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "nexuscan-flowlib-{tag}-{}-{}",
            std::process::id(),
            nexus_core::now_monotonic_us()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn hash(c: char) -> String {
        c.to_string().repeat(64)
    }

    fn file_json(id: &str, kind: &str, revision: u64, name: &str) -> String {
        json!({
            "schemaVersion": 1,
            "kind": kind,
            "flow": {
                "id": id,
                "revision": revision,
                "name": name,
                "description": "",
                "createdAt": "2026-11-18T10:00:00.000Z",
                "updatedAt": format!("2026-11-18T10:00:{:02}.000Z", revision % 60),
                "author": null,
                "origin": "user",
                "aiReviewed": false,
                "tags": ["uds"],
                "blocks": [],
                "connections": [],
                "futureField": { "x": 1 }
            },
            "contentHash": hash(char::from(b'a' + (revision % 6) as u8)),
            "envelopeExtra": true
        })
        .to_string()
    }

    fn flow(id: &str, revision: u64) -> String {
        file_json(id, "nexuscan.flow", revision, &format!("Flow {id}"))
    }

    #[test]
    fn error_wire_format() {
        assert_eq!(
            FlowLibError::Conflict("x".into()).to_ipc_string(),
            "[flowlib:conflict] x"
        );
        assert_eq!(
            FlowLibError::NotFound("y".into()).to_ipc_string(),
            "[flowlib:not_found] y"
        );
        assert_eq!(
            FlowLibError::TooLarge("z".into()).to_ipc_string(),
            "[flowlib:too_large] z"
        );
        assert_eq!(
            FlowLibError::Io("i".into()).to_ipc_string(),
            "[flowlib:io] i"
        );
        assert_eq!(
            FlowLibError::Invalid("v".into()).to_ipc_string(),
            "[flowlib:invalid] v"
        );
    }

    #[test]
    fn first_save_is_revision_one_and_raw_bytes_are_stored() {
        let base = tmp_dir("first");
        let lib = FlowLibrary::new(base.join("flowlib"));
        let raw = flow("read_vin", 1);
        let entry = lib.save(&raw).unwrap();
        assert_eq!(entry.id, "read_vin");
        assert_eq!(entry.kind, FlowLibKind::Flow);
        assert_eq!(entry.latest_revision, 1);
        assert_eq!(entry.origin, FlowOrigin::User);
        assert_eq!(entry.tags, vec!["uds".to_string()]);
        assert!(!entry.deleted);
        assert_eq!(
            fs::read_to_string(base.join("flowlib/read_vin/r1.json")).unwrap(),
            raw
        );
        assert!(base.join("flowlib/index.json").is_file());
        assert_eq!(lib.load("read_vin", None).unwrap(), raw);
        assert_eq!(lib.load("read_vin", Some(1)).unwrap(), raw);
        assert_eq!(lib.list(false).unwrap(), vec![entry]);

        // Starting at 2 is a conflict.
        let err = lib.save(&flow("other", 2)).unwrap_err();
        assert_eq!(err.code(), FlowLibErrorCode::Conflict);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn wrong_revision_is_conflict_with_latest_in_message() {
        let base = tmp_dir("conflict");
        let lib = FlowLibrary::new(base.join("flowlib"));
        lib.save(&flow("f", 1)).unwrap();
        lib.save(&flow("f", 2)).unwrap();
        for bad in [1, 2, 4] {
            let err = lib.save(&flow("f", bad)).unwrap_err();
            assert_eq!(err.code(), FlowLibErrorCode::Conflict, "{err}");
            assert!(err.to_string().contains("latest revision 2"), "{err}");
            assert!(err.to_ipc_string().starts_with("[flowlib:conflict] "));
        }
        let e3 = lib.save(&flow("f", 3)).unwrap();
        assert_eq!(e3.latest_revision, 3);
        let revs = lib.revisions("f").unwrap();
        assert_eq!(
            revs.iter().map(|r| r.revision).collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
        assert_eq!(lib.load("f", Some(2)).unwrap(), flow("f", 2));
        assert_eq!(
            lib.load("f", Some(9)).unwrap_err().code(),
            FlowLibErrorCode::NotFound
        );
        assert_eq!(
            lib.revisions("nope").unwrap_err().code(),
            FlowLibErrorCode::NotFound
        );
        assert_eq!(
            lib.load("nope", None).unwrap_err().code(),
            FlowLibErrorCode::NotFound
        );
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn existing_revision_file_is_never_overwritten() {
        let base = tmp_dir("nooverwrite");
        let lib = FlowLibrary::new(base.join("flowlib"));
        lib.save(&flow("f", 1)).unwrap();
        let r1 = base.join("flowlib/f/r1.json");
        let before = fs::read(&r1).unwrap();

        // Re-saving revision 1 (even with a stale/missing index) must not touch r1.json.
        let mut changed = flow("f", 1);
        changed = changed.replace("Flow f", "Changed");
        assert_eq!(
            lib.save(&changed).unwrap_err().code(),
            FlowLibErrorCode::Conflict
        );
        fs::remove_file(base.join("flowlib/index.json")).unwrap();
        assert_eq!(
            lib.save(&changed).unwrap_err().code(),
            FlowLibErrorCode::Conflict
        );
        assert_eq!(fs::read(&r1).unwrap(), before);

        // Low-level primitive refuses an existing target.
        let err = create_new_file_atomic(&base.join("flowlib/f"), "r1.json", b"x").unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read(&r1).unwrap(), before);

        // Stale index (r2 written, index not updated) → index rebuilt, next save must be 3.
        let r2 = flow("f", 2);
        fs::write(base.join("flowlib/f/r2.json"), &r2).unwrap();
        let err = lib.save(&flow("f", 2)).unwrap_err();
        assert_eq!(err.code(), FlowLibErrorCode::Conflict);
        assert_eq!(
            fs::read_to_string(base.join("flowlib/f/r2.json")).unwrap(),
            r2
        );
        assert_eq!(lib.save(&flow("f", 3)).unwrap().latest_revision, 3);

        // No temp files left behind.
        let leftovers = fs::read_dir(base.join("flowlib/f"))
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(leftovers, 0);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn kind_change_is_rejected() {
        let base = tmp_dir("kind");
        let lib = FlowLibrary::new(base.join("flowlib"));
        lib.save(&flow("k", 1)).unwrap();
        let err = lib
            .save(&file_json("k", "nexuscan.block", 2, "K"))
            .unwrap_err();
        assert_eq!(err.code(), FlowLibErrorCode::Invalid);
        assert!(err.to_string().contains("cannot change"), "{err}");
        assert!(!base.join("flowlib/k/r2.json").exists());

        let b = lib
            .save(&file_json("blk", "nexuscan.block", 1, "B"))
            .unwrap();
        assert_eq!(b.kind, FlowLibKind::Block);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn bad_ids_and_envelopes_are_rejected() {
        let base = tmp_dir("badids");
        let lib = FlowLibrary::new(base.join("flowlib"));
        let long = "a".repeat(65);
        for bad in [
            "", "..", ".", "../x", "a/b", "a\\b", "a.b", "C:x", "x y", "é", "a\u{0}b", &long,
        ] {
            let err = lib.save(&flow(bad, 1)).unwrap_err();
            assert_eq!(err.code(), FlowLibErrorCode::Invalid, "{bad:?}: {err}");
            assert_eq!(
                lib.load(bad, None).unwrap_err().code(),
                FlowLibErrorCode::Invalid
            );
            assert_eq!(
                lib.revisions(bad).unwrap_err().code(),
                FlowLibErrorCode::Invalid
            );
            assert_eq!(
                lib.delete(bad).unwrap_err().code(),
                FlowLibErrorCode::Invalid
            );
        }
        assert!(lib.save(&flow(&"a".repeat(64), 1)).is_ok());
        assert!(lib.save(&flow("A-z_09", 1)).is_ok());

        let invalid = |s: String| {
            let err = lib.save(&s).unwrap_err();
            assert_eq!(err.code(), FlowLibErrorCode::Invalid, "{s}: {err}");
        };
        invalid("not json".into());
        invalid("[]".into());
        invalid(flow("v", 1).replace("\"schemaVersion\":1", "\"schemaVersion\":2"));
        invalid(file_json("v", "nexuscan.ecus", 1, "V"));
        invalid(file_json("v", "nexuscan.flow", 1, "   "));
        invalid(file_json("v", "nexuscan.flow", 1, &"n".repeat(201)));
        assert!(lib
            .save(&file_json("v200", "nexuscan.flow", 1, &"ñ".repeat(200)))
            .is_ok());
        invalid(flow("v", 1).replace(&hash('b'), "abc"));
        invalid(flow("v", 1).replace(&hash('b'), &hash('g')));
        invalid(flow("v", 1).replace("\"origin\":\"user\"", "\"origin\":\"robot\""));
        invalid(flow("v", 1).replace("\"revision\":1", "\"revision\":0"));
        invalid(flow("v", 1).replace("\"revision\":1", "\"revision\":-1"));
        assert!(!base.join("flowlib/v").exists());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn too_large_is_rejected() {
        let base = tmp_dir("large");
        let lib = FlowLibrary::new(base.join("flowlib"));
        let mut big = flow("big", 1);
        big.pop();
        big.push_str(&format!(
            ",\"pad\":\"{}\"}}",
            "x".repeat(MAX_FLOW_FILE_BYTES)
        ));
        let err = lib.save(&big).unwrap_err();
        assert_eq!(err.code(), FlowLibErrorCode::TooLarge);
        assert!(err.to_ipc_string().starts_with("[flowlib:too_large] "));
        assert!(!base.join("flowlib/big").exists());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn soft_delete_hides_entry_but_pinned_load_works_and_resave_undeletes() {
        let base = tmp_dir("delete");
        let lib = FlowLibrary::new(base.join("flowlib"));
        lib.save(&flow("d", 1)).unwrap();
        lib.save(&flow("d", 2)).unwrap();
        lib.save(&flow("keep", 1)).unwrap();
        assert_eq!(
            lib.delete("missing").unwrap_err().code(),
            FlowLibErrorCode::NotFound
        );
        lib.delete("d").unwrap();
        lib.delete("d").unwrap(); // idempotent

        let visible: Vec<String> = lib.list(false).unwrap().into_iter().map(|e| e.id).collect();
        assert_eq!(visible, vec!["keep".to_string()]);
        let all = lib.list(true).unwrap();
        let d = all.iter().find(|e| e.id == "d").unwrap();
        assert!(d.deleted);
        assert_eq!(d.latest_revision, 2);

        // Pinned references still load; revisions still listed.
        assert_eq!(lib.load("d", Some(1)).unwrap(), flow("d", 1));
        assert_eq!(lib.load("d", None).unwrap(), flow("d", 2));
        assert_eq!(lib.revisions("d").unwrap().len(), 2);

        // Deleted flag survives an index rebuild (marker file).
        fs::remove_file(base.join("flowlib/index.json")).unwrap();
        assert!(lib
            .list(true)
            .unwrap()
            .iter()
            .any(|e| e.id == "d" && e.deleted));
        assert!(!lib.list(false).unwrap().iter().any(|e| e.id == "d"));

        // Re-save un-deletes.
        let e3 = lib.save(&flow("d", 3)).unwrap();
        assert!(!e3.deleted);
        assert!(lib.list(false).unwrap().iter().any(|e| e.id == "d"));
        fs::remove_file(base.join("flowlib/index.json")).unwrap();
        assert!(lib
            .list(false)
            .unwrap()
            .iter()
            .any(|e| e.id == "d" && !e.deleted));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn index_is_rebuilt_when_missing_or_corrupt() {
        let base = tmp_dir("rebuild");
        let lib = FlowLibrary::new(base.join("flowlib"));
        lib.save(&flow("a", 1)).unwrap();
        lib.save(&flow("a", 2)).unwrap();
        lib.save(&file_json("b", "nexuscan.block", 1, "Bee"))
            .unwrap();
        let expected = lib.list(true).unwrap();
        let expected_revs = lib.revisions("a").unwrap();
        let index_path = base.join("flowlib/index.json");

        // Unparsable / foreign files are skipped.
        fs::write(base.join("flowlib/a/r3.json"), b"{ garbage").unwrap();
        fs::write(base.join("flowlib/a/r07.json"), flow("a", 7)).unwrap();
        fs::write(base.join("flowlib/a/notes.txt"), b"x").unwrap();
        fs::create_dir_all(base.join("flowlib/bad.id")).unwrap();
        fs::write(base.join("flowlib/bad.id/r1.json"), flow("bad", 1)).unwrap();
        fs::create_dir_all(base.join("flowlib/empty")).unwrap();
        // Revision file whose header names another id is skipped.
        fs::create_dir_all(base.join("flowlib/mismatch")).unwrap();
        fs::write(base.join("flowlib/mismatch/r1.json"), flow("other", 1)).unwrap();

        // 1. Missing index.
        fs::remove_file(&index_path).unwrap();
        assert_eq!(lib.list(true).unwrap(), expected);
        assert_eq!(lib.revisions("a").unwrap(), expected_revs);
        assert!(index_path.is_file(), "rebuilt index is persisted");

        // 2. Corrupt index.
        fs::write(&index_path, b"\x00\x01 not json").unwrap();
        assert_eq!(lib.list(true).unwrap(), expected);

        // 3. Structurally inconsistent index.
        fs::write(
            &index_path,
            br#"{"schemaVersion":1,"entries":{"../x":{"entry":{},"revisions":[]}}}"#,
        )
        .unwrap();
        assert_eq!(lib.list(true).unwrap(), expected);

        // Loading the latest after rebuild still works; garbage r3 counts as taken on disk.
        assert_eq!(lib.load("a", None).unwrap(), flow("a", 2));
        let err = lib.save(&flow("a", 3)).unwrap_err();
        assert_eq!(err.code(), FlowLibErrorCode::Conflict);
        assert!(lib.save(&flow("a", 4)).is_ok());
        let _ = fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_id_directory_is_refused() {
        let base = tmp_dir("symlink");
        let lib = FlowLibrary::new(base.join("flowlib"));
        fs::create_dir_all(base.join("flowlib")).unwrap();
        fs::create_dir_all(base.join("outside")).unwrap();
        std::os::unix::fs::symlink(base.join("outside"), base.join("flowlib/evil")).unwrap();
        let err = lib.save(&flow("evil", 1)).unwrap_err();
        assert_eq!(err.code(), FlowLibErrorCode::Io, "{err}");
        assert_eq!(fs::read_dir(base.join("outside")).unwrap().count(), 0);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn revision_file_name_parsing() {
        assert_eq!(parse_revision_file_name("r1.json"), Some(1));
        assert_eq!(parse_revision_file_name("r42.json"), Some(42));
        for bad in [
            "r0.json",
            "r01.json",
            "r.json",
            "r-1.json",
            "r+1.json",
            "1.json",
            "r1.json.tmp",
        ] {
            assert_eq!(parse_revision_file_name(bad), None, "{bad}");
        }
    }
}
