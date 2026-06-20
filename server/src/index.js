const path = require('path');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const { BinaryProtocolParser } = require('./binaryParser');
const { RTGHardwareSimulator } = require('./rtgSimulator');
const { ConnectionGuard } = require('./connectionGuard');
const { HistoricalChunkEngine } = require('./historicalChunker');

const PROTO_PATH = path.join(__dirname, '..', '..', 'proto', 'rtg.proto');
const GRPC_PORT = process.env.GRPC_PORT || '50051';
const MAX_MESSAGE_SIZE = 64 * 1024 * 1024;

class RTGMonitorServer {
  constructor() {
    this.simulator = new RTGHardwareSimulator();
    this.parser = new BinaryProtocolParser();
    this.connectionGuard = new ConnectionGuard();
    this.chunkEngine = new HistoricalChunkEngine(this.simulator, this.parser);
    this.clients = new Map();
    this.waveClients = new Map();
    this.historicalSessions = new Map();
  }

  _loadProto() {
    const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true
    });
    return grpc.loadPackageDefinition(packageDefinition).rtgmonitor;
  }

  _binaryPacketToDataPoint(pkt) {
    const hot = pkt.hotSideTempC;
    const cold = pkt.coldSideTempC;
    const dT = hot - cold;
    const powerW = pkt.pu238ThermalPowerW;
    const elecPower = pkt.thermocoupleVoltageMv * 0.012;
    let health = 1;
    if (hot > 1150 || cold > -80) health = 2;
    if (hot > 1200 || dT < 1000 || powerW < 2000) health = 3;
    return {
      timestamp_ns: pkt.timestampNs.toString(),
      device_id: 'RTG-' + pkt.deviceId.toString(16).toUpperCase(),
      hot_side_temp_c: hot,
      cold_side_temp_c: cold,
      thermocouple_voltage_mv: pkt.thermocoupleVoltageMv,
      pu238_thermal_power_w: powerW,
      system_voltage_v: pkt.thermocoupleVoltageMv * 0.012,
      system_current_a: powerW > 0 ? elecPower / (pkt.thermocoupleVoltageMv * 0.012 || 1) : 0,
      heat_sink_temp_c: cold + 28,
      health: ['HEALTH_UNKNOWN', 'HEALTH_NOMINAL', 'HEALTH_WARNING', 'HEALTH_CRITICAL', 'HEALTH_FAULT'][health] || 'HEALTH_NOMINAL',
      sequence: pkt.sequence
    };
  }

  _sendRejectWithBackoff(call, reason, backoffMs) {
    try {
      call.write({
        session_id: '0',
        chunk_index: 0,
        total_chunks: 0,
        payload_bytes: 0,
        crc32: 0,
        start_timestamp_ns: '0',
        end_timestamp_ns: '0',
        sample_count: 0,
        payload: Buffer.alloc(0),
        chunk_type: 'CHUNK_REJECT',
        status: [{
          expected_chunks: 0, received_chunks: 0, bytes_transferred: 0,
          throughput_mbps: 0, retry_count: 0
        }],
        error_message: `${reason}; backoff=${Math.ceil(backoffMs)}ms`
      });
      call.end();
    } catch (e) {}
  }

  StreamRTGData(call) {
    const peer = call.getPeer();
    const guard = this.connectionGuard.allowIncoming(peer, 'StreamRTGData');
    if (!guard.allowed) {
      console.log(`[RTG] Rejected StreamRTGData from ${peer}: ${guard.reason}, backoff=${guard.retryBackoff}ms`);
      call.emit('error', {
        code: grpc.status.RESOURCE_EXHAUSTED,
        details: `${guard.reason}; backoff=${Math.ceil(guard.retryBackoff)}ms`,
        metadata: new grpc.Metadata()
      });
      return;
    }
    console.log(`[RTG] StreamRTGData client connected: ${peer}, stream=${guard.streamId.toString().slice(0, 40)}`);
    this.clients.set(guard.streamId, call);
    call.on('cancelled', () => {
      console.log('[RTG] StreamRTGData client disconnected');
      this.clients.delete(guard.streamId);
      this.connectionGuard.release(guard.streamId, peer);
      this.connectionGuard.reportSuccess();
    });
    call.on('error', (e) => {
      this.clients.delete(guard.streamId);
      this.connectionGuard.release(guard.streamId, peer);
      this.connectionGuard.reportFailure();
    });
  }

  StreamThermocoupleWave(call) {
    const peer = call.getPeer();
    const guard = this.connectionGuard.allowIncoming(peer, 'StreamThermocoupleWave');
    if (!guard.allowed) {
      console.log(`[RTG] Rejected StreamThermocoupleWave from ${peer}: ${guard.reason}`);
      call.emit('error', {
        code: grpc.status.RESOURCE_EXHAUSTED,
        details: `${guard.reason}; backoff=${Math.ceil(guard.retryBackoff)}ms`
      });
      return;
    }
    console.log(`[RTG] StreamThermocoupleWave client connected: ${peer}`);
    this.waveClients.set(guard.streamId, call);
    call.on('cancelled', () => {
      this.waveClients.delete(guard.streamId);
      this.connectionGuard.release(guard.streamId, peer);
      this.connectionGuard.reportSuccess();
    });
    call.on('error', (e) => {
      this.waveClients.delete(guard.streamId);
      this.connectionGuard.release(guard.streamId, peer);
      this.connectionGuard.reportFailure();
    });
  }

  GetRTGSnapshot(call, callback) {
    const snap = this.simulator.getSnapshot();
    callback(null, {
      timestamp_ns: snap.timestampNs.toString(),
      device_id: snap.deviceId,
      hot_side_temp_c: snap.hotSideTempC,
      cold_side_temp_c: snap.coldSideTempC,
      thermocouple_voltage_mv: snap.thermocoupleVoltageMv,
      pu238_thermal_power_w: snap.pu238ThermalPowerW,
      pu238_mass_g: snap.pu238MassG,
      half_life_years: snap.halfLifeYears,
      efficiency_percent: snap.efficiencyPercent,
      uptime_hours: snap.uptimeHours,
      health: 'HEALTH_NOMINAL',
      alerts: []
    });
    this.connectionGuard.reportSuccess();
  }

  async StreamHistoricalBurst(call) {
    const peer = call.getPeer();
    const guard = this.connectionGuard.allowIncoming(peer, 'StreamHistoricalBurst');
    if (!guard.allowed) {
      console.log(`[HIST] Rejected StreamHistoricalBurst from ${peer}: ${guard.reason}`);
      this._sendRejectWithBackoff(call, guard.reason, guard.retryBackoff);
      this.connectionGuard.reportFailure();
      return;
    }

    const request = call.request;
    console.log(`[HIST] New historical burst request from ${peer}:`, {
      deviceId: request.device_id,
      startNs: request.start_timestamp_ns,
      endNs: request.end_timestamp_ns,
      chunkSize: request.chunk_size_bytes
    });

    try {
      const sessionId = Symbol.for(`hist-${Date.now()}-${Math.random()}`);
      this.historicalSessions.set(sessionId, { call, startTime: Date.now() });
      let cancelled = false;

      call.on('cancelled', () => {
        console.log('[HIST] Historical burst cancelled by client');
        cancelled = true;
      });

      for await (const chunk of this.chunkEngine.streamHistoricalChunks(request)) {
        if (cancelled) break;
        try {
          call.write(chunk);
        } catch (e) {
          console.log('[HIST] Write error:', e.message);
          break;
        }
        await new Promise(r => setImmediate(r));
      }

      if (!cancelled) {
        call.end();
      }
      this.historicalSessions.delete(sessionId);
      this.connectionGuard.release(guard.streamId, peer);
      this.connectionGuard.reportSuccess();
    } catch (e) {
      console.error('[HIST] Stream error:', e);
      try {
        call.write({
          session_id: '0',
          chunk_index: 0,
          total_chunks: 0,
          payload_bytes: 0,
          crc32: 0,
          start_timestamp_ns: '0',
          end_timestamp_ns: '0',
          sample_count: 0,
          payload: Buffer.alloc(0),
          chunk_type: 'CHUNK_ERROR',
          status: [{
            expected_chunks: 0, received_chunks: 0, bytes_transferred: 0,
            throughput_mbps: 0, retry_count: 0
          }],
          error_message: e.message
        });
        call.end();
      } catch {}
      this.connectionGuard.release(guard.streamId, peer);
      this.connectionGuard.reportFailure();
    }
  }

  _broadcastToClients() {
    const bin = this.simulator.generateBinaryPacket();
    const pkts = this.parser.feed(bin);
    pkts.forEach(pkt => {
      const dp = this._binaryPacketToDataPoint(pkt);
      for (const [streamId, c] of this.clients) {
        try { c.write(dp); } catch (e) { this.clients.delete(streamId); }
      }
    });
  }

  _broadcastWaveSamples() {
    for (let i = 0; i < 4; i++) {
      const s = this.simulator.generateHighFreqSample();
      const msg = {
        timestamp_ns: s.timestampNs.toString(),
        voltage_mv: s.voltageMv,
        sequence: s.sequence
      };
      for (const [streamId, c] of this.waveClients) {
        try { c.write(msg); } catch (e) { this.waveClients.delete(streamId); }
      }
    }
  }

  _logStats() {
    const stats = this.connectionGuard.getStats();
    console.log(`[RTG] STATS: streams=${stats.totalStreams}, ips=${stats.ipsTracked}, rejections=${stats.rejections}, circuit=${stats.circuitState}, failures=${stats.failureCount.toFixed(0)}`);
  }

  start() {
    const rtgProto = this._loadProto();
    const server = new grpc.Server({
      'grpc.max_receive_message_length': MAX_MESSAGE_SIZE,
      'grpc.max_send_message_length': MAX_MESSAGE_SIZE,
      'grpc.http2.max_pings_without_data': 0,
      'grpc.keepalive_time_ms': 30000,
      'grpc.keepalive_timeout_ms': 5000
    });

    server.addService(rtgProto.RTGMonitorService.service, {
      StreamRTGData: this.StreamRTGData.bind(this),
      StreamThermocoupleWave: this.StreamThermocoupleWave.bind(this),
      GetRTGSnapshot: this.GetRTGSnapshot.bind(this),
      StreamHistoricalBurst: this.StreamHistoricalBurst.bind(this)
    });

    server.bindAsync(`0.0.0.0:${GRPC_PORT}`, grpc.ServerCredentials.createInsecure(), (err, port) => {
      if (err) { console.error('[RTG] Bind error:', err); process.exit(1); }
      console.log(`[RTG] gRPC Server running on port ${port}`);
      console.log(`[RTG] Max message size: ${(MAX_MESSAGE_SIZE / 1024 / 1024).toFixed(0)}MB`);
      server.start();
    });

    setInterval(this._broadcastToClients.bind(this), 50);
    setInterval(this._broadcastWaveSamples.bind(this), 5);
    setInterval(this._logStats.bind(this), 10000);
  }
}

if (require.main === module) {
  const srv = new RTGMonitorServer();
  srv.start();
}

module.exports = { RTGMonitorServer, MAX_MESSAGE_SIZE };
