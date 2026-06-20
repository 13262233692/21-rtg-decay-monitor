<template>
  <div class="panel" style="height: 100%; display: flex; flex-direction: column;">
    <div class="corner-mark corner-tl"></div>
    <div class="corner-mark corner-tr"></div>
    <div class="corner-mark corner-bl"></div>
    <div class="corner-mark corner-br"></div>
    <div class="panel-header">
      <div class="panel-title">热电偶电压脉动 · THERMOCOUPLE WAVEFORM</div>
      <div class="panel-tag">800 Hz · mV</div>
    </div>
    <div class="panel-body" style="flex: 1; padding: 10px; min-height: 0;">
      <div class="waveform-container">
        <canvas ref="canvasEl" class="waveform-canvas"></canvas>
        <div class="waveform-legend">
          <div><span style="color: var(--accent-cyan);">━━</span> 实时电压 V(t)</div>
          <div><span style="color: var(--accent-yellow); opacity: 0.5;">╌╌</span> 基线 V₀</div>
          <div><span style="color: var(--accent-green); opacity: 0.6;">┈┈</span> ±1σ 包络</div>
        </div>
        <div class="waveformform-stats" style="position: absolute; bottom: 10px; left: 14px; font-size: 10px; display: flex; gap: 16px; color: var(--text-muted);">
          <span>MAX <b style="color: var(--text-primary); font-variant-numeric: tabular-nums;">{{ stats.max.toFixed(4) }}mV</b></span>
          <span>MIN <b style="color: var(--text-primary); font-variant-numeric: tabular-nums;">{{ stats.min.toFixed(4) }}mV</b></span>
          <span>ΔV <b style="color: var(--accent-cyan); font-variant-numeric: tabular-nums;">{{ (stats.max - stats.min).toFixed(4) }}mV</b></span>
          <span>σ <b style="color: var(--accent-green); font-variant-numeric: tabular-nums;">{{ stats.std.toFixed(4) }}mV</b></span>
          <span>DC <b style="color: var(--accent-yellow); font-variant-numeric: tabular-nums;">{{ stats.mean.toFixed(3) }}mV</b></span>
          <span>FPS <b style="color: var(--text-secondary); font-variant-numeric: tabular-nums;">{{ fps }}</b></span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount, watch } from 'vue';

const props = defineProps({
  samples: { type: Array, default: () => [] }
});

const canvasEl = ref(null);
const stats = ref({ max: 0, min: 0, std: 0, mean: 0 });
const fps = ref(0);

let ctx = null;
let rafId = null;
let resizeObs = null;
let lastDrawTime = 0;
let frameCount = 0;
let fpsTime = 0;

function resizeCanvas() {
  const canvas = canvasEl.value;
  if (!canvas) return;
  const ratio = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.floor(rect.width * ratio);
  canvas.height = Math.floor(rect.height * ratio);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
}

function setupResize() {
  const canvas = canvasEl.value;
  if (!canvas) return;
  resizeObs = new ResizeObserver(() => resizeCanvas());
  resizeObs.observe(canvas);
  resizeCanvas();
}

function computeStats(arr) {
  if (!arr.length) return { max: 0, min: 0, mean: 0, std: 0 };
  let max = -Infinity, min = Infinity, sum = 0;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (v > max) max = v;
    if (v < min) min = v;
    sum += v;
  }
  const mean = sum / arr.length;
  let sq = 0;
  for (let i = 0; i < arr.length; i++) {
    const d = arr[i] - mean;
    sq += d * d;
  }
  const std = Math.sqrt(sq / arr.length);
  return { max, min, mean, std };
}

function draw() {
  const canvas = canvasEl.value;
  if (!canvas || !ctx) { rafId = requestAnimationFrame(draw); return; }
  const rect = canvas.getBoundingClientRect();
  const W = rect.width;
  const H = rect.height;

  const now = performance.now();
  frameCount++;
  if (now - fpsTime >= 500) {
    fps.value = Math.round(frameCount * 1000 / (now - fpsTime));
    fpsTime = now;
    frameCount = 0;
  }
  lastDrawTime = now;

  ctx.clearRect(0, 0, W, H);

  ctx.fillStyle = 'rgba(10, 14, 20, 0.6)';
  ctx.fillRect(0, 0, W, H);

  const data = props.samples;
  const s = computeStats(data);
  stats.value = s;

  const marginLeft = 54;
  const marginRight = 12;
  const marginTop = 12;
  const marginBottom = 28;
  const plotW = W - marginLeft - marginRight;
  const plotH = H - marginTop - marginBottom;

  const range = Math.max(s.max - s.min, 0.05);
  const pad = range * 0.18;
  const yMin = s.min - pad;
  const yMax = s.max + pad;
  const ySpan = yMax - yMin;

  ctx.strokeStyle = 'rgba(42, 64, 96, 0.5)';
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  for (let i = 0; i <= 8; i++) {
    const y = marginTop + (plotH * i / 8);
    ctx.moveTo(marginLeft, y);
    ctx.lineTo(marginLeft + plotW, y);
  }
  for (let i = 0; i <= 10; i++) {
    const x = marginLeft + (plotW * i / 10);
    ctx.moveTo(x, marginTop);
    ctx.lineTo(x, marginTop + plotH);
  }
  ctx.stroke();

  ctx.strokeStyle = 'rgba(255, 212, 0, 0.15)';
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  const baseY = ySpan > 0 ? (marginTop + plotH * (1 - (s.mean - yMin) / ySpan)) : (marginTop + plotH / 2);
  ctx.moveTo(marginLeft, baseY);
  ctx.lineTo(marginLeft + plotW, baseY);
  ctx.stroke();

  ctx.font = '9px Consolas, monospace';
  ctx.fillStyle = '#4d647f';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 5; i++) {
    const frac = i / 5;
    const val = yMin + ySpan * (1 - frac);
    const y = marginTop + plotH * frac;
    ctx.fillText(val.toFixed(2) + 'm', marginLeft - 6, y);
  }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const N = data.length;
  if (N >= 2) {
    const windowSec = (N / 800);
    for (let i = 0; i <= 5; i++) {
      const frac = i / 5;
      const t = windowSec * frac;
      const x = marginLeft + plotW * frac;
      ctx.fillText((-windowSec + t).toFixed(1) + 's', x, marginTop + plotH + 6);
    }
  }

  ctx.fillStyle = 'rgba(10, 14, 20, 0.4)';
  ctx.fillRect(marginLeft, marginTop, plotW, plotH);

  if (N >= 2) {
    if (s.std > 0.0001) {
      const stdY1 = marginTop + plotH * (1 - (s.mean + s.std - yMin) / ySpan);
      const stdY2 = marginTop + plotH * (1 - (s.mean - s.std - yMin) / ySpan);
      ctx.fillStyle = 'rgba(0, 230, 118, 0.06)';
      ctx.fillRect(marginLeft, Math.min(stdY1, stdY2), plotW, Math.abs(stdY2 - stdY1));
      ctx.strokeStyle = 'rgba(0, 230, 118, 0.35)';
      ctx.lineWidth = 0.5;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(marginLeft, stdY1);
      ctx.lineTo(marginLeft + plotW, stdY1);
      ctx.moveTo(marginLeft, stdY2);
      ctx.lineTo(marginLeft + plotW, stdY2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.strokeStyle = 'rgba(0, 229, 255, 0.9)';
    ctx.lineWidth = 1.2;
    ctx.shadowColor = 'rgba(0, 229, 255, 0.4)';
    ctx.shadowBlur = 6;
    ctx.beginPath();
    const stepX = plotW / (N - 1);
    for (let i = 0; i < N; i++) {
      const x = marginLeft + plotW - stepX * i;
      const idx = N - 1 - i;
      const y = marginTop + plotH * (1 - (data[idx] - yMin) / ySpan);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;

    ctx.strokeStyle = 'rgba(0, 229, 255, 0.15)';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    for (let i = 0; i < N; i++) {
      const x = marginLeft + plotW - stepX * i;
      const idx = N - 1 - i;
      const y = marginTop + plotH * (1 - (data[idx] - yMin) / ySpan);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    const lastV = data[N - 1];
    const lastY = marginTop + plotH * (1 - (lastV - yMin) / ySpan);
    ctx.fillStyle = '#00e5ff';
    ctx.shadowColor = 'rgba(0, 229, 255, 0.8)';
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(marginLeft + plotW, lastY, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.fillStyle = '#00e5ff';
    ctx.font = 'bold 10px Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(lastV.toFixed(3) + ' mV', marginLeft + plotW - 80, lastY - 6);
  }

  ctx.strokeStyle = 'rgba(0, 229, 255, 0.25)';
  ctx.lineWidth = 0.5;
  ctx.strokeRect(marginLeft, marginTop, plotW, plotH);

  rafId = requestAnimationFrame(draw);
}

onMounted(() => {
  ctx = canvasEl.value.getContext('2d');
  setupResize();
  rafId = requestAnimationFrame(draw);
});

onBeforeUnmount(() => {
  if (rafId) cancelAnimationFrame(rafId);
  if (resizeObs) resizeObs.disconnect();
});
</script>
