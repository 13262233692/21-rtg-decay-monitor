<template>
  <div class="lifetime-panel">
    <div class="panel-header">
      <h3 class="panel-title">
        <span class="title-icon">⚛</span>
        RTG 能源寿命预测中枢
      </h3>
      <div class="panel-stats">
        <div class="stat-item">
          <span class="stat-label">预测跨度</span>
          <span class="stat-value">{{ projectionYears }} 年</span>
        </div>
        <div class="stat-item">
          <span class="stat-label">数据点</span>
          <span class="stat-value">{{ projectionData.length }}</span>
        </div>
        <div class="stat-item" v-if="currentMetrics">
          <span class="stat-label">当前功率</span>
          <span class="stat-value">{{ formatPower(currentMetrics.pu238_thermal_power_w) }}</span>
        </div>
      </div>
    </div>

    <div class="chart-container">
      <canvas ref="chartCanvas" class="projection-canvas"></canvas>
      
      <div 
        class="timeline-ruler"
        :style="{ left: rulerPosition + '%' }"
        @mousedown="startDrag"
      >
        <div class="ruler-line"></div>
        <div class="ruler-handle">
          <span class="ruler-year">{{ rulerYears.toFixed(1) }}年</span>
        </div>
        <div class="ruler-tooltip" v-if="hoverData">
          <div class="tooltip-row">
            <span class="tooltip-label">日期</span>
            <span class="tooltip-value">{{ formatDate(hoverData.target_timestamp_ns) }}</span>
          </div>
          <div class="tooltip-row">
            <span class="tooltip-label">热功率</span>
            <span class="tooltip-value">{{ formatPower(hoverData.pu238_thermal_power_w) }}</span>
          </div>
          <div class="tooltip-row">
            <span class="tooltip-label">功率衰减</span>
            <span class="tooltip-value decay">{{ hoverData.power_decay_percent.toFixed(1) }}%</span>
          </div>
          <div class="tooltip-row">
            <span class="tooltip-label">热端温度</span>
            <span class="tooltip-value">{{ hoverData.hot_side_temp_c.toFixed(1) }}°C</span>
          </div>
          <div class="tooltip-row">
            <span class="tooltip-label">温度下降</span>
            <span class="tooltip-value drop">-{{ hoverData.hot_side_temp_drop_c.toFixed(1) }}°C</span>
          </div>
          <div class="tooltip-row">
            <span class="tooltip-label">载荷功率</span>
            <span class="tooltip-value payload">{{ formatPower(hoverData.max_payload_power_w) }}</span>
          </div>
          <div class="tooltip-row">
            <span class="tooltip-label">Pu-238剩余</span>
            <span class="tooltip-value">{{ hoverData.pu238_mass_remaining_g.toFixed(0) }}g</span>
          </div>
          <div class="tooltip-row">
            <span class="tooltip-label">健康状态</span>
            <span class="tooltip-value" :class="healthClass(hoverData.health_status)">
              {{ formatHealth(hoverData.health_status) }}
            </span>
          </div>
        </div>
      </div>
    </div>

    <div class="timeline-controls">
      <div class="control-row">
        <div class="control-label">
          <span>时间轴位置</span>
          <span class="control-value">{{ rulerYears.toFixed(1) }} 年</span>
        </div>
        <input 
          type="range" 
          class="timeline-slider"
          min="0" 
          :max="projectionYears" 
          step="0.1"
          :value="rulerYears"
          @input="onSliderInput"
        />
      </div>
      <div class="control-row preset-buttons">
        <button 
          v-for="preset in yearPresets" 
          :key="preset.value"
          class="preset-btn"
          :class="{ active: rulerYears === preset.value }"
          @click="setRulerYear(preset.value)"
        >
          {{ preset.label }}
        </button>
      </div>
    </div>

    <div class="metrics-grid" v-if="hoverData">
      <div class="metric-card primary">
        <div class="metric-icon">🔥</div>
        <div class="metric-content">
          <div class="metric-title">热端温度</div>
          <div class="metric-value">{{ hoverData.hot_side_temp_c.toFixed(1) }}°C</div>
          <div class="metric-sub">
            <span class="metric-trend down">↓ {{ hoverData.hot_side_temp_drop_c.toFixed(1) }}°C</span>
            <span class="metric-desc">相对当前下降幅度</span>
          </div>
        </div>
      </div>

      <div class="metric-card primary">
        <div class="metric-icon">⚡</div>
        <div class="metric-content">
          <div class="metric-title">载荷功率阈值</div>
          <div class="metric-value">{{ formatPower(hoverData.max_payload_power_w) }}</div>
          <div class="metric-sub">
            <span class="metric-trend">{{ getPayloadTrend() }}</span>
            <span class="metric-desc">可供设备的最大功率</span>
          </div>
        </div>
      </div>

      <div class="metric-card">
        <div class="metric-icon">☢</div>
        <div class="metric-content">
          <div class="metric-title">Pu-238 状态</div>
          <div class="metric-value">{{ (hoverData.pu238_mass_remaining_g / 4500 * 100).toFixed(1) }}%</div>
          <div class="metric-sub">
            <span>{{ hoverData.pu238_mass_remaining_g.toFixed(0) }}g / 4500g</span>
            <span class="metric-desc">已消耗 {{ hoverData.pu238_mass_consumed_g.toFixed(0) }}g</span>
          </div>
        </div>
      </div>

      <div class="metric-card">
        <div class="metric-icon">📉</div>
        <div class="metric-content">
          <div class="metric-title">功率衰减</div>
          <div class="metric-value decay">{{ hoverData.power_decay_percent.toFixed(1) }}%</div>
          <div class="metric-sub">
            <span>{{ formatPower(hoverData.pu238_thermal_power_w) }}</span>
            <span class="metric-desc">剩余 {{ (100 - hoverData.power_decay_percent).toFixed(1) }}%</span>
          </div>
        </div>
      </div>
    </div>

    <div class="operational-notes" v-if="hoverData && hoverData.operational_notes.length > 0">
      <div class="notes-header">
        <span class="notes-icon">📋</span>
        <span>运行状态评估</span>
      </div>
      <div class="notes-list">
        <div 
          v-for="(note, idx) in hoverData.operational_notes" 
          :key="idx"
          class="note-item"
          :class="getNoteClass(note)"
        >
          <span class="note-icon">{{ getNoteIcon(note) }}</span>
          <span class="note-text">{{ note }}</span>
        </div>
      </div>
    </div>

    <div class="loading-overlay" v-if="loading">
      <div class="loading-spinner"></div>
      <span class="loading-text">正在生成寿命预测模型...</span>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, watch, computed } from 'vue';

const props = defineProps({
  grpcClient: {
    type: Object,
    required: true
  },
  deviceId: {
    type: String,
    default: 'RTG-GENERAL-PURPOSE-001'
  },
  projectionYears: {
    type: Number,
    default: 30
  },
  dataPoints: {
    type: Number,
    default: 180
  }
});

const emit = defineEmits(['dataLoaded', 'rulerChanged']);

const chartCanvas = ref(null);
const projectionData = ref([]);
const currentMetrics = ref(null);
const hoverData = ref(null);
const loading = ref(true);
const rulerYears = ref(0);
const rulerPosition = ref(0);
const isDragging = ref(false);

let chartCtx = null;
let animationFrame = null;
let streamCleanup = null;
let containerRect = null;

const yearPresets = [
  { label: '现在', value: 0 },
  { label: '5年', value: 5 },
  { label: '10年', value: 10 },
  { label: '15年', value: 15 },
  { label: '20年', value: 20 },
  { label: '25年', value: 25 },
  { label: '30年', value: 30 }
];

const healthClass = (status) => {
  const map = {
    'PROJECTION_NOMINAL': 'health-nominal',
    'PROJECTION_WARNING': 'health-warning',
    'PROJECTION_CRITICAL': 'health-critical',
    'PROJECTION_END_OF_LIFE': 'health-eol'
  };
  return map[status] || 'health-nominal';
};

const formatHealth = (status) => {
  const map = {
    'PROJECTION_NOMINAL': '正常',
    'PROJECTION_WARNING': '注意',
    'PROJECTION_CRITICAL': '警告',
    'PROJECTION_END_OF_LIFE': '寿命终点'
  };
  return map[status] || '未知';
};

const formatPower = (watts) => {
  if (watts >= 1000) return (watts / 1000).toFixed(2) + ' kW';
  return watts.toFixed(1) + ' W';
};

const formatDate = (timestampNs) => {
  const ns = BigInt(timestampNs);
  const ms = Number(ns / 1000000n);
  const date = new Date(ms);
  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' });
};

const getNoteIcon = (note) => {
  if (note.includes('警告') || note.includes('低于')) return '⚠️';
  if (note.includes('更换') || note.includes('寿命终点')) return '🔴';
  if (note.includes('最佳')) return '✅';
  return 'ℹ️';
};

const getNoteClass = (note) => {
  if (note.includes('警告') || note.includes('低于')) return 'note-warning';
  if (note.includes('更换') || note.includes('寿命终点')) return 'note-critical';
  return 'note-info';
};

const getPayloadTrend = () => {
  if (!hoverData.value || !currentMetrics.value) return '';
  const diff = hoverData.value.max_payload_power_w - currentMetrics.value.max_payload_power_w;
  if (diff < 0) return `↓ ${formatPower(-diff)}`;
  return `↑ ${formatPower(diff)}`;
};

const startDrag = (e) => {
  isDragging.value = true;
  containerRect = chartCanvas.value.getBoundingClientRect();
  updateRulerFromMouse(e.clientX);
  window.addEventListener('mousemove', onDrag);
  window.addEventListener('mouseup', stopDrag);
};

const onDrag = (e) => {
  if (!isDragging.value) return;
  updateRulerFromMouse(e.clientX);
};

const stopDrag = () => {
  isDragging.value = false;
  window.removeEventListener('mousemove', onDrag);
  window.removeEventListener('mouseup', stopDrag);
};

const updateRulerFromMouse = (clientX) => {
  if (!containerRect) return;
  const x = clientX - containerRect.left;
  const percent = Math.max(0, Math.min(100, (x / containerRect.width) * 100));
  rulerPosition.value = percent;
  rulerYears.value = (percent / 100) * props.projectionYears;
  updateHoverData();
};

const onSliderInput = (e) => {
  const value = parseFloat(e.target.value);
  rulerYears.value = value;
  rulerPosition.value = (value / props.projectionYears) * 100;
  updateHoverData();
};

const setRulerYear = (year) => {
  rulerYears.value = year;
  rulerPosition.value = (year / props.projectionYears) * 100;
  updateHoverData();
};

const updateHoverData = async () => {
  try {
    const result = await props.grpcClient.getLifetimeInverse(props.deviceId, rulerYears.value);
    hoverData.value = result;
    emit('rulerChanged', { year: rulerYears.value, data: result });
    requestAnimationFrame(drawChart);
  } catch (e) {
    console.error('Failed to get lifetime inverse:', e);
  }
};

const drawChart = () => {
  if (!chartCtx || projectionData.value.length === 0) return;

  const canvas = chartCanvas.value;
  const width = canvas.width;
  const height = canvas.height;
  const padding = { top: 30, right: 60, bottom: 40, left: 70 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  chartCtx.clearRect(0, 0, width, height);

  const data = projectionData.value;
  const maxPower = Math.max(...data.map(d => d.pu238_thermal_power_w)) * 1.05;
  const minPower = Math.min(...data.map(d => d.pu238_thermal_power_w)) * 0.95;
  const maxYears = props.projectionYears;

  const xScale = (x) => padding.left + (x / maxYears) * chartWidth;
  const yScale = (y) => padding.top + (1 - (y - minPower) / (maxPower - minPower)) * chartHeight;

  chartCtx.strokeStyle = 'rgba(0, 255, 136, 0.1)';
  chartCtx.lineWidth = 1;
  for (let i = 0; i <= 5; i++) {
    const y = padding.top + (i / 5) * chartHeight;
    chartCtx.beginPath();
    chartCtx.moveTo(padding.left, y);
    chartCtx.lineTo(width - padding.right, y);
    chartCtx.stroke();
  }

  for (let i = 0; i <= 6; i++) {
    const x = padding.left + (i / 6) * chartWidth;
    chartCtx.beginPath();
    chartCtx.moveTo(x, padding.top);
    chartCtx.lineTo(x, height - padding.bottom);
    chartCtx.stroke();
  }

  chartCtx.fillStyle = 'rgba(0, 255, 136, 0.5)';
  chartCtx.font = '11px "JetBrains Mono", monospace';
  chartCtx.textAlign = 'right';
  for (let i = 0; i <= 5; i++) {
    const power = maxPower - (i / 5) * (maxPower - minPower);
    const y = padding.top + (i / 5) * chartHeight;
    chartCtx.fillText((power / 1000).toFixed(1) + 'kW', padding.left - 8, y + 4);
  }

  chartCtx.textAlign = 'center';
  for (let i = 0; i <= 6; i++) {
    const year = (i / 6) * maxYears;
    const x = padding.left + (i / 6) * chartWidth;
    chartCtx.fillText(year.toFixed(0) + '年', x, height - padding.bottom + 20);
  }

  if (data[0]?.confidence_upper && data[0]?.confidence_lower) {
    chartCtx.beginPath();
    chartCtx.moveTo(xScale(data[0].years_from_now), yScale(data[0].confidence_upper));
    for (let i = 1; i < data.length; i++) {
      chartCtx.lineTo(xScale(data[i].years_from_now), yScale(data[i].confidence_upper));
    }
    for (let i = data.length - 1; i >= 0; i--) {
      chartCtx.lineTo(xScale(data[i].years_from_now), yScale(data[i].confidence_lower));
    }
    chartCtx.closePath();
    chartCtx.fillStyle = 'rgba(255, 140, 0, 0.1)';
    chartCtx.fill();
  }

  const gradient = chartCtx.createLinearGradient(0, padding.top, 0, height - padding.bottom);
  gradient.addColorStop(0, 'rgba(255, 100, 100, 0.3)');
  gradient.addColorStop(0.5, 'rgba(255, 200, 0, 0.2)');
  gradient.addColorStop(1, 'rgba(0, 255, 136, 0.1)');

  chartCtx.beginPath();
  chartCtx.moveTo(xScale(data[0].years_from_now), height - padding.bottom);
  for (let i = 0; i < data.length; i++) {
    chartCtx.lineTo(xScale(data[i].years_from_now), yScale(data[i].pu238_thermal_power_w));
  }
  chartCtx.lineTo(xScale(data[data.length - 1].years_from_now), height - padding.bottom);
  chartCtx.closePath();
  chartCtx.fillStyle = gradient;
  chartCtx.fill();

  chartCtx.beginPath();
  chartCtx.moveTo(xScale(data[0].years_from_now), yScale(data[0].pu238_thermal_power_w));
  for (let i = 1; i < data.length; i++) {
    const x0 = xScale(data[i - 1].years_from_now);
    const y0 = yScale(data[i - 1].pu238_thermal_power_w);
    const x1 = xScale(data[i].years_from_now);
    const y1 = yScale(data[i].pu238_thermal_power_w);
    const cx = (x0 + x1) / 2;
    chartCtx.quadraticCurveTo(x0, y0, cx, (y0 + y1) / 2);
  }
  chartCtx.strokeStyle = '#00ff88';
  chartCtx.lineWidth = 2.5;
  chartCtx.shadowColor = '#00ff88';
  chartCtx.shadowBlur = 10;
  chartCtx.stroke();
  chartCtx.shadowBlur = 0;

  if (hoverData.value) {
    const rulerX = xScale(rulerYears.value);
    const rulerY = yScale(hoverData.value.pu238_thermal_power_w);

    chartCtx.beginPath();
    chartCtx.arc(rulerX, rulerY, 8, 0, Math.PI * 2);
    chartCtx.fillStyle = '#ff8c00';
    chartCtx.shadowColor = '#ff8c00';
    chartCtx.shadowBlur = 15;
    chartCtx.fill();
    chartCtx.shadowBlur = 0;

    chartCtx.beginPath();
    chartCtx.arc(rulerX, rulerY, 4, 0, Math.PI * 2);
    chartCtx.fillStyle = '#ffffff';
    chartCtx.fill();
  }

  chartCtx.fillStyle = 'rgba(0, 255, 136, 0.3)';
  chartCtx.font = '10px "JetBrains Mono", monospace';
  chartCtx.textAlign = 'center';
  chartCtx.fillText('Pu-238 热功率 (kW)', width / 2, 15);
};

const resizeCanvas = () => {
  if (!chartCanvas.value) return;
  const container = chartCanvas.value.parentElement;
  const rect = container.getBoundingClientRect();
  chartCanvas.value.width = rect.width * window.devicePixelRatio;
  chartCanvas.value.height = rect.height * window.devicePixelRatio;
  chartCanvas.value.style.width = rect.width + 'px';
  chartCanvas.value.style.height = rect.height + 'px';
  chartCtx = chartCanvas.value.getContext('2d');
  chartCtx.scale(window.devicePixelRatio, window.devicePixelRatio);
  drawChart();
};

const loadProjectionData = async () => {
  loading.value = true;
  projectionData.value = [];

  try {
    const current = await props.grpcClient.getLifetimeInverse(props.deviceId, 0);
    currentMetrics.value = current;
    hoverData.value = current;

    const request = {
      device_id: props.deviceId,
      projection_years: props.projectionYears,
      data_points: props.dataPoints,
      include_confidence_band: true
    };

    streamCleanup = props.grpcClient.streamRTGLifetimeProjection(
      request,
      (point) => {
        projectionData.value.push(point);
        if (projectionData.value.length % 10 === 0 || projectionData.value.length === props.dataPoints) {
          drawChart();
        }
      },
      (err) => {
        loading.value = false;
        if (err) {
          console.error('Projection stream error:', err);
        } else {
          emit('dataLoaded', projectionData.value);
          drawChart();
          updateHoverData();
        }
      }
    );
  } catch (e) {
    console.error('Failed to load projection:', e);
    loading.value = false;
  }
};

watch(() => [props.projectionYears, props.dataPoints], () => {
  if (streamCleanup) {
    streamCleanup();
    streamCleanup = null;
  }
  loadProjectionData();
});

onMounted(() => {
  resizeCanvas();
  loadProjectionData();
  window.addEventListener('resize', resizeCanvas);
});

onUnmounted(() => {
  window.removeEventListener('resize', resizeCanvas);
  if (streamCleanup) {
    streamCleanup();
  }
  if (animationFrame) {
    cancelAnimationFrame(animationFrame);
  }
});
</script>

<style scoped>
.lifetime-panel {
  position: relative;
  background: linear-gradient(135deg, rgba(10, 20, 30, 0.95), rgba(5, 15, 25, 0.98));
  border: 1px solid rgba(0, 255, 136, 0.2);
  border-radius: 8px;
  padding: 16px;
  box-shadow: 0 0 30px rgba(0, 255, 136, 0.1);
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid rgba(0, 255, 136, 0.15);
}

.panel-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: #00ff88;
  font-family: "JetBrains Mono", monospace;
  letter-spacing: 1px;
}

.title-icon {
  margin-right: 8px;
  font-size: 18px;
}

.panel-stats {
  display: flex;
  gap: 20px;
}

.stat-item {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}

.stat-label {
  font-size: 10px;
  color: rgba(0, 255, 136, 0.5);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.stat-value {
  font-size: 14px;
  font-weight: 600;
  color: #ffffff;
  font-family: "JetBrains Mono", monospace;
}

.chart-container {
  position: relative;
  height: 280px;
  margin-bottom: 16px;
  background: rgba(0, 0, 0, 0.3);
  border-radius: 4px;
  border: 1px solid rgba(0, 255, 136, 0.1);
  overflow: hidden;
}

.projection-canvas {
  width: 100%;
  height: 100%;
  cursor: crosshair;
}

.timeline-ruler {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  pointer-events: none;
  z-index: 10;
}

.timeline-ruler .ruler-line {
  position: absolute;
  top: 0;
  bottom: 0;
  left: -1px;
  width: 2px;
  background: linear-gradient(to bottom, #ff8c00, #ff6b00);
  box-shadow: 0 0 10px rgba(255, 140, 0, 0.5);
  pointer-events: auto;
  cursor: ew-resize;
}

.ruler-handle {
  position: absolute;
  top: 5px;
  left: 50%;
  transform: translateX(-50%);
  background: #ff8c00;
  color: #000;
  padding: 2px 8px;
  border-radius: 3px;
  font-size: 10px;
  font-weight: 700;
  font-family: "JetBrains Mono", monospace;
  white-space: nowrap;
  box-shadow: 0 0 10px rgba(255, 140, 0, 0.5);
  pointer-events: auto;
  cursor: ew-resize;
}

.ruler-year {
  color: #000;
}

.ruler-tooltip {
  position: absolute;
  top: 40px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(0, 0, 0, 0.95);
  border: 1px solid rgba(255, 140, 0, 0.5);
  border-radius: 4px;
  padding: 10px;
  min-width: 220px;
  z-index: 100;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
}

.tooltip-row {
  display: flex;
  justify-content: space-between;
  padding: 3px 0;
  font-size: 11px;
  font-family: "JetBrains Mono", monospace;
}

.tooltip-label {
  color: rgba(0, 255, 136, 0.6);
}

.tooltip-value {
  color: #ffffff;
  font-weight: 600;
}

.tooltip-value.decay {
  color: #ff6b6b;
}

.tooltip-value.drop {
  color: #ff8c00;
}

.tooltip-value.payload {
  color: #00ff88;
}

.health-nominal { color: #00ff88 !important; }
.health-warning { color: #ffcc00 !important; }
.health-critical { color: #ff6b6b !important; }
.health-eol { color: #880808 !important; }

.timeline-controls {
  background: rgba(0, 0, 0, 0.3);
  border-radius: 4px;
  padding: 12px;
  margin-bottom: 16px;
  border: 1px solid rgba(0, 255, 136, 0.1);
}

.control-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.control-row + .control-row {
  margin-top: 12px;
}

.control-label {
  display: flex;
  justify-content: space-between;
  width: 140px;
  font-size: 12px;
  color: rgba(0, 255, 136, 0.7);
}

.control-value {
  color: #ffffff;
  font-weight: 600;
  font-family: "JetBrains Mono", monospace;
}

.timeline-slider {
  flex: 1;
  height: 6px;
  -webkit-appearance: none;
  appearance: none;
  background: rgba(0, 255, 136, 0.2);
  border-radius: 3px;
  outline: none;
}

.timeline-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 18px;
  height: 18px;
  background: #ff8c00;
  border-radius: 50%;
  cursor: pointer;
  box-shadow: 0 0 10px rgba(255, 140, 0, 0.5);
}

.timeline-slider::-moz-range-thumb {
  width: 18px;
  height: 18px;
  background: #ff8c00;
  border-radius: 50%;
  cursor: pointer;
  border: none;
  box-shadow: 0 0 10px rgba(255, 140, 0, 0.5);
}

.preset-buttons {
  gap: 6px;
  flex-wrap: wrap;
}

.preset-btn {
  padding: 4px 12px;
  background: rgba(0, 255, 136, 0.1);
  border: 1px solid rgba(0, 255, 136, 0.3);
  color: rgba(0, 255, 136, 0.8);
  border-radius: 3px;
  font-size: 11px;
  font-family: "JetBrains Mono", monospace;
  cursor: pointer;
  transition: all 0.2s;
}

.preset-btn:hover {
  background: rgba(0, 255, 136, 0.2);
  border-color: rgba(0, 255, 136, 0.5);
}

.preset-btn.active {
  background: rgba(0, 255, 136, 0.3);
  border-color: #00ff88;
  color: #00ff88;
}

.metrics-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  margin-bottom: 16px;
}

.metric-card {
  background: rgba(0, 0, 0, 0.4);
  border: 1px solid rgba(0, 255, 136, 0.15);
  border-radius: 6px;
  padding: 12px;
  display: flex;
  gap: 10px;
  transition: all 0.3s;
}

.metric-card:hover {
  border-color: rgba(0, 255, 136, 0.3);
  transform: translateY(-2px);
}

.metric-card.primary {
  background: linear-gradient(135deg, rgba(0, 255, 136, 0.1), rgba(0, 0, 0, 0.4));
  border-color: rgba(0, 255, 136, 0.25);
}

.metric-icon {
  font-size: 24px;
  line-height: 1;
}

.metric-content {
  flex: 1;
  min-width: 0;
}

.metric-title {
  font-size: 10px;
  color: rgba(0, 255, 136, 0.5);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 4px;
}

.metric-value {
  font-size: 18px;
  font-weight: 700;
  color: #ffffff;
  font-family: "JetBrains Mono", monospace;
  line-height: 1.2;
  margin-bottom: 4px;
}

.metric-value.decay {
  color: #ff6b6b;
}

.metric-sub {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.metric-trend {
  font-size: 11px;
  font-family: "JetBrains Mono", monospace;
  color: #00ff88;
}

.metric-trend.down {
  color: #ff8c00;
}

.metric-desc {
  font-size: 10px;
  color: rgba(255, 255, 255, 0.4);
}

.operational-notes {
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid rgba(0, 255, 136, 0.1);
  border-radius: 6px;
  padding: 12px;
}

.notes-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  font-size: 12px;
  font-weight: 600;
  color: rgba(0, 255, 136, 0.8);
}

.notes-icon {
  font-size: 14px;
}

.notes-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.note-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 4px;
  font-size: 11px;
}

.note-item.note-info {
  background: rgba(0, 255, 136, 0.1);
  border-left: 3px solid #00ff88;
}

.note-item.note-warning {
  background: rgba(255, 204, 0, 0.1);
  border-left: 3px solid #ffcc00;
}

.note-item.note-critical {
  background: rgba(255, 107, 107, 0.1);
  border-left: 3px solid #ff6b6b;
}

.note-icon {
  font-size: 14px;
  flex-shrink: 0;
}

.note-text {
  color: rgba(255, 255, 255, 0.8);
  line-height: 1.4;
}

.loading-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.8);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  border-radius: 8px;
  z-index: 100;
}

.loading-spinner {
  width: 40px;
  height: 40px;
  border: 3px solid rgba(0, 255, 136, 0.2);
  border-top-color: #00ff88;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

.loading-text {
  font-size: 13px;
  color: rgba(0, 255, 136, 0.8);
  font-family: "JetBrains Mono", monospace;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

@media (max-width: 1200px) {
  .metrics-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (max-width: 600px) {
  .metrics-grid {
    grid-template-columns: 1fr;
  }
  
  .panel-stats {
    display: none;
  }
  
  .preset-buttons {
    justify-content: flex-start;
  }
}
</style>
