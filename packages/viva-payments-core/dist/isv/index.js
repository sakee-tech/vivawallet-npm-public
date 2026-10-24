"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.LegacyBasicClient = exports.IsvPayments = exports.IsvSources = exports.IsvWebhooks = exports.IsvAccounts = exports.IsvHttpClient = void 0;
var client_js_1 = require("./client.js");
Object.defineProperty(exports, "IsvHttpClient", { enumerable: true, get: function () { return client_js_1.IsvHttpClient; } });
var accounts_js_1 = require("./accounts.js");
Object.defineProperty(exports, "IsvAccounts", { enumerable: true, get: function () { return accounts_js_1.IsvAccounts; } });
var webhooks_api_js_1 = require("./webhooks-api.js");
Object.defineProperty(exports, "IsvWebhooks", { enumerable: true, get: function () { return webhooks_api_js_1.IsvWebhooks; } });
var sources_js_1 = require("./sources.js");
Object.defineProperty(exports, "IsvSources", { enumerable: true, get: function () { return sources_js_1.IsvSources; } });
const index_js_1 = require("../payments/index.js");
const index_js_2 = require("../legacy/index.js");
/**
 * @deprecated Use `Payments` from `@sakeetech/viva-payments-core/payments`
 * with `mode: 'isv'` explicitly set. Will be removed in 0.3.0.
 *
 * Back-compat wrapper that preserves the pre-slice-2 positional constructor
 * signature and pins `mode: 'isv'` on the underlying {@link Payments} class.
 * Existing call sites such as `new IsvPayments(client, undefined, legacyClient)`
 * continue to compile and behave as before.
 */
class IsvPayments extends index_js_1.Payments {
    constructor(client, secondaryClient, legacyClient) {
        super({
            mode: 'isv',
            client,
            ...(secondaryClient !== undefined ? { secondaryClient } : {}),
            ...(legacyClient !== undefined ? { legacyClient } : {}),
        });
    }
}
exports.IsvPayments = IsvPayments;
/**
 * @deprecated Renamed to `BasicAuthClient` — import from
 * `@sakeetech/viva-payments-core/legacy`. Will be removed in 0.3.0.
 *
 * Back-compat wrapper that always pins `authVariant: 'merchant'` on the
 * underlying {@link BasicAuthClient}. Pre-slice-4 adapter call sites that
 * construct `LegacyBasicClient` with `{ environment, merchantId, apiKey }`
 * continue to compile and behave identically.
 */
class LegacyBasicClient extends index_js_2.BasicAuthClient {
    constructor(opts) {
        super({ authVariant: 'merchant', ...opts });
    }
}
exports.LegacyBasicClient = LegacyBasicClient;
//# sourceMappingURL=index.js.map