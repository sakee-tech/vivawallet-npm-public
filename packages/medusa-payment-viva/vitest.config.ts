import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // medusaIntegrationTestRunner calls describe/beforeAll/beforeEach/afterEach
    // as globals — enable them. Existing suites import from 'vitest' explicitly
    // and coexist with globals enabled.
    globals: true,
    // The integration boot test starts a full Medusa app (migrations + boot),
    // which is well beyond the default 5s hook/test timeouts.
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
