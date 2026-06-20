export class ProtoCodec {
  static encodeVarint(v, buf, offset) {
    let n = 0;
    if (typeof v === 'bigint') {
      do {
        let b = Number(v & 0x7Fn);
        v >>= 7n;
        if (v) b |= 0x80;
        buf[offset + n++] = b;
      } while (v);
    } else {
      v = v >>> 0;
      do {
        let b = v & 0x7F;
        v >>>= 7;
        if (v) b |= 0x80;
        buf[offset + n++] = b;
      } while (v);
    }
    return n;
  }

  static decodeVarint(buf, offset) {
    let r = 0n, s = 0n, i = 0;
    while (true) {
      if (i === 10) throw new Error('malformed varint');
      const b = buf[offset + i++];
      r |= BigInt(b & 0x7F) << s;
      s += 7n;
      if ((b & 0x80) === 0) break;
    }
    return { value: r, length: i };
  }

  static encodeDouble(v, buf, offset) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    dv.setFloat64(offset, v, false);
    return 8;
  }

  static decodeDouble(buf, offset) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    return { value: dv.getFloat64(offset, false), length: 8 };
  }

  static encodeString(s, buf, offset) {
    const enc = new TextEncoder();
    const sBytes = enc.encode(s);
    const l = this.encodeVarint(sBytes.length, buf, offset);
    for (let i = 0; i < sBytes.length; i++) buf[offset + l + i] = sBytes[i];
    return l + sBytes.length;
  }

  static decodeString(buf, offset) {
    const len = this.decodeVarint(buf, offset);
    const start = offset + len.length;
    const end = start + Number(len.value);
    const dv = new TextDecoder('utf-8');
    const s = dv.decode(buf.subarray(start, end));
    return { value: s, length: len.length + Number(len.value) };
  }

  static encodeTag(field, wire, buf, offset) {
    return this.encodeVarint(((field >>> 0) << 3) | (wire & 7), buf, offset);
  }

  static readGrpcWebFrame(buffer) {
    if (buffer.length < 5) return null;
    const flags = buffer[0];
    const dv = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const len = dv.getUint32(1, false);
    if (buffer.length < 5 + len) return null;
    return {
      flags,
      payload: buffer.subarray(5, 5 + len),
      rest: buffer.subarray(5 + len)
    };
  }

  static writeGrpcWebFrame(payload, flags = 0) {
    const out = new Uint8Array(5 + payload.length);
    out[0] = flags;
    const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
    dv.setUint32(1, payload.length, false);
    out.set(payload, 5);
    return out;
  }

  static encodeStreamRequest(p) {
    const tmp = new Uint8Array(512);
    let n = 0;
    if (p.device_id != null) { n += this.encodeTag(1, 2, tmp, n); n += this.encodeString(p.device_id, tmp, n); }
    if (p.sample_rate_hz != null) { n += this.encodeTag(2, 0, tmp, n); n += this.encodeVarint(BigInt(p.sample_rate_hz), tmp, n); }
    return tmp.subarray(0, n);
  }

  static encodeSnapshotRequest(p) {
    const tmp = new Uint8Array(512);
    let n = 0;
    if (p.device_id != null) { n += this.encodeTag(1, 2, tmp, n); n += this.encodeString(p.device_id, tmp, n); }
    return tmp.subarray(0, n);
  }

  static decodeRTGDataPoint(buf) {
    const r = {};
    let o = 0;
    while (o < buf.length) {
      const tag = this.decodeVarint(buf, o); o += tag.length;
      const field = Number(tag.value >> 3n);
      const wire = Number(tag.value & 7n);
      switch (field) {
        case 1: { const v = this.decodeVarint(buf, o); r.timestamp_ns = v.value.toString(); o += v.length; break; }
        case 2: { const v = this.decodeString(buf, o); r.device_id = v.value; o += v.length; break; }
        case 3: { const v = this.decodeDouble(buf, o); r.hot_side_temp_c = v.value; o += v.length; break; }
        case 4: { const v = this.decodeDouble(buf, o); r.cold_side_temp_c = v.value; o += v.length; break; }
        case 5: { const v = this.decodeDouble(buf, o); r.thermocouple_voltage_mv = v.value; o += v.length; break; }
        case 6: { const v = this.decodeDouble(buf, o); r.pu238_thermal_power_w = v.value; o += v.length; break; }
        case 7: { const v = this.decodeDouble(buf, o); r.system_voltage_v = v.value; o += v.length; break; }
        case 8: { const v = this.decodeDouble(buf, o); r.system_current_a = v.value; o += v.length; break; }
        case 9: { const v = this.decodeDouble(buf, o); r.heat_sink_temp_c = v.value; o += v.length; break; }
        case 10: { const v = this.decodeVarint(buf, o); r.health = ['HEALTH_UNKNOWN','HEALTH_NOMINAL','HEALTH_WARNING','HEALTH_CRITICAL','HEALTH_FAULT'][Number(v.value)] ?? 'HEALTH_UNKNOWN'; o += v.length; break; }
        case 11: { const v = this.decodeVarint(buf, o); r.sequence = Number(v.value); o += v.length; break; }
        default: {
          if (wire === 0) { const v = this.decodeVarint(buf, o); o += v.length; }
          else if (wire === 2) { const l = this.decodeVarint(buf, o); o += l.length + Number(l.value); }
          else if (wire === 1) o += 8;
          else if (wire === 5) o += 4;
          else o = buf.length;
        }
      }
    }
    return r;
  }

  static decodeThermocoupleSample(buf) {
    const r = {};
    let o = 0;
    while (o < buf.length) {
      const tag = this.decodeVarint(buf, o); o += tag.length;
      const field = Number(tag.value >> 3n);
      const wire = Number(tag.value & 7n);
      switch (field) {
        case 1: { const v = this.decodeVarint(buf, o); r.timestamp_ns = v.value.toString(); o += v.length; break; }
        case 2: { const v = this.decodeDouble(buf, o); r.voltage_mv = v.value; o += v.length; break; }
        case 3: { const v = this.decodeVarint(buf, o); r.sequence = Number(v.value); o += v.length; break; }
        default: {
          if (wire === 0) { const v = this.decodeVarint(buf, o); o += v.length; }
          else if (wire === 2) { const l = this.decodeVarint(buf, o); o += l.length + Number(l.value); }
          else if (wire === 1) o += 8;
          else if (wire === 5) o += 4;
          else o = buf.length;
        }
      }
    }
    return r;
  }

  static decodeRTGSnapshot(buf) {
    const r = { alerts: [] };
    let o = 0;
    while (o < buf.length) {
      const tag = this.decodeVarint(buf, o); o += tag.length;
      const field = Number(tag.value >> 3n);
      const wire = Number(tag.value & 7n);
      switch (field) {
        case 1: { const v = this.decodeVarint(buf, o); r.timestamp_ns = v.value.toString(); o += v.length; break; }
        case 2: { const v = this.decodeString(buf, o); r.device_id = v.value; o += v.length; break; }
        case 3: { const v = this.decodeDouble(buf, o); r.hot_side_temp_c = v.value; o += v.length; break; }
        case 4: { const v = this.decodeDouble(buf, o); r.cold_side_temp_c = v.value; o += v.length; break; }
        case 5: { const v = this.decodeDouble(buf, o); r.thermocouple_voltage_mv = v.value; o += v.length; break; }
        case 6: { const v = this.decodeDouble(buf, o); r.pu238_thermal_power_w = v.value; o += v.length; break; }
        case 7: { const v = this.decodeDouble(buf, o); r.pu238_mass_g = v.value; o += v.length; break; }
        case 8: { const v = this.decodeDouble(buf, o); r.half_life_years = v.value; o += v.length; break; }
        case 9: { const v = this.decodeDouble(buf, o); r.efficiency_percent = v.value; o += v.length; break; }
        case 10: { const v = this.decodeDouble(buf, o); r.uptime_hours = v.value; o += v.length; break; }
        case 11: { const v = this.decodeVarint(buf, o); r.health = ['HEALTH_UNKNOWN','HEALTH_NOMINAL','HEALTH_WARNING','HEALTH_CRITICAL','HEALTH_FAULT'][Number(v.value)] ?? 'HEALTH_UNKNOWN'; o += v.length; break; }
        default: {
          if (wire === 2) {
            const l = this.decodeVarint(buf, o);
            o += l.length + Number(l.value);
          } else if (wire === 0) { const v = this.decodeVarint(buf, o); o += v.length; }
          else if (wire === 1) o += 8;
          else if (wire === 5) o += 4;
          else o = buf.length;
        }
      }
    }
    return r;
  }
}
