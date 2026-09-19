package com.tenvyr.worker;

import com.fasterxml.jackson.databind.JsonNode;
import java.math.BigDecimal;

final class JsonCompat {
  static final BigDecimal MAX_SAFE = new BigDecimal("9007199254740991");

  private JsonCompat() {}

  static void assertSafe(JsonNode node, String path) {
    if (node == null || node.isNull() || node.isMissingNode() || node.isBoolean() || node.isTextual()) {
      return;
    }
    if (node.isNumber()) {
      BigDecimal value = node.decimalValue();
      boolean integral = node.isIntegralNumber() || value.stripTrailingZeros().scale() <= 0;
      if (integral && value.abs().compareTo(MAX_SAFE) > 0) {
        throw new ProtocolException(400, "INVALID_REQUEST", path + " integer must be within the interoperable safe range");
      }
      return;
    }
    if (node.isArray()) {
      int index = 0;
      for (JsonNode child : node) {
        assertSafe(child, path + "[" + index + "]");
        index += 1;
      }
      return;
    }
    if (node.isObject()) {
      var fields = node.fields();
      while (fields.hasNext()) {
        var field = fields.next();
        assertSafe(field.getValue(), path + "." + field.getKey());
      }
    }
  }
}
