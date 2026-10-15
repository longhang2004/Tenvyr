package io.tenvyr.control.runtime;

public final class RuntimeFailure extends RuntimeException {
    private final String code;
    public RuntimeFailure(String code,String message) { super(message);this.code=code; }
    public String code() {return code;}
    public boolean retryable() {return code.endsWith("CONFLICT") || code.endsWith("IN_PROGRESS") || code.endsWith("INTERRUPTED");}
}
