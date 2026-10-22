import asyncio
import unittest

import mqtt_packets as mqtt


class PacketTests(unittest.IsolatedAsyncioTestCase):
    async def test_packet_lengths_and_round_trip(self):
        for length in (0, 127, 128, 16383, 16384, 65536):
            with self.subTest(length=length):
                body = b"x" * length
                reader = asyncio.StreamReader()
                reader.feed_data(mqtt.packet(0x32, body))
                reader.feed_eof()
                self.assertEqual(await mqtt.read_packet(reader), (0x32, body))
        with self.assertRaises(ValueError):
            mqtt.packet(0x32, b"x" * 65537)

    async def test_fragmented_input(self):
        reader = asyncio.StreamReader()
        task = asyncio.create_task(mqtt.read_packet(reader))
        for byte in b"\x40\x02\x00\x07":
            reader.feed_data(bytes([byte]))
            await asyncio.sleep(0)
        self.assertEqual(await task, (0x40, b"\x00\x07"))

    async def test_malformed_oversized_and_truncated_packets(self):
        for data, error in ((b"\x32\x80\x80\x80\x80", ValueError),
                            (b"\x32\x81\x80\x04", ValueError),
                            (b"\x40\x02\x00", asyncio.IncompleteReadError)):
            with self.subTest(data=data):
                reader = asyncio.StreamReader()
                reader.feed_data(data)
                reader.feed_eof()
                with self.assertRaises(error):
                    await mqtt.read_packet(reader)

    def test_non_retained_qos1_publish_and_duplicate(self):
        body = b"\x00\x03t/1\x00\x07content"
        for header in (0x32, 0x3A):
            self.assertEqual(mqtt.publish_fields(header, body), (b"t/1", b"\x00\x07", b"content"))
        for header, data in ((0x30, body), (0x33, body), (0x32, b""),
                             (0x32, b"\x00\x00\x00\x07"),
                             (0x32, b"\x00\x03t/1\x00"),
                             (0x32, b"\x00\x03t/1\x00\x00")):
            with self.subTest(header=header, data=data), self.assertRaises(ValueError):
                mqtt.publish_fields(header, data)


if __name__ == "__main__":
    unittest.main()
