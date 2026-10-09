//! Enumerate the host's active IPv4 addresses with `GetAdaptersAddresses`.
//!
//! The app must be reachable over whatever carries IP between phone and host:
//! home Wi-Fi, the phone's Wi-Fi hotspot, Bluetooth PAN, or USB tethering
//! (RNDIS). We list every up IPv4 address, label it by interface type so the
//! console can show "Wi-Fi" / "Bluetooth PAN" / "USB", and drop loopback and
//! APIPA (169.254.x.x) which are never useful to connect to.

use super::ffi::*;
use super::from_wide;
use std::net::Ipv4Addr;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Interface {
    pub ip: Ipv4Addr,
    pub friendly_name: String,
    pub kind: IfKind,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IfKind {
    WiFi,
    Ethernet,
    BluetoothPan,
    UsbRndis,
    Other,
}

impl IfKind {
    pub fn label(self) -> &'static str {
        match self {
            IfKind::WiFi => "Wi-Fi",
            IfKind::Ethernet => "Ethernet",
            IfKind::BluetoothPan => "Bluetooth PAN",
            IfKind::UsbRndis => "USB/RNDIS",
            IfKind::Other => "Other",
        }
    }
}

/// Classify an adapter from its IF_TYPE and friendly name. Bluetooth PAN and
/// USB tethering both report as Ethernet at the IF_TYPE level, so the friendly
/// name disambiguates them — the same heuristic Windows' own UI relies on.
fn classify(if_type: DWORD, friendly: &str) -> IfKind {
    let f = friendly.to_lowercase();
    if f.contains("bluetooth") {
        return IfKind::BluetoothPan;
    }
    if f.contains("rndis") || f.contains("usb") || f.contains("tether") {
        return IfKind::UsbRndis;
    }
    match if_type {
        IF_TYPE_IEEE80211 => IfKind::WiFi,
        IF_TYPE_ETHERNET_CSMACD => IfKind::Ethernet,
        _ => IfKind::Other,
    }
}

/// Return every active, routable IPv4 interface, best effort. On any API
/// failure this yields an empty list rather than erroring: the server still
/// starts and the console simply shows no addresses.
pub fn interfaces() -> Vec<Interface> {
    let mut out = Vec::new();
    let flags = GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER;

    // Size probe, then allocate and fetch. Retry once if the size grew.
    let mut size: ULONG = 16 * 1024;
    for _ in 0..3 {
        let mut buf = vec![0u8; size as usize];
        let ret = unsafe {
            GetAdaptersAddresses(
                AF_INET as ULONG,
                flags,
                std::ptr::null_mut(),
                buf.as_mut_ptr() as *mut IP_ADAPTER_ADDRESSES,
                &mut size,
            )
        };
        if ret == ERROR_BUFFER_OVERFLOW {
            // `size` now holds the required length; loop reallocates.
            continue;
        }
        if ret != ERROR_SUCCESS {
            return out;
        }
        unsafe {
            walk_adapters(buf.as_ptr() as *const IP_ADAPTER_ADDRESSES, &mut out);
        }
        break;
    }
    out
}

unsafe fn walk_adapters(mut adapter: *const IP_ADAPTER_ADDRESSES, out: &mut Vec<Interface>) {
    while !adapter.is_null() {
        let a = &*adapter;
        if a.OperStatus == IfOperStatusUp && a.IfType != IF_TYPE_SOFTWARE_LOOPBACK {
            let friendly = if a.FriendlyName.is_null() {
                String::new()
            } else {
                read_wide_ptr(a.FriendlyName)
            };
            let kind = classify(a.IfType, &friendly);
            let mut uni = a.FirstUnicastAddress;
            while !uni.is_null() {
                let u = &*uni;
                if !u.Address.lpSockaddr.is_null() {
                    let sa = &*u.Address.lpSockaddr;
                    if sa.sa_family == AF_INET {
                        // sockaddr_in: family(2) port(2) addr(4). In our
                        // SOCKADDR, sa_data[0..2] is the port and sa_data[2..6]
                        // is the IPv4 address in network byte order.
                        let o = [
                            sa.sa_data[2],
                            sa.sa_data[3],
                            sa.sa_data[4],
                            sa.sa_data[5],
                        ];
                        let ip = Ipv4Addr::new(o[0], o[1], o[2], o[3]);
                        if !ip.is_loopback() && !ip.is_link_local() && !ip.is_unspecified() {
                            out.push(Interface {
                                ip,
                                friendly_name: friendly.clone(),
                                kind,
                            });
                        }
                    }
                }
                uni = u.Next;
            }
        }
        adapter = a.Next;
    }
}

unsafe fn read_wide_ptr(ptr: *const WCHAR) -> String {
    let mut len = 0usize;
    while *ptr.add(len) != 0 {
        len += 1;
    }
    from_wide(std::slice::from_raw_parts(ptr, len))
}
