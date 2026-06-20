const path = require('path');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const { BinaryProtocolParser } = require('./binaryParser');
const { RTGHardwareSimulator } = require('./rtgSimulator');

const PROTO_PATH = path.join(__dirname, '..', '..', 'proto', 'rtg.proto');
const GRPC_PORT = process.env.GRPC_PORT || '50051';

class RTGMonitorServer {
  constructor() {
    this.simulator = new RTGHardwareSimulator();
    this.parser = new BinaryProtocolParser();
    this.clients = new Set();
    this.waveClients = new Set();
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

  StreamRTGData(call) {
    console.log('[RTG] StreamRTGData client connected:', call.getPeer());
    this.clients.add(call);
    call.on('cancelled', () => {
      console.log('[RTG] StreamRTGData client disconnected');
      this.clients.delete(call);
    });
    call.on('error', () => this.clients.delete(call));
  }

  StreamThermocoupleWave(call) {
    console.log('[RTG] StreamThermocoupleWave client connected:', call.getPeer());
    this.waveClients.add(call);
    call.on('cancelled', () => {
      console.log('[RTG] StreamThermocoupleWave client disconnected');
      this.waveClients.delete(call);
    });
    call.on('error', () => this.waveClients.delete(call));
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
  }

  _broadcastToClients() {
    const bin = this.simulator.generateBinaryPacket();
    const pkts = this.parser.feed(bin);
    pkts.forEach(pkt => {
      const dp = this._binaryPacketToDataPoint(pkt);
      this.clients.forEach(c => {
        try { c.write(dp); } catch (e) { this.clients.delete(c); }
      });
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
      this.waveClients.forEach(c => {
        try { c.write(msg); } catch (e) { this.waveClients.delete(c); }
      });
    }
  }

  start() {
    const rtgProto = this._loadProto();
    const server = new grpc.Server();
    server.addService(rtgProto.RTGMonitorService.service, {
      StreamRTGData: this.StreamRTGData.bind(this),
      StreamThermocoupleWave: this.StreamThermocoupleWave.bind(this),
      GetRTGSnapshot: this.GetRTGSnapshot.bind(this)
    });
    server.bindAsync(`0.0.0.0:${GRPC_PORT}`, grpc.ServerCredentials.createInsecure(), (err, port) => {
      if (err) { console.error('[RTG] Bind error:', err); process.exit(1); }
      console.log(`[RTG] gRPC Server running on port ${port}`);
      server.start();
    });
    setInterval(this._broadcastToClients.bind(this), 50);
    setInterval(this._broadcastWaveSamples.bind(this), 5);
  }
}

if (require.main === module) {
  const srv = new RTGMonitorServer();
  srv.start();
}

module.exports = { RTGMonitorServer };
