package io.tenvyr.control.engine;

public final class AdapterError extends RuntimeException {
  public final String code;
  public final boolean retryable;
  public final int httpStatus;
  public AdapterError(String code, boolean retryable, String message) { this(code, retryable, message, 0, null); }
  public AdapterError(String code, boolean retryable, String message, int status, Throwable cause) { super(message, cause); this.code = code; this.retryable = retryable; this.httpStatus = status; }
}
