import { describe, it, expect } from 'vitest';
import { buildChallengeResponse } from '../../src/webhooks/challenge-response.js';
import { VivaWebhookError } from '../../src/errors/index.js';

describe('buildChallengeResponse', () => {
  it('returns { Key: value } for a valid key', () => {
    const result = buildChallengeResponse('abc');
    expect(result).toEqual({ Key: 'abc' });
  });

  it('preserves the exact key value (no trimming)', () => {
    const key = 'B3248222FDCD1885AEAFE51CCC1B5607F00903F6';
    const result = buildChallengeResponse(key);
    expect(result.Key).toBe(key);
  });

  it('throws VivaWebhookError for an empty string', () => {
    expect(() => buildChallengeResponse('')).toThrow(VivaWebhookError);
    expect(() => buildChallengeResponse('')).toThrow('webhookVerificationKey');
  });

  it('throws VivaWebhookError for a whitespace-only string', () => {
    expect(() => buildChallengeResponse('   ')).toThrow(VivaWebhookError);
    expect(() => buildChallengeResponse('\t\n')).toThrow(VivaWebhookError);
  });
});
