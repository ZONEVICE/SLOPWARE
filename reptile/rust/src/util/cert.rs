//! Self-signed certificate generation, in process.
//!
//! `--https` must mint a NEW certificate on every run, replacing the previous
//! one in the certificate directory. The Node.js implementation drives the
//! system `openssl` binary; this one cannot count on that (Windows has none),
//! so it builds the X.509 structure itself: a few hundred bytes of DER, signed
//! with an ECDSA P-256 key from `ring`.
//!
//! The certificate matches the Node.js one: EC P-256, `CN=<host>.local`,
//! `O=Reptile`, `CA:FALSE` (critical), key usage digitalSignature (critical),
//! extended key usage serverAuth, a subject key identifier, and SANs for
//! localhost, the host name, `<host>.local`, loopback and every LAN address.
//! Browsers show their usual warning once; peers accept it and pin its
//! fingerprint for the session.

use crate::util::ids::{random_bytes, random_hex, system_random};
use crate::util::time::{now_ms, utc};
use ring::digest::{digest, SHA256};
use ring::signature::{EcdsaKeyPair, KeyPair, ECDSA_P256_SHA256_ASN1_SIGNING};
use std::fs;
use std::io;
use std::net::IpAddr;
use std::path::{Path, PathBuf};

pub struct Certificate {
    /// DER of the certificate.
    pub cert_der: Vec<u8>,
    /// PKCS#8 DER of the private key.
    pub key_der: Vec<u8>,
    pub cert_path: PathBuf,
    pub key_path: PathBuf,
    /// `AB:CD:...`, the SHA-256 of the DER, as Node's `fingerprint256`.
    pub fingerprint256: String,
    pub key_type: &'static str,
}

// --- DER ---------------------------------------------------------------------------

fn tlv(tag: u8, content: &[u8]) -> Vec<u8> {
    let mut out = vec![tag];
    let length = content.len();
    if length < 0x80 {
        out.push(length as u8);
    } else {
        let bytes: Vec<u8> = length.to_be_bytes().iter().copied().skip_while(|b| *b == 0).collect();
        out.push(0x80 | bytes.len() as u8);
        out.extend_from_slice(&bytes);
    }
    out.extend_from_slice(content);
    out
}

fn sequence(parts: &[Vec<u8>]) -> Vec<u8> {
    tlv(0x30, &parts.concat())
}

fn set(parts: &[Vec<u8>]) -> Vec<u8> {
    tlv(0x31, &parts.concat())
}

fn oid(arcs: &[u64]) -> Vec<u8> {
    let mut body = vec![(arcs[0] * 40 + arcs[1]) as u8];
    for &arc in &arcs[2..] {
        let mut chunk = vec![(arc & 0x7f) as u8];
        let mut rest = arc >> 7;
        while rest > 0 {
            chunk.push(0x80 | (rest & 0x7f) as u8);
            rest >>= 7;
        }
        chunk.reverse();
        body.extend(chunk);
    }
    tlv(0x06, &body)
}

fn positive_integer(bytes: &[u8]) -> Vec<u8> {
    let mut trimmed: Vec<u8> = bytes.iter().copied().skip_while(|b| *b == 0).collect();
    if trimmed.is_empty() || trimmed[0] & 0x80 != 0 {
        trimmed.insert(0, 0);
    }
    tlv(0x02, &trimmed)
}

fn bit_string(bytes: &[u8]) -> Vec<u8> {
    let mut body = vec![0u8];
    body.extend_from_slice(bytes);
    tlv(0x03, &body)
}

fn octet_string(bytes: &[u8]) -> Vec<u8> {
    tlv(0x04, bytes)
}

fn utf8_string(text: &str) -> Vec<u8> {
    tlv(0x0c, text.as_bytes())
}

/// UTCTime before 2050, GeneralizedTime from then on (RFC 5280, 4.1.2.5).
fn time(ms: i64) -> Vec<u8> {
    let t = utc(ms);
    if t.year < 2050 {
        let text = format!("{:02}{:02}{:02}{:02}{:02}{:02}Z", t.year % 100, t.month, t.day, t.hour, t.minute, t.second);
        tlv(0x17, text.as_bytes())
    } else {
        let text = format!("{:04}{:02}{:02}{:02}{:02}{:02}Z", t.year, t.month, t.day, t.hour, t.minute, t.second);
        tlv(0x18, text.as_bytes())
    }
}

fn extension(id: &[u64], critical: bool, value: Vec<u8>) -> Vec<u8> {
    let mut parts = vec![oid(id)];
    if critical {
        parts.push(vec![0x01, 0x01, 0xff]);
    }
    parts.push(octet_string(&value));
    sequence(&parts)
}

const ECDSA_WITH_SHA256: &[u64] = &[1, 2, 840, 10045, 4, 3, 2];
const EC_PUBLIC_KEY: &[u64] = &[1, 2, 840, 10045, 2, 1];
const PRIME256V1: &[u64] = &[1, 2, 840, 10045, 3, 1, 7];

/// A DNS name safe to put in a certificate.
fn valid_dns_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 253
        && bytes[0].is_ascii_alphanumeric()
        && bytes[bytes.len() - 1].is_ascii_alphanumeric()
        && bytes.iter().all(|b| b.is_ascii_alphanumeric() || *b == b'.' || *b == b'-')
}

/// Colon-separated uppercase SHA-256, as Node prints certificate fingerprints.
pub fn fingerprint256(der: &[u8]) -> String {
    digest(&SHA256, der).as_ref().iter().map(|b| format!("{b:02X}")).collect::<Vec<_>>().join(":")
}

fn pem(label: &str, der: &[u8]) -> String {
    let encoded = base64(der);
    let mut out = format!("-----BEGIN {label}-----\n");
    for line in encoded.as_bytes().chunks(64) {
        out.push_str(std::str::from_utf8(line).unwrap());
        out.push('\n');
    }
    out.push_str(&format!("-----END {label}-----\n"));
    out
}

fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n =
            (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
    }
    out
}

/// Build and sign the certificate. Pure: no file is touched.
pub fn build(common_name: &str, dns: &[String], ips: &[IpAddr], days: i64) -> io::Result<(Vec<u8>, Vec<u8>)> {
    let fail = |what: &str| io::Error::other(format!("could not generate a certificate: {what}"));
    let rng = system_random();
    let pkcs8 =
        EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, rng).map_err(|_| fail("key generation"))?;
    let key_pair = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, pkcs8.as_ref(), rng)
        .map_err(|_| fail("key parsing"))?;
    let public_key = key_pair.public_key().as_ref().to_vec();

    let cn = if valid_dns_name(common_name) { common_name } else { "reptile.local" };
    let name = sequence(&[
        set(&[sequence(&[oid(&[2, 5, 4, 3]), utf8_string(cn)])]),
        set(&[sequence(&[oid(&[2, 5, 4, 10]), utf8_string("Reptile")])]),
    ]);

    let mut serial = [0u8; 16];
    random_bytes(&mut serial);
    serial[0] &= 0x7f;
    serial[0] |= 0x01;

    let now = now_ms();
    let validity = sequence(&[time(now - 3_600_000), time(now + days * 86_400_000)]);
    let algorithm = sequence(&[oid(ECDSA_WITH_SHA256)]);
    let spki = sequence(&[sequence(&[oid(EC_PUBLIC_KEY), oid(PRIME256V1)]), bit_string(&public_key)]);

    let mut seen_dns = Vec::new();
    let mut alt_names = Vec::new();
    for name in dns {
        if valid_dns_name(name) && !seen_dns.contains(name) {
            seen_dns.push(name.clone());
            alt_names.push(tlv(0x82, name.as_bytes()));
        }
    }
    let mut seen_ip = Vec::new();
    for ip in ips {
        if seen_ip.contains(ip) {
            continue;
        }
        seen_ip.push(*ip);
        match ip {
            IpAddr::V4(v4) => alt_names.push(tlv(0x87, &v4.octets())),
            IpAddr::V6(v6) => alt_names.push(tlv(0x87, &v6.octets())),
        }
    }
    let public_digest = digest(&SHA256, &public_key);
    let key_identifier = &public_digest.as_ref()[..20];
    let extensions = sequence(&[
        extension(&[2, 5, 29, 19], true, sequence(&[])),
        extension(&[2, 5, 29, 15], true, vec![0x03, 0x02, 0x07, 0x80]),
        extension(&[2, 5, 29, 37], false, sequence(&[oid(&[1, 3, 6, 1, 5, 5, 7, 3, 1])])),
        extension(&[2, 5, 29, 14], false, octet_string(key_identifier)),
        extension(&[2, 5, 29, 17], false, sequence(&alt_names)),
    ]);

    let tbs = sequence(&[
        tlv(0xa0, &positive_integer(&[2])),
        positive_integer(&serial),
        algorithm.clone(),
        name.clone(),
        validity,
        name,
        spki,
        tlv(0xa3, &extensions),
    ]);
    let signature = key_pair.sign(rng, &tbs).map_err(|_| fail("signing"))?;
    let cert = sequence(&[tbs, algorithm, bit_string(signature.as_ref())]);
    Ok((cert, pkcs8.as_ref().to_vec()))
}

/// Generate a fresh certificate and install it in `directory` as `cert.pem`
/// and `key.pem`, replacing what was there. Files are written under temporary
/// names and renamed into place, so an interrupted run never leaves a key
/// that does not match its certificate.
pub fn generate(directory: &Path, common_name: &str, dns: &[String], ips: &[IpAddr]) -> io::Result<Certificate> {
    let (cert_der, key_der) = build(common_name, dns, ips, 365)?;
    create_private_dir(directory)?;
    let suffix = random_hex(4);
    let tmp_key = directory.join(format!(".key-{suffix}.pem"));
    let tmp_cert = directory.join(format!(".cert-{suffix}.pem"));
    let key_path = directory.join("key.pem");
    let cert_path = directory.join("cert.pem");
    let result = (|| {
        write_private(&tmp_key, pem("PRIVATE KEY", &key_der).as_bytes())?;
        fs::write(&tmp_cert, pem("CERTIFICATE", &cert_der))?;
        fs::rename(&tmp_key, &key_path)?;
        fs::rename(&tmp_cert, &cert_path)
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&tmp_key);
        let _ = fs::remove_file(&tmp_cert);
        return Err(error);
    }
    Ok(Certificate {
        fingerprint256: fingerprint256(&cert_der),
        cert_der,
        key_der,
        cert_path,
        key_path,
        key_type: "ec",
    })
}

#[cfg(unix)]
fn create_private_dir(directory: &Path) -> io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    fs::DirBuilder::new().recursive(true).mode(0o700).create(directory)
}

#[cfg(not(unix))]
fn create_private_dir(directory: &Path) -> io::Result<()> {
    fs::create_dir_all(directory)
}

#[cfg(unix)]
fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(path)?;
    file.write_all(bytes)
}

#[cfg(not(unix))]
fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    fs::write(path, bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn der_primitives() {
        assert_eq!(oid(&[1, 2, 840, 10045, 2, 1]), vec![0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01]);
        assert_eq!(positive_integer(&[0x80]), vec![0x02, 0x02, 0x00, 0x80]);
        assert_eq!(tlv(0x04, &[0u8; 200])[..3], [0x04, 0x81, 200]);
        assert_eq!(base64(b"Reptile"), "UmVwdGlsZQ==");
    }

    #[test]
    fn builds_a_certificate_rustls_accepts() {
        let (cert, key) =
            build("box.local", &["localhost".into(), "box".into()], &["127.0.0.1".parse().unwrap()], 365).unwrap();
        assert_eq!(cert[0], 0x30);
        let provider = std::sync::Arc::new(rustls::crypto::ring::default_provider());
        let config = rustls::ServerConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(
                vec![rustls::pki_types::CertificateDer::from(cert.clone())],
                rustls::pki_types::PrivateKeyDer::Pkcs8(rustls::pki_types::PrivatePkcs8KeyDer::from(key)),
            );
        assert!(config.is_ok(), "{:?}", config.err());
        assert_eq!(fingerprint256(&cert).len(), 32 * 3 - 1);
    }
}
