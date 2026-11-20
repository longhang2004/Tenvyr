package io.tenvyr.reviewworker;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import io.tenvyr.agents.AgentProcessor;
import io.tenvyr.platform.Json;
import io.tenvyr.worker.CallbackDelivery;
import io.tenvyr.worker.Worker;
import io.tenvyr.worker.WorkerConfig;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BooleanSupplier;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Real loopback integration tests for Review Worker HTTP hosting, HMAC callback delivery,
 * scheduling/admission, idempotency, failure mapping, and bounded HTTP runner factory checks.
 */
class ReviewWorkerIntegrationTest {

    private static final HttpClient HTTP_CLIENT = HttpClient.newBuilder()
            .followRedirects(HttpClient.Redirect.NEVER)
            .build();

    private HttpServer callbackServer;
    private int callbackPort;
    private ExecutorService callbackExecutor;

    private final List<CapturedDelivery> capturedDeliveries = new CopyOnWriteArrayList<>();
    private final List<Throwable> callbackErrors = new CopyOnWriteArrayList<>();
    private final AtomicInteger callbackStatusCode = new AtomicInteger(204);
    private final AtomicInteger callbackAttempts = new AtomicInteger(0);
    private volatile int retry503Threshold = 0;

    private record CapturedDelivery(byte[] raw, String deliveryId, String timestamp, String signature, String keyId, JsonNode body) {}

    @BeforeEach
    void setUpCallbackServer() throws IOException {
        capturedDeliveries.clear();
        callbackErrors.clear();
        callbackStatusCode.set(204);
        callbackAttempts.set(0);
        retry503Threshold = 0;

        callbackExecutor = Executors.newCachedThreadPool();
        callbackServer = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        callbackServer.setExecutor(callbackExecutor);

        callbackServer.createContext("/callback", exchange -> {
            try {
                byte[] raw = exchange.getRequestBody().readAllBytes();
                String deliveryId = exchange.getRequestHeaders().getFirst(CallbackDelivery.DELIVERY_ID);
                String timestamp = exchange.getRequestHeaders().getFirst(CallbackDelivery.TIMESTAMP);
                String signature = exchange.getRequestHeaders().getFirst(CallbackDelivery.SIGNATURE);
                String keyId = exchange.getRequestHeaders().getFirst(CallbackDelivery.KEY_ID);

                try {
                    assertEquals("test-key", keyId, "Callback Key ID header");
                    assertNotNull(deliveryId, "Delivery ID must be present");
                    assertNotNull(timestamp, "Timestamp must be present");
                    assertNotNull(signature, "Signature must be present");
                    String expectedSignature = CallbackDelivery.signature("test-secret", timestamp, deliveryId, raw);
                    assertEquals(expectedSignature, signature, "HMAC-SHA256 signature over exact transmitted bytes");
                } catch (Throwable t) {
                    callbackErrors.add(t);
                }

                JsonNode parsed = Json.parse(new String(raw, StandardCharsets.UTF_8));
                capturedDeliveries.add(new CapturedDelivery(raw, deliveryId, timestamp, signature, keyId, parsed));

                int attempt = callbackAttempts.incrementAndGet();
                int status = (attempt <= retry503Threshold) ? 503 : callbackStatusCode.get();
                if (attempt <= retry503Threshold) {
                    exchange.getResponseHeaders().set("Retry-After", "0");
                }

                exchange.sendResponseHeaders(status, -1);
            } catch (Throwable t) {
                callbackErrors.add(t);
            } finally {
                exchange.close();
            }
        });

        callbackServer.start();
        callbackPort = callbackServer.getAddress().getPort();
    }

    @AfterEach
    void tearDownCallbackServer() {
        if (callbackServer != null) {
            callbackServer.stop(0);
        }
        if (callbackExecutor != null) {
            callbackExecutor.shutdownNow();
        }
    }

    private WorkerConfig createWorkerConfig() {
        WorkerConfig config = new WorkerConfig();
        config.agentName = "code-reviewer";
        config.bearerToken = "test-token";
        config.callbackKeys = Map.of("test-key", "test-secret");
        config.allowedOrigins = List.of("http://127.0.0.1:" + callbackPort);
        config.allowInsecureHttp = true;
        config.concurrency = 2;
        config.maxQueuedRuns = 16;
        config.maxRequestBytes = 1_048_576;
        config.maxResponseBytes = 65_536;
        config.callbackMaxAttempts = 3;
        config.callbackInitialDelayMs = 20;
        config.callbackMaxDelayMs = 100;
        config.callbackJitterRatio = 0;
        config.callbackRequestTimeoutMs = 1000;
        config.shutdownGraceMs = 1000;
        return config;
    }

    private ObjectNode createRunRequest(String invocationId, int targetCallbackPort) {
        return Json.object(
                "schemaVersion", "1",
                "invocation", Json.object(
                        "schemaVersion", "1",
                        "invocationId", invocationId,
                        "executionId", "exec-" + invocationId,
                        "stepExecutionId", "step-" + invocationId,
                        "stepId", "review",
                        "target", Json.object("agent", "code-reviewer"),
                        "input", Json.object("code", "const x = 1;", "language", "typescript"),
                        "attempt", 1,
                        "createdAt", "2026-07-26T00:00:00.000Z",
                        "trace", Json.object("traceId", "trace-" + invocationId, "correlationId", invocationId)
                ),
                "resultDelivery", Json.object(
                        "mode", "callback",
                        "callbackUrl", "http://127.0.0.1:" + targetCallbackPort + "/callback",
                        "authentication", Json.object(
                                "scheme", "hmac-sha256",
                                "keyId", "test-key"
                        )
                )
        );
    }

    private HttpResponse<String> submit(Worker worker, String invocationId, String token, ObjectNode request) throws Exception {
        return HTTP_CLIENT.send(
                HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + worker.port() + "/v1/runs"))
                        .timeout(Duration.ofSeconds(3))
                        .header("Content-Type", "application/json")
                        .header("Authorization", "Bearer " + token)
                        .header("Idempotency-Key", invocationId)
                        .POST(HttpRequest.BodyPublishers.ofString(Json.stringify(request)))
                        .build(),
                HttpResponse.BodyHandlers.ofString()
        );
    }

    private void await(BooleanSupplier condition, String message, long seconds) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(seconds);
        while (!condition.getAsBoolean() && System.nanoTime() < deadline) {
            Thread.sleep(10);
        }
        assertTrue(condition.getAsBoolean(), message);
    }

    private void assertNoCallbackErrors() {
        if (!callbackErrors.isEmpty()) {
            throw new AssertionError("Callback verification failure on asynchronous handler", callbackErrors.get(0));
        }
    }

    @Test
    @DisplayName("Loopback Worker submission yields 202 accepted, signed raw callback, and direct score/findings output")
    void loopbackWorkerSucceedsAndDeliversSignedDirectOutput() throws Exception {
        AgentProcessor.Runner runner = (prompt, context, timeout) -> Json.object(
                "success", true,
                "data", Json.object(
                        "output", "{\"score\":100,\"findings\":[\"Clean code.\"]}",
                        "metadata", Json.object("provider", "mock", "model", "demo-fixture")
                )
        );

        try (Worker worker = ReviewWorkerMain.create(createWorkerConfig(), runner)) {
            worker.start("127.0.0.1", 0);

            ObjectNode request = createRunRequest("loopback-run-1", callbackPort);
            HttpResponse<String> response = submit(worker, "loopback-run-1", "test-token", request);

            assertEquals(202, response.statusCode());
            JsonNode accepted = Json.parse(response.body());
            assertEquals("accepted", accepted.path("status").asText());
            assertEquals("loopback-run-1", accepted.path("invocationId").asText());
            assertNotNull(accepted.path("runId").asText());

            await(() -> !capturedDeliveries.isEmpty(), "Callback must be delivered", 5);
            assertNoCallbackErrors();

            CapturedDelivery delivery = capturedDeliveries.get(0);
            JsonNode result = delivery.body;

            assertEquals("1", result.path("schemaVersion").asText());
            assertEquals("loopback-run-1", result.path("invocationId").asText());
            assertEquals("exec-loopback-run-1", result.path("executionId").asText());
            assertEquals("step-loopback-run-1", result.path("stepExecutionId").asText());
            assertEquals("succeeded", result.path("status").asText());

            // Output must contain score and findings directly, not a nested result envelope
            JsonNode output = result.path("output");
            assertNotNull(output);
            assertEquals(100, output.path("score").asInt());
            assertEquals(1, output.path("findings").size());
            assertEquals("Clean code.", output.path("findings").get(0).asText());
            assertFalse(output.has("invocationId"), "Output must not be a nested AgentResult envelope");
            assertFalse(output.has("schemaVersion"), "Output must not be a nested AgentResult envelope");
        }
    }

    @Test
    @DisplayName("Unauthenticated request is rejected with 401 Bearer challenge")
    void bearerAuthenticationDenied() throws Exception {
        AgentProcessor.Runner runner = (p, c, t) -> Json.object("success", true);

        try (Worker worker = ReviewWorkerMain.create(createWorkerConfig(), runner)) {
            worker.start("127.0.0.1", 0);

            ObjectNode request = createRunRequest("unauth-run", callbackPort);
            HttpResponse<String> response = submit(worker, "unauth-run", "wrong-token", request);

            assertEquals(401, response.statusCode());
            assertEquals(0, capturedDeliveries.size());
        }
    }

    @Test
    @DisplayName("Callback URL with disallowed origin is rejected with 400 Bad Request")
    void callbackOriginDenied() throws Exception {
        AgentProcessor.Runner runner = (p, c, t) -> Json.object("success", true);

        try (Worker worker = ReviewWorkerMain.create(createWorkerConfig(), runner)) {
            worker.start("127.0.0.1", 0);

            // Origin port differs from allowed callbackPort
            ObjectNode request = createRunRequest("bad-origin-run", callbackPort + 1);
            HttpResponse<String> response = submit(worker, "bad-origin-run", "test-token", request);

            assertEquals(400, response.statusCode());
            assertEquals(0, capturedDeliveries.size());
        }
    }

    @Test
    @DisplayName("Duplicate submission with same runId computes once and preserves accepted payload")
    void duplicateSubmissionExecutesOnce() throws Exception {
        AtomicInteger computeCount = new AtomicInteger(0);
        AgentProcessor.Runner runner = (prompt, context, timeout) -> {
            computeCount.incrementAndGet();
            return Json.object(
                    "success", true,
                    "data", Json.object(
                            "output", "{\"score\":100,\"findings\":[]}",
                            "metadata", Json.object("provider", "mock")
                    )
            );
        };

        try (Worker worker = ReviewWorkerMain.create(createWorkerConfig(), runner)) {
            worker.start("127.0.0.1", 0);

            ObjectNode request = createRunRequest("dup-run", callbackPort);
            HttpResponse<String> firstResp = submit(worker, "dup-run", "test-token", request);
            assertEquals(202, firstResp.statusCode());

            HttpResponse<String> dupResp = submit(worker, "dup-run", "test-token", request);
            assertEquals(202, dupResp.statusCode());
            assertEquals(firstResp.body(), dupResp.body(), "Duplicate submission returns identical accepted payload");

            await(() -> capturedDeliveries.size() == 1, "Only one callback delivery", 5);
            Thread.sleep(100);
            assertEquals(1, computeCount.get(), "Computation must execute exactly once for duplicate submission");
            assertEquals(1, capturedDeliveries.size());
            assertNoCallbackErrors();
        }
    }

    @Test
    @DisplayName("Callback retry upon 503 delivers identical raw bytes and delivery ID")
    void callbackRetryPreservesSameRawBytesAndDeliveryId() throws Exception {
        retry503Threshold = 1; // 1st attempt returns 503, 2nd attempt returns 204

        AgentProcessor.Runner runner = (prompt, context, timeout) -> Json.object(
                "success", true,
                "data", Json.object(
                        "output", "{\"score\":85,\"findings\":[\"ok\"]}",
                        "metadata", Json.object("provider", "mock")
                )
        );

        try (Worker worker = ReviewWorkerMain.create(createWorkerConfig(), runner)) {
            worker.start("127.0.0.1", 0);

            ObjectNode request = createRunRequest("retry-run", callbackPort);
            HttpResponse<String> response = submit(worker, "retry-run", "test-token", request);
            assertEquals(202, response.statusCode());

            await(() -> capturedDeliveries.size() == 2, "Callback should retry and deliver second time", 5);
            assertNoCallbackErrors();

            CapturedDelivery first = capturedDeliveries.get(0);
            CapturedDelivery second = capturedDeliveries.get(1);

            assertEquals(first.deliveryId(), second.deliveryId(), "Stable retry delivery ID");
            assertArrayEquals(first.raw(), second.raw(), "Serialized-once retry bytes must match exactly");
        }
    }

    @Test
    @DisplayName("Worker close followed by fresh Worker demonstrates recomputation, new runId, and no durable state claim")
    void freshWorkerRecomputesAndAssignsNewRunId() throws Exception {
        AtomicInteger computeCount = new AtomicInteger(0);
        AgentProcessor.Runner runner = (prompt, context, timeout) -> {
            computeCount.incrementAndGet();
            return Json.object(
                    "success", true,
                    "data", Json.object(
                            "output", "{\"score\":100,\"findings\":[]}",
                            "metadata", Json.object("provider", "mock")
                    )
            );
        };

        String runId1;
        try (Worker firstWorker = ReviewWorkerMain.create(createWorkerConfig(), runner)) {
            firstWorker.start("127.0.0.1", 0);
            ObjectNode request = createRunRequest("restart-run", callbackPort);
            HttpResponse<String> resp1 = submit(firstWorker, "restart-run", "test-token", request);
            assertEquals(202, resp1.statusCode());
            runId1 = Json.parse(resp1.body()).path("runId").asText();
            await(() -> capturedDeliveries.size() == 1, "First delivery", 5);
        }

        // Fresh worker has no durable store from the first worker
        try (Worker secondWorker = ReviewWorkerMain.create(createWorkerConfig(), runner)) {
            secondWorker.start("127.0.0.1", 0);
            ObjectNode request = createRunRequest("restart-run", callbackPort);
            HttpResponse<String> resp2 = submit(secondWorker, "restart-run", "test-token", request);
            assertEquals(202, resp2.statusCode());
            String runId2 = Json.parse(resp2.body()).path("runId").asText();

            assertNotEquals(runId1, runId2, "Fresh worker generates a new ephemeral runId");
            await(() -> capturedDeliveries.size() == 2, "Second delivery after fresh worker start", 5);
            assertEquals(2, computeCount.get(), "Work is recomputed after restart (no durable storage claim)");
            assertNoCallbackErrors();
        }
    }

    @Test
    @DisplayName("Injected runner timeout maps to retryable failure callback")
    void injectedTimeoutRunnerMapsToRetryableFailureCallback() throws Exception {
        AgentProcessor.Runner timeoutRunner = (prompt, context, timeout) -> {
            throw new HttpTimeoutException("Runner response timeout");
        };

        try (Worker worker = ReviewWorkerMain.create(createWorkerConfig(), timeoutRunner)) {
            worker.start("127.0.0.1", 0);

            ObjectNode request = createRunRequest("timeout-callback-run", callbackPort);
            HttpResponse<String> response = submit(worker, "timeout-callback-run", "test-token", request);
            assertEquals(202, response.statusCode());

            await(() -> !capturedDeliveries.isEmpty(), "Timeout callback delivered", 5);
            assertNoCallbackErrors();

            JsonNode result = capturedDeliveries.get(0).body;
            assertEquals("failed", result.path("status").asText(), "Worker wire status for agent failure is failed");
            assertEquals("AGENT_TIMED_OUT", result.path("error").path("code").asText());
            assertTrue(result.path("error").path("retryable").asBoolean(), "Timeout error must be retryable");
            assertFalse(result.has("output"), "Failed run must not contain output");
        }
    }

    @Test
    @DisplayName("Injected malformed runner output maps to nonretryable failure callback without fabricated score")
    void injectedMalformedRunnerMapsToNonretryableFailureCallback() throws Exception {
        AgentProcessor.Runner malformedRunner = (prompt, context, timeout) -> Json.object(
                "success", true,
                "data", Json.object("output", "This is plain text with no score or findings")
        );

        try (Worker worker = ReviewWorkerMain.create(createWorkerConfig(), malformedRunner)) {
            worker.start("127.0.0.1", 0);

            ObjectNode request = createRunRequest("malformed-callback-run", callbackPort);
            HttpResponse<String> response = submit(worker, "malformed-callback-run", "test-token", request);
            assertEquals(202, response.statusCode());

            await(() -> !capturedDeliveries.isEmpty(), "Malformed callback delivered", 5);
            assertNoCallbackErrors();

            JsonNode result = capturedDeliveries.get(0).body;
            assertEquals("failed", result.path("status").asText());
            assertFalse(result.path("error").path("retryable").asBoolean(), "Malformed output must be nonretryable");
            assertFalse(result.has("output"), "Must not invent output or fabricate score 80 or 90");
        }
    }

    @Test
    @DisplayName("Injected malformed runner output with sentinel secret never echoes secrets or Jackson excerpts in callback")
    void injectedMalformedRunnerCallbackNeverEchoesRawSecretsOrJacksonExcerpts() throws Exception {
        AgentProcessor.Runner malformedRunner = (prompt, context, timeout) -> Json.object(
                "success", true,
                "data", Json.object("output", "{\"score\": 90, \"secret\": \"SENTINEL_WIRE_SECRET_TOKEN_99999\", \"findings\": [unclosed")
        );

        try (Worker worker = ReviewWorkerMain.create(createWorkerConfig(), malformedRunner)) {
            worker.start("127.0.0.1", 0);

            ObjectNode request = createRunRequest("secret-callback-run", callbackPort);
            HttpResponse<String> response = submit(worker, "secret-callback-run", "test-token", request);
            assertEquals(202, response.statusCode());

            await(() -> !capturedDeliveries.isEmpty(), "Malformed callback delivered", 5);
            assertNoCallbackErrors();

            JsonNode result = capturedDeliveries.get(0).body;
            assertEquals("failed", result.path("status").asText());
            assertEquals("AGENT_EXECUTION_FAILED", result.path("error").path("code").asText());
            assertFalse(result.path("error").path("retryable").asBoolean(), "Malformed output must be nonretryable");
            assertFalse(result.has("output"), "Must not invent output");

            String errorMessage = result.path("error").path("message").asText();
            assertEquals("Agent Runner raw output is not strict JSON", errorMessage,
                    "Error message in public callback must be sanitized");
            assertFalse(errorMessage.contains("SENTINEL_WIRE_SECRET_TOKEN_99999"),
                    "Callback error must never leak raw report text or secrets");
            assertFalse(errorMessage.contains("unclosed"),
                    "Callback error must never leak Jackson excerpt text");
            assertFalse(errorMessage.contains("Source:"),
                    "Callback error must not expose Jackson parser source details");
        }
    }

    // -------------------------------------------------------------------------
    // Bounded HTTP Runner Factory Tests (AgentProcessor.httpRunner)
    // -------------------------------------------------------------------------

    @Test
    @DisplayName("Bounded httpRunner executes normal roundtrip with prompt and context")
    void httpRunnerNormalRoundtrip() throws Exception {
        HttpServer runnerServer = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        runnerServer.createContext("/api/run", exchange -> {
            try {
                byte[] body = exchange.getRequestBody().readAllBytes();
                JsonNode parsed = Json.parse(new String(body, StandardCharsets.UTF_8));
                assertTrue(parsed.has("promptTemplate"));
                assertTrue(parsed.has("context"));

                byte[] resp = Json.stringify(Json.object(
                        "success", true,
                        "data", Json.object(
                                "output", "{\"score\":92,\"findings\":[\"All clear.\"]}",
                                "metadata", Json.object("provider", "real-http")
                        )
                )).getBytes(StandardCharsets.UTF_8);

                exchange.getResponseHeaders().set("Content-Type", "application/json");
                exchange.sendResponseHeaders(200, resp.length);
                exchange.getResponseBody().write(resp);
            } finally {
                exchange.close();
            }
        });
        runnerServer.start();
        int runnerPort = runnerServer.getAddress().getPort();

        try {
            AgentProcessor.Runner runner = AgentProcessor.httpRunner("http://127.0.0.1:" + runnerPort, 1_048_576);
            JsonNode result = runner.run("Template: {{code}}", Json.object("code", "const a = 1;"), 5000);

            assertTrue(result.path("success").asBoolean());
            assertEquals("real-http", result.path("data").path("metadata").path("provider").asText());
        } finally {
            runnerServer.stop(0);
        }
    }

    @Test
    @DisplayName("Bounded httpRunner rejects 302 redirect and never reaches redirect target")
    void httpRunnerRejectsRedirectAndNeverReachesTarget() throws Exception {
        AtomicBoolean targetReached = new AtomicBoolean(false);

        HttpServer targetServer = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        targetServer.createContext("/redirect-target", exchange -> {
            targetReached.set(true);
            exchange.sendResponseHeaders(200, -1);
            exchange.close();
        });
        targetServer.start();
        int targetPort = targetServer.getAddress().getPort();

        HttpServer runnerServer = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        runnerServer.createContext("/api/run", exchange -> {
            exchange.getResponseHeaders().set("Location", "http://127.0.0.1:" + targetPort + "/redirect-target");
            exchange.sendResponseHeaders(302, -1);
            exchange.close();
        });
        runnerServer.start();
        int runnerPort = runnerServer.getAddress().getPort();

        try {
            AgentProcessor.Runner runner = AgentProcessor.httpRunner("http://127.0.0.1:" + runnerPort, 1_048_576);
            assertThrows(Exception.class, () -> runner.run("prompt", Json.object(), 5000));
            assertFalse(targetReached.get(), "Redirect target must never be contacted");
        } finally {
            runnerServer.stop(0);
            targetServer.stop(0);
        }
    }

    @Test
    @DisplayName("Bounded httpRunner rejects chunked stream exceeding 1 MiB maxResponseBytes")
    void httpRunnerRejectsChunkedStreamExceedingMaxResponseBytes() throws Exception {
        HttpServer runnerServer = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        runnerServer.createContext("/api/run", exchange -> {
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            // 0 indicates chunked transfer encoding (no Content-Length declared)
            exchange.sendResponseHeaders(200, 0);
            OutputStream out = exchange.getResponseBody();
            byte[] chunk = new byte[8192];
            Arrays.fill(chunk, (byte) ' ');
            // Stream ~1.2 MiB (150 chunks of 8KB = 1,228,800 bytes)
            try {
                for (int i = 0; i < 150; i++) {
                    out.write(chunk);
                    out.flush();
                }
            } catch (IOException ignored) {
                // Client may abort connection once byte limit is exceeded
            } finally {
                exchange.close();
            }
        });
        runnerServer.start();
        int runnerPort = runnerServer.getAddress().getPort();

        try {
            AgentProcessor.Runner runner = AgentProcessor.httpRunner("http://127.0.0.1:" + runnerPort, 1_048_576);
            assertThrows(Exception.class, () -> runner.run("prompt", Json.object(), 5000),
                    "Oversized chunked body exceeding maxResponseBytes must be rejected");
        } finally {
            runnerServer.stop(0);
        }
    }

    @Test
    @DisplayName("Bounded httpRunner throws HttpTimeoutException within bounded elapsed time on stalled body")
    void httpRunnerStalledBodyThrowsHttpTimeoutExceptionWithinBoundedElapsed() throws Exception {
        HttpServer runnerServer = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        runnerServer.createContext("/api/run", exchange -> {
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            try {
                // Send response headers immediately, then stall without sending body
                exchange.sendResponseHeaders(200, 0);
                Thread.sleep(10_000);
            } catch (InterruptedException ignored) {
            } finally {
                exchange.close();
            }
        });
        runnerServer.start();
        int runnerPort = runnerServer.getAddress().getPort();

        try {
            AgentProcessor.Runner runner = AgentProcessor.httpRunner("http://127.0.0.1:" + runnerPort, 1_048_576);
            long start = System.currentTimeMillis();

            // Timeout set to 300ms
            assertThrows(HttpTimeoutException.class, () -> runner.run("prompt", Json.object(), 300),
                    "Expected HttpTimeoutException specifically, not generic Exception");

            long elapsed = System.currentTimeMillis() - start;
            assertTrue(elapsed < 3000, "Must abort within bounded elapsed time on stalled body, took: " + elapsed + "ms");
        } finally {
            runnerServer.stop(0);
        }
    }
}
