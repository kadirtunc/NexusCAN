//! WP-8 / HIGH-09: persistent data root (`projects/`, `traces/`), symlink-safe file access
//! and IPC input size limits shared by `src-tauri` and the `nexus_bridge` dev server.
//!
//! Resolution order for the data root:
//! 1. An explicit [`DataRoot`] passed to [`crate::PipelineEngine::with_data_root`]
//!    (`src-tauri` uses `app_local_data_dir()`).
//! 2. The `NEXUS_DATA_DIR` environment variable ([`DataRoot::from_env`]).
//! 3. Dev fallback ([`DataRoot::dev_default`]): `<repo>/projects` + `<repo>/traces` when a
//!    NexusCAN checkout is found, else `<cwd>/projects` + `<cwd>/traces`.
//!
//! All project/trace reads, writes and deletes go through [`resolve_in_dir`],
//! [`read_regular_file`], [`write_regular_file_atomic`] and [`remove_regular_file`]:
//! symlinks are refused (`symlink_metadata`), resolved paths must stay inside the
//! canonicalized directory, writes go to a `create_new` temp file and are renamed into place
//! (a planted symlink is replaced, never followed).

use crate::error::{AdapterError, HalError};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// Environment variable overriding the data root (`<dir>/projects`, `<dir>/traces`).
pub const DATA_DIR_ENV: &str = "NEXUS_DATA_DIR";

/// Max size of one inbound IPC text/base64 payload (trace content, project JSON, database
/// content). 64 MiB of base64 decodes to 48 MiB.
pub const MAX_IPC_CONTENT_BYTES: usize = 64 * 1024 * 1024;

/// Max combined base64 size of all database files bound to one bus in a single call.
pub const MAX_IPC_DB_TOTAL_BYTES: usize = 128 * 1024 * 1024;

/// Max number of database files in one `cmd_set_bus_databases` call.
pub const MAX_DB_FILES_PER_CALL: usize = 64;

/// Max number of frames accepted for BLF export / in-memory replay.
pub const MAX_IPC_FRAMES: usize = 1_000_000;

/// Max `(signal_id, value)` pairs in one signal TX request (a 512-bit CAN-FD frame holds at
/// most 512 one-bit signals; mux selectors are added by the encoder).
pub const MAX_TX_SIGNAL_VALUES: usize = 1024;

/// Max byte length of a periodic TX job label.
pub const MAX_TX_JOB_LABEL_BYTES: usize = 256;

/// Max size of a project file read from disk.
pub const MAX_PROJECT_FILE_BYTES: u64 = MAX_IPC_CONTENT_BYTES as u64;

/// Max size of a trace file read from disk (traces may be dropped into the folder manually).
pub const MAX_TRACE_FILE_BYTES: u64 = 256 * 1024 * 1024;

/// Max directory entries considered by `cmd_list_projects` / `cmd_list_traces`.
pub const MAX_LISTED_ENTRIES: usize = 4096;

/// Persistent storage locations of one [`crate::PipelineEngine`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DataRoot {
    projects_dir: PathBuf,
    traces_dir: PathBuf,
}

impl DataRoot {
    /// `<root>/projects` + `<root>/traces`.
    pub fn under(root: impl AsRef<Path>) -> Self {
        let root = root.as_ref();
        Self {
            projects_dir: root.join("projects"),
            traces_dir: root.join("traces"),
        }
    }

    /// Explicit, independent projects and traces directories.
    pub fn from_dirs(projects_dir: impl Into<PathBuf>, traces_dir: impl Into<PathBuf>) -> Self {
        Self {
            projects_dir: projects_dir.into(),
            traces_dir: traces_dir.into(),
        }
    }

    /// `NEXUS_DATA_DIR` if set to a non-empty value.
    pub fn from_env() -> Option<Self> {
        Self::from_env_value(std::env::var_os(DATA_DIR_ENV))
    }

    fn from_env_value(value: Option<std::ffi::OsString>) -> Option<Self> {
        let value = value?;
        if value.is_empty() {
            return None;
        }
        Some(Self::under(PathBuf::from(value)))
    }

    /// Dev fallback used by the bridge / CLI / tests: repo-relative `projects/` + `traces/`
    /// when a NexusCAN checkout is found (via the build-time manifest dir in debug builds, the
    /// cwd or the exe location), else relative to the current directory. `src-tauri` uses it
    /// only in debug builds; release builds always use `app_local_data_dir()`.
    pub fn dev_default() -> Self {
        match locate_dev_repo_root() {
            Some(root) => Self::under(root),
            None => Self::under(std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))),
        }
    }

    /// [`Self::from_env`] or [`Self::dev_default`].
    pub fn resolve_default() -> Self {
        Self::from_env().unwrap_or_else(Self::dev_default)
    }

    pub fn projects_dir(&self) -> &Path {
        &self.projects_dir
    }

    pub fn traces_dir(&self) -> &Path {
        &self.traces_dir
    }

    /// Creates both directories (mode `0700` on Unix for newly created directories).
    pub fn ensure_dirs(&self) -> io::Result<()> {
        create_private_dir_all(&self.projects_dir)?;
        create_private_dir_all(&self.traces_dir)
    }
}

/// Repo marker: `scripts/sample_vehicle.dbc` next to a `Cargo.toml`.
fn is_dev_repo_root(dir: &Path) -> bool {
    dir.join("Cargo.toml").is_file() && dir.join("scripts").join("sample_vehicle.dbc").is_file()
}

fn locate_dev_repo_root() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    // Debug builds only: build-time checkout location (meaningless on another machine, so it
    // is checked for the marker like every other candidate). Release builds never embed or
    // consult `CARGO_MANIFEST_DIR` at runtime (WP-8 / HIGH-09).
    #[cfg(debug_assertions)]
    candidates.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."));
    if let Ok(cwd) = std::env::current_dir() {
        candidates.extend(cwd.ancestors().take(4).map(Path::to_path_buf));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.extend(dir.ancestors().take(5).map(Path::to_path_buf));
        }
    }
    candidates
        .into_iter()
        .find(|dir| is_dev_repo_root(dir))
        .map(|dir| fs::canonicalize(&dir).unwrap_or(dir))
}

#[cfg(unix)]
pub(crate) fn create_private_dir_all(dir: &Path) -> io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    if dir.is_dir() {
        return Ok(());
    }
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
}

#[cfg(not(unix))]
pub(crate) fn create_private_dir_all(dir: &Path) -> io::Result<()> {
    fs::create_dir_all(dir)
}

#[inline]
fn io_err(e: io::Error) -> HalError {
    HalError::Adapter(AdapterError::Io(e))
}

/// Windows reserved device names (`CON.trc` opens the console on Windows).
pub(crate) fn is_windows_reserved_stem(stem: &str) -> bool {
    const RESERVED: [&str; 22] = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    RESERVED.iter().any(|r| r.eq_ignore_ascii_case(stem))
}

/// WP-8 / HIGH-09: rejects path-like user input instead of silently rewriting it.
///
/// `what` names the field in the error message (`"trace file name"`, `"project name"`).
/// Rejected: empty / whitespace-only, path separators (`/`, `\\`), drive / stream separators
/// (`:`), any `..` sequence, a leading `.` (hidden files, `.`, `..`), NUL and other control
/// characters.
pub fn reject_path_like_name(what: &str, raw: &str) -> Result<(), HalError> {
    let trimmed = raw.trim();
    let reason = if trimmed.is_empty() {
        Some("name is empty")
    } else if trimmed.contains(['/', '\\']) {
        Some("path separators are not allowed")
    } else if trimmed.contains(':') {
        Some("':' is not allowed")
    } else if trimmed.contains("..") {
        Some("'..' is not allowed")
    } else if trimmed.starts_with('.') {
        Some("name must not start with '.'")
    } else if trimmed.chars().any(char::is_control) {
        Some("control characters are not allowed")
    } else {
        None
    };
    match reason {
        Some(reason) => Err(HalError::InvalidInput(format!(
            "Invalid {what} '{}': {reason}",
            trimmed.escape_debug()
        ))),
        None => Ok(()),
    }
}

/// Returns an error when `payload_len` exceeds `max` (`what` names the field in the message).
pub fn check_ipc_size(what: &str, payload_len: usize, max: usize) -> Result<(), HalError> {
    if payload_len > max {
        return Err(HalError::InvalidInput(format!(
            "{what} is too large: {payload_len} bytes (limit {max} bytes)"
        )));
    }
    Ok(())
}

/// Returns an error when `count` exceeds [`MAX_IPC_FRAMES`].
pub fn check_frame_count(what: &str, count: usize) -> Result<(), HalError> {
    if count > MAX_IPC_FRAMES {
        return Err(HalError::InvalidInput(format!(
            "{what}: too many frames ({count}, limit {MAX_IPC_FRAMES})"
        )));
    }
    Ok(())
}

/// Resolves the already-sanitized single-segment `file_name` inside `dir` (creating `dir`).
///
/// Fails when the name is not a plain file name, when the resolved path would leave the
/// canonicalized `dir`, or when an existing entry is a symlink / not a regular file.
pub fn resolve_in_dir(dir: &Path, file_name: &str) -> Result<PathBuf, HalError> {
    if file_name.is_empty()
        || file_name == "."
        || file_name == ".."
        || file_name.contains(['/', '\\', '\0'])
    {
        return Err(HalError::InvalidInput(format!(
            "Invalid file name '{file_name}'"
        )));
    }
    create_private_dir_all(dir).map_err(io_err)?;
    let canon_dir = fs::canonicalize(dir).map_err(io_err)?;
    let target = canon_dir.join(file_name);
    if target.parent() != Some(canon_dir.as_path()) {
        return Err(HalError::InvalidInput(format!(
            "File name '{file_name}' escapes the storage directory"
        )));
    }
    match fs::symlink_metadata(&target) {
        Ok(meta) if meta.file_type().is_symlink() => Err(symlink_refused(file_name)),
        Ok(meta) if !meta.is_file() => Err(HalError::InvalidInput(format!(
            "'{file_name}' is not a regular file"
        ))),
        Ok(_) => Ok(target),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(target),
        Err(e) => Err(io_err(e)),
    }
}

fn symlink_refused(name: &str) -> HalError {
    HalError::InvalidInput(format!("Refusing to follow symbolic link '{name}'"))
}

fn display_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// `true` when `path` exists as a regular file (not a symlink).
pub fn is_regular_file(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|m| m.file_type().is_file())
        .unwrap_or(false)
}

/// Opens `path` for reading after verifying it is a regular file (not a symlink) and that
/// the opened handle is the same inode that was checked (Unix).
fn open_regular_file(path: &Path) -> Result<(File, fs::Metadata), HalError> {
    let name = display_name(path);
    let pre = fs::symlink_metadata(path).map_err(io_err)?;
    if pre.file_type().is_symlink() {
        return Err(symlink_refused(&name));
    }
    if !pre.is_file() {
        return Err(HalError::InvalidInput(format!(
            "'{name}' is not a regular file"
        )));
    }
    let file = File::open(path).map_err(io_err)?;
    let post = file.metadata().map_err(io_err)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if pre.dev() != post.dev() || pre.ino() != post.ino() {
            return Err(HalError::InvalidInput(format!(
                "'{name}' changed while being opened"
            )));
        }
    }
    if !post.is_file() {
        return Err(HalError::InvalidInput(format!(
            "'{name}' is not a regular file"
        )));
    }
    Ok((file, post))
}

/// Reads a regular file (symlinks refused) of at most `max_bytes`.
pub fn read_regular_file(path: &Path, max_bytes: u64) -> Result<Vec<u8>, HalError> {
    let (file, meta) = open_regular_file(path)?;
    if meta.len() > max_bytes {
        return Err(HalError::InvalidInput(format!(
            "'{}' is too large: {} bytes (limit {max_bytes} bytes)",
            display_name(path),
            meta.len()
        )));
    }
    let mut buf = Vec::with_capacity(meta.len() as usize);
    file.take(max_bytes + 1)
        .read_to_end(&mut buf)
        .map_err(io_err)?;
    if buf.len() as u64 > max_bytes {
        return Err(HalError::InvalidInput(format!(
            "'{}' grew beyond the {max_bytes} byte limit while being read",
            display_name(path)
        )));
    }
    Ok(buf)
}

/// Reads at most `max_bytes` from the start of a regular file (symlinks refused).
pub fn read_regular_file_prefix(path: &Path, max_bytes: usize) -> Result<Vec<u8>, HalError> {
    let (file, _) = open_regular_file(path)?;
    let mut buf = Vec::with_capacity(max_bytes);
    file.take(max_bytes as u64)
        .read_to_end(&mut buf)
        .map_err(io_err)?;
    Ok(buf)
}

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Writes `bytes` to `path` via a `create_new` temp file in the same directory + rename.
/// An existing symlink at `path` is refused; a symlink planted between the check and the
/// rename is replaced (rename never follows the destination).
pub fn write_regular_file_atomic(path: &Path, bytes: &[u8]) -> Result<(), HalError> {
    let name = display_name(path);
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => return Err(symlink_refused(&name)),
        Ok(meta) if !meta.is_file() => {
            return Err(HalError::InvalidInput(format!(
                "'{name}' is not a regular file"
            )))
        }
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(io_err(e)),
    }
    let parent = path
        .parent()
        .ok_or_else(|| HalError::InvalidInput(format!("'{name}' has no parent directory")))?;
    let tmp = parent.join(format!(
        ".{name}.{}.{}.tmp",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));

    let result = (|| -> io::Result<()> {
        let mut opts = OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        fs::rename(&tmp, path)
    })();

    if let Err(e) = result {
        let _ = fs::remove_file(&tmp);
        return Err(io_err(e));
    }
    Ok(())
}

/// Deletes a regular file; symlinks and missing files are errors.
pub fn remove_regular_file(path: &Path) -> Result<(), HalError> {
    let name = display_name(path);
    let meta = fs::symlink_metadata(path).map_err(io_err)?;
    if meta.file_type().is_symlink() {
        return Err(symlink_refused(&name));
    }
    if !meta.is_file() {
        return Err(HalError::InvalidInput(format!(
            "'{name}' is not a regular file"
        )));
    }
    fs::remove_file(path).map_err(io_err)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;

    fn tmp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "nexuscan-storage-{tag}-{}-{}",
            std::process::id(),
            nexus_core::now_monotonic_us()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn data_root_env_override_and_layout() {
        assert_eq!(DataRoot::from_env_value(None), None);
        assert_eq!(DataRoot::from_env_value(Some(OsString::new())), None);
        let root = DataRoot::from_env_value(Some(OsString::from("/opt/nexus-data"))).unwrap();
        assert_eq!(root.projects_dir(), Path::new("/opt/nexus-data/projects"));
        assert_eq!(root.traces_dir(), Path::new("/opt/nexus-data/traces"));
        assert_eq!(root, DataRoot::under("/opt/nexus-data"));
    }

    #[test]
    fn ensure_dirs_creates_private_directories() {
        let base = tmp_dir("ensure");
        let root = DataRoot::under(base.join("nested/data"));
        root.ensure_dirs().unwrap();
        assert!(root.projects_dir().is_dir());
        assert!(root.traces_dir().is_dir());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(root.traces_dir())
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(
                mode & 0o077,
                0,
                "traces dir must not be group/world accessible"
            );
        }
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn resolve_in_dir_rejects_traversal_names() {
        let base = tmp_dir("resolve");
        for bad in ["", ".", "..", "../x", "a/b", "a\\b", "x\0y"] {
            assert!(
                resolve_in_dir(&base, bad).is_err(),
                "{bad:?} must be rejected"
            );
        }
        let ok = resolve_in_dir(&base, "a.trc").unwrap();
        assert_eq!(ok.parent().unwrap(), fs::canonicalize(&base).unwrap());
        let _ = fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_refused_for_read_write_delete() {
        let base = tmp_dir("symlink");
        let outside = base.join("outside.txt");
        fs::write(&outside, b"secret").unwrap();
        let dir = base.join("traces");
        fs::create_dir_all(&dir).unwrap();
        let link = dir.join("link.trc");
        std::os::unix::fs::symlink(&outside, &link).unwrap();

        assert!(resolve_in_dir(&dir, "link.trc").is_err());
        assert!(read_regular_file(&link, 1024).is_err());
        assert!(read_regular_file_prefix(&link, 16).is_err());
        assert!(write_regular_file_atomic(&link, b"overwrite").is_err());
        assert!(remove_regular_file(&link).is_err());
        assert!(!is_regular_file(&link));
        // Target untouched, link still there.
        assert_eq!(fs::read(&outside).unwrap(), b"secret");
        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn atomic_write_read_roundtrip_and_size_limit() {
        let base = tmp_dir("rw");
        let path = resolve_in_dir(&base, "p.json").unwrap();
        write_regular_file_atomic(&path, b"{\"a\":1}").unwrap();
        write_regular_file_atomic(&path, b"{\"a\":2}").unwrap();
        assert_eq!(read_regular_file(&path, 64).unwrap(), b"{\"a\":2}");
        assert!(read_regular_file(&path, 3).is_err());
        assert_eq!(read_regular_file_prefix(&path, 2).unwrap(), b"{\"");
        // No temp files left behind.
        let leftovers: Vec<_> = fs::read_dir(&base)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty());
        remove_regular_file(&path).unwrap();
        assert!(remove_regular_file(&path).is_err());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn ipc_limits() {
        assert!(check_ipc_size("x", 10, 10).is_ok());
        assert!(check_ipc_size("x", 11, 10).is_err());
        assert!(check_frame_count("x", MAX_IPC_FRAMES).is_ok());
        assert!(check_frame_count("x", MAX_IPC_FRAMES + 1).is_err());
        assert!(is_windows_reserved_stem("con"));
        assert!(is_windows_reserved_stem("LPT1"));
        assert!(!is_windows_reserved_stem("console"));
    }
}
