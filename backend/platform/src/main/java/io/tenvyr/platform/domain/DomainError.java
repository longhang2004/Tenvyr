package io.tenvyr.platform.domain;
public class DomainError extends IllegalArgumentException {
    public final String code;
    public DomainError(String code,String message){super(message);this.code=code;}
}
