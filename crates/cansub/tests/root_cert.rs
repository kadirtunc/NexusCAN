//! C0: the embedded CSS root CA must match the pinned SHA-256 fingerprint (contract §2.6).

use base64::Engine as _;
use sha2::{Digest, Sha256};

fn pem_to_der(pem: &str) -> Vec<u8> {
    let body: String = pem
        .lines()
        .filter(|l| !l.starts_with("-----"))
        .flat_map(|l| l.trim().chars())
        .collect();
    base64::engine::general_purpose::STANDARD
        .decode(body)
        .expect("valid base64 PEM body")
}

#[test]
fn css_root_ca_fingerprint_is_pinned() {
    let pem = cansub::certs::CSS_ROOT_CA_PEM;
    assert!(pem.starts_with("-----BEGIN CERTIFICATE-----"));
    assert_eq!(
        pem.matches("BEGIN CERTIFICATE").count(),
        1,
        "exactly one certificate"
    );
    let digest = Sha256::digest(pem_to_der(pem));
    assert_eq!(digest.as_slice(), &cansub::certs::CSS_ROOT_CA_SHA256);
    assert_eq!(
        hex::encode_upper(digest),
        "D064C85905195400216A11BB50D754865ED2B5F997D36A9EA2EA97883B15D0F1"
    );
}
