import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative paths so the build works from any GitHub Pages sub-path.
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
  },
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
