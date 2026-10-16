package io.tenvyr.gateway;

import java.net.URI;
import java.util.*;

/** Same startup and browser-origin decision as the retained gateway contract. */
public final class LocalOrigin {
    private final List<String> origins;
    public LocalOrigin(String raw) {
        if (raw == null || raw.isEmpty()) { origins = null; return; }
        origins = Arrays.stream(raw.split(",")).map(String::trim).filter(s -> !s.isEmpty()).toList();
        if (origins.isEmpty() || origins.contains("*")) throw new IllegalArgumentException("CORS_ORIGIN \"" + raw + "\" rejected: wildcard \"*\" is not allowed; list explicit origins, comma-separated");
    }
    public boolean httpAllowed(String origin) { return origins != null && origins.contains(origin); }
    public boolean socketAllowed(String origin) {
        if (origin == null || origin.isEmpty()) return true;
        if (origins != null) return origins.contains(origin);
        try {
            URI uri = URI.create(origin);
            return Set.of("http", "https").contains(uri.getScheme()) && Set.of("127.0.0.1", "localhost", "[::1]", "::1").contains(uri.getHost());
        } catch (RuntimeException e) { return false; }
    }
    public boolean enabled() { return origins != null; }
}
