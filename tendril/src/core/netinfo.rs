//! The host name and the machine's local IP addresses.
//!
//! Used for the startup banner (which URLs to open) and for the subject
//! alternative names of the self-signed certificate. Unix asks the kernel
//! through `getifaddrs`; Windows through `GetAdaptersAddresses`; both add the
//! address of the default route. Container and VM networks are left out,
//! since nobody browses to them: on Unix the bridges (`docker0`, `br-*`,
//! `veth*`, `virbr*`...), on Windows the Hyper-V virtual switches (including
//! WSL's), VirtualBox host-only and VMware adapters. VPN interfaces (`tun*`,
//! `wg*`, `tailscale*`, `zt*`; ZeroTier, WireGuard, Tailscale, OpenVPN on
//! Windows) are kept, since reaching Tendril over a VPN is a supported use.
//! The default route's address is never filtered, so a Hyper-V external
//! switch that carries the real LAN address still shows it.

use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};

/// The machine's host name, if it can be determined.
pub fn hostname() -> Option<String> {
    let name = platform_hostname()?;
    let name = name.trim().to_string();
    if name.is_empty() { None } else { Some(name) }
}

/// Non-loopback, non-link-local addresses of this machine, IPv4 first.
pub fn local_ips() -> Vec<IpAddr> {
    let mut ips = platform_ips();
    if let Some(ip) = default_route_ip() {
        ips.push(ip);
    }
    ips.retain(is_reachable_unicast);
    ips.sort_by_key(|ip| (ip.is_ipv6(), *ip));
    ips.dedup();
    ips
}

/// True for addresses another machine could use to reach this one.
fn is_reachable_unicast(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => !(v4.is_loopback() || v4.is_unspecified() || v4.is_link_local() || v4.is_multicast()),
        IpAddr::V6(v6) => {
            let link_local = (v6.segments()[0] & 0xffc0) == 0xfe80;
            !(v6.is_loopback() || v6.is_unspecified() || link_local || v6.is_multicast())
        }
    }
}

/// The source address the OS would use to reach the Internet. `connect` on a
/// UDP socket only selects a route; no packet is sent.
fn default_route_ip() -> Option<IpAddr> {
    let socket = UdpSocket::bind(SocketAddr::from((Ipv4Addr::UNSPECIFIED, 0))).ok()?;
    socket.connect(SocketAddr::from((Ipv4Addr::new(192, 0, 2, 1), 9))).ok()?;
    Some(socket.local_addr().ok()?.ip())
}

#[cfg(unix)]
fn platform_hostname() -> Option<String> {
    let mut buf = [0u8; 256];
    // SAFETY: the buffer is valid for `buf.len()` bytes; gethostname writes a
    // NUL-terminated name into it (truncated if needed).
    let rc = unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) };
    if rc != 0 {
        return None;
    }
    let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
    Some(String::from_utf8_lossy(&buf[..end]).into_owned())
}

#[cfg(windows)]
fn platform_hostname() -> Option<String> {
    std::env::var("COMPUTERNAME").ok()
}

#[cfg(not(any(unix, windows)))]
fn platform_hostname() -> Option<String> {
    None
}

#[cfg(unix)]
fn platform_ips() -> Vec<IpAddr> {
    let mut out = Vec::new();
    let mut list: *mut libc::ifaddrs = std::ptr::null_mut();
    // SAFETY: getifaddrs allocates a linked list that is released below with
    // freeifaddrs; every pointer is checked for null before it is read.
    unsafe {
        if libc::getifaddrs(&mut list) != 0 {
            return out;
        }
        let mut cursor = list;
        while !cursor.is_null() {
            let entry = &*cursor;
            if !entry.ifa_addr.is_null() {
                let name = std::ffi::CStr::from_ptr(entry.ifa_name).to_string_lossy();
                if is_virtual_bridge(&name) {
                    cursor = entry.ifa_next;
                    continue;
                }
                match (*entry.ifa_addr).sa_family as i32 {
                    libc::AF_INET => {
                        let sin = &*(entry.ifa_addr as *const libc::sockaddr_in);
                        out.push(IpAddr::V4(Ipv4Addr::from(u32::from_be(sin.sin_addr.s_addr))));
                    }
                    libc::AF_INET6 => {
                        let sin6 = &*(entry.ifa_addr as *const libc::sockaddr_in6);
                        out.push(IpAddr::V6(std::net::Ipv6Addr::from(sin6.sin6_addr.s6_addr)));
                    }
                    _ => {}
                }
            }
            cursor = entry.ifa_next;
        }
        libc::freeifaddrs(list);
    }
    out
}

/// Interface names of container and virtual-machine bridges.
#[cfg(unix)]
fn is_virtual_bridge(name: &str) -> bool {
    const PREFIXES: &[&str] = &[
        "docker", "br-", "veth", "virbr", "vmnet", "vboxnet", "lxcbr", "lxdbr", "cni", "flannel", "kube", "podman",
        "cali", "weave",
    ];
    PREFIXES.iter().any(|p| name.starts_with(p))
}

/// Windows adapters of local virtual machines and containers, by their
/// friendly name ("vEthernet (Default Switch)", "vEthernet (WSL)") or
/// description ("Hyper-V Virtual Ethernet Adapter", "VirtualBox Host-Only
/// Ethernet Adapter", "VMware Virtual Ethernet Adapter for VMnet8"). VPN
/// adapters ("ZeroTier Virtual Port", "WireGuard Tunnel", "Tailscale
/// Tunnel", "TAP-Windows Adapter V9") do not match.
#[cfg(any(windows, test))]
fn is_virtual_adapter(friendly_name: &str, description: &str) -> bool {
    let name = friendly_name.to_ascii_lowercase();
    let description = description.to_ascii_lowercase();
    name.starts_with("vethernet")
        || ["hyper-v virtual ethernet", "virtualbox host-only", "vmware virtual ethernet"]
            .iter()
            .any(|pattern| description.contains(pattern))
}

#[cfg(windows)]
fn platform_ips() -> Vec<IpAddr> {
    adapter_ips().unwrap_or_else(hostname_ips)
}

/// Addresses of the adapters that are up, minus virtual-machine networks.
/// `None` when the adapter list cannot be read.
#[cfg(windows)]
fn adapter_ips() -> Option<Vec<IpAddr>> {
    use std::ffi::c_void;

    // The leading fields of IP_ADAPTER_ADDRESSES_LH and
    // IP_ADAPTER_UNICAST_ADDRESS_LH (iptypes.h). Only these are read, always
    // through pointers the OS filled in; the real structs are longer.
    #[repr(C)]
    struct SocketAddress {
        sockaddr: *const u8,
        length: i32,
    }
    #[repr(C)]
    struct Unicast {
        length: u32,
        flags: u32,
        next: *const Unicast,
        address: SocketAddress,
    }
    #[repr(C)]
    struct Adapter {
        length: u32,
        if_index: u32,
        next: *const Adapter,
        adapter_name: *const u8,
        first_unicast: *const Unicast,
        first_anycast: *const c_void,
        first_multicast: *const c_void,
        first_dns_server: *const c_void,
        dns_suffix: *const u16,
        description: *const u16,
        friendly_name: *const u16,
        physical_address: [u8; 8],
        physical_address_length: u32,
        flags: u32,
        mtu: u32,
        if_type: u32,
        oper_status: u32,
    }
    #[link(name = "iphlpapi")]
    unsafe extern "system" {
        fn GetAdaptersAddresses(
            family: u32,
            flags: u32,
            reserved: *mut c_void,
            list: *mut Adapter,
            size: *mut u32,
        ) -> u32;
    }
    const AF_UNSPEC: u32 = 0;
    const AF_INET: u16 = 2;
    const AF_INET6: u16 = 23;
    const SKIP_ANYCAST_MULTICAST_DNS: u32 = 0x2 | 0x4 | 0x8;
    const ERROR_BUFFER_OVERFLOW: u32 = 111;
    const IF_OPER_STATUS_UP: u32 = 1;
    const IF_TYPE_SOFTWARE_LOOPBACK: u32 = 24;

    /// A NUL-terminated UTF-16 string owned by the adapter list.
    ///
    /// SAFETY: `text` is null or points to a NUL-terminated UTF-16 string.
    unsafe fn wide(text: *const u16) -> String {
        if text.is_null() {
            return String::new();
        }
        let mut len = 0;
        // SAFETY: the string is NUL-terminated (caller's contract).
        while unsafe { *text.add(len) } != 0 {
            len += 1;
        }
        // SAFETY: `len` u16s were just read from `text`.
        String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(text, len) })
    }

    // u64 storage keeps the list 8-byte aligned, as the structs require.
    let mut size: u32 = 16 * 1024;
    let mut buffer: Vec<u64> = Vec::new();
    let mut result = ERROR_BUFFER_OVERFLOW;
    for _ in 0..3 {
        buffer = vec![0u64; (size as usize).div_ceil(8)];
        // SAFETY: `buffer` holds `size` writable bytes, 8-byte aligned; the
        // call writes at most `size` bytes and updates `size` when too small.
        result = unsafe {
            GetAdaptersAddresses(
                AF_UNSPEC,
                SKIP_ANYCAST_MULTICAST_DNS,
                std::ptr::null_mut(),
                buffer.as_mut_ptr().cast(),
                &mut size,
            )
        };
        if result != ERROR_BUFFER_OVERFLOW {
            break;
        }
    }
    if result != 0 {
        return None;
    }
    let mut out = Vec::new();
    let mut adapter = buffer.as_ptr() as *const Adapter;
    // SAFETY: on success the buffer holds a linked list of adapters whose
    // pointers stay valid while `buffer` lives; each is checked for null.
    unsafe {
        while !adapter.is_null() {
            let a = &*adapter;
            let skip = a.oper_status != IF_OPER_STATUS_UP
                || a.if_type == IF_TYPE_SOFTWARE_LOOPBACK
                || is_virtual_adapter(&wide(a.friendly_name), &wide(a.description));
            let mut unicast = if skip { std::ptr::null() } else { a.first_unicast };
            while !unicast.is_null() {
                let u = &*unicast;
                let sockaddr = u.address.sockaddr;
                if !sockaddr.is_null() {
                    let family = u16::from_ne_bytes([*sockaddr, *sockaddr.add(1)]);
                    if family == AF_INET && u.address.length >= 8 {
                        let b = std::slice::from_raw_parts(sockaddr.add(4), 4);
                        out.push(IpAddr::V4(Ipv4Addr::new(b[0], b[1], b[2], b[3])));
                    } else if family == AF_INET6 && u.address.length >= 24 {
                        let mut b = [0u8; 16];
                        b.copy_from_slice(std::slice::from_raw_parts(sockaddr.add(8), 16));
                        out.push(IpAddr::V6(std::net::Ipv6Addr::from(b)));
                    }
                }
                unicast = u.next;
            }
            adapter = a.next;
        }
    }
    Some(out)
}

/// Every address the host name resolves to (no adapter information).
#[cfg(not(unix))]
fn hostname_ips() -> Vec<IpAddr> {
    use std::net::ToSocketAddrs;
    let Some(name) = platform_hostname() else { return Vec::new() };
    match (name.as_str(), 0u16).to_socket_addrs() {
        Ok(addrs) => addrs.map(|a| a.ip()).collect(),
        Err(_) => Vec::new(),
    }
}

#[cfg(not(any(unix, windows)))]
fn platform_ips() -> Vec<IpAddr> {
    hostname_ips()
}

/// Maps an IPv4-mapped IPv6 address (`::ffff:1.2.3.4`) to plain IPv4, so the
/// same client is always identified by the same address.
pub fn canonical_ip(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => IpAddr::V4(v4),
            None => IpAddr::V6(v6),
        },
        v4 => v4,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_unreachable_addresses() {
        assert!(!is_reachable_unicast(&"127.0.0.1".parse().unwrap()));
        assert!(!is_reachable_unicast(&"169.254.1.1".parse().unwrap()));
        assert!(!is_reachable_unicast(&"fe80::1".parse().unwrap()));
        assert!(is_reachable_unicast(&"192.168.1.10".parse().unwrap()));
        assert!(is_reachable_unicast(&"2001:db8::1".parse().unwrap()));
        for ip in local_ips() {
            assert!(is_reachable_unicast(&ip));
        }
    }

    #[cfg(unix)]
    #[test]
    fn container_bridges_are_virtual_but_vpns_are_not() {
        assert!(is_virtual_bridge("docker0"));
        assert!(is_virtual_bridge("br-5f2a"));
        assert!(!is_virtual_bridge("wg0"));
        assert!(!is_virtual_bridge("tun0"));
        assert!(!is_virtual_bridge("eth0"));
    }

    #[test]
    fn virtual_machine_adapters_are_left_out_but_vpns_are_not() {
        assert!(is_virtual_adapter("vEthernet (Default Switch)", "Hyper-V Virtual Ethernet Adapter"));
        assert!(is_virtual_adapter("vEthernet (WSL)", "Hyper-V Virtual Ethernet Adapter #2"));
        assert!(is_virtual_adapter("Ethernet 3", "VirtualBox Host-Only Ethernet Adapter"));
        assert!(is_virtual_adapter("VMware Network Adapter VMnet8", "VMware Virtual Ethernet Adapter for VMnet8"));
        assert!(!is_virtual_adapter("ZeroTier One [8056c2e21c000001]", "ZeroTier Virtual Port"));
        assert!(!is_virtual_adapter("Wi-Fi", "Intel(R) Wi-Fi 6 AX201 160MHz"));
        assert!(!is_virtual_adapter("Ethernet", "Realtek PCIe GbE Family Controller"));
        assert!(!is_virtual_adapter("wg0", "WireGuard Tunnel"));
        assert!(!is_virtual_adapter("Tailscale", "Tailscale Tunnel"));
        assert!(!is_virtual_adapter("OpenVPN TAP", "TAP-Windows Adapter V9"));
    }

    #[test]
    fn mapped_addresses_become_ipv4() {
        let mapped: IpAddr = "::ffff:10.0.0.5".parse().unwrap();
        assert_eq!(canonical_ip(mapped), "10.0.0.5".parse::<IpAddr>().unwrap());
        let v6: IpAddr = "2001:db8::1".parse().unwrap();
        assert_eq!(canonical_ip(v6), v6);
    }
}
