package com.tenvyr.worker;

import java.net.URI;
import java.util.Collection;
import java.util.Locale;
import java.util.Set;

final class Origins {
  record Origin(String scheme, String host, int port) {}

  private Origins() {}

  static Origin parseOrigin(String value, boolean allowInsecureHttp) {
    URI uri = parseAbsolute(value);
    if (uri.getRawPath() != null && !uri.getRawPath().isEmpty() && !uri.getRawPath().equals("/")) {
      throw new ProtocolException(400, "CALLBACK_TARGET_REJECTED", "callback origin must not contain a path, query, or fragment");
    }
    return originOf(uri, allowInsecureHttp);
  }

  static String validateCallbackUrl(String value, Collection<Origin> allowed, boolean allowInsecureHttp) {
    URI uri = parseAbsolute(value);
    Origin origin = originOf(uri, allowInsecureHttp);
    if (!allowed.contains(origin)) {
      throw new ProtocolException(400, "CALLBACK_TARGET_REJECTED", "callback URL origin is not allowed");
    }
    return value;
  }

  private static URI parseAbsolute(String value) {
    if (value == null || value.isBlank()) {
      throw new ProtocolException(400, "CALLBACK_TARGET_REJECTED", "callback URL must be a valid absolute URL");
    }
    for (int i = 0; i < value.length(); i += 1) {
      char character = value.charAt(i);
      if (character <= 32 || character == 127) {
        throw new ProtocolException(400, "CALLBACK_TARGET_REJECTED", "callback URL must be a valid absolute URL");
      }
    }
    URI uri;
    try {
      uri = URI.create(value);
    } catch (IllegalArgumentException error) {
      throw new ProtocolException(400, "CALLBACK_TARGET_REJECTED", "callback URL must be a valid absolute URL");
    }
    if (uri.getScheme() == null || uri.getHost() == null) {
      throw new ProtocolException(400, "CALLBACK_TARGET_REJECTED", "callback URL must be a valid absolute URL");
    }
    if (uri.getUserInfo() != null) {
      throw new ProtocolException(400, "CALLBACK_TARGET_REJECTED", "callback URL must not contain credentials");
    }
    if (uri.getRawQuery() != null) {
      throw new ProtocolException(400, "CALLBACK_TARGET_REJECTED", "callback URL must not contain a query");
    }
    if (uri.getRawFragment() != null) {
      throw new ProtocolException(400, "CALLBACK_TARGET_REJECTED", "callback URL must not contain a fragment");
    }
    return uri;
  }

  private static Origin originOf(URI uri, boolean allowInsecureHttp) {
    String scheme = uri.getScheme().toLowerCase(Locale.ROOT);
    if (!scheme.equals("https") && !(scheme.equals("http") && allowInsecureHttp)) {
      throw new ProtocolException(
          400,
          "CALLBACK_TARGET_REJECTED",
          "callback URL requires HTTPS unless insecure HTTP is explicitly allowed");
    }
    int port = uri.getPort();
    if (port < 0) {
      port = scheme.equals("https") ? 443 : 80;
    }
    return new Origin(scheme, uri.getHost().toLowerCase(Locale.ROOT), port);
  }

  static Set<Origin> freeze(Collection<String> origins, boolean allowInsecureHttp) {
    return Set.copyOf(origins.stream().map(value -> parseOrigin(value, allowInsecureHttp)).toList());
  }
}
