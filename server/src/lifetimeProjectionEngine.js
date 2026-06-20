const HALF_LIFE_YEARS = 87.7;
const HALF_LIFE_SECONDS = HALF_LIFE_YEARS * 365.25 * 24 * 3600;
const LAMBDA = Math.log(2) / HALF_LIFE_SECONDS;
const PU238_SPECIFIC_POWER_W_PER_G = 0.568;
const SEEBECK_COEFF = 0.054;
const MASS_G = 4500;
const INITIAL_POWER_W = MASS_G * PU238_SPECIFIC_POWER_W_PER_G;

const BASE_HOT_TEMP = 1100;
const BASE_COLD_TEMP = -120;
const BASE_EFFICIENCY = 0.065;

const EFFICIENCY_DECAY_RATE = 0.0012;
const TEMP_DECAY_EXPONENT = 0.25;
const CONFIDENCE_SIGMA = 0.03;

function calculateDecayRatio(yearsFromNow, elapsedSeconds = 0) {
  const totalSeconds = yearsFromNow * 365.25 * 24 * 3600 + elapsedSeconds;
  return Math.exp(-LAMBDA * totalSeconds);
}

function calculateThermalPower(decayRatio) {
  return INITIAL_POWER_W * decayRatio;
}

function calculateMassRemaining(decayRatio) {
  return MASS_G * decayRatio;
}

function calculateHotSideTemp(thermalPower, initialPower = INITIAL_POWER_W) {
  const powerRatio = thermalPower / initialPower;
  const tempDrop = (BASE_HOT_TEMP - BASE_COLD_TEMP) * (1 - Math.pow(powerRatio, TEMP_DECAY_EXPONENT));
  return BASE_HOT_TEMP - tempDrop;
}

function calculateEfficiency(yearsFromNow, thermalPower) {
  const baseEff = BASE_EFFICIENCY * Math.exp(-EFFICIENCY_DECAY_RATE * yearsFromNow);
  const tempFactor = calculateHotSideTemp(thermalPower) / BASE_HOT_TEMP;
  return baseEff * Math.pow(tempFactor, 0.5) * 100;
}

function calculateConfidenceBand(value, yearsFromNow, sigma = CONFIDENCE_SIGMA) {
  const spread = sigma * Math.sqrt(1 + yearsFromNow / 30);
  return {
    lower: value * (1 - spread),
    upper: value * (1 + spread)
  };
}

function getHealthStatus(decayRatio, yearsFromNow) {
  if (decayRatio < 0.3) return 'PROJECTION_END_OF_LIFE';
  if (decayRatio < 0.5) return 'PROJECTION_CRITICAL';
  if (decayRatio < 0.75) return 'PROJECTION_WARNING';
  return 'PROJECTION_NOMINAL';
}

function getOperationalNotes(decayRatio, yearsFromNow, hotSideTemp) {
  const notes = [];
  if (decayRatio < 0.5) {
    notes.push('警告：已超过 Pu-238 半衰期，功率输出不足设计值的 50%');
  }
  if (hotSideTemp < 800) {
    notes.push('热端温度低于 800°C，热电转换效率显著下降');
  }
  if (yearsFromNow > 20) {
    notes.push('已超过设计寿命 20 年，建议安排维修任务更换核燃料');
  }
  if (decayRatio < 0.3) {
    notes.push('达到寿命终点，系统仅能维持基础遥测功能');
  }
  if (notes.length === 0) {
    notes.push('系统运行在最佳工况区间');
  }
  return notes;
}

class LifetimeProjectionEngine {
  constructor(simulator) {
    this.simulator = simulator;
    this.historicalEfficiencyData = [];
    this.efficiencyTrend = null;
  }

  collectHistoricalEfficiency(dataPoint) {
    if (this.historicalEfficiencyData.length > 1000) {
      this.historicalEfficiencyData.shift();
    }
    this.historicalEfficiencyData.push({
      timestamp: Date.now(),
      efficiency: dataPoint.efficiency_percent,
      hotTemp: dataPoint.hot_side_temp_c,
      power: dataPoint.pu238_thermal_power_w
    });
    this._updateEfficiencyTrend();
  }

  _updateEfficiencyTrend() {
    if (this.historicalEfficiencyData.length < 10) return;
    
    const n = this.historicalEfficiencyData.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    
    const startTime = this.historicalEfficiencyData[0].timestamp;
    for (let i = 0; i < n; i++) {
      const x = (this.historicalEfficiencyData[i].timestamp - startTime) / (365.25 * 24 * 3600 * 1000);
      const y = this.historicalEfficiencyData[i].efficiency;
      sumX += x;
      sumY += y;
      sumXY += x * y;
      sumXX += x * x;
    }
    
    const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;
    
    this.efficiencyTrend = { slope, intercept, rSquared: this._calculateRSquared(slope, intercept, startTime) };
  }

  _calculateRSquared(slope, intercept, startTime) {
    if (this.historicalEfficiencyData.length < 10) return 0;
    
    const n = this.historicalEfficiencyData.length;
    const yMean = this.historicalEfficiencyData.reduce((s, d) => s + d.efficiency, 0) / n;
    
    let ssTotal = 0, ssResidual = 0;
    for (let i = 0; i < n; i++) {
      const x = (this.historicalEfficiencyData[i].timestamp - startTime) / (365.25 * 24 * 3600 * 1000);
      const y = this.historicalEfficiencyData[i].efficiency;
      const yPred = slope * x + intercept;
      ssTotal += Math.pow(y - yMean, 2);
      ssResidual += Math.pow(y - yPred, 2);
    }
    
    return ssTotal > 0 ? 1 - (ssResidual / ssTotal) : 0;
  }

  _getAdjustedEfficiency(yearsFromNow, thermalPower) {
    let baseEff = calculateEfficiency(yearsFromNow, thermalPower);
    
    if (this.efficiencyTrend) {
      const historicalEff = this.efficiencyTrend.intercept + this.efficiencyTrend.slope * yearsFromNow;
      const weight = Math.min(1, this.historicalEfficiencyData.length / 1000);
      baseEff = baseEff * (1 - weight * 0.3) + historicalEff * weight * 0.3;
    }
    
    return baseEff;
  }

  *generateProjection(projectionYears = 30, numPoints = 180, includeConfidenceBand = true, deviceId = 'RTG-GENERAL-PURPOSE-001') {
    const startTimeNs = BigInt(Date.now()) * 1000000n;
    const secondsPerPoint = (projectionYears * 365.25 * 24 * 3600) / numPoints;
    
    const currentSnapshot = this.simulator ? this.simulator.getSnapshot() : null;
    const currentPower = currentSnapshot ? currentSnapshot.pu238ThermalPowerW : INITIAL_POWER_W;
    const currentDecayRatio = currentPower / INITIAL_POWER_W;
    const currentElapsedYears = -Math.log(currentDecayRatio) / (LAMBDA * 365.25 * 24 * 3600);

    for (let i = 0; i <= numPoints; i++) {
      const yearsFromNow = (i / numPoints) * projectionYears;
      const totalYears = currentElapsedYears + yearsFromNow;
      const decayRatio = calculateDecayRatio(totalYears);
      const thermalPower = calculateThermalPower(decayRatio);
      const massRemaining = calculateMassRemaining(decayRatio);
      const hotSideTemp = calculateHotSideTemp(thermalPower, INITIAL_POWER_W);
      const coldSideTemp = BASE_COLD_TEMP + yearsFromNow * 0.15;
      const dT = hotSideTemp - coldSideTemp;
      const thermocoupleVoltage = SEEBECK_COEFF * dT;
      const efficiency = this._getAdjustedEfficiency(yearsFromNow, thermalPower);
      const electricalPower = thermalPower * (efficiency / 100);
      const maxPayloadPower = electricalPower * 0.85;
      const healthStatus = getHealthStatus(decayRatio, yearsFromNow);

      const timestampNs = startTimeNs + BigInt(Math.floor(i * secondsPerPoint * 1e9));

      const point = {
        timestamp_ns: timestampNs.toString(),
        years_from_now: yearsFromNow,
        pu238_thermal_power_w: thermalPower,
        pu238_mass_remaining_g: massRemaining,
        hot_side_temp_c: hotSideTemp,
        cold_side_temp_c: coldSideTemp,
        thermocouple_voltage_mv: thermocoupleVoltage,
        efficiency_percent: efficiency,
        electrical_power_w: electricalPower,
        max_payload_power_w: maxPayloadPower,
        decay_ratio: decayRatio,
        confidence_lower: 0,
        confidence_upper: 0,
        health_status: healthStatus
      };

      if (includeConfidenceBand) {
        const band = calculateConfidenceBand(thermalPower, yearsFromNow);
        point.confidence_lower = band.lower;
        point.confidence_upper = band.upper;
      }

      yield point;
    }
  }

  calculateInverse(yearsFromNow, deviceId = 'RTG-GENERAL-PURPOSE-001') {
    const currentSnapshot = this.simulator ? this.simulator.getSnapshot() : null;
    const currentPower = currentSnapshot ? currentSnapshot.pu238ThermalPowerW : INITIAL_POWER_W;
    const currentHotTemp = currentSnapshot ? currentSnapshot.hotSideTempC : BASE_HOT_TEMP;
    const currentDecayRatio = currentPower / INITIAL_POWER_W;
    const currentElapsedYears = -Math.log(currentDecayRatio) / (LAMBDA * 365.25 * 24 * 3600);

    const totalYears = currentElapsedYears + yearsFromNow;
    const decayRatio = calculateDecayRatio(totalYears);
    const thermalPower = calculateThermalPower(decayRatio);
    const massRemaining = calculateMassRemaining(decayRatio);
    const massConsumed = MASS_G - massRemaining;
    const hotSideTemp = calculateHotSideTemp(thermalPower, INITIAL_POWER_W);
    const hotSideTempDrop = yearsFromNow === 0 ? 0 : currentHotTemp - hotSideTemp;
    const coldSideTemp = BASE_COLD_TEMP + yearsFromNow * 0.15;
    const dT = hotSideTemp - coldSideTemp;
    const thermocoupleVoltage = SEEBECK_COEFF * dT;
    const efficiency = this._getAdjustedEfficiency(yearsFromNow, thermalPower);
    const electricalPower = thermalPower * (efficiency / 100);
    const maxPayloadPower = electricalPower * 0.85;
    const remainingHalfLives = totalYears / HALF_LIFE_YEARS;
    const powerDecayPercent = (1 - decayRatio / currentDecayRatio) * 100;
    const healthStatus = getHealthStatus(decayRatio, yearsFromNow);
    const operationalNotes = getOperationalNotes(decayRatio, yearsFromNow, hotSideTemp);

    const targetTimestampNs = BigInt(Date.now()) * 1000000n + BigInt(Math.floor(yearsFromNow * 365.25 * 24 * 3600 * 1e9));

    return {
      target_timestamp_ns: targetTimestampNs.toString(),
      years_from_now: yearsFromNow,
      pu238_thermal_power_w: thermalPower,
      power_decay_percent: powerDecayPercent,
      hot_side_temp_c: hotSideTemp,
      hot_side_temp_drop_c: hotSideTempDrop,
      cold_side_temp_c: coldSideTemp,
      thermocouple_voltage_mv: thermocoupleVoltage,
      efficiency_percent: efficiency,
      electrical_power_w: electricalPower,
      max_payload_power_w: maxPayloadPower,
      remaining_half_lives: remainingHalfLives,
      pu238_mass_remaining_g: massRemaining,
      pu238_mass_consumed_g: massConsumed,
      health_status: healthStatus,
      operational_notes: operationalNotes
    };
  }

  getCurrentMetrics() {
    return this.calculateInverse(0);
  }
}

module.exports = {
  LifetimeProjectionEngine,
  HALF_LIFE_YEARS,
  INITIAL_POWER_W,
  calculateDecayRatio,
  calculateThermalPower,
  calculateHotSideTemp,
  calculateEfficiency,
  getHealthStatus
};
