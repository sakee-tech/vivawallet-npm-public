/**
 * Shared undici Pool dispatchers for outbound Viva API calls.
 *
 * Two separate pools are maintained — one per host — because the auth
 * endpoint (`/connect/token`) and the API endpoint live on different hosts.
 * Mixing them in one pool would route all requests to a single origin.
 *
 * @see references/viva-docs/md/oauth2-authentication.txt:145 (environment URLs)
 * @see references/viva-docs/md/oauth2-authentication.txt:145 (demo vs production hosts)
 */
import { type Dispatcher } from 'undici';
import type { VivaEnvironment } from '../types/common.js';
export type { VivaEnvironment };
export interface VivaHttpConfig {
    /** 'demo' | 'production' */
    environment: VivaEnvironment;
    /** Optional dispatcher override — use in unit tests with MockAgent. */
    dispatcher?: Dispatcher;
}
/**
 * Returns a memoized undici Pool for the auth host (`/connect/token`).
 *
 * @see references/viva-docs/md/oauth2-authentication.txt:145
 * Demo:       https://demo-accounts.vivapayments.com
 * Production: https://accounts.vivapayments.com
 */
export declare function getAuthDispatcher(env: VivaEnvironment): Dispatcher;
/**
 * Returns a memoized undici Pool for the Viva API host.
 *
 * @see references/viva-docs/md/oauth2-authentication.txt:145
 * Demo:       https://demo-api.vivapayments.com
 * Production: https://api.vivapayments.com
 */
export declare function getApiDispatcher(env: VivaEnvironment): Dispatcher;
/**
 * Closes all memoized pools. Call this in test `afterAll` hooks and during
 * graceful process shutdown to avoid open-handle warnings.
 *
 * Note: dispatchers are process-shared; tests MUST call `closeAllDispatchers()`
 * in `afterAll` when injecting a `MockAgent` to avoid cross-test leaks.
 */
export declare function closeAllDispatchers(): Promise<void>;
//# sourceMappingURL=http.d.ts.map