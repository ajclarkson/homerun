import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    exclude: ['dist/**'],
    // Compile-time guarantees (declared reasons narrowing `reason`) are asserted in *.test-d.ts.
    typecheck: { enabled: true, include: ['src/**/*.test-d.ts'] },
  },
});
