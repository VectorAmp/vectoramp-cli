import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    reporters: [
      ['default', { summary: false }],
      ['junit', { outputFile: 'junit.xml' }]
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      reporter: ['text', 'lcov', 'cobertura']
    }
  }
});
