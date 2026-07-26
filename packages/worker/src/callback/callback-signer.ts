import { createHmac } from "crypto";

export function createCallbackSignature(
  secret: string,
  timestamp: string,
  deliveryId: string,
  rawBody: Buffer,
): string {
  const digest = createHmac("sha256", secret)
    .update(timestamp)
    .update(".")
    .update(deliveryId)
    .update(".")
    .update(rawBody)
    .digest("hex");
  return `v1=${digest}`;
}
