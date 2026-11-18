//! ECU reprogramming building blocks (ISO 14229-1 upload/download functional unit).
//!
//! * [`firmware`] — Intel HEX / S-record / binary parsing → normalised [`FirmwareImage`].
//! * [`checksum`] — CRC-32 (IEEE), CRC-16/CCITT-FALSE, sum8 / sum16.
//! * [`transfer`] — `0x34 → 0x36* → 0x37` engine over the [`UdsRequester`] abstraction.
//!
//! OEM sequences (session, security access, erase / check routines, reset) are composed by the
//! Flow editor from separate blocks; nothing here hardcodes one.
pub mod checksum;
pub mod firmware;
pub mod transfer;

pub use checksum::{crc16_ccitt, crc32_ieee, sum16, sum8, Crc16Ccitt, Crc32};
pub use firmware::{
    detect_format, from_binary, parse_intel_hex, parse_srec, FirmwareError, FirmwareFormat,
    FirmwareImage, FirmwareImageSummaryDto, FirmwareSegment, FirmwareSegmentSummaryDto,
};
pub use transfer::{
    download_image, parse_request_download_response, response_to_result, DownloadConfig,
    FlashError, FlashErrorKind, FlashPhase, FlashProgressDto, FlashReportDto, RequesterError,
    SegmentReportDto, TransferMode, UdsRequester,
};
