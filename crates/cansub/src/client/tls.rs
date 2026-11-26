//! TLS 1.2 client setup and the §2.6 certificate verifier.

use std::fmt;
use std::net::{IpAddr, TcpStream, ToSocketAddrs};
use std::sync::Arc;
use std::time::Duration;

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::client::WebPkiServerVerifier;
use rustls::crypto::{ring, verify_tls12_signature, verify_tls13_signature, CryptoProvider};
use rustls::{
    CertificateError, ClientConfig, ClientConnection, DigitallySignedStruct, RootCertStore,
    SignatureScheme, StreamOwned,
};
use rustls_pki_types::pem::PemObject;
use rustls_pki_types::{CertificateDer, ServerName, UnixTime};

use super::{ConnectOptions, Error};

/// Client TLS stream used by REST and WebSocket connections.
pub(crate) type TlsStream = StreamOwned<ClientConnection, TcpStream>;

/// Parsed `ConnectOptions::host`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Endpoint {
    /// Host name or IP literal without brackets.
    pub(crate) host: String,
    pub(crate) port: u16,
    /// `Host` header / URL authority (`host`, `host:port`, `[v6]:port`).
    pub(crate) authority: String,
    pub(crate) ip: Option<IpAddr>,
}

/// Parses `name[:port]`, `ipv4[:port]`, `[v6][:port]` or a bare IPv6 literal (port 443).
pub(crate) fn parse_host(s: &str) -> Result<Endpoint, Error> {
    let bad = || Error::Protocol(format!("invalid host {s:?}"));
    let s = s.trim();
    let (host, port) = if let Some(rest) = s.strip_prefix('[') {
        let (h, tail) = rest.split_once(']').ok_or_else(bad)?;
        let port = match tail {
            "" => 443,
            t => t
                .strip_prefix(':')
                .and_then(|p| p.parse().ok())
                .ok_or_else(bad)?,
        };
        (h, port)
    } else if s.matches(':').count() == 1 {
        let (h, p) = s.split_once(':').ok_or_else(bad)?;
        (h, p.parse().map_err(|_| bad())?)
    } else {
        (s, 443)
    };
    if host.is_empty() || port == 0 {
        return Err(bad());
    }
    let ip = host.parse::<IpAddr>().ok();
    let shown = match ip {
        Some(IpAddr::V6(_)) => format!("[{host}]"),
        _ => host.to_string(),
    };
    let authority = if port == 443 {
        shown
    } else {
        format!("{shown}:{port}")
    };
    Ok(Endpoint {
        host: host.to_string(),
        port,
        authority,
        ip,
    })
}

/// §2.6 verification mode.
#[derive(Debug)]
enum Mode {
    /// Rule 1: chain + SAN `<id>-usb.local` or `<id>-eth.local`.
    Device {
        id: String,
        names: [ServerName<'static>; 2],
    },
    /// Rule 2: chain only.
    AnyDevice,
    /// Rule 3: chain + standard hostname check against the connected name.
    Hostname,
}

/// §2.6 verifier: chain validation is delegated to rustls' [`WebPkiServerVerifier`] (single root);
/// the device identity check is layered on top. `verify_server_name` runs only after the chain
/// verified, so a name mismatch from the inner verifier implies a valid chain.
struct CansubVerifier {
    inner: Arc<WebPkiServerVerifier>,
    provider: Arc<CryptoProvider>,
    mode: Mode,
}

impl fmt::Debug for CansubVerifier {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CansubVerifier")
            .field("mode", &self.mode)
            .finish_non_exhaustive()
    }
}

fn is_name_error(e: &rustls::Error) -> bool {
    matches!(
        e,
        rustls::Error::InvalidCertificate(
            CertificateError::NotValidForName | CertificateError::NotValidForNameContext { .. }
        )
    )
}

/// A name no CANsub certificate carries (rule 2 only needs the chain result).
const PLACEHOLDER_NAME: &str = "cansub.invalid";

impl ServerCertVerifier for CansubVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        match &self.mode {
            Mode::Hostname => self.inner.verify_server_cert(
                end_entity,
                intermediates,
                server_name,
                ocsp_response,
                now,
            ),
            Mode::AnyDevice => {
                let name = ServerName::try_from(PLACEHOLDER_NAME)
                    .map_err(|e| rustls::Error::General(e.to_string()))?;
                match self.inner.verify_server_cert(
                    end_entity,
                    intermediates,
                    &name,
                    ocsp_response,
                    now,
                ) {
                    Err(e) if is_name_error(&e) => Ok(ServerCertVerified::assertion()),
                    r => r,
                }
            }
            Mode::Device { id, names } => {
                for name in names {
                    match self.inner.verify_server_cert(
                        end_entity,
                        intermediates,
                        name,
                        ocsp_response,
                        now,
                    ) {
                        Err(e) if is_name_error(&e) => continue,
                        r => return r,
                    }
                }
                Err(rustls::Error::General(format!(
                    "certificate does not belong to CANsub {id} \
                     (no SAN {id}-usb.local / {id}-eth.local); check the Device ID"
                )))
            }
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

/// DER of the embedded CSS Electronics root CA (the only production trust anchor).
pub(crate) fn css_root_der() -> Result<Vec<u8>, Error> {
    CertificateDer::from_pem_slice(crate::certs::CSS_ROOT_CA_PEM.as_bytes())
        .map(|c| c.as_ref().to_vec())
        .map_err(|e| Error::Tls(format!("embedded CSS root CA: {e}")))
}

/// Everything needed to open a new TLS connection to the device.
#[derive(Debug)]
pub(crate) struct TlsTarget {
    pub(crate) endpoint: Endpoint,
    pub(crate) timeout: Duration,
    server_name: ServerName<'static>,
    config: Arc<ClientConfig>,
}

fn valid_device_id(id: &str) -> bool {
    id.len() == 8 && id.bytes().all(|b| b.is_ascii_hexdigit())
}

impl TlsTarget {
    /// Validates `opts` and builds the TLS client configuration trusting only `root_der`.
    pub(crate) fn new(opts: &ConnectOptions, root_der: &[u8]) -> Result<Self, Error> {
        let endpoint = parse_host(&opts.host)?;
        if opts.timeout.is_zero() {
            return Err(Error::Protocol("timeout must be > 0".into()));
        }
        let dns = |n: String| {
            ServerName::try_from(n)
                .map_err(|e| Error::Protocol(format!("invalid host name {:?}: {e}", opts.host)))
        };
        let (mode, server_name) = match &opts.device_id {
            Some(id) => {
                let id = id.trim().to_ascii_lowercase();
                if !valid_device_id(&id) {
                    return Err(Error::Tls(format!(
                        "Device ID {id:?} must be 8 hex digits (e.g. aabbccdd)"
                    )));
                }
                let usb = dns(format!("{id}-usb.local"))?;
                let eth = dns(format!("{id}-eth.local"))?;
                // SNI: the DNS host itself, or the USB name when connecting by IP.
                let sni = match endpoint.ip {
                    Some(_) => usb.clone(),
                    None => dns(endpoint.host.clone())?,
                };
                (
                    Mode::Device {
                        id,
                        names: [usb, eth],
                    },
                    sni,
                )
            }
            None if opts.accept_any_device => {
                let sni = match endpoint.ip {
                    Some(ip) => ServerName::IpAddress(ip.into()), // rustls sends no SNI for IPs
                    None => dns(endpoint.host.clone())?,
                };
                (Mode::AnyDevice, sni)
            }
            None => match endpoint.ip {
                Some(ip) => {
                    return Err(Error::Tls(format!(
                        "CANsub at {ip}: enter the Device ID (8 hex) or enable 'accept any CANsub'"
                    )))
                }
                None => (Mode::Hostname, dns(endpoint.host.clone())?),
            },
        };

        let provider = Arc::new(CryptoProvider {
            cipher_suites: vec![ring::cipher_suite::TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256],
            ..ring::default_provider()
        });
        let mut roots = RootCertStore::empty();
        roots
            .add(CertificateDer::from(root_der.to_vec()))
            .map_err(|e| Error::Tls(format!("root CA: {e}")))?;
        let inner = WebPkiServerVerifier::builder_with_provider(Arc::new(roots), provider.clone())
            .build()
            .map_err(|e| Error::Tls(format!("certificate verifier: {e}")))?;
        let verifier = Arc::new(CansubVerifier {
            inner,
            provider: provider.clone(),
            mode,
        });
        let config = ClientConfig::builder_with_provider(provider)
            .with_protocol_versions(&[&rustls::version::TLS12])
            .map_err(|e| Error::Tls(e.to_string()))?
            .dangerous()
            .with_custom_certificate_verifier(verifier)
            .with_no_client_auth();
        Ok(Self {
            endpoint,
            timeout: opts.timeout,
            server_name,
            config: Arc::new(config),
        })
    }

    /// TCP connect (all resolved addresses, `timeout` each) + TLS handshake. The socket keeps
    /// read / write timeouts of `timeout`.
    pub(crate) fn connect(&self) -> Result<TlsStream, Error> {
        let addrs = (self.endpoint.host.as_str(), self.endpoint.port).to_socket_addrs()?;
        let mut last = None;
        let mut tcp = None;
        for a in addrs {
            match TcpStream::connect_timeout(&a, self.timeout) {
                Ok(s) => {
                    tcp = Some(s);
                    break;
                }
                Err(e) => last = Some(e),
            }
        }
        let tcp = match (tcp, last) {
            (Some(t), _) => t,
            (None, Some(e)) => return Err(Error::Io(e)),
            (None, None) => {
                return Err(Error::Io(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    format!("{}: no address", self.endpoint.host),
                )))
            }
        };
        tcp.set_nodelay(true)?;
        tcp.set_read_timeout(Some(self.timeout))?;
        tcp.set_write_timeout(Some(self.timeout))?;
        let conn = ClientConnection::new(self.config.clone(), self.server_name.clone())
            .map_err(|e| Error::Tls(e.to_string()))?;
        let mut s = StreamOwned::new(conn, tcp);
        while s.conn.is_handshaking() {
            s.conn
                .complete_io(&mut s.sock)
                .map_err(|e| self.handshake_error(e))?;
        }
        Ok(s)
    }

    fn handshake_error(&self, e: std::io::Error) -> Error {
        match e.get_ref().and_then(|r| r.downcast_ref::<rustls::Error>()) {
            Some(tls) => Error::Tls(format!("CANsub at {}: {tls}", self.endpoint.authority)),
            None => Error::Io(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_forms() {
        let e = parse_host("aabbccdd-usb.local").unwrap();
        assert_eq!(
            (e.host.as_str(), e.port, e.ip),
            ("aabbccdd-usb.local", 443, None)
        );
        assert_eq!(e.authority, "aabbccdd-usb.local");
        let e = parse_host("10.0.0.1:8443").unwrap();
        assert_eq!((e.port, e.authority.as_str()), (8443, "10.0.0.1:8443"));
        assert!(e.ip.is_some());
        let e = parse_host("[fe80::1]:444").unwrap();
        assert_eq!((e.host.as_str(), e.port), ("fe80::1", 444));
        assert_eq!(e.authority, "[fe80::1]:444");
        let e = parse_host("fe80::1").unwrap();
        assert_eq!((e.port, e.authority.as_str()), (443, "[fe80::1]"));
        assert!(parse_host("").is_err());
        assert!(parse_host("host:x").is_err());
        assert!(parse_host("[::1").is_err());
    }

    #[test]
    fn css_root_parses() {
        let der = css_root_der().unwrap();
        let opts = ConnectOptions {
            host: "aabbccdd-usb.local".into(),
            ..ConnectOptions::default()
        };
        assert!(TlsTarget::new(&opts, &der).is_ok());
    }

    #[test]
    fn ip_without_identity_is_rejected_before_handshake() {
        let opts = ConnectOptions {
            host: "10.1.2.3".into(),
            ..ConnectOptions::default()
        };
        let der = css_root_der().unwrap();
        match TlsTarget::new(&opts, &der) {
            Err(Error::Tls(m)) => assert!(m.contains("Device ID"), "{m}"),
            other => panic!("{other:?}"),
        }
    }
}
