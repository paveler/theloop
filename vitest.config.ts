import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // modules that log before createEngine sets the level would otherwise print to the test output
    env: { LOG_LEVEL: 'silent' },
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
})
