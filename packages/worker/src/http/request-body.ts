import type { IncomingMessage } from "http";

export async function readRequestBody(
  request: IncomingMessage,
  limit: number,
): Promise<{ body?: Buffer; tooLarge: boolean }> {
  const contentLength = Number(request.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > limit) {
    request.resume();
    return { tooLarge: true };
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > limit) {
      request.resume();
      return { tooLarge: true };
    }
    chunks.push(buffer);
  }
  return { body: Buffer.concat(chunks), tooLarge: false };
}
