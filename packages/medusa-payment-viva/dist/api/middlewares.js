"use strict";
/**
 * middlewares.ts — Medusa v2 middleware registration for the Viva webhook route.
 *
 * Captures raw request body as Buffer before JSON body-parser runs, so the POST
 * webhook handler can read the unmodified bytes from `req.rawBody`.
 *
 * Convention used: `defineMiddlewares()` from `@medusajs/framework/http`, which
 * is the standard Medusa v2 plugin middleware pattern.
 *
 * @see references/viva-docs/md/webhooks-for-payments.txt:254 (webhook security model P7)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.vivaWebhookRawBodyMiddleware = vivaWebhookRawBodyMiddleware;
const http_1 = require("@medusajs/framework/http");
// ---------------------------------------------------------------------------
// Raw body capture middleware
// ---------------------------------------------------------------------------
/**
 * Express middleware that captures the raw request body as a Buffer.
 * Must run BEFORE any JSON body-parser so the unmodified bytes are available
 * to the webhook POST handler for JSON parsing.
 *
 * Attaches the Buffer to `req.rawBody`. Medusa's MedusaRequest type already
 * declares `rawBody?: any`, so no augmentation is needed.
 */
function vivaWebhookRawBodyMiddleware() {
    return function captureRawBody(req, _res, next) {
        const chunks = [];
        req.on('data', (chunk) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        req.on('end', () => {
            req.rawBody = Buffer.concat(chunks);
            next();
        });
        req.on('error', (err) => {
            next(err);
        });
    };
}
// ---------------------------------------------------------------------------
// Middleware registration (Medusa v2 convention)
//
// Medusa v2 loads `src/api/middlewares.ts` and calls the default export to
// obtain a MiddlewaresConfig. `defineMiddlewares` validates and types the config.
//
// `bodyParser: false` disables Medusa's built-in JSON parser for the POST route
// so we control body consumption ourselves in the raw-body middleware.
// ---------------------------------------------------------------------------
exports.default = (0, http_1.defineMiddlewares)([
    {
        matcher: '/viva/webhook',
        methods: ['POST'],
        bodyParser: false,
        middlewares: [vivaWebhookRawBodyMiddleware()],
    },
]);
//# sourceMappingURL=middlewares.js.map