import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: { environment: 'node', include: ['**/*.test.ts', '**/*.test.tsx'], exclude: ['node_modules', '.next'] },
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
});
