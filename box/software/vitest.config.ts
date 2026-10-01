import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/tests/**/*.test.ts'],
    /* Every timing-sensitive suite (LED patterns, debounce, purge TTL) runs on
       fake timers. Real sleeps would make the suite slow and flaky. */
    clearMocks: true,
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      /* The gate (`npm run check`) runs with coverage on every commit, so the default report is
         the four-line summary. `npm run test:coverage` asks for the full table and the HTML. */
      reporter: ['text-summary'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/tests/**',
        /* Composition roots: wiring, exercised on the device and by the release smoke test. */
        'src/processes/**',
        /* The simulator's Socket.io microphone and buttons. Development-only, and driven by a
           browser. */
        'src/server/simulatorTransport.ts',
      ],
      /*
       * A ratchet, not a target: each is today's figure rounded down. A change that lowers one
       * fails the gate; when a change raises one, raise the number here in the same commit.
       */
      thresholds: {
        statements: 91,
        branches: 83,
        functions: 89,
        lines: 92,
      },
    },
  },
});
