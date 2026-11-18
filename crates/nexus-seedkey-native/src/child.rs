//! Bounded child-process execution: stdin payload, capped stdout/stderr, wall-clock timeout
//! with kill. Shared by the `library` (helper process) and `external_process` providers.

use std::io::{Read, Write};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::{Duration, Instant};

/// Poll interval while waiting for the child.
const POLL: Duration = Duration::from_millis(2);
/// Grace period for the pipe readers after the child exited / was killed.
const READER_GRACE: Duration = Duration::from_millis(500);

#[derive(Debug)]
pub(crate) struct ChildOutput {
    pub status: ExitStatus,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

#[derive(Debug)]
pub(crate) enum RunError {
    Spawn(std::io::Error),
    Wait(std::io::Error),
    Timeout,
    StdoutOverflow,
}

/// Environment variables passed through to children (everything else is cleared).
pub(crate) const PASSTHROUGH_ENV: &[&str] = &["PATH", "SystemRoot", "windir", "TEMP", "TMP"];

/// Clears the environment except [`PASSTHROUGH_ENV`] and hides console windows on Windows.
pub(crate) fn harden(cmd: &mut Command, passthrough: &[&str]) {
    cmd.env_clear();
    for key in passthrough {
        if let Some(value) = std::env::var_os(key) {
            cmd.env(key, value);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

/// Reads at most `cap` bytes; sets `overflow` and stops when the stream carries more.
fn spawn_reader<R: Read + Send + 'static>(
    mut src: R,
    cap: usize,
    overflow: Option<Arc<AtomicBool>>,
) -> mpsc::Receiver<Vec<u8>> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut buf = Vec::with_capacity(cap.min(8 * 1024));
        let mut chunk = [0u8; 4096];
        loop {
            match src.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let room = cap.saturating_sub(buf.len());
                    buf.extend_from_slice(&chunk[..n.min(room)]);
                    if n > room {
                        if let Some(flag) = &overflow {
                            flag.store(true, Ordering::Release);
                            break;
                        }
                        // stderr: keep draining (discarding) so the child never blocks on it.
                    }
                }
            }
        }
        let _ = tx.send(buf);
    });
    rx
}

fn kill_and_reap(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

/// Runs `cmd` to completion or until `timeout` elapses (then the child is killed).
pub(crate) fn run(
    mut cmd: Command,
    stdin_data: Vec<u8>,
    timeout: Duration,
    stdout_cap: usize,
    stderr_cap: usize,
) -> Result<ChildOutput, RunError> {
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let started = Instant::now();
    let mut child = cmd.spawn().map_err(RunError::Spawn)?;

    if let Some(mut stdin) = child.stdin.take() {
        // Separate thread: a child that never reads stdin must not block us. Write errors
        // (child exited early -> broken pipe) are irrelevant.
        thread::spawn(move || {
            let _ = stdin.write_all(&stdin_data);
        });
    }
    let overflow = Arc::new(AtomicBool::new(false));
    let stdout_rx = child
        .stdout
        .take()
        .map(|s| spawn_reader(s, stdout_cap, Some(Arc::clone(&overflow))));
    let stderr_rx = child
        .stderr
        .take()
        .map(|s| spawn_reader(s, stderr_cap, None));

    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(e) => {
                kill_and_reap(&mut child);
                return Err(RunError::Wait(e));
            }
        }
        if overflow.load(Ordering::Acquire) {
            kill_and_reap(&mut child);
            return Err(RunError::StdoutOverflow);
        }
        if started.elapsed() >= timeout {
            kill_and_reap(&mut child);
            return Err(RunError::Timeout);
        }
        thread::sleep(POLL);
    };

    // Readers finish once the pipes close; a grandchild holding a pipe open must not hang us.
    let collect = |rx: Option<mpsc::Receiver<Vec<u8>>>| {
        rx.and_then(|rx| rx.recv_timeout(READER_GRACE).ok())
            .unwrap_or_default()
    };
    let stdout = collect(stdout_rx);
    let stderr = collect(stderr_rx);
    if overflow.load(Ordering::Acquire) {
        return Err(RunError::StdoutOverflow);
    }
    Ok(ChildOutput {
        status,
        stdout,
        stderr,
    })
}

/// Human-readable exit description (`exit code 3`, `signal 11 (SIGSEGV)`,
/// `0xC0000005 (access violation)`).
pub(crate) fn describe_status(status: &ExitStatus) -> String {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(sig) = status.signal() {
            let name = match sig {
                4 => " (SIGILL)",
                6 => " (SIGABRT)",
                7 | 10 => " (SIGBUS)",
                8 => " (SIGFPE)",
                9 => " (SIGKILL)",
                11 => " (SIGSEGV)",
                _ => "",
            };
            return format!("signal {sig}{name}");
        }
    }
    match status.code() {
        Some(code) => {
            #[cfg(windows)]
            {
                let name = match code as u32 {
                    0xC000_0005 => Some("access violation"),
                    0xC000_0409 => Some("stack buffer overrun / fail-fast"),
                    0xC000_001D => Some("illegal instruction"),
                    0xC000_00FD => Some("stack overflow"),
                    0xC000_0094 => Some("integer divide by zero"),
                    0xC000_0135 => Some("dependent DLL not found"),
                    _ => None,
                };
                if let Some(name) = name {
                    return format!("0x{:08X} ({name})", code as u32);
                }
            }
            format!("exit code {code}")
        }
        None => "terminated abnormally".to_string(),
    }
}

/// Lossy UTF-8, trimmed and truncated to `max` chars (diagnostics only).
pub(crate) fn snippet(bytes: &[u8], max: usize) -> String {
    let text = String::from_utf8_lossy(bytes);
    let text = text.trim();
    let mut out: String = text.chars().take(max).collect();
    if text.chars().count() > max {
        out.push('…');
    }
    out
}
