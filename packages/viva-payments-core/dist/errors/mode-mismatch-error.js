"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VivaModeMismatchError = void 0;
const base_js_1 = require("./base.js");
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
class VivaModeMismatchError extends base_js_1.VivaError {
    code = 'VIVA_MODE_MISMATCH';
    constructor(opts) {
        super(opts);
        this.name = 'VivaModeMismatchError';
    }
}
exports.VivaModeMismatchError = VivaModeMismatchError;
//# sourceMappingURL=mode-mismatch-error.js.map