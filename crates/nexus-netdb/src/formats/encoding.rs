use crate::error::ParseDiagnostic;

/// Result of auto-detecting and transcoding raw file bytes to UTF-8 text.
pub struct TranscodeResult {
    pub text: String,
    pub encoding_name: &'static str,
    pub diagnostic: Option<ParseDiagnostic>,
}

/// Auto-detects text encoding and losslessly converts file bytes to valid UTF-8 String.
/// Supports UTF-8 (with or without BOM), UTF-16LE, UTF-16BE, and Windows-1252 / Latin-1.
pub fn decode_text_lossless(bytes: &[u8]) -> TranscodeResult {
    if bytes.is_empty() {
        return TranscodeResult {
            text: String::new(),
            encoding_name: "UTF-8",
            diagnostic: None,
        };
    }

    // 1. Check for UTF-8 BOM: EF BB BF
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        let content = &bytes[3..];
        match std::str::from_utf8(content) {
            Ok(valid_str) => {
                return TranscodeResult {
                    text: valid_str.to_string(),
                    encoding_name: "UTF-8-BOM",
                    diagnostic: None,
                };
            }
            Err(_) => {
                // Malformed UTF-8 after BOM, fall through to Windows-1252
            }
        }
    }

    // 2. Check for UTF-16LE BOM: FF FE
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let (cow, _, had_errors) = encoding_rs::UTF_16LE.decode(&bytes[2..]);
        let diag = if had_errors {
            Some(ParseDiagnostic::warning(
                "ENCODING_DECODE_ERRORS",
                "UTF-16LE decoding encountered unmapped replacement characters",
                None,
                None,
                Some("encoding".to_string()),
            ))
        } else {
            Some(ParseDiagnostic::info(
                "ENCODING_TRANSCODED",
                "Transcoded input from UTF-16LE to UTF-8",
                None,
                None,
                Some("encoding".to_string()),
            ))
        };
        return TranscodeResult {
            text: cow.into_owned(),
            encoding_name: "UTF-16LE",
            diagnostic: diag,
        };
    }

    // 3. Check for UTF-16BE BOM: FE FF
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let (cow, _, had_errors) = encoding_rs::UTF_16BE.decode(&bytes[2..]);
        let diag = if had_errors {
            Some(ParseDiagnostic::warning(
                "ENCODING_DECODE_ERRORS",
                "UTF-16BE decoding encountered unmapped replacement characters",
                None,
                None,
                Some("encoding".to_string()),
            ))
        } else {
            Some(ParseDiagnostic::info(
                "ENCODING_TRANSCODED",
                "Transcoded input from UTF-16BE to UTF-8",
                None,
                None,
                Some("encoding".to_string()),
            ))
        };
        return TranscodeResult {
            text: cow.into_owned(),
            encoding_name: "UTF-16BE",
            diagnostic: diag,
        };
    }

    // 4. Try standard UTF-8 without BOM
    if let Ok(valid_str) = std::str::from_utf8(bytes) {
        return TranscodeResult {
            text: valid_str.to_string(),
            encoding_name: "UTF-8",
            diagnostic: None,
        };
    }

    // 5. Fallback: Transcode from Windows-1252 / ISO-8859-1 (covers °C, µA, Ω, German umlauts, Turkish chars)
    let (cow, _, had_errors) = encoding_rs::WINDOWS_1252.decode(bytes);
    let diag = if had_errors {
        Some(ParseDiagnostic::warning(
            "ENCODING_DECODE_ERRORS",
            "Windows-1252 transcoding encountered unmapped replacement characters",
            None,
            None,
            Some("encoding".to_string()),
        ))
    } else {
        Some(ParseDiagnostic::info(
            "ENCODING_TRANSCODED",
            "Transcoded legacy industrial file from Windows-1252 / ISO-8859-1 to UTF-8",
            None,
            None,
            Some("encoding".to_string()),
        ))
    };

    TranscodeResult {
        text: cow.into_owned(),
        encoding_name: "Windows-1252",
        diagnostic: diag,
    }
}
