# Security Policy

NexusCAN talks to real CAN buses. A software bug here can become a physical safety problem on a vehicle, a test bench or an industrial line, so security reports are treated as high priority.

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Use GitHub's private reporting instead: **Security → Report a vulnerability** on this repository. Include the version or commit, your OS, the adapter (if any) and the steps to reproduce. You will get an acknowledgement within 7 days and a fix or a mitigation plan as soon as the issue is confirmed. Reporters are credited in the release notes unless they prefer otherwise.

## Supported versions

| Version | Supported |
|---|---|
| `development` branch / latest preview | ✅ |
| Older previews | ❌ (please update) |

## Safety model

These are design invariants. A way to break any of them is a security bug:

- **Listen-Only by default.** Physical channels open passive. Where the platform allows it, the controller itself is put into listen-only mode; the UI shows per bus whether listen-only is enforced in hardware, in software only, or the bus is virtual.
- **Explicit, confirmed arming.** Nothing transmits until a bus is armed by the user, and arming needs a confirmation.
- **Stop All TX.** One action cancels every transmit source (periodic jobs, diagnostics, polling, replay), disarms every bus and latches. It returns only after any frame write already handed to a driver has finished, so nothing reaches the wire afterwards (verified on `vcan0` with an independent sniffer). If a driver write does not finish within 250 ms, the latch is still set and the affected buses are reported in the UI. The latch is released only by an explicit "Clear Panic".
- **Clamped TX values.** Signal-encoded frames are clamped to the DBC range.
- **No remote actuation.** The experimental cloud protocol has no message type that can arm a bus or transmit a frame; the headless agent always runs Listen-Only.
- **Local-only development bridge.** The browser-mode bridge binds to loopback and requires a per-run token. The desktop app does not open a network port.
- **No code execution from files.** Projects, panels, databases and traces are data. Custom SecurityAccess algorithms run in a sandboxed Rhai engine in the backend, with size, operation and time limits.

## Known limitations

<!-- Finalised before each release. -->
- Hardware listen-only on Linux SocketCAN needs `CAP_NET_ADMIN`. Without it the bus is marked **software-only** listen-only: NexusCAN will not transmit, but the CAN controller may still acknowledge frames.
- The NexusCloud client and the headless agent are experimental and off by default. TLS is not implemented yet; they refuse non-loopback servers until it is.
- Parsers for `.dbc`, `.kcd`, `.blf`, `.asc`, `.trc`, `.csv` and candump logs handle untrusted input and are fuzz-tested (cargo-fuzz, short runs in CI), but only open files you would be willing to share.
