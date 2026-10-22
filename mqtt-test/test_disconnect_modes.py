import socket
import struct
import unittest
from unittest.mock import AsyncMock, MagicMock, call

import disconnect_modes as modes


class DisconnectTests(unittest.IsolatedAsyncioTestCase):
    def test_fin_is_write_half_close_without_disconnect_or_full_close(self):
        writer = MagicMock()
        modes.tcp_fin(writer)
        writer.write_eof.assert_called_once_with()
        writer.write.assert_not_called()
        writer.close.assert_not_called()
        writer.transport.abort.assert_not_called()

    def test_rst_sets_zero_linger_before_aborting_without_disconnect(self):
        writer = MagicMock()
        modes.tcp_rst(writer)
        self.assertEqual(writer.mock_calls, [
            call.get_extra_info("socket"),
            call.get_extra_info().setsockopt(socket.SOL_SOCKET, socket.SO_LINGER,
                                             struct.pack("ii", 1, 0)),
            call.transport.abort(),
        ])

    async def test_mqtt_silence_consumes_bytes_until_eof(self):
        reader = MagicMock()
        reader.read = AsyncMock(side_effect=[b"\x32\x02xx", b"\xd0\x00", b""])
        await modes.mqtt_silent(reader)
        self.assertEqual(reader.read.call_args_list, [call(65536)] * 3)

    def test_drop_rules_are_bidirectional_scoped_and_do_not_flush(self):
        rules = modes.drop_rules("mqtt_unit", "192.0.2.10", ["198.51.100.20"],
                                  [40002, 40001, 40001])
        self.assertIn("old_ports { 40001, 40002 }", rules)
        self.assertEqual(rules.count("policy accept"), 2)
        self.assertIn("ip saddr 192.0.2.10 ip daddr { 198.51.100.20 }", rules)
        self.assertIn("ip daddr 192.0.2.10 ip saddr { 198.51.100.20 }", rules)
        self.assertIn("tcp dport 1883 tcp sport @old_ports counter drop", rules)
        self.assertIn("tcp sport 1883 tcp dport @old_ports counter drop", rules)
        self.assertEqual(rules.count("counter drop"), 2)
        self.assertIn("timeout 30m", rules)
        self.assertNotIn("tcp flags", rules)
        self.assertNotIn("flush", rules)
        self.assertNotIn("reject", rules)

    def test_drop_rules_reject_unsafe_names_addresses_and_ports(self):
        for table in ("system", "mqtt_x;flush ruleset", "mqtt_" + "x" * 25):
            with self.subTest(table=table), self.assertRaises(ValueError):
                modes.drop_rules(table, "192.0.2.10", ["198.51.100.20"], [40001])
        for ports in ([], [22], [65536], ["40001"], [40001, "40002"], [True]):
            with self.subTest(ports=ports), self.assertRaises(ValueError):
                modes.drop_rules("mqtt_unit", "192.0.2.10", ["198.51.100.20"], ports)
        for local, peers in (("invalid", ["198.51.100.20"]), ("192.0.2.10", []),
                             ("192.0.2.10", ["::1"]), ("192.0.2.10", ["invalid"])):
            with self.subTest(local=local, peers=peers), self.assertRaises(ValueError):
                modes.drop_rules("mqtt_unit", local, peers, [40001])
        for port in (0, 65536, "1883", True):
            with self.subTest(port=port), self.assertRaises(ValueError):
                modes.drop_rules("mqtt_unit", "192.0.2.10", ["198.51.100.20"], [40001], port)


if __name__ == "__main__":
    unittest.main()
