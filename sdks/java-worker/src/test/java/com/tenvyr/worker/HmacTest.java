package com.tenvyr.worker;

import static org.junit.jupiter.api.Assertions.assertEquals;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

class HmacTest {
  private static final ObjectMapper JSON = new ObjectMapper();

  @Test
  void sharedConformanceVectors() throws Exception {
    JsonNode vectors = JSON.readTree(Files.readString(vectorsPath()));
    assertEquals(8, vectors.size());
    for (JsonNode vector : vectors) {
      String signature =
          Hmac.sign(
              vector.get("secret").asText(),
              vector.get("timestamp").asText(),
              vector.get("deliveryId").asText(),
              vector.get("rawBodyUtf8").asText().getBytes(StandardCharsets.UTF_8));
      assertEquals(vector.get("expectedSignature").asText(), signature, vector.get("name").asText());
    }
  }

  static Path vectorsPath() {
    Path cwd = Path.of("").toAbsolutePath();
    while (cwd != null) {
      Path candidate = cwd.resolve("contracts/conformance/callback-signatures/vectors.json");
      if (Files.isRegularFile(candidate)) {
        return candidate;
      }
      cwd = cwd.getParent();
    }
    throw new IllegalStateException("vectors.json not found");
  }
}
