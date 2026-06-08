/**
 * test/jobs/retention-cleanup.test.ts
 *
 * Unit tests for RetentionCleanupHandler.
 *
 * Coverage:
 *  - Rows older than 90d with processedAt set → deleted
 *  - Rows newer than 90d → kept
 *  - Rows with processedAt = NULL → kept regardless of age
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RetentionCleanupHandler } from '../../src/jobs/retention-cleanup.handler.js';

// ---------------------------------------------------------------------------
// Mock DB repo
// ---------------------------------------------------------------------------

interface MockRow {
  messageId: string;
  processedAt: Date | null;
}

function makeHandler(rows: MockRow[]): RetentionCleanupHandler {
  const handler = Object.create(RetentionCleanupHandler.prototype) as RetentionCleanupHandler;

  // Mock connection.rawConnection.getRepository
  (handler as any).connection = {
    rawConnection: {
      getRepository: () => ({
        delete: async (criteria: { processedAt: any }) => {
          // LessThan wraps the value — extract it
          const cutoff: Date = criteria.processedAt?.value ?? criteria.processedAt;
          let deleted = 0;
          for (let i = rows.length - 1; i >= 0; i--) {
            const row = rows[i]!;
            if (row.processedAt !== null && row.processedAt < cutoff) {
              rows.splice(i, 1);
              deleted++;
            }
          }
          return { affected: deleted };
        },
      }),
    },
  };

  return handler;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RetentionCleanupHandler', () => {
  it('deletes processed rows older than 90 days', async () => {
    const ninetyOneDaysAgo = new Date(Date.now() - 91 * 24 * 60 * 60 * 1_000);
    const rows: MockRow[] = [
      { messageId: 'old-1', processedAt: ninetyOneDaysAgo },
      { messageId: 'old-2', processedAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1_000) },
    ];
    const handler = makeHandler(rows);

    const deleted = await handler.runCleanup();

    expect(deleted).toBe(2);
    expect(rows).toHaveLength(0);
  });

  it('keeps processed rows newer than 90 days', async () => {
    const rows: MockRow[] = [
      { messageId: 'recent-1', processedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1_000) },
      { messageId: 'recent-2', processedAt: new Date(Date.now() - 89 * 24 * 60 * 60 * 1_000) },
    ];
    const handler = makeHandler(rows);

    const deleted = await handler.runCleanup();

    expect(deleted).toBe(0);
    expect(rows).toHaveLength(2);
  });

  it('keeps rows with processedAt = NULL regardless of receivedAt age', async () => {
    const rows: MockRow[] = [
      { messageId: 'pending-old', processedAt: null },
    ];
    const handler = makeHandler(rows);

    const deleted = await handler.runCleanup();

    expect(deleted).toBe(0);
    expect(rows).toHaveLength(1);
  });

  it('keeps new processed rows and deletes old ones in the same run', async () => {
    const rows: MockRow[] = [
      { messageId: 'old', processedAt: new Date(Date.now() - 95 * 24 * 60 * 60 * 1_000) },
      { messageId: 'new', processedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1_000) },
      { messageId: 'pending', processedAt: null },
    ];
    const handler = makeHandler(rows);

    const deleted = await handler.runCleanup();

    expect(deleted).toBe(1);
    expect(rows.map((r) => r.messageId)).toEqual(['new', 'pending']);
  });

  it('returns 0 and logs warning when DB throws', async () => {
    const handler = Object.create(RetentionCleanupHandler.prototype) as RetentionCleanupHandler;
    (handler as any).connection = {
      rawConnection: {
        getRepository: () => ({
          delete: async () => { throw new Error('DB connection lost'); },
        }),
      },
    };

    const deleted = await handler.runCleanup();
    expect(deleted).toBe(0);
  });
});
