---
name: nexuscan-hal-drivers
description: >-
  Two-layer Hardware Abstraction Layer (crates/nexus-core and crates/nexus-hal) and CAN/CAN-FD adapter
  drivers in Rust for NexusCAN. Use when designing, implementing, or debugging RawCanFrame, BusId,
  AdapterDriver and CanChannel traits, DriverRegistry, Linux SocketCAN (vcan0/can0), multi-mux synthetic
  mock0 driver, USB-CAN (gs_usb via nusb), SLCAN, or PCAN/Kvaser FFI backends.
---

# NexusCAN Hardware Abstraction Layer (`crates/nexus-core` & `crates/nexus-hal`)

NexusCAN isolates core primitives (`crates/nexus-core`, zero OS/UI dependencies) and hardware I/O (`crates/nexus-hal`) so multi-channel CAN / CAN-FD capture runs with zero heap allocations on the hot path.

## 1. Zero-Allocation `RawCanFrame` (`crates/nexus-core/src/frame.rs`)

Never allocate `Vec<u8>` per frame. Every frame is an exact **80-byte**, `#[repr(C)]`, `Copy` struct carrying `bus_id` for simultaneous multi-adapter operation:

```rust
pub mod frame_flags {
    pub const EXTENDED: u8 = 1 << 0; // 29-bit Extended Arbitration ID
    pub const RTR:      u8 = 1 << 1; // Remote Transmission Request
    pub const FD:       u8 = 1 << 2; // CAN-FD frame
    pub const BRS:      u8 = 1 << 3; // Bit Rate Switch (CAN-FD fast data phase)
    pub const ESI:      u8 = 1 << 4; // Error State Indicator (CAN-FD)
    pub const ERROR:    u8 = 1 << 5; // Bus error frame
    pub const TX:       u8 = 1 << 6; // Self-transmitted / loopback echo marker
}

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct RawCanFrame {
    pub timestamp_us: u64, // Monotonic microseconds (8 bytes)
    pub arb_id: u32,       // Clean 11-bit (0..=0x7FF) or 29-bit (0..=0x1FFF_FFFF) ID (4 bytes)
    pub bus_id: u8,        // Logical channel/bus ID 0..=255 (1 byte)
    pub dlc: u8,           // Payload byte length: 0..=8 Classical CAN, 0..=64 CAN-FD (1 byte)
    pub flags: u8,         // Bitmask from frame_flags (1 byte)
    pub _reserved: u8,     // Explicit alignment padding -> header = 16 bytes, total = 80 bytes
    pub data: [u8; 64],    // Fixed stack payload buffer (64 bytes)
}
```

* Compile-time size assertion: `const _: () = assert!( core::mem::size_of::<RawCanFrame>() == 80 );`.
* Provide `CanIdKey` (`Standard(u16)` vs `Extended(u32)`) helper derived from `(arb_id, flags & EXTENDED)` so `0x100` Standard and `0x00000100` Extended never collide.

## 2. Two-Layer HAL Traits (`crates/nexus-hal/src/lib.rs`)

Separate **Device Discovery & Capability Probing** (`AdapterDriver`) from **Hot-Path Frame I/O** (`CanChannel`):

```rust
pub trait AdapterDriver: Send + Sync {
    fn driver_id(&self) -> &'static str;    // "socketcan", "mock", "gs_usb", "pcan", "slcan"
    fn display_name(&self) -> &'static str;
    fn discover_devices(&self) -> Result<Vec<DeviceDescriptor>, AdapterError>;
    fn open_channel(
        &self,
        device: &DeviceDescriptor,
        config: &ChannelConfig,
    ) -> Result<Box<dyn CanChannel>, AdapterError>;
}

pub trait CanChannel: Send {
    fn descriptor(&self) -> &DeviceDescriptor;
    fn capabilities(&self) -> &AdapterCapabilities; // supports_fd, listen_only, hw_timestamps, max_bitrate
    fn close(&mut self) -> Result<(), AdapterError>;
    /// Reads up to `out_batch.len()` frames into pre-allocated slice. Returns count read (0 on timeout).
    fn recv_batch(&mut self, out_batch: &mut [RawCanFrame], timeout_ms: u32) -> Result<usize, AdapterError>;
    fn send_frame(&mut self, frame: &RawCanFrame) -> Result<(), AdapterError>;
    fn set_filters(&mut self, filters: &[CanFilter]) -> Result<(), AdapterError>;
    fn health(&self) -> BusHealthSnapshot; // BusState (Active/Warning/Passive/BusOff), TEC, REC
}
```

### Batch Drain Strategy (`recv_batch`)
1. Poll/wait up to `timeout_ms` (`5..10ms`) for the first frame so idle channels consume ~0% CPU and stop cleanly.
2. Drain remaining ready frames non-blockingly (`MSG_DONTWAIT` / `WouldBlock`) up to `out_batch.len()` (e.g. `256` frames) to amortize syscall and channel costs at 25k–50k fps.

## 3. Linux SocketCAN (`drivers/socketcan_drv.rs`)

* Gate Linux crates in `crates/nexus-hal/Cargo.toml`:
  `[target.'cfg(target_os = "linux")'.dependencies]` -> `socketcan = "3"`, `nix`.
* **Auto-Discovery (`/sys/class/net`):** Match `/sys/class/net/<iface>/type == "280"` (`ARPHRD_CAN`) to find all `can*`, `vcan*`, and `slcan*` interfaces, reading `mtu` (`72` => CAN-FD capable, `16` => Classical CAN) and `operstate`.
* Open `CanFdSocket` when MTU >= 72 (transparently handles both 8-byte CAN and 64-byte CAN-FD frames), falling back to `CanSocket` on Classical-only interfaces. Strip Linux `CAN_EFF_FLAG` / `CAN_RTR_FLAG` / `CAN_ERR_FLAG` into `RawCanFrame::flags`.

## 4. Synthetic EV + Multiplexed BMS Mock Driver (`drivers/mock_drv.rs`)

Always expose `"mock0 (Synthetic EV + Multiplexed BMS 25kfps)"` on every OS (Linux/WSL2/Windows/macOS):
* Generate realistic animated waveforms matching `scripts/sample_vehicle.dbc` and `scripts/sample_bms.kcd`:
  * Standard + Extended J1939 frames, Intel & Motorola signals, signed currents, IEEE-754 floats, `VAL_` enum states, and **multiplexed BMS cell banks** (`Mux = 0..23`) so Retained Mux State in `StateTable` is continuously exercised.

## Verification Gates
1. `cargo test -p nexus-core -p nexus-hal` passes with zero warnings.
2. Verify `size_of::<RawCanFrame>() == 80` and clean `mock0` throughput at `25,000+ fps`.
