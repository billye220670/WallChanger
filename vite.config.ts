import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const BACKEND = 'http://localhost:8100'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // v2 API routes
      '/api': {
        target: BACKEND,
        changeOrigin: true,
      },
      // legacy / utility routes
      '/health': {
        target: BACKEND,
        changeOrigin: true,
      },
      '/enhance': {
        target: BACKEND,
        changeOrigin: true,
      },
      '/process-masks': {
        target: BACKEND,
        changeOrigin: true,
      },
      '/process-upload': {
        target: BACKEND,
        changeOrigin: true,
      },
      '/debug-segment': {
        target: BACKEND,
        changeOrigin: true,
      },
      '/apply-material': {
        target: BACKEND,
        changeOrigin: true,
      },
      '/finalize': {
        target: BACKEND,
        changeOrigin: true,
      },
    },
  },
})
