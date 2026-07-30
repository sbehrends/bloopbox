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
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/tests/**', 'src/processes/**', 'src/hal/gpioDriver.ts'],
      thresholds: {
        /* Core domain logic is pure and must stay well covered. Process wiring
           and the unverifiable GPIO driver are excluded above. */
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },
  },
});
