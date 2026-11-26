---
name: nexuscan-mf4
description: Integrate or verify ASAM MDF4 CAN/CAN-FD trace import in NexusCAN.
---

# NexusCAN MF4 import

- Use the existing binary dispatch in `crates/nexus-hal/src/pipeline/replay.rs`. The `mf4.rs` adapter reuses the MIT/Apache-2.0 `falcon_mdf` reader with optional features disabled.
- Map raw CAN data-frame groups into `CompiledReplayEntry` using the recorded channel, CAN ID, frame flags and payload. Stable-sort by file time and normalize to microseconds relative to the first frame. Keep MDF parsing outside the live RX/TX path. Use existing Trace and DBC decoding.
- Trace import currently reads the whole file and accepts at most 100,000 CAN data frames. Import all recorded CAN channels into one session. Channel selection, measurement channels and MF4 export are future work.
- Run `cargo test -p nexus-hal --test mf4_import` and `npm run build`. Compare real logs against asammdf for frame count, channels, relative timestamps, IDs, flags and payload.
