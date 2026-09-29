import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve:{
    tsconfigPaths: true,
  },
  // Resolves the path aliases declared in tsconfig.json, including the ones
  // added by `nest g library`.
  test: {
    globals: true,
    root: './',
    include: ['**/*.spec.ts'],
  },
});
