"use strict";
/**
 * url-template.ts — Simple {token} substitution for redirect URLs.
 *
 * Used to substitute {orderCode} (and optionally other tokens) into
 * successUrl / failureUrl after Viva returns the orderCode.
 *
 * @see docs/plans/vendure-plugin-v0.md §"Configuration Surface"
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.substitute = substitute;
/**
 * Replace all `{token}` occurrences in a template string with values from
 * the provided map. Tokens with no matching key are left unchanged.
 *
 * @example
 * substitute('https://example.com/success?ref={orderCode}', { orderCode: '12345' })
 * // → 'https://example.com/success?ref=12345'
 */
function substitute(template, tokens) {
    return template.replace(/\{([^}]+)\}/g, (match, key) => {
        return Object.prototype.hasOwnProperty.call(tokens, key) ? tokens[key] : match;
    });
}
//# sourceMappingURL=url-template.js.map