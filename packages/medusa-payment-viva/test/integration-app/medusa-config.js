/**
 * test/integration-app/medusa-config.js — fixture Medusa app for the
 * boots-in-medusa integration test (#21 DI verification).
 *
 * CJS, not TS: medusaIntegrationTestRunner loads this via a plain `require()`
 * (no TS register), so the fixture and its imports must be CJS-resolvable. The
 * package dist is CJS, so requiring the package entry works.
 *
 * Registers @medusajs/payment with the Viva provider AND loads the package as a
 * plugin (so its loaders/subscribers/api routes run). The runner manages the
 * test database and overrides the DB connection, so projectConfig only carries
 * the secrets.
 *
 * The viva-config module is loaded with __passSharedContainer: true so its
 * loader can resolve the root Medusa container (sharedContainer) and register
 * vivaPluginConfig + vivaOAuth2Strategy on it at boot.
 */

const path = require('path');
const { defineConfig } = require('@medusajs/framework/utils');
const { loadConfigFromEnv } = require('@sakeetech/medusa-payment-viva');

module.exports = defineConfig({
  projectConfig: {
    http: {
      jwtSecret: 'test-jwt-secret',
      cookieSecret: 'test-cookie-secret',
    },
  },
  plugins: [
    {
      resolve: '@sakeetech/medusa-payment-viva',
      options: {},
    },
  ],
  modules: [
    {
      resolve: '@medusajs/medusa/payment',
      options: {
        providers: [
          {
            resolve: '@sakeetech/medusa-payment-viva',
            id: 'viva',
            options: { config: loadConfigFromEnv(process.env) },
          },
        ],
      },
    },
    {
      resolve: path.resolve(
        __dirname,
        '../../.medusa/server/src/modules/viva-config',
      ),
    },
  ],
});
