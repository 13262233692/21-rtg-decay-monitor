const { BinaryProtocolParser } = require('./binaryParser');

const HALF_LIFE_YEARS = 87.7;
const HALF_LIFE_SECONDS = HALF_LIFE_YEARS * 365.25 * 24 * 3600;
const LAMBDA = Math.log(2) / HALF_LIFE_SECONDS;
const PU238_SPECIFIC_POWER_W_PER_G = 0.568;
const SEEBECK_COEFF = 0.054;
const MASS_G = 4500;

class RTGHardwareSimulator {
  constructor() {
    this.sequence = 0;
    this.waveSeq = 0;
    this.startTime = Date.now();
    this.elapsedSeconds = 0;
    this.hotTempBase = 1100;
    this.coldTempBase = -120;
    this.powerDecayStart = MASS_G * PU238_SPECIFIC_POWER_W_PER_G;
    this.currentDecayDays = 365 * 12;
    this.voltageNoisePhase = 0;
  }

  _elapsed() {
    this.elapsedSeconds = (Date.now() - this.startTime) / 1000;
    return this.elapsedSeconds;
  }

  _thermalPower() {
    const t = this.currentDecayDays * 86400 + this._elapsed() * 100;
    return this.powerDecayStart * Math.exp(-LAMBDA * t);
  }

  _addNoise(base, amp) {
    return base + (Math.random() - 0.5) * 2 * amp;
  }

  generateBinaryPacket() {
    const t = this._elapsed();
    const powerW = this._thermalPower();
    const hot = this._addNoise(this.hotTempBase, 3.5) + Math.sin(t * 0.3) * 2.1;
    const cold = this._addNoise(this.coldTempBase, 1.8) + Math.cos(t * 0.17) * 0.9;
    const dT = hot - cold;
    const vMv = SEEBECK_COEFF * dT + this._addNoise(0, 0.085) + Math.sin(t * 7.7) * 0.032 + Math.sin(t * 53.2) * 0.011;
    this.sequence++;
    return BinaryProtocolParser.buildPacket({
      deviceId: 0x52544701,
      sequence: this.sequence,
      timestampNs: BigInt(Date.now()) * 1000000n,
      hotSideTempC: hot,
      coldSideTempC: cold,
      thermocoupleVoltageMv: vMv,
      pu238ThermalPowerW: powerW,
      status: 1
    });
  }

  generateHighFreqSample() {
    const t = this._elapsed();
    const dT = (this.hotTempBase - this.coldTempBase);
    const baseV = SEEBECK_COEFF * dT;
    this.voltageNoisePhase += 0.043;
    const vMv = baseV
      + Math.sin(t * 127.3 + this.voltageNoisePhase) * 0.047
      + Math.sin(t * 89.7) * 0.021
      + Math.sin(t * 213.1) * 0.009
      + Math.sin(t * 61.4) * 0.033
      + (Math.random() - 0.5) * 0.018;
    this.waveSeq++;
    return {
      timestampNs: (BigInt(Date.now()) * 1000000n) + BigInt(Math.floor(Math.random() * 800000)),
      voltageMv: vMv,
      sequence: this.waveSeq
    };
  }

  getSnapshot() {
    const t = this._elapsed();
    const powerW = this._thermalPower();
    const hot = this._addNoise(this.hotTempBase, 2);
    const cold = this._addNoise(this.coldTempBase, 1);
    const dT = hot - cold;
    const vMv = SEEBECK_COEFF * dT;
    const eff = (vMv * 0.012 / powerW) * 100;
    return {
      timestampNs: BigInt(Date.now()) * 1000000n,
      deviceId: 'RTG-GENERAL-PURPOSE-001',
      hotSideTempC: hot,
      coldSideTempC: cold,
      thermocoupleVoltageMv: vMv,
      pu238ThermalPowerW: powerW,
      pu238MassG: MASS_G,
      halfLifeYears: HALF_LIFE_YEARS,
      efficiencyPercent: eff,
      uptimeHours: t / 3600 + this.currentDecayDays * 24,
      health: 1,
      alerts: []
    };
  }
}

module.exports = { RTGHardwareSimulator };
