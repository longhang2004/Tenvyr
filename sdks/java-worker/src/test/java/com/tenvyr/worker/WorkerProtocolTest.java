package com.tenvyr.worker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

class WorkerProtocolTest {
  private static final ObjectMapper JSON = new ObjectMapper();
  private static final HttpClient HTTP = HttpClient.newHttpClient();
  private TenvyrWorker worker;

  @AfterEach
  void stop() {
    if (worker != null) {
      worker.stop();
    }
  }

  @Test
  void submitAcceptedThenSignedCallback() throws Exception {
    CountDownLatch delivered = new CountDownLatch(1);
    AtomicReference<Captured> captured = new AtomicReference<>();
    HttpServer orchestrator = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
    orchestrator.createContext(
        "/internal/agent-callbacks/http/echo-agent",
        exchange -> {
          byte[] body = exchange.getRequestBody().readAllBytes();
          captured.set(
              new Captured(
                  exchange.getRequestHeaders().getFirst(Hmac.HEADER_KEY_ID),
                  exchange.getRequestHeaders().getFirst(Hmac.HEADER_TIMESTAMP),
                  exchange.getRequestHeaders().getFirst(Hmac.HEADER_DELIVERY_ID),
                  exchange.getRequestHeaders().getFirst(Hmac.HEADER_SIGNATURE),
                  body));
          exchange.sendResponseHeaders(204, -1);
          exchange.close();
          delivered.countDown();
        });
    orchestrator.start();
    int callbackPort = orchestrator.getAddress().getPort();
    String origin = "http://127.0.0.1:" + callbackPort;
    worker =
        new TenvyrWorker(
            WorkerConfig.builder()
                .agentName("echo-agent")
                .bearerToken("token")
                .callbackKeys(Map.of("conformance-v1", "tenvyr-conformance-secret"))
                .allowedCallbackOrigins(List.of(origin))
                .allowInsecureHttp(true)
                .callbackMaxAttempts(3)
                .execute(input -> input)
                .build());
    worker.start("127.0.0.1", 0);
    String callbackUrl = origin + "/internal/agent-callbacks/http/echo-agent";
    HttpResponse<String> first = postRun(runRequest("invocation-1", callbackUrl, JSON.nullNode()));
    assertEquals(202, first.statusCode());
    JsonNode accepted = JSON.readTree(first.body());
    assertEquals("accepted", accepted.get("status").asText());
    assertEquals("invocation-1", accepted.get("invocationId").asText());
    HttpResponse<String> duplicate = postRun(runRequest("invocation-1", callbackUrl, JSON.nullNode()));
    assertEquals(202, duplicate.statusCode());
    assertEquals(accepted.get("runId").asText(), JSON.readTree(duplicate.body()).get("runId").asText());
    assertTrue(delivered.await(5, TimeUnit.SECONDS), "callback was not delivered");
    Captured callback = captured.get();
    assertEquals("conformance-v1", callback.keyId);
    assertEquals(
        Hmac.sign("tenvyr-conformance-secret", callback.timestamp, callback.deliveryId, callback.body),
        callback.signature);
    JsonNode result = JSON.readTree(callback.body);
    assertEquals("succeeded", result.get("status").asText());
    assertEquals("invocation-1", result.get("invocationId").asText());
    orchestrator.stop(0);
  }

  @Test
  void unsafeHandlerOutputBecomesAgentOutputInvalid() throws Exception {
    CountDownLatch delivered = new CountDownLatch(1);
    AtomicReference<byte[]> callbackBody = new AtomicReference<>();
    HttpServer orchestrator = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
    orchestrator.createContext(
        "/internal/agent-callbacks/http/echo-agent",
        exchange -> {
          callbackBody.set(exchange.getRequestBody().readAllBytes());
          exchange.sendResponseHeaders(204, -1);
          exchange.close();
          delivered.countDown();
        });
    orchestrator.start();
    String origin = "http://127.0.0.1:" + orchestrator.getAddress().getPort();
    worker =
        new TenvyrWorker(
            WorkerConfig.builder()
                .agentName("echo-agent")
                .bearerToken("token")
                .callbackKeys(Map.of("conformance-v1", "secret"))
                .allowedCallbackOrigins(List.of(origin))
                .allowInsecureHttp(true)
                .callbackMaxAttempts(1)
                .execute(
                    input -> {
                      ObjectNode output = JSON.createObjectNode();
                      output.put("unsafe", 9_007_199_254_740_993L);
                      return output;
                    })
                .build());
    worker.start("127.0.0.1", 0);
    HttpResponse<String> accepted =
        postRun(runRequest("invocation-unsafe-output", origin + "/internal/agent-callbacks/http/echo-agent", JSON.nullNode()));
    assertEquals(202, accepted.statusCode());
    assertTrue(delivered.await(5, TimeUnit.SECONDS), "callback was not delivered");
    JsonNode result = JSON.readTree(callbackBody.get());
    assertEquals("failed", result.get("status").asText());
    assertEquals("AGENT_OUTPUT_INVALID", result.get("error").get("code").asText());
    assertEquals("Agent output validation failed", result.get("error").get("message").asText());
    assertEquals(false, result.get("error").get("retryable").asBoolean());
    orchestrator.stop(0);
  }

  @Test
  void unauthorizedWithoutBearer() throws Exception {
    worker =
        new TenvyrWorker(
            WorkerConfig.builder()
                .agentName("echo-agent")
                .bearerToken("token")
                .callbackKeys(Map.of("conformance-v1", "secret"))
                .allowedCallbackOrigins(List.of("https://orchestrator.example"))
                .build());
    worker.start("127.0.0.1", 0);
    HttpRequest request =
        HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + worker.port() + "/v1/runs"))
            .timeout(Duration.ofSeconds(2))
            .header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString("{}"))
            .build();
    HttpResponse<String> response = HTTP.send(request, HttpResponse.BodyHandlers.ofString());
    assertEquals(401, response.statusCode());
    assertEquals("UNAUTHORIZED", JSON.readTree(response.body()).get("error").get("code").asText());
  }

  @Test
  void rejectsUnsafeInteger() throws Exception {
    worker =
        new TenvyrWorker(
            WorkerConfig.builder()
                .agentName("echo-agent")
                .bearerToken("token")
                .callbackKeys(Map.of("conformance-v1", "secret"))
                .allowedCallbackOrigins(List.of("https://orchestrator.example"))
                .build());
    worker.start("127.0.0.1", 0);
    ObjectNode input = JSON.createObjectNode();
    input.put("n", new java.math.BigDecimal("9007199254740992"));
    HttpResponse<String> response =
        postRun(runRequest("invocation-unsafe", "https://orchestrator.example/callback", input));
    assertEquals(400, response.statusCode());
    assertEquals("INVALID_REQUEST", JSON.readTree(response.body()).get("error").get("code").asText());
  }

  private HttpResponse<String> postRun(String body) throws Exception {
    JsonNode parsed = JSON.readTree(body);
    HttpRequest request =
        HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + worker.port() + "/v1/runs"))
            .timeout(Duration.ofSeconds(2))
            .header("Content-Type", "application/json")
            .header("Authorization", "Bearer token")
            .header("Idempotency-Key", parsed.get("invocation").get("invocationId").asText())
            .POST(HttpRequest.BodyPublishers.ofString(body))
            .build();
    return HTTP.send(request, HttpResponse.BodyHandlers.ofString());
  }

  private static String runRequest(String invocationId, String callbackUrl, JsonNode input) throws Exception {
    ObjectNode root = JSON.createObjectNode();
    root.put("schemaVersion", "1");
    ObjectNode invocation = root.putObject("invocation");
    invocation.put("schemaVersion", "1");
    invocation.put("invocationId", invocationId);
    invocation.put("executionId", "execution-1");
    invocation.put("stepExecutionId", "step-1");
    invocation.put("stepId", "echo");
    invocation.putObject("target").put("agent", "echo-agent");
    invocation.set("input", input);
    invocation.put("attempt", 1);
    invocation.put("createdAt", "2026-07-26T00:00:00.000Z");
    ObjectNode trace = invocation.putObject("trace");
    trace.put("traceId", "trace-1");
    trace.put("correlationId", invocationId);
    ObjectNode delivery = root.putObject("resultDelivery");
    delivery.put("mode", "callback");
    delivery.put("callbackUrl", callbackUrl);
    ObjectNode auth = delivery.putObject("authentication");
    auth.put("scheme", "hmac-sha256");
    auth.put("keyId", "conformance-v1");
    return JSON.writeValueAsString(root);
  }

  private record Captured(String keyId, String timestamp, String deliveryId, String signature, byte[] body) {}
}
