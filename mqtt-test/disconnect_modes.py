"""Independent fault-injection snippets; importing this module changes nothing."""

import ipaddress
import re
import socket
import struct


def tcp_fin(writer):
    # Retain the reader until peer EOF; closing unread data can produce RST.
    writer.write_eof()


def tcp_rst(writer):
    writer.get_extra_info("socket").setsockopt(
        socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
    writer.transport.abort()


async def mqtt_silent(reader):
    # Consume bytes without MQTT replies so the receive window does not fill.
    while await reader.read(65536):
        pass


def drop_rules(table, local_ip, ips, ports, port=1883):
    """Generate nftables rules only; the caller applies and rolls them back."""
    if not re.fullmatch(r"mqtt_[a-z0-9_]{1,24}", table):
        raise ValueError("Invalid run-owned table name")
    local_ip = str(ipaddress.IPv4Address(local_ip))
    ips = sorted({str(ipaddress.IPv4Address(ip)) for ip in ips})
    ports = list(ports)
    if not ips or not ports or not all(type(p) is int and 1024 <= p <= 65535 for p in ports):
        raise ValueError("Invalid selected flow ports/addresses")
    if type(port) is not int or not 1 <= port <= 65535:
        raise ValueError("Invalid broker port")
    peers = ", ".join(ips)
    selected = ", ".join(map(str, sorted(set(ports))))
    return f"""add table inet {table}
add set inet {table} old_ports {{ type inet_service; flags timeout; timeout 30m; }}
add element inet {table} old_ports {{ {selected} }}
add chain inet {table} outbound {{ type filter hook output priority -50; policy accept; }}
add chain inet {table} inbound {{ type filter hook input priority -50; policy accept; }}
add rule inet {table} outbound ip saddr {local_ip} ip daddr {{ {peers} }} tcp dport {port} tcp sport @old_ports counter drop
add rule inet {table} inbound ip daddr {local_ip} ip saddr {{ {peers} }} tcp sport {port} tcp dport @old_ports counter drop
"""
