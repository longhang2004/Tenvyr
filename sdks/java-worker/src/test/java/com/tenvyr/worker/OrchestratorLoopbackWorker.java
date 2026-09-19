package com.tenvyr.worker;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * NDJSON lifecycle fixture for Orchestrator loopback. Not part of the SDK
 * public surface.
 */
public final class OrchestratorLoopbackWorker {
  private static final ObjectMapper JSON = new ObjectMapper();
  private static final AtomicInteger EXECUTIONS = new AtomicInteger();

  private OrchestratorLoopbackWorker() {}

  public static void main(String[] args) {
    try {
      run();
    } catch (Exception error) {
      emit(
          failedEvent(error),
          true);
      System.exit(1);
    }
  }

  private static void run() throws Exception {
    String host = envOr("TENVYR_WORKER_HOST", "127.0.0.1");
    int port = parsePort(envOr("TENVYR_WORKER_PORT", "0"));
    String keyId = required("TENVYR_CALLBACK_KEY_ID");
    TenvyrWorker worker =
        new TenvyrWorker(
            WorkerConfig.builder()
                .agentName("remote-echo-agent")
                .bearerToken(required("TENVYR_WORKER_TOKEN"))
                .callbackKeys(Map.of(keyId, required("TENVYR_CALLBACK_SECRET")))
                .allowedCallbackOrigins(List.of(required("TENVYR_CALLBACK_ORIGIN")))
                .allowInsecureHttp("true".equals(required("TENVYR_ALLOW_INSECURE_HTTP")))
                .callbackMaxAttempts(3)
                .callbackRetryDelayMs(10)
                .callbackMaxRetryDelayMs(20)
                .execute(OrchestratorLoopbackWorker::execute)
                .build());
    CountDownLatch keepAlive = new CountDownLatch(1);
    Runtime.getRuntime()
        .addShutdownHook(
            new Thread(
                () -> {
                  worker.stop();
                  ObjectNode stopped = JSON.createObjectNode();
                  stopped.put("event", "tenvyr.worker.stopped");
                  stopped.put("executions", EXECUTIONS.get());
                  emit(stopped, false);
                }));
    InetSocketAddress address = worker.start(host, port);
    ObjectNode ready = JSON.createObjectNode();
    ready.put("event", "tenvyr.worker.ready");
    ready.put("host", host);
    ready.put("port", address.getPort());
    emit(ready, false);
    keepAlive.await();
  }

  private static JsonNode execute(JsonNode input) {
    EXECUTIONS.incrementAndGet();
    String mode = textOr(input, "mode", "echo");
    if ("safe-boundaries".equals(mode)) {
      ObjectNode output = JSON.createObjectNode();
      output.put("maximum", 9_007_199_254_740_991L);
      output.put("minimum", -9_007_199_254_740_991L);
      return output;
    }
    if ("unsafe-output".equals(mode)) {
      ObjectNode output = JSON.createObjectNode();
      output.put("unsafe", 9_007_199_254_740_993L);
      return output;
    }
    JsonNode message = input.get("message");
    if (message == null || !message.isTextual()) {
      throw new IllegalArgumentException("message must be a string");
    }
    ObjectNode output = JSON.createObjectNode();
    output.put("echo", message.asText());
    return output;
  }

  private static String required(String name) {
    String value = System.getenv(name);
    if (value == null || value.isBlank()) {
      throw new IllegalArgumentException(name + " is required");
    }
    return value;
  }

  private static String envOr(String name, String fallback) {
    String value = System.getenv(name);
    return value == null || value.isBlank() ? fallback : value;
  }

  private static int parsePort(String value) {
    int port;
    try {
      port = Integer.parseInt(value);
    } catch (NumberFormatException error) {
      throw new IllegalArgumentException("TENVYR_WORKER_PORT must be an integer");
    }
    if (port < 0 || port > 65535) {
      throw new IllegalArgumentException("TENVYR_WORKER_PORT must be between 0 and 65535");
    }
    return port;
  }

  private static String textOr(JsonNode node, String field, String fallback) {
    JsonNode value = node.get(field);
    if (value == null || value.isNull() || value.isMissingNode()) {
      return fallback;
    }
    if (!value.isTextual()) {
      throw new IllegalArgumentException(field + " must be a string");
    }
    return value.asText();
  }

  private static ObjectNode failedEvent(Exception error) {
    ObjectNode failed = JSON.createObjectNode();
    failed.put("event", "tenvyr.worker.failed");
    failed.put("error", error.getClass().getSimpleName());
    return failed;
  }

  private static void emit(ObjectNode event, boolean stderr) {
    try {
      String line = JSON.writeValueAsString(event);
      if (stderr) {
        System.err.write((line + "\n").getBytes(StandardCharsets.UTF_8));
        System.err.flush();
      } else {
        System.out.write((line + "\n").getBytes(StandardCharsets.UTF_8));
        System.out.flush();
      }
    } catch (Exception error) {
      throw new IllegalStateException("lifecycle emit failed", error);
    }
  }
}
