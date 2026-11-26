//! ASAM MDF4 CAN_DataFrame import through the falcon_mdf reader.

use super::replay::CompiledReplayEntry;
use crate::error::HalError;
use falcon_mdf::{ChannelGroup, Mf4File};
use nexus_core::{dlc_code_to_len, CanIdKey, RawCanFrame, FLAG_ESI, FLAG_TX};

// Match Trace's maximum retained row count until import can page through large files.
const MAX_MF4_FRAMES: usize = 100_000;

pub(super) fn is_mf4_bytes(bytes: &[u8]) -> bool {
    (bytes.starts_with(b"MDF     ") || bytes.starts_with(b"UnFinMF "))
        && bytes.get(8) == Some(&b'4')
}

fn invalid(error: impl std::fmt::Display) -> HalError {
    HalError::InvalidInput(format!("MF4: {error}"))
}

fn read_column(
    file: &Mf4File,
    group: &ChannelGroup,
    name: &str,
    count: usize,
) -> Result<Option<Vec<f64>>, HalError> {
    let Some(channel) = group.find_channel(&format!("CAN_DataFrame.{name}")) else {
        return Ok(None);
    };
    let values = file
        .signal(channel)
        .and_then(|signal| signal.values())
        .map_err(invalid)?
        .to_f64();
    if values.len() != count {
        return Err(invalid(format!("invalid {name} sample count")));
    }
    Ok(Some(values))
}

fn flag(column: &Option<Vec<f64>>, index: usize) -> bool {
    column.as_ref().is_some_and(|values| values[index] == 1.0)
}

pub(super) fn parse_mf4_bytes(bytes: &[u8]) -> Result<Vec<CompiledReplayEntry>, HalError> {
    if !is_mf4_bytes(bytes) {
        return Err(invalid("expected an ASAM MDF 4 file"));
    }
    let file = Mf4File::from_bytes(bytes.to_vec()).map_err(invalid)?;
    let mut entries = Vec::new();

    for group in file.can_frame_groups() {
        let remaining = MAX_MF4_FRAMES - entries.len();
        if group.sample_count > remaining as u64 {
            return Err(invalid(format!(
                "Trace supports up to {MAX_MF4_FRAMES} MF4 frames per import"
            )));
        }
        let frames = file.can_frames(group).map_err(invalid)?;
        let count = frames.len();
        if count > remaining {
            return Err(invalid(format!(
                "Trace supports up to {MAX_MF4_FRAMES} MF4 frames per import"
            )));
        }
        let edl = read_column(&file, group, "EDL", count)?;
        let brs = read_column(&file, group, "BRS", count)?;
        let esi = read_column(&file, group, "ESI", count)?;
        let direction = read_column(&file, group, "Dir", count)?;
        let raw_id = if group.find_channel("CAN_DataFrame.IDE").is_none() {
            read_column(&file, group, "ID", count)?
        } else {
            None
        };
        let dlc = read_column(&file, group, "DLC", count)?;
        let length = read_column(&file, group, "DataLength", count)?;
        for index in 0..count {
            let frame = frames
                .get(index)
                .ok_or_else(|| invalid("incomplete CAN frame"))?;
            if !frame.timestamp.is_finite() {
                return Err(invalid("invalid CAN timestamp"));
            }
            let encoded_id = raw_id
                .as_ref()
                .map_or(frame.id, |values| values[index] as u32);
            let extended = frame
                .extended
                .unwrap_or(encoded_id & 0x8000_0000 != 0 || frame.id > 0x7ff);
            let id = if extended {
                CanIdKey::new_extended(frame.id)
            } else {
                u16::try_from(frame.id)
                    .ok()
                    .and_then(CanIdKey::new_standard)
            }
            .ok_or_else(|| invalid("CAN ID is outside its declared range"))?;
            let is_brs = flag(&brs, index);
            let is_fd = edl.as_ref().map_or_else(
                || {
                    is_brs
                        || flag(&esi, index)
                        || length.as_ref().is_some_and(|values| values[index] > 8.0)
                        || dlc.as_ref().is_some_and(|values| values[index] > 8.0)
                        || (length.is_none() && dlc.is_none() && frame.data.len() > 8)
                },
                |values| values[index] == 1.0,
            );
            let payload_len = length
                .as_ref()
                .map(|values| values[index])
                .or_else(|| {
                    dlc.as_ref().map(|values| {
                        let code = values[index];
                        if (0.0..=15.0).contains(&code) && code.fract() == 0.0 {
                            f64::from(dlc_code_to_len(code as u8, is_fd))
                        } else {
                            f64::NAN
                        }
                    })
                })
                .unwrap_or(frame.data.len() as f64);
            if !(0.0..=frame.data.len() as f64).contains(&payload_len) || payload_len.fract() != 0.0
            {
                return Err(invalid("invalid CAN payload length"));
            }
            let payload = &frame.data[..payload_len as usize];
            let mut raw = if is_fd {
                RawCanFrame::new_fd(frame.bus_channel, id, payload, is_brs, 0)
            } else {
                RawCanFrame::new_classical(frame.bus_channel, id, payload, 0)
            }
            .map_err(invalid)?;
            if usize::from(raw.dlc) != payload.len() {
                return Err(invalid(
                    "CAN FD payload length is not representable by its DLC",
                ));
            }
            if flag(&esi, index) {
                raw.flags |= FLAG_ESI;
            }
            if flag(&direction, index) {
                raw.flags |= FLAG_TX;
            }
            entries.push((frame.timestamp, raw));
        }
    }

    if entries.is_empty() {
        return Err(invalid("no CAN data frames found"));
    }
    entries.sort_by(|left, right| left.0.total_cmp(&right.0));
    let origin = entries[0].0;
    entries
        .into_iter()
        .map(|(time, mut frame)| {
            let rel_us = ((time - origin) * 1_000_000.0).round();
            if rel_us >= (u64::MAX - super::replay::SYNTHETIC_TRACE_ORIGIN_US) as f64 {
                return Err(invalid("CAN timestamp span exceeds Trace range"));
            }
            let rel_us = rel_us as u64;
            frame.timestamp_us = super::replay::SYNTHETIC_TRACE_ORIGIN_US + rel_us;
            Ok(CompiledReplayEntry { rel_us, frame })
        })
        .collect()
}
