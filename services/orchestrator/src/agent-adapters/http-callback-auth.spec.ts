import { constantTimeEqual, createHttpCallbackSignature, verifyHttpCallbackSignature } from './http-callback-auth';

const secret = 'fixed-callback-secret';
const timestamp = '1785024000';
const deliveryId = 'delivery-1';
const nowMs = 1785024000 * 1000;
const rawBody = Buffer.from('{"schemaVersion":"1","status":"succeeded"}');

const validHeaders = () => ({
  timestamp,
  deliveryId,
  signature: createHttpCallbackSignature(secret, timestamp, deliveryId, rawBody),
});

describe('HTTP callback HMAC authentication', () => {
  it('accepts a valid signature', () => {
    expect(() =>
      verifyHttpCallbackSignature({
        secret,
        rawBody,
        maxSkewSeconds: 300,
        nowMs,
        ...validHeaders(),
      }),
    ).not.toThrow();
  });

  it.each([
    ['invalid signature', { signature: `v1=${'0'.repeat(64)}` }],
    ['missing signature', { signature: undefined }],
    ['missing timestamp', { timestamp: undefined }],
    ['missing delivery ID', { deliveryId: undefined }],
    ['malformed timestamp', { timestamp: '1.5' }],
  ])('rejects %s', (_case, overrides) => {
    expect(() =>
      verifyHttpCallbackSignature({
        secret,
        rawBody,
        maxSkewSeconds: 300,
        nowMs,
        ...validHeaders(),
        ...overrides,
      }),
    ).toThrow(expect.objectContaining({ code: 'CALLBACK_UNAUTHORIZED' }));
  });

  it.each([
    ['expired timestamps', String(Number(timestamp) - 301)],
    ['future timestamps beyond skew', String(Number(timestamp) + 301)],
  ])('rejects %s', (_case, changedTimestamp) => {
    expect(() =>
      verifyHttpCallbackSignature({
        secret,
        rawBody,
        maxSkewSeconds: 300,
        nowMs,
        ...validHeaders(),
        timestamp: changedTimestamp,
      }),
    ).toThrow(expect.objectContaining({ code: 'CALLBACK_UNAUTHORIZED' }));
  });

  it('signs exact raw bytes rather than reserialized JSON', () => {
    const compact = Buffer.from('{"a":1,"b":2}');
    const spaced = Buffer.from('{ "a": 1, "b": 2 }');

    expect(createHttpCallbackSignature(secret, timestamp, deliveryId, compact)).not.toBe(
      createHttpCallbackSignature(secret, timestamp, deliveryId, spaced),
    );
  });

  it('changes the signature when property order changes', () => {
    expect(createHttpCallbackSignature(secret, timestamp, deliveryId, Buffer.from('{"a":1,"b":2}'))).not.toBe(
      createHttpCallbackSignature(secret, timestamp, deliveryId, Buffer.from('{"b":2,"a":1}')),
    );
  });

  it('uses the constant-time comparison helper', () => {
    expect(constantTimeEqual(Buffer.from('same'), Buffer.from('same'))).toBe(true);
    expect(constantTimeEqual(Buffer.from('same'), Buffer.from('diff'))).toBe(false);
    expect(constantTimeEqual(Buffer.from('short'), Buffer.from('longer'))).toBe(false);
  });

  it('does not include the secret or signature in errors', () => {
    const signature = `v1=${'0'.repeat(64)}`;
    try {
      verifyHttpCallbackSignature({
        secret,
        signature,
        timestamp,
        deliveryId,
        rawBody,
        maxSkewSeconds: 300,
        nowMs,
      });
      throw new Error('expected authentication failure');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain(secret);
      expect(message).not.toContain(signature);
    }
  });
});
