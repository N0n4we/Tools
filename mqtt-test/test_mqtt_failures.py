import ssl
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

import mqtt_failures as mqtt


class MQTTTests(unittest.TestCase):
    def setUp(self):
        self.raw = MagicMock()
        self.raw.__enter__.return_value = self.raw
        self.raw.getsockname.return_value = ("192.0.2.1", 12345)
        self.stream = MagicMock()
        self.stream.__enter__.return_value = self.stream
        self.context = MagicMock()
        self.context.wrap_socket.return_value = self.stream

    def probe(self):
        with patch.object(mqtt.socket, "create_connection", return_value=self.raw):
            return mqtt.probe("broker.example", "192.0.2.2", 8883, "test", self.context)

    def test_reads_existing_config_format_without_needing_real_password(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "env"
            path.write_text("ADDRESS: broker.example\nMQTT over TLS/SSL Port: 8883\nUsername: test\n")
            self.assertEqual(mqtt.load_config(path), ("broker.example", 8883, "test"))
            path.write_text("ADDRESS: broker.example\n")
            with self.assertRaisesRegex(ValueError, "Missing configuration"):
                mqtt.load_config(path)

    def test_connect_packet_lengths_flags_and_wrong_password(self):
        packet = mqtt.connect_packet("u" * 200)
        index, length, multiplier = 1, 0, 1
        while True:
            byte = packet[index]
            index += 1
            length += (byte & 127) * multiplier
            if not byte & 128:
                break
            multiplier *= 128
        body = packet[index:]
        self.assertEqual(packet[0], 0x10)
        self.assertEqual(length, len(body))
        self.assertEqual(body[:10], b"\x00\x04MQTT\x04\xc2\x00\x0a")
        self.assertIn(b"intentionally-wrong-", body)
        with self.assertRaises(ValueError):
            mqtt.connect_packet("u" * 65536)

    def test_fragmented_application_rejection(self):
        self.stream.recv.side_effect = [b"\x20", b"\x02\x00", b"\x05"]
        result = self.probe()
        self.assertEqual(result["status"], "application_rejected")
        self.assertEqual(result["mqtt_return_code"], 5)
        self.assertEqual(result["local_port"], 12345)
        self.context.wrap_socket.assert_called_once_with(self.raw, server_hostname="broker.example")

    def test_tcp_timeout_is_not_reported_as_application_rejection(self):
        with patch.object(mqtt.socket, "create_connection", side_effect=TimeoutError):
            result = mqtt.probe("broker.example", "192.0.2.2", 8883, "test", self.context)
        self.assertEqual(result["status"], "tcp_timeout")
        self.assertNotIn("mqtt_return_code", result)

    def test_tls_failure_is_not_reported_as_aws_blocking(self):
        self.context.wrap_socket.side_effect = ssl.SSLError("certificate verification failed")
        self.assertEqual(self.probe()["status"], "tls_error")

    def test_closed_or_invalid_connack_and_unexpected_success(self):
        for reply, status in ((b"", "mqtt_closed_without_connack"),
                              (b"\x20\x02\x01\x05", "mqtt_protocol_error"),
                              (b"\x20\x02\x00\x00", "unexpected_success")):
            with self.subTest(reply=reply):
                self.stream.recv.side_effect = None
                self.stream.recv.return_value = reply
                self.assertEqual(self.probe()["status"], status)


if __name__ == "__main__":
    unittest.main()
