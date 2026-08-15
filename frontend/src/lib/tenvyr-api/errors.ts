/**
 * Structured API Error class for Tenvyr Frontend.
 */
export class TenvyrApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(message: string, status = 500, code = "API_ERROR", details?: unknown) {
    super(message);
    this.name = "TenvyrApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static fromResponse(status: number, data: unknown): TenvyrApiError {
    const record =
      data !== null && typeof data === "object"
        ? (data as Record<string, unknown>)
        : null;
    const errorObj =
      record && typeof record.error === "object" && record.error !== null
        ? (record.error as Record<string, unknown>)
        : null;

    const message =
      errorObj?.message ||
      record?.message ||
      record?.error ||
      (typeof data === "string" ? data : `API returned HTTP ${status}`);
    const code = errorObj?.code || record?.code || `HTTP_${status}`;
    return new TenvyrApiError(String(message), status, String(code), data);
  }
}
