import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const alias = { '@': fileURLToPath(new URL('.', import.meta.url)) };
const exclude = ['node_modules/**', '.next/**', 'e2e/**', 'playwright-report/**', 'test-results/**', 'deploy-check/**', 'reference/**', 'graphify-out/**', '.superpowers/**'];

export default defineConfig({
  test: {
    projects: [
      {
        // Everything except the portal UI kit; component tests there opt into jsdom with a docblock.
        extends: true,
        resolve: { alias },
        test: { name: 'app', environment: 'node', include: ['**/*.test.ts', '**/*.test.tsx'], exclude: [...exclude, 'ui/**'] },
      },
      {
        // ui/ : jsdom, jest-dom matchers, automatic cleanup.
        extends: true,
        resolve: { alias },
        test: {
          name: 'ui',
          environment: 'jsdom',
          globals: true,
          include: ['ui/**/*.test.tsx'],
          exclude,
          setupFiles: ['./ui/test-setup.ts'],
        },
      },
    ],
  },
});
