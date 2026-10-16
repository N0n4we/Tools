#!/usr/bin/env python3
"""Hold one MQTT 3.1.1 TCP connection, logging heartbeats without reconnecting."""

import argparse
import datetime
import json
import os
import socket
import time

HOST = "gf092f87.ala.dedicated.aws.mqttce.net"
PORT = 1883
KEEPALIVE = 20
PING_INTERVAL = 5
TIMEOUT = 10


def log(client_id, event, **fields):
    print(json.dumps({"at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                      "client_id": client_id, "event": event, **fields}), flush=True)


def connect_packet(client_id, username, password):
    payload = bytearray()
    for value in (client_id, username, password):
        encoded = value.encode("utf-8")
        if not encoded or len(encoded) > 65535 or b"\x00" in encoded:
            raise ValueError("MQTT fields must be nonempty, NUL-free, and at most 65535 bytes")
        payload.extend(len(encoded).to_bytes(2, "big") + encoded)
    body = b"\x00\x04MQTT\x04\xc2" + KEEPALIVE.to_bytes(2, "big") + payload
    length = len(body)
    remaining = bytearray()
    while True:
        byte = length % 128
        length //= 128
        remaining.append(byte | (128 if length else 0))
        if not length:
            break
    return b"\x10" + remaining + body


def receive(stream, size):
    deadline = time.monotonic() + TIMEOUT
    data = b""
    while len(data) < size:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("MQTT response deadline exceeded")
        stream.settimeout(remaining)
        chunk = stream.recv(size - len(data))
        if not chunk:
            raise EOFError("Broker closed the connection")
        data += chunk
    return data


def hold(client_id, username, password):
    phase = "connect"
    log(client_id, "starting", host=HOST, port=PORT, pid=os.getpid())
    try:
        packet = connect_packet(client_id, username, password)
        with socket.create_connection((HOST, PORT), timeout=TIMEOUT) as stream:
            stream.sendall(packet)
            reply = receive(stream, 4)
            if reply[:3] != b"\x20\x02\x00" or reply[3] > 5:
                raise ValueError("Invalid MQTT 3.1.1 CONNACK")
            if reply[3]:
                raise PermissionError(f"MQTT CONNACK rejected: code {reply[3]}")
            log(client_id, "connected", local=stream.getsockname(), remote=stream.getpeername())
            phase = "heartbeat"
            while True:
                time.sleep(PING_INTERVAL)
                started = time.monotonic()
                log(client_id, "ping_sent")
                stream.settimeout(TIMEOUT)
                stream.sendall(b"\xc0\x00")
                if receive(stream, 2) != b"\xd0\x00":
                    raise ValueError("Expected MQTT PINGRESP")
                log(client_id, "pingresp", rtt_ms=round((time.monotonic() - started) * 1000, 1))
    except (OSError, EOFError, ValueError) as error:
        log(client_id, "disconnected", phase=phase, error=type(error).__name__, reason=str(error))
        return 1
    except KeyboardInterrupt:
        log(client_id, "stopped")
        return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("client_id")
    args = parser.parse_args()
    raise SystemExit(hold(args.client_id, os.environ["MQTT_USERNAME"], os.environ["MQTT_PASSWORD"]))
