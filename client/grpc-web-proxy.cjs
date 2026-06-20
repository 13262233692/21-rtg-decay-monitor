const http = require('http');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const path = require('path');

const PROTO_PATH = path.join(__dirname, '..', 'proto', 'rtg.proto');
const PROXY_PORT = 8081;
const GRPC_TARGET = 'localhost:50051';

const packageDef = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true, longs: String, enums: String, defaults: true, oneofs: true
});
const rtgProto = grpc.loadPackageDefinition(packageDef).rtgmonitor;
const grpcClient = new rtgProto.RTGMonitorService(GRPC_TARGET, grpc.credentials.createInsecure());

class ProtobufHandCodec {
  static encodeDouble(v, buf, offset) { buf.writeDoubleBE(v, offset); return 8; }
  static encodeFloat(v, buf, offset) { buf.writeFloatBE(v, offset); return 4; }
  static encodeInt32(v, buf, offset) {
    v = v | 0; let n = 0;
    if (v < 0) { for (let i = 0; i < 10; i++) { let b = (v >>> 7) | (i < 9 ? 0x80 : 0); if (i === 9) b = (v >> 25) & 0xFF; buf[offset + n++] = (v & 0x7F) | (i < 9 && (v >>>= 7) ? 0x80 : 0); if (!v) break; } }
    else do { let b = v & 0x7F; v >>>= 7; if (v) b |= 0x80; buf[offset + n++] = b; } while (v);
    return n;
  }
  static encodeUInt64Str(s, buf, offset) {
    let n = 0; let v = BigInt(s);
    do { let b = Number(v & 0x7Fn); v >>= 7n; if (v) b |= 0x80; buf[offset + n++] = b; } while (v);
    return n;
  }
  static encodeTag(field, wire, buf, offset) {
    return this.encodeInt32((field << 3) | wire, buf, offset);
  }
  static encodeString(s, buf, offset) {
    const sBuf = Buffer.from(s, 'utf8');
    const l = this.encodeInt32(sBuf.length, buf, offset);
    sBuf.copy(buf, offset + l);
    return l + sBuf.length;
  }

  static decodeVarint(buf, offset) { let r = 0n, s = 0n, i = 0; do { if (i === 10) throw new Error('malformed varint'); const b = buf[offset + i++]; r |= BigInt(b & 0x7F) << s; s += 7n; if ((b & 0x80) === 0) break; } while (true); return { value: r, length: i }; }
  static decodeDouble(buf, offset) { return { value: buf.readDoubleBE(offset), length: 8 }; }
  static decodeFloat(buf, offset) { return { value: buf.readFloatBE(offset), length: 4 }; }
  static decodeLength(buf, offset) { const vi = this.decodeVarint(buf, offset); return { value: Number(vi.value), length: vi.length }; }
  static decodeString(buf, offset) { const len = this.decodeLength(buf, offset); const s = buf.toString('utf8', offset + len.length, offset + len.length + len.value); return { value: s, length: len.length + len.value }; }
  static decodeFixed32(buf, offset) { return { value: buf.readUInt32BE(offset), length: 4 }; }

  static encodeRTGDataPoint(p) {
    const tmp = Buffer.alloc(4096);
    let n = 0;
    if (p.timestamp_ns != null) { n += this.encodeTag(1, 0, tmp, n); n += this.encodeUInt64Str(p.timestamp_ns, tmp, n); }
    if (p.device_id != null) { n += this.encodeTag(2, 2, tmp, n); n += this.encodeString(p.device_id, tmp, n); }
    if (p.hot_side_temp_c != null) { n += this.encodeTag(3, 1, tmp, n); n += this.encodeDouble(p.hot_side_temp_c, tmp, n); }
    if (p.cold_side_temp_c != null) { n += this.encodeTag(4, 1, tmp, n); n += this.encodeDouble(p.cold_side_temp_c, tmp, n); }
    if (p.thermocouple_voltage_mv != null) { n += this.encodeTag(5, 1, tmp, n); n += this.encodeDouble(p.thermocouple_voltage_mv, tmp, n); }
    if (p.pu238_thermal_power_w != null) { n += this.encodeTag(6, 1, tmp, n); n += this.encodeDouble(p.pu238_thermal_power_w, tmp, n); }
    if (p.system_voltage_v != null) { n += this.encodeTag(7, 1, tmp, n); n += this.encodeDouble(p.system_voltage_v, tmp, n); }
    if (p.system_current_a != null) { n += this.encodeTag(8, 1, tmp, n); n += this.encodeDouble(p.system_current_a, tmp, n); }
    if (p.heat_sink_temp_c != null) { n += this.encodeTag(9, 1, tmp, n); n += this.encodeDouble(p.heat_sink_temp_c, tmp, n); }
    if (p.health != null) { const enumMap = { HEALTH_UNKNOWN: 0, HEALTH_NOMINAL: 1, HEALTH_WARNING: 2, HEALTH_CRITICAL: 3, HEALTH_FAULT: 4 }; const v = typeof p.health === 'string' ? (enumMap[p.health] ?? 0) : Number(p.health); n += this.encodeTag(10, 0, tmp, n); n += this.encodeInt32(v, tmp, n); }
    if (p.sequence != null) { n += this.encodeTag(11, 0, tmp, n); n += this.encodeInt32(p.sequence, tmp, n); }
    return tmp.subarray(0, n);
  }

  static decodeRTGDataPoint(buf) {
    const r = {}; let o = 0;
    while (o < buf.length) {
      const tag = this.decodeVarint(buf, o); o += tag.length;
      const field = Number(tag.value >> 3n); const wire = Number(tag.value & 7n);
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
        default: if (wire === 0) { const v = this.decodeVarint(buf, o); o += v.length; } else if (wire === 2) { const l = this.decodeLength(buf, o); o += l.length + l.value; } else if (wire === 1) { o += 8; } else if (wire === 5) { o += 4; } else { o = buf.length; }
      }
    }
    return r;
  }

  static decodeThermocoupleSample(buf) {
    const r = {}; let o = 0;
    while (o < buf.length) {
      const tag = this.decodeVarint(buf, o); o += tag.length;
      const field = Number(tag.value >> 3n); const wire = Number(tag.value & 7n);
      switch (field) {
        case 1: { const v = this.decodeVarint(buf, o); r.timestamp_ns = v.value.toString(); o += v.length; break; }
        case 2: { const v = this.decodeDouble(buf, o); r.voltage_mv = v.value; o += v.length; break; }
        case 3: { const v = this.decodeVarint(buf, o); r.sequence = Number(v.value); o += v.length; break; }
        default: if (wire === 0) { const v = this.decodeVarint(buf, o); o += v.length; } else if (wire === 2) { const l = this.decodeLength(buf, o); o += l.length + l.value; } else if (wire === 1) { o += 8; } else if (wire === 5) { o += 4; } else { o = buf.length; }
      }
    }
    return r;
  }

  static encodeStreamRequest(p) {
    const tmp = Buffer.alloc(512); let n = 0;
    if (p.device_id != null) { n += this.encodeTag(1, 2, tmp, n); n += this.encodeString(p.device_id, tmp, n); }
    if (p.sample_rate_hz != null) { n += this.encodeTag(2, 0, tmp, n); n += this.encodeInt32(p.sample_rate_hz, tmp, n); }
    return tmp.subarray(0, n);
  }

  static decodeRTGSnapshot(buf) {
    const r = { alerts: [] }; let o = 0;
    while (o < buf.length) {
      const tag = this.decodeVarint(buf, o); o += tag.length;
      const field = Number(tag.value >> 3n); const wire = Number(tag.value & 7n);
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
        case 12: { const l = this.decodeLength(buf, o); o += l.length;
          const abuf = buf.subarray(o, o + l.value); o += l.value;
          const al = {}; let ao = 0;
          while (ao < abuf.length) {
            const at = this.decodeVarint(abuf, ao); ao += at.length;
            const af = Number(at.value >> 3n); const aw = Number(at.value & 7n);
            if (af === 1) { const v = this.decodeVarint(abuf, ao); al.timestamp_ns = v.value.toString(); ao += v.length; }
            else if (af === 2) { const v = this.decodeString(abuf, ao); al.code = v.value; ao += v.length; }
            else if (af === 3) { const v = this.decodeString(abuf, ao); al.message = v.value; ao += v.length; }
            else if (af === 4) { const v = this.decodeVarint(abuf, ao); al.level = Number(v.value); ao += v.length; }
            else { if (aw === 0) { const v = this.decodeVarint(abuf, ao); ao += v.length; } else if (aw === 2) { const ll = this.decodeLength(abuf, ao); ao += ll.length + ll.value; } else if (aw === 1) ao += 8; else if (aw === 5) ao += 4; else ao = abuf.length; }
          }
          r.alerts.push(al);
          break; }
        default: if (wire === 0) { const v = this.decodeVarint(buf, o); o += v.length; } else if (wire === 2) { const l = this.decodeLength(buf, o); o += l.length + l.value; } else if (wire === 1) { o += 8; } else if (wire === 5) { o += 4; } else { o = buf.length; }
      }
    }
    return r;
  }

  static encodeSnapshotRequest(p) {
    const tmp = Buffer.alloc(512); let n = 0;
    if (p.device_id != null) { n += this.encodeTag(1, 2, tmp, n); n += this.encodeString(p.device_id, tmp, n); }
    return tmp.subarray(0, n);
  }

  static readGrpcWebFrame(chunks) {
    const data = Buffer.concat(chunks);
    if (data.length < 5) return { frame: null, rest: data };
    const flags = data[0];
    const len = data.readUInt32BE(1);
    if (data.length < 5 + len) return { frame: null, rest: data };
    const payload = data.subarray(5, 5 + len);
    return { frame: { flags, payload }, rest: data.subarray(5 + len) };
  }

  static writeGrpcWebFrame(payload, flags = 0) {
    const header = Buffer.alloc(5);
    header[0] = flags;
    header.writeUInt32BE(payload.length, 1);
    return Buffer.concat([header, payload]);
  }

  static writeGrpcWebTrailers(statusCode, statusText) {
    const trailers = `grpc-status:${statusCode}\r\ngrpc-message:${statusText}\r\n`;
    const tBuf = Buffer.from(trailers, 'ascii');
    const header = Buffer.alloc(5);
    header[0] = 0x80;
    header.writeUInt32BE(tBuf.length, 1);
    return Buffer.concat([header, tBuf]);
  }
}

function handleUnary(methodPath, reqBuf) {
  return new Promise((resolve, reject) => {
    let reqMsg;
    if (methodPath.endsWith('GetRTGSnapshot')) {
      let o = 0; const m = {};
      while (o < reqBuf.length) {
        const tag = ProtobufHandCodec.decodeVarint(reqBuf, o); o += tag.length;
        const field = Number(tag.value >> 3n); const wire = Number(tag.value & 7n);
        if (field === 1 && wire === 2) { const v = ProtobufHandCodec.decodeString(reqBuf, o); m.device_id = v.value; o += v.length; }
        else { if (wire === 0) { const v = ProtobufHandCodec.decodeVarint(reqBuf, o); o += v.length; } else if (wire === 2) { const l = ProtobufHandCodec.decodeLength(reqBuf, o); o += l.length + l.value; } else if (wire === 1) o += 8; else if (wire === 5) o += 4; else o = reqBuf.length; }
      }
      reqMsg = m;
    } else {
      reqMsg = {};
    }

    const grpcMethod = methodPath.split('/').pop();
    grpcClient[grpcMethod](reqMsg, (err, resp) => {
      if (err) return reject(err);
      let outBuf;
      if (grpcMethod === 'GetRTGSnapshot') {
        outBuf = Buffer.alloc(8192); let n = 0;
        const tmp = outBuf;
        if (resp.timestamp_ns != null) { n += ProtobufHandCodec.encodeTag(1, 0, tmp, n); n += ProtobufHandCodec.encodeUInt64Str(String(resp.timestamp_ns), tmp, n); }
        if (resp.device_id != null) { n += ProtobufHandCodec.encodeTag(2, 2, tmp, n); n += ProtobufHandCodec.encodeString(resp.device_id, tmp, n); }
        if (resp.hot_side_temp_c != null) { n += ProtobufHandCodec.encodeTag(3, 1, tmp, n); n += ProtobufHandCodec.encodeDouble(resp.hot_side_temp_c, tmp, n); }
        if (resp.cold_side_temp_c != null) { n += ProtobufHandCodec.encodeTag(4, 1, tmp, n); n += ProtobufHandCodec.encodeDouble(resp.cold_side_temp_c, tmp, n); }
        if (resp.thermocouple_voltage_mv != null) { n += ProtobufHandCodec.encodeTag(5, 1, tmp, n); n += ProtobufHandCodec.encodeDouble(resp.thermocouple_voltage_mv, tmp, n); }
        if (resp.pu238_thermal_power_w != null) { n += ProtobufHandCodec.encodeTag(6, 1, tmp, n); n += ProtobufHandCodec.encodeDouble(resp.pu238_thermal_power_w, tmp, n); }
        if (resp.pu238_mass_g != null) { n += ProtobufHandCodec.encodeTag(7, 1, tmp, n); n += ProtobufHandCodec.encodeDouble(resp.pu238_mass_g, tmp, n); }
        if (resp.half_life_years != null) { n += ProtobufHandCodec.encodeTag(8, 1, tmp, n); n += ProtobufHandCodec.encodeDouble(resp.half_life_years, tmp, n); }
        if (resp.efficiency_percent != null) { n += ProtobufHandCodec.encodeTag(9, 1, tmp, n); n += ProtobufHandCodec.encodeDouble(resp.efficiency_percent, tmp, n); }
        if (resp.uptime_hours != null) { n += ProtobufHandCodec.encodeTag(10, 1, tmp, n); n += ProtobufHandCodec.encodeDouble(resp.uptime_hours, tmp, n); }
        if (resp.health != null) { const enumMap = { HEALTH_UNKNOWN: 0, HEALTH_NOMINAL: 1, HEALTH_WARNING: 2, HEALTH_CRITICAL: 3, HEALTH_FAULT: 4 }; const v = typeof resp.health === 'string' ? (enumMap[resp.health] ?? 0) : Number(resp.health); n += ProtobufHandCodec.encodeTag(11, 0, tmp, n); n += ProtobufHandCodec.encodeInt32(v, tmp, n); }
        outBuf = outBuf.subarray(0, n);
      } else {
        outBuf = Buffer.alloc(0);
      }
      resolve(outBuf);
    });
  });
}

function handleServerStream(methodPath, reqBuf, onMessage, onEnd) {
  let reqMsg;
  let o = 0; const m = {};
  while (o < reqBuf.length) {
    const tag = ProtobufHandCodec.decodeVarint(reqBuf, o); o += tag.length;
    const field = Number(tag.value >> 3n); const wire = Number(tag.value & 7n);
    if (field === 1 && wire === 2) { const v = ProtobufHandCodec.decodeString(reqBuf, o); m.device_id = v.value; o += v.length; }
    else if (field === 2 && wire === 0) { const v = ProtobufHandCodec.decodeVarint(reqBuf, o); m.sample_rate_hz = Number(v.value); o += v.length; }
    else { if (wire === 0) { const v = ProtobufHandCodec.decodeVarint(reqBuf, o); o += v.length; } else if (wire === 2) { const l = ProtobufHandCodec.decodeLength(reqBuf, o); o += l.length + l.value; } else if (wire === 1) o += 8; else if (wire === 5) o += 4; else o = reqBuf.length; }
  }
  reqMsg = m;
  const grpcMethod = methodPath.split('/').pop();
  const call = grpcClient[grpcMethod](reqMsg);
  call.on('data', (resp) => {
    let outBuf;
    if (grpcMethod === 'StreamRTGData') {
      outBuf = Buffer.alloc(8192); let n = 0; const tmp = outBuf;
      if (resp.timestamp_ns != null) { n += ProtobufHandCodec.encodeTag(1, 0, tmp, n); n += ProtobufHandCodec.encodeUInt64Str(String(resp.timestamp_ns), tmp, n); }
      if (resp.device_id != null) { n += ProtobufHandCodec.encodeTag(2, 2, tmp, n); n += ProtobufHandCodec.encodeString(resp.device_id, tmp, n); }
      if (resp.hot_side_temp_c != null) { n += ProtobufHandCodec.encodeTag(3, 1, tmp, n); n += ProtobufHandCodec.encodeDouble(resp.hot_side_temp_c, tmp, n); }
      if (resp.cold_side_temp_c != null) { n += ProtobufHandCodec.encodeTag(4, 1, tmp, n); n += ProtobufHandCodec.encodeDouble(resp.cold_side_temp_c, tmp, n); }
      if (resp.thermocouple_voltage_mv != null) { n += ProtobufHandCodec.encodeTag(5, 1, tmp, n); n += ProtobufHandCodec.encodeDouble(resp.thermocouple_voltage_mv, tmp, n); }
      if (resp.pu238_thermal_power_w != null) { n += ProtobufHandCodec.encodeTag(6, 1, tmp, n); n += ProtobufHandCodec.encodeDouble(resp.pu238_thermal_power_w, tmp, n); }
      if (resp.system_voltage_v != null) { n += ProtobufHandCodec.encodeTag(7, 1, tmp, n); n += ProtobufHandCodec.encodeDouble(resp.system_voltage_v, tmp, n); }
      if (resp.system_current_a != null) { n += ProtobufHandCodec.encodeTag(8, 1, tmp, n); n += ProtobufHandCodec.encodeDouble(resp.system_current_a, tmp, n); }
      if (resp.heat_sink_temp_c != null) { n += ProtobufHandCodec.encodeTag(9, 1, tmp, n); n += ProtobufHandCodec.encodeDouble(resp.heat_sink_temp_c, tmp, n); }
      if (resp.health != null) { const enumMap = { HEALTH_UNKNOWN: 0, HEALTH_NOMINAL: 1, HEALTH_WARNING: 2, HEALTH_CRITICAL: 3, HEALTH_FAULT: 4 }; const v = typeof resp.health === 'string' ? (enumMap[resp.health] ?? 0) : Number(resp.health); n += ProtobufHandCodec.encodeTag(10, 0, tmp, n); n += ProtobufHandCodec.encodeInt32(v, tmp, n); }
      if (resp.sequence != null) { n += ProtobufHandCodec.encodeTag(11, 0, tmp, n); n += ProtobufHandCodec.encodeInt32(resp.sequence, tmp, n); }
      outBuf = outBuf.subarray(0, n);
    } else if (grpcMethod === 'StreamThermocoupleWave') {
      outBuf = Buffer.alloc(64); let n = 0; const tmp = outBuf;
      if (resp.timestamp_ns != null) { n += ProtobufHandCodec.encodeTag(1, 0, tmp, n); n += ProtobufHandCodec.encodeUInt64Str(String(resp.timestamp_ns), tmp, n); }
      if (resp.voltage_mv != null) { n += ProtobufHandCodec.encodeTag(2, 1, tmp, n); n += ProtobufHandCodec.encodeDouble(resp.voltage_mv, tmp, n); }
      if (resp.sequence != null) { n += ProtobufHandCodec.encodeTag(3, 0, tmp, n); n += ProtobufHandCodec.encodeInt32(resp.sequence, tmp, n); }
      outBuf = outBuf.subarray(0, n);
    } else {
      outBuf = Buffer.alloc(0);
    }
    onMessage(outBuf);
  });
  call.on('end', () => onEnd(null));
  call.on('error', (e) => onEnd(e));
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-grpc-web, x-user-agent');
  res.setHeader('Access-Control-Expose-Headers', 'grpc-status, grpc-message');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const contentType = req.headers['content-type'] || '';
  const isText = contentType.includes('application/grpc-web-text');
  const isServerStream = req.url.includes('Stream');

  const chunks = [];
  req.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
  req.on('end', async () => {
    try {
      let raw = Buffer.concat(chunks);
      if (isText) raw = Buffer.from(raw.toString('ascii'), 'base64');

      const { frame } = ProtobufHandCodec.readGrpcWebFrame([raw]);
      const reqBuf = frame?.payload ?? Buffer.alloc(0);

      res.writeHead(200, {
        'Content-Type': isText ? 'application/grpc-web-text+proto' : 'application/grpc-web+proto',
        'Transfer-Encoding': 'chunked',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });

      if (isServerStream) {
        handleServerStream(req.url, reqBuf,
          (msgBuf) => {
            const frame = ProtobufHandCodec.writeGrpcWebFrame(msgBuf, 0);
            const out = isText ? Buffer.from(frame.toString('base64'), 'ascii') : frame;
            res.write(out);
          },
          (err) => {
            const code = err?.code ?? 0;
            const msg = err?.details ?? 'OK';
            const trailer = ProtobufHandCodec.writeGrpcWebTrailers(code, encodeURIComponent(msg));
            const out = isText ? Buffer.from(trailer.toString('base64'), 'ascii') : trailer;
            res.end(out);
          }
        );
      } else {
        try {
          const respBuf = await handleUnary(req.url, reqBuf);
          const frame = ProtobufHandCodec.writeGrpcWebFrame(respBuf, 0);
          res.write(isText ? Buffer.from(frame.toString('base64'), 'ascii') : frame);
          const trailer = ProtobufHandCodec.writeGrpcWebTrailers(0, 'OK');
          res.end(isText ? Buffer.from(trailer.toString('base64'), 'ascii') : trailer);
        } catch (e) {
          const trailer = ProtobufHandCodec.writeGrpcWebTrailers(e?.code ?? 2, encodeURIComponent(e?.message ?? 'Internal'));
          res.end(isText ? Buffer.from(trailer.toString('base64'), 'ascii') : trailer);
        }
      }
    } catch (e) {
      console.error('[PROXY]', e);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
});

server.listen(PROXY_PORT, () => {
  console.log(`[PROXY] gRPC-Web proxy running on :${PROXY_PORT} -> ${GRPC_TARGET}`);
});

module.exports = { ProtobufHandCodec };
