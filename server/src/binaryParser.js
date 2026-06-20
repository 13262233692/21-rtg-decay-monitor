const HEADER_MAGIC = 0xAA55;
const PACKET_SIZE = 48;

class BinaryProtocolParser {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  feed(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const packets = [];
    while (this.buffer.length >= PACKET_SIZE) {
      const header = this.buffer.readUInt16BE(0);
      if (header !== HEADER_MAGIC) {
        this.buffer = this.buffer.slice(1);
        continue;
      }
      const packet = this.parsePacket(this.buffer.slice(0, PACKET_SIZE));
      if (packet) {
        packets.push(packet);
      }
      this.buffer = this.buffer.slice(PACKET_SIZE);
    }
    return packets;
  }

  parsePacket(buf) {
    const checksum = buf.readUInt16BE(PACKET_SIZE - 2);
    let calc = 0;
    for (let i = 0; i < PACKET_SIZE - 2; i++) calc += buf[i];
    calc &= 0xFFFF;
    if (calc !== checksum) return null;
    return {
      header: buf.readUInt16BE(0),
      deviceId: buf.readUInt32BE(2),
      sequence: buf.readUInt32BE(6),
      timestampNs: (BigInt(buf.readUInt32BE(10)) << 32n) | BigInt(buf.readUInt32BE(14)),
      hotSideTempC: buf.readDoubleBE(18),
      coldSideTempC: buf.readDoubleBE(26),
      thermocoupleVoltageMv: buf.readFloatBE(34),
      pu238ThermalPowerW: buf.readFloatBE(38),
      status: buf.readUInt8(42),
      reserved: buf.slice(43, 46),
      checksum
    };
  }

  static buildPacket(data) {
    const buf = Buffer.alloc(PACKET_SIZE);
    buf.writeUInt16BE(HEADER_MAGIC, 0);
    buf.writeUInt32BE(data.deviceId || 0x52544701, 2);
    buf.writeUInt32BE(data.sequence || 0, 6);
    const ts = BigInt(data.timestampNs || Date.now() * 1e6);
    buf.writeUInt32BE(Number((ts >> 32n) & 0xFFFFFFFFn), 10);
    buf.writeUInt32BE(Number(ts & 0xFFFFFFFFn), 14);
    buf.writeDoubleBE(data.hotSideTempC, 18);
    buf.writeDoubleBE(data.coldSideTempC, 26);
    buf.writeFloatBE(data.thermocoupleVoltageMv, 34);
    buf.writeFloatBE(data.pu238ThermalPowerW, 38);
    buf.writeUInt8(data.status || 1, 42);
    let calc = 0;
    for (let i = 0; i < PACKET_SIZE - 2; i++) calc += buf[i];
    buf.writeUInt16BE(calc & 0xFFFF, PACKET_SIZE - 2);
    return buf;
  }
}

module.exports = { BinaryProtocolParser, HEADER_MAGIC, PACKET_SIZE };
