#!/usr/bin/env bash
set -euo pipefail
: "${MQTT_HOST:?Set MQTT_HOST to an explicitly authorized target}"

uv run --no-project python - <<'PY'
import os
import socket
import ssl

host = os.environ["MQTT_HOST"]
port = int(os.environ.get("MQTT_PORT", "8883"))
if not 1 <= port <= 65535:
    raise ValueError("MQTT_PORT must be between 1 and 65535")
with socket.create_connection((host, port), timeout=5) as sock:
    print("TCP connected")
    with ssl.create_default_context().wrap_socket(sock, server_hostname=host):
        print("TLS connected")
PY
