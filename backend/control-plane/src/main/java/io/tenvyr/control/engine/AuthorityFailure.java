package io.tenvyr.control.engine;

public final class AuthorityFailure extends RuntimeException {
  public final String code;
  public final String disposition;
  public AuthorityFailure(String code, String disposition, String message) { super(message); this.code = code; this.disposition = disposition; }
}
