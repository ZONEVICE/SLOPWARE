//! Percent-encoding with the browser's rules, so that both implementations
//! write and read `?path=` exactly alike.

/// JavaScript's `encodeURIComponent`.
pub fn encode_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        let keep = byte.is_ascii_alphanumeric()
            || matches!(byte, b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')');
        if keep {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// Decode `%XX` sequences. `strict` (like `decodeURIComponent`) rejects a
/// malformed escape or invalid UTF-8; otherwise (like `URLSearchParams`)
/// malformed escapes are kept as they are and invalid UTF-8 is replaced.
fn decode(text: &str, plus_is_space: bool, strict: bool) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if byte == b'%' {
            if let (Some(high), Some(low)) =
                (bytes.get(index + 1).and_then(|b| hex_value(*b)), bytes.get(index + 2).and_then(|b| hex_value(*b)))
            {
                out.push(high * 16 + low);
                index += 3;
                continue;
            }
            if strict {
                return None;
            }
            out.push(byte);
        } else if byte == b'+' && plus_is_space {
            out.push(b' ');
        } else {
            out.push(byte);
        }
        index += 1;
    }
    if strict {
        String::from_utf8(out).ok()
    } else {
        Some(String::from_utf8_lossy(&out).into_owned())
    }
}

/// JavaScript's `decodeURIComponent` (None where it would throw).
pub fn decode_component(text: &str) -> Option<String> {
    decode(text, false, true)
}

/// The first value of `name` in a query string, decoded like `URLSearchParams`.
pub fn query_param(query: &str, name: &str) -> Option<String> {
    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        if decode(key, true, false).as_deref() == Some(name) {
            return decode(value, true, false);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips() {
        let path = "fotos 2024/año+1/ñ&x=y#?.txt";
        let encoded = encode_component(path);
        assert_eq!(encoded, "fotos%202024%2Fa%C3%B1o%2B1%2F%C3%B1%26x%3Dy%23%3F.txt");
        assert_eq!(query_param(&format!("path={encoded}"), "path").as_deref(), Some(path));
        assert_eq!(query_param("a=1&path=x+y", "path").as_deref(), Some("x y"));
        assert_eq!(decode_component("%E0%A4%A"), None);
        assert_eq!(decode_component("a%2Fb").as_deref(), Some("a/b"));
    }
}
