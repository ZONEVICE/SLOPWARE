//! JSON serialization, compact and pretty.

use super::Value;

pub fn to_string(value: &Value, pretty: bool) -> String {
    let mut out = String::new();
    write_value(&mut out, value, pretty, 0);
    out
}

fn write_value(out: &mut String, value: &Value, pretty: bool, depth: usize) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Num(n) => out.push_str(&format_number(*n)),
        Value::Str(s) => write_string(out, s),
        Value::Array(items) => write_array(out, items, pretty, depth),
        Value::Object(pairs) => write_object(out, pairs, pretty, depth),
    }
}

/// JSON has one number type. Integers print without a decimal point; other
/// finite values use Rust's shortest round-trip formatting. Non-finite values
/// are not representable in JSON and become `null`.
fn format_number(n: f64) -> String {
    if !n.is_finite() {
        return "null".to_string();
    }
    if n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        let mut s = format!("{n}");
        if !s.contains('.') && !s.contains('e') && !s.contains('E') {
            s.push_str(".0");
        }
        s
    }
}

fn write_string(out: &mut String, s: &str) {
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{0008}' => out.push_str("\\b"),
            '\u{000C}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

fn indent(out: &mut String, depth: usize) {
    for _ in 0..depth {
        out.push_str("  ");
    }
}

fn write_array(out: &mut String, items: &[Value], pretty: bool, depth: usize) {
    if items.is_empty() {
        out.push_str("[]");
        return;
    }
    out.push('[');
    for (i, item) in items.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        if pretty {
            out.push('\n');
            indent(out, depth + 1);
        }
        write_value(out, item, pretty, depth + 1);
    }
    if pretty {
        out.push('\n');
        indent(out, depth);
    }
    out.push(']');
}

fn write_object(out: &mut String, pairs: &[(String, Value)], pretty: bool, depth: usize) {
    if pairs.is_empty() {
        out.push_str("{}");
        return;
    }
    out.push('{');
    for (i, (key, val)) in pairs.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        if pretty {
            out.push('\n');
            indent(out, depth + 1);
        }
        write_string(out, key);
        out.push(':');
        if pretty {
            out.push(' ');
        }
        write_value(out, val, pretty, depth + 1);
    }
    if pretty {
        out.push('\n');
        indent(out, depth);
    }
    out.push('}');
}

#[cfg(test)]
mod tests {
    use super::super::{parse, Obj, Value};

    #[test]
    fn compact_roundtrip() {
        let src = r#"{"a":1,"b":[true,null,"x"],"c":{}}"#;
        let v = parse(src).unwrap();
        assert_eq!(v.to_string(), src);
    }

    #[test]
    fn integers_have_no_decimal() {
        assert_eq!(Value::Num(5.0).to_string(), "5");
        assert_eq!(Value::Num(-12.0).to_string(), "-12");
        assert_eq!(Value::Num(1.5).to_string(), "1.5");
    }

    #[test]
    fn pretty_indents_two_spaces() {
        let v = Obj::new().num("a", 1).set("b", Value::Array(vec![Value::Num(2.0)])).build();
        let expected = "{\n  \"a\": 1,\n  \"b\": [\n    2\n  ]\n}";
        assert_eq!(v.to_pretty(), expected);
    }

    #[test]
    fn escapes_special_characters() {
        let v = Value::Str("line\nquote\"tab\t".into());
        assert_eq!(v.to_string(), r#""line\nquote\"tab\t""#);
    }

    #[test]
    fn pretty_then_parse_is_stable() {
        let src = r#"{"name":"ñ 😀","items":[1,2,3],"nested":{"on":true}}"#;
        let v = parse(src).unwrap();
        let reparsed = parse(&v.to_pretty()).unwrap();
        assert_eq!(v, reparsed);
    }
}
