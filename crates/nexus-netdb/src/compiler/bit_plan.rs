use crate::error::BitPlanError;
use crate::ir::ByteOrder;
use smallvec::SmallVec;

/// Pre-compiled, normalized bit coordinates for a signal within a CAN/CAN-FD payload (0..64 bytes = 0..512 bits).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NormalizedBitSpan {
    pub start_bit: u16,
    pub bit_len: u8,
    pub byte_order: ByteOrder,
    pub min_byte: u8,
    pub max_byte: u8,
    /// bit_coords[k] contains (byte_index, bit_in_byte) for signal bit k (0 <= k < bit_len).
    /// k = 0 is the Least Significant Bit (LSB, weight 2^0).
    /// k = bit_len - 1 is the Most Significant Bit (MSB, weight 2^(bit_len - 1)).
    pub bit_coords: SmallVec<[(u8, u8); 64]>,
}

impl NormalizedBitSpan {
    pub fn compile(
        start_bit: u16,
        bit_len: u8,
        byte_order: ByteOrder,
    ) -> Result<Self, BitPlanError> {
        if start_bit >= 512 {
            return Err(BitPlanError::StartBitOutOfRange {
                start_bit,
                max_allowed: 511,
            });
        }
        if bit_len == 0 {
            return Err(BitPlanError::BitLengthZero);
        }
        if bit_len > 64 {
            return Err(BitPlanError::BitLengthTooLarge {
                bit_len,
                max_allowed: 64,
            });
        }

        let bit_coords = trace_signal_bits(start_bit, bit_len, byte_order)?;

        let mut min_byte = 64u8;
        let mut max_byte = 0u8;

        for &(byte_idx, _) in &bit_coords {
            if byte_idx < min_byte {
                min_byte = byte_idx;
            }
            if byte_idx > max_byte {
                max_byte = byte_idx;
            }
        }

        Ok(Self {
            start_bit,
            bit_len,
            byte_order,
            min_byte,
            max_byte,
            bit_coords,
        })
    }

    /// Extracts raw unsigned 64-bit value from payload bytes using precomputed coordinates.
    /// Operates directly on &[u8] without heap allocation or single-u64 payload casts.
    #[inline(always)]
    pub fn extract_raw_u64(&self, payload: &[u8]) -> u64 {
        let mut raw = 0u64;
        let len = payload.len();

        for (k, &(byte_idx, bit_in_byte)) in self.bit_coords.iter().enumerate() {
            let b_idx = byte_idx as usize;
            if b_idx < len {
                let bit_val = ((payload[b_idx] >> bit_in_byte) & 1) as u64;
                raw |= bit_val << k;
            }
        }

        raw
    }

    /// Packs raw unsigned 64-bit value into destination 64-byte payload.
    /// Zero heap allocation.
    #[inline(always)]
    pub fn pack_raw_u64(&self, raw: u64, payload: &mut [u8; 64]) {
        for (k, &(byte_idx, bit_in_byte)) in self.bit_coords.iter().enumerate() {
            let b_idx = byte_idx as usize;
            if b_idx < 64 {
                let bit_val = ((raw >> k) & 1) as u8;
                payload[b_idx] = (payload[b_idx] & !(1 << bit_in_byte)) | (bit_val << bit_in_byte);
            }
        }
    }
}

/// Traces the exact bit coordinates (byte_idx, bit_in_byte) for each bit of a signal.
/// Returns bit coordinates ordered from LSB (signal bit 0) to MSB (signal bit bit_len - 1).
pub fn trace_signal_bits(
    start_bit: u16,
    bit_len: u8,
    byte_order: ByteOrder,
) -> Result<SmallVec<[(u8, u8); 64]>, BitPlanError> {
    let mut coords: SmallVec<[(u8, u8); 64]> = SmallVec::with_capacity(bit_len as usize);

    match byte_order {
        ByteOrder::LittleEndian => {
            // Intel (@1): start_bit is LSB. Bit k is at start_bit + k.
            if (start_bit as u32) + (bit_len as u32) > 512 {
                return Err(BitPlanError::SpanExceedsPayload {
                    start_bit,
                    bit_len,
                    max_bits: 512,
                });
            }

            for k in 0..bit_len {
                let pos = start_bit + (k as u16);
                let byte_idx = (pos / 8) as u8;
                let bit_in_byte = (pos % 8) as u8;
                coords.push((byte_idx, bit_in_byte));
            }
        }
        ByteOrder::BigEndian => {
            // Motorola (@0 Vector Sawtooth): start_bit is MSB.
            // Stepping from MSB (bit_len - 1) down to LSB (0).
            let mut msb_to_lsb: SmallVec<[(u8, u8); 64]> =
                SmallVec::with_capacity(bit_len as usize);

            let mut curr_byte = (start_bit / 8) as usize;
            let mut curr_bit = (start_bit % 8) as i8;

            for _ in 0..bit_len {
                if curr_byte >= 64 {
                    return Err(BitPlanError::MotorolaByteOverflow {
                        start_bit,
                        bit_len,
                        byte_index: curr_byte,
                    });
                }

                msb_to_lsb.push((curr_byte as u8, curr_bit as u8));

                if curr_bit == 0 {
                    curr_byte += 1;
                    curr_bit = 7;
                } else {
                    curr_bit -= 1;
                }
            }

            // Reverse so coords[0] is LSB (signal bit 0) and coords[bit_len - 1] is MSB
            for item in msb_to_lsb.into_iter().rev() {
                coords.push(item);
            }
        }
    }

    Ok(coords)
}
