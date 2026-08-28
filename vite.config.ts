import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

const apiProxy = {
  '/api': {
    target: `http://127.0.0.1:${process.env.PORT ?? 8787}`,
    changeOrigin: false,
  },
}

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  // `vite preview` has its own proxy config, so a production build served
  // here reaches the API exactly as the dev server does.
  preview: { port: 4173, proxy: apiProxy },
  // The API runs separately (`npm run server`). Proxying keeps the browser
  // on one origin, so there is no CORS in dev and relative `/api/...` URLs
  // work unchanged in a production build behind a reverse proxy.
  server: { port: 5173, open: false, proxy: apiProxy },
})
