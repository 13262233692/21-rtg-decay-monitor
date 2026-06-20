import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/rtgmonitor.RTGMonitorService': {
        target: 'http://localhost:8081',
        ws: true,
        changeOrigin: true
      }
    }
  }
})
