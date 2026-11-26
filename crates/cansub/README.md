# cansub-rs

Rust SDK for **CSS Electronics CANsub.2 / CANsub.4** CAN / CAN-FD interfaces (USB CDC-NCM and Ethernet).

> Status: pre-release, not yet published. Unofficial; crate name pending approval by CSS Electronics.

- `proto` — `no_std`, allocation-free HDLC + CRC32 stream decoder / encoder for the CANsub WebSocket wire format
- `timing` — bitrate → bit-timing registers for the 80 MHz CAN clock
- `blocking` feature — TLS 1.2 (pinned CSS root CA) REST + WebSocket client
- `discovery` feature — mDNS `_cansub._tcp`
- `sim` feature — `cansub-sim` device emulator for hardware-free testing

## License

Licensed under either of MIT (`LICENSE-MIT`) or Apache-2.0 (`LICENSE-APACHE`) at your option.
The embedded CSS root certificate (`certs/cansub_root_cert.crt`) is © CSS Electronics, MIT (`certs/LICENSE-CSS-MIT`).
