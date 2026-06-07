/**
 * types.ts — Public configuration types for VivaPaymentPlugin.
 *
 * v0.2.0: `VivaPaymentPluginOptions` is now a **discriminated union** on `mode`.
 *
 * - `mode: 'isv'` (default until 0.3.0) — multi-merchant ISV partner setup.
 * - `mode: 'merchant'` — single direct Viva merchant, no reseller hierarchy.
 *
 * Field rename (one-minor back-compat):
 *   - `isvClientId`  → `clientId`     (old name accepted with deprecation warning)
 *   - `isvClientSecret` → `clientSecret`
 *
 * Plan ref: docs/plans/multi-mode-v0.md §5 (config shape), §10 (Vendure adapter).
 *
 * Vendure types (RequestContext, Order) are imported as peer-dep types only —
 * no runtime Vendure import here so the types module is safe to import in
 * non-Vendure test environments.
 *
 * viva-payments-core types are imported from sub-paths to avoid pulling in
 * implementation code.
 */
export {};
//# sourceMappingURL=types.js.map