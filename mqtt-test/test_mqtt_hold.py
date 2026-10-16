import unittest
from unittest.mock import MagicMock, call, patch

import mqtt_hold as mqtt


class HoldTests(unittest.TestCase):
    def test_connect_packet_credentials_and_variable_length(self):
        packet = mqtt.connect_packet("acl-test", "test", "p" * 200)
        index, length, multiplier = 1, 0, 1
        while True:
            byte = packet[index]
            index += 1
            length += (byte & 127) * multiplier
            if not byte & 128:
                break
            multiplier *= 128
        self.assertEqual(packet[0], 0x10)
        self.assertEqual(length, len(packet[index:]))
        self.assertEqual(packet[index:index + 10], b"\x00\x04MQTT\x04\xc2\x00\x14")
        self.assertTrue(packet.endswith(b"\x00\xc8" + b"p" * 200))
        for value in ("", "bad\x00id", "u" * 65536):
            with self.subTest(value=value[:10]), self.assertRaises(ValueError):
                mqtt.connect_packet(value, "test", "test")

    def test_fragmented_receive_and_closed_socket(self):
        stream = MagicMock()
        stream.recv.side_effect = [b"\x20", b"\x02\x00", b"\x00"]
        self.assertEqual(mqtt.receive(stream, 4), b"\x20\x02\x00\x00")
        stream.recv.side_effect = [b""]
        with self.assertRaises(EOFError):
            mqtt.receive(stream, 2)

    def test_response_deadline(self):
        stream = MagicMock()
        with patch.object(mqtt.time, "monotonic", side_effect=[0, 11]):
            with self.assertRaises(TimeoutError):
                mqtt.receive(stream, 2)
        stream.recv.assert_not_called()

    def run_hold(self, replies):
        stream = MagicMock()
        stream.__enter__.return_value = stream
        stream.recv.side_effect = replies
        with patch.object(mqtt.socket, "create_connection", return_value=stream) as connect, \
                patch.object(mqtt.time, "sleep"), patch.object(mqtt, "log") as log:
            self.assertEqual(mqtt.hold("acl-test", "test", "test"), 1)
        connect.assert_called_once_with((mqtt.HOST, mqtt.PORT), timeout=mqtt.TIMEOUT)
        return stream, log

    def test_heartbeat_then_disconnect_without_reconnecting(self):
        stream, log = self.run_hold([b"\x20\x02\x00\x00", b"\xd0\x00", b""])
        self.assertEqual([entry.args[1] for entry in log.call_args_list],
                         ["starting", "connected", "ping_sent", "pingresp", "ping_sent", "disconnected"])
        self.assertIn(call(b"\xc0\x00"), stream.sendall.call_args_list)
        self.assertEqual(log.call_args.kwargs["phase"], "heartbeat")

    def test_rejected_or_invalid_connack_never_sends_heartbeat(self):
        for reply in (b"\x20\x02\x00\x05", b"\x20\x02\x01\x00"):
            with self.subTest(reply=reply):
                stream, log = self.run_hold([reply])
                self.assertEqual(stream.sendall.call_count, 1)
                self.assertEqual(log.call_args.kwargs["phase"], "connect")

    def test_missing_or_invalid_heartbeat_response(self):
        for reply in (TimeoutError("timed out"), b"\xe0\x00"):
            with self.subTest(reply=reply):
                _, log = self.run_hold([b"\x20\x02\x00\x00", reply])
                self.assertEqual(log.call_args.args[1], "disconnected")
                self.assertEqual(log.call_args.kwargs["phase"], "heartbeat")


if __name__ == "__main__":
    unittest.main()
