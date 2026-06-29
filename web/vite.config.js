import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'

// Read the app version from the root package.json so the UI can display it.
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)))

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    // Env-overridable so an isolated preview instance can use its own ports.
    port: Number(process.env.VITE_PORT) || 5173,
    strictPort: false,
    // Proxy API calls to the Node backend during dev.
    proxy: { '/api': process.env.VITE_API_TARGET || 'http://localhost:5174' },
  },
})
