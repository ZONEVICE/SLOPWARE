//! The self-signed certificate and the rustls server configuration.
//!
//! A new certificate is minted with `rcgen` on **every start** (ECDSA P-256,
//! valid from yesterday for 397 days) and written to `~/.tendril/cert/`
//! (`cert.pem`, and `key.pem` readable by the owner only), replacing the
//! previous one. Browsers will warn each time - expected for a self-signed
//! certificate - so the console prints its SHA-256 fingerprint for the user
//! to compare with what the browser shows.
//!
//! The certificate names `localhost`, `127.0.0.1`, `::1`, the host name and
//! the machine's local addresses. ALPN offers only `http/1.1`: the server
//! speaks HTTP/1.1, which keeps per-connection memory small.

use std::fs;
use std::net::IpAddr;
use std::path::Path;
use std::sync::Arc;

use rcgen::{CertificateParams, DistinguishedName, DnType, ExtendedKeyUsagePurpose, KeyPair, KeyUsagePurpose};
use ring::digest;
use rustls::ServerConfig;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};

use crate::core::{atomic, clock};

/// A freshly minted certificate and the TLS config that serves it.
pub struct Minted {
    pub config: Arc<ServerConfig>,
    /// SHA-256 of the DER certificate, `AB:CD:...`.
    pub fingerprint: String,
    pub cert_pem: String,
}

/// Subject alternative names: loopback, the host name, local addresses.
pub fn subject_names(hostname: Option<&str>, ips: &[IpAddr]) -> Vec<String> {
    let mut names = vec!["localhost".to_string(), "127.0.0.1".to_string(), "::1".to_string()];
    if let Some(host) = hostname
        && host.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.')
    {
        names.push(host.to_string());
        if !host.contains('.') {
            names.push(format!("{host}.local"));
        }
    }
    names.extend(ips.iter().map(|ip| ip.to_string()));
    names.dedup();
    names
}

/// Mints a certificate for `names`, writes it to `cert_dir` and builds the
/// rustls server configuration.
pub fn mint(cert_dir: &Path, names: Vec<String>) -> Result<Minted, String> {
    let key = KeyPair::generate().map_err(|e| format!("key generation failed: {e}"))?;
    let mut params = CertificateParams::new(names).map_err(|e| format!("invalid certificate name: {e}"))?;
    let mut dn = DistinguishedName::new();
    dn.push(DnType::CommonName, "Tendril (self-signed)");
    dn.push(DnType::OrganizationName, "Tendril");
    params.distinguished_name = dn;
    let today = clock::day_number(clock::unix_ms());
    let (y, m, d) = ymd(today - 1);
    params.not_before = rcgen::date_time_ymd(y, m, d);
    let (y, m, d) = ymd(today + 397);
    params.not_after = rcgen::date_time_ymd(y, m, d);
    params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
    params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    let cert = params.self_signed(&key).map_err(|e| format!("certificate signing failed: {e}"))?;

    let cert_pem = cert.pem();
    fs::create_dir_all(cert_dir).map_err(|e| format!("could not create {}: {e}", cert_dir.display()))?;
    atomic::write(&cert_dir.join("cert.pem"), cert_pem.as_bytes(), false)
        .map_err(|e| format!("could not write cert.pem: {e}"))?;
    atomic::write(&cert_dir.join("key.pem"), key.serialize_pem().as_bytes(), true)
        .map_err(|e| format!("could not write key.pem: {e}"))?;

    let der: CertificateDer<'static> = cert.der().clone();
    let fingerprint = fingerprint(der.as_ref());
    let private = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key.serialize_der()));
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut config = ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| format!("TLS configuration failed: {e}"))?
        .with_no_client_auth()
        .with_single_cert(vec![der], private)
        .map_err(|e| format!("TLS configuration failed: {e}"))?;
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(Minted { config: Arc::new(config), fingerprint, cert_pem })
}

/// (year, month, day) for a day number, in the types rcgen expects.
fn ymd(day: i64) -> (i32, u8, u8) {
    let (y, m, d) = clock::civil_from_days(day);
    (y as i32, m as u8, d as u8)
}

/// `AB:CD:...` SHA-256 fingerprint of DER bytes.
pub fn fingerprint(der: &[u8]) -> String {
    let hash = digest::digest(&digest::SHA256, der);
    hash.as_ref().iter().map(|b| format!("{b:02X}")).collect::<Vec<_>>().join(":")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::random;

    #[test]
    fn mints_a_new_certificate_every_time() {
        let dir = std::env::temp_dir().join(format!("tendril-cert-{}", random::token_hex(4)));
        let names = subject_names(Some("myhost"), &["192.168.1.7".parse().unwrap()]);
        assert!(names.contains(&"myhost.local".to_string()));
        let first = mint(&dir, names.clone()).unwrap();
        let second = mint(&dir, names).unwrap();
        assert_ne!(first.fingerprint, second.fingerprint);
        assert_eq!(first.fingerprint.len(), 32 * 3 - 1);
        let on_disk = fs::read_to_string(dir.join("cert.pem")).unwrap();
        assert_eq!(on_disk, second.cert_pem);
        assert!(fs::read_to_string(dir.join("key.pem")).unwrap().contains("PRIVATE KEY"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(dir.join("key.pem")).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn odd_host_names_are_left_out() {
        let names = subject_names(Some("bad host!"), &[]);
        assert_eq!(names, vec!["localhost", "127.0.0.1", "::1"]);
    }
}
