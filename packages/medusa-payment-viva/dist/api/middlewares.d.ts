/**
 * middlewares.ts — Medusa v2 middleware registration for the Viva webhook route.
 *
 * Captures raw request body as Buffer before JSON body-parser runs.
 * Required for HMAC-SHA256 signature verification of event 7936.
 *
 * Convention used: `defineMiddlewares()` from `@medusajs/framework/http`, which
 * is the standard Medusa v2 plugin middleware pattern.
 *
 * @see references/viva-docs/md/webhooks-for-payments.txt:254 (webhook security model P7)
 * @see references/viva-docs/md/wh-sale-transactions.txt:149 (HMAC raw body requirement)
 */
import type { MedusaNextFunction, MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
/**
 * Express middleware that captures the raw request body as a Buffer.
 * Must run BEFORE any JSON body-parser so the unmodified bytes are available
 * for HMAC-SHA256 signature verification (event 7936).
 *
 * Attaches the Buffer to `req.rawBody`. Medusa's MedusaRequest type already
 * declares `rawBody?: any`, so no augmentation is needed.
 *
 * @see references/viva-docs/md/wh-sale-transactions.txt:149 (HMAC raw bytes)
 */
export declare function vivaWebhookRawBodyMiddleware(): (req: MedusaRequest, _res: MedusaResponse, next: MedusaNextFunction) => void;
declare const _default: import("@medusajs/framework/http").MiddlewaresConfig;
export default _default;
//# sourceMappingURL=middlewares.d.ts.map