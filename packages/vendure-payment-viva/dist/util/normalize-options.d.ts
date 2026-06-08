/**
 * util/normalize-options.ts — input validation + back-compat handling for
 * `VivaPaymentPlugin.init()`.
 *
 * Takes the loose `VivaPaymentPluginInitInput` shape (which accepts deprecated
 * field aliases and an optional `mode`) and returns the strict discriminated
 * `VivaPaymentPluginOptions` union.
 *
 * Responsibilities:
 *  1. Resolve deprecated `isvClientId`/`isvClientSecret` → `clientId`/`clientSecret`,
 *     with one-time deprecation warnings.
 *  2. Resolve `mode`: default to `'merchant'` (with a warning), or auto-detect
 *     `'isv'` when ISV-only fields are present (no warning — strong hint).
 *  3. Warn (don't throw) when merchant mode is paired with ISV-only resolvers.
 *  4. Throw a single aggregated error if required fields are missing.
 *
 * Mirrors `medusa-payment-viva/src/config.ts` defaulting + back-compat behaviour
 * (multi-mode-v0 plan §5, §10).
 */
import type { VivaPaymentPluginInitInput, VivaPaymentPluginOptions } from '../types.js';
/** @internal Test-only: reset all one-time warning latches. */
export declare function _resetInitNoticesForTesting(): void;
export declare function normalizePluginOptions(input: VivaPaymentPluginInitInput): VivaPaymentPluginOptions;
//# sourceMappingURL=normalize-options.d.ts.map