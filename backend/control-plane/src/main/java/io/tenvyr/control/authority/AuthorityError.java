package io.tenvyr.control.authority;

/** Stable, bounded domain failure; callers persist the code without payload values. */
public class AuthorityError extends RuntimeException {
    public final String code;
    public AuthorityError(String code, String message) { super(message); this.code=code; }
}
