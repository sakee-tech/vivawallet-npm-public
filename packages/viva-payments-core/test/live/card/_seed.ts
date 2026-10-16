/**
 * Card-seeding helper for the LIVE card suite.
 *
 * Drives a real payment through Viva's demo Smart Checkout with Playwright so
 * the retrieve / refund / cancel tests have a genuine settled transaction to
 * act on. Playwright is imported DYNAMICALLY — this module loads fine even when
 * `playwright` is not installed, so the card suite can self-skip instead of
 * breaking test collection.
 *
 * Setup (not done by default — see docs/resume):
 *   pnpm add -D playwright && npx playwright install chromium
 *   VIVA_LIVE_CARD=1 VIVA_LIVE_MUTATIONS=1 pnpm test:live
 *
 * Demo test cards (references/viva-docs, saved by the user):
 *   success (frictionless, no 3DS): 4147 4630 1111 0133
 *   failure:                        4147 4630 1111 0141
 *   3DS challenge:                  5188 3400 0000 0060  (answer Y / "Yes")
 * CVV: any 3 digits. Expiry: any future date.
 *
 * After payment Viva redirects to the order's success URL with query params:
 *   t       = transactionId
 *   s       = orderCode
 *   EventId = outcome code (0 = success)
 */

import { ENVIRONMENT } from '../_env.js';

export const DEMO_CARDS = {
  success: '4147463011110133',
  failure: '4147463011110141',
  threeDS: '5188340000000060',
} as const;

export interface SeededTransaction {
  transactionId: string;
  orderCode: string;
  eventId: string | null;
}

/** True when the `playwright` package can be resolved at runtime. */
export async function playwrightAvailable(): Promise<boolean> {
  try {
    await import('playwright');
    return true;
  } catch {
    return false;
  }
}

function checkoutHost(): string {
  return ENVIRONMENT === 'production'
    ? 'https://www.vivapayments.com'
    : 'https://demo.vivapayments.com';
}

/**
 * Pay an existing order via Smart Checkout and return the resolved txn ids.
 *
 * NOTE: Viva's Smart Checkout DOM/selectors are not version-pinned and may
 * drift; the selectors below are best-effort and the first thing to revisit if
 * a card run fails. Per the "run once, report, stop" rule, a failure here is a
 * report, not a retry loop.
 */
export async function payOrder(
  orderCode: bigint | string,
  card: string = DEMO_CARDS.success,
): Promise<SeededTransaction> {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`${checkoutHost()}/web/checkout?ref=${orderCode}`, {
      waitUntil: 'domcontentloaded',
    });

    // Card number / expiry / CVV — Smart Checkout renders these in iframes in
    // some flows and inline in others. Try inline first; fall back to frames.
    await fillCardField(page, ['#cardNumber', 'input[name="cardNumber"]'], card);
    await fillCardField(page, ['#cardHolder', 'input[name="cardHolder"]'], 'Live Suite');
    await fillCardField(page, ['#cardExpiration', 'input[name="cardExpiration"]'], '12/30');
    await fillCardField(page, ['#cardCvv', 'input[name="cardCvv"]'], '123');

    await Promise.all([
      page.waitForURL(/[?&]t=/, { timeout: 30_000 }),
      page.click('button[type="submit"], #submitButton'),
    ]);

    const url = new URL(page.url());
    const transactionId = url.searchParams.get('t');
    const orderCodeOut = url.searchParams.get('s') ?? String(orderCode);
    if (!transactionId) {
      throw new Error(`payOrder: no transactionId in redirect ${page.url()}`);
    }
    return {
      transactionId,
      orderCode: orderCodeOut,
      eventId: url.searchParams.get('EventId'),
    };
  } finally {
    await browser.close();
  }
}

async function fillCardField(
  page: import('playwright').Page,
  selectors: string[],
  value: string,
): Promise<void> {
  for (const sel of selectors) {
    const el = page.locator(sel).first();
    if (await el.count().then((c) => c > 0).catch(() => false)) {
      await el.fill(value);
      return;
    }
    for (const frame of page.frames()) {
      const fel = frame.locator(sel).first();
      if (await fel.count().then((c) => c > 0).catch(() => false)) {
        await fel.fill(value);
        return;
      }
    }
  }
  throw new Error(`fillCardField: none of ${selectors.join(', ')} found`);
}
