//! Pure-Rust, zero-`unsafe` Vector Binary Logging Format (`.blf`) reader and writer
//! supporting `LOG_CONTAINER` (uncompressed & zlib-compressed with cross-container `LOBJ`
//! stream reassembly and zip-bomb bounds), Classical CAN (`CAN_MESSAGE` / `CAN_MESSAGE2`),
//! and ISO 11898-1 CAN-FD (`CAN_FD_MESSAGE` / `CAN_FD_MESSAGE_64`).

use crate::error::HalError;
use crate::pipeline::replay::{CompiledReplayEntry, SYNTHETIC_TRACE_ORIGIN_US};
use flate2::read::ZlibDecoder;
use flate2::write::ZlibEncoder;
use flate2::Compression;
use nexus_core::{
    dlc_code_to_len, len_to_canfd_dlc_code, CanIdKey, RawCanFrame, EXT_CAN_ID_MASK, FLAG_ESI,
    FLAG_TX, MAX_CAN_FD_DLC, MAX_CLASSICAL_CAN_DLC, STD_CAN_ID_MASK,
};
use std::io::{Read, Write};

/// Vector `.blf` file header magic (`"LOGG"`).
pub const BLF_FILE_SIGNATURE: &[u8; 4] = b"LOGG";

/// Vector `.blf` object header magic (`"LOBJ"`).
pub const BLF_OBJECT_SIGNATURE: &[u8; 4] = b"LOBJ";

/// Standard `VBLFileStatisticsEx` header byte length (`144` bytes).
pub const BLF_FILE_HEADER_SIZE: usize = 144;

/// Minimum accepted `LOGG` file statistics header size (`72` bytes).
const MIN_BLF_FILE_HEADER_SIZE: usize = 72;

/// Uncompressed inner `LOBJ` chunk size per `LOG_CONTAINER` (`128 KiB`).
pub const BLF_CONTAINER_CHUNK_SIZE: usize = 131_072;

/// Security bound: maximum uncompressed bytes permitted in a single `LOG_CONTAINER` (`64 MiB`).
pub const MAX_CONTAINER_UNCOMPRESSED_BYTES: usize = 64 * 1024 * 1024;

/// Security bound: maximum cumulative uncompressed stream bytes across an entire `.blf` file (`256 MiB`).
pub const MAX_TOTAL_UNCOMPRESSED_BYTES: usize = 256 * 1024 * 1024;

// Vector BLF Object Type IDs
const BLF_OBJ_CAN_MESSAGE: u32 = 1;
const BLF_OBJ_LOG_CONTAINER: u32 = 10;
const BLF_OBJ_CAN_MESSAGE2: u32 = 86;
const BLF_OBJ_CAN_FD_MESSAGE: u32 = 100;
const BLF_OBJ_CAN_FD_MESSAGE_64: u32 = 101;

// Vector BLF Compression Methods
const BLF_COMPRESSION_NONE: u16 = 0;
const BLF_COMPRESSION_ZLIB: u16 = 2;

// Vector BLF Timestamp Flags (`object_flags`)
const BL_OBJ_FLAG_TIME_TEN_MICS: u32 = 0x0000_0001;
const BL_OBJ_FLAG_TIME_ONE_NANS: u32 = 0x0000_0002;

// Vector BLF Raw Extended Arbitration ID Flag
const BLF_EXT_ID_FLAG: u32 = 0x8000_0000;

/// Returns `true` if `bytes` carries a valid Vector `.blf` `LOGG` signature and >= `144` bytes.
#[inline]
pub fn is_blf_bytes(bytes: &[u8]) -> bool {
    bytes.len() >= BLF_FILE_HEADER_SIZE && &bytes[0..4] == BLF_FILE_SIGNATURE
}

#[inline]
fn read_u16_le(buf: &[u8], offset: usize) -> Result<u16, HalError> {
    let slice = buf.get(offset..offset + 2).ok_or_else(|| {
        HalError::InvalidInput(format!("Truncated BLF u16 field at byte offset {offset}"))
    })?;
    Ok(u16::from_le_bytes([slice[0], slice[1]]))
}

#[inline]
fn read_u32_le(buf: &[u8], offset: usize) -> Result<u32, HalError> {
    let slice = buf.get(offset..offset + 4).ok_or_else(|| {
        HalError::InvalidInput(format!("Truncated BLF u32 field at byte offset {offset}"))
    })?;
    Ok(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

#[inline]
fn read_u64_le(buf: &[u8], offset: usize) -> Result<u64, HalError> {
    let slice = buf.get(offset..offset + 8).ok_or_else(|| {
        HalError::InvalidInput(format!("Truncated BLF u64 field at byte offset {offset}"))
    })?;
    Ok(u64::from_le_bytes([
        slice[0], slice[1], slice[2], slice[3], slice[4], slice[5], slice[6], slice[7],
    ]))
}

#[inline]
fn choose_next_lobj_offset(stream: &[u8], pos: usize, object_size: usize, pad: usize) -> usize {
    let unpadded = pos.saturating_add(object_size);
    let padded = unpadded.saturating_add(pad);
    if pad == 0 || padded >= stream.len() {
        return padded.min(stream.len());
    }
    if stream.get(padded..padded + 4) == Some(BLF_OBJECT_SIGNATURE.as_slice()) {
        return padded;
    }
    if stream.get(unpadded..unpadded + 4) == Some(BLF_OBJECT_SIGNATURE.as_slice()) {
        return unpadded;
    }
    padded.min(stream.len())
}

/// Parses a binary Vector `.blf` byte buffer into origin-normalized (`rel_us` starting at `0`),
/// chronologically sorted [`CompiledReplayEntry`] records.
pub fn parse_blf_bytes(bytes: &[u8]) -> Result<Vec<CompiledReplayEntry>, HalError> {
    if bytes.len() < MIN_BLF_FILE_HEADER_SIZE || &bytes[0..4] != BLF_FILE_SIGNATURE {
        return Err(HalError::InvalidInput(
            "Invalid Vector .blf file: missing 'LOGG' file header signature".to_string(),
        ));
    }

    let file_header_size = read_u32_le(bytes, 4)? as usize;
    if file_header_size < MIN_BLF_FILE_HEADER_SIZE || file_header_size > bytes.len() {
        return Err(HalError::InvalidInput(format!(
            "Invalid Vector .blf header_size={file_header_size} (file len={})",
            bytes.len()
        )));
    }

    let mut uncompressed_stream: Vec<u8> = Vec::new();
    let mut raw_frames: Vec<(u64, RawCanFrame)> = Vec::new();

    let mut offset = file_header_size;
    while offset < bytes.len() {
        let remaining = &bytes[offset..];
        if remaining.iter().all(|&b| b == 0) {
            break;
        }
        if remaining.len() < 16 {
            return Err(HalError::InvalidInput(format!(
                "Truncated outer BLF LOBJ header at offset {offset}"
            )));
        }
        if &remaining[0..4] != BLF_OBJECT_SIGNATURE {
            return Err(HalError::InvalidInput(format!(
                "Expected outer BLF 'LOBJ' signature at offset {offset}"
            )));
        }

        let object_size = read_u32_le(bytes, offset + 8)? as usize;
        let object_type = read_u32_le(bytes, offset + 12)?;
        if object_size < 16 {
            return Err(HalError::InvalidInput(format!(
                "Invalid outer BLF LOBJ object_size={object_size} at offset {offset}"
            )));
        }
        let Some(obj_end) = offset.checked_add(object_size) else {
            return Err(HalError::InvalidInput(
                "BLF outer LOBJ size overflow".to_string(),
            ));
        };
        if obj_end > bytes.len() {
            return Err(HalError::InvalidInput(format!(
                "Truncated outer BLF LOBJ at offset {offset}: object_size={object_size} exceeds file length {}",
                bytes.len()
            )));
        }

        let obj_slice = &bytes[offset..obj_end];
        if object_type == BLF_OBJ_LOG_CONTAINER {
            if object_size < 32 {
                return Err(HalError::InvalidInput(format!(
                    "Invalid BLF LOG_CONTAINER size={object_size} (< 32) at offset {offset}"
                )));
            }
            let compression_method = read_u16_le(obj_slice, 16)?;
            let declared_uncompressed = read_u32_le(obj_slice, 24)? as usize;
            if declared_uncompressed > MAX_CONTAINER_UNCOMPRESSED_BYTES {
                return Err(HalError::InvalidInput(format!(
                    "BLF LOG_CONTAINER uncompressed_size={declared_uncompressed} exceeds 64 MiB safety limit"
                )));
            }
            if uncompressed_stream
                .len()
                .saturating_add(declared_uncompressed)
                > MAX_TOTAL_UNCOMPRESSED_BYTES
            {
                return Err(HalError::InvalidInput(
                    "BLF cumulative uncompressed stream exceeds 256 MiB safety limit".to_string(),
                ));
            }

            let container_data = &obj_slice[32..];
            match compression_method {
                BLF_COMPRESSION_NONE => {
                    if container_data.len() > MAX_CONTAINER_UNCOMPRESSED_BYTES
                        || uncompressed_stream
                            .len()
                            .saturating_add(container_data.len())
                            > MAX_TOTAL_UNCOMPRESSED_BYTES
                    {
                        return Err(HalError::InvalidInput(
                            "BLF uncompressed LOG_CONTAINER exceeds safety bounds".to_string(),
                        ));
                    }
                    uncompressed_stream.extend_from_slice(container_data);
                }
                BLF_COMPRESSION_ZLIB => {
                    let remaining_total_budget =
                        MAX_TOTAL_UNCOMPRESSED_BYTES.saturating_sub(uncompressed_stream.len());
                    let max_chunk_budget =
                        MAX_CONTAINER_UNCOMPRESSED_BYTES.min(remaining_total_budget);
                    let reserve_hint = declared_uncompressed.min(max_chunk_budget).min(1024 * 1024);
                    uncompressed_stream.reserve(reserve_hint);

                    let start_len = uncompressed_stream.len();
                    let mut limited_decoder =
                        ZlibDecoder::new(container_data).take((max_chunk_budget as u64) + 1);
                    limited_decoder
                        .read_to_end(&mut uncompressed_stream)
                        .map_err(|e| {
                            HalError::InvalidInput(format!(
                                "Corrupt zlib stream in BLF LOG_CONTAINER at offset {offset}: {e}"
                            ))
                        })?;
                    let produced = uncompressed_stream.len() - start_len;
                    if produced > max_chunk_budget {
                        return Err(HalError::InvalidInput(
                            "BLF LOG_CONTAINER decompressed payload exceeded 64 MiB / 256 MiB zip-bomb safety limit"
                                .to_string(),
                        ));
                    }
                }
                other => {
                    return Err(HalError::InvalidInput(format!(
                        "Unsupported BLF LOG_CONTAINER compression_method={other} at offset {offset}"
                    )));
                }
            }
        } else {
            parse_timestamped_lobj(obj_slice, &mut raw_frames)?;
        }

        let pad = (4 - (object_size % 4)) % 4;
        offset = choose_next_lobj_offset(bytes, offset, object_size, pad);
    }

    // Parse inner `LOBJ` stream reassembled across all `LOG_CONTAINER` blocks
    let mut inner_pos = 0usize;
    while inner_pos < uncompressed_stream.len() {
        let rem = &uncompressed_stream[inner_pos..];
        if rem.iter().all(|&b| b == 0) {
            break;
        }
        if rem.len() < 16 {
            return Err(HalError::InvalidInput(format!(
                "Truncated inner BLF LOBJ header at uncompressed offset {inner_pos}"
            )));
        }
        if &rem[0..4] != BLF_OBJECT_SIGNATURE {
            return Err(HalError::InvalidInput(format!(
                "Expected inner BLF 'LOBJ' signature at uncompressed offset {inner_pos}"
            )));
        }

        let object_size = read_u32_le(&uncompressed_stream, inner_pos + 8)? as usize;
        if object_size < 16 {
            return Err(HalError::InvalidInput(format!(
                "Invalid inner BLF LOBJ object_size={object_size} at uncompressed offset {inner_pos}"
            )));
        }
        let Some(obj_end) = inner_pos.checked_add(object_size) else {
            return Err(HalError::InvalidInput(
                "Inner BLF LOBJ size overflow".to_string(),
            ));
        };
        if obj_end > uncompressed_stream.len() {
            return Err(HalError::InvalidInput(format!(
                "Truncated inner BLF LOBJ at uncompressed offset {inner_pos}: size={object_size}, stream_len={}",
                uncompressed_stream.len()
            )));
        }

        parse_timestamped_lobj(&uncompressed_stream[inner_pos..obj_end], &mut raw_frames)?;

        let pad = (4 - (object_size % 4)) % 4;
        inner_pos = choose_next_lobj_offset(&uncompressed_stream, inner_pos, object_size, pad);
    }

    if raw_frames.is_empty() {
        return Ok(Vec::new());
    }

    raw_frames.sort_by_key(|(ts_us, _)| *ts_us);
    let first_ts_us = raw_frames[0].0;

    let mut entries = Vec::with_capacity(raw_frames.len());
    for (raw_ts_us, mut frame) in raw_frames {
        let rel_us = raw_ts_us.saturating_sub(first_ts_us);
        frame.timestamp_us = SYNTHETIC_TRACE_ORIGIN_US.saturating_add(rel_us);
        entries.push(CompiledReplayEntry { rel_us, frame });
    }

    Ok(entries)
}

fn parse_timestamped_lobj(
    obj_slice: &[u8],
    out: &mut Vec<(u64, RawCanFrame)>,
) -> Result<(), HalError> {
    if obj_slice.len() < 16 {
        return Ok(());
    }
    let header_size = read_u16_le(obj_slice, 4)? as usize;
    let header_version = read_u16_le(obj_slice, 6)?;
    let object_type = read_u32_le(obj_slice, 12)?;

    if !matches!(
        object_type,
        BLF_OBJ_CAN_MESSAGE
            | BLF_OBJ_CAN_MESSAGE2
            | BLF_OBJ_CAN_FD_MESSAGE
            | BLF_OBJ_CAN_FD_MESSAGE_64
    ) {
        return Ok(());
    }

    let min_hdr = match header_version {
        1 => 32usize,
        2 => 40usize,
        _ => 32usize,
    };
    if header_size < min_hdr || header_size > obj_slice.len() {
        return Err(HalError::InvalidInput(format!(
            "Invalid BLF timestamped object header_version={header_version}, header_size={header_size}, len={}",
            obj_slice.len()
        )));
    }

    let object_flags = read_u32_le(obj_slice, 16)?;
    let object_timestamp = read_u64_le(obj_slice, 24)?;
    let raw_ts_us = if (object_flags & BL_OBJ_FLAG_TIME_TEN_MICS) != 0 {
        object_timestamp.saturating_mul(10)
    } else {
        object_timestamp / 1_000
    };

    let payload = &obj_slice[header_size..];

    match object_type {
        BLF_OBJ_CAN_MESSAGE | BLF_OBJ_CAN_MESSAGE2 => {
            if payload.len() < 16 {
                return Ok(());
            }
            let channel = read_u16_le(payload, 0)?;
            let bus_id = (channel.saturating_sub(1)).min(255) as u8;
            let flags = payload[2];
            let is_tx = (flags & 0x01) != 0;
            let is_rtr = (flags & 0x80) != 0;
            let dlc_raw = payload[3];
            let len = usize::from(dlc_code_to_len(dlc_raw, false).min(8));
            let raw_id = read_u32_le(payload, 4)?;
            let is_extended = (raw_id & BLF_EXT_ID_FLAG) != 0;
            let arb_id = if is_extended {
                raw_id & EXT_CAN_ID_MASK
            } else {
                raw_id & STD_CAN_ID_MASK
            };
            let can_id = CanIdKey::new_masked(arb_id, is_extended);

            let frame_res = if is_rtr {
                RawCanFrame::new_rtr(bus_id, can_id, dlc_raw.min(8), 0)
            } else {
                RawCanFrame::new_classical(bus_id, can_id, &payload[8..8 + len], 0)
            };
            if let Ok(mut frame) = frame_res {
                if is_tx {
                    frame.flags |= FLAG_TX;
                }
                out.push((raw_ts_us, frame));
            }
        }
        BLF_OBJ_CAN_FD_MESSAGE => {
            if payload.len() < 20 {
                return Ok(());
            }
            let channel = read_u16_le(payload, 0)?;
            let bus_id = (channel.saturating_sub(1)).min(255) as u8;
            let flags = payload[2];
            let is_tx = (flags & 0x01) != 0;
            let is_rtr = (flags & 0x80) != 0;
            let dlc = payload[3];
            let raw_id = read_u32_le(payload, 4)?;
            let is_extended = (raw_id & BLF_EXT_ID_FLAG) != 0;
            let arb_id = if is_extended {
                raw_id & EXT_CAN_ID_MASK
            } else {
                raw_id & STD_CAN_ID_MASK
            };
            let can_id = CanIdKey::new_masked(arb_id, is_extended);

            let fd_flags = payload[13];
            let declared_valid = usize::from(payload[14]);
            let is_fd = (fd_flags & 0x01) != 0 || declared_valid > MAX_CLASSICAL_CAN_DLC;
            let is_brs = (fd_flags & 0x02) != 0;
            let is_esi = (fd_flags & 0x04) != 0;
            let valid_bytes = declared_valid
                .min(MAX_CAN_FD_DLC)
                .min(payload.len().saturating_sub(20));

            let frame_res = if is_rtr && !is_fd {
                RawCanFrame::new_rtr(bus_id, can_id, dlc.min(8), 0)
            } else if is_fd {
                RawCanFrame::new_fd(bus_id, can_id, &payload[20..20 + valid_bytes], is_brs, 0)
            } else {
                RawCanFrame::new_classical(bus_id, can_id, &payload[20..20 + valid_bytes.min(8)], 0)
            };
            if let Ok(mut frame) = frame_res {
                if is_esi {
                    frame.flags |= FLAG_ESI;
                }
                if is_tx {
                    frame.flags |= FLAG_TX;
                }
                out.push((raw_ts_us, frame));
            }
        }
        BLF_OBJ_CAN_FD_MESSAGE_64 => {
            if payload.len() < 40 {
                return Ok(());
            }
            let channel = payload[0];
            let bus_id = channel.saturating_sub(1);
            let dlc = payload[1];
            let valid_data_bytes = usize::from(payload[2]).min(MAX_CAN_FD_DLC);
            let raw_id = read_u32_le(payload, 4)?;
            let is_extended = (raw_id & BLF_EXT_ID_FLAG) != 0;
            let arb_id = if is_extended {
                raw_id & EXT_CAN_ID_MASK
            } else {
                raw_id & STD_CAN_ID_MASK
            };
            let can_id = CanIdKey::new_masked(arb_id, is_extended);

            let flags = read_u32_le(payload, 12)?;
            let is_rtr = (flags & 0x0010) != 0;
            let is_fd = (flags & 0x1000) != 0 || valid_data_bytes > MAX_CLASSICAL_CAN_DLC;
            let is_brs = (flags & 0x2000) != 0;
            let is_esi = (flags & 0x4000) != 0;
            let dir = payload[34];
            let is_tx = dir == 1 || (flags & 0x0001) != 0;

            let data_offset = 40usize;
            let actual_len = valid_data_bytes.min(payload.len().saturating_sub(data_offset));
            let data_slice = &payload[data_offset..data_offset + actual_len];

            let frame_res = if is_rtr && !is_fd {
                RawCanFrame::new_rtr(bus_id, can_id, dlc.min(8), 0)
            } else if is_fd {
                RawCanFrame::new_fd(bus_id, can_id, data_slice, is_brs, 0)
            } else {
                RawCanFrame::new_classical(bus_id, can_id, &data_slice[..actual_len.min(8)], 0)
            };
            if let Ok(mut frame) = frame_res {
                if is_esi {
                    frame.flags |= FLAG_ESI;
                }
                if is_tx {
                    frame.flags |= FLAG_TX;
                }
                out.push((raw_ts_us, frame));
            }
        }
        _ => {}
    }

    Ok(())
}

/// Encodes [`CompiledReplayEntry`] records into a standard zlib-compressed Vector `.blf` binary file.
pub fn encode_blf_bytes(entries: &[CompiledReplayEntry]) -> Result<Vec<u8>, HalError> {
    if entries.is_empty() {
        let mut empty_file = vec![0u8; BLF_FILE_HEADER_SIZE];
        write_logg_file_header(
            &mut empty_file[..BLF_FILE_HEADER_SIZE],
            BLF_FILE_HEADER_SIZE as u64,
            BLF_FILE_HEADER_SIZE as u64,
            0,
        );
        return Ok(empty_file);
    }

    let mut inner_stream = Vec::with_capacity(entries.len().saturating_mul(64));
    for entry in entries {
        let frame = &entry.frame;
        let ts_ns = entry.rel_us.saturating_mul(1_000);
        let raw_id = if frame.is_extended() {
            (frame.arb_id & EXT_CAN_ID_MASK) | BLF_EXT_ID_FLAG
        } else {
            frame.arb_id & STD_CAN_ID_MASK
        };

        if !frame.is_fd() && usize::from(frame.dlc) <= MAX_CLASSICAL_CAN_DLC {
            // `CAN_MESSAGE` (`object_type = 1`, `object_size = 32 + 16 = 48` bytes, 4-byte aligned)
            let object_size = 48u32;
            write_inner_v1_header(&mut inner_stream, object_size, BLF_OBJ_CAN_MESSAGE, ts_ns);

            let channel = u16::from(frame.bus_id).saturating_add(1);
            let flags = (if frame.is_tx() { 0x01u8 } else { 0u8 })
                | (if frame.is_rtr() { 0x80u8 } else { 0u8 });
            let dlc = frame.dlc.min(8);
            let mut data8 = [0u8; 8];
            if !frame.is_rtr() {
                let n = usize::from(dlc);
                data8[..n].copy_from_slice(&frame.data[..n]);
            }

            inner_stream.extend_from_slice(&channel.to_le_bytes());
            inner_stream.push(flags);
            inner_stream.push(dlc);
            inner_stream.extend_from_slice(&raw_id.to_le_bytes());
            inner_stream.extend_from_slice(&data8);
        } else if u8::try_from(u16::from(frame.bus_id) + 1).is_err() {
            // The 1-based channel (bus 255 -> channel 256) does not fit the `u8` channel of
            // `CAN_FD_MESSAGE_64`, so fall back to `CAN_FD_MESSAGE` (`object_type = 100`) whose
            // channel is a `u16`. Vector `VBLCANFDMessage` body is a fixed 84 bytes
            // (20-byte header + `mData[64]`): `object_size = 32 + 84 = 116` (4-byte aligned).
            let valid_len = usize::from(frame.dlc).min(MAX_CAN_FD_DLC);
            let object_size = 32u32 + 20 + 64;
            write_inner_v1_header(
                &mut inner_stream,
                object_size,
                BLF_OBJ_CAN_FD_MESSAGE,
                ts_ns,
            );

            let channel = u16::from(frame.bus_id) + 1;
            // `mFlags`: bit0 = TX direction, bit7 = RTR (same as `CAN_MESSAGE`).
            let flags = (if frame.is_tx() { 0x01u8 } else { 0u8 })
                | (if frame.is_rtr() { 0x80u8 } else { 0u8 });
            let dlc_code = len_to_canfd_dlc_code(valid_len as u8);
            // `mCANFDFlags`: bit0 = EDL (FD), bit1 = BRS, bit2 = ESI. Always EDL, mirroring the
            // unconditional `0x1000` of the type-101 writer below.
            let mut fd_flags = 0x01u8;
            if frame.is_brs() {
                fd_flags |= 0x02;
            }
            if frame.is_esi() {
                fd_flags |= 0x04;
            }
            let mut data64 = [0u8; 64];
            data64[..valid_len].copy_from_slice(&frame.data[..valid_len]);

            inner_stream.extend_from_slice(&channel.to_le_bytes()); // 0..2: channel
            inner_stream.push(flags); // 2: flags
            inner_stream.push(dlc_code); // 3: dlc
            inner_stream.extend_from_slice(&raw_id.to_le_bytes()); // 4..8: id
            inner_stream.extend_from_slice(&0u32.to_le_bytes()); // 8..12: frame_length
            inner_stream.push(0u8); // 12: arb_bit_count
            inner_stream.push(fd_flags); // 13: canfd_flags
            inner_stream.push(valid_len as u8); // 14: valid_data_bytes
            inner_stream.push(0u8); // 15: reserved1
            inner_stream.extend_from_slice(&0u32.to_le_bytes()); // 16..20: reserved2
            inner_stream.extend_from_slice(&data64); // 20..84: data[64]
        } else {
            // `CAN_FD_MESSAGE_64` (`object_type = 101`, `object_size = 32 + 40 + valid_len` + 4B padding)
            let valid_len = usize::from(frame.dlc).min(MAX_CAN_FD_DLC);
            let object_size = (32 + 40 + valid_len) as u32;
            write_inner_v1_header(
                &mut inner_stream,
                object_size,
                BLF_OBJ_CAN_FD_MESSAGE_64,
                ts_ns,
            );

            let channel = frame.bus_id.saturating_add(1);
            let dlc_code = len_to_canfd_dlc_code(valid_len as u8);
            let mut fd64_flags = 0x1000u32; // CAN-FD flag
            if frame.is_brs() {
                fd64_flags |= 0x2000;
            }
            if frame.is_esi() {
                fd64_flags |= 0x4000;
            }
            if frame.is_rtr() {
                fd64_flags |= 0x0010;
            }
            if frame.is_tx() {
                fd64_flags |= 0x0001;
            }
            let dir = if frame.is_tx() { 1u8 } else { 0u8 };

            // 40-byte `VBLCANFDMessage64` body (`<BBBBLLLLLLLHBBL`)
            inner_stream.push(channel); // 0
            inner_stream.push(dlc_code); // 1
            inner_stream.push(valid_len as u8); // 2
            inner_stream.push(0u8); // 3: tx_count
            inner_stream.extend_from_slice(&raw_id.to_le_bytes()); // 4..8
            inner_stream.extend_from_slice(&0u32.to_le_bytes()); // 8..12: frame_length
            inner_stream.extend_from_slice(&fd64_flags.to_le_bytes()); // 12..16: flags
            inner_stream.extend_from_slice(&[0u8; 16]); // 16..32: btr_cfg_arb, btr_cfg_data, brs_ns, crc_del_ns
            inner_stream.extend_from_slice(&0u16.to_le_bytes()); // 32..34: bit_count
            inner_stream.push(dir); // 34: dir
            inner_stream.push(0u8); // 35: ext_data_offset
            inner_stream.extend_from_slice(&0u32.to_le_bytes()); // 36..40: crc
            inner_stream.extend_from_slice(&frame.data[..valid_len]); // 40..40+valid_len

            let pad = (4 - ((object_size as usize) % 4)) % 4;
            if pad > 0 {
                inner_stream.extend_from_slice(&[0u8; 3][..pad]);
            }
        }
    }

    let total_inner_uncompressed_bytes = inner_stream.len();
    let mut out = vec![0u8; BLF_FILE_HEADER_SIZE];

    for chunk in inner_stream.chunks(BLF_CONTAINER_CHUNK_SIZE) {
        let mut encoder = ZlibEncoder::new(Vec::new(), Compression::fast());
        encoder.write_all(chunk).map_err(|e| {
            HalError::InvalidInput(format!("Failed to zlib-compress BLF LOG_CONTAINER: {e}"))
        })?;
        let compressed = encoder.finish().map_err(|e| {
            HalError::InvalidInput(format!(
                "Failed to finalize BLF LOG_CONTAINER zlib stream: {e}"
            ))
        })?;

        let container_obj_size = (32 + compressed.len()) as u32;
        let container_pad = (4 - ((container_obj_size as usize) % 4)) % 4;

        // Outer `LOG_CONTAINER` (`object_type = 10`, `header_size = 16`, `header_version = 1`)
        out.extend_from_slice(BLF_OBJECT_SIGNATURE); // 0..4
        out.extend_from_slice(&16u16.to_le_bytes()); // 4..6: header_size
        out.extend_from_slice(&1u16.to_le_bytes()); // 6..8: header_version
        out.extend_from_slice(&container_obj_size.to_le_bytes()); // 8..12: object_size
        out.extend_from_slice(&BLF_OBJ_LOG_CONTAINER.to_le_bytes()); // 12..16: object_type = 10
        out.extend_from_slice(&BLF_COMPRESSION_ZLIB.to_le_bytes()); // 16..18: compression_method = 2
        out.extend_from_slice(&[0u8; 6]); // 18..24: reserved
        out.extend_from_slice(&(chunk.len() as u32).to_le_bytes()); // 24..28: uncompressed_size
        out.extend_from_slice(&[0u8; 4]); // 28..32: reserved
        out.extend_from_slice(&compressed); // 32..32+compressed.len()
        if container_pad > 0 {
            out.extend_from_slice(&[0u8; 3][..container_pad]);
        }
    }

    let total_file_bytes = out.len() as u64;
    let uncompressed_file_bytes = (BLF_FILE_HEADER_SIZE + total_inner_uncompressed_bytes) as u64;
    let object_count = u32::try_from(entries.len()).unwrap_or(u32::MAX);

    write_logg_file_header(
        &mut out[..BLF_FILE_HEADER_SIZE],
        total_file_bytes,
        uncompressed_file_bytes,
        object_count,
    );

    Ok(out)
}

#[inline]
fn write_inner_v1_header(buf: &mut Vec<u8>, object_size: u32, object_type: u32, ts_ns: u64) {
    buf.extend_from_slice(BLF_OBJECT_SIGNATURE); // 0..4: "LOBJ"
    buf.extend_from_slice(&32u16.to_le_bytes()); // 4..6: header_size = 32
    buf.extend_from_slice(&1u16.to_le_bytes()); // 6..8: header_version = 1
    buf.extend_from_slice(&object_size.to_le_bytes()); // 8..12: object_size
    buf.extend_from_slice(&object_type.to_le_bytes()); // 12..16: object_type
    buf.extend_from_slice(&BL_OBJ_FLAG_TIME_ONE_NANS.to_le_bytes()); // 16..20: object_flags = 0x02
    buf.extend_from_slice(&0u16.to_le_bytes()); // 20..22: client_index
    buf.extend_from_slice(&0u16.to_le_bytes()); // 22..24: object_version
    buf.extend_from_slice(&ts_ns.to_le_bytes()); // 24..32: object_timestamp (ns)
}

#[inline]
fn write_logg_file_header(
    hdr: &mut [u8],
    file_size: u64,
    uncompressed_size: u64,
    object_count: u32,
) {
    hdr.fill(0);
    hdr[0..4].copy_from_slice(BLF_FILE_SIGNATURE);
    hdr[4..8].copy_from_slice(&(BLF_FILE_HEADER_SIZE as u32).to_le_bytes());
    hdr[8..12].copy_from_slice(&0x0409_0000u32.to_le_bytes()); // api_version
    hdr[12] = 5u8; // app_id (CANoe)
    hdr[13] = 6u8; // compression_level
    hdr[14] = 4u8; // major
    hdr[15] = 9u8; // minor
    hdr[16..24].copy_from_slice(&file_size.to_le_bytes());
    hdr[24..32].copy_from_slice(&uncompressed_size.to_le_bytes());
    hdr[32..36].copy_from_slice(&object_count.to_le_bytes());
    hdr[36..40].copy_from_slice(&1u32.to_le_bytes()); // app_build
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blf_roundtrip_classical_ext_and_canfd_64_compressed() {
        // 1. Standard 11-bit (`0x101`), Bus 0, Rx, 8-byte payload @ rel_us = 0
        let f_std = RawCanFrame::new_classical(
            0,
            CanIdKey::Standard(0x101),
            &[0x10, 0x27, 0xA5, 0x5A, 0x01, 0x02, 0x03, 0x04],
            SYNTHETIC_TRACE_ORIGIN_US,
        )
        .expect("std classical frame");

        // 2. Extended 29-bit (`0x18FF50E5`), Bus 1, Tx flag set, 8-byte payload @ rel_us = 12_500
        let mut f_ext_tx = RawCanFrame::new_classical(
            1,
            CanIdKey::Extended(0x18FF_50E5),
            &[0xDE, 0xAD, 0xBE, 0xEF, 0xCA, 0xFE, 0xBA, 0xBE],
            SYNTHETIC_TRACE_ORIGIN_US + 12_500,
        )
        .expect("ext classical frame");
        f_ext_tx.flags |= FLAG_TX;

        // 3. 48-byte CAN-FD + BRS (`0x205`), Bus 0, Rx @ rel_us = 25_000
        let mut payload_48 = [0u8; 48];
        for (i, b) in payload_48.iter_mut().enumerate() {
            *b = ((i * 7 + 3) & 0xFF) as u8;
        }
        let f_fd_48 = RawCanFrame::new_fd(
            0,
            CanIdKey::Standard(0x205),
            &payload_48,
            true,
            SYNTHETIC_TRACE_ORIGIN_US + 25_000,
        )
        .expect("48B CAN-FD BRS frame");

        // 4. 64-byte CAN-FD + BRS + ESI + TX (`0x205`), Bus 2 @ rel_us = 50_750
        let mut payload_64 = [0u8; 64];
        for (i, b) in payload_64.iter_mut().enumerate() {
            *b = (0xFF - (i as u8)).wrapping_mul(3);
        }
        let mut f_fd_64 = RawCanFrame::new_fd(
            2,
            CanIdKey::Standard(0x205),
            &payload_64,
            true,
            SYNTHETIC_TRACE_ORIGIN_US + 50_750,
        )
        .expect("64B CAN-FD BRS frame");
        f_fd_64.flags |= FLAG_ESI | FLAG_TX;

        // 5. 5-byte CAN-FD (tests non-4-byte-aligned `object_size = 32 + 40 + 5 = 77` + 3B padding!)
        let f_fd_odd = RawCanFrame::new_fd(
            0,
            CanIdKey::Extended(0x18DA_10F1),
            &[0x11, 0x22, 0x33, 0x44, 0x55],
            true,
            SYNTHETIC_TRACE_ORIGIN_US + 75_000,
        )
        .expect("5B CAN-FD frame");

        let original = vec![
            CompiledReplayEntry {
                rel_us: 0,
                frame: f_std,
            },
            CompiledReplayEntry {
                rel_us: 12_500,
                frame: f_ext_tx,
            },
            CompiledReplayEntry {
                rel_us: 25_000,
                frame: f_fd_48,
            },
            CompiledReplayEntry {
                rel_us: 50_750,
                frame: f_fd_64,
            },
            CompiledReplayEntry {
                rel_us: 75_000,
                frame: f_fd_odd,
            },
        ];

        let blf_bytes = encode_blf_bytes(&original).expect("encode BLF");
        assert!(is_blf_bytes(&blf_bytes));
        assert_eq!(&blf_bytes[0..4], b"LOGG");
        assert_eq!(read_u32_le(&blf_bytes, 4).unwrap(), 144);
        assert_eq!(read_u64_le(&blf_bytes, 16).unwrap(), blf_bytes.len() as u64);
        assert_eq!(read_u32_le(&blf_bytes, 32).unwrap(), 5);

        let decoded = parse_blf_bytes(&blf_bytes).expect("parse BLF");
        assert_eq!(decoded.len(), original.len());

        for (idx, (got, exp)) in decoded.iter().zip(original.iter()).enumerate() {
            assert_eq!(got.rel_us, exp.rel_us, "rel_us mismatch at index {idx}");
            assert_eq!(
                got.frame.bus_id, exp.frame.bus_id,
                "bus_id mismatch at index {idx}"
            );
            assert_eq!(
                got.frame.arb_id, exp.frame.arb_id,
                "arb_id mismatch at index {idx}"
            );
            assert_eq!(
                got.frame.is_extended(),
                exp.frame.is_extended(),
                "is_extended mismatch at index {idx}"
            );
            assert_eq!(
                got.frame.is_fd(),
                exp.frame.is_fd(),
                "is_fd mismatch at index {idx}"
            );
            assert_eq!(
                got.frame.is_brs(),
                exp.frame.is_brs(),
                "is_brs mismatch at index {idx}"
            );
            assert_eq!(
                got.frame.is_esi(),
                exp.frame.is_esi(),
                "is_esi mismatch at index {idx}"
            );
            assert_eq!(
                got.frame.is_tx(),
                exp.frame.is_tx(),
                "is_tx mismatch at index {idx}"
            );
            assert_eq!(got.frame.dlc, exp.frame.dlc, "dlc mismatch at index {idx}");
            assert_eq!(
                got.frame.payload(),
                exp.frame.payload(),
                "payload mismatch at index {idx}"
            );
            assert_eq!(
                got, exp,
                "exact CompiledReplayEntry equality at index {idx}"
            );
        }
    }

    #[test]
    fn blf_multi_container_boundary_split_and_legacy_object_types() {
        // 1. Generate 1,500 x 64B CAN-FD frames (~204 KiB inner stream > 128 KiB chunk size)
        //    so inner `LOBJ` records split directly across two zlib `LOG_CONTAINER` boundaries!
        let mut many_entries = Vec::with_capacity(1_500);
        for i in 0..1_500u64 {
            let mut payload = [0u8; 64];
            payload[0..8].copy_from_slice(&i.to_le_bytes());
            payload[63] = (i & 0xFF) as u8;
            let rel_us = i * 500;
            let frame = RawCanFrame::new_fd(
                (i % 2) as u8,
                CanIdKey::Standard(0x201),
                &payload,
                true,
                SYNTHETIC_TRACE_ORIGIN_US + rel_us,
            )
            .expect("64B FD frame");
            many_entries.push(CompiledReplayEntry { rel_us, frame });
        }

        let multi_bytes = encode_blf_bytes(&many_entries).expect("encode multi-container BLF");
        let parsed_many = parse_blf_bytes(&multi_bytes).expect("parse multi-container BLF");
        assert_eq!(parsed_many.len(), 1_500);
        assert_eq!(parsed_many, many_entries);

        // 2. Empty BLF header roundtrip
        let empty_blf = encode_blf_bytes(&[]).expect("encode empty BLF");
        assert_eq!(empty_blf.len(), 144);
        assert!(is_blf_bytes(&empty_blf));
        assert!(parse_blf_bytes(&empty_blf)
            .expect("parse empty BLF")
            .is_empty());

        // 3. Verify `CAN_FD_MESSAGE` (type 100) + `header_version = 2` (40B) + `TIME_TEN_MICS` (0x01)
        let mut custom = vec![0u8; BLF_FILE_HEADER_SIZE];
        let obj_size = 40u32 + 20u32 + 12u32; // 72 bytes
        custom.extend_from_slice(BLF_OBJECT_SIGNATURE);
        custom.extend_from_slice(&40u16.to_le_bytes()); // header_size = 40 (v2)
        custom.extend_from_slice(&2u16.to_le_bytes()); // header_version = 2
        custom.extend_from_slice(&obj_size.to_le_bytes());
        custom.extend_from_slice(&BLF_OBJ_CAN_FD_MESSAGE.to_le_bytes()); // 100
        custom.extend_from_slice(&BL_OBJ_FLAG_TIME_TEN_MICS.to_le_bytes()); // 10us ticks
        custom.extend_from_slice(&[0u8; 4]); // time_status, reserved, obj_version
        custom.extend_from_slice(&2_500u64.to_le_bytes()); // 2500 * 10us = 25_000us
        custom.extend_from_slice(&0u64.to_le_bytes()); // original_timestamp
                                                       // Payload (20B header + 12B data):
        custom.extend_from_slice(&2u16.to_le_bytes()); // channel 2 -> bus_id 1
        custom.push(0x01); // TX flag
        custom.push(9); // DLC 9 (12B)
        custom.extend_from_slice(&(0x18FF_50E5u32 | BLF_EXT_ID_FLAG).to_le_bytes());
        custom.extend_from_slice(&0u32.to_le_bytes()); // frame_length
        custom.push(0); // arb_bit_count
        custom.push(0x01 | 0x02); // fd_flags: FD + BRS
        custom.push(12); // valid_data_bytes = 12
        custom.extend_from_slice(&[0u8; 5]); // padding to offset 20
        custom.extend_from_slice(&[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
        let total_len = custom.len() as u64;
        write_logg_file_header(&mut custom[..BLF_FILE_HEADER_SIZE], total_len, total_len, 1);

        let parsed_fd100 = parse_blf_bytes(&custom).expect("parse type 100 v2 BLF");
        assert_eq!(parsed_fd100.len(), 1);
        assert_eq!(parsed_fd100[0].rel_us, 0);
        assert_eq!(parsed_fd100[0].frame.bus_id, 1);
        assert_eq!(parsed_fd100[0].frame.arb_id, 0x18FF_50E5);
        assert!(parsed_fd100[0].frame.is_extended());
        assert!(parsed_fd100[0].frame.is_fd());
        assert!(parsed_fd100[0].frame.is_brs());
        assert!(parsed_fd100[0].frame.is_tx());
        assert_eq!(
            parsed_fd100[0].frame.payload(),
            &[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
        );
    }
}
