const http = require('http');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const path = require('path');
const { EventEmitter } = require('events');

const PROTO_PATH = path.join(__dirname, '..', 'proto', 'rtg.proto');
const PROXY_PORT = 8081;
const GRPC_TARGET = 'localhost:50051';
const MAX_MESSAGE_SIZE = 64 * 1024 * 1024;
const MAX_FRAME_SIZE = 8 * 1024 * 1024;
const MAX_CONCURRENT_CONNECTIONS = 128;
const PER_CONNECTION_BUFFER_LIMIT = 16 * 1024 * 1024;
const HIGH_WATER_MARK = 4 * 1024 * 1024;
const LOW_WATER_MARK = 1 * 1024 * 1024;

const packageDef = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true, longs: String, enums: String, defaults: true, oneofs: true
});
const rtgProto = grpc.loadPackageDefinition(packageDef).rtgmonitor;

const grpcOptions = {
  'grpc.max_receive_message_length': MAX_MESSAGE_SIZE,
  'grpc.max_send_message_length': MAX_MESSAGE_SIZE,
  'grpc.http2.max_pings_without_data': 0,
  'grpc.keepalive_time_ms': 30000,
  'grpc.keepalive_timeout_ms': 5000
};

class StreamBackpressureController extends EventEmitter {
  constructor(maxBufferSize = PER_CONNECTION_BUFFER_LIMIT) {
    super();
    this.buffer = Buffer.alloc(0);
    this.maxBufferSize = maxBufferSize;
    this.paused = false;
    this.writable = true;
    this.totalBytes = 0;
    this.frameCount = 0;
    this.droppedFrames = 0;
    this.highWaterMark = HIGH_WATER_MARK;
    this.lowWaterMark = LOW_WATER_MARK;
  }

  push(chunk) {
    this.totalBytes += chunk.length;
    this.frameCount++;
    if (this.buffer.length + chunk.length > this.maxBufferSize) {
      this.droppedFrames++;
      console.warn(`[PROXY] Buffer overflow (${this.buffer.length} bytes), dropping frame. Total dropped: ${this.droppedFrames}`);
      return false;
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > this.highWaterMark && !this.paused) {
      this.paused = true;
      this.emit('pause');
    }
    return true;
  }

  readAll() {
    if (this.buffer.length === 0) return Buffer.alloc(0);
    const data = this.buffer;
    this.buffer = Buffer.alloc(0);
    if (this.paused && this.buffer.length < this.lowWaterMark) {
      this.paused = false;
      this.emit('resume');
    }
    return data;
  }

  hasFrames() {
    if (this.buffer.length < 5) return false;
    const len = this.buffer.readUInt32BE(1);
    return this.buffer.length >= 5 + len;
  }

  getStats() {
    return {
      bufferSize: this.buffer.length,
      totalBytes: this.totalBytes,
      frameCount: this.frameCount,
      droppedFrames: this.droppedFrames,
      paused: this.paused
    };
  }
}

class ConnectionManager {
  constructor(maxConnections = MAX_CONCURRENT_CONNECTIONS) {
    this.maxConnections = maxConnections;
    this.connections = new Map();
    this.rejectionCount = 0;
  }

  accept(connId, controller) {
    if (this.connections.size >= this.maxConnections) {
      this.rejectionCount++;
      return { allowed: false, reason: 'PROXY_CONNECTION_LIMIT', backoff: 10000 + Math.random() * 20000 };
    }
    if (this.connections.has(connId)) {
      return { allowed: false, reason: 'DUPLICATE_CONNECTION', backoff: 5000 + Math.random() * 5000 };
    }
    this.connections.set(connId, {
      controller,
      startTime: Date.now(),
      lastActivity: Date.now()
    });
    return { allowed: true };
  }

  touch(connId) {
    const c = this.connections.get(connId);
    if (c) c.lastActivity = Date.now();
  }

  release(connId) {
    this.connections.delete(connId);
  }

  getStats() {
    return {
      activeConnections: this.connections.size,
      maxConnections: this.maxConnections,
      rejections: this.rejectionCount
    };
  }
}

const connManager = new ConnectionManager();

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

  static encodeBytes(b, buf, offset) {
    const l = this.encodeInt32(b.length, buf, offset);
    b.copy(buf, offset + l);
    return l + b.length;
  }

  static encodeHistoricalChunk(c) {
    const tmp = Buffer.alloc(16 * 1024 * 1024);
    let n = 0;
    if (c.session_id != null) { n += this.encodeTag(1, 0, tmp, n); n += this.encodeUInt64Str(c.session_id, tmp, n); }
    if (c.chunk_index != null) { n += this.encodeTag(2, 0, tmp, n); n += this.encodeInt32(c.chunk_index, tmp, n); }
    if (c.total_chunks != null) { n += this.encodeTag(3, 0, tmp, n); n += this.encodeInt32(c.total_chunks, tmp, n); }
    if (c.payload_bytes != null) { n += this.encodeTag(4, 0, tmp, n); n += this.encodeInt32(c.payload_bytes, tmp, n); }
    if (c.crc32 != null) { n += this.encodeTag(5, 0, tmp, n); n += this.encodeInt32(c.crc32, tmp, n); }
    if (c.start_timestamp_ns != null) { n += this.encodeTag(6, 0, tmp, n); n += this.encodeUInt64Str(c.start_timestamp_ns, tmp, n); }
    if (c.end_timestamp_ns != null) { n += this.encodeTag(7, 0, tmp, n); n += this.encodeUInt64Str(c.end_timestamp_ns, tmp, n); }
    if (c.sample_count != null) { n += this.encodeTag(8, 0, tmp, n); n += this.encodeInt32(c.sample_count, tmp, n); }
    if (c.payload != null) { n += this.encodeTag(9, 2, tmp, n); n += this.encodeBytes(c.payload, tmp, n); }
    if (c.chunk_type != null) {
      const enumMap = { CHUNK_DATA: 0, CHUNK_METADATA: 1, CHUNK_HEARTBEAT: 2, CHUNK_FINAL: 3, CHUNK_ERROR: 4, CHUNK_REJECT: 5 };
      const v = typeof c.chunk_type === 'string' ? (enumMap[c.chunk_type] ?? 0) : Number(c.chunk_type);
      n += this.encodeTag(10, 0, tmp, n); n += this.encodeInt32(v, tmp, n);
    }
    if (c.error_message != null) { n += this.encodeTag(12, 2, tmp, n); n += this.encodeString(c.error_message, tmp, n); }
    return tmp.subarray(0, n);
  }

  static decodeHistoricalChunk(buf) {
    const r = { status: [] }; let o = 0;
    while (o < buf.length) {
      const tag = this.decodeVarint(buf, o); o += tag.length;
      const field = Number(tag.value >> 3n); const wire = Number(tag.value & 7n);
      switch (field) {
        case 1: { const v = this.decodeVarint(buf, o); r.session_id = v.value.toString(); o += v.length; break; }
        case 2: { const v = this.decodeVarint(buf, o); r.chunk_index = Number(v.value); o += v.length; break; }
        case 3: { const v = this.decodeVarint(buf, o); r.total_chunks = Number(v.value); o += v.length; break; }
        case 4: { const v = this.decodeVarint(buf, o); r.payload_bytes = Number(v.value); o += v.length; break; }
        case 5: { const v = this.decodeVarint(buf, o); r.crc32 = Number(v.value); o += v.length; break; }
        case 6: { const v = this.decodeVarint(buf, o); r.start_timestamp_ns = v.value.toString(); o += v.length; break; }
        case 7: { const v = this.decodeVarint(buf, o); r.end_timestamp_ns = v.value.toString(); o += v.length; break; }
        case 8: { const v = this.decodeVarint(buf, o); r.sample_count = Number(v.value); o += v.length; break; }
        case 9: { const l = this.decodeLength(buf, o); o += l.length; r.payload = buf.subarray(o, o + l.value); o += l.value; break; }
        case 10: { const v = this.decodeVarint(buf, o); r.chunk_type = ['CHUNK_DATA','CHUNK_METADATA','CHUNK_HEARTBEAT','CHUNK_FINAL','CHUNK_ERROR','CHUNK_REJECT'][Number(v.value)] ?? 'CHUNK_DATA'; o += v.length; break; }
        case 12: { const v = this.decodeString(buf, o); r.error_message = v.value; o += v.length; break; }
        default: if (wire === 0) { const v = this.decodeVarint(buf, o); o += v.length; } else if (wire === 2) { const l = this.decodeLength(buf, o); o += l.length + l.value; } else if (wire === 1) o += 8; else if (wire === 5) o += 4; else o = buf.length;
      }
    }
    return r;
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
        default: if (wire === 0) { const v = this.decodeVarint(buf, o); o += v.length; } else if (wire === 2) { const l = this.decodeLength(buf, o); o += l.length + l.value; } else if (wire === 1) o += 8; else if (wire === 5) o += 4; else o = buf.length;
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
        default: if (wire === 0) { const v = this.decodeVarint(buf, o); o += v.length; } else if (wire === 2) { const l = this.decodeLength(buf, o); o += l.length + l.value; } else if (wire === 1) o += 8; else if (wire === 5) o += 4; else o = buf.length;
      }
    }
    return r;
  }

  static decodeHistoricalRequest(buf) {
    const r = { include_thermocouple: true, include_power: true }; let o = 0;
    while (o < buf.length) {
      const tag = this.decodeVarint(buf, o); o += tag.length;
      const field = Number(tag.value >> 3n); const wire = Number(tag.value & 7n);
      switch (field) {
        case 1: { const v = this.decodeString(buf, o); r.device_id = v.value; o += v.length; break; }
        case 2: { const v = this.decodeVarint(buf, o); r.start_timestamp_ns = v.value.toString(); o += v.length; break; }
        case 3: { const v = this.decodeVarint(buf, o); r.end_timestamp_ns = v.value.toString(); o += v.length; break; }
        case 4: { const v = this.decodeVarint(buf, o); r.chunk_size_bytes = Number(v.value); o += v.length; break; }
        case 5: { const v = this.decodeVarint(buf, o); r.sample_rate_hz = Number(v.value); o += v.length; break; }
        case 6: { const v = this.decodeVarint(buf, o); r.include_thermocouple = Number(v.value) !== 0; o += v.length; break; }
        case 7: { const v = this.decodeVarint(buf, o); r.include_power = Number(v.value) !== 0; o += v.length; break; }
        case 8: { const v = this.decodeVarint(buf, o); r.compressed = Number(v.value) !== 0; o += v.length; break; }
        default: if (wire === 0) { const v = this.decodeVarint(buf, o); o += v.length; } else if (wire === 2) { const l = this.decodeLength(buf, o); o += l.length + l.value; } else if (wire === 1) o += 8; else if (wire === 5) o += 4; else o = buf.length;
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

  static decodeSnapshotRequest(buf) {
    let o = 0; const m = {};
    while (o < buf.length) {
      const tag = this.decodeVarint(buf, o); o += tag.length;
      const field = Number(tag.value >> 3n); const wire = Number(tag.value & 7n);
      if (field === 1 && wire === 2) { const v = this.decodeString(buf, o); m.device_id = v.value; o += v.length; }
      else { if (wire === 0) { const v = this.decodeVarint(buf, o); o += v.length; } else if (wire === 2) { const l = this.decodeLength(buf, o); o += l.length + l.value; } else if (wire === 1) o += 8; else if (wire === 5) o += 4; else o = buf.length; }
    }
    return m;
  }

  static readGrpcWebFrame(chunks) {
    const data = Buffer.concat(chunks);
    if (data.length < 5) return { frame: null, rest: data };
    const flags = data[0];
    const len = data.readUInt32BE(1);
    if (len > MAX_FRAME_SIZE) {
      throw new Error(`Frame size ${len} exceeds maximum ${MAX_FRAME_SIZE}`);
    }
    if (data.length < 5 + len) return { frame: null, rest: data };
    const payload = data.subarray(5, 5 + len);
    return { frame: { flags, payload }, rest: data.subarray(5 + len) };
  }

  static writeGrpcWebFrame(payload, flags = 0) {
    if (payload.length > MAX_FRAME_SIZE) {
      throw new Error(`Payload ${payload.length} exceeds max frame size ${MAX_FRAME_SIZE}`);
    }
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

function decodeGrpcError(details) {
  const m = details.match(/backoff=(\d+)ms/);
  const backoff = m ? parseInt(m[1]) : 5000;
  return { code: 8, details, backoff };
}

function handleUnary(methodPath, reqBuf) {
  return new Promise((resolve, reject) => {
    let reqMsg;
    if (methodPath.endsWith('GetRTGSnapshot')) {
      reqMsg = ProtobufHandCodec.decodeSnapshotRequest(reqBuf);
    } else {
      reqMsg = {};
    }
    const grpcClient = new rtgProto.RTGMonitorService(GRPC_TARGET, grpc.credentials.createInsecure(), grpcOptions);
    const grpcMethod = methodPath.split('/').pop();
    grpcClient[grpcMethod](reqMsg, (err, resp) => {
      grpcClient.close();
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

function handleServerStream(methodPath, reqBuf, onMessage, onEnd, controller, connId) {
  let reqMsg;
  if (methodPath.endsWith('StreamHistoricalBurst')) {
    reqMsg = ProtobufHandCodec.decodeHistoricalRequest(reqBuf);
  } else {
    let o = 0; const m = {};
    while (o < reqBuf.length) {
      const tag = ProtobufHandCodec.decodeVarint(reqBuf, o); o += tag.length;
      const field = Number(tag.value >> 3n); const wire = Number(tag.value & 7n);
      if (field === 1 && wire === 2) { const v = ProtobufHandCodec.decodeString(reqBuf, o); m.device_id = v.value; o += v.length; }
      else if (field === 2 && wire === 0) { const v = ProtobufHandCodec.decodeVarint(reqBuf, o); m.sample_rate_hz = Number(v.value); o += v.length; }
      else { if (wire === 0) { const v = ProtobufHandCodec.decodeVarint(reqBuf, o); o += v.length; } else if (wire === 2) { const l = ProtobufHandCodec.decodeLength(reqBuf, o); o += l.length + l.value; } else if (wire === 1) o += 8; else if (wire === 5) o += 4; else o = reqBuf.length; }
    }
    reqMsg = m;
  }

  const grpcClient = new rtgProto.RTGMonitorService(GRPC_TARGET, grpc.credentials.createInsecure(), grpcOptions);
  const grpcMethod = methodPath.split('/').pop();
  const call = grpcClient[grpcMethod](reqMsg);

  let streamPaused = false;
  controller.on('pause', () => { streamPaused = true; call.pause && call.pause(); });
  controller.on('resume', () => { streamPaused = false; call.resume && call.resume(); });

  let msgCount = 0;

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
    } else if (grpcMethod === 'StreamHistoricalBurst') {
      outBuf = ProtobufHandCodec.encodeHistoricalChunk(resp);
    } else {
      outBuf = Buffer.alloc(0);
    }
    msgCount++;
    connManager.touch(connId);
    onMessage(outBuf);
  });

  call.on('end', () => {
    grpcClient.close();
    console.log(`[PROXY] Stream ${grpcMethod} ended, ${msgCount} msgs`);
    onEnd(null);
  });

  call.on('error', (e) => {
    grpcClient.close();
    console.log(`[PROXY] Stream ${grpcMethod} error: ${e.message}`);
    onEnd(e);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-grpc-web, x-user-agent, x-grpc-web-accept');
  res.setHeader('Access-Control-Expose-Headers', 'grpc-status, grpc-message');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const contentType = req.headers['content-type'] || '';
  const isText = contentType.includes('application/grpc-web-text');
  const isServerStream = req.url.includes('Stream');

  const connId = `${req.socket.remoteAddress}:${req.socket.remotePort}-${Date.now()}`;
  const controller = new StreamBackpressureController();
  const acceptResult = connManager.accept(connId, controller);

  if (!acceptResult.allowed) {
    res.writeHead(503, { 'Retry-After': Math.ceil(acceptResult.backoff / 1000).toString() });
    res.end(`${acceptResult.reason}; backoff=${Math.ceil(acceptResult.backoff)}ms`);
    console.log(`[PROXY] Rejected connection (${acceptResult.reason}): ${connId}`);
    return;
  }

  console.log(`[PROXY] Connection accepted: ${connId}, active=${connManager.getStats().activeConnections}`);

  const chunks = [];
  let contentLength = 0;
  let aborted = false;

  req.on('data', c => {
    contentLength += c.length;
    if (contentLength > MAX_MESSAGE_SIZE) {
      aborted = true;
      req.destroy();
      connManager.release(connId);
      if (!res.headersSent) res.writeHead(413);
      res.end('PAYLOAD_TOO_LARGE');
      return;
    }
    chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  });

  req.on('end', async () => {
    if (aborted) return;
    try {
      let raw = Buffer.concat(chunks);
      if (isText) raw = Buffer.from(raw.toString('ascii'), 'base64');

      const { frame } = ProtobufHandCodec.readGrpcWebFrame([raw]);
      const reqBuf = frame?.payload ?? Buffer.alloc(0);

      res.writeHead(200, {
        'Content-Type': isText ? 'application/grpc-web-text+proto' : 'application/grpc-web+proto',
        'Transfer-Encoding': 'chunked',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Cache-Control': 'no-cache'
      });

      let isPaused = false;

      function drainLoop() {
        while (controller.hasFrames() && !aborted) {
          const all = controller.readAll();
          let rest = all;
          while (rest.length >= 5) {
            try {
              const fr = ProtobufHandCodec.readGrpcWebFrame([rest]);
              if (!fr.frame) break;
              const out = isText ? Buffer.from(fr.frame.toString('base64'), 'ascii') : fr.frame;
              if (!res.write(out)) {
                isPaused = true;
                return;
              }
              rest = fr.rest;
            } catch (e) {
              console.warn(`[PROXY] Frame parse error: ${e.message}`);
              break;
            }
          }
        }
      }

      res.on('drain', () => {
        isPaused = false;
        drainLoop();
      });

      req.on('close', () => {
        aborted = true;
        connManager.release(connId);
        const stats = controller.getStats();
        console.log(`[PROXY] Connection ${connId} closed: ${JSON.stringify(stats)}`);
      });

      if (isServerStream) {
        handleServerStream(req.url, reqBuf,
          (msgBuf) => {
            if (aborted) return;
            try {
              const frame = ProtobufHandCodec.writeGrpcWebFrame(msgBuf, 0);
              const pushed = controller.push(frame);
              if (!isPaused && pushed) drainLoop();
            } catch (e) { console.warn(`[PROXY] Encode error: ${e.message}`); }
          },
          (err) => {
            if (aborted) return;
            const code = err?.code ?? 0;
            let msg = err?.details ?? 'OK';
            if (code === 8) {
              const parsed = decodeGrpcError(msg);
              msg = parsed.details;
            }
            const trailer = ProtobufHandCodec.writeGrpcWebTrailers(code, encodeURIComponent(msg));
            controller.push(trailer);
            drainLoop();
            setTimeout(() => { if (!aborted) res.end(); }, 50);
          },
          controller,
          connId
        );
      } else {
        try {
          const respBuf = await handleUnary(req.url, reqBuf);
          const frame = ProtobufHandCodec.writeGrpcWebFrame(respBuf, 0);
          res.write(isText ? Buffer.from(frame.toString('base64'), 'ascii') : frame);
          const trailer = ProtobufHandCodec.writeGrpcWebTrailers(0, 'OK');
          res.end(isText ? Buffer.from(trailer.toString('base64'), 'ascii') : trailer);
          connManager.release(connId);
        } catch (e) {
          const code = e?.code ?? 2;
          const trailer = ProtobufHandCodec.writeGrpcWebTrailers(code, encodeURIComponent(e?.message ?? 'Internal'));
          res.end(isText ? Buffer.from(trailer.toString('base64'), 'ascii') : trailer);
          connManager.release(connId);
        }
      }
    } catch (e) {
      console.error('[PROXY]', e);
      connManager.release(connId);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
});

setInterval(() => {
  const stats = connManager.getStats();
  console.log(`[PROXY] STATS: active=${stats.activeConnections}/${stats.maxConnections}, rejections=${stats.rejections}`);
}, 10000);

server.listen(PROXY_PORT, () => {
  console.log(`[PROXY] gRPC-Web proxy running on :${PROXY_PORT} -> ${GRPC_TARGET}`);
  console.log(`[PROXY] Max message: ${(MAX_MESSAGE_SIZE/1024/1024).toFixed(0)}MB, Max frame: ${(MAX_FRAME_SIZE/1024/1024).toFixed(0)}MB`);
  console.log(`[PROXY] Max connections: ${MAX_CONCURRENT_CONNECTIONS}, Per-conn buffer: ${(PER_CONNECTION_BUFFER_LIMIT/1024/1024).toFixed(0)}MB`);
});

module.exports = { ProtobufHandCodec, StreamBackpressureController, ConnectionManager };
