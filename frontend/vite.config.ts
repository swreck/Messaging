import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [
    react(),
    // In dev mode, swap icons to local-badge versions so Ken can
    // distinguish local from production at a glance on any device.
    {
      name: 'local-dev-icons',
      transformIndexHtml(html) {
        if (process.env.NODE_ENV === 'production') return html;
        return html
          .replace('/icon-32.png', '/icon-32-local.png')
          .replace('/apple-touch-icon.png', '/apple-touch-icon-local.png')
          .replace('/manifest.json', '/manifest-local.json');
      },
    },
  ],
  server: {
    port: 5173,
    host: true, // Bind to all network interfaces (0.0.0.0) for iPhone/iPad access
    proxy: {
      '/api': {
        target: 'http://localhost:3002',
        changeOrigin: true,
      },
    },
  },
})
