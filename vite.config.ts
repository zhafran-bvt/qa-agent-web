import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const backendPort = Number(process.env.QA_AGENT_PORT || process.env.PORT || 5174);

export default defineConfig({
  plugins: [react()],
  publicDir: false,
  build: {
    outDir: 'client-dist',
    emptyOutDir: true,
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': `http://localhost:${backendPort}`,
      '/auth': `http://localhost:${backendPort}`,
    },
  },
});
