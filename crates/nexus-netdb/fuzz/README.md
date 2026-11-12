# nexus-netdb fuzz targets

[cargo-fuzz](https://github.com/rust-fuzz/cargo-fuzz) / libFuzzer harnesses for the untrusted-input
surface of `nexus-netdb` (WP-6). This directory is a **standalone workspace** and needs a **nightly**
toolchain. The normal stable `cargo build` / `cargo test` at the repository root never builds it.

| Target | Input | What it exercises |
| --- | --- | --- |
| `dbc_parse_compile` | arbitrary bytes as `.dbc` | encoding sniffing, lexer, parser (fault-tolerant + strict), `DbcWriter` -> reparse, compile, schema DTO, decode + encode of every message |
| `kcd_parse_compile` | arbitrary bytes as `.kcd` | quick-xml parser (fault-tolerant + strict), nesting limits, LabelGroup ranges, DBC export, compile, schema DTO, decode + encode |
| `codec_roundtrip` | 1 selector byte + payload | decode/encode against a fixed reference DB (Intel/Motorola, signed, f32/f64, CAN-FD > 8 bytes, cascaded + range mux); asserts `enc(dec(p))` reaches a fixed point |

## Run

```sh
cargo install cargo-fuzz            # once
cd crates/nexus-netdb/fuzz
cargo +nightly fuzz run dbc_parse_compile -- -max_total_time=300
cargo +nightly fuzz run kcd_parse_compile -- -max_total_time=300 -max_len=65536
cargo +nightly fuzz run codec_roundtrip   -- -max_total_time=300 -max_len=65
```

Seed corpora: point libFuzzer at the repository fixtures, e.g.
`cargo +nightly fuzz run dbc_parse_compile corpus/dbc ../../../scripts` (any directory of `.dbc` files).

Without cargo-fuzz installed, the same binaries can be built with plain nightly cargo:

```sh
RUSTFLAGS="--cfg fuzzing -Cpasses=sancov-module -Cllvm-args=-sanitizer-coverage-level=4 \
  -Cllvm-args=-sanitizer-coverage-inline-8bit-counters -Cllvm-args=-sanitizer-coverage-pc-table \
  -Cllvm-args=-sanitizer-coverage-trace-compares -Cdebug-assertions -Coverflow-checks" \
  cargo +nightly build --release --target x86_64-unknown-linux-gnu
./target/x86_64-unknown-linux-gnu/release/dbc_parse_compile -max_total_time=300
```

## Triage

A crash writes `artifacts/<target>/crash-*`. Reproduce with
`cargo +nightly fuzz run <target> artifacts/<target>/crash-...`, then add the input as a deterministic
regression test in `crates/nexus-netdb/tests/hostile_inputs.rs` (those run in the normal stable `cargo test`).

The stack limits to remember: cascaded multiplexers are bounded by `nexus_netdb::MAX_MUX_DEPTH` (16)
at parse (KCD), compile, RX decode and TX encode.
