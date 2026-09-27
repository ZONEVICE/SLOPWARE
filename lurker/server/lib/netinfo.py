"""This machine's name and IPv4 addresses, for the banner and the certificate."""
import ipaddress
import socket
import struct
import sys

# Interfaces that exist on the machine but are never how another device on the
# LAN reaches it. They are listed last rather than dropped.
_VIRTUAL_PREFIXES = ('docker', 'br-', 'veth', 'virbr', 'vmnet', 'vboxnet', 'lxc', 'lxd', 'cni', 'flannel',
                     'podman', 'zt', 'tailscale', 'tun', 'tap', 'wg')


def hostname():
    try:
        return socket.gethostname() or 'localhost'
    except OSError:
        return 'localhost'


def lan_addresses(include_virtual=True):
    """Non-loopback IPv4 addresses, the most likely LAN address first.

    Container and VM bridges (docker0, virbr0...) are real addresses of this
    machine but never how a phone on the LAN reaches it; they are left out
    unless `include_virtual` (the certificate wants every name it may be
    reached by).
    """
    ordered = []

    def add(address):
        try:
            parsed = ipaddress.IPv4Address(address)
        except ValueError:
            return
        if parsed.is_loopback or parsed.is_unspecified or parsed.is_multicast:
            return
        if address not in ordered:
            ordered.append(address)

    add(_primary_address())
    physical, virtual = _interface_addresses()
    for address in physical:
        add(address)
    for address in _hostname_addresses():
        if address not in virtual or include_virtual:
            add(address)
    if include_virtual:
        for address in virtual:
            add(address)
    # Link-local (169.254.x.x) addresses work, but only as a last resort.
    return sorted(ordered, key=lambda a: ipaddress.IPv4Address(a).is_link_local)


def _primary_address():
    """The address the OS would use to reach the outside world. No packet is sent."""
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(('192.0.2.1', 9))  # TEST-NET-1: never routed, never contacted
        return probe.getsockname()[0]
    except OSError:
        return None
    finally:
        probe.close()


def _hostname_addresses():
    try:
        return socket.gethostbyname_ex(socket.gethostname())[2]
    except OSError:
        return []


def _interface_addresses():
    """(physical, virtual) IPv4 addresses per interface, on Linux only."""
    if not sys.platform.startswith('linux') or not hasattr(socket, 'if_nameindex'):
        return [], []
    try:
        import fcntl
    except ImportError:
        return [], []
    physical, virtual = [], []
    siocgifaddr = 0x8915
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        for _, name in socket.if_nameindex():
            if name == 'lo':
                continue
            try:
                packed = fcntl.ioctl(probe.fileno(), siocgifaddr, struct.pack('256s', name[:15].encode()))
            except OSError:
                continue  # interface without an IPv4 address
            address = socket.inet_ntoa(packed[20:24])
            (virtual if name.startswith(_VIRTUAL_PREFIXES) else physical).append(address)
    except OSError:
        pass
    finally:
        probe.close()
    return physical, virtual


def certificate_names(bind_host):
    """(dns_names, ip_addresses) a certificate for this machine should cover."""
    name = hostname()
    dns = ['localhost']
    for candidate in (name, name.split('.')[0], name.split('.')[0] + '.local'):
        if candidate and candidate not in dns:
            dns.append(candidate)
    ips = ['127.0.0.1', '::1']
    for address in lan_addresses():
        if address not in ips:
            ips.append(address)
    if bind_host not in ('', '0.0.0.0', '::') and bind_host not in ips:
        try:
            ipaddress.ip_address(bind_host)
            ips.append(bind_host)
        except ValueError:
            if bind_host not in dns:
                dns.append(bind_host)
    return dns, ips
