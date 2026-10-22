"""Small MQTT 3.1.1 packet helpers, extracted from load-test prototypes."""


def packet(header, body=b""):
    size, encoded = len(body), bytearray([header])
    if size > 65536:
        raise ValueError("Test packet exceeds size limit")
    while True:
        size, byte = divmod(size, 128)
        encoded.append(byte | (128 if size else 0))
        if not size:
            return bytes(encoded) + body


async def read_packet(reader):
    header = (await reader.readexactly(1))[0]
    size = 0
    for index in range(4):
        byte = (await reader.readexactly(1))[0]
        size += (byte & 127) << (index * 7)
        if size > 65536:
            raise ValueError("Broker packet exceeds test size limit")
        if not byte & 128:
            return header, await reader.readexactly(size)
    raise ValueError("Invalid MQTT remaining length")


def publish_fields(header, body):
    if header not in (0x32, 0x3A) or len(body) < 4:
        raise ValueError("Expected non-retained QoS 1 PUBLISH")
    size = int.from_bytes(body[:2], "big")
    if not size or len(body) < size + 4:
        raise ValueError("Truncated PUBLISH topic/packet identifier")
    identifier = body[size + 2:size + 4]
    if identifier == b"\x00\x00":
        raise ValueError("Zero packet identifier")
    return body[2:size + 2], identifier, body[size + 4:]
