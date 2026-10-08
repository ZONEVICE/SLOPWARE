//! TLS for both directions, with rustls.
//!
//! Every HTTPS instance generates its own self-signed certificate at startup,
//! so peers accept any certificate (the signature over the handshake is still
//! verified against the certificate's key) and then PIN the SHA-256
//! fingerprint they saw when the session was opened. A different certificate
//! later in the same session means a different server, and the request fails
//! with `certificate_changed`. This is exactly what the Node.js implementation
//! does with `rejectUnauthorized: false` plus `fingerprint256`.

use crate::util::cert::fingerprint256;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, CryptoProvider};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, ServerConfig, SignatureScheme};
use std::io;
use std::sync::{Arc, OnceLock};

fn provider() -> Arc<CryptoProvider> {
    static PROVIDER: OnceLock<Arc<CryptoProvider>> = OnceLock::new();
    PROVIDER.get_or_init(|| Arc::new(rustls::crypto::ring::default_provider())).clone()
}

#[derive(Debug)]
struct AcceptAnyCertificate(Arc<CryptoProvider>);

impl ServerCertVerifier for AcceptAnyCertificate {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        // Self-signed by design; pinned by fingerprint once a session starts.
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

/// The client configuration every outgoing HTTPS request uses.
pub fn client_config() -> Arc<ClientConfig> {
    static CONFIG: OnceLock<Arc<ClientConfig>> = OnceLock::new();
    CONFIG
        .get_or_init(|| {
            let provider = provider();
            let config = ClientConfig::builder_with_provider(provider.clone())
                .with_safe_default_protocol_versions()
                .expect("TLS versions")
                .dangerous()
                .with_custom_certificate_verifier(Arc::new(AcceptAnyCertificate(provider)))
                .with_no_client_auth();
            Arc::new(config)
        })
        .clone()
}

/// The server configuration for this process's certificate.
pub fn server_config(cert_der: &[u8], key_der: &[u8]) -> io::Result<Arc<ServerConfig>> {
    let config = ServerConfig::builder_with_provider(provider())
        .with_safe_default_protocol_versions()
        .map_err(io::Error::other)?
        .with_no_client_auth()
        .with_single_cert(
            vec![CertificateDer::from(cert_der.to_vec())],
            PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key_der.to_vec())),
        )
        .map_err(io::Error::other)?;
    Ok(Arc::new(config))
}

/// The name to present for `host`: an IP address (no SNI is sent) or a DNS name.
pub fn server_name(host: &str) -> ServerName<'static> {
    ServerName::try_from(host.to_string()).unwrap_or_else(|_| ServerName::try_from("localhost").expect("valid name"))
}

/// Fingerprint of the first certificate a peer presented.
pub fn peer_fingerprint(certificates: Option<&[CertificateDer<'_>]>) -> Option<String> {
    certificates.and_then(|chain| chain.first()).map(|cert| fingerprint256(cert.as_ref()))
}
