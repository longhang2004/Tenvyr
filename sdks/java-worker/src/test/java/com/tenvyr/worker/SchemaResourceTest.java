package com.tenvyr.worker;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;

import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

class SchemaResourceTest {
  private static final String[] SCHEMAS = {
    "agent-event.v1.schema.json",
    "agent-invocation.v1.schema.json",
    "agent-result.v1.schema.json",
    "http-agent-run-accepted.v1.schema.json",
    "http-agent-run-request.v1.schema.json"
  };

  @Test
  void bundledSchemasMatchContracts() throws Exception {
    Path contracts = HmacTest.vectorsPath().getParent().getParent().getParent().resolve("schemas");
    for (String name : SCHEMAS) {
      try (var stream = SchemaResourceTest.class.getResourceAsStream("/schema_json/" + name)) {
        assertNotNull(stream, name);
        assertArrayEquals(Files.readAllBytes(contracts.resolve(name)), stream.readAllBytes(), name);
      }
    }
  }
}
