<template>
  <div class="panel" style="height: 100%; display: flex; flex-direction: column;">
    <div class="corner-mark corner-tl"></div>
    <div class="corner-mark corner-tr"></div>
    <div class="corner-mark corner-bl"></div>
    <div class="corner-mark corner-br"></div>
    <div class="panel-header">
      <div class="panel-title">
        {{ title }}
      </div>
      <div class="panel-tag">
        <span class="led" :class="ledClass" style="vertical-align: middle;"></span>
        &nbsp;{{ subtitle }}
      </div>
    </div>
    <div class="panel-body power-display" style="flex: 1; display: flex; flex-direction: column; justify-content: center;">
      <div class="power-number">
        <span>{{ integerPart }}</span>
        <span class="power-decimal">.{{ decimalPart }}</span>
        <span class="power-unit">{{ unit }}</span>
      </div>
      <div class="power-label">{{ description }}</div>
      <div style="margin-top: 14px; display: flex; justify-content: center; gap: 30px;">
        <div v-for="(s, i) in subStats" :key="i" style="text-align: center;">
          <div style="font-size: 9px; color: var(--text-muted); letter-spacing: 1.5px; text-transform: uppercase;">{{ s.label }}</div>
          <div style="font-size: 16px; font-weight: 700; font-variant-numeric: tabular-nums; color: #b388ff; margin-top: 3px; text-shadow: 0 0 8px rgba(179, 136, 255, 0.3);">
            {{ s.value }} <span style="font-size: 10px; font-weight: 500; color: var(--text-secondary);">{{ s.unit }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue';

const props = defineProps({
  value: { type: Number, default: 0 },
  title: { type: String, default: 'Pu-238 热功率' },
  subtitle: { type: String, default: '实时测量' },
  unit: { type: String, default: 'W' },
  description: { type: String, default: 'Pu-238 THERMAL POWER OUTPUT · LIVE' },
  status: { type: String, default: 'nominal' },
  subStats: { type: Array, default: () => [] }
});

const displayed = ref(0);
let rafId = null;
let lastTarget = 0;
let lastTime = 0;

const ledClass = computed(() => {
  return { nominal: 'led-green', warning: 'led-orange', critical: 'led-red' }[props.status] || 'led-cyan';
});

const integerPart = computed(() => {
  const v = Math.max(0, displayed.value);
  return Math.floor(v).toString().padStart(4, '0');
});

const decimalPart = computed(() => {
  const v = Math.max(0, displayed.value);
  const dec = Math.floor((v - Math.floor(v)) * 100);
  return dec.toString().padStart(2, '0');
});

function animate(now) {
  const dt = Math.min(0.1, (now - lastTime) / 1000 || 0.016);
  lastTime = now;
  const target = props.value;
  const diff = target - displayed.value;
  const k = 18;
  displayed.value += diff * (1 - Math.exp(-k * dt));
  rafId = requestAnimationFrame(animate);
}

onMounted(() => {
  lastTarget = props.value;
  displayed.value = props.value;
  lastTime = performance.now();
  rafId = requestAnimationFrame(animate);
});

onBeforeUnmount(() => {
  if (rafId) cancelAnimationFrame(rafId);
});
</script>
