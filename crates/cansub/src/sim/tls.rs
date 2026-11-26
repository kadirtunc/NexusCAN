//! Emulator TLS: run-time rcgen test root CA + device certificate, TLS 1.2 single-suite rustls server.

use std::sync::Arc;

use rcgen::{
    BasicConstraints, CertificateParams, DistinguishedName, DnType, ExtendedKeyUsagePurpose, IsCa,
    Issuer, KeyPair, KeyUsagePurpose,
};
use rustls::crypto::{ring, CryptoProvider};
use rustls::ServerConfig;
use rustls_pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};

/// Generated certificate material.
pub(crate) struct SimTls {
    pub(crate) config: Arc<ServerConfig>,
    pub(crate) root_der: Vec<u8>,
    pub(crate) root_pem: String,
}

fn io_err(e: impl std::fmt::Display) -> std::io::Error {
    std::io::Error::other(format!("cansub-sim TLS setup: {e}"))
}

/// Builds the device-faithful TLS server: TLS 1.2 only, `ECDHE-ECDSA-AES128-GCM-SHA256` only, ECDSA P-256
/// certificate with SANs `<id>-usb.local` and `<id>-eth.local` (no IP SAN, like the real device).
pub(crate) fn build(device_id: &str) -> std::io::Result<SimTls> {
    let ca_key = KeyPair::generate().map_err(io_err)?; // ECDSA P-256 / SHA-256
    let mut ca_params = CertificateParams::new(Vec::<String>::new()).map_err(io_err)?;
    let mut dn = DistinguishedName::new();
    dn.push(DnType::CommonName, "CANsub root (cansub-sim test CA)");
    ca_params.distinguished_name = dn;
    ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    ca_params.key_usages = vec![
        KeyUsagePurpose::KeyCertSign,
        KeyUsagePurpose::CrlSign,
        KeyUsagePurpose::DigitalSignature,
    ];
    let ca_cert = ca_params.self_signed(&ca_key).map_err(io_err)?;
    let root_der = ca_cert.der().to_vec();
    let root_pem = ca_cert.pem();
    let issuer = Issuer::new(ca_params, ca_key);

    let dev_key = KeyPair::generate().map_err(io_err)?;
    let mut dev_params = CertificateParams::new(vec![
        format!("{device_id}-usb.local"),
        format!("{device_id}-eth.local"),
    ])
    .map_err(io_err)?;
    let mut dn = DistinguishedName::new();
    dn.push(DnType::CommonName, format!("CANsub {device_id}"));
    dev_params.distinguished_name = dn;
    dev_params.is_ca = IsCa::ExplicitNoCa;
    dev_params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
    dev_params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    let dev_cert = dev_params.signed_by(&dev_key, &issuer).map_err(io_err)?;

    let provider = CryptoProvider {
        cipher_suites: vec![ring::cipher_suite::TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256],
        ..ring::default_provider()
    };
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(dev_key.serialize_der()));
    let config = ServerConfig::builder_with_provider(Arc::new(provider))
        .with_protocol_versions(&[&rustls::version::TLS12])
        .map_err(io_err)?
        .with_no_client_auth()
        .with_single_cert(vec![CertificateDer::from(dev_cert.der().to_vec())], key)
        .map_err(io_err)?;
    Ok(SimTls {
        config: Arc::new(config),
        root_der,
        root_pem,
    })
}
