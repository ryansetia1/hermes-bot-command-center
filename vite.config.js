import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const presencePort = process.env.PRESENCE_PORT || '8787'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/presence': `http://127.0.0.1:${presencePort}`,
      '/hermes-pets': `http://127.0.0.1:${presencePort}`,
      '/hermes-avatars': `http://127.0.0.1:${presencePort}`,
      '/roster': `http://127.0.0.1:${presencePort}`,
      '/events': `http://127.0.0.1:${presencePort}`,
    },
  },
})
