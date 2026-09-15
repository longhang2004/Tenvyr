package com.tenvyr.worker;

import java.nio.charset.StandardCharsets;
import java.util.HexFormat;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

public final class Hmac {
  public static final String HEADER_KEY_ID = "X-AgentWeave-Key-Id";
  public static final String HEADER_TIMESTAMP = "X-AgentWeave-Timestamp";
  public static final String HEADER_DELIVERY_ID = "X-AgentWeave-Delivery-Id";
  public static final String HEADER_SIGNATURE = "X-AgentWeave-Signature";

  private Hmac() {}

  public static String sign(String secret, String timestamp, String deliveryId, byte[] rawBody) {
    try {
      Mac mac = Mac.getInstance("HmacSHA256");
      mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
      mac.update(timestamp.getBytes(StandardCharsets.UTF_8));
      mac.update((byte) '.');
      mac.update(deliveryId.getBytes(StandardCharsets.UTF_8));
      mac.update((byte) '.');
      mac.update(rawBody);
      return "v1=" + HexFormat.of().formatHex(mac.doFinal());
    } catch (Exception error) {
      throw new IllegalStateException("HMAC-SHA256 is required", error);
    }
  }
}
