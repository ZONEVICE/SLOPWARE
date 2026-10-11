//! Read-only registry access.
//!
//! The firewall check reads the local rule store straight from
//! `HKLM\…\FirewallPolicy\FirewallRules`: one `REG_SZ` value per rule, readable
//! by standard users, and far faster than asking PowerShell (milliseconds
//! instead of seconds on a machine with a couple of thousand rules). Nothing
//! here ever writes to the registry.

use super::ffi::*;
use super::{from_wide, wide};

/// Every string value (`REG_SZ` / `REG_EXPAND_SZ`, unexpanded) directly under
/// `HKEY_LOCAL_MACHINE\<subkey>`, as `(value name, data)` pairs. Values of other
/// types are skipped. Errors carry the Win32 status code.
pub fn hklm_string_values(subkey: &str) -> Result<Vec<(String, String)>, u32> {
    let path = wide(subkey);
    let mut key: HKEY = std::ptr::null_mut();
    let status = unsafe { RegOpenKeyExW(HKEY_LOCAL_MACHINE, path.as_ptr(), 0, KEY_READ, &mut key) };
    if status != 0 {
        return Err(status as u32);
    }
    let result = enum_string_values(key);
    unsafe { RegCloseKey(key) };
    result
}

fn enum_string_values(key: HKEY) -> Result<Vec<(String, String)>, u32> {
    // Size the buffers from the key's own maxima (name in chars, data in bytes);
    // they only grow if the store changes while we enumerate.
    let mut max_name: DWORD = 0;
    let mut max_data: DWORD = 0;
    let status = unsafe {
        RegQueryInfoKeyW(
            key,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut max_name,
            &mut max_data,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if status != 0 {
        return Err(status as u32);
    }
    let mut name_buf = vec![0u16; max_name as usize + 1];
    let mut data_buf = vec![0u8; max_data as usize + 2];

    let mut values = Vec::new();
    let mut index: DWORD = 0;
    loop {
        let mut name_len = name_buf.len() as DWORD;
        let mut data_len = data_buf.len() as DWORD;
        let mut kind: DWORD = 0;
        let status = unsafe {
            RegEnumValueW(
                key,
                index,
                name_buf.as_mut_ptr(),
                &mut name_len,
                std::ptr::null_mut(),
                &mut kind,
                data_buf.as_mut_ptr(),
                &mut data_len,
            )
        } as DWORD;
        match status {
            ERROR_SUCCESS => {}
            ERROR_NO_MORE_ITEMS => break,
            ERROR_MORE_DATA => {
                // A value grew mid-enumeration: enlarge and retry this index.
                name_buf.resize(name_buf.len() * 2, 0);
                data_buf.resize((data_buf.len() * 2).max(data_len as usize + 2), 0);
                continue;
            }
            other => return Err(other),
        }
        if kind == REG_SZ || kind == REG_EXPAND_SZ {
            let name = String::from_utf16_lossy(&name_buf[..name_len as usize]);
            let units: Vec<u16> = data_buf[..data_len as usize]
                .chunks_exact(2)
                .map(|b| u16::from_le_bytes([b[0], b[1]]))
                .collect();
            values.push((name, from_wide(&units)));
        }
        index += 1;
    }
    Ok(values)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_well_known_key() {
        // Present on every Windows install and readable by standard users.
        let values =
            hklm_string_values(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion").unwrap();
        assert!(values.iter().any(|(name, data)| name == "ProductName" && !data.is_empty()));
    }

    #[test]
    fn missing_key_is_an_error() {
        assert!(hklm_string_values(r"SOFTWARE\AllySwally\Definitely\Not\Here").is_err());
    }
}
