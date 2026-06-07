/**
 * test/api/admin-onboarding.test.ts — AdminOnboardingController unit tests.
 *
 * Uses a minimal Nest-free harness (same pattern as webhook-controller.test.ts).
 * All Viva HTTP calls are mocked via IsvAccounts stubs.
 *
 * Coverage (≥12 test cases):
 *  1.  POST happy path — creates accountId, writes to channel, returns payload
 *  2.  POST — missing channelId body → 400
 *  3.  POST — channel not found → 404
 *  4.  POST — channel has no seller → 400 VIVA_CHANNEL_MISCONFIGURED
 *  5.  POST — channel already has accountId → 409 VIVA_ALREADY_ONBOARDED
 *  6.  POST — Viva 4xx → 4xx pass-through with VIVA_API_ERROR
 *  7.  POST — Viva 5xx / auth error → 503 VIVA_AUTH_DOWN
 *  8.  GET — not_started (no accountId) → verificationStatus='not_started'
 *  9.  GET — awaiting_kyc (accountId set, payoutsEnabled=false) → 'awaiting_kyc'
 *  10. GET — verified (payoutsEnabled=true) → 'verified'
 *  11. GET — channel not found → 404
 *  12. Reconcile — channel missing accountId → 400
 *  13. Reconcile — Viva says verified → writes merchantId, flips payoutsEnabled
 *  14. Reconcile — Viva says still pending → no writes, returns 'awaiting_kyc'
 *  15. Reconcile — already verified → idempotent no-op, returns 'verified'
 *
 * @see docs/plans/vendure-plugin-v0.md §"Build Plan — V9"
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ServerResponse } from 'node:http';
import { AdminOnboardingController } from '../../src/api/admin-onboarding.controller.js';
import type { VivaPaymentPluginOptions } from '../../src/types.js';
import type { ConnectedAccountId } from '@sakeetech/viva-payments-core/types';
import { VivaApiError, VivaAuthError } from '@sakeetech/viva-payments-core/errors';

// ---------------------------------------------------------------------------
// Response mock
// ---------------------------------------------------------------------------

function makeMockResponse(): ServerResponse & {
  _status: number;
  _body: string;
} {
  let status = 200;
  let body = '';
  return {
    _status: 200,
    _body: '',
    writeHead(s: number) {
      status = s;
      (this as any)._status = s;
    },
    end(data?: string) {
      body = data ?? '';
      (this as any)._body = body;
    },
  } as unknown as ServerResponse & { _status: number; _body: string };
}

// ---------------------------------------------------------------------------
// Plugin options factory
// ---------------------------------------------------------------------------

function makeOptions(): VivaPaymentPluginOptions {
  return {
    mode: 'isv' as const,

    clientId: 'test-id',
    clientSecret: 'test-secret',
    onboardingReturnUrl: 'https://example.com/onboarding-return',
    environment: 'demo',
    webhookVerificationKey: 'key-abc',
    legacyMerchantId: 'test-legacy-merchant-uuid',
    legacyApiKey: 'test-legacy-api-key',
    successUrl: 'https://example.com/success',
    failureUrl: 'https://example.com/failure',
    onboardingReturnUrl: 'https://example.com/connected',
    onboardingBranding: {
      partnerName: 'Test ISV',
      logoUrl: 'https://example.com/logo.png',
    },
  };
}

// ---------------------------------------------------------------------------
// Channel factory
// ---------------------------------------------------------------------------

function makeChannel(overrides: {
  id?: string | number;
  vivaAccountId?: string | null;
  vivaMerchantId?: string | null;
  vivaPayoutsEnabled?: boolean;
  vivaApplePayDomainVerified?: boolean;
  seller?: Record<string, unknown> | null;
} = {}) {
  return {
    id: overrides.id ?? '42',
    customFields: {
      vivaAccountId: overrides.vivaAccountId ?? null,
      vivaMerchantId: overrides.vivaMerchantId ?? null,
      vivaPayoutsEnabled: overrides.vivaPayoutsEnabled ?? false,
      vivaApplePayDomainVerified: overrides.vivaApplePayDomainVerified ?? false,
    },
    seller: 'seller' in overrides ? overrides.seller : {
      id: 'seller-1',
      name: 'Test Seller',
      customFields: {
        contactEmail: 'seller@example.com',
        countryCode: 'GB',
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Mock IsvAccounts
// ---------------------------------------------------------------------------

function makeIsvAccountsMock(opts: {
  createResult?: { accountId: string; invitation: { email: string; redirectUrl: string; created: string } };
  createError?: Error;
  retrieveResult?: {
    accountId: string;
    merchantId?: string | null;
    verified?: boolean;
    acquiringEnabled?: boolean;
  };
  retrieveError?: Error;
} = {}) {
  return {
    createConnectedAccount: vi.fn().mockImplementation(async () => {
      if (opts.createError) throw opts.createError;
      return opts.createResult ?? {
        accountId: 'acct-uuid-001',
        invitation: {
          email: 'seller@example.com',
          redirectUrl: 'https://onboarding.vivapayments.com/kyc/xxx',
          created: '2026-05-11T00:00:00Z',
        },
      };
    }),
    retrieveConnectedAccount: vi.fn().mockImplementation(async () => {
      if (opts.retrieveError) throw opts.retrieveError;
      return opts.retrieveResult ?? {
        accountId: 'acct-uuid-001',
        merchantId: 'merch-uuid-001',
        verified: true,
        acquiringEnabled: true,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// ConnectedAccountsService mock
// ---------------------------------------------------------------------------

function makeConnectedAccountsService() {
  return {
    writeAccountId: vi.fn().mockResolvedValue(undefined),
    writeMerchantId: vi.fn().mockResolvedValue(undefined),
    flipPayoutsEnabled: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// TransactionalConnection mock
// ---------------------------------------------------------------------------

function makeConnectionMock(channel: ReturnType<typeof makeChannel> | null) {
  const repo = {
    findOne: vi.fn().mockImplementation(async (query: { where?: { id?: unknown }; relations?: string[] }) => {
      if (!channel) return null;
      if (query.relations?.includes('seller')) {
        return { ...channel };
      }
      return { ...channel };
    }),
  };
  return {
    rawConnection: {
      getRepository: vi.fn().mockReturnValue(repo),
    },
    _repo: repo,
  };
}

// ---------------------------------------------------------------------------
// RequestContextService mock
// ---------------------------------------------------------------------------

function makeRequestContextService() {
  return {
    create: vi.fn().mockResolvedValue({ apiType: 'admin', channelId: 42 }),
  };
}

// ---------------------------------------------------------------------------
// Controller factory
// ---------------------------------------------------------------------------

function buildController(
  channel: ReturnType<typeof makeChannel> | null,
  isvAccountsMockOverrides: Parameters<typeof makeIsvAccountsMock>[0] = {},
) {
  const options = makeOptions();
  const oauth2 = { getBearerToken: vi.fn().mockResolvedValue('test-token') };
  const connection = makeConnectionMock(channel);
  const requestContextService = makeRequestContextService();
  const connectedAccountsService = makeConnectedAccountsService();
  const isvAccountsMock = makeIsvAccountsMock(isvAccountsMockOverrides);

  const ctrl = new AdminOnboardingController(
    options,
    oauth2 as any,
    connection as any,
    requestContextService as any,
    connectedAccountsService as any,
  );

  // Monkey-patch buildIsvAccounts to return our mock
  (ctrl as any).buildIsvAccounts = () => isvAccountsMock;

  return { ctrl, connection, connectedAccountsService, isvAccountsMock, requestContextService };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AdminOnboardingController', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockReturnValue(undefined);
    vi.spyOn(console, 'info').mockReturnValue(undefined);
    vi.spyOn(console, 'error').mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // POST /viva/admin/connected-accounts — Initiate onboarding
  // =========================================================================

  describe('POST — initiate onboarding', () => {
    it('happy path: creates accountId, writes to channel, returns {accountId, onboardingUrl}', async () => {
      const channel = makeChannel({ id: '42', vivaAccountId: null });
      const { ctrl, connectedAccountsService, isvAccountsMock } = buildController(channel, {
        createResult: {
          accountId: 'acct-uuid-001',
          invitation: {
            email: 'seller@example.com',
            redirectUrl: 'https://kyc.viva.com/link',
            created: '2026-05-11T00:00:00Z',
          },
        },
      });

      const res = makeMockResponse();
      await ctrl.initiateOnboarding({ channelId: '42' }, res);

      expect(res._status).toBe(200);
      const body = JSON.parse(res._body);
      expect(body.accountId).toBe('acct-uuid-001');
      expect(body.onboardingUrl).toBe('https://kyc.viva.com/link');
      expect(body.channelId).toBe('42');
      expect(body.instructions).toContain('Send onboardingUrl');

      // IsvAccounts.createConnectedAccount called with the new wire shape
      expect(isvAccountsMock.createConnectedAccount).toHaveBeenCalledTimes(1);
      const createPayload = isvAccountsMock.createConnectedAccount.mock.calls[0][0];
      expect(createPayload.email).toBe('seller@example.com');
      expect(createPayload.returnUrl).toBe('https://example.com/connected');
      expect(createPayload.branding).toMatchObject({
        partnerName: 'Test ISV',
        logoUrl: 'https://example.com/logo.png',
      });

      // vivaAccountId written to channel
      expect(connectedAccountsService.writeAccountId).toHaveBeenCalledTimes(1);
      expect(connectedAccountsService.writeAccountId.mock.calls[0][2]).toBe('acct-uuid-001');
    });

    it('missing channelId body → 400 VIVA_CHANNEL_MISCONFIGURED', async () => {
      const { ctrl } = buildController(null);
      const res = makeMockResponse();

      await ctrl.initiateOnboarding({ channelId: '' }, res);

      expect(res._status).toBe(400);
      const body = JSON.parse(res._body);
      expect(body.code).toBe('VIVA_CHANNEL_MISCONFIGURED');
    });

    it('channel not found → 404', async () => {
      const { ctrl } = buildController(null);
      const res = makeMockResponse();

      await ctrl.initiateOnboarding({ channelId: 'nonexistent' }, res);

      expect(res._status).toBe(404);
      const body = JSON.parse(res._body);
      expect(body.code).toBe('VIVA_CHANNEL_MISCONFIGURED');
    });

    it('channel has no seller → 400 VIVA_CHANNEL_MISCONFIGURED', async () => {
      const channel = makeChannel({ id: '42', seller: null });
      const { ctrl } = buildController(channel);
      const res = makeMockResponse();

      await ctrl.initiateOnboarding({ channelId: '42' }, res);

      expect(res._status).toBe(400);
      const body = JSON.parse(res._body);
      expect(body.code).toBe('VIVA_CHANNEL_MISCONFIGURED');
      expect(body.message).toContain('Seller');
    });

    it('channel already has vivaAccountId → 409 VIVA_ALREADY_ONBOARDED', async () => {
      const channel = makeChannel({ id: '42', vivaAccountId: 'existing-acct-id' });
      const { ctrl } = buildController(channel);
      const res = makeMockResponse();

      await ctrl.initiateOnboarding({ channelId: '42' }, res);

      expect(res._status).toBe(409);
      const body = JSON.parse(res._body);
      expect(body.code).toBe('VIVA_ALREADY_ONBOARDED');
      expect(body.message).toContain('existing-acct-id');
    });

    it('Viva 4xx → 4xx pass-through with VIVA_API_ERROR', async () => {
      const channel = makeChannel({ id: '42', vivaAccountId: null });
      const vivaError = new VivaApiError({ message: 'Invalid email', httpStatus: 400 } as any);
      (vivaError as any).httpStatus = 400;
      const { ctrl } = buildController(channel, { createError: vivaError });
      const res = makeMockResponse();

      await ctrl.initiateOnboarding({ channelId: '42' }, res);

      expect(res._status).toBe(400);
      const body = JSON.parse(res._body);
      expect(body.code).toBe('VIVA_API_ERROR');
    });

    it('Viva 5xx → 503 VIVA_AUTH_DOWN', async () => {
      const channel = makeChannel({ id: '42', vivaAccountId: null });
      const vivaError = new VivaApiError({ message: 'Server error', httpStatus: 503 } as any);
      (vivaError as any).httpStatus = 503;
      const { ctrl } = buildController(channel, { createError: vivaError });
      const res = makeMockResponse();

      await ctrl.initiateOnboarding({ channelId: '42' }, res);

      expect(res._status).toBe(503);
      const body = JSON.parse(res._body);
      expect(body.code).toBe('VIVA_AUTH_DOWN');
    });

    it('Viva auth error (VivaAuthError) → 503 VIVA_AUTH_DOWN', async () => {
      const channel = makeChannel({ id: '42', vivaAccountId: null });
      const authError = new VivaAuthError({ message: 'Unauthorized', httpStatus: 401 } as any);
      const { ctrl } = buildController(channel, { createError: authError });
      const res = makeMockResponse();

      await ctrl.initiateOnboarding({ channelId: '42' }, res);

      expect(res._status).toBe(503);
      const body = JSON.parse(res._body);
      expect(body.code).toBe('VIVA_AUTH_DOWN');
    });

    it('overrides body fields are merged into create payload', async () => {
      const channel = makeChannel({ id: '42', vivaAccountId: null });
      const { ctrl, isvAccountsMock } = buildController(channel);
      const res = makeMockResponse();

      const overrideBranding = {
        partnerName: 'Override ISV',
        logoUrl: 'https://override.example.com/logo.png',
        primaryColor: '#FF0000',
      };

      await ctrl.initiateOnboarding(
        {
          channelId: '42',
          overrides: {
            email: 'override@example.com',
            returnUrl: 'https://override.example.com/done',
            branding: overrideBranding,
          },
        },
        res,
      );

      const createPayload = isvAccountsMock.createConnectedAccount.mock.calls[0][0];
      expect(createPayload.email).toBe('override@example.com');
      expect(createPayload.returnUrl).toBe('https://override.example.com/done');
      expect(createPayload.branding).toEqual(overrideBranding);
    });
  });

  // =========================================================================
  // GET /viva/admin/connected-accounts/:channelId — Status
  // =========================================================================

  describe('GET — onboarding status', () => {
    it('not started (no vivaAccountId) → verificationStatus=not_started', async () => {
      const channel = makeChannel({ id: '1', vivaAccountId: null, vivaPayoutsEnabled: false });
      const { ctrl } = buildController(channel);
      const res = makeMockResponse();

      await ctrl.getStatus('1', res);

      expect(res._status).toBe(200);
      const body = JSON.parse(res._body);
      expect(body.verificationStatus).toBe('not_started');
      expect(body.accountId).toBeNull();
    });

    it('awaiting KYC (accountId set, payoutsEnabled=false) → verificationStatus=awaiting_kyc', async () => {
      const channel = makeChannel({
        id: '2',
        vivaAccountId: 'acct-pending',
        vivaMerchantId: null,
        vivaPayoutsEnabled: false,
      });
      // retrieveConnectedAccount returns pending
      const { ctrl } = buildController(channel, {
        retrieveResult: { accountId: 'acct-pending', verified: false, acquiringEnabled: false },
      });
      const res = makeMockResponse();

      await ctrl.getStatus('2', res);

      expect(res._status).toBe(200);
      const body = JSON.parse(res._body);
      expect(body.verificationStatus).toBe('awaiting_kyc');
      expect(body.accountId).toBe('acct-pending');
    });

    it('verified (payoutsEnabled=true) → verificationStatus=verified', async () => {
      const channel = makeChannel({
        id: '3',
        vivaAccountId: 'acct-verified',
        vivaMerchantId: 'merch-uuid-001',
        vivaPayoutsEnabled: true,
      });
      const { ctrl } = buildController(channel, {
        retrieveResult: { accountId: 'acct-verified', merchantId: 'merch-uuid-001', verified: true },
      });
      const res = makeMockResponse();

      await ctrl.getStatus('3', res);

      expect(res._status).toBe(200);
      const body = JSON.parse(res._body);
      expect(body.verificationStatus).toBe('verified');
      expect(body.merchantId).toBe('merch-uuid-001');
      expect(body.payoutsEnabled).toBe(true);
    });

    it('channel not found → 404', async () => {
      const { ctrl } = buildController(null);
      const res = makeMockResponse();

      await ctrl.getStatus('nonexistent', res);

      expect(res._status).toBe(404);
      const body = JSON.parse(res._body);
      expect(body.code).toBe('VIVA_CHANNEL_MISCONFIGURED');
    });

    it('includes applePayDomainVerified field', async () => {
      const channel = makeChannel({
        id: '4',
        vivaAccountId: null,
        vivaApplePayDomainVerified: true,
      });
      const { ctrl } = buildController(channel);
      const res = makeMockResponse();

      await ctrl.getStatus('4', res);

      const body = JSON.parse(res._body);
      expect(body.applePayDomainVerified).toBe(true);
    });

    it('retrieve-connected-account failure is best-effort (does not fail the GET)', async () => {
      const channel = makeChannel({
        id: '5',
        vivaAccountId: 'acct-retrieve-fail',
        vivaPayoutsEnabled: false,
      });
      const { ctrl } = buildController(channel, {
        retrieveError: new VivaApiError({ message: 'Timeout' } as any),
      });
      const res = makeMockResponse();

      await ctrl.getStatus('5', res);

      // Should still return 200 with local state
      expect(res._status).toBe(200);
      const body = JSON.parse(res._body);
      expect(body.verificationStatus).toBe('awaiting_kyc');
    });
  });

  // =========================================================================
  // POST /viva/admin/connected-accounts/:channelId/reconcile
  // =========================================================================

  describe('POST reconcile', () => {
    it('channel missing vivaAccountId → 400', async () => {
      const channel = makeChannel({ id: '10', vivaAccountId: null });
      const { ctrl } = buildController(channel);
      const res = makeMockResponse();

      await ctrl.reconcile('10', res);

      expect(res._status).toBe(400);
      const body = JSON.parse(res._body);
      expect(body.code).toBe('VIVA_CHANNEL_MISCONFIGURED');
    });

    it('already verified → idempotent no-op, returns verified status', async () => {
      const channel = makeChannel({
        id: '11',
        vivaAccountId: 'acct-001',
        vivaMerchantId: 'merch-001',
        vivaPayoutsEnabled: true,
      });
      const { ctrl, connectedAccountsService, isvAccountsMock } = buildController(channel);
      const res = makeMockResponse();

      await ctrl.reconcile('11', res);

      expect(res._status).toBe(200);
      const body = JSON.parse(res._body);
      expect(body.verificationStatus).toBe('verified');
      // No Viva API call, no writes
      expect(isvAccountsMock.retrieveConnectedAccount).not.toHaveBeenCalled();
      expect(connectedAccountsService.writeMerchantId).not.toHaveBeenCalled();
      expect(connectedAccountsService.flipPayoutsEnabled).not.toHaveBeenCalled();
    });

    it('Viva says verified → writes vivaMerchantId FIRST, then vivaPayoutsEnabled', async () => {
      const channel = makeChannel({
        id: '12',
        vivaAccountId: 'acct-pending',
        vivaMerchantId: null,
        vivaPayoutsEnabled: false,
      });
      const { ctrl, connectedAccountsService, isvAccountsMock } = buildController(channel, {
        retrieveResult: {
          accountId: 'acct-pending',
          merchantId: 'merch-new-uuid',
          verified: true,
          acquiringEnabled: true,
        },
      });
      const res = makeMockResponse();

      await ctrl.reconcile('12', res);

      expect(res._status).toBe(200);
      const body = JSON.parse(res._body);
      expect(body.verificationStatus).toBe('verified');
      expect(body.merchantId).toBe('merch-new-uuid');
      expect(body.payoutsEnabled).toBe(true);

      // Verify IsvAccounts.retrieveConnectedAccount was called with accountId
      expect(isvAccountsMock.retrieveConnectedAccount).toHaveBeenCalledTimes(1);
      expect(isvAccountsMock.retrieveConnectedAccount).toHaveBeenCalledWith('acct-pending');

      // CRITICAL: writeMerchantId must be called BEFORE flipPayoutsEnabled
      const writeMerchantOrder = connectedAccountsService.writeMerchantId.mock.invocationCallOrder[0];
      const flipPayoutsOrder = connectedAccountsService.flipPayoutsEnabled.mock.invocationCallOrder[0];
      expect(writeMerchantOrder).toBeLessThan(flipPayoutsOrder);

      expect(connectedAccountsService.writeMerchantId).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        'merch-new-uuid',
      );
      expect(connectedAccountsService.flipPayoutsEnabled).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        true,
      );
    });

    it('Viva says still pending → no writes, returns awaiting_kyc', async () => {
      const channel = makeChannel({
        id: '13',
        vivaAccountId: 'acct-still-pending',
        vivaMerchantId: null,
        vivaPayoutsEnabled: false,
      });
      const { ctrl, connectedAccountsService } = buildController(channel, {
        retrieveResult: {
          accountId: 'acct-still-pending',
          merchantId: null,
          verified: false,
          acquiringEnabled: false,
        },
      });
      const res = makeMockResponse();

      await ctrl.reconcile('13', res);

      expect(res._status).toBe(200);
      const body = JSON.parse(res._body);
      expect(body.verificationStatus).toBe('awaiting_kyc');
      expect(body.payoutsEnabled).toBe(false);

      // No writes should occur
      expect(connectedAccountsService.writeMerchantId).not.toHaveBeenCalled();
      expect(connectedAccountsService.flipPayoutsEnabled).not.toHaveBeenCalled();
    });

    it('Viva says verified but merchantId missing → no writes (defensive)', async () => {
      const channel = makeChannel({
        id: '14',
        vivaAccountId: 'acct-no-merch',
        vivaMerchantId: null,
        vivaPayoutsEnabled: false,
      });
      const { ctrl, connectedAccountsService } = buildController(channel, {
        retrieveResult: {
          accountId: 'acct-no-merch',
          merchantId: undefined, // verified=true but no merchantId yet (shouldn't happen in practice)
          verified: true,
        },
      });
      const res = makeMockResponse();

      await ctrl.reconcile('14', res);

      expect(res._status).toBe(200);
      const body = JSON.parse(res._body);
      // Without merchantId, cannot reconcile fully
      expect(body.payoutsEnabled).toBe(false);
      expect(connectedAccountsService.writeMerchantId).not.toHaveBeenCalled();
    });

    it('channel not found → 404', async () => {
      const { ctrl } = buildController(null);
      const res = makeMockResponse();

      await ctrl.reconcile('nonexistent', res);

      expect(res._status).toBe(404);
      const body = JSON.parse(res._body);
      expect(body.code).toBe('VIVA_CHANNEL_MISCONFIGURED');
    });

    it('Viva retrieve 5xx → 503 VIVA_AUTH_DOWN', async () => {
      const channel = makeChannel({
        id: '15',
        vivaAccountId: 'acct-pending',
        vivaMerchantId: null,
        vivaPayoutsEnabled: false,
      });
      const vivaError = new VivaApiError({ message: 'Internal Server Error', httpStatus: 500 } as any);
      (vivaError as any).httpStatus = 500;
      const { ctrl } = buildController(channel, { retrieveError: vivaError });
      const res = makeMockResponse();

      await ctrl.reconcile('15', res);

      expect(res._status).toBe(503);
      const body = JSON.parse(res._body);
      expect(body.code).toBe('VIVA_AUTH_DOWN');
    });
  });
});
