//! L2b: arbitrary bytes, arbitrary chunking → `Decoder::push` never panics, and the result
//! (events + stats) is independent of how the stream was split into WebSocket messages.
#![no_main]

use cansub::proto::{Decoder, DecoderStats, Event};
use libfuzzer_sys::fuzz_target;

fn run(bytes: &[u8], chunks: &[u8]) -> (Vec<Event>, DecoderStats) {
    let mut d = Decoder::new();
    let mut ev = Vec::new();
    let mut rest = bytes;
    let mut i = 0usize;
    while !rest.is_empty() {
        let c = if chunks.is_empty() {
            rest.len()
        } else {
            chunks[i % chunks.len()] as usize
        };
        let n = c.clamp(1, rest.len());
        d.push(&rest[..n], &mut |e| ev.push(e));
        rest = &rest[n..];
        i += 1;
    }
    (ev, d.stats())
}

fuzz_target!(|data: &[u8]| {
    // First byte = number of chunk-size bytes that follow; remainder = wire stream.
    let Some((&k, tail)) = data.split_first() else {
        return;
    };
    let k = (k as usize % 16).min(tail.len());
    let (chunks, stream) = tail.split_at(k);

    let (ev_whole, st_whole) = run(stream, &[]);
    let (ev_split, st_split) = run(stream, chunks);
    assert_eq!(ev_whole, ev_split, "events depend on chunking");
    assert_eq!(st_whole, st_split, "stats depend on chunking");
    assert!(st_whole.garbage_bytes <= stream.len() as u64);
    let closed = st_whole.hdlc_ok + st_whole.crc_errors + st_whole.overflows;
    let flags = stream.iter().filter(|&&b| b == 0x7E).count() as u64;
    // Every accepted / rejected HDLC is closed by a flag, overflows resync on one: bounded by flags
    // (+1 for an overflow that happens before any closing flag).
    assert!(closed <= flags + 1, "closed={closed} flags={flags}");
    let frames = ev_whole
        .iter()
        .filter(|e| matches!(e, Event::Frame(_)))
        .count() as u64;
    // Smallest CAN frame on the wire is 9 bytes (header+std id, no data).
    assert!(frames <= stream.len() as u64 / 9 + 1);
});
