uv run --no-project --python 3.12 python - <<'PY'
import socket
import ssl

host = "b66e1f11.ala.dedicated.aws.mqttce.net"
with socket.create_connection((host, 8883), timeout=5) as sock:
    print("TCP connected")
    with ssl.create_default_context().wrap_socket(sock, server_hostname=host):
        print("TLS connected")
PY
