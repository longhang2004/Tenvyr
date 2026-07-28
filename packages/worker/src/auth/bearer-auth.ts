import { timingSafeEqual } from "crypto";

export function authenticateBearer(
  _authorization: string | undefined,
  _expectedToken: string,
): boolean {
  if (!_authorization) return false;
  const match = /^Bearer ([^\s]+)$/i.exec(_authorization);
  if (!match) return false;
  return constantTimeEqual(
    Buffer.from(match[1], "utf8"),
    Buffer.from(_expectedToken, "utf8"),
  );
}

export function constantTimeEqual(actual: Buffer, expected: Buffer): boolean {
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
