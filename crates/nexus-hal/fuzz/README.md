# nexus-hal fuzz targets

[cargo-fuzz](https://github.com/rust-fuzz/cargo-fuzz) / libFuzzer harnesses for the untrusted-input
surface of the `nexus-hal` trace importers (WP-6): Vector `.blf`, Vector `.asc`, PEAK `.trc`
(v1.1 / v2.1), Linux `candump .log` and NexusCAN `.csv`. This directory is a **standalone workspace**
and needs a **nightly** toolchain. The normal stable `cargo build` / `cargo test` at the repository
root never builds it (the root `members = ["crates/*"]` glob does not reach `crates/nexus-hal/fuzz`).

| Target | Input | What it exercises |
| --- | --- | --- |
| `blf_parse` | arbitrary bytes as `.blf` | `pipeline::blf::parse_blf_bytes`: LOGG/LOBJ framing, padding recovery, zlib `LOG_CONTAINER` (64 MiB / 256 MiB zip-bomb caps), CAN / CAN_MESSAGE2 / CAN_FD / CAN_FD_64 objects; structural invariants; DTO plane roundtrip; `encode_blf_bytes` -> reparse must preserve count, bus, ID, IDE, FD, DLC, payload, TX and `rel_us` |
| `trace_text_parse` | 1 selector byte (`%4`: `.asc` / `.trc` / `.log` / `.csv` file-name hint) + text body | `pipeline::replay::parse_trace_text` (content sniffing + all four line parsers) and the stateless IPC import path `parse_trace_bytes`; then `entries_to_chronological_dtos` -> `compile_chronological_frames` must be lossless |
| `trace_bytes_autodetect` | arbitrary bytes, neutral `fuzz.trc` name | `pipeline::replay::parse_trace_entries_from_bytes`: `LOGG` sniffing (BLF) vs lossy-UTF-8 text with content-based format detection |

Invariants checked on every `Ok` result (`fuzz_targets/common.rs`): first `rel_us == 0`, sorted
`rel_us`, `timestamp_us == SYNTHETIC_TRACE_ORIGIN_US + rel_us` (saturating), `dlc <= 64`
(`<= 8` unless FD), `arb_id` inside the 11/29-bit mask.

## Run

```sh
cargo install cargo-fuzz            # once
cd crates/nexus-hal/fuzz
cargo +nightly fuzz run blf_parse              -- -max_total_time=300 -max_len=1048576 -rss_limit_mb=2048 -timeout=10
cargo +nightly fuzz run trace_text_parse       -- -max_total_time=300 -max_len=65536   -rss_limit_mb=2048 -timeout=10
cargo +nightly fuzz run trace_bytes_autodetect -- -max_total_time=300 -max_len=65536   -rss_limit_mb=2048 -timeout=10
```

Seed corpora: the repository fixtures in `test/traces/` (and any local `traces/*.trc`). For the text
targets use **short, line-aligned prefixes** (~4 KiB); the parsers are linear but ASan + SanCov make
a 64 KiB input cost ~25 ms, which drops throughput to tens of exec/s:

```sh
mkdir -p corpus/blf_parse corpus/trace_text_parse corpus/trace_bytes_autodetect
cp ../../../test/traces/*.blf corpus/blf_parse/
for f in ../../../test/traces/*.{asc,trc,log,csv}; do head -c 4096 "$f" | sed '$d' > corpus/trace_bytes_autodetect/$(basename "$f"); done
# trace_text_parse: prefix one selector byte, 0=asc 1=trc 2=log 3=csv
for f in ../../../test/traces/*.log; do (printf '\x02'; head -c 4096 "$f" | sed '$d') > corpus/trace_text_parse/$(basename "$f"); done
```

Without cargo-fuzz installed, the same binaries can be built with plain nightly cargo:

```sh
RUSTFLAGS="--cfg fuzzing -Cpasses=sancov-module -Cllvm-args=-sanitizer-coverage-level=4 \
  -Cllvm-args=-sanitizer-coverage-inline-8bit-counters -Cllvm-args=-sanitizer-coverage-pc-table \
  -Cllvm-args=-sanitizer-coverage-trace-compares -Cdebug-assertions -Coverflow-checks" \
  cargo +nightly build --release --target x86_64-unknown-linux-gnu
./target/x86_64-unknown-linux-gnu/release/blf_parse corpus/blf_parse -max_total_time=300 -max_len=1048576
```

## Triage

A crash writes `artifacts/<target>/crash-*` (`timeout-*` / `oom-*` for hangs and memory blow-ups).
Reproduce with `cargo +nightly fuzz run <target> artifacts/<target>/crash-...`, fix the root cause in
`crates/nexus-hal/src/pipeline/{blf,replay}.rs`, then add the input as a deterministic regression test
in `crates/nexus-hal/tests/hostile_traces.rs` (those run in the normal stable `cargo test -p nexus-hal`).

Things to remember when fixing:

- Text is lossy-UTF-8; never slice `&str` at `idx + 1` / `[..1]` derived from a char search; use
  byte-wise scans or `str::get`.
- `f64 as i128` saturates for finite huge timestamps (`1e300`); timestamp arithmetic must be
  `saturating_*`.
- BLF allocations are bounded by `blf::MAX_CONTAINER_UNCOMPRESSED_BYTES` (64 MiB) and
  `blf::MAX_TOTAL_UNCOMPRESSED_BYTES` (256 MiB); IPC-level frame caps live in `storage.rs`
  (`MAX_IPC_FRAMES`, `MAX_TRACE_FILE_BYTES`).

Findings fixed so far (all covered by `tests/hostile_traces.rs`):

| Input | Root cause | Fix |
| --- | --- | --- |
| candump `vcan\u{FFFD}0 ...` (found by `trace_text_parse`) | `extract_iface_bus_id`: char-wise `rfind` + 1 sliced inside a multi-byte char | byte-wise `rposition` |
| candump `123##\u{e9}a` | compact-FD flags nibble `&rhs[..1]` sliced inside a multi-byte char | `rhs.get(..1)` |
| `(1e300) ...` / `(-1e300) ...` | `ts - origin` i128 overflow after saturating `f64 as i128` | `saturating_sub` |
| BLF `CAN_FD_MESSAGE` on channel 256 (bus 255) | encoder always wrote `CAN_FD_MESSAGE_64`, whose `u8` channel cannot hold 256 -> reparsed as bus 254 | encoder emits `CAN_FD_MESSAGE` (type 100, `u16` channel) for FD frames on bus 255; covered by `tests/blf_roundtrip.rs` |
