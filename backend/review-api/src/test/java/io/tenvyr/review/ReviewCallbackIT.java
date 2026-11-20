package io.tenvyr.review;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sun.net.httpserver.HttpServer;
import io.tenvyr.control.ControlPlaneRuntime;
import io.tenvyr.control.engine.ExecutionService;
import io.tenvyr.control.engine.HttpAgentAdapter;
import io.tenvyr.control.engine.PipelineService;
import io.tenvyr.platform.Db;
import io.tenvyr.platform.Json;
import io.tenvyr.platform.Protocol;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.http.*;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import javax.sql.DataSource;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.*;

import static org.junit.jupiter.api.Assertions.*;

/**
 * T01 Integration Test: Review Callback Byte and Authentication Boundary.
 * Requires real disposable PostgreSQL (no H2/mocks).
 * Validates HMAC raw-byte authentication, CSRF exemption, 1 MiB bound, and route denial.
 */
@SpringBootTest(classes = ReviewApplication.class, webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = {
                "HTTP_AGENT_ALLOW_INSECURE=true",
                "HTTP_AGENT_CALLBACK_BASE_URL=http://127.0.0.1:8080",
                "TEST_SECRET=" + ReviewCallbackIT.TEST_SECRET,
                "TEST_TOKEN=test-token"
        }
)
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
public class ReviewCallbackIT {

    @LocalServerPort
    private int port;

    @Autowired
    private TestRestTemplate restTemplate;

    @Autowired
    private ControlPlaneRuntime engineRuntime;

    @Autowired
    private DataSource dataSource;

    public static final String CALLBACK_PATH = "/internal/agent-callbacks/http/code-reviewer";
    public static final String TEST_AGENT = "code-reviewer";
    public static final String TEST_SECRET = "code-reviewer-test-secret-key-64bytes-long-hmac-sha256-signature";
    public static final String TEST_KEY_ID = "code-reviewer-key-1";

    private static HttpServer mockWorkerServer;
    private static int mockWorkerPort;
    private static final java.util.concurrent.BlockingQueue<JsonNode> peerDispatches = new java.util.concurrent.LinkedBlockingQueue<>();

    @DynamicPropertySource
    static void configureProperties(DynamicPropertyRegistry registry) {
        String raw = System.getenv("TENVYR_REVIEW_TEST_DATABASE_URL");
        if (raw == null || raw.isBlank()) {
            throw new IllegalStateException("T01 IT requires real PostgreSQL: TENVYR_REVIEW_TEST_DATABASE_URL must be set");
        }

        validateDisposableDatabaseUrl(raw);

        String user = System.getenv().getOrDefault("POSTGRES_USER", "postgres");
        String password = System.getenv().getOrDefault("POSTGRES_PASSWORD", "postgres");
        String jdbcUrl = raw;

        registry.add("spring.datasource.url", () -> jdbcUrl);
        registry.add("spring.datasource.username", () -> user);
        registry.add("spring.datasource.password", () -> password);

        // Start deterministic local peer for HTTP worker dispatch before Spring context starts
        try {
            if (mockWorkerServer == null) {
                mockWorkerServer = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
                mockWorkerPort = mockWorkerServer.getAddress().getPort();
                mockWorkerServer.createContext("/v1/runs", exchange -> {
                    byte[] body = exchange.getRequestBody().readAllBytes();
                    try {
                        JsonNode req = Json.parse(new String(body, StandardCharsets.UTF_8));
                        JsonNode invocation = req.path("invocation");
                        String invId = invocation.path("invocationId").asText();
                        ObjectNode resp = Protocol.httpAccepted(Json.object(
                                "schemaVersion", "1",
                                "invocationId", invId,
                                "runId", UUID.randomUUID().toString(),
                                "status", "accepted",
                                "acceptedAt", Protocol.jsInstant(Instant.now())
                        ));
                        byte[] respBytes = Json.stringify(resp).getBytes(StandardCharsets.UTF_8);
                        exchange.getResponseHeaders().set("Content-Type", "application/json");
                        exchange.sendResponseHeaders(202, respBytes.length);
                        try (OutputStream os = exchange.getResponseBody()) {
                            os.write(respBytes);
                        }
                        peerDispatches.offer(invocation);
                    } catch (Exception e) {
                        exchange.sendResponseHeaders(500, -1);
                    }
                });
                mockWorkerServer.start();
            }
        } catch (Exception e) {
            throw new RuntimeException("Failed to start mock worker peer", e);
        }

        String transportConfig = Json.stringify(Json.object(
                TEST_AGENT, Json.object(
                        "kind", "http",
                        "submitUrl", "http://127.0.0.1:" + mockWorkerPort + "/v1/runs",
                        "outboundAuthentication", Json.object("type", "bearer", "tokenEnv", "TEST_TOKEN"),
                        "callbackAuthentication", Json.object("keyId", TEST_KEY_ID, "secretEnv", "TEST_SECRET"),
                        "requestTimeoutMs", 2000,
                        "maxResponseBytes", 65536
                )
        ));
        registry.add("AGENT_TRANSPORT_CONFIG", () -> transportConfig);
    }

    @BeforeAll
    static void requireRealDisposableDatabase() {
        String raw = System.getenv("TENVYR_REVIEW_TEST_DATABASE_URL");
        validateDisposableDatabaseUrl(raw);
    }

    @AfterAll
    static void tearDownPeer() {
        if (mockWorkerServer != null) {
            mockWorkerServer.stop(0);
            mockWorkerServer = null;
        }
    }

    private static final Set<String> FORBIDDEN_ROUTING_KEYS = Set.of(
            "pgdbname",
            "pghost",
            "pgport",
            "service",
            "dbname",
            "databasename",
            "database",
            "host",
            "port"
    );

    static void validateDisposableDatabaseUrl(String raw) {
        if (raw == null || raw.isBlank()) {
            throw new IllegalStateException("Test database URL is required (TENVYR_REVIEW_TEST_DATABASE_URL)");
        }
        if (!raw.startsWith("jdbc:postgresql://")) {
            throw new IllegalArgumentException("Test database URL must be a valid PostgreSQL JDBC URL (jdbc:postgresql://host/db)");
        }
        URI parsed;
        try {
            parsed = URI.create(raw.substring(5));
        } catch (Exception e) {
            throw new IllegalArgumentException("Malformed test database URL");
        }
        if (parsed.getRawFragment() != null) {
            throw new IllegalArgumentException("Malformed test database URL");
        }
        if (parsed.getScheme() == null || !parsed.getScheme().equalsIgnoreCase("postgresql")) {
            throw new IllegalArgumentException("Test database URL must be a valid PostgreSQL JDBC URL");
        }
        if (parsed.getHost() == null || parsed.getHost().isBlank()) {
            throw new IllegalArgumentException("Test database URL must specify a host");
        }
        String path = parsed.getPath();
        if (path == null || path.length() <= 1) {
            throw new IllegalArgumentException("Test database URL must specify a database name");
        }
        String rawDbName = path.substring(1);
        String dbName;
        try {
            dbName = java.net.URLDecoder.decode(rawDbName, StandardCharsets.UTF_8);
        } catch (Exception e) {
            throw new IllegalArgumentException("Malformed test database URL: invalid percent decoding");
        }
        if (!dbName.toLowerCase(Locale.ROOT).matches(".*(?:test|scratch|disposable).*")) {
            throw new IllegalArgumentException("Refusing non-disposable test database. Database name must contain test, scratch, or disposable");
        }

        int qIndex = raw.indexOf('?');
        if (qIndex != -1) {
            String queryPart = raw.substring(qIndex + 1);
            String[] pairs = queryPart.split("&");
            for (String pair : pairs) {
                if (pair.isEmpty()) {
                    continue;
                }
                int eq = pair.indexOf('=');
                String rawKey = eq >= 0 ? pair.substring(0, eq) : pair;
                String decodedKey;
                try {
                    decodedKey = java.net.URLDecoder.decode(rawKey, StandardCharsets.UTF_8).trim().toLowerCase(Locale.ROOT);
                } catch (Exception e) {
                    throw new IllegalArgumentException("Malformed test database URL: invalid query parameter encoding");
                }
                if (FORBIDDEN_ROUTING_KEYS.contains(decodedKey)) {
                    throw new IllegalArgumentException("Test database URL must not override database routing in query parameters");
                }
            }
        }
    }

    private String url(String path) {
        return "http://127.0.0.1:" + port + path;
    }

    private record MaterializedInvocation(String executionId, String stepExecutionId, String invocationId) {}

    private MaterializedInvocation startExecutionAndAwaitDispatch() throws Exception {
        PipelineService pipelines = engineRuntime.pipelines();
        String pipelineName = "callback-test-pipeline-" + UUID.randomUUID();
        ObjectNode pipeline = pipelines.create(Json.object(
                "name", pipelineName,
                "version", "1.0",
                "steps", Json.array(Json.object(
                        "id", "review",
                        "agent", TEST_AGENT,
                        "input", Json.object("code", "class Sample {}", "language", "java")
                ))
        ));
        String pipelineId = pipeline.path("id").asText();

        // Start execution through engine: reconcile claims and dispatches to HTTP adapter
        ObjectNode execution = engineRuntime.engine().startExecution(pipelineId, Json.object("source", "test"));
        String executionId = execution.path("id").asText();

        // Bounded wait for mockWorkerServer to receive dispatch and return 202 httpAccepted
        JsonNode invocation = peerDispatches.poll(10, java.util.concurrent.TimeUnit.SECONDS);
        assertNotNull(invocation, "Mock peer worker must receive and accept HTTP dispatch invocation within timeout");
        assertEquals(executionId, invocation.path("executionId").asText(), "Dispatched executionId must match started execution");

        String invocationId = invocation.path("invocationId").asText();
        String stepExecutionId = invocation.path("stepExecutionId").asText();

        // Verify actual step execution exists in durable storage
        ObjectNode stepRow = engineRuntime.executions().getStepExecution(executionId, "review");
        assertNotNull(stepRow, "Step execution row must exist in database");

        return new MaterializedInvocation(executionId, stepExecutionId, invocationId);
    }

    @Test
    @DisplayName("Unsigned callback request must be rejected with 401 Unauthorized")
    void postUnsignedCallback_returns401() {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        HttpEntity<String> entity = new HttpEntity<>("{\"status\":\"succeeded\"}", headers);

        ResponseEntity<String> response = restTemplate.postForEntity(url(CALLBACK_PATH), entity, String.class);
        assertEquals(HttpStatus.UNAUTHORIZED, response.getStatusCode(),
                "Unsigned callback without HMAC headers must return 401");
    }

    @Test
    @DisplayName("Callback with invalid signature must be rejected with 401 Unauthorized")
    void postBadSignatureCallback_returns401() {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.set(HttpAgentAdapter.KEY_ID, TEST_KEY_ID);
        headers.set(HttpAgentAdapter.TIMESTAMP, String.valueOf(System.currentTimeMillis() / 1000));
        headers.set(HttpAgentAdapter.DELIVERY_ID, UUID.randomUUID().toString());
        headers.set(HttpAgentAdapter.SIGNATURE, "v1=" + "0".repeat(64));

        HttpEntity<String> entity = new HttpEntity<>("{\"status\":\"succeeded\"}", headers);
        ResponseEntity<String> response = restTemplate.postForEntity(url(CALLBACK_PATH), entity, String.class);
        assertEquals(HttpStatus.UNAUTHORIZED, response.getStatusCode(),
                "Callback with invalid signature must return 401");
    }

    @Test
    @DisplayName("Callback with expired timestamp exceeding max skew must return 401")
    void postExpiredTimestampCallback_returns401() {
        String rawBody = "{\"status\":\"succeeded\"}";
        String expiredTimestamp = String.valueOf((System.currentTimeMillis() / 1000) - 600);
        String deliveryId = UUID.randomUUID().toString();
        String sig = HttpAgentAdapter.signature(TEST_SECRET, expiredTimestamp, deliveryId, rawBody.getBytes(StandardCharsets.UTF_8));

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.set(HttpAgentAdapter.KEY_ID, TEST_KEY_ID);
        headers.set(HttpAgentAdapter.TIMESTAMP, expiredTimestamp);
        headers.set(HttpAgentAdapter.DELIVERY_ID, deliveryId);
        headers.set(HttpAgentAdapter.SIGNATURE, sig);

        HttpEntity<String> entity = new HttpEntity<>(rawBody, headers);
        ResponseEntity<String> response = restTemplate.postForEntity(url(CALLBACK_PATH), entity, String.class);
        assertEquals(HttpStatus.UNAUTHORIZED, response.getStatusCode(),
                "Callback with timestamp beyond max skew must return 401");
    }

    @Test
    @DisplayName("Signed original bytes callback with real materialized invocation succeeds with 204 No Content without session or CSRF")
    void postSignedOriginalBytes_returns204() throws Exception {
        MaterializedInvocation inv = startExecutionAndAwaitDispatch();

        ObjectNode result = Json.object(
                "schemaVersion", "1",
                "invocationId", inv.invocationId(),
                "executionId", inv.executionId(),
                "stepExecutionId", inv.stepExecutionId(),
                "status", "succeeded",
                "completedAt", Protocol.jsInstant(Instant.now()),
                "output", Json.object("score", 95, "findings", Json.array("clean implementation"))
        );
        byte[] rawBytes = Json.stringify(result).getBytes(StandardCharsets.UTF_8);

        String timestamp = String.valueOf(System.currentTimeMillis() / 1000);
        String deliveryId = UUID.randomUUID().toString();
        String sig = HttpAgentAdapter.signature(TEST_SECRET, timestamp, deliveryId, rawBytes);

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.set(HttpAgentAdapter.KEY_ID, TEST_KEY_ID);
        headers.set(HttpAgentAdapter.TIMESTAMP, timestamp);
        headers.set(HttpAgentAdapter.DELIVERY_ID, deliveryId);
        headers.set(HttpAgentAdapter.SIGNATURE, sig);

        HttpEntity<byte[]> entity = new HttpEntity<>(rawBytes, headers);
        ResponseEntity<Void> response = restTemplate.postForEntity(url(CALLBACK_PATH), entity, Void.class);
        assertEquals(HttpStatus.NO_CONTENT, response.getStatusCode(),
                "Valid HMAC signed callback on real materialized invocation must return 204");

        // Prove durable inbox and terminal state
        Db db = Db.fromDataSource(dataSource);
        ObjectNode inboxRow = db.one("SELECT * FROM result_inbox WHERE \"invocationId\"=?", inv.invocationId());
        assertNotNull(inboxRow, "Result inbox must record the accepted callback");
        assertEquals("APPLIED", inboxRow.path("status").asText(), "Result inbox status must be APPLIED");

        // Bounded wait for durable execution to reach terminal COMPLETED status
        long deadline = System.currentTimeMillis() + 10_000;
        ObjectNode executionRow = null;
        while (System.currentTimeMillis() < deadline) {
            executionRow = engineRuntime.executions().getExecution(inv.executionId());
            if (executionRow != null && "COMPLETED".equals(executionRow.path("status").asText())) {
                break;
            }
            Thread.sleep(50);
        }
        assertNotNull(executionRow, "Execution must be readable");
        assertEquals("COMPLETED", executionRow.path("status").asText(), "Execution must reach terminal COMPLETED status");
    }

    @Test
    @DisplayName("Tampered body or altered bytes with valid original signature must be rejected with 401 Unauthorized")
    void postTamperedBytesCallback_returns401() throws Exception {
        MaterializedInvocation inv = startExecutionAndAwaitDispatch();

        ObjectNode result = Json.object(
                "schemaVersion", "1",
                "invocationId", inv.invocationId(),
                "executionId", inv.executionId(),
                "stepExecutionId", inv.stepExecutionId(),
                "status", "succeeded",
                "completedAt", Protocol.jsInstant(Instant.now()),
                "output", Json.object("score", 95, "findings", Json.array("clean implementation"))
        );
        byte[] rawBytes = Json.stringify(result).getBytes(StandardCharsets.UTF_8);

        String timestamp = String.valueOf(System.currentTimeMillis() / 1000);
        String deliveryId = UUID.randomUUID().toString();
        String sig = HttpAgentAdapter.signature(TEST_SECRET, timestamp, deliveryId, rawBytes);

        // Tamper with bytes (even single space or altered field)
        byte[] tamperedBytes = (new String(rawBytes, StandardCharsets.UTF_8) + " ").getBytes(StandardCharsets.UTF_8);

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.set(HttpAgentAdapter.KEY_ID, TEST_KEY_ID);
        headers.set(HttpAgentAdapter.TIMESTAMP, timestamp);
        headers.set(HttpAgentAdapter.DELIVERY_ID, deliveryId);
        headers.set(HttpAgentAdapter.SIGNATURE, sig);

        HttpEntity<byte[]> entity = new HttpEntity<>(tamperedBytes, headers);
        ResponseEntity<String> response = restTemplate.postForEntity(url(CALLBACK_PATH), entity, String.class);
        assertEquals(HttpStatus.UNAUTHORIZED, response.getStatusCode(),
                "Tampered raw bytes with original signature must return 401");
    }

    @Test
    @DisplayName("Callback streaming body exceeding 1 MiB bound without Content-Length (chunked) must return exact 413 Payload Too Large")
    void callbackStreamingChunkedBodyBoundedTo1MiB_returnsExact413() throws Exception {
        int oversize = (1024 * 1024) + 1024; // 1 MiB + 1 KiB
        byte[] bigBody = new byte[oversize];
        Arrays.fill(bigBody, (byte) ' ');

        String timestamp = String.valueOf(System.currentTimeMillis() / 1000);
        String deliveryId = UUID.randomUUID().toString();
        String sig = HttpAgentAdapter.signature(TEST_SECRET, timestamp, deliveryId, bigBody);

        URL target = new URI(url(CALLBACK_PATH)).toURL();
        HttpURLConnection conn = (HttpURLConnection) target.openConnection();
        try {
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setChunkedStreamingMode(8192); // Genuine chunked streaming without Content-Length
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setRequestProperty(HttpAgentAdapter.KEY_ID, TEST_KEY_ID);
            conn.setRequestProperty(HttpAgentAdapter.TIMESTAMP, timestamp);
            conn.setRequestProperty(HttpAgentAdapter.DELIVERY_ID, deliveryId);
            conn.setRequestProperty(HttpAgentAdapter.SIGNATURE, sig);

            try (OutputStream os = conn.getOutputStream()) {
                int written = 0;
                while (written < oversize) {
                    int len = Math.min(8192, oversize - written);
                    os.write(bigBody, written, len);
                    written += len;
                }
                os.flush();
            }

            int status = conn.getResponseCode();
            assertEquals(HttpStatus.PAYLOAD_TOO_LARGE.value(), status,
                    "Oversize streaming body without Content-Length must be rejected with exact 413 Payload Too Large");
        } finally {
            conn.disconnect();
        }
    }

    @Test
    @DisplayName("Callback-adjacent and other unsafe POST routes require CSRF protection and return 403 Forbidden")
    void callbackAdjacentUnsafeRouteWithoutCsrf_returns403() {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        HttpEntity<String> entity = new HttpEntity<>("{}", headers);

        // Subpath under callback route
        ResponseEntity<String> subpathResponse = restTemplate.postForEntity(
                url(CALLBACK_PATH + "/subpath"), entity, String.class);
        assertEquals(HttpStatus.FORBIDDEN, subpathResponse.getStatusCode(),
                "Callback-adjacent subpath route without CSRF token must return 403 Forbidden");

        // Sibling agent callback route that is not configured for HMAC exemption
        ResponseEntity<String> otherAgentResponse = restTemplate.postForEntity(
                url("/internal/agent-callbacks/http/other-agent"), entity, String.class);
        assertEquals(HttpStatus.FORBIDDEN, otherAgentResponse.getStatusCode(),
                "Non-exempt callback-adjacent route without CSRF token must return 403 Forbidden");

        // New review business route without CSRF
        ResponseEntity<String> reviewRouteResponse = restTemplate.postForEntity(
                url("/api/v1/reviews"), entity, String.class);
        assertEquals(HttpStatus.FORBIDDEN, reviewRouteResponse.getStatusCode(),
                "Business POST route without CSRF token must return 403 Forbidden");
    }

    @Test
    @DisplayName("Actuator liveness and readiness health probes return UP and do not expose secrets or URLs")
    void healthProbesDoNotExposeSecrets() {
        ResponseEntity<String> liveness = restTemplate.getForEntity(url("/actuator/health/liveness"), String.class);
        assertEquals(HttpStatus.OK, liveness.getStatusCode(), "Liveness probe must return 200");
        assertNotNull(liveness.getBody(), "Liveness body must not be null");
        assertTrue(liveness.getBody().contains("UP"), "Liveness status must be UP");
        assertFalse(liveness.getBody().toLowerCase(Locale.ROOT).contains("password"), "Health probe must not expose password");
        assertFalse(liveness.getBody().contains("postgres://"), "Health probe must not expose postgres connection URL");
        assertFalse(liveness.getBody().contains("jdbc:"), "Health probe must not expose jdbc connection URL");

        ResponseEntity<String> readiness = restTemplate.getForEntity(url("/actuator/health/readiness"), String.class);
        assertEquals(HttpStatus.OK, readiness.getStatusCode(), "Readiness probe must return 200");
        assertNotNull(readiness.getBody(), "Readiness body must not be null");
        assertFalse(readiness.getBody().toLowerCase(Locale.ROOT).contains("password"), "Health probe must not expose password");
        assertFalse(readiness.getBody().contains("postgres://"), "Health probe must not expose postgres connection URL");
        assertFalse(readiness.getBody().contains("jdbc:"), "Health probe must not expose jdbc connection URL");
    }

    @Test
    @DisplayName("Denies access to legacy control plane routes and unexposed business routes")
    void deniesUnexposedRoutes() {
        ResponseEntity<String> root = restTemplate.getForEntity(url("/"), String.class);
        assertTrue(root.getStatusCode().is4xxClientError(), "Root endpoint must be denied (401/403/404)");

        ResponseEntity<String> pipelines = restTemplate.getForEntity(url("/pipelines"), String.class);
        assertTrue(pipelines.getStatusCode().is4xxClientError(), "Legacy /pipelines must not be exposed");

        ResponseEntity<String> executions = restTemplate.getForEntity(url("/executions"), String.class);
        assertTrue(executions.getStatusCode().is4xxClientError(), "Legacy /executions must not be exposed");
    }
}
