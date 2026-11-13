//! Cross-OS Lawicel `SLCAN` (Serial / USB-CDC) CAN 2.0 & CAN-FD adapter driver.
//!
//! Built on `serialport` (`default-features = false` for zero `libudev` C-header dependency on Linux/WSL2)
//! while maintaining `#![forbid(unsafe_code)]` and zero heap allocations on hot-path `recv_batch` / `send_frame`.

use crate::dto::{AdapterCapabilitiesDto, DeviceDescriptorDto, SerialPortInfoDto};
use crate::error::AdapterError;
use crate::traits::{
    AdapterCapabilities, AdapterDriver, BusHealthSnapshot, BusState, CanChannel, CanFilter,
    ChannelConfig, DeviceDescriptor, ListenOnlyEnforcement,
};
use nexus_core::{
    now_monotonic_us, BusId, CanIdKey, RawCanFrame, EXT_CAN_ID_MASK, MAX_CAN_FD_DLC,
    MAX_CLASSICAL_CAN_DLC, STD_CAN_ID_MASK,
};
use serialport::{ClearBuffer, SerialPort, SerialPortType};
use std::collections::BTreeMap;
use std::io::{self, Read, Write};
use std::time::{Duration, Instant};

/// Maximum encoded ASCII length of a 64-byte CAN-FD Lawicel frame (`B` + 8 ID + 1 DLC + 128 hex + `\r` = 139B).
pub const MAX_SLCAN_ASCII_LEN: usize = 148;

const CAN_FD_DLC_LEN_TABLE: [u8; 16] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 20, 24, 32, 48, 64];
const HEX_UPPER: &[u8; 16] = b"0123456789ABCDEF";
const INTERNAL_QUEUE_CAP: usize = 64;

/// Maps nominal CAN bitrate (bps) to standard Lawicel `S0`..`S8` setup command.
#[inline]
pub const fn slcan_bitrate_command(bitrate: u32) -> &'static [u8] {
    match bitrate {
        0..=10_000 => b"S0\r",
        10_001..=20_000 => b"S1\r",
        20_001..=50_000 => b"S2\r",
        50_001..=100_000 => b"S3\r",
        100_001..=125_000 => b"S4\r",
        125_001..=250_000 => b"S5\r",
        250_001..=500_000 => b"S6\r",
        500_001..=800_000 => b"S7\r",
        _ => b"S8\r",
    }
}

/// Maps CAN-FD data phase bitrate (bps) to CANable 2.0 / candleLight-SLCAN `Y2`..`Y8` command.
#[inline]
pub const fn slcan_fd_data_bitrate_command(data_bitrate: u32) -> &'static [u8] {
    match data_bitrate {
        0..=2_000_000 => b"Y2\r",
        2_000_001..=4_000_000 => b"Y4\r",
        4_000_001..=5_000_000 => b"Y5\r",
        _ => b"Y8\r",
    }
}

/// Builds the exact Lawicel ASCII initialization command sequence for channel startup.
///
/// Enforces `L\r` when `listen_only == true` (passive silent monitoring) and `O\r` otherwise.
pub fn slcan_init_sequence(
    bitrate: u32,
    data_bitrate: u32,
    enable_fd: bool,
    listen_only: bool,
) -> Vec<&'static [u8]> {
    let mut seq = Vec::with_capacity(4);
    seq.push(b"C\r".as_slice());
    seq.push(slcan_bitrate_command(bitrate));
    if enable_fd {
        seq.push(slcan_fd_data_bitrate_command(data_bitrate));
    }
    if listen_only {
        seq.push(b"L\r".as_slice());
    } else {
        seq.push(b"O\r".as_slice());
    }
    seq
}

/// Maximum bytes scanned for a Lawicel command reply (tolerates echoes / stray bytes).
const LAWICEL_REPLY_SCAN_MAX: usize = 16;

/// Total time allowed for one Lawicel command reply, polled with the port's own 5 ms read
/// timeout (USB-CDC adapters typically answer within 1-2 ms; 50 ms leaves margin for hubs).
const LAWICEL_REPLY_WINDOW: Duration = Duration::from_millis(50);

/// Input drain: the line counts as quiet once no byte arrived for this long.
const LAWICEL_DRAIN_QUIET: Duration = Duration::from_millis(20);

/// Input drain: upper bound on one drain; a line still busy after this is "streaming".
const LAWICEL_DRAIN_CAP: Duration = Duration::from_millis(200);

/// Timing of the Lawicel open handshake (production: [`LAWICEL_TIMING`]; tests shrink it).
#[derive(Clone, Copy, Debug)]
struct HandshakeTiming {
    /// Per-command reply window.
    reply_window: Duration,
    /// Quiet period that ends an input drain.
    drain_quiet: Duration,
    /// Total cap of an input drain.
    drain_cap: Duration,
}

const LAWICEL_TIMING: HandshakeTiming = HandshakeTiming {
    reply_window: LAWICEL_REPLY_WINDOW,
    drain_quiet: LAWICEL_DRAIN_QUIET,
    drain_cap: LAWICEL_DRAIN_CAP,
};

/// Reply to one Lawicel ASCII command.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LawicelReply {
    /// `CR` (0x0D): command accepted.
    Ack,
    /// `BEL` (0x07): command refused.
    Nack,
    /// No `CR` / `BEL` within the reply window or [`LAWICEL_REPLY_SCAN_MAX`] bytes.
    NoReply,
    /// (strict mode only) a `CR` terminated a non-empty line other than the command echo.
    Unexpected,
}

/// How strictly a `CR` is accepted as the acknowledgement.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ReplyMode {
    /// Setup commands (`C`, `Sx`, `Yx`, `O`): stray bytes before the `CR` are tolerated, but a
    /// line that looks like a received frame (`t`/`T`/`r`/`R`/`d`/`D`/`b`/`B`) or the echoed
    /// command is skipped, never taken as the acknowledgement.
    Lenient,
    /// `L`: only a bare `CR`, or the exact echo `L\r` followed by a bare `CR`, is an `Ack`.
    /// Any other line before a `CR` is [`LawicelReply::Unexpected`].
    Strict,
}

/// First byte of a Lawicel received-frame line.
#[inline]
const fn is_frame_line_start(b: u8) -> bool {
    matches!(b, b't' | b'T' | b'r' | b'R' | b'd' | b'D' | b'b' | b'B')
}

/// Reads the reply to the Lawicel command `echo` (without its trailing `\r`).
///
/// Scans at most [`LAWICEL_REPLY_SCAN_MAX`] bytes for `CR` / `BEL`; `BEL` anywhere is a `Nack`.
/// What a `CR` means depends on `mode` (see [`ReplyMode`]); the echoed command line is
/// skipped once in both modes.
fn read_lawicel_reply<P: Read + ?Sized>(
    port: &mut P,
    echo: &[u8],
    window: Duration,
    mode: ReplyMode,
) -> LawicelReply {
    let deadline = Instant::now() + window;
    let mut line = [0u8; LAWICEL_REPLY_SCAN_MAX];
    let mut line_len = 0usize;
    let mut echo_seen = false;
    let mut scanned = 0usize;
    let mut buf = [0u8; LAWICEL_REPLY_SCAN_MAX];
    while scanned < LAWICEL_REPLY_SCAN_MAX && Instant::now() < deadline {
        let want = LAWICEL_REPLY_SCAN_MAX - scanned;
        let n = match port.read(&mut buf[..want]) {
            Ok(0) => return LawicelReply::NoReply,
            Ok(n) => n,
            Err(e) if is_transient_read_error(&e) => continue,
            Err(_) => return LawicelReply::NoReply,
        };
        for &b in &buf[..n] {
            scanned += 1;
            if b == 0x07 {
                return LawicelReply::Nack;
            }
            if b != b'\r' {
                // `scanned <= LAWICEL_REPLY_SCAN_MAX`, so `line_len` stays in bounds.
                if let Some(slot) = line.get_mut(line_len) {
                    *slot = b;
                    line_len += 1;
                }
                continue;
            }
            let text = &line[..line_len];
            line_len = 0;
            if text.is_empty() {
                return LawicelReply::Ack;
            }
            if !echo_seen && !echo.is_empty() && text == echo {
                echo_seen = true;
                continue;
            }
            match mode {
                ReplyMode::Strict => return LawicelReply::Unexpected,
                ReplyMode::Lenient if is_frame_line_start(text[0]) => continue,
                ReplyMode::Lenient => return LawicelReply::Ack,
            }
        }
    }
    LawicelReply::NoReply
}

#[inline]
fn is_transient_read_error(e: &io::Error) -> bool {
    matches!(
        e.kind(),
        io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
    )
}

/// Reads and discards input until no byte arrived for `quiet`, bounded by `cap`.
///
/// Returns `true` when the line went quiet, `false` when it was still busy after `cap` (the
/// adapter keeps streaming frames) or the port failed. Cold path; stack buffer only.
fn drain_until_quiet<P: Read + ?Sized>(port: &mut P, quiet: Duration, cap: Duration) -> bool {
    let start = Instant::now();
    let mut last_rx = start;
    let mut buf = [0u8; 64];
    loop {
        let now = Instant::now();
        if now.duration_since(last_rx) >= quiet {
            return true;
        }
        if now.duration_since(start) >= cap {
            return false;
        }
        match port.read(&mut buf) {
            Ok(0) => std::thread::sleep(Duration::from_millis(1)),
            Ok(_) => last_rx = Instant::now(),
            Err(e) if is_transient_read_error(&e) => {}
            Err(_) => return false,
        }
    }
}

/// Writes one Lawicel command and reads its reply.
fn lawicel_command<P: Read + Write + ?Sized>(
    port: &mut P,
    cmd: &[u8],
    port_name: &str,
    window: Duration,
    mode: ReplyMode,
) -> Result<LawicelReply, AdapterError> {
    port.write_all(cmd)
        .and_then(|()| port.flush())
        .map_err(|e| {
            AdapterError::Driver(format!(
                "Failed writing Lawicel init command to '{port_name}': {e}"
            ))
        })?;
    let echo = cmd.strip_suffix(b"\r").unwrap_or(cmd);
    Ok(read_lawicel_reply(port, echo, window, mode))
}

/// Why the adapter's listen-only state could not be confirmed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ListenOnlyUnverified {
    /// `L` was answered with anything but an acceptable `CR` (see [`ReplyMode::Strict`]).
    Reply(LawicelReply),
    /// The input never went quiet before `L`; `L` was not sent.
    Streaming,
    /// `L` was acknowledged, but an earlier setup command was refused / unanswered or the line
    /// did not go quiet after `C`, so the reply stream may be shifted.
    SetupSuspect,
}

impl ListenOnlyUnverified {
    const fn describe(self) -> &'static str {
        match self {
            Self::Reply(LawicelReply::Nack) => "refused it (BEL)",
            Self::Reply(LawicelReply::Unexpected) => {
                "answered it with an unexpected line instead of a bare CR"
            }
            Self::Reply(_) => "did not acknowledge it in time",
            Self::Streaming => {
                "kept streaming data and never went quiet, so it was not sent (the reply could \
                 not be told apart from received frames)"
            }
            Self::SetupSuspect => {
                "acknowledged it, but an earlier setup command (C/Sx/Yx) was refused or \
                 unanswered, so that acknowledgement cannot be trusted"
            }
        }
    }
}

/// Lawicel open handshake: `C`, `Sx`, optional `Yx`, then `L` (Listen-Only) or `O`.
///
/// Every command's reply is read before the next one is sent. Replies are kept in step:
/// * After `C` and again right before `L`, the input is drained until it is quiet for
///   `drain_quiet` (bounded by `drain_cap`), so frames still streaming from an adapter left
///   open by a crashed session are not mistaken for replies.
/// * Setup replies are read leniently ([`ReplyMode::Lenient`]); a frame-looking line is never
///   an acknowledgement. `O`'s reply is not enforced.
///
/// For `L`, [`ListenOnlyEnforcement::Hardware`] is reported only when ALL of these hold:
/// * the line went quiet before `L` (otherwise `L` is not sent at all);
/// * every setup command (`C`, `Sx`, `Yx`) got an `Ack` and the line went quiet after `C`
///   (an `Ack` to `L` after a refused / unanswered setup command is NOT trusted: the replies
///   may be shifted by one);
/// * `L` got a bare `CR`, or the exact echo `L\r` followed by a bare `CR`
///   ([`ReplyMode::Strict`]). `BEL`, timeout, or any other line → not acknowledged.
///
/// Honest limit: even then `Hardware` is the ADAPTER'S CLAIM, not proof. Lawicel has no
/// command to read back the mode, and some clone firmwares answer `CR` to every command
/// (including `L`) while still ACKing on the bus.
///
/// When not acknowledged, `C` is sent (in case it silently entered listen-only), then:
/// * `require_hardware_listen_only`: fail-closed error, the CAN channel is never opened (the
///   caller drops, i.e. closes, the serial port).
/// * otherwise: Lawicel has no other way to receive frames, so the channel is opened with `O`
///   (normal mode: the adapter WILL ACK frames) and reported
///   [`ListenOnlyEnforcement::SoftwareOnly`]; NexusCAN's software TX lock stays in force
///   (`send_frame` rejects) and the HMI shows the software-only warning.
///
/// Active (non-listen-only) channels return `SoftwareOnly` (not consulted by the pipeline).
fn slcan_open_handshake<P: Read + Write + ?Sized>(
    port: &mut P,
    config: &ChannelConfig,
    port_name: &str,
    timing: HandshakeTiming,
) -> Result<ListenOnlyEnforcement, AdapterError> {
    let init = slcan_init_sequence(
        config.bitrate,
        config.data_bitrate,
        config.enable_fd,
        config.listen_only,
    );
    let window = timing.reply_window;
    let mut setup_suspect = false;
    let mut unverified = None;
    for cmd in init {
        if cmd == b"L\r" {
            if !drain_until_quiet(port, timing.drain_quiet, timing.drain_cap) {
                unverified = Some(ListenOnlyUnverified::Streaming);
                break;
            }
            let reply = lawicel_command(port, cmd, port_name, window, ReplyMode::Strict)?;
            unverified = match (reply, setup_suspect) {
                (LawicelReply::Ack, false) => return Ok(ListenOnlyEnforcement::Hardware),
                (LawicelReply::Ack, true) => Some(ListenOnlyUnverified::SetupSuspect),
                (other, _) => Some(ListenOnlyUnverified::Reply(other)),
            };
            break;
        }
        let reply = lawicel_command(port, cmd, port_name, window, ReplyMode::Lenient)?;
        if cmd == b"O\r" {
            continue;
        }
        if reply != LawicelReply::Ack {
            setup_suspect = true;
        }
        if cmd == b"C\r" && !drain_until_quiet(port, timing.drain_quiet, timing.drain_cap) {
            setup_suspect = true;
        }
    }
    let Some(why) = unverified else {
        // Active channel (`O` sent).
        return Ok(ListenOnlyEnforcement::SoftwareOnly);
    };
    let _ = lawicel_command(port, b"C\r", port_name, window, ReplyMode::Lenient);
    if config.require_hardware_listen_only {
        return Err(AdapterError::hw_listen_only_unavailable(&format!(
            "SLCAN adapter on '{port_name}' {}: hardware listen-only via the Lawicel \
             listen-only command (`L`) could not be confirmed, so its CAN channel was not \
             opened and the serial port was closed. Use firmware with `L` support (and retry \
             once a previous session's stream has stopped), or clear 'require hardware \
             listen-only' to accept the software-only TX lock.",
            why.describe()
        )));
    }
    let _ = lawicel_command(port, b"O\r", port_name, window, ReplyMode::Lenient)?;
    Ok(ListenOnlyEnforcement::SoftwareOnly)
}

#[inline]
const fn decode_hex_nibble(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

#[inline]
fn parse_hex_u32(slice: &[u8]) -> Option<u32> {
    if slice.is_empty() || slice.len() > 8 {
        return None;
    }
    let mut val = 0u32;
    for &b in slice {
        let nib = decode_hex_nibble(b)?;
        val = (val << 4) | u32::from(nib);
    }
    Some(val)
}

#[inline]
fn fd_len_to_dlc_code(payload_len: usize) -> (u8, usize) {
    for (code, &fd_len) in CAN_FD_DLC_LEN_TABLE.iter().enumerate() {
        let len_usize = usize::from(fd_len);
        if payload_len <= len_usize {
            return (code as u8, len_usize);
        }
    }
    (15, MAX_CAN_FD_DLC)
}

/// Zero-allocation parser for a single Lawicel SLCAN ASCII line (without trailing `\r`/`\n`).
///
/// Supports:
/// - `tIIILDD..` (11-bit Classical CAN data)
/// - `TIIIIIIIIILDD..` (`T` + 8-hex 29-bit Extended CAN data)
/// - `rIIIL` / `RIIIIIIIIIL` (11-bit / 29-bit RTR frames)
/// - `d`/`D` (11-bit / 29-bit CAN-FD data without BRS)
/// - `b`/`B` (11-bit / 29-bit CAN-FD data with BRS)
pub fn parse_slcan_line(mut line: &[u8], bus_id: BusId, timestamp_us: u64) -> Option<RawCanFrame> {
    while let Some(&last) = line.last() {
        if last == b'\r' || last == b'\n' || last == b' ' {
            line = &line[..line.len() - 1];
        } else {
            break;
        }
    }
    let (&cmd, rest) = line.split_first()?;

    let (is_extended, is_rtr, is_fd, is_brs) = match cmd {
        b't' => (false, false, false, false),
        b'T' => (true, false, false, false),
        b'r' => (false, true, false, false),
        b'R' => (true, true, false, false),
        b'd' => (false, false, true, false),
        b'D' => (true, false, true, false),
        b'b' => (false, false, true, true),
        b'B' => (true, false, true, true),
        _ => return None,
    };

    let id_chars = if is_extended { 8 } else { 3 };
    if rest.len() < id_chars + 1 {
        return None;
    }

    let raw_id = parse_hex_u32(&rest[..id_chars])?;
    let arb_id = if is_extended {
        if raw_id > EXT_CAN_ID_MASK {
            return None;
        }
        raw_id & EXT_CAN_ID_MASK
    } else {
        if raw_id > STD_CAN_ID_MASK {
            return None;
        }
        raw_id & STD_CAN_ID_MASK
    };

    let dlc_nibble = decode_hex_nibble(rest[id_chars])?;
    let payload_hex = &rest[id_chars + 1..];

    let payload_len: usize = if is_fd {
        usize::from(*CAN_FD_DLC_LEN_TABLE.get(usize::from(dlc_nibble))?)
    } else {
        if usize::from(dlc_nibble) > MAX_CLASSICAL_CAN_DLC {
            return None;
        }
        usize::from(dlc_nibble)
    };

    let mut data = [0u8; MAX_CAN_FD_DLC];
    if !is_rtr {
        let needed_hex = payload_len * 2;
        // Allow optional 4-hex-digit Lawicel millisecond timestamp suffix (`ZZZZ`), reject truncated lines.
        if payload_hex.len() != needed_hex && payload_hex.len() != needed_hex + 4 {
            return None;
        }
        for i in 0..payload_len {
            let hi = decode_hex_nibble(payload_hex[i * 2])?;
            let lo = decode_hex_nibble(payload_hex[i * 2 + 1])?;
            data[i] = (hi << 4) | lo;
        }
    }

    let id_key = if is_extended {
        CanIdKey::Extended(arb_id)
    } else {
        CanIdKey::Standard(arb_id as u16)
    };

    if is_rtr {
        RawCanFrame::new_rtr(bus_id, id_key, payload_len as u8, timestamp_us).ok()
    } else if is_fd {
        RawCanFrame::new_fd(bus_id, id_key, &data[..payload_len], is_brs, timestamp_us).ok()
    } else {
        RawCanFrame::new_classical(bus_id, id_key, &data[..payload_len], timestamp_us).ok()
    }
}

/// Zero-allocation formatter encoding a [`RawCanFrame`] into a Lawicel SLCAN ASCII command terminated by `\r`.
pub fn encode_slcan_frame(
    frame: &RawCanFrame,
    out_buf: &mut [u8; MAX_SLCAN_ASCII_LEN],
) -> Result<usize, AdapterError> {
    let payload_len = usize::from(frame.dlc);
    if !frame.is_fd() && payload_len > MAX_CLASSICAL_CAN_DLC {
        return Err(AdapterError::UnsupportedCapability(format!(
            "Classical SLCAN frame length {} exceeds 8 bytes",
            payload_len
        )));
    }
    if payload_len > MAX_CAN_FD_DLC {
        return Err(AdapterError::UnsupportedCapability(format!(
            "CAN-FD SLCAN frame length {} exceeds 64 bytes",
            payload_len
        )));
    }

    let mut pos = 0usize;
    let cmd = if frame.is_fd() {
        match (frame.is_extended(), frame.is_brs()) {
            (false, false) => b'd',
            (true, false) => b'D',
            (false, true) => b'b',
            (true, true) => b'B',
        }
    } else if frame.is_rtr() {
        if frame.is_extended() {
            b'R'
        } else {
            b'r'
        }
    } else if frame.is_extended() {
        b'T'
    } else {
        b't'
    };
    out_buf[pos] = cmd;
    pos += 1;

    if frame.is_extended() {
        let id = frame.arb_id & EXT_CAN_ID_MASK;
        for shift in (0..8).rev() {
            let nib = ((id >> (shift * 4)) & 0xF) as usize;
            out_buf[pos] = HEX_UPPER[nib];
            pos += 1;
        }
    } else {
        let id = frame.arb_id & STD_CAN_ID_MASK;
        for shift in (0..3).rev() {
            let nib = ((id >> (shift * 4)) & 0xF) as usize;
            out_buf[pos] = HEX_UPPER[nib];
            pos += 1;
        }
    }

    let (dlc_code, wire_len) = if frame.is_fd() {
        fd_len_to_dlc_code(payload_len)
    } else {
        (frame.dlc, payload_len)
    };
    out_buf[pos] = HEX_UPPER[usize::from(dlc_code & 0xF)];
    pos += 1;

    if !frame.is_rtr() {
        for i in 0..wire_len {
            let b = if i < payload_len { frame.data[i] } else { 0 };
            out_buf[pos] = HEX_UPPER[usize::from(b >> 4)];
            out_buf[pos + 1] = HEX_UPPER[usize::from(b & 0xF)];
            pos += 2;
        }
    }

    out_buf[pos] = b'\r';
    pos += 1;
    Ok(pos)
}

/// HIGH-01: canonical USB-serial / COM port names accepted for SLCAN even when the OS
/// enumeration does not list them (yet): `/dev/ttyUSB<n>`, `/dev/ttyACM<n>`,
/// `/dev/serial/by-id/<name>`, macOS `/dev/cu.<name>` / `/dev/tty.usb<name>`, Windows
/// `COM<n>` (optionally `\\.\COM<n>`). Anything else (`/dev/mem`, `/dev/sda`, files,
/// `..` traversal, nested paths) is rejected.
pub fn is_canonical_serial_port_name(name: &str) -> bool {
    fn digits(s: &str) -> bool {
        !s.is_empty() && s.len() <= 4 && s.bytes().all(|b| b.is_ascii_digit())
    }
    fn simple_component(s: &str) -> bool {
        !s.is_empty()
            && s.len() <= 200
            && s != "."
            && s != ".."
            && !s.contains("..")
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b':' | b'+'))
    }
    if let Some(n) = name
        .strip_prefix("/dev/ttyUSB")
        .or_else(|| name.strip_prefix("/dev/ttyACM"))
    {
        return digits(n);
    }
    if let Some(rest) = name.strip_prefix("/dev/serial/by-id/") {
        return simple_component(rest);
    }
    if let Some(rest) = name.strip_prefix("/dev/cu.") {
        return simple_component(rest);
    }
    if let Some(rest) = name.strip_prefix("/dev/tty.usb") {
        return rest.is_empty() || simple_component(rest);
    }
    let win = name.strip_prefix(r"\\.\").unwrap_or(name);
    if win.len() > 3 && win[..3].eq_ignore_ascii_case("COM") {
        return digits(&win[3..]);
    }
    false
}

/// HIGH-01: only ports enumerated by the OS (`serialport::available_ports()` / our sysfs
/// scan) or canonical USB-serial / COM names may be opened as SLCAN adapters.
fn validate_slcan_port(port: &str) -> Result<(), AdapterError> {
    if is_canonical_serial_port_name(port) {
        return Ok(());
    }
    let listed = serialport::available_ports()
        .map(|ports| ports.iter().any(|p| p.port_name == port))
        .unwrap_or(false)
        || discover_serial_ports().iter().any(|p| p.port_name == port);
    if listed {
        return Ok(());
    }
    Err(AdapterError::Driver(format!(
        "Refusing to open '{port}' as an SLCAN adapter: not an enumerated serial port and not a \
         canonical USB-serial name (/dev/ttyUSB*, /dev/ttyACM*, /dev/serial/by-id/*, /dev/cu.*, \
         /dev/tty.usb*, COMn)"
    )))
}

/// Enumerates host serial / USB-CDC ports across Windows, macOS, and Linux (enriching sysfs USB metadata without `libudev`).
pub fn discover_serial_ports() -> Vec<SerialPortInfoDto> {
    let mut by_name: BTreeMap<String, SerialPortInfoDto> = BTreeMap::new();

    if let Ok(ports) = serialport::available_ports() {
        for p in ports {
            #[cfg(target_os = "linux")]
            if is_unpopulated_linux_8250_port(&p.port_name) {
                continue;
            }

            // `mut` is only used by the Linux sysfs enrichment below.
            #[cfg_attr(not(target_os = "linux"), allow(unused_mut))]
            let mut info = match p.port_type {
                SerialPortType::UsbPort(usb) => SerialPortInfoDto {
                    port_name: p.port_name.clone(),
                    port_type: "USB-CDC".to_string(),
                    vid_pid: Some(format!("{:04X}:{:04X}", usb.vid, usb.pid)),
                    manufacturer: usb.manufacturer,
                    product: usb.product,
                },
                SerialPortType::PciPort => SerialPortInfoDto {
                    port_name: p.port_name.clone(),
                    port_type: "PCI-UART".to_string(),
                    vid_pid: None,
                    manufacturer: None,
                    product: None,
                },
                SerialPortType::BluetoothPort => SerialPortInfoDto {
                    port_name: p.port_name.clone(),
                    port_type: "Bluetooth".to_string(),
                    vid_pid: None,
                    manufacturer: None,
                    product: None,
                },
                SerialPortType::Unknown => SerialPortInfoDto {
                    port_name: p.port_name.clone(),
                    port_type: "Serial".to_string(),
                    vid_pid: None,
                    manufacturer: None,
                    product: None,
                },
            };

            #[cfg(target_os = "linux")]
            enrich_linux_sysfs_usb_metadata(&mut info);

            by_name.insert(p.port_name, info);
        }
    }

    #[cfg(target_os = "linux")]
    scan_linux_tty_devices(&mut by_name);

    by_name.into_values().collect()
}

#[cfg(target_os = "linux")]
fn is_unpopulated_linux_8250_port(port_name: &str) -> bool {
    let Some(tty_name) = port_name.strip_prefix("/dev/") else {
        return false;
    };
    if !tty_name.starts_with("ttyS") {
        return false;
    }
    let sys_type = std::path::Path::new("/sys/class/tty")
        .join(tty_name)
        .join("type");
    match std::fs::read_to_string(sys_type) {
        Ok(s) => s.trim() == "0",
        Err(_) => true,
    }
}

#[cfg(target_os = "linux")]
fn enrich_linux_sysfs_usb_metadata(info: &mut SerialPortInfoDto) {
    let tty_name = info
        .port_name
        .strip_prefix("/dev/")
        .unwrap_or(info.port_name.as_str());
    if tty_name.starts_with("ttyUSB") || tty_name.starts_with("ttyACM") {
        info.port_type = "USB-CDC".to_string();
    }

    let dev_link = std::path::Path::new("/sys/class/tty")
        .join(tty_name)
        .join("device");
    let Ok(canon) = std::fs::canonicalize(dev_link) else {
        return;
    };

    let mut cur: Option<&std::path::Path> = Some(canon.as_path());
    for _ in 0..4 {
        let Some(dir) = cur else { break };
        let vid = std::fs::read_to_string(dir.join("idVendor"))
            .ok()
            .map(|s| s.trim().to_ascii_uppercase())
            .filter(|s| !s.is_empty());
        let pid = std::fs::read_to_string(dir.join("idProduct"))
            .ok()
            .map(|s| s.trim().to_ascii_uppercase())
            .filter(|s| !s.is_empty());
        if let (Some(v), Some(p)) = (vid, pid) {
            info.port_type = "USB-CDC".to_string();
            if info.vid_pid.is_none() {
                info.vid_pid = Some(format!("{v}:{p}"));
            }
            if info.manufacturer.is_none() {
                info.manufacturer = std::fs::read_to_string(dir.join("manufacturer"))
                    .ok()
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty());
            }
            if info.product.is_none() {
                info.product = std::fs::read_to_string(dir.join("product"))
                    .ok()
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty());
            }
            break;
        }
        cur = dir.parent();
    }
}

#[cfg(target_os = "linux")]
fn scan_linux_tty_devices(by_name: &mut BTreeMap<String, SerialPortInfoDto>) {
    if let Ok(entries) = std::fs::read_dir("/dev") {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("ttyUSB") || name.starts_with("ttyACM") {
                let full_path = format!("/dev/{name}");
                by_name.entry(full_path.clone()).or_insert_with(|| {
                    let mut info = SerialPortInfoDto {
                        port_name: full_path,
                        port_type: "USB-CDC".to_string(),
                        vid_pid: None,
                        manufacturer: None,
                        product: None,
                    };
                    enrich_linux_sysfs_usb_metadata(&mut info);
                    info
                });
            }
        }
    }

    if let Ok(entries) = std::fs::read_dir("/sys/class/tty") {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !(name.starts_with("ttyUSB") || name.starts_with("ttyACM")) {
                continue;
            }
            if !entry.path().join("device").exists() {
                continue;
            }
            let full_path = format!("/dev/{name}");
            by_name.entry(full_path.clone()).or_insert_with(|| {
                let mut info = SerialPortInfoDto {
                    port_name: full_path,
                    port_type: "USB-CDC".to_string(),
                    vid_pid: None,
                    manufacturer: None,
                    product: None,
                };
                enrich_linux_sysfs_usb_metadata(&mut info);
                info
            });
        }
    }
}

/// Cross-OS Lawicel `SLCAN` driver (`CAN232`, `USBtin`, `CANable` SLCAN firmware, STM32 USB-CDC).
#[derive(Clone, Copy, Debug, Default)]
pub struct SlcanDriver;

impl SlcanDriver {
    /// Creates a new [`SlcanDriver`].
    pub const fn new() -> Self {
        Self
    }

    /// Constructs a [`DeviceDescriptor`] for an arbitrary (discovered or manually entered) serial port.
    pub fn descriptor_for_port(port_name: &str) -> DeviceDescriptor {
        let trimmed = port_name.trim();
        DeviceDescriptorDto {
            device_id: format!("slcan:{trimmed}"),
            driver_id: "slcan".to_string(),
            channel_name: trimmed.to_string(),
            display_name: format!("{trimmed} — Serial / USB-CDC Lawicel SLCAN"),
            capabilities: AdapterCapabilitiesDto {
                supports_fd: true,
                supports_listen_only: true,
                supports_hw_timestamps: false,
                max_bitrate: 1_000_000,
                is_virtual: false,
            },
        }
    }
}

impl AdapterDriver for SlcanDriver {
    fn driver_id(&self) -> &'static str {
        "slcan"
    }

    fn display_name(&self) -> &'static str {
        "Serial / USB-CDC Lawicel SLCAN"
    }

    fn discover_devices(&self) -> Result<Vec<DeviceDescriptor>, AdapterError> {
        let ports = discover_serial_ports();
        let mut out = Vec::with_capacity(ports.len());
        for p in ports {
            let label_suffix = match (&p.product, &p.vid_pid) {
                (Some(prod), Some(vp)) => format!("SLCAN {prod} ({vp})"),
                (Some(prod), None) => format!("SLCAN {prod}"),
                (None, Some(vp)) => format!("SLCAN USB-CDC ({vp})"),
                (None, None) => format!("Lawicel SLCAN ({})", p.port_type),
            };
            out.push(DeviceDescriptorDto {
                device_id: format!("slcan:{}", p.port_name),
                driver_id: "slcan".to_string(),
                channel_name: p.port_name.clone(),
                display_name: format!("{} — {label_suffix}", p.port_name),
                capabilities: AdapterCapabilitiesDto {
                    supports_fd: true,
                    supports_listen_only: true,
                    supports_hw_timestamps: false,
                    max_bitrate: 1_000_000,
                    is_virtual: false,
                },
            });
        }
        Ok(out)
    }

    fn open_channel(
        &self,
        device: &DeviceDescriptor,
        config: &ChannelConfig,
    ) -> Result<Box<dyn CanChannel>, AdapterError> {
        let resolved_port = config
            .serial_port
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .or_else(|| {
                let ch = device.channel_name.trim();
                if !ch.is_empty() {
                    Some(ch)
                } else {
                    device.device_id.strip_prefix("slcan:").map(str::trim)
                }
            })
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                AdapterError::Driver(
                    "SLCAN serial port is required (e.g. COM3, /dev/ttyUSB0, or /dev/ttyACM0)"
                        .to_string(),
                )
            })?
            .to_string();

        validate_slcan_port(&resolved_port)?;

        let baud_rate = config.serial_baud_rate.unwrap_or(1_000_000).max(9_600);
        let assert_dtr_rts = config.serial_dtr_rts.unwrap_or(true);

        let mut port = serialport::new(&resolved_port, baud_rate)
            .timeout(Duration::from_millis(5))
            .open()
            .map_err(|e| {
                AdapterError::Driver(format!(
                    "Failed to open SLCAN serial port '{resolved_port}' at {baud_rate} baud: {e}"
                ))
            })?;

        let _ = port.write_data_terminal_ready(assert_dtr_rts);
        let _ = port.write_request_to_send(assert_dtr_rts);
        let _ = port.clear(ClearBuffer::All);

        // On `Err` the port is dropped here, i.e. closed (WP-5 fail-closed path included).
        let listen_only_enforcement =
            slcan_open_handshake(&mut *port, config, &resolved_port, LAWICEL_TIMING)?;

        let mut actual_desc = device.clone();
        if actual_desc.channel_name != resolved_port {
            actual_desc = Self::descriptor_for_port(&resolved_port);
        }

        Ok(Box::new(SlcanChannel {
            descriptor: actual_desc,
            bus_id: config.bus_id,
            listen_only: config.listen_only,
            listen_only_enforcement,
            closed: false,
            port: Some(port),
            current_timeout_ms: 5,
            rx_chunk: [0u8; 512],
            line_buf: [0u8; 256],
            line_len: 0,
            queued: [RawCanFrame::zeroed(); INTERNAL_QUEUE_CAP],
            queued_head: 0,
            queued_len: 0,
            filters: Vec::new(),
            tx_errors: 0,
            rx_errors: 0,
        }))
    }
}

/// Zero-allocation hot-path Lawicel SLCAN channel.
pub struct SlcanChannel {
    descriptor: DeviceDescriptor,
    bus_id: BusId,
    listen_only: bool,
    /// Result of the `L` handshake (see `slcan_open_handshake`).
    listen_only_enforcement: ListenOnlyEnforcement,
    closed: bool,
    port: Option<Box<dyn SerialPort>>,
    current_timeout_ms: u32,
    rx_chunk: [u8; 512],
    line_buf: [u8; 256],
    line_len: usize,
    queued: [RawCanFrame; INTERNAL_QUEUE_CAP],
    queued_head: usize,
    queued_len: usize,
    filters: Vec<CanFilter>,
    tx_errors: u32,
    rx_errors: u32,
}

impl SlcanChannel {
    #[inline]
    fn matches_filters(&self, frame: &RawCanFrame) -> bool {
        if self.filters.is_empty() {
            return true;
        }
        self.filters.iter().any(|f| {
            let ext_ok = match f.extended {
                Some(ext) => frame.is_extended() == ext,
                None => true,
            };
            ext_ok && ((frame.arb_id & f.mask) == (f.id & f.mask))
        })
    }

    #[inline]
    fn push_queued(&mut self, frame: RawCanFrame) {
        if self.queued_len < INTERNAL_QUEUE_CAP {
            let idx = (self.queued_head + self.queued_len) % INTERNAL_QUEUE_CAP;
            self.queued[idx] = frame;
            self.queued_len += 1;
        } else {
            self.rx_errors = self.rx_errors.saturating_add(1);
        }
    }

    #[inline]
    fn pop_queued(&mut self) -> Option<RawCanFrame> {
        if self.queued_len == 0 {
            return None;
        }
        let f = self.queued[self.queued_head];
        self.queued_head = (self.queued_head + 1) % INTERNAL_QUEUE_CAP;
        self.queued_len -= 1;
        Some(f)
    }
}

impl CanChannel for SlcanChannel {
    fn descriptor(&self) -> &DeviceDescriptor {
        &self.descriptor
    }

    fn capabilities(&self) -> &AdapterCapabilities {
        &self.descriptor.capabilities
    }

    fn close(&mut self) -> Result<(), AdapterError> {
        self.closed = true;
        if let Some(mut port) = self.port.take() {
            let _ = port.write_all(b"C\r");
            let _ = port.flush();
        }
        Ok(())
    }

    fn recv_batch(
        &mut self,
        out_batch: &mut [RawCanFrame],
        timeout_ms: u32,
    ) -> Result<usize, AdapterError> {
        if self.closed {
            return Err(AdapterError::ChannelClosed);
        }
        if out_batch.is_empty() {
            return Ok(0);
        }

        let mut written = 0usize;
        while written < out_batch.len() {
            let Some(frame) = self.pop_queued() else {
                break;
            };
            out_batch[written] = frame;
            written += 1;
        }
        if written == out_batch.len() {
            return Ok(written);
        }

        let clamped_timeout = timeout_ms.clamp(1, 10);
        if clamped_timeout != self.current_timeout_ms {
            if let Some(port) = self.port.as_mut() {
                let _ = port.set_timeout(Duration::from_millis(u64::from(clamped_timeout)));
                self.current_timeout_ms = clamped_timeout;
            }
        }

        let n_read = {
            let port = self.port.as_mut().ok_or(AdapterError::ChannelClosed)?;
            match port.read(&mut self.rx_chunk) {
                Ok(n) => n,
                Err(e)
                    if e.kind() == io::ErrorKind::TimedOut
                        || e.kind() == io::ErrorKind::WouldBlock =>
                {
                    0
                }
                Err(e) => return Err(AdapterError::Io(e)),
            }
        };

        if n_read == 0 {
            return Ok(written);
        }

        let ts_us = now_monotonic_us().max(1);
        for i in 0..n_read {
            let byte = self.rx_chunk[i];
            match byte {
                b'\r' | b'\n' => {
                    if self.line_len > 0 {
                        let parsed =
                            parse_slcan_line(&self.line_buf[..self.line_len], self.bus_id, ts_us);
                        self.line_len = 0;
                        match parsed {
                            Some(frame) => {
                                if self.matches_filters(&frame) {
                                    if written < out_batch.len() {
                                        out_batch[written] = frame;
                                        written += 1;
                                    } else {
                                        self.push_queued(frame);
                                    }
                                }
                            }
                            None => {
                                self.rx_errors = self.rx_errors.saturating_add(1);
                            }
                        }
                    }
                }
                b'\x07' => {
                    // Lawicel BELL (NACK)
                    self.line_len = 0;
                    self.tx_errors = self.tx_errors.saturating_add(1);
                }
                _ => {
                    if self.line_len < self.line_buf.len() {
                        self.line_buf[self.line_len] = byte;
                        self.line_len += 1;
                    } else {
                        // Malformed oversized line: discard without allocating.
                        self.line_len = 0;
                        self.rx_errors = self.rx_errors.saturating_add(1);
                    }
                }
            }
        }

        Ok(written)
    }

    fn send_frame(&mut self, frame: &RawCanFrame) -> Result<(), AdapterError> {
        if self.closed {
            return Err(AdapterError::ChannelClosed);
        }
        if self.listen_only {
            return Err(AdapterError::ListenOnlyMode);
        }

        let mut wire_buf = [0u8; MAX_SLCAN_ASCII_LEN];
        let encoded_len = encode_slcan_frame(frame, &mut wire_buf)?;

        let port = self.port.as_mut().ok_or(AdapterError::ChannelClosed)?;
        if let Err(e) = port.write_all(&wire_buf[..encoded_len]) {
            self.tx_errors = self.tx_errors.saturating_add(1);
            return Err(AdapterError::Io(e));
        }
        Ok(())
    }

    fn set_filters(&mut self, filters: &[CanFilter]) -> Result<(), AdapterError> {
        self.filters.clear();
        self.filters.extend_from_slice(filters);
        Ok(())
    }

    /// `Hardware` only when the adapter acknowledged the Lawicel `L` command with `CR`;
    /// `SoftwareOnly` when it refused / ignored `L` and the channel was opened with `O`
    /// (software TX lock only; see `slcan_open_handshake`).
    fn listen_only_enforcement(&self) -> ListenOnlyEnforcement {
        self.listen_only_enforcement
    }

    fn health(&self) -> BusHealthSnapshot {
        let state = if self.closed {
            BusState::Disconnected
        } else if self.tx_errors >= 128 || self.rx_errors >= 128 {
            BusState::Passive
        } else if self.tx_errors >= 32 || self.rx_errors >= 32 {
            BusState::Warning
        } else {
            BusState::Active
        };
        BusHealthSnapshot {
            state,
            tx_error_count: self.tx_errors,
            rx_error_count: self.rx_errors,
        }
    }
}

impl Drop for SlcanChannel {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_serial_port_names_allowlist() {
        for ok in [
            "/dev/ttyUSB0",
            "/dev/ttyACM12",
            "/dev/serial/by-id/usb-CANable_2.0_ABC123-if00",
            "/dev/cu.usbmodem14101",
            "/dev/tty.usbserial-A1B2",
            "COM3",
            "com17",
            r"\\.\COM12",
        ] {
            assert!(is_canonical_serial_port_name(ok), "{ok} must be accepted");
        }
        for bad in [
            "",
            "/dev/mem",
            "/dev/sda",
            "/dev/ttyS0",
            "/dev/ttyUSB",
            "/dev/ttyUSB0/../../mem",
            "/dev/serial/by-id/../../sda",
            "/dev/serial/by-id/a/b",
            "/dev/cu.",
            "/etc/passwd",
            "COM",
            "COM1;rm",
            "CON",
            "../COM3",
        ] {
            assert!(
                !is_canonical_serial_port_name(bad),
                "{bad} must be rejected"
            );
        }
    }

    /// Reply script for one command: bytes (`None` = never answers) released after
    /// `delay_reads` further `read` calls (0 = immediately).
    #[derive(Clone, Copy)]
    struct Scripted {
        bytes: Option<&'static [u8]>,
        delay_reads: usize,
    }

    /// Scripted Lawicel adapter: replies per command (default: immediate `CR`), optional
    /// pre-loaded / continuous frame stream, records everything written.
    struct ScriptedPort {
        replies: std::collections::HashMap<&'static str, Scripted>,
        written: Vec<u8>,
        pending: std::collections::VecDeque<u8>,
        cmd_buf: Vec<u8>,
        /// Frame line appended on every `read` while streaming.
        stream_line: Option<&'static [u8]>,
        /// `true`: the stream stops once `C\r` is received (adapter honours close).
        stream_stops_on_close: bool,
        reads: usize,
        /// `(release at read count, bytes)`.
        scheduled: Vec<(usize, &'static [u8])>,
    }

    impl ScriptedPort {
        fn new(l_reply: Option<&'static [u8]>) -> Self {
            let mut port = Self {
                replies: std::collections::HashMap::new(),
                written: Vec::new(),
                pending: std::collections::VecDeque::new(),
                cmd_buf: Vec::new(),
                stream_line: None,
                stream_stops_on_close: true,
                reads: 0,
                scheduled: Vec::new(),
            };
            port.replies.insert(
                "L",
                Scripted {
                    bytes: l_reply,
                    delay_reads: 0,
                },
            );
            port
        }
        /// Overrides the reply to `cmd` (without `\r`).
        fn reply(mut self, cmd: &'static str, bytes: Option<&'static [u8]>, delay: usize) -> Self {
            self.replies.insert(
                cmd,
                Scripted {
                    bytes,
                    delay_reads: delay,
                },
            );
            self
        }
        /// Bytes already waiting in the input buffer (arrived after `clear()`).
        fn preload(mut self, line: &[u8], count: usize) -> Self {
            for _ in 0..count {
                self.pending.extend(line);
            }
            self
        }
        /// Continuous frame stream from an adapter left open (`O`) by a crashed session.
        fn streaming(mut self, line: &'static [u8], stops_on_close: bool) -> Self {
            self.stream_line = Some(line);
            self.stream_stops_on_close = stops_on_close;
            self
        }
        /// Commands written, in order, as strings without `\r`.
        fn commands(&self) -> Vec<String> {
            self.written
                .split(|&b| b == b'\r')
                .filter(|c| !c.is_empty())
                .map(|c| String::from_utf8_lossy(c).into_owned())
                .collect()
        }
    }

    impl Write for ScriptedPort {
        fn write(&mut self, data: &[u8]) -> io::Result<usize> {
            for &b in data {
                self.written.push(b);
                self.cmd_buf.push(b);
                if b == b'\r' {
                    let cmd = String::from_utf8_lossy(&self.cmd_buf[..self.cmd_buf.len() - 1])
                        .into_owned();
                    if cmd == "C" && self.stream_stops_on_close {
                        self.stream_line = None;
                    }
                    let s = self.replies.get(cmd.as_str()).copied().unwrap_or(Scripted {
                        bytes: Some(b"\r"),
                        delay_reads: 0,
                    });
                    if let Some(bytes) = s.bytes {
                        if s.delay_reads == 0 {
                            self.pending.extend(bytes);
                        } else {
                            self.scheduled.push((self.reads + s.delay_reads, bytes));
                        }
                    }
                    self.cmd_buf.clear();
                }
            }
            Ok(data.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    impl Read for ScriptedPort {
        fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
            self.reads += 1;
            let reads = self.reads;
            let mut i = 0;
            while i < self.scheduled.len() {
                if self.scheduled[i].0 <= reads {
                    let (_, bytes) = self.scheduled.remove(i);
                    self.pending.extend(bytes);
                } else {
                    i += 1;
                }
            }
            if let Some(line) = self.stream_line {
                self.pending.extend(line);
            }
            if self.pending.is_empty() {
                std::thread::sleep(Duration::from_millis(1));
                return Err(io::Error::new(io::ErrorKind::TimedOut, "timeout"));
            }
            let n = out.len().min(self.pending.len());
            for slot in out.iter_mut().take(n) {
                *slot = self.pending.pop_front().unwrap_or_default();
            }
            Ok(n)
        }
    }

    const TEST_TIMING: HandshakeTiming = HandshakeTiming {
        reply_window: Duration::from_millis(15),
        drain_quiet: Duration::from_millis(5),
        drain_cap: Duration::from_millis(40),
    };

    fn run(
        mut port: ScriptedPort,
        listen_only: bool,
        require_hw: bool,
        enable_fd: bool,
    ) -> (Result<ListenOnlyEnforcement, AdapterError>, Vec<String>) {
        let cfg = ChannelConfig {
            listen_only,
            require_hardware_listen_only: require_hw,
            enable_fd,
            ..ChannelConfig::default()
        };
        let r = slcan_open_handshake(&mut port, &cfg, "COM9", TEST_TIMING);
        (r, port.commands())
    }

    fn handshake(
        l_reply: Option<&'static [u8]>,
        listen_only: bool,
        require_hw: bool,
    ) -> (Result<ListenOnlyEnforcement, AdapterError>, Vec<String>) {
        run(ScriptedPort::new(l_reply), listen_only, require_hw, false)
    }

    /// Asserts "not Hardware": `Err(fail-closed)` with the flag, `SoftwareOnly` (via `C`, `O`)
    /// without it.
    fn assert_not_hardware(
        (r, cmds): (Result<ListenOnlyEnforcement, AdapterError>, Vec<String>),
        require_hw: bool,
        what: &str,
    ) {
        if require_hw {
            let err = r.expect_err(what);
            assert!(err.is_hw_listen_only_unavailable(), "{what}: {err}");
            assert!(!cmds.iter().any(|c| c == "O"), "{what}: never O: {cmds:?}");
            assert_eq!(
                cmds.last().map(String::as_str),
                Some("C"),
                "{what}: {cmds:?}"
            );
        } else {
            assert_eq!(
                r.expect(what),
                ListenOnlyEnforcement::SoftwareOnly,
                "{what}"
            );
            assert!(
                cmds.ends_with(&["C".into(), "O".into()]),
                "{what}: {cmds:?}"
            );
        }
    }

    #[test]
    fn l_acked_with_cr_is_hardware() {
        for require in [false, true] {
            let (r, cmds) = handshake(Some(b"\r"), true, require);
            assert_eq!(r.expect("open"), ListenOnlyEnforcement::Hardware);
            assert_eq!(cmds, ["C", "S6", "L"], "never falls back to O");
        }
    }

    #[test]
    fn l_refused_or_unanswered_falls_back_to_software_only_without_flag() {
        for reply in [Some(&b"\x07"[..]), None] {
            let (r, cmds) = handshake(reply, true, false);
            assert_eq!(
                r.expect("opens"),
                ListenOnlyEnforcement::SoftwareOnly,
                "{reply:?}"
            );
            assert_eq!(cmds, ["C", "S6", "L", "C", "O"], "{reply:?}");
        }
    }

    #[test]
    fn l_refused_or_unanswered_is_fail_closed_with_flag() {
        for reply in [Some(&b"\x07"[..]), None] {
            let (r, cmds) = handshake(reply, true, true);
            let err = r.expect_err("must refuse");
            assert!(err.is_hw_listen_only_unavailable(), "{err}");
            assert!(
                err.to_string()
                    .contains("Lawicel listen-only command (`L`)"),
                "{err}"
            );
            assert_eq!(cmds, ["C", "S6", "L", "C"], "never opens with O: {reply:?}");
        }
    }

    #[test]
    fn l_reply_acceptance_is_strict() {
        // Echoed command, then a bare CR: accepted.
        assert_eq!(
            handshake(Some(b"L\r\r"), true, true).0.expect("ok"),
            ListenOnlyEnforcement::Hardware
        );
        assert!(handshake(Some(b"L\r\x07"), true, true).0.is_err());
        // Only the echo: not an acknowledgement.
        assert!(handshake(Some(b"L\r"), true, true).0.is_err());
        // Stray bytes before CR are NOT an acknowledgement for `L` any more.
        assert_not_hardware(handshake(Some(b"zz\r"), true, true), true, "zz");
        assert_not_hardware(handshake(Some(b"zz\r"), true, false), false, "zz");
        // Echo twice is not "echo + bare CR".
        assert!(handshake(Some(b"L\rL\r\r"), true, true).0.is_err());
        // CR beyond the 16-byte scan bound is not accepted.
        assert!(handshake(Some(b"0123456789ABCDEF\r"), true, true)
            .0
            .is_err());
    }

    /// (f) A received-frame line terminated by CR is never `L`'s acknowledgement.
    #[test]
    fn frame_line_before_cr_is_not_l_ack() {
        for reply in [
            &b"t123\r"[..],
            b"T1234567811\r",
            b"r1230\r",
            b"b1230\r",
            b"L\rt123\r",
        ] {
            for require in [true, false] {
                let what = String::from_utf8_lossy(reply).into_owned();
                assert_not_hardware(handshake(Some(reply), true, require), require, &what);
            }
        }
    }

    /// (a) Adapter left open by a crashed session keeps delivering `t1000\r` lines after
    /// `clear()`; `L` answered by BEL. Previously these lines were taken as the replies to
    /// `C` / `S6` / `L` and `Hardware` was reported.
    #[test]
    fn frame_stream_with_l_refused_is_fail_closed_with_flag() {
        // Backlog only (adapter honours `C`).
        let backlog = ScriptedPort::new(Some(b"\x07")).preload(b"t1000\r", 40);
        let (r, cmds) = run(backlog, true, true, false);
        let err = r.expect_err("backlog: must refuse");
        assert!(err.is_hw_listen_only_unavailable(), "{err}");
        assert!(!cmds.iter().any(|c| c == "O"), "{cmds:?}");
        assert_eq!(cmds, ["C", "S6", "L", "C"]);

        // Backlog plus a stream that `C` does stop.
        let stopped = ScriptedPort::new(Some(b"\x07"))
            .preload(b"t1000\r", 40)
            .streaming(b"t1000\r", true);
        let (r, cmds) = run(stopped, true, true, false);
        assert!(r
            .expect_err("stopped stream")
            .is_hw_listen_only_unavailable());
        assert!(!cmds.iter().any(|c| c == "O"), "{cmds:?}");

        // Adapter ignores `C` and never stops streaming: `L` is not even sent.
        let endless = ScriptedPort::new(Some(b"\x07"))
            .preload(b"t1000\r", 40)
            .streaming(b"t1000\r", false);
        let (r, cmds) = run(endless, true, true, false);
        let err = r.expect_err("endless stream: must refuse");
        assert!(err.is_hw_listen_only_unavailable(), "{err}");
        assert!(err.to_string().contains("never went quiet"), "{err}");
        assert_eq!(cmds, ["C", "S6", "C"], "no L, never O");
    }

    /// (b) Same streams without the flag: `SoftwareOnly`, opened via `C`, `O`.
    #[test]
    fn frame_stream_without_flag_falls_back_to_software_only() {
        let backlog = ScriptedPort::new(Some(b"\x07")).preload(b"t1000\r", 40);
        let (r, cmds) = run(backlog, true, false, false);
        assert_eq!(r.expect("opens"), ListenOnlyEnforcement::SoftwareOnly);
        assert_eq!(cmds, ["C", "S6", "L", "C", "O"]);

        let endless = ScriptedPort::new(Some(b"\x07"))
            .preload(b"t1000\r", 40)
            .streaming(b"t1000\r", false);
        let (r, cmds) = run(endless, true, false, false);
        assert_eq!(r.expect("opens"), ListenOnlyEnforcement::SoftwareOnly);
        assert_eq!(cmds, ["C", "S6", "C", "O"]);
    }

    /// Even an adapter that would ACK `L` is not trusted while frames are streaming.
    #[test]
    fn frame_stream_never_yields_hardware_even_if_l_acked() {
        for stops in [true, false] {
            for require in [true, false] {
                let port = ScriptedPort::new(Some(b"\r"))
                    .preload(b"t1000\r", 40)
                    .streaming(b"t1000\r", stops);
                assert_not_hardware(
                    run(port, true, require, false),
                    require,
                    &format!("stops_on_close={stops}"),
                );
            }
        }
    }

    /// (c) `S6`'s CR arrives after its reply window (would previously shift into `L`'s reply).
    #[test]
    fn late_setup_reply_never_yields_hardware() {
        for l_reply in [&b"\x07"[..], b"\r"] {
            for require in [true, false] {
                let port = ScriptedPort::new(Some(l_reply)).reply("S6", Some(b"\r"), 40);
                let (r, cmds) = run(port, true, require, false);
                assert!(
                    !matches!(r, Ok(ListenOnlyEnforcement::Hardware)),
                    "{l_reply:?} require={require}: {r:?}"
                );
                assert_not_hardware((r, cmds), require, "late S6");
            }
        }
        // `L` CR after a late setup reply: the error names the distrusted setup.
        let port = ScriptedPort::new(Some(b"\r")).reply("S6", Some(b"\r"), 40);
        let err = run(port, true, true, false).0.expect_err("refuse");
        assert!(err.to_string().contains("earlier setup command"), "{err}");
    }

    /// (d) A NACKed (or unanswered) setup command makes a later `L` CR untrustworthy.
    #[test]
    fn nacked_setup_command_distrusts_l_ack() {
        let cases: [(&'static str, Option<&'static [u8]>, bool); 5] = [
            ("C", Some(b"\x07"), false),
            ("S6", Some(b"\x07"), false),
            ("S6", None, false),
            ("Y2", Some(b"\x07"), true),
            ("S6", Some(b"t1000\r"), false),
        ];
        for (cmd, reply, fd) in cases {
            for require in [true, false] {
                let port = ScriptedPort::new(Some(b"\r")).reply(cmd, reply, 0);
                let what = format!("{cmd} -> {reply:?} require={require}");
                assert_not_hardware(run(port, true, require, fd), require, &what);
            }
        }
    }

    /// (e) A clean adapter is unaffected by the drains: `Hardware`, unchanged sequence.
    #[test]
    fn clean_adapter_is_hardware_with_unchanged_sequence() {
        let (r, cmds) = run(ScriptedPort::new(Some(b"\r")), true, true, false);
        assert_eq!(r.expect("open"), ListenOnlyEnforcement::Hardware);
        assert_eq!(cmds, ["C", "S6", "L"]);
        let (r, cmds) = run(ScriptedPort::new(Some(b"\r")), true, true, true);
        assert_eq!(r.expect("open fd"), ListenOnlyEnforcement::Hardware);
        assert_eq!(cmds, ["C", "S6", "Y2", "L"]);
        // Echoing firmware (every command echoed, then CR).
        let echo = ScriptedPort::new(Some(b"L\r\r"))
            .reply("C", Some(b"C\r\r"), 0)
            .reply("S6", Some(b"S6\r\r"), 0);
        let (r, cmds) = run(echo, true, true, false);
        assert_eq!(r.expect("echo"), ListenOnlyEnforcement::Hardware);
        assert_eq!(cmds, ["C", "S6", "L"]);
    }

    #[test]
    fn drain_until_quiet_respects_quiet_and_cap() {
        let mut quiet = ScriptedPort::new(None).preload(b"t1000\r", 10);
        assert!(drain_until_quiet(
            &mut quiet,
            Duration::from_millis(5),
            Duration::from_millis(40)
        ));
        assert!(quiet.pending.is_empty(), "backlog discarded");
        let mut busy = ScriptedPort::new(None).streaming(b"t1000\r", false);
        let t0 = Instant::now();
        assert!(!drain_until_quiet(
            &mut busy,
            Duration::from_millis(5),
            Duration::from_millis(40)
        ));
        assert!(t0.elapsed() < Duration::from_millis(500), "bounded by cap");
    }

    #[test]
    fn active_channel_opens_with_o_and_never_sends_l() {
        let (r, cmds) = handshake(Some(b"\x07"), false, true);
        assert!(r.is_ok());
        assert_eq!(cmds, ["C", "S6", "O"]);
    }

    #[test]
    fn open_rejects_non_serial_device_paths() {
        let drv = SlcanDriver::new();
        let desc = SlcanDriver::descriptor_for_port("/dev/mem");
        let cfg = ChannelConfig {
            serial_port: Some("/dev/mem".to_string()),
            ..ChannelConfig::default()
        };
        let err = drv
            .open_channel(&desc, &cfg)
            .err()
            .expect("must refuse /dev/mem");
        assert!(
            err.to_string().contains("Refusing to open '/dev/mem'"),
            "{err}"
        );
    }
}
