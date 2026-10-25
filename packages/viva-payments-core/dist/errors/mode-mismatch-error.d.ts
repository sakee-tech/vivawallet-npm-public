import { VivaError, type VivaErrorOptions } from './base.js';
/**
 * Thrown when a code path is invoked under the wrong plugin mode.
 *
 * Example: an ISV-only endpoint (e.g. POST /api/sources, the Connected
 * Accounts webhook subscriber, the ISV tenant resolver) is invoked while
 * `VivaPluginConfig.mode === 'merchant'`. Or, in a future merchant-only
 * code path, while `mode === 'isv'`.
 *
 * Plan multi-mode-v0 §5 (config shape) + §10.1 (Vendure parallel).
 * Migration 0.1→0.2 §2.2.
 *
 * Maps to `MedusaError(Types.NOT_ALLOWED)` in the adapter layer.
 */
export declare class VivaModeMismatchError extends VivaError {
    readonly code: "VIVA_MODE_MISMATCH";
    constructor(opts: VivaErrorOptions);
}
//# sourceMappingURL=mode-mismatch-error.d.ts.map