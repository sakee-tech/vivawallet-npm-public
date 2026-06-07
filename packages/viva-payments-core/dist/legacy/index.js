/**
 * viva-payments-core/legacy — barrel export.
 *
 * Subpath: `viva-payments-core/legacy`
 *
 * BasicAuthClient covers Viva's legacy host endpoints (Basic auth +
 * MerchantId/ApiKey). Currently the only path that works for refunds —
 * Viva returns 405 on the v2/OAuth2 refund route.
 *
 * @see references/viva-docs/md/tut-create-recurring-payment.txt:288
 * @see references/viva-docs/md/merchant-id-and-api-key.txt:1
 */
export { BasicAuthClient } from './client.js';
//# sourceMappingURL=index.js.map