import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

export default defineConfig({
  // esbuild (vitest's default TS transform) does NOT emit `design:paramtypes`
  // decorator metadata, which NestJS DI relies on for type-based constructor
  // injection. Without it, booting the plugin inside a real Vendure app fails
  // to resolve injected core services (OrderService, etc.) regardless of
  // wiring. swc emits the metadata, matching what `tsc` produces for the
  // shipped dist (tsconfig: emitDecoratorMetadata=true) — so the boot smoke
  // test exercises DI faithfully. See test/plugin/boots-in-vendure.test.ts.
  plugins: [
    swc.vite({
      jsc: {
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
        target: 'es2022',
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    globals: false,
  },
});
