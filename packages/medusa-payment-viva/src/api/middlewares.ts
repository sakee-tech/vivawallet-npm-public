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

import type { MedusaNextFunction, MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { defineMiddlewares } from '@medusajs/framework/http';

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
export function vivaWebhookRawBodyMiddleware() {
  return function captureRawBody(
    req: MedusaRequest,
    _res: MedusaResponse,
    next: MedusaNextFunction,
  ): void {
    const chunks: Buffer[] = [];

    req.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    req.on('end', () => {
      req.rawBody = Buffer.concat(chunks);
      next();
    });

    req.on('error', (err: Error) => {
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

export default defineMiddlewares([
  {
    matcher: '/viva/webhook',
    methods: ['POST'],
    bodyParser: false,
    middlewares: [vivaWebhookRawBodyMiddleware()],
  },
]);
