import { defineConfig, type Plugin } from 'vite';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, 'public');

/**
 * Fails the build if the named entry imports any other chunk.
 *
 * The captive portal runs in a phone's captive-network sheet, a webview where anything beyond the
 * page's own script is one more request that can stall (`docs/architecture.md`, "The portal is
 * deliberately not on that contract"). Rolldown hoists code two entries share into a common
 * chunk on its own, so the portal stays self-contained only by never importing what the panel
 * imports. This checks the output rather than trusting that.
 */
function selfContainedEntry(entry: string): Plugin {
  return {
    name: 'bloopbox:self-contained-entry',
    apply: 'build',
    /* After Vite's own CSS plugin, which drops the empty JS chunk a CSS-only import leaves. */
    enforce: 'post',
    generateBundle(_options, bundle) {
      const chunk = Object.values(bundle).find(
        (output) => output.type === 'chunk' && output.isEntry && output.name === entry,
      );
      if (chunk?.type !== 'chunk') {
        this.error(`no entry chunk named "${entry}" in the bundle`);
      }
      const shared = [...chunk.imports, ...chunk.dynamicImports];
      if (shared.length > 0) {
        this.error(
          `the ${entry} page must load no shared chunk, but its script imports ${shared.join(', ')}`,
        );
      }
    },
  };
}

export default defineConfig({
  root,
  plugins: [selfContainedEntry('portal')],
  build: {
    outDir: resolve(import.meta.dirname, 'dist/public'),
    emptyOutDir: true,
    /* Every browser the panel supports has native modulepreload. The polyfill was the one chunk
       all four pages shared, the portal included. */
    modulePreload: { polyfill: false },
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
