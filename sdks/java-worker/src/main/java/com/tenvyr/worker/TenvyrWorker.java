package com.tenvyr.worker;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sun.net.httpserver.Headers;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.HexFormat;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class TenvyrWorker {
  private static final ObjectMapper JSON = new ObjectMapper();
  private static final Pattern BEARER = Pattern.compile("Bearer ([^\\s]+)", Pattern.CASE_INSENSITIVE);
  private static final Set<String> REQUEST_KEYS = Set.of("schemaVersion", "invocation", "resultDelivery");
  private static final Set<String> INVOCATION_KEYS =
      Set.of(
          "schemaVersion",
          "invocationId",
          "executionId",
          "stepExecutionId",
          "stepId",
          "target",
          "input",
          "context",
          "attempt",
          "createdAt",
          "deadlineAt",
          "trace",
          "metadata",
          "connection",
          "requestedModelId");
  private static final Set<String> REQUIRED_INVOCATION =
      Set.of(
          "schemaVersion",
          "invocationId",
          "executionId",
          "stepExecutionId",
          "stepId",
          "target",
          "input",
          "attempt",
          "createdAt",
          "trace");

  private final WorkerConfig config;
  private final Set<Origins.Origin> origins;
  private final CallbackClient callbacks = new CallbackClient();
  private final Map<String, Acceptance> idempotency = new ConcurrentHashMap<>();
  private final Object lock = new Object();
  private final ExecutorService pool;
  private HttpServer server;
  private volatile boolean running;

  public TenvyrWorker(WorkerConfig config) {
    this.config = config;
    this.origins = Origins.freeze(config.allowedCallbackOrigins, config.allowInsecureHttp);
    ThreadPoolExecutor executor =
        new ThreadPoolExecutor(
            config.executionConcurrency,
            config.executionConcurrency,
            60L,
            TimeUnit.SECONDS,
            new java.util.concurrent.LinkedBlockingQueue<>(config.maxQueuedRuns),
            Executors.defaultThreadFactory());
    executor.setRejectedExecutionHandler(new ThreadPoolExecutor.AbortPolicy());
    this.pool = executor;
  }

  public synchronized InetSocketAddress start(String host, int port) throws IOException {
    if (server != null) {
      throw new IllegalStateException("already started");
    }
    server = HttpServer.create(new InetSocketAddress(host, port), 0);
    server.createContext("/v1/runs", this::handleRuns);
    server.createContext("/health/live", exchange -> json(exchange, 200, "{\"status\":\"ok\"}"));
    server.createContext("/health/ready", this::handleReady);
    server.createContext("/", this::handleNotFound);
    server.setExecutor(Executors.newCachedThreadPool());
    running = true;
    server.start();
    return server.getAddress();
  }

  public synchronized void stop() {
    running = false;
    if (server != null) {
      server.stop(0);
      server = null;
    }
    pool.shutdownNow();
  }

  public int port() {
    return server.getAddress().getPort();
  }

  private void handleReady(HttpExchange exchange) throws IOException {
    if (running) {
      json(exchange, 200, "{\"status\":\"ok\"}");
    } else {
      json(exchange, 503, "{\"status\":\"unavailable\"}");
    }
  }

  private void handleNotFound(HttpExchange exchange) throws IOException {
    error(exchange, 404, "NOT_FOUND", "not found");
  }

  private void handleRuns(HttpExchange exchange) throws IOException {
    if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
      error(exchange, 404, "NOT_FOUND", "not found");
      return;
    }
    if (!running) {
      drain(exchange);
      error(exchange, 503, "WORKER_NOT_READY", "worker is not ready");
      return;
    }
    if (!authenticate(exchange.getRequestHeaders().getFirst("Authorization"))) {
      drain(exchange);
      error(exchange, 401, "UNAUTHORIZED", "unauthorized", Map.of("WWW-Authenticate", "Bearer"));
      return;
    }
    String contentType = exchange.getRequestHeaders().getFirst("Content-Type");
    if (contentType == null || !contentType.toLowerCase(Locale.ROOT).startsWith("application/json")) {
      drain(exchange);
      error(exchange, 415, "UNSUPPORTED_MEDIA_TYPE", "unsupported media type");
      return;
    }
    byte[] body;
    try {
      body = readBody(exchange);
    } catch (ProtocolException error) {
      error(exchange, error.status, error.code, error.getMessage());
      return;
    }
    try {
      Acceptance accepted = accept(exchange.getRequestHeaders(), body);
      json(exchange, 202, accepted.body);
    } catch (ProtocolException error) {
      error(exchange, error.status, error.code, error.getMessage());
    } catch (RejectedExecutionException error) {
      error(exchange, 429, "QUEUE_FULL", "queue is full");
    } catch (Exception error) {
      error(exchange, 500, "INTERNAL_ERROR", "internal error");
    }
  }

  private Acceptance accept(Headers headers, byte[] body) {
    JsonNode root;
    try {
      root = JSON.readTree(body);
    } catch (Exception error) {
      throw new ProtocolException(400, "INVALID_JSON", "invalid JSON");
    }
    JsonCompat.assertSafe(root, "$");
    JsonNode invocation = parseRequest(root);
    String invocationId = text(invocation, "invocationId");
    String idempotencyKey = headers.getFirst("Idempotency-Key");
    if (idempotencyKey == null || !idempotencyKey.equals(invocationId)) {
      throw new ProtocolException(400, "INVALID_IDEMPOTENCY_KEY", "Idempotency-Key must equal invocationId");
    }
    String fingerprint;
    try {
      fingerprint = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(body));
    } catch (Exception error) {
      throw new ProtocolException(500, "INTERNAL_ERROR", "fingerprint failed");
    }
    JsonNode delivery = root.get("resultDelivery");
    String keyId = text(delivery.get("authentication"), "keyId");
    String secret = config.callbackKeys.get(keyId);
    if (secret == null) {
      throw new ProtocolException(400, "UNKNOWN_CALLBACK_KEY", "unknown callback key");
    }
    String callbackUrl =
        Origins.validateCallbackUrl(text(delivery, "callbackUrl"), origins, config.allowInsecureHttp);
    synchronized (lock) {
      Acceptance existing = idempotency.get(invocationId);
      if (existing != null) {
        if (!existing.fingerprint.equals(fingerprint)) {
          throw new ProtocolException(409, "IDEMPOTENCY_CONFLICT", "idempotency conflict");
        }
        return existing;
      }
      if (idempotency.size() >= 10_000) {
        throw new ProtocolException(429, "IDEMPOTENCY_CAPACITY_FULL", "idempotency store is full");
      }
      String runId = UUID.randomUUID().toString();
      String acceptedAt = Instant.now().toString();
      ObjectNode acceptance = JSON.createObjectNode();
      acceptance.put("schemaVersion", "1");
      acceptance.put("invocationId", invocationId);
      acceptance.put("runId", runId);
      acceptance.put("status", "accepted");
      acceptance.put("acceptedAt", acceptedAt);
      byte[] acceptedBody;
      try {
        acceptedBody = JSON.writeValueAsBytes(acceptance);
      } catch (IOException error) {
        throw new ProtocolException(500, "INTERNAL_ERROR", "acceptance serialize failed");
      }
      Acceptance record = new Acceptance(fingerprint, acceptedBody);
      idempotency.put(invocationId, record);
      pool.execute(() -> execute(invocation, callbackUrl, keyId, secret));
      return record;
    }
  }

  private JsonNode parseRequest(JsonNode root) {
    if (!root.isObject() || !REQUEST_KEYS.equals(fieldNames(root))) {
      throw new ProtocolException(400, "INVALID_REQUEST", "run request is invalid");
    }
    if (!"1".equals(text(root, "schemaVersion"))) {
      throw new ProtocolException(400, "INVALID_REQUEST", "schemaVersion must be 1");
    }
    JsonNode invocation = root.get("invocation");
    if (!invocation.isObject() || !invocation.fieldNames().hasNext()) {
      throw new ProtocolException(400, "INVALID_REQUEST", "invocation is invalid");
    }
    for (String name : fieldNames(invocation)) {
      if (!INVOCATION_KEYS.contains(name)) {
        throw new ProtocolException(400, "INVALID_REQUEST", "invocation has unknown field " + name);
      }
    }
    for (String required : REQUIRED_INVOCATION) {
      if (!invocation.has(required)) {
        throw new ProtocolException(400, "INVALID_REQUEST", "invocation missing " + required);
      }
    }
    if (!"1".equals(text(invocation, "schemaVersion"))) {
      throw new ProtocolException(400, "INVALID_REQUEST", "invocation schemaVersion must be 1");
    }
    JsonNode target = invocation.get("target");
    if (!target.isObject() || !target.has("agent") || fieldNames(target).size() != 1) {
      throw new ProtocolException(400, "INVALID_REQUEST", "target is invalid");
    }
    String agent = text(target, "agent");
    if (!config.agentName.equals(agent)) {
      throw new ProtocolException(404, "AGENT_NOT_FOUND", "agent not found");
    }
    JsonNode delivery = root.get("resultDelivery");
    if (!delivery.isObject()
        || !Set.of("mode", "callbackUrl", "authentication").equals(fieldNames(delivery))
        || !"callback".equals(text(delivery, "mode"))) {
      throw new ProtocolException(400, "INVALID_REQUEST", "resultDelivery is invalid");
    }
    JsonNode authentication = delivery.get("authentication");
    if (!authentication.isObject()
        || !Set.of("scheme", "keyId").equals(fieldNames(authentication))
        || !"hmac-sha256".equals(text(authentication, "scheme"))) {
      throw new ProtocolException(400, "INVALID_REQUEST", "callback authentication is invalid");
    }
    JsonNode trace = invocation.get("trace");
    if (!trace.isObject() || !trace.has("traceId") || !trace.has("correlationId")) {
      throw new ProtocolException(400, "INVALID_REQUEST", "trace is invalid");
    }
    if (!invocation.get("attempt").canConvertToInt() || invocation.get("attempt").asInt() < 1) {
      throw new ProtocolException(400, "INVALID_REQUEST", "attempt is invalid");
    }
    return invocation;
  }

  private void execute(JsonNode invocation, String callbackUrl, String keyId, String secret) {
    ObjectNode result = JSON.createObjectNode();
    result.put("schemaVersion", "1");
    result.put("invocationId", text(invocation, "invocationId"));
    result.put("executionId", text(invocation, "executionId"));
    result.put("stepExecutionId", text(invocation, "stepExecutionId"));
    try {
      JsonNode output = config.execute.apply(invocation.get("input"));
      JsonCompat.assertSafe(output, "$.output");
      result.put("status", "succeeded");
      result.put("completedAt", Instant.now().toString());
      result.set("output", output == null || output.isMissingNode() ? JSON.nullNode() : output);
    } catch (Exception error) {
      result.put("status", "failed");
      result.put("completedAt", Instant.now().toString());
      ObjectNode failure = result.putObject("error");
      failure.put("code", "AGENT_FAILED");
      failure.put("message", error.getMessage() == null ? "agent failed" : error.getMessage());
      failure.put("retryable", false);
    }
    try {
      byte[] payload = JSON.writeValueAsBytes(result);
      callbacks.deliver(callbackUrl, keyId, secret, payload, config.callbackMaxAttempts);
    } catch (Exception error) {
      System.err.println("callback delivery failed: " + error.getMessage());
    }
  }

  private boolean authenticate(String header) {
    if (header == null) {
      return false;
    }
    Matcher match = BEARER.matcher(header);
    if (!match.matches()) {
      return false;
    }
    byte[] provided = match.group(1).getBytes(StandardCharsets.UTF_8);
    byte[] expected = config.bearerToken.getBytes(StandardCharsets.UTF_8);
    return MessageDigest.isEqual(provided, expected);
  }

  private byte[] readBody(HttpExchange exchange) throws IOException {
    long declared = exchange.getRequestHeaders().getFirst("Content-Length") == null
        ? -1
        : Long.parseLong(exchange.getRequestHeaders().getFirst("Content-Length"));
    if (declared > config.maxRequestBytes) {
      drain(exchange);
      throw new ProtocolException(413, "REQUEST_TOO_LARGE", "request too large");
    }
    try (InputStream input = exchange.getRequestBody()) {
      byte[] data = input.readNBytes(config.maxRequestBytes + 1);
      if (data.length > config.maxRequestBytes) {
        throw new ProtocolException(413, "REQUEST_TOO_LARGE", "request too large");
      }
      return data;
    }
  }

  private static Set<String> fieldNames(JsonNode node) {
    java.util.LinkedHashSet<String> names = new java.util.LinkedHashSet<>();
    node.fieldNames().forEachRemaining(names::add);
    return names;
  }

  private static String text(JsonNode node, String field) {
    JsonNode value = node.get(field);
    if (value == null || !value.isTextual() || value.asText().isEmpty()) {
      throw new ProtocolException(400, "INVALID_REQUEST", field + " is invalid");
    }
    return value.asText();
  }

  private static void drain(HttpExchange exchange) {
    try (InputStream input = exchange.getRequestBody()) {
      input.transferTo(OutputStream.nullOutputStream());
    } catch (IOException ignored) {
      // best-effort unread
    }
  }

  private static void error(HttpExchange exchange, int status, String code, String message) throws IOException {
    error(exchange, status, code, message, Map.of());
  }

  private static void error(
      HttpExchange exchange, int status, String code, String message, Map<String, String> extra) throws IOException {
    ObjectNode body = JSON.createObjectNode();
    ObjectNode error = body.putObject("error");
    error.put("code", code);
    error.put("message", message);
    json(exchange, status, JSON.writeValueAsString(body), extra);
  }

  private static void json(HttpExchange exchange, int status, String body) throws IOException {
    json(exchange, status, body, Map.of());
  }

  private static void json(HttpExchange exchange, int status, byte[] body) throws IOException {
    json(exchange, status, body, Map.of());
  }

  private static void json(HttpExchange exchange, int status, String body, Map<String, String> extra)
      throws IOException {
    json(exchange, status, body.getBytes(StandardCharsets.UTF_8), extra);
  }

  private static void json(HttpExchange exchange, int status, byte[] body, Map<String, String> extra)
      throws IOException {
    Headers headers = exchange.getResponseHeaders();
    headers.set("Content-Type", "application/json; charset=utf-8");
    extra.forEach(headers::set);
    exchange.sendResponseHeaders(status, body.length);
    try (OutputStream output = exchange.getResponseBody()) {
      output.write(body);
    }
  }

  private record Acceptance(String fingerprint, byte[] body) {}
}
