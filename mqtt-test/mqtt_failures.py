#!/usr/bin/env python3
"""Make 30 MQTT 3.1.1 connections with a wrong password in under one minute."""

import collections
import datetime
import json
import socket
import ssl
import time
import uuid
from pathlib import Path

ATTEMPTS = 30
TIMEOUT = 1.5


def load_config(path):
    values = {}
    for line in path.read_text().splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        key, separator, value = line.partition(":")
        if not separator:
            raise ValueError("Expected label: value in the configuration file")
        values[key.strip()] = value.strip()
    for key in ("ADDRESS", "MQTT over TLS/SSL Port", "Username"):
        if not values.get(key):
            raise ValueError(f"Missing configuration: {key}")
    port = int(values["MQTT over TLS/SSL Port"])
    if not 1 <= port <= 65535:
        raise ValueError("Invalid MQTT port")
    return values["ADDRESS"], port, values["Username"]


def connect_packet(username):
    def field(value):
        encoded = value.encode("utf-8")
        if len(encoded) > 65535:
            raise ValueError("MQTT string exceeds 65535 bytes")
        return len(encoded).to_bytes(2, "big") + encoded

    payload = b"".join(field(value) for value in (
        "nacltest-" + uuid.uuid4().hex[:12], username,
        "intentionally-wrong-" + uuid.uuid4().hex,
    ))
    # MQTT 3.1.1, clean session, username/password, 10-second keepalive; no PUBLISH.
    body = b"\x00\x04MQTT\x04\xc2\x00\x0a" + payload
    length = len(body)
    remaining = bytearray()
    while True:
        byte = length % 128
        length //= 128
        remaining.append(byte | (128 if length else 0))
        if not length:
            break
    return b"\x10" + remaining + body


def utc_now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds")


def probe(host, ip, port, username, context):
    started = time.monotonic()
    deadline = started + TIMEOUT
    result = {"started_at": utc_now(), "remote_ip": ip, "remote_port": port}
    phase = "tcp"

    def remaining():
        seconds = deadline - time.monotonic()
        if seconds <= 0:
            raise TimeoutError("Connection attempt deadline exceeded")
        return seconds

    try:
        with socket.create_connection((ip, port), timeout=remaining()) as raw:
            result["local_ip"], result["local_port"] = raw.getsockname()[:2]
            phase = "tls"
            raw.settimeout(remaining())
            with context.wrap_socket(raw, server_hostname=host) as stream:
                phase = "mqtt"
                stream.settimeout(remaining())
                stream.sendall(connect_packet(username))
                reply = b""
                while len(reply) < 4:
                    stream.settimeout(remaining())
                    chunk = stream.recv(4 - len(reply))
                    if not chunk:
                        raise EOFError("Connection closed before CONNACK")
                    reply += chunk
                if reply[:3] != b"\x20\x02\x00" or reply[3] > 5:
                    raise ValueError("Invalid MQTT 3.1.1 CONNACK")
                result.update(
                    status="application_rejected" if reply[3] else "unexpected_success",
                    mqtt_return_code=reply[3],
                    reason=("accepted", "unsupported_protocol", "client_id_rejected",
                            "server_unavailable", "bad_username_or_password", "not_authorized")[reply[3]],
                )
    except TimeoutError:
        result.update(status=f"{phase}_timeout", reason="No response before deadline")
    except ssl.SSLError as error:
        result.update(status="tls_error", reason=str(error))
    except EOFError as error:
        result.update(status="mqtt_closed_without_connack", reason=str(error))
    except OSError as error:
        result.update(status=f"{phase}_error", reason=str(error))
    except ValueError as error:
        result.update(status="mqtt_protocol_error", reason=str(error))
    result.update(phase=phase, finished_at=utc_now(), elapsed_ms=round((time.monotonic() - started) * 1000))
    return result


def main():
    host, port, username = load_config(Path(__file__).with_name("env"))
    addresses = sorted({entry[4][0] for entry in socket.getaddrinfo(host, port, socket.AF_INET, socket.SOCK_STREAM)})
    context = ssl.create_default_context()
    print(json.dumps({"event": "start", "started_at": utc_now(), "host": host,
                      "resolved_ipv4": addresses, "port": port, "attempts": ATTEMPTS}), flush=True)
    started = time.monotonic()
    counts = collections.Counter()
    for index in range(ATTEMPTS):
        time.sleep(max(0, started + index - time.monotonic()))
        result = probe(host, addresses[0], port, username, context)
        counts[result["status"]] += 1
        print(json.dumps({"attempt": index + 1, **result}), flush=True)
        if result["status"] == "unexpected_success":
            break
    elapsed = time.monotonic() - started
    summary = {"event": "summary", "finished_at": utc_now(), "attempts": sum(counts.values()),
               "statuses": dict(counts), "elapsed_seconds": round(elapsed, 3), "within_60_seconds": elapsed < 60}
    print(json.dumps(summary), flush=True)
    return 0 if sum(counts.values()) == ATTEMPTS and not counts["unexpected_success"] and elapsed < 60 else 1


if __name__ == "__main__":
    raise SystemExit(main())
