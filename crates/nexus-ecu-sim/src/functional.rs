//! Functional addressing (ISO 15765-4 / ISO 14229-1 §7.3): requests on the
//! functional ID (e.g. 0x7DF) must be **Single Frames**. The simulator reads
//! them from a `CAN_RAW` socket and decodes the SF itself, so a First /
//! Consecutive Frame on the functional ID is ignored (no FlowControl is ever
//! sent for it), unlike a kernel ISO-TP socket which would answer an FF.

/// Why a functional CAN frame was not accepted as a request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotSingleFrame {
    Empty,
    /// First Frame (PCI 0x1): multi-frame requests are not allowed functionally.
    FirstFrame,
    /// Consecutive Frame (PCI 0x2).
    ConsecutiveFrame,
    /// FlowControl (PCI 0x3).
    FlowControl,
    /// Reserved PCI type or SF_DL inconsistent with the frame length.
    Invalid,
}

impl std::fmt::Display for NotSingleFrame {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Empty => "empty frame",
            Self::FirstFrame => "First Frame on the functional ID (multi-frame not allowed)",
            Self::ConsecutiveFrame => "Consecutive Frame on the functional ID",
            Self::FlowControl => "FlowControl on the functional ID",
            Self::Invalid => "invalid Single Frame PCI / length",
        })
    }
}

/// Decodes the payload of an ISO 15765-2 Single Frame (classical or CAN FD).
///
/// * `len <= 8`: PCI `0x0L`, `L = 1..=7`, `L <= len - 1` (padding allowed).
/// * `len > 8` (CAN FD): escape PCI `0x00`, `SF_DL` in byte 1, `8..=len - 2`.
pub fn decode_single_frame(frame: &[u8]) -> Result<&[u8], NotSingleFrame> {
    let Some(&pci) = frame.first() else {
        return Err(NotSingleFrame::Empty);
    };
    match pci >> 4 {
        0x0 => {}
        0x1 => return Err(NotSingleFrame::FirstFrame),
        0x2 => return Err(NotSingleFrame::ConsecutiveFrame),
        0x3 => return Err(NotSingleFrame::FlowControl),
        _ => return Err(NotSingleFrame::Invalid),
    }
    if frame.len() <= 8 {
        let n = usize::from(pci & 0x0F);
        if n == 0 || n + 1 > frame.len() {
            return Err(NotSingleFrame::Invalid);
        }
        Ok(&frame[1..1 + n])
    } else {
        if pci != 0x00 || frame.len() < 2 {
            return Err(NotSingleFrame::Invalid);
        }
        let n = usize::from(frame[1]);
        if n < 8 || n + 2 > frame.len() {
            return Err(NotSingleFrame::Invalid);
        }
        Ok(&frame[2..2 + n])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classical_single_frames() {
        assert_eq!(
            decode_single_frame(&[0x02, 0x3E, 0x80]),
            Ok(&[0x3E, 0x80][..])
        );
        // padded
        assert_eq!(
            decode_single_frame(&[0x03, 0x28, 0x83, 0x01, 0xAA, 0xAA, 0xAA, 0xAA]),
            Ok(&[0x28, 0x83, 0x01][..])
        );
        assert_eq!(
            decode_single_frame(&[0x07, 1, 2, 3, 4, 5, 6, 7]),
            Ok(&[1, 2, 3, 4, 5, 6, 7][..])
        );
        assert_eq!(
            decode_single_frame(&[0x00, 0x3E]),
            Err(NotSingleFrame::Invalid)
        );
        assert_eq!(
            decode_single_frame(&[0x03, 0x3E, 0x00]),
            Err(NotSingleFrame::Invalid)
        );
        assert_eq!(decode_single_frame(&[]), Err(NotSingleFrame::Empty));
    }

    #[test]
    fn multi_frame_pcis_rejected() {
        assert_eq!(
            decode_single_frame(&[0x10, 0x14, 0x2E, 0xF1, 0x90, 1, 2, 3]),
            Err(NotSingleFrame::FirstFrame)
        );
        assert_eq!(
            decode_single_frame(&[0x21, 1, 2, 3, 4, 5, 6, 7]),
            Err(NotSingleFrame::ConsecutiveFrame)
        );
        assert_eq!(
            decode_single_frame(&[0x30, 0, 0]),
            Err(NotSingleFrame::FlowControl)
        );
        assert_eq!(
            decode_single_frame(&[0x40, 0]),
            Err(NotSingleFrame::Invalid)
        );
    }

    #[test]
    fn can_fd_escape_single_frame() {
        let mut f = vec![0x00, 10];
        f.extend(1..=10u8);
        f.resize(12, 0xCC);
        assert_eq!(decode_single_frame(&f), Ok(&f[2..12]));
        let mut short = vec![0x00, 7];
        short.resize(12, 0);
        assert_eq!(decode_single_frame(&short), Err(NotSingleFrame::Invalid));
        let mut long = vec![0x00, 20];
        long.resize(12, 0);
        assert_eq!(decode_single_frame(&long), Err(NotSingleFrame::Invalid));
    }
}
