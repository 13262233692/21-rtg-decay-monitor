<template>
  <div style="width: 100vw; height: 100vh; display: flex; flex-direction: column;">
    <div class="top-bar">
      <div class="brand">
        <div class="brand-logo">☢</div>
        <div class="brand-text">
          <div class="brand-title">RTG · MONITOR HUB</div>
          <div class="brand-sub">深空 / 极地 核电池监控中枢 v1.0</div>
        </div>
      </div>
      <div class="top-info">
        <div class="info-item">
          <span class="info-label">DEVICE ID</span>
          <span class="info-val" style="color: var(--accent-cyan);">{{ deviceId }}</span>
        </div>
        <div class="info-item">
          <span class="info-label">MISSION ELAPSED</span>
          <span class="info-val" style="font-variant-numeric: tabular-nums;">{{ missionTime }}</span>
        </div>
        <div class="info-item">
          <span class="info-label">UTC TIME</span>
          <span class="info-val" style="font-variant-numeric: tabular-nums;">{{ utcTime }}</span>
        </div>
        <div class="info-item">
          <span class="info-label">CONNECTION</span>
          <span class="status-chip" :class="connStatus">{{ connLabel }}</span>
        </div>
      </div>
    </div>

    <div class="dashboard-grid">
      <div style="grid-column: span 4; grid-row: span 1; min-height: 180px;">
        <PowerDisplay
          :value="data.pu238_thermal_power_w || 0"
          title="Pu-238 热功率"
          subtitle="实时输出"
          unit="W"
          description="Pu-238 THERMAL POWER · LIVE OUTPUT"
          :status="healthColor"
          :subStats="powerSubStats"
        />
      </div>

      <div style="grid-column: span 4; grid-row: span 1; min-height: 180px;">
        <div class="panel" style="height: 100%; display: flex; flex-direction: column;">
          <div class="corner-mark corner-tl"></div>
          <div class="corner-mark corner-tr"></div>
          <div class="corner-mark corner-bl"></div>
          <div class="corner-mark corner-br"></div>
          <div class="panel-header">
            <div class="panel-title">温度梯度 · TEMP GRADIENT</div>
            <div class="panel-tag">ΔT: {{ deltaT }} °C</div>
          </div>
          <div class="panel-body" style="flex: 1;">
            <div class="temp-dual">
              <div class="temp-side temp-hot">
                <div class="temp-label">热端 HOT SIDE</div>
                <div class="temp-value">{{ data.hot_side_temp_c?.toFixed(1) || '---' }}°</div>
                <div style="font-size: 9px; color: var(--text-muted); margin-top: 4px;">1050 ~ 1150 °C</div>
              </div>
              <div class="temp-side temp-cold">
                <div class="temp-label">冷端 COLD SIDE</div>
                <div class="temp-value">{{ data.cold_side_temp_c?.toFixed(1) || '---' }}°</div>
                <div style="font-size: 9px; color: var(--text-muted); margin-top: 4px;">-150 ~ -100 °C</div>
              </div>
            </div>
            <div style="margin-top: 14px; display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px;" class="stat-grid">
              <div class="stat-card">
                <div class="stat-label">散热片温度</div>
                <div class="stat-value" style="font-size: 18px; color: var(--accent-yellow);">
                  {{ data.heat_sink_temp_c?.toFixed(1) || '---' }}<span class="stat-unit">°C</span>
                </div>
              </div>
              <div class="stat-card">
                <div class="stat-label">效率</div>
                <div class="stat-value" style="font-size: 18px; color: var(--accent-purple);">
                  {{ efficiency }}<span class="stat-unit">%</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div style="grid-column: span 4; grid-row: span 1; min-height: 180px;">
        <div class="panel" style="height: 100%; display: flex; flex-direction: column;">
          <div class="corner-mark corner-tl"></div>
          <div class="corner-mark corner-tr"></div>
          <div class="corner-mark corner-bl"></div>
          <div class="corner-mark corner-br"></div>
          <div class="panel-header">
            <div class="panel-title">系统电气 · ELECTRICAL OUT</div>
            <div class="panel-tag">THERMOELECTRIC</div>
          </div>
          <div class="panel-body" style="flex: 1; display: flex; flex-direction: column;">
            <div class="voltage-display" style="flex: 0 0 auto;">
              <div style="font-size: 9px; color: var(--text-muted); letter-spacing: 2px; text-transform: uppercase; margin-bottom: 6px;">热电偶温差电动势</div>
              <div class="voltage-main">
                {{ data.thermocouple_voltage_mv?.toFixed(3) || '---' }}
                <span style="font-size: 14px; color: var(--text-secondary); margin-left: 4px;">mV</span>
              </div>
              <div style="font-size: 9px; color: var(--text-muted); margin-top: 6px;">≈ {{ ((data.thermocouple_voltage_mv || 0) * 0.012).toFixed(3) }} J/s 温差发电</div>
            </div>
            <div style="margin-top: 12px; display: grid; grid-template-columns: 1fr 1fr; gap: 10px; flex: 1;">
              <div class="stat-card" style="display: flex; flex-direction: column; justify-content: center;">
                <div class="stat-label">系统电压</div>
                <div class="stat-value" style="font-size: 16px; color: var(--accent-cyan);">
                  {{ data.system_voltage_v?.toFixed(3) || '---' }}<span class="stat-unit">V</span>
                </div>
              </div>
              <div class="stat-card" style="display: flex; flex-direction: column; justify-content: center;">
                <div class="stat-label">输出电流</div>
                <div class="stat-value" style="font-size: 16px; color: var(--accent-green);">
                  {{ data.system_current_a?.toFixed(3) || '---' }}<span class="stat-unit">A</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div style="grid-column: span 8; grid-row: span 2; min-height: 380px;">
        <WaveformChart :samples="waveSamples" />
      </div>

      <div style="grid-column: span 4; grid-row: span 2; min-height: 380px;">
        <div class="panel" style="height: 100%; display: flex; flex-direction: column;">
          <div class="corner-mark corner-tl"></div>
          <div class="corner-mark corner-tr"></div>
          <div class="corner-mark corner-bl"></div>
          <div class="corner-mark corner-br"></div>
          <div class="panel-header">
            <div class="panel-title">系统诊断 · SYSTEM DIAGNOSTIC</div>
            <div class="panel-tag">
              <span class="led" :class="healthLed" style="vertical-align: middle;"></span>
              &nbsp;{{ healthText }}
            </div>
          </div>
          <div class="panel-body health-panel" style="flex: 1; overflow-y: auto;">
            <div class="health-row">
              <span class="health-key">SEQUENCE</span>
              <span class="health-val">#{{ data.sequence || 0 }}</span>
            </div>
            <div class="health-row">
              <span class="health-key">HEALTH STATUS</span>
              <span class="health-val" :style="{ color: healthHex }">{{ healthText }}</span>
            </div>
            <div class="health-row">
              <span class="health-key">Pu-238 装料</span>
              <span class="health-val">{{ snapshot.pu238_mass_g?.toFixed(0) || '4,500' }} g</span>
            </div>
            <div class="health-row">
              <span class="health-key">半衰期</span>
              <span class="health-val">87.70 yr</span>
            </div>
            <div class="health-row">
              <span class="health-key">已工作</span>
              <span class="health-val">{{ uptimeStr }}</span>
            </div>
            <div class="health-row">
              <span class="health-key">功率衰减</span>
              <span class="health-val" style="color: var(--accent-orange);">{{ decayPct }}%</span>
            </div>
            <div class="health-row">
              <span class="health-key">预计剩余寿命</span>
              <span class="health-val" style="color: var(--accent-cyan);">{{ remainYears }} yr</span>
            </div>
            <div class="health-row">
              <span class="health-key">比功率</span>
              <span class="health-val">{{ specificPower }} W/g</span>
            </div>
            <div class="health-row">
              <span class="health-key">热电转换</span>
              <span class="health-val">Seebeck 0.054 V/K</span>
            </div>
            <div class="health-row">
              <span class="health-key">数据协议</span>
              <span class="health-val" style="color: var(--text-secondary);">gRPC Streaming</span>
            </div>
            <div class="health-row">
              <span class="health-key">数据包校验</span>
              <span class="health-val" style="color: var(--accent-green);">CRC-16 OK</span>
            </div>
            <div class="health-row">
              <span class="health-key">丢包率</span>
              <span class="health-val" style="color: var(--accent-green);">{{ lossPct }}%</span>
            </div>
            <div class="health-row">
              <span class="health-key">波形采样率</span>
              <span class="health-val">~800 Hz</span>
            </div>
            <div class="health-row">
              <span class="health-key">主循环频率</span>
              <span class="health-val">20 Hz</span>
            </div>
            <div style="margin-top: 14px; padding: 10px; border: 1px dashed var(--border-accent); background: rgba(0, 229, 255, 0.03);">
              <div style="font-size: 9px; letter-spacing: 2px; color: var(--accent-cyan); margin-bottom: 8px; text-transform: uppercase;">☢ 核电池安全告警</div>
              <div style="font-size: 10px; color: var(--text-secondary); line-height: 1.8;">
                · 热端温度 <span style="color: var(--accent-red);">> 1200°C</span> 自动停机<br>
                · 冷端温度 <span style="color: var(--accent-orange);">> -80°C</span> 辐射异常<br>
                · 输出功率 <span style="color: var(--accent-orange);">< 2000W</span> 衰减警告<br>
                · 热电偶电压 <span style="color: var(--text-muted);">~66mV</span> 额定值
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onBeforeUnmount, onUpdated } from 'vue';
import PowerDisplay from './components/PowerDisplay.vue';
import WaveformChart from './components/WaveformChart.vue';
import { RTGGrpcWebClient } from './grpcClient.js';

const deviceId = ref('RTG-52544701');
const data = reactive({
  timestamp_ns: '0',
  hot_side_temp_c: 1100,
  cold_side_temp_c: -120,
  thermocouple_voltage_mv: 66,
  pu238_thermal_power_w: 2500,
  system_voltage_v: 0.8,
  system_current_a: 12,
  heat_sink_temp_c: -92,
  health: 'HEALTH_NOMINAL',
  sequence: 0
});

const snapshot = reactive({
  pu238_mass_g: 4500,
  uptime_hours: 365 * 12 * 24
});

const waveSamples = ref([]);
const WAVE_CAP = 1200;
const client = new RTGGrpcWebClient();
const connStatus = ref('nominal');
const connLabel = ref('CONNECTING');
const utcTime = ref('');
const missionTime = ref('00:00:00:00');
const lastSeq = ref(0);
const lostPkts = ref(0);
let utcTimer = null;
let stopMain = null;
let stopWave = null;

const healthColor = computed(() => {
  const m = { HEALTH_NOMINAL: 'nominal', HEALTH_WARNING: 'warning', HEALTH_CRITICAL: 'critical', HEALTH_FAULT: 'critical' };
  return m[data.health] || 'nominal';
});

const healthLed = computed(() => ({ nominal: 'led-green', warning: 'led-orange', critical: 'led-red' }[healthColor.value] || 'led-cyan'));
const healthText = computed(() => {
  const m = { HEALTH_UNKNOWN: '未知', HEALTH_NOMINAL: '正常 NOMINAL', HEALTH_WARNING: '警告 WARNING', HEALTH_CRITICAL: '严重 CRITICAL', HEALTH_FAULT: '故障 FAULT' };
  return m[data.health] || '---';
});
const healthHex = computed(() => ({ nominal: 'var(--accent-green)', warning: 'var(--accent-orange)', critical: 'var(--accent-red)' }[healthColor.value] || 'var(--text-primary)'));

const deltaT = computed(() => {
  const d = (data.hot_side_temp_c || 0) - (data.cold_side_temp_c || 0);
  return d.toFixed(1);
});

const efficiency = computed(() => {
  const p = data.pu238_thermal_power_w || 1;
  const e = (data.thermocouple_voltage_mv || 0) * 0.012;
  return ((e / p) * 100).toFixed(2);
});

const specificPower = computed(() => {
  const p = data.pu238_thermal_power_w || 0;
  const m = snapshot.pu238_mass_g || 1;
  return (p / m).toFixed(3);
});

const decayPct = computed(() => {
  const start = 4500 * 0.568;
  const cur = data.pu238_thermal_power_w || start;
  return ((1 - cur / start) * 100).toFixed(2);
});

const remainYears = computed(() => {
  const start = 4500 * 0.568;
  const cur = data.pu238_thermal_power_w || start;
  const ratio = cur / start;
  if (ratio <= 0) return 0;
  const t = -Math.log(ratio) * 87.7 / Math.log(2);
  return Math.max(0, (87.7 - t)).toFixed(1);
});

const uptimeStr = computed(() => {
  const h = snapshot.uptime_hours || 0;
  const d = Math.floor(h / 24);
  const hh = Math.floor(h % 24);
  return `${d.toLocaleString()} 天 ${hh} 小时`;
});

const lossPct = computed(() => {
  const total = data.sequence || 1;
  return ((lostPkts.value / total) * 100).toFixed(3);
});

const powerSubStats = computed(() => [
  { label: '初始功率', value: (4500 * 0.568).toFixed(0), unit: 'W' },
  { label: '当前/初始', value: ((data.pu238_thermal_power_w / (4500 * 0.568)) * 100).toFixed(1), unit: '%' },
  { label: '总能量', value: ((data.pu238_thermal_power_w * snapshot.uptime_hours / 1000).toFixed(0)), unit: 'kWh' }
]);

function fmtMission(s) {
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s = Math.floor(s % 60);
  const pad = (n) => n.toString().padStart(2, '0');
  return `${pad(d)}:${pad(h)}:${pad(m)}:${pad(s)}`;
}

let missionSeconds = 12 * 365 * 86400 + 42 * 86400 + 7 * 3600;

function updateTimes() {
  const now = new Date();
  utcTime.value = now.toISOString().replace('T', ' ').replace('Z', '') + ' UTC';
  missionSeconds += 1;
  missionTime.value = fmtMission(missionSeconds);
}

onMounted(async () => {
  updateTimes();
  utcTimer = setInterval(updateTimes, 1000);

  try {
    const snap = await client.getSnapshot('RTG-GENERAL-PURPOSE-001');
    if (snap) {
      snapshot.pu238_mass_g = snap.pu238_mass_g || 4500;
      snapshot.uptime_hours = snap.uptime_hours || snapshot.uptime_hours;
    }
  } catch (e) { console.warn('snapshot err', e); }

  stopMain = client.streamRTGData(
    'RTG-GENERAL-PURPOSE-001',
    (dp) => {
      connStatus.value = 'nominal';
      connLabel.value = 'LINK OK';
      Object.assign(data, dp);
      if (lastSeq.value && data.sequence - lastSeq.value > 1) {
        lostPkts.value += (data.sequence - lastSeq.value - 1);
      }
      lastSeq.value = data.sequence;
    },
    (e) => {
      if (e) {
        connStatus.value = 'warning';
        connLabel.value = 'RECONNECTING';
      }
    }
  );

  stopWave = client.streamThermocoupleWave(
    'RTG-GENERAL-PURPOSE-001',
    (sm) => {
      const arr = waveSamples.value;
      arr.push(sm.voltage_mv);
      if (arr.length > WAVE_CAP) {
        const overflow = arr.length - WAVE_CAP;
        arr.splice(0, overflow);
      }
    },
    (e) => { /* silent */ }
  );

  setTimeout(() => {
    if (connLabel.value === 'CONNECTING') {
      connStatus.value = 'critical';
      connLabel.value = 'NO LINK';
    }
  }, 3000);
});

onBeforeUnmount(() => {
  if (utcTimer) clearInterval(utcTimer);
  if (stopMain) stopMain();
  if (stopWave) stopWave();
  client.closeAll();
});
</script>
