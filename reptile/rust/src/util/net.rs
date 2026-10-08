//! Network helpers: local interfaces, subnets and address parsing.
//!
//! Everything here is pure or reads the interface table; nothing opens a
//! socket. Discovery builds its scan targets from these functions, and the
//! status bar shows `primary_address`.
//!
//! The interface table follows what Node.js's `os.networkInterfaces()`
//! reports (libuv's rules: only interfaces that are up and running, one entry
//! per address, the MAC of the interface on each entry), because the machine
//! fingerprint built from it must come out identical in both implementations.

use crate::util::ids::hex;
use ring::digest::{digest, SHA256};
use std::collections::BTreeSet;
use std::net::{IpAddr, Ipv4Addr};

/// One address of one network interface.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InterfaceAddress {
    pub name: String,
    pub address: IpAddr,
    /// Prefix length of the subnet.
    pub prefix: u8,
    /// Loopback.
    pub internal: bool,
    /// `aa:bb:cc:dd:ee:ff`, or all zeros when the interface has none.
    pub mac: String,
}

/// An IPv4 entry, with the classification discovery needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ipv4Interface {
    pub name: String,
    pub address: Ipv4Addr,
    pub prefix: u8,
    pub internal: bool,
    /// Loopback, or a container/VM/VPN interface that never leads to the LAN.
    pub is_virtual: bool,
    pub mac: String,
}

/// Interface names that belong to containers, VMs and VPN tunnels rather than
/// to the physical local network. Docker alone creates several /16 bridges;
/// scanning those is slow and can never find another computer on the LAN.
const VIRTUAL_PREFIXES: &[&str] = &[
    "lo",
    "docker",
    "br-",
    "veth",
    "virbr",
    "vmnet",
    "vboxnet",
    "lxc",
    "lxd",
    "cni",
    "flannel",
    "cali",
    "weave",
    "tun",
    "tap",
    "utun",
    "zt",
    "tailscale",
    "wg",
    "kube",
    "podman",
    "dummy",
    "ham",
    "nordlynx",
];

pub fn is_virtual_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    VIRTUAL_PREFIXES.iter().any(|prefix| lower.starts_with(prefix))
}

/// Format a hardware address the way libuv does: six bytes, zero-filled.
pub fn format_mac(bytes: &[u8]) -> String {
    let mut six = [0u8; 6];
    for (slot, byte) in six.iter_mut().zip(bytes) {
        *slot = *byte;
    }
    six.iter().map(|b| format!("{b:02x}")).collect::<Vec<_>>().join(":")
}

#[cfg_attr(windows, allow(dead_code))]
fn prefix_of_mask(mask: &[u8]) -> u8 {
    let mut bits = 0u8;
    for byte in mask {
        if *byte == 0xff {
            bits += 8;
        } else {
            bits += byte.leading_ones() as u8;
            break;
        }
    }
    bits
}

// --- The interface table, per platform ----------------------------------------

#[cfg(unix)]
pub fn list_interfaces() -> Vec<InterfaceAddress> {
    use std::collections::HashMap;
    use std::ffi::CStr;
    use std::net::Ipv6Addr;

    let mut out = Vec::new();
    let mut macs: HashMap<String, String> = HashMap::new();
    let mut head: *mut libc::ifaddrs = std::ptr::null_mut();
    // SAFETY: getifaddrs allocates a list we walk read-only and free below.
    unsafe {
        if libc::getifaddrs(&mut head) != 0 {
            return out;
        }
        let up = (libc::IFF_UP | libc::IFF_RUNNING) as libc::c_uint;
        let mut cursor = head;
        // First pass: hardware addresses by interface name.
        while !cursor.is_null() {
            let entry = &*cursor;
            cursor = entry.ifa_next;
            if entry.ifa_addr.is_null() || entry.ifa_name.is_null() {
                continue;
            }
            let name = CStr::from_ptr(entry.ifa_name).to_string_lossy().into_owned();
            #[cfg(any(target_os = "linux", target_os = "android"))]
            if (*entry.ifa_addr).sa_family as libc::c_int == libc::AF_PACKET {
                let link = &*(entry.ifa_addr as *const libc::sockaddr_ll);
                let length = (link.sll_halen as usize).min(link.sll_addr.len());
                macs.insert(name, format_mac(&link.sll_addr[..length]));
                continue;
            }
            #[cfg(any(target_os = "macos", target_os = "ios", target_os = "freebsd"))]
            if (*entry.ifa_addr).sa_family as libc::c_int == libc::AF_LINK {
                let link = &*(entry.ifa_addr as *const libc::sockaddr_dl);
                let data = (link.sdl_data.as_ptr() as *const u8).add(link.sdl_nlen as usize);
                let length = (link.sdl_alen as usize).min(6);
                macs.insert(name, format_mac(std::slice::from_raw_parts(data, length)));
                continue;
            }
            let _ = name;
        }
        // Second pass: addresses of interfaces that are up and running.
        cursor = head;
        while !cursor.is_null() {
            let entry = &*cursor;
            cursor = entry.ifa_next;
            if entry.ifa_addr.is_null() || entry.ifa_name.is_null() || entry.ifa_flags & up != up {
                continue;
            }
            let name = CStr::from_ptr(entry.ifa_name).to_string_lossy().into_owned();
            let family = (*entry.ifa_addr).sa_family as libc::c_int;
            let (address, prefix) = if family == libc::AF_INET {
                let sin = &*(entry.ifa_addr as *const libc::sockaddr_in);
                let address = Ipv4Addr::from(sin.sin_addr.s_addr.to_ne_bytes());
                let prefix = if entry.ifa_netmask.is_null() {
                    32
                } else {
                    let mask = &*(entry.ifa_netmask as *const libc::sockaddr_in);
                    prefix_of_mask(&mask.sin_addr.s_addr.to_ne_bytes())
                };
                (IpAddr::V4(address), prefix)
            } else if family == libc::AF_INET6 {
                let sin6 = &*(entry.ifa_addr as *const libc::sockaddr_in6);
                let address = Ipv6Addr::from(sin6.sin6_addr.s6_addr);
                let prefix = if entry.ifa_netmask.is_null() {
                    128
                } else {
                    let mask = &*(entry.ifa_netmask as *const libc::sockaddr_in6);
                    prefix_of_mask(&mask.sin6_addr.s6_addr)
                };
                (IpAddr::V6(address), prefix)
            } else {
                continue;
            };
            out.push(InterfaceAddress {
                mac: macs.get(&name).cloned().unwrap_or_else(|| format_mac(&[])),
                internal: entry.ifa_flags & (libc::IFF_LOOPBACK as libc::c_uint) != 0,
                name,
                address,
                prefix,
            });
        }
        libc::freeifaddrs(head);
    }
    out
}

#[cfg(windows)]
pub fn list_interfaces() -> Vec<InterfaceAddress> {
    use std::net::Ipv6Addr;
    use windows_sys::Win32::Foundation::ERROR_BUFFER_OVERFLOW;
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GetAdaptersAddresses, GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_DNS_SERVER, GAA_FLAG_SKIP_MULTICAST,
        IF_TYPE_SOFTWARE_LOOPBACK, IP_ADAPTER_ADDRESSES_LH,
    };
    use windows_sys::Win32::NetworkManagement::Ndis::IfOperStatusUp;
    use windows_sys::Win32::Networking::WinSock::{AF_INET, AF_INET6, AF_UNSPEC, SOCKADDR_IN, SOCKADDR_IN6};

    let mut out = Vec::new();
    let flags = GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER;
    let mut size: u32 = 15 * 1024;
    // u64 elements keep the buffer aligned for the structures written into it.
    let mut buffer: Vec<u64>;
    loop {
        buffer = vec![0u64; (size as usize).div_ceil(8)];
        // SAFETY: the buffer is at least `size` bytes and suitably aligned.
        let result = unsafe {
            GetAdaptersAddresses(
                AF_UNSPEC as u32,
                flags,
                std::ptr::null(),
                buffer.as_mut_ptr() as *mut IP_ADAPTER_ADDRESSES_LH,
                &mut size,
            )
        };
        if result == ERROR_BUFFER_OVERFLOW {
            continue;
        }
        if result != 0 {
            return out;
        }
        break;
    }
    // SAFETY: walking the linked list GetAdaptersAddresses wrote into `buffer`.
    unsafe {
        let mut adapter = buffer.as_ptr() as *const IP_ADAPTER_ADDRESSES_LH;
        while !adapter.is_null() {
            let a = &*adapter;
            adapter = a.Next;
            if a.OperStatus != IfOperStatusUp {
                continue;
            }
            let name = wide_to_string(a.FriendlyName);
            let length = (a.PhysicalAddressLength as usize).min(a.PhysicalAddress.len());
            let mac = format_mac(&a.PhysicalAddress[..length]);
            let internal = a.IfType == IF_TYPE_SOFTWARE_LOOPBACK;
            let mut unicast = a.FirstUnicastAddress;
            while !unicast.is_null() {
                let u = &*unicast;
                unicast = u.Next;
                let sockaddr = u.Address.lpSockaddr;
                if sockaddr.is_null() {
                    continue;
                }
                let family = (*sockaddr).sa_family;
                let address = if family == AF_INET {
                    let sin = &*(sockaddr as *const SOCKADDR_IN);
                    IpAddr::V4(Ipv4Addr::from(sin.sin_addr.S_un.S_addr.to_ne_bytes()))
                } else if family == AF_INET6 {
                    let sin6 = &*(sockaddr as *const SOCKADDR_IN6);
                    IpAddr::V6(Ipv6Addr::from(sin6.sin6_addr.u.Byte))
                } else {
                    continue;
                };
                out.push(InterfaceAddress {
                    name: name.clone(),
                    address,
                    prefix: u.OnLinkPrefixLength,
                    internal,
                    mac: mac.clone(),
                });
            }
        }
    }
    out
}

#[cfg(windows)]
unsafe fn wide_to_string(pointer: *const u16) -> String {
    if pointer.is_null() {
        return String::new();
    }
    let mut length = 0;
    while *pointer.add(length) != 0 {
        length += 1;
    }
    String::from_utf16_lossy(std::slice::from_raw_parts(pointer, length))
}

#[cfg(not(any(unix, windows)))]
pub fn list_interfaces() -> Vec<InterfaceAddress> {
    Vec::new()
}

// --- IPv4 arithmetic ------------------------------------------------------------

/// Dotted quad to an integer, or None.
pub fn parse_ipv4(text: &str) -> Option<Ipv4Addr> {
    let parts: Vec<&str> = text.trim().split('.').collect();
    if parts.len() != 4 {
        return None;
    }
    let mut octets = [0u8; 4];
    for (slot, part) in octets.iter_mut().zip(&parts) {
        if part.is_empty() || part.len() > 3 || !part.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        *slot = part.parse::<u16>().ok().filter(|v| *v <= 255)? as u8;
    }
    Some(Ipv4Addr::from(octets))
}

pub fn is_ipv4(text: &str) -> bool {
    parse_ipv4(text).is_some()
}

/// Every usable host of the subnet `address` belongs to. Subnets wider than
/// /24 are narrowed to the /24 around the address: a whole /16 is 65 534 hosts
/// times every port, far too slow for a sweep that repeats every few seconds.
pub fn subnet_hosts(address: Ipv4Addr, prefix: u8, min_prefix: u8) -> Vec<Ipv4Addr> {
    let value = u32::from(address);
    let effective = prefix.min(32).max(min_prefix);
    if effective >= 31 {
        return vec![address];
    }
    let mask: u32 = if effective == 0 { 0 } else { u32::MAX << (32 - effective) };
    let network = value & mask;
    let broadcast = network | !mask;
    ((network + 1)..broadcast).map(Ipv4Addr::from).collect()
}

/// Private (RFC 1918) or link-local IPv4 address.
pub fn is_private_ipv4(address: Ipv4Addr) -> bool {
    let [a, b, _, _] = address.octets();
    a == 10 || (a == 172 && (16..=31).contains(&b)) || (a == 192 && b == 168) || (a == 169 && b == 254)
}

/// Strip the IPv4-mapped IPv6 prefix of dual-stack sockets.
pub fn normalize_address(address: &str) -> String {
    if let Some(rest) = address.strip_prefix("::ffff:") {
        if is_ipv4(rest) {
            return rest.to_string();
        }
    }
    address.to_string()
}

/// Display form of a socket's peer address, IPv4-mapped addresses unwrapped.
pub fn display_ip(address: IpAddr) -> String {
    match address {
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => v4.to_string(),
            None => v6.to_string(),
        },
        IpAddr::V4(v4) => v4.to_string(),
    }
}

/// 127.0.0.0/8 and ::1, in any spelling.
pub fn is_loopback_address(address: &str) -> bool {
    let value = normalize_address(address);
    if value == "::1" {
        return true;
    }
    parse_ipv4(&value).map(|ip| ip.octets()[0] == 127).unwrap_or(false)
}

/// IPv4 entries with their classification.
pub fn ipv4_interfaces(table: &[InterfaceAddress]) -> Vec<Ipv4Interface> {
    table
        .iter()
        .filter_map(|entry| match entry.address {
            IpAddr::V4(address) => Some(Ipv4Interface {
                name: entry.name.clone(),
                address,
                prefix: entry.prefix,
                internal: entry.internal,
                is_virtual: entry.internal || is_virtual_name(&entry.name),
                mac: entry.mac.clone(),
            }),
            IpAddr::V6(_) => None,
        })
        .collect()
}

/// Interfaces facing the local network, private addresses first.
pub fn lan_interfaces(table: &[InterfaceAddress]) -> Vec<Ipv4Interface> {
    let mut all: Vec<Ipv4Interface> = ipv4_interfaces(table).into_iter().filter(|entry| !entry.is_virtual).collect();
    all.sort_by_key(|entry| !is_private_ipv4(entry.address));
    all
}

/// LAN IPv4 addresses of this machine, best first.
pub fn lan_addresses(table: &[InterfaceAddress]) -> Vec<String> {
    lan_interfaces(table).into_iter().map(|entry| entry.address.to_string()).collect()
}

/// The address the status bar shows: the best LAN address, or loopback.
pub fn primary_address(table: &[InterfaceAddress]) -> String {
    lan_addresses(table).into_iter().next().unwrap_or_else(|| "127.0.0.1".to_string())
}

/// Every address of this machine, loopback included: how requests from the
/// local user are recognised.
pub fn local_addresses(table: &[InterfaceAddress]) -> BTreeSet<String> {
    let mut out: BTreeSet<String> = ["127.0.0.1".to_string(), "::1".to_string()].into();
    for entry in table {
        out.insert(normalize_address(&entry.address.to_string()));
    }
    out
}

/// Hosts to scan: the /24 of every LAN interface, plus loopback (cheap, and
/// finds instances on this same machine even without a network).
pub fn default_scan_hosts(table: &[InterfaceAddress]) -> Vec<String> {
    let mut seen = BTreeSet::new();
    let mut hosts = Vec::new();
    let mut push = |host: String| {
        if seen.insert(host.clone()) {
            hosts.push(host);
        }
    };
    push("127.0.0.1".to_string());
    for entry in lan_interfaces(table) {
        for host in subnet_hosts(entry.address, entry.prefix, 24) {
            push(host.to_string());
        }
    }
    hosts
}

/// Expand "192.168.1.20,10.0.0.0/24" into hosts (blocks wider than /24 are
/// narrowed to a /24).
pub fn parse_host_spec(spec: &str) -> Vec<String> {
    let mut seen = BTreeSet::new();
    let mut hosts = Vec::new();
    for item in spec.split(',').map(str::trim).filter(|item| !item.is_empty()) {
        let (address, bits) = match item.split_once('/') {
            Some((address, bits)) => (address, Some(bits)),
            None => (item, None),
        };
        let Some(ip) = parse_ipv4(address) else { continue };
        match bits {
            None => {
                if seen.insert(ip) {
                    hosts.push(ip.to_string());
                }
            }
            Some(bits) => {
                let digits: String = bits.trim().chars().take_while(|c| c.is_ascii_digit()).collect();
                let Ok(prefix) = digits.parse::<u32>() else { continue };
                for host in subnet_hosts(ip, prefix.min(32) as u8, 24) {
                    if seen.insert(host) {
                        hosts.push(host.to_string());
                    }
                }
            }
        }
    }
    hosts
}

/// Expand "55667-55686,8080" into ports.
pub fn parse_port_spec(spec: &str) -> Vec<u16> {
    let mut seen = BTreeSet::new();
    let mut ports = Vec::new();
    for item in spec.split(',').map(str::trim).filter(|item| !item.is_empty()) {
        let (start, end) = match item.split_once('-') {
            Some((a, b)) => (a, b),
            None => (item, item),
        };
        let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
        if !digits(start) || !digits(end) {
            continue;
        }
        let (Ok(start), Ok(end)) = (start.parse::<u64>(), end.parse::<u64>()) else { continue };
        for port in start.min(end)..=start.max(end) {
            if (1..=65535).contains(&port) && seen.insert(port) {
                ports.push(port as u16);
            }
            if port > 65535 {
                break;
            }
        }
    }
    ports
}

/// `[1, 2, 3, 7]` -> "1-3, 7".
pub fn format_port_ranges(ports: &[u16]) -> String {
    let sorted: BTreeSet<u16> = ports.iter().copied().collect();
    let mut ranges: Vec<(u16, u16)> = Vec::new();
    for port in sorted {
        match ranges.last_mut() {
            Some(last) if port == last.1 + 1 => last.1 = port,
            _ => ranges.push((port, port)),
        }
    }
    ranges.iter().map(|(a, b)| if a == b { a.to_string() } else { format!("{a}-{b}") }).collect::<Vec<_>>().join(", ")
}

/// A stable fingerprint of this machine: host name plus MAC addresses.
///
/// Two instances on the same computer compute the same value (whichever
/// implementation they are), which is how a host recognises an attempt to
/// sync a directory into itself. It is not a secret.
pub fn machine_fingerprint(table: &[InterfaceAddress], hostname: &str) -> String {
    let macs: BTreeSet<&str> = table
        .iter()
        .map(|entry| entry.mac.as_str())
        .filter(|mac| *mac != "00:00:00:00:00:00" && !mac.is_empty())
        .collect();
    let joined = macs.into_iter().collect::<Vec<_>>().join(",");
    let hash = digest(&SHA256, format!("{hostname}|{joined}").as_bytes());
    hex(hash.as_ref())[..32].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(name: &str, address: &str, prefix: u8, internal: bool, mac: &str) -> InterfaceAddress {
        InterfaceAddress { name: name.into(), address: address.parse().unwrap(), prefix, internal, mac: mac.into() }
    }

    #[test]
    fn subnets_and_specs() {
        let hosts = subnet_hosts("192.168.1.77".parse().unwrap(), 24, 24);
        assert_eq!(hosts.len(), 254);
        assert_eq!(hosts[0].to_string(), "192.168.1.1");
        assert_eq!(subnet_hosts("10.1.2.3".parse().unwrap(), 8, 24).len(), 254);
        assert_eq!(parse_host_spec("10.0.0.7, 192.168.5.0/24").len(), 255);
        assert_eq!(parse_port_spec("55667-55669,8080,0,70000"), vec![55667, 55668, 55669, 8080]);
        assert_eq!(format_port_ranges(&[3, 1, 2, 7]), "1-3, 7");
        assert!(is_private_ipv4("172.20.0.1".parse().unwrap()));
        assert!(!is_private_ipv4("8.8.8.8".parse().unwrap()));
        assert_eq!(normalize_address("::ffff:10.0.0.1"), "10.0.0.1");
        assert!(is_loopback_address("127.0.0.5"));
        assert!(is_loopback_address("::1"));
        assert!(parse_ipv4("1.2.3").is_none());
        assert!(parse_ipv4("256.1.1.1").is_none());
    }

    #[test]
    fn lan_interfaces_skip_virtual_ones() {
        let table = vec![
            entry("lo", "127.0.0.1", 8, true, "00:00:00:00:00:00"),
            entry("docker0", "172.17.0.1", 16, false, "02:42:00:00:00:01"),
            entry("wlan0", "8.8.4.4", 24, false, "aa:bb:cc:dd:ee:01"),
            entry("eth0", "192.168.1.10", 24, false, "aa:bb:cc:dd:ee:ff"),
        ];
        assert_eq!(lan_addresses(&table), vec!["192.168.1.10", "8.8.4.4"]);
        assert_eq!(primary_address(&table), "192.168.1.10");
        let scan = default_scan_hosts(&table);
        assert_eq!(scan[0], "127.0.0.1");
        assert_eq!(scan.len(), 1 + 254 + 254);
    }

    #[test]
    fn fingerprint_matches_the_node_implementation() {
        // Node: sha256(`${hostname}|${[...macs].sort().join(',')}`).slice(0, 32)
        let table = vec![
            entry("lo", "127.0.0.1", 8, true, "00:00:00:00:00:00"),
            entry("eth0", "192.168.1.10", 24, false, "aa:bb:cc:dd:ee:ff"),
            entry("eth0", "fe80::1", 64, false, "aa:bb:cc:dd:ee:ff"),
            entry("wlan0", "192.168.1.11", 24, false, "11:22:33:44:55:66"),
        ];
        let expected = hex(digest(&SHA256, b"box|11:22:33:44:55:66,aa:bb:cc:dd:ee:ff").as_ref())[..32].to_string();
        assert_eq!(machine_fingerprint(&table, "box"), expected);
    }
}
