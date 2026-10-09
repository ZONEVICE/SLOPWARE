//! Recursive-descent JSON parser with line/column error reporting.

use super::Value;

/// A parse failure with a human-readable message and a 1-based position. The
/// Diagnostics panel shows these for hand-edited `user-data` files.
#[derive(Clone, Debug, PartialEq)]
pub struct ParseError {
    pub message: String,
    pub line: usize,
    pub column: usize,
}

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} at line {} column {}", self.message, self.line, self.column)
    }
}

struct Parser<'a> {
    bytes: &'a [u8],
    pos: usize,
    line: usize,
    col: usize,
}

/// Parse a complete JSON document. Trailing content after the top-level value
/// (other than whitespace) is an error.
pub fn parse(input: &str) -> Result<Value, ParseError> {
    let mut p = Parser {
        bytes: input.as_bytes(),
        pos: 0,
        line: 1,
        col: 1,
    };
    p.skip_ws();
    let value = p.parse_value()?;
    p.skip_ws();
    if p.pos != p.bytes.len() {
        return Err(p.err("trailing characters after JSON value"));
    }
    Ok(value)
}

impl<'a> Parser<'a> {
    fn err(&self, msg: &str) -> ParseError {
        ParseError {
            message: msg.to_string(),
            line: self.line,
            column: self.col,
        }
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    fn bump(&mut self) -> Option<u8> {
        let b = self.peek()?;
        self.pos += 1;
        if b == b'\n' {
            self.line += 1;
            self.col = 1;
        } else {
            self.col += 1;
        }
        Some(b)
    }

    fn skip_ws(&mut self) {
        while let Some(b) = self.peek() {
            if b == b' ' || b == b'\t' || b == b'\n' || b == b'\r' {
                self.bump();
            } else {
                break;
            }
        }
    }

    fn parse_value(&mut self) -> Result<Value, ParseError> {
        match self.peek() {
            Some(b'{') => self.parse_object(),
            Some(b'[') => self.parse_array(),
            Some(b'"') => Ok(Value::Str(self.parse_string()?)),
            Some(b't') | Some(b'f') => self.parse_bool(),
            Some(b'n') => self.parse_null(),
            Some(c) if c == b'-' || c.is_ascii_digit() => self.parse_number(),
            Some(_) => Err(self.err("unexpected character")),
            None => Err(self.err("unexpected end of input")),
        }
    }

    fn expect(&mut self, lit: &str, value: Value) -> Result<Value, ParseError> {
        for &want in lit.as_bytes() {
            match self.bump() {
                Some(b) if b == want => {}
                _ => return Err(self.err(&format!("expected `{lit}`"))),
            }
        }
        Ok(value)
    }

    fn parse_bool(&mut self) -> Result<Value, ParseError> {
        if self.peek() == Some(b't') {
            self.expect("true", Value::Bool(true))
        } else {
            self.expect("false", Value::Bool(false))
        }
    }

    fn parse_null(&mut self) -> Result<Value, ParseError> {
        self.expect("null", Value::Null)
    }

    fn parse_number(&mut self) -> Result<Value, ParseError> {
        let start = self.pos;
        if self.peek() == Some(b'-') {
            self.bump();
        }
        while matches!(self.peek(), Some(c) if c.is_ascii_digit()) {
            self.bump();
        }
        if self.peek() == Some(b'.') {
            self.bump();
            while matches!(self.peek(), Some(c) if c.is_ascii_digit()) {
                self.bump();
            }
        }
        if matches!(self.peek(), Some(b'e') | Some(b'E')) {
            self.bump();
            if matches!(self.peek(), Some(b'+') | Some(b'-')) {
                self.bump();
            }
            while matches!(self.peek(), Some(c) if c.is_ascii_digit()) {
                self.bump();
            }
        }
        let text = std::str::from_utf8(&self.bytes[start..self.pos]).unwrap_or("");
        text.parse::<f64>()
            .map(Value::Num)
            .map_err(|_| self.err("invalid number"))
    }

    fn parse_string(&mut self) -> Result<String, ParseError> {
        self.bump(); // opening quote
        let mut out = String::new();
        loop {
            match self.bump() {
                None => return Err(self.err("unterminated string")),
                Some(b'"') => return Ok(out),
                Some(b'\\') => {
                    let esc = self.bump().ok_or_else(|| self.err("unterminated escape"))?;
                    match esc {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{0008}'),
                        b'f' => out.push('\u{000C}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let cp = self.parse_hex4()?;
                            // Handle surrogate pairs for characters above the BMP.
                            if (0xD800..=0xDBFF).contains(&cp) {
                                if self.bump() != Some(b'\\') || self.bump() != Some(b'u') {
                                    return Err(self.err("expected low surrogate"));
                                }
                                let low = self.parse_hex4()?;
                                if !(0xDC00..=0xDFFF).contains(&low) {
                                    return Err(self.err("invalid low surrogate"));
                                }
                                let c = 0x10000 + ((cp - 0xD800) << 10) + (low - 0xDC00);
                                out.push(
                                    char::from_u32(c)
                                        .ok_or_else(|| self.err("invalid code point"))?,
                                );
                            } else {
                                out.push(
                                    char::from_u32(cp)
                                        .ok_or_else(|| self.err("invalid code point"))?,
                                );
                            }
                        }
                        _ => return Err(self.err("invalid escape")),
                    }
                }
                Some(b) if b < 0x20 => return Err(self.err("control character in string")),
                Some(b) if b < 0x80 => out.push(b as char),
                Some(b) => {
                    // Multi-byte UTF-8: collect the continuation bytes.
                    let len = utf8_len(b);
                    let mut buf = vec![b];
                    for _ in 1..len {
                        buf.push(self.bump().ok_or_else(|| self.err("truncated UTF-8"))?);
                    }
                    match std::str::from_utf8(&buf) {
                        Ok(s) => out.push_str(s),
                        Err(_) => return Err(self.err("invalid UTF-8")),
                    }
                }
            }
        }
    }

    fn parse_hex4(&mut self) -> Result<u32, ParseError> {
        let mut n = 0u32;
        for _ in 0..4 {
            let b = self.bump().ok_or_else(|| self.err("truncated \\u escape"))?;
            let d = match b {
                b'0'..=b'9' => (b - b'0') as u32,
                b'a'..=b'f' => (b - b'a' + 10) as u32,
                b'A'..=b'F' => (b - b'A' + 10) as u32,
                _ => return Err(self.err("invalid hex digit")),
            };
            n = n * 16 + d;
        }
        Ok(n)
    }

    fn parse_array(&mut self) -> Result<Value, ParseError> {
        self.bump(); // [
        let mut items = Vec::new();
        self.skip_ws();
        if self.peek() == Some(b']') {
            self.bump();
            return Ok(Value::Array(items));
        }
        loop {
            self.skip_ws();
            items.push(self.parse_value()?);
            self.skip_ws();
            match self.bump() {
                Some(b',') => continue,
                Some(b']') => return Ok(Value::Array(items)),
                _ => return Err(self.err("expected `,` or `]`")),
            }
        }
    }

    fn parse_object(&mut self) -> Result<Value, ParseError> {
        self.bump(); // {
        let mut pairs: Vec<(String, Value)> = Vec::new();
        self.skip_ws();
        if self.peek() == Some(b'}') {
            self.bump();
            return Ok(Value::Object(pairs));
        }
        loop {
            self.skip_ws();
            if self.peek() != Some(b'"') {
                return Err(self.err("expected string key"));
            }
            let key = self.parse_string()?;
            self.skip_ws();
            if self.bump() != Some(b':') {
                return Err(self.err("expected `:`"));
            }
            self.skip_ws();
            let value = self.parse_value()?;
            pairs.push((key, value));
            self.skip_ws();
            match self.bump() {
                Some(b',') => continue,
                Some(b'}') => return Ok(Value::Object(pairs)),
                _ => return Err(self.err("expected `,` or `}`")),
            }
        }
    }
}

fn utf8_len(first: u8) -> usize {
    if first >= 0xF0 {
        4
    } else if first >= 0xE0 {
        3
    } else if first >= 0xC0 {
        2
    } else {
        1
    }
}

#[cfg(test)]
mod tests {
    use super::super::Value;
    use super::*;

    #[test]
    fn parses_scalars() {
        assert_eq!(parse("true").unwrap(), Value::Bool(true));
        assert_eq!(parse("null").unwrap(), Value::Null);
        assert_eq!(parse("42").unwrap(), Value::Num(42.0));
        assert_eq!(parse("-3.5e2").unwrap(), Value::Num(-350.0));
        assert_eq!(parse("\"hi\"").unwrap(), Value::Str("hi".into()));
    }

    #[test]
    fn parses_nested() {
        let v = parse(r#"{"a":[1,2,{"b":true}],"c":"x"}"#).unwrap();
        assert_eq!(v.get("c").unwrap().as_str(), Some("x"));
        let a = v.get("a").unwrap().as_array().unwrap();
        assert_eq!(a.len(), 3);
        assert_eq!(a[2].get("b").unwrap().as_bool(), Some(true));
    }

    #[test]
    fn preserves_key_order() {
        let v = parse(r#"{"z":1,"a":2,"m":3}"#).unwrap();
        let keys: Vec<&str> = v
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, _)| k.as_str())
            .collect();
        assert_eq!(keys, ["z", "a", "m"]);
    }

    #[test]
    fn reports_line_and_column() {
        let err = parse("{\n  \"a\": ,\n}").unwrap_err();
        assert_eq!(err.line, 2);
        assert_eq!(err.column, 8);
    }

    #[test]
    fn handles_escapes_and_unicode() {
        assert_eq!(parse(r#""a\nb""#).unwrap().as_str(), Some("a\nb"));
        assert_eq!(parse(r#""ñ""#).unwrap().as_str(), Some("ñ"));
        // Surrogate pair for U+1F600 😀
        assert_eq!(parse(r#""😀""#).unwrap().as_str(), Some("😀"));
    }

    #[test]
    fn rejects_trailing_comma() {
        assert!(parse(r#"[1,2,]"#).is_err());
        assert!(parse(r#"{"a":1,}"#).is_err());
    }
}
