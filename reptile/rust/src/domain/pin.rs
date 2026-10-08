//! The PIN: four digits, the only protection Reptile has.
//!
//! It is deliberately symbolic. There is no attempt limit and no lockout; the
//! specification says so explicitly. What the PIN does guarantee is that a
//! peer cannot connect by accident, and that changing it cuts off whoever is
//! connected until they type the new one.

use crate::domain::errors::{AppError, AppResult};
use crate::util::ids::{random_below, safe_eq};
use serde_json::Value;

fn is_pin(text: &str) -> bool {
    text.len() == 4 && text.bytes().all(|b| b.is_ascii_digit())
}

/// A random PIN, zero-padded: "0042" is as valid as "4242".
pub fn generate_pin() -> String {
    format!("{:04}", random_below(10_000))
}

/// Validate a PIN typed by the user (a string, or a number as JavaScript
/// would stringify it).
pub fn assert_pin(value: Option<&Value>) -> AppResult<String> {
    let pin = match value {
        Some(Value::String(text)) => text.trim().to_string(),
        Some(Value::Number(number)) => number.to_string(),
        _ => String::new(),
    };
    if !is_pin(&pin) {
        return Err(AppError::bad_request("The PIN must be exactly 4 digits.", "pin_format"));
    }
    Ok(pin)
}

/// True when no PIN was given (`undefined`, `null` or `""`): generate one.
pub fn pin_missing(value: Option<&Value>) -> bool {
    matches!(value, None | Some(Value::Null)) || value.and_then(Value::as_str) == Some("")
}

/// Compare a candidate with the current PIN in constant time.
pub fn pin_matches(candidate: &str, actual: &str) -> bool {
    is_pin(candidate) && safe_eq(candidate, actual)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rules() {
        assert_eq!(assert_pin(Some(&json!(" 0042 "))).unwrap(), "0042");
        assert_eq!(assert_pin(Some(&json!(1234))).unwrap(), "1234");
        assert_eq!(assert_pin(Some(&json!("12a4"))).unwrap_err().code, "pin_format");
        assert!(assert_pin(None).is_err());
        assert!(pin_matches("1234", "1234"));
        assert!(!pin_matches("1235", "1234"));
        assert!(!pin_matches("123", "123"));
        assert_eq!(generate_pin().len(), 4);
        assert!(pin_missing(Some(&json!(""))));
        assert!(pin_missing(None));
        assert!(!pin_missing(Some(&json!("1"))));
    }
}
