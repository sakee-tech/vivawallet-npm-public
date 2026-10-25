"use strict";
/**
 * api/index.ts — barrel re-export for Medusa v2 API route registration.
 *
 * Medusa v2 file-based routing convention: the framework scans `src/api/`
 * for `route.ts` files and mounts them at the path matching the directory
 * structure. `middlewares.ts` at the root of `src/api/` is auto-loaded as the
 * middleware configuration for all routes in this API tree.
 *
 * - `src/api/middlewares.ts`            → middleware config (raw body capture)
 * - `src/api/viva/webhook/route.ts`     → GET + POST handlers at /viva/webhook
 *
 * @see @medusajs/framework dist/http/router.d.ts (ApiLoader file-based convention)
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.middlewares = void 0;
var middlewares_js_1 = require("./middlewares.js");
Object.defineProperty(exports, "middlewares", { enumerable: true, get: function () { return __importDefault(middlewares_js_1).default; } });
//# sourceMappingURL=index.js.map