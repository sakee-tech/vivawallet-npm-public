/**
 * Viva transaction status letter mapping and plugin status enum.
 *
 * Implements plan P17: maps Viva's raw `StatusId` letter codes to the
 * plugin's canonical `VivaTransactionStatus` enum. The M-family letters
 * (M, MA, MI, ML, MS, MW) all map to `'disputed'` with the specific
 * letter stored in `claim_substate`.
 *
 * Implements plan A9: adds `authorized → cancelled` transition
 * (void-before-capture).
 *
 * The actual runtime `mapStatusLetter` function lives in S4
 * (src/webhooks/status-lattice.ts). This file is types only.
 *
 * @see references/viva-docs/md/wh-transaction-payment-created.txt:398
 * @see references/viva-docs/md/wh-sale-transactions.txt:210
 */
export {};
//# sourceMappingURL=status.js.map