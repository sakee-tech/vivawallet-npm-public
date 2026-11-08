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
exports.VIVA_WEBHOOK_JOB_RETRIES = exports.VIVA_PROCESS_EVENT_JOB = exports.VIVA_WEBHOOK_QUEUE = void 0;
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
/**
 * Retries per webhook job. Vendure's `JobQueue.add` defaults to 0, which made
 * every "throw so the job retries" path run once. The delay between tries is
 * the host queue's backoff (DefaultJobQueuePlugin: flat 1 s; BullMQ: exponential
 * from 1 s).
 */
exports.VIVA_WEBHOOK_JOB_RETRIES = 10;
//# sourceMappingURL=queue-names.js.map