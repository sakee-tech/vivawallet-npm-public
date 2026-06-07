/**
 * IsvSources — ISV-mode admin operations on payment sources for connected merchants.
 *
 * Wraps `POST /api/sources` on the Viva legacy host using a `BasicAuthClient`
 * configured with `authVariant: 'reseller'`. A "source" is a payment-source
 * configuration on a merchant account — e.g. a Smart Checkout source linked to
 * a domain + success/fail callback paths, or a physical (in-store) source.
 *
 * The reseller credentials baked into the underlying `BasicAuthClient` are
 * scoped to **one** connected merchant per client instance. To operate on
 * multiple merchants under the same reseller account, construct multiple
 * `BasicAuthClient` instances (one per merchant) and pass each to its own
 * `IsvSources`.
 *
 * @see references/payment-isv-api.yaml:135
 * @see docs/AUTH.md §1.2 (Reseller Basic)
 * @see docs/ENDPOINTS.md §5.1
 */

import type { BasicAuthClient } from '../legacy/client.js';
import { VivaValidationError } from '../errors/index.js';

// ---------------------------------------------------------------------------
// Input / output types
// ---------------------------------------------------------------------------

/**
 * Input for `createEcommerceSource` — Smart Checkout source for a website.
 */
export interface CreateEcommerceSourceInput {
  /** Domain the source is bound to, e.g. `www.example.com`. */
  domain: string;
  /** URL path the customer is redirected to after a successful checkout. */
  pathSuccess: string;
  /** URL path the customer is redirected to after a failed checkout. */
  pathFail: string;
  /** Friendly label for the source (optional). */
  name?: string;
  /**
   * 4-digit source code (1000..9999). Auto-assigned by Viva when omitted.
   */
  sourceCode?: number;
  /** Whether the domain is served over HTTPS. Defaults to `true`. */
  isSecure?: boolean;
}

/**
 * Input for `createPhysicalSource` — in-store / terminal source.
 */
export interface CreatePhysicalSourceInput {
  /** Friendly label for the physical source. Required. */
  name: string;
  /** 4-digit source code (1000..9999). Auto-assigned by Viva when omitted. */
  sourceCode?: number;
}

/**
 * Response shape from `POST /api/sources`. Kept permissive — Viva's response
 * may include additional fields depending on the source type / account state.
 */
export interface SourceResponse {
  sourceCode: number;
  name?: string;
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const SOURCE_CODE_MIN = 1000;
const SOURCE_CODE_MAX = 9999;

function requireNonEmptyString(value: unknown, field: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new VivaValidationError({
      message: `IsvSources: ${field} is required and must be a non-empty string`,
    });
  }
}

function validateSourceCode(value: number | undefined): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < SOURCE_CODE_MIN || value > SOURCE_CODE_MAX) {
    throw new VivaValidationError({
      message: `IsvSources: sourceCode must be a 4-digit integer in [${SOURCE_CODE_MIN}, ${SOURCE_CODE_MAX}]`,
    });
  }
}

// ---------------------------------------------------------------------------
// IsvSources
// ---------------------------------------------------------------------------

export class IsvSources {
  /**
   * @param basic A `BasicAuthClient` already configured with
   *   `authVariant: 'reseller'`. The reseller credentials are tied to ONE
   *   connected merchant per client instance.
   */
  constructor(private readonly basic: BasicAuthClient) {}

  /**
   * Create a Smart Checkout (ecommerce) payment source for the connected
   * merchant.
   *
   * @see docs/ENDPOINTS.md §5.1
   */
  async createEcommerceSource(input: CreateEcommerceSourceInput): Promise<SourceResponse> {
    requireNonEmptyString(input.domain, 'domain');
    requireNonEmptyString(input.pathSuccess, 'pathSuccess');
    requireNonEmptyString(input.pathFail, 'pathFail');
    validateSourceCode(input.sourceCode);

    const body: Record<string, unknown> = {
      domain: input.domain,
      isSecure: input.isSecure ?? true,
      pathFail: input.pathFail,
      pathSuccess: input.pathSuccess,
    };
    if (input.name !== undefined) {
      body['name'] = input.name;
    }
    if (input.sourceCode !== undefined) {
      body['sourceCode'] = input.sourceCode;
    }

    const result = await this.basic.request<SourceResponse>({
      method: 'POST',
      path: '/api/sources',
      jsonBody: body,
      idempotent: false,
      endpoint: 'POST /api/sources',
    });
    return result.data;
  }

  /**
   * Create a physical (in-store / terminal) payment source for the connected
   * merchant.
   *
   * @see docs/ENDPOINTS.md §5.1
   */
  async createPhysicalSource(input: CreatePhysicalSourceInput): Promise<SourceResponse> {
    requireNonEmptyString(input.name, 'name');
    validateSourceCode(input.sourceCode);

    const body: Record<string, unknown> = {
      isPhysical: true,
      name: input.name,
    };
    if (input.sourceCode !== undefined) {
      body['sourceCode'] = input.sourceCode;
    }

    const result = await this.basic.request<SourceResponse>({
      method: 'POST',
      path: '/api/sources',
      jsonBody: body,
      idempotent: false,
      endpoint: 'POST /api/sources',
    });
    return result.data;
  }
}
