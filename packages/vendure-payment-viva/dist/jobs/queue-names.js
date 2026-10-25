"use strict";
/**
 * jobs/queue-names.ts — Single source of truth for BullMQ queue + job names.
 *
 * Both the webhook controller (V6) and the webhook job handler (V7) import
 * from here so the strings are never duplicated.
 *
 * @see docs/plans/vendure-plugin-v0.md §"Build Plan — V6"
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.VIVA_PROCESS_EVENT_JOB = exports.VIVA_WEBHOOK_QUEUE = void 0;
// ---------------------------------------------------------------------------
// Queue names
// ---------------------------------------------------------------------------
/** BullMQ queue that receives all Viva webhook processing jobs. */
exports.VIVA_WEBHOOK_QUEUE = 'viva-webhook';
// ---------------------------------------------------------------------------
// Job names
// ---------------------------------------------------------------------------
/** Job that processes a single Viva webhook event (V7 implements the handler). */
exports.VIVA_PROCESS_EVENT_JOB = 'process-viva-webhook';
//# sourceMappingURL=queue-names.js.map