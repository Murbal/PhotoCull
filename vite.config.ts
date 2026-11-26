import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { handleApiRequest } from './server/index.js';

/**
 * Serves `/api/*` directly inside Vite's dev server so opening http://127.0.0.1:5173
 * in a browser (or running `vite` standalone) works immediately without a separate proxy port.
 * In Electron, the renderer uses native IPC + `photocull://` protocol directly.
 */
function photoCullApiMiddleware(): Plugin {
  return {
    name: 'photocull-api-middleware',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/api/')) {
          next();
          return;
        }
        void handleApiRequest(req, res).catch(next);
      });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss(), photoCullApiMiddleware()],
  server: {
    port: 5173,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    target: 'es2022',
  },
});
