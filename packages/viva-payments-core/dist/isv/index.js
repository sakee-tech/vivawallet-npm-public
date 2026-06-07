/**
 * viva-payments-core/isv — barrel export.
 *
 * Subpath: `viva-payments-core/isv`
 *
 * Exports the ISV-specific API client classes (Accounts, Webhooks) and the
 * shared HTTP client. Also re-exports `Payments` and `BasicAuthClient` under
 * their previous names (`IsvPayments`, `LegacyBasicClient`) as deprecated
 * aliases for one-minor back-compat — these will be removed in 0.3.0.
 *
 * @see references/viva-docs/md/isv-partner-program.txt:104
 * @see references/viva-docs/md/payment-isv-api.txt:1
 */
export { IsvHttpClient } from './client.js';
export { IsvAccounts } from './accounts.js';
export { IsvWebhooks } from './webhooks-api.js';
export { IsvSources } from './sources.js';
import { Payments } from '../payments/index.js';
import { BasicAuthClient } from '../legacy/index.js';
/**
 * @deprecated Use `Payments` from `@sakeetech/viva-payments-core/payments`
 * with `mode: 'isv'` explicitly set. Will be removed in 0.3.0.
 *
 * Back-compat wrapper that preserves the pre-slice-2 positional constructor
 * signature and pins `mode: 'isv'` on the underlying {@link Payments} class.
 * Existing call sites such as `new IsvPayments(client, undefined, legacyClient)`
 * continue to compile and behave as before.
 */
export class IsvPayments extends Payments {
    constructor(client, secondaryClient, legacyClient) {
        super({
            mode: 'isv',
            client,
            ...(secondaryClient !== undefined ? { secondaryClient } : {}),
            ...(legacyClient !== undefined ? { legacyClient } : {}),
        });
    }
}
/**
 * @deprecated Renamed to `BasicAuthClient` — import from
 * `@sakeetech/viva-payments-core/legacy`. Will be removed in 0.3.0.
 *
 * Back-compat wrapper that always pins `authVariant: 'merchant'` on the
 * underlying {@link BasicAuthClient}. Pre-slice-4 adapter call sites that
 * construct `LegacyBasicClient` with `{ environment, merchantId, apiKey }`
 * continue to compile and behave identically.
 */
export class LegacyBasicClient extends BasicAuthClient {
    constructor(opts) {
        super({ authVariant: 'merchant', ...opts });
    }
}
//# sourceMappingURL=index.js.map