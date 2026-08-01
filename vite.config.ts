import { defineConfig } from 'vite';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, 'public');

export default defineConfig({
  root,
  build: {
    outDir: resolve(import.meta.dirname, 'dist/public'),
    emptyOutDir: true,
    /* Vite 8 bundles with Rolldown; `rollupOptions` is deprecated. */
    rolldownOptions: {
      input: {
        admin: resolve(root, 'admin/index.html'),
        simulator: resolve(root, 'simulator/index.html'),
        portal: resolve(root, 'portal/index.html'),
        /* The brand kit ships with the device on purpose: it is static HTML with no JS, it
           loads the same two stylesheets the other three pages do, and a style guide that
           is not built alongside what it documents is a style guide that rots. */
        brand: resolve(root, 'brand/index.html'),
      },
    },
  },
  server: {
    port: 5174,
    /* `npm run dev:web` gives HMR for the UIs while the real hardware server
       owns :3000 for the API and Socket.io. */
    proxy: {
      '/api': 'http://localhost:3000',
      '/socket.io': { target: 'http://localhost:3000', ws: true },
      /* Cues and recorded notes are served by the hardware server. Without these the
         simulator plays nothing at all here: every `sim:play` 404s, the browser reports a
         playback error, and a queue that cannot play never clears its light. */
      '/sounds': 'http://localhost:3000',
      '/audio': 'http://localhost:3000',
    },
  },
});
