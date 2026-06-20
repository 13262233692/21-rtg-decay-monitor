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

  static encodeHistoricalRequest(p) {
    const tmp = new Uint8Array(256);
    let n = 0;
    if (p.device_id != null) { n += this.encodeTag(1, 2, tmp, n); n += this.encodeString(p.device_id, tmp, n); }
    if (p.start_timestamp_ns != null) { n += this.encodeTag(2, 0, tmp, n); n += this.encodeVarint(BigInt(p.start_timestamp_ns), tmp, n); }
    if (p.end_timestamp_ns != null) { n += this.encodeTag(3, 0, tmp, n); n += this.encodeVarint(BigInt(p.end_timestamp_ns), tmp, n); }
    if (p.chunk_size_bytes != null) { n += this.encodeTag(4, 0, tmp, n); n += this.encodeVarint(BigInt(p.chunk_size_bytes), tmp, n); }
    if (p.sample_rate_hz != null) { n += this.encodeTag(5, 0, tmp, n); n += this.encodeVarint(BigInt(p.sample_rate_hz), tmp, n); }
    if (p.include_thermocouple != null) { n += this.encodeTag(6, 0, tmp, n); n += this.encodeVarint(BigInt(p.include_thermocouple ? 1 : 0), tmp, n); }
    if (p.include_power != null) { n += this.encodeTag(7, 0, tmp, n); n += this.encodeVarint(BigInt(p.include_power ? 1 : 0), tmp, n); }
    return tmp.subarray(0, n);
  }

  static decodeHistoricalChunk(buf) {
    const r = { status: [], payload: new Uint8Array(0) };
    let o = 0;
    while (o < buf.length) {
      const tag = this.decodeVarint(buf, o); o += tag.length;
      const field = Number(tag.value >> 3n);
      const wire = Number(tag.value & 7n);
      switch (field) {
        case 1: { const v = this.decodeVarint(buf, o); r.session_id = v.value.toString(); o += v.length; break; }
        case 2: { const v = this.decodeVarint(buf, o); r.chunk_index = Number(v.value); o += v.length; break; }
        case 3: { const v = this.decodeVarint(buf, o); r.total_chunks = Number(v.value); o += v.length; break; }
        case 4: { const v = this.decodeVarint(buf, o); r.payload_bytes = Number(v.value); o += v.length; break; }
        case 5: { const v = this.decodeVarint(buf, o); r.crc32 = Number(v.value); o += v.length; break; }
        case 6: { const v = this.decodeVarint(buf, o); r.start_timestamp_ns = v.value.toString(); o += v.length; break; }
        case 7: { const v = this.decodeVarint(buf, o); r.end_timestamp_ns = v.value.toString(); o += v.length; break; }
        case 8: { const v = this.decodeVarint(buf, o); r.sample_count = Number(v.value); o += v.length; break; }
        case 9: {
          if (wire === 2) {
            const l = this.decodeVarint(buf, o); o += l.length;
            const len = Number(l.value);
            r.payload = new Uint8Array(buf.subarray(o, o + len));
            o += len;
          } else o += 4;
          break;
        }
        case 10: { const v = this.decodeVarint(buf, o); r.chunk_type = ['CHUNK_DATA','CHUNK_METADATA','CHUNK_HEARTBEAT','CHUNK_FINAL','CHUNK_ERROR','CHUNK_REJECT'][Number(v.value)] ?? 'CHUNK_DATA'; o += v.length; break; }
        case 12: { const v = this.decodeString(buf, o); r.error_message = v.value; o += v.length; break; }
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

  static crc32(buf) {
    let crc = 0xFFFFFFFF;
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[i] = c >>> 0;
    }
    for (let i = 0; i < buf.length; i++) {
      crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  static encodeLifetimeProjectionRequest(p) {
    const tmp = new Uint8Array(256);
    let n = 0;
    if (p.device_id != null) { n += this.encodeTag(1, 2, tmp, n); n += this.encodeString(p.device_id, tmp, n); }
    if (p.projection_years != null) { n += this.encodeTag(2, 0, tmp, n); n += this.encodeVarint(BigInt(p.projection_years), tmp, n); }
    if (p.data_points != null) { n += this.encodeTag(3, 0, tmp, n); n += this.encodeVarint(BigInt(p.data_points), tmp, n); }
    if (p.include_confidence_band != null) { n += this.encodeTag(4, 0, tmp, n); n += this.encodeVarint(BigInt(p.include_confidence_band ? 1 : 0), tmp, n); }
    return tmp.subarray(0, n);
  }

  static decodeLifetimeProjectionPoint(buf) {
    const r = {};
    let o = 0;
    while (o < buf.length) {
      const tag = this.decodeVarint(buf, o); o += tag.length;
      const field = Number(tag.value >> 3n);
      const wire = Number(tag.value & 7n);
      switch (field) {
        case 1: { const v = this.decodeVarint(buf, o); r.timestamp_ns = v.value.toString(); o += v.length; break; }
        case 2: { const v = this.decodeDouble(buf, o); r.years_from_now = v.value; o += v.length; break; }
        case 3: { const v = this.decodeDouble(buf, o); r.pu238_thermal_power_w = v.value; o += v.length; break; }
        case 4: { const v = this.decodeDouble(buf, o); r.pu238_mass_remaining_g = v.value; o += v.length; break; }
        case 5: { const v = this.decodeDouble(buf, o); r.hot_side_temp_c = v.value; o += v.length; break; }
        case 6: { const v = this.decodeDouble(buf, o); r.cold_side_temp_c = v.value; o += v.length; break; }
        case 7: { const v = this.decodeDouble(buf, o); r.thermocouple_voltage_mv = v.value; o += v.length; break; }
        case 8: { const v = this.decodeDouble(buf, o); r.efficiency_percent = v.value; o += v.length; break; }
        case 9: { const v = this.decodeDouble(buf, o); r.electrical_power_w = v.value; o += v.length; break; }
        case 10: { const v = this.decodeDouble(buf, o); r.max_payload_power_w = v.value; o += v.length; break; }
        case 11: { const v = this.decodeDouble(buf, o); r.decay_ratio = v.value; o += v.length; break; }
        case 12: { const v = this.decodeDouble(buf, o); r.confidence_lower = v.value; o += v.length; break; }
        case 13: { const v = this.decodeDouble(buf, o); r.confidence_upper = v.value; o += v.length; break; }
        case 14: { const v = this.decodeVarint(buf, o); r.health_status = ['PROJECTION_NOMINAL','PROJECTION_WARNING','PROJECTION_CRITICAL','PROJECTION_END_OF_LIFE'][Number(v.value)] ?? 'PROJECTION_NOMINAL'; o += v.length; break; }
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

  static encodeLifetimeInverseRequest(p) {
    const tmp = new Uint8Array(256);
    let n = 0;
    if (p.device_id != null) { n += this.encodeTag(1, 2, tmp, n); n += this.encodeString(p.device_id, tmp, n); }
    if (p.target_years_from_now != null) { n += this.encodeTag(2, 1, tmp, n); n += this.encodeDouble(p.target_years_from_now, tmp, n); }
    return tmp.subarray(0, n);
  }

  static decodeLifetimeInverseResult(buf) {
    const r = { operational_notes: [] };
    let o = 0;
    while (o < buf.length) {
      const tag = this.decodeVarint(buf, o); o += tag.length;
      const field = Number(tag.value >> 3n);
      const wire = Number(tag.value & 7n);
      switch (field) {
        case 1: { const v = this.decodeVarint(buf, o); r.target_timestamp_ns = v.value.toString(); o += v.length; break; }
        case 2: { const v = this.decodeDouble(buf, o); r.years_from_now = v.value; o += v.length; break; }
        case 3: { const v = this.decodeDouble(buf, o); r.pu238_thermal_power_w = v.value; o += v.length; break; }
        case 4: { const v = this.decodeDouble(buf, o); r.power_decay_percent = v.value; o += v.length; break; }
        case 5: { const v = this.decodeDouble(buf, o); r.hot_side_temp_c = v.value; o += v.length; break; }
        case 6: { const v = this.decodeDouble(buf, o); r.hot_side_temp_drop_c = v.value; o += v.length; break; }
        case 7: { const v = this.decodeDouble(buf, o); r.cold_side_temp_c = v.value; o += v.length; break; }
        case 8: { const v = this.decodeDouble(buf, o); r.thermocouple_voltage_mv = v.value; o += v.length; break; }
        case 9: { const v = this.decodeDouble(buf, o); r.efficiency_percent = v.value; o += v.length; break; }
        case 10: { const v = this.decodeDouble(buf, o); r.electrical_power_w = v.value; o += v.length; break; }
        case 11: { const v = this.decodeDouble(buf, o); r.max_payload_power_w = v.value; o += v.length; break; }
        case 12: { const v = this.decodeDouble(buf, o); r.remaining_half_lives = v.value; o += v.length; break; }
        case 13: { const v = this.decodeDouble(buf, o); r.pu238_mass_remaining_g = v.value; o += v.length; break; }
        case 14: { const v = this.decodeDouble(buf, o); r.pu238_mass_consumed_g = v.value; o += v.length; break; }
        case 15: { const v = this.decodeVarint(buf, o); r.health_status = ['PROJECTION_NOMINAL','PROJECTION_WARNING','PROJECTION_CRITICAL','PROJECTION_END_OF_LIFE'][Number(v.value)] ?? 'PROJECTION_NOMINAL'; o += v.length; break; }
        case 16: { const v = this.decodeString(buf, o); r.operational_notes.push(v.value); o += v.length; break; }
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
}
