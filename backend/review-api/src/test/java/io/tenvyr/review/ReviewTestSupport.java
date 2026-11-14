package io.tenvyr.review;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sun.net.httpserver.HttpServer;
import io.tenvyr.control.ControlPlaneRuntime;
import io.tenvyr.control.engine.HttpAgentAdapter;
import io.tenvyr.platform.Db;
import io.tenvyr.platform.Json;
import io.tenvyr.platform.Protocol;
import io.tenvyr.review.domain.ReviewTypes.Role;
import org.springframework.security.crypto.factory.PasswordEncoderFactories;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.test.context.DynamicPropertyRegistry;

import javax.sql.DataSource;
import java.io.IOException;
import java.io.OutputStream;
import java.net.CookieManager;
import java.net.CookiePolicy;
import java.net.HttpCookie;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Shared test fixture and utility support for T04 integration tests (ReviewSubmissionIT, ReviewReadsIT).
 * Provides disposable PostgreSQL configuration, controlled ephemeral loopback HTTP peer,
 * standard authentication/CSRF helpers, safe error assertions, and FK-ordered fixture cleanup.
 */
public final class ReviewTestSupport {

    public static final String TEST_AGENT = "code-reviewer";
    public static final String TEST_SECRET = "code-reviewer-test-secret-key-64bytes-long-hmac-sha256-signature";
    public static final String TEST_KEY_ID = "code-reviewer-key-1";
    public static final String TEST_TOKEN = "test-token";
    public static final String CALLBACK_PATH = "/internal/agent-callbacks/http/code-reviewer";

    private static HttpServer mockWorkerServer;
    private static int mockWorkerPort;
    private static int workerRefCount = 0;
    private static final BlockingQueue<JsonNode> dispatches = new LinkedBlockingQueue<>();

    /**
     * Dedicated exception thrown by the test-local fault injection seam.
     */
    public static class ForcedFaultInjectionException extends RuntimeException {
        public ForcedFaultInjectionException(String message) {
            super(message);
        }
    }

    /**
     * Package-private / test-local seam invoked after engine execution materialization
     * and before review request / audit row insertion.
     */
    @FunctionalInterface
    public interface PostMaterializationHook {
        void onMaterialized(Connection connection, UUID executionId) throws Exception;
    }

    public static volatile PostMaterializationHook postMaterializationHook = null;

    private ReviewTestSupport() {}

    public record TestUser(UUID id, String username, String rawPassword, Role role) {}

    public record CsrfToken(String headerName, String parameterName, String token) {}

    public record AuthenticatedSession(HttpClient client, CookieManager cookieManager, CsrfToken csrf, TestUser user) {}

    public static synchronized int startMockWorkerPeer() {
        if (mockWorkerServer == null) {
            try {
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
                        dispatches.offer(invocation);
                    } catch (Exception e) {
                        exchange.sendResponseHeaders(500, -1);
                    }
                });
                mockWorkerServer.start();
            } catch (IOException e) {
                throw new RuntimeException("Failed to start mock worker peer", e);
            }
        }
        workerRefCount++;
        return mockWorkerPort;
    }

    public static synchronized void stopMockWorkerPeer() {
        workerRefCount--;
        if (workerRefCount <= 0 && mockWorkerServer != null) {
            mockWorkerServer.stop(0);
            mockWorkerServer = null;
            mockWorkerPort = 0;
            workerRefCount = 0;
            dispatches.clear();
        }
    }

    public static JsonNode pollDispatch(long timeout, TimeUnit unit) throws InterruptedException {
        return dispatches.poll(timeout, unit);
    }

    public static void configureTestDatabaseProperties(DynamicPropertyRegistry registry, int workerPort) {
        String raw = System.getenv("TENVYR_REVIEW_TEST_DATABASE_URL");
        if (raw == null || raw.isBlank()) {
            throw new IllegalStateException("Integration tests require real PostgreSQL: TENVYR_REVIEW_TEST_DATABASE_URL must be set");
        }

        ReviewCallbackIT.validateDisposableDatabaseUrl(raw);

        String user = System.getenv().getOrDefault("POSTGRES_USER", "postgres");
        String password = System.getenv().getOrDefault("POSTGRES_PASSWORD", "postgres");

        registry.add("spring.datasource.url", () -> raw);
        registry.add("spring.datasource.username", () -> user);
        registry.add("spring.datasource.password", () -> password);

        String transportConfig = Json.stringify(Json.object(
                TEST_AGENT, Json.object(
                        "kind", "http",
                        "submitUrl", "http://127.0.0.1:" + workerPort + "/v1/runs",
                        "outboundAuthentication", Json.object("type", "bearer", "tokenEnv", "TEST_TOKEN"),
                        "callbackAuthentication", Json.object("keyId", TEST_KEY_ID, "secretEnv", "TEST_SECRET"),
                        "requestTimeoutMs", 2000,
                        "maxResponseBytes", 65536
                )
        ));
        registry.add("AGENT_TRANSPORT_CONFIG", () -> transportConfig);
    }

    public static TestUser createTestUser(DataSource dataSource, Set<UUID> trackedUsers, String prefix, Role role) throws SQLException {
        UUID id = UUID.randomUUID();
        String username = (prefix + "_" + UUID.randomUUID().toString().replace("-", "")).substring(0, 24);
        String rawPassword = "password-" + UUID.randomUUID().toString().substring(0, 8) + "!";
        PasswordEncoder encoder = PasswordEncoderFactories.createDelegatingPasswordEncoder();
        String passwordHash = encoder.encode(rawPassword);

        try (Connection conn = dataSource.getConnection();
             PreparedStatement ps = conn.prepareStatement(
                     "INSERT INTO tenvyr_review.users (id, username, password_hash, role, enabled) VALUES (?, ?, ?, ?, true)")) {
            ps.setObject(1, id);
            ps.setString(2, username);
            ps.setString(3, passwordHash);
            ps.setString(4, role.name());
            assertEquals(1, ps.executeUpdate(), "User insert must succeed");
        }

        if (trackedUsers != null) {
            trackedUsers.add(id);
        }
        return new TestUser(id, username, rawPassword, role);
    }

    public static CsrfToken fetchCsrf(HttpClient client, int port) throws Exception {
        HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create("http://127.0.0.1:" + port + "/api/v1/auth/csrf"))
                .GET()
                .build();
        HttpResponse<String> resp = client.send(req, HttpResponse.BodyHandlers.ofString());
        assertEquals(200, resp.statusCode(), "CSRF endpoint must return 200 OK");
        String cacheControl = resp.headers().firstValue("Cache-Control").orElse("");
        assertTrue(cacheControl.contains("no-store"), "CSRF endpoint must specify Cache-Control: no-store");

        JsonNode json = Json.parse(resp.body());
        assertTrue(json.hasNonNull("headerName"), "CSRF token must contain headerName");
        assertTrue(json.hasNonNull("parameterName"), "CSRF token must contain parameterName");
        assertTrue(json.hasNonNull("token"), "CSRF token must contain token");

        return new CsrfToken(
                json.path("headerName").asText(),
                json.path("parameterName").asText(),
                json.path("token").asText()
        );
    }

    public static HttpResponse<String> login(HttpClient client, int port, String username, String password, CsrfToken csrf) throws Exception {
        String body = "username=" + URLEncoder.encode(username, StandardCharsets.UTF_8) +
                "&password=" + URLEncoder.encode(password, StandardCharsets.UTF_8);
        if (csrf != null && csrf.parameterName() != null && !csrf.parameterName().isBlank()) {
            body += "&" + URLEncoder.encode(csrf.parameterName(), StandardCharsets.UTF_8) +
                    "=" + URLEncoder.encode(csrf.token(), StandardCharsets.UTF_8);
        }

        HttpRequest.Builder builder = HttpRequest.newBuilder()
                .uri(URI.create("http://127.0.0.1:" + port + "/login"))
                .header("Content-Type", "application/x-www-form-urlencoded")
                .POST(HttpRequest.BodyPublishers.ofString(body));

        if (csrf != null && csrf.headerName() != null && !csrf.headerName().isBlank()) {
            builder.header(csrf.headerName(), csrf.token());
        }

        return client.send(builder.build(), HttpResponse.BodyHandlers.ofString());
    }

    public static AuthenticatedSession loginUser(int port, TestUser user) throws Exception {
        CookieManager cookieManager = new CookieManager(null, CookiePolicy.ACCEPT_ALL);
        HttpClient client = HttpClient.newBuilder()
                .cookieHandler(cookieManager)
                .followRedirects(HttpClient.Redirect.NEVER)
                .build();

        CsrfToken preLoginCsrf = fetchCsrf(client, port);
        HttpResponse<String> loginResp = login(client, port, user.username(), user.rawPassword(), preLoginCsrf);
        assertEquals(204, loginResp.statusCode(), "Form login must return 204 No Content according to SPEC");

        List<HttpCookie> cookies = cookieManager.getCookieStore().get(URI.create("http://127.0.0.1:" + port));
        boolean hasSessionCookie = cookies.stream().anyMatch(c -> "JSESSIONID".equalsIgnoreCase(c.getName()));
        assertTrue(hasSessionCookie, "Valid login must establish JSESSIONID cookie");

        CsrfToken postLoginCsrf = fetchCsrf(client, port);
        return new AuthenticatedSession(client, cookieManager, postLoginCsrf, user);
    }

    public static void assertSafeErrorJson(HttpResponse<String> resp, int expectedStatus, String expectedCode) {
        assertEquals(expectedStatus, resp.statusCode());
        String contentType = resp.headers().firstValue("Content-Type").orElse("");
        assertTrue(contentType.startsWith("application/json"),
                "Error response must be application/json, got: " + contentType);

        String body = resp.body();
        assertFalse(body.toLowerCase(Locale.ROOT).contains("<html>"), "Response must not contain HTML");
        assertFalse(body.toLowerCase(Locale.ROOT).contains("password"), "Response must not leak password");
        assertFalse(body.toLowerCase(Locale.ROOT).contains("hash"), "Response must not leak hash");
        assertFalse(body.toLowerCase(Locale.ROOT).contains("exception"), "Response must not leak exception class");
        assertFalse(body.toLowerCase(Locale.ROOT).contains("sqlstate"), "Response must not leak sqlstate");

        JsonNode json = Json.parse(body);
        assertTrue(json.isObject(), "Error response must be a JSON object");

        Set<String> keys = new HashSet<>();
        json.fieldNames().forEachRemaining(keys::add);
        assertEquals(Set.of("code", "message", "requestId"), keys,
                "Error JSON must contain exact {code, message, requestId} fields, got: " + keys);

        String code = json.path("code").asText();
        assertFalse(code.isBlank(), "code must not be blank");
        assertTrue(code.length() <= 64, "code length must be bounded");
        if (expectedCode != null) {
            assertEquals(expectedCode, code);
        }

        String message = json.path("message").asText();
        assertFalse(message.isBlank(), "message must not be blank");
        assertTrue(message.length() <= 256, "message length must be bounded");

        String requestId = json.path("requestId").asText();
        assertDoesNotThrow(() -> UUID.fromString(requestId),
                "requestId must be a valid UUID, got: " + requestId);
    }

    public static UUID createDirectReviewRequest(
            Connection conn,
            Set<UUID> trackedRequests,
            UUID ownerId,
            UUID idempotencyKey,
            String title,
            String language,
            String code,
            UUID executionId,
            Instant createdAt) throws SQLException {
        UUID id = UUID.randomUUID();
        String requestHash = Json.hash(Json.object("title", title, "language", language, "code", code));
        try (PreparedStatement ps = conn.prepareStatement(
                "INSERT INTO tenvyr_review.requests (id, owner_id, idempotency_key, request_hash, title, language, code, execution_id, created_at) " +
                        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")) {
            ps.setObject(1, id);
            ps.setObject(2, ownerId);
            ps.setObject(3, idempotencyKey);
            ps.setString(4, requestHash);
            ps.setString(5, title);
            ps.setString(6, language);
            ps.setString(7, code);
            ps.setObject(8, executionId);
            ps.setObject(9, Timestamp.from(createdAt));
            assertEquals(1, ps.executeUpdate());
        }
        if (trackedRequests != null) {
            trackedRequests.add(id);
        }
        return id;
    }

    public static void createDirectAuditEntry(
            Connection conn,
            UUID requestId,
            UUID actorId,
            String action,
            UUID operationKey,
            String payloadHash,
            Instant createdAt) throws SQLException {
        UUID id = UUID.randomUUID();
        try (PreparedStatement ps = conn.prepareStatement(
                "INSERT INTO tenvyr_review.audit (id, request_id, actor_id, action, operation_key, payload_hash, created_at) " +
                        "VALUES (?, ?, ?, ?, ?, ?, ?)")) {
            ps.setObject(1, id);
            ps.setObject(2, requestId);
            ps.setObject(3, actorId);
            ps.setString(4, action);
            ps.setObject(5, operationKey);
            ps.setString(6, payloadHash);
            ps.setObject(7, Timestamp.from(createdAt));
            assertEquals(1, ps.executeUpdate());
        }
    }

    public static HttpResponse<String> postSignedCallback(
            int port,
            String invocationId,
            String executionId,
            String stepExecutionId,
            ObjectNode output) throws Exception {
        ObjectNode result = Json.object(
                "schemaVersion", "1",
                "invocationId", invocationId,
                "executionId", executionId,
                "stepExecutionId", stepExecutionId,
                "status", "succeeded",
                "completedAt", Protocol.jsInstant(Instant.now()),
                "output", output
        );
        byte[] rawBytes = Json.stringify(result).getBytes(StandardCharsets.UTF_8);

        String timestamp = String.valueOf(System.currentTimeMillis() / 1000);
        String deliveryId = UUID.randomUUID().toString();
        String sig = HttpAgentAdapter.signature(TEST_SECRET, timestamp, deliveryId, rawBytes);

        HttpClient client = HttpClient.newHttpClient();
        HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create("http://127.0.0.1:" + port + CALLBACK_PATH))
                .header("Content-Type", "application/json")
                .header(HttpAgentAdapter.KEY_ID, TEST_KEY_ID)
                .header(HttpAgentAdapter.TIMESTAMP, timestamp)
                .header(HttpAgentAdapter.DELIVERY_ID, deliveryId)
                .header(HttpAgentAdapter.SIGNATURE, sig)
                .POST(HttpRequest.BodyPublishers.ofByteArray(rawBytes))
                .build();

        return client.send(req, HttpResponse.BodyHandlers.ofString());
    }

    /**
     * Strict foreign-key-ordered cleanup of exact test fixtures.
     * Discovers ALL requests and execution IDs belonging to exact tracked user UUIDs BEFORE deletion,
     * merging them with tracked sets even if an HTTP assertion failed before tracking response IDs.
     * Deletes dependent decisions, audit, requests, engine execution children, and users.
     * Prohibits wildcards, global deletes, or schema dropping. Asserts cleanup failures to avoid masking test failures.
     */
    public static void cleanup(
            DataSource dataSource,
            Set<UUID> userIds,
            Set<UUID> requestIds,
            Set<UUID> executionIds) throws SQLException {
        List<Throwable> failures = new ArrayList<>();
        try (Connection conn = dataSource.getConnection()) {
            conn.setAutoCommit(false);
            try {
                Set<UUID> toDeleteRequests = new HashSet<>(requestIds != null ? requestIds : Collections.emptySet());
                Set<UUID> toDeleteExecutions = new HashSet<>(executionIds != null ? executionIds : Collections.emptySet());

                // 0. Discover all requests and executions belonging to tracked user UUIDs
                if (userIds != null && !userIds.isEmpty()) {
                    try (PreparedStatement ps = conn.prepareStatement(
                            "SELECT id, execution_id FROM tenvyr_review.requests WHERE owner_id = ?")) {
                        for (UUID u : userIds) {
                            ps.setObject(1, u);
                            try (ResultSet rs = ps.executeQuery()) {
                                while (rs.next()) {
                                    UUID rId = rs.getObject("id", UUID.class);
                                    UUID eId = rs.getObject("execution_id", UUID.class);
                                    if (rId != null) toDeleteRequests.add(rId);
                                    if (eId != null) toDeleteExecutions.add(eId);
                                }
                            }
                        }
                    }

                    try (PreparedStatement ps = conn.prepareStatement(
                            "SELECT request_id FROM tenvyr_review.audit WHERE actor_id = ? AND request_id IS NOT NULL")) {
                        for (UUID u : userIds) {
                            ps.setObject(1, u);
                            try (ResultSet rs = ps.executeQuery()) {
                                while (rs.next()) {
                                    UUID rId = rs.getObject("request_id", UUID.class);
                                    if (rId != null) toDeleteRequests.add(rId);
                                }
                            }
                        }
                    }

                    try (PreparedStatement ps = conn.prepareStatement(
                            "SELECT request_id FROM tenvyr_review.decisions WHERE actor_id = ? AND request_id IS NOT NULL")) {
                        for (UUID u : userIds) {
                            ps.setObject(1, u);
                            try (ResultSet rs = ps.executeQuery()) {
                                while (rs.next()) {
                                    UUID rId = rs.getObject("request_id", UUID.class);
                                    if (rId != null) toDeleteRequests.add(rId);
                                }
                            }
                        }
                    }
                }

                // For all discovered requests, discover any associated execution_id
                for (UUID rId : toDeleteRequests) {
                    try (PreparedStatement ps = conn.prepareStatement(
                            "SELECT execution_id FROM tenvyr_review.requests WHERE id = ?")) {
                        ps.setObject(1, rId);
                        try (ResultSet rs = ps.executeQuery()) {
                            if (rs.next()) {
                                UUID eId = rs.getObject("execution_id", UUID.class);
                                if (eId != null) toDeleteExecutions.add(eId);
                            }
                        }
                    }
                }

                // Merge discovered IDs back to tracked sets so caller inspects full scope
                if (requestIds != null) requestIds.addAll(toDeleteRequests);
                if (executionIds != null) executionIds.addAll(toDeleteExecutions);

                // 1. Delete decisions
                if (!toDeleteRequests.isEmpty()) {
                    try (PreparedStatement ps = conn.prepareStatement("DELETE FROM tenvyr_review.decisions WHERE request_id = ?")) {
                        for (UUID id : toDeleteRequests) {
                            ps.setObject(1, id);
                            ps.addBatch();
                        }
                        ps.executeBatch();
                    }
                }
                if (userIds != null && !userIds.isEmpty()) {
                    try (PreparedStatement ps = conn.prepareStatement("DELETE FROM tenvyr_review.decisions WHERE actor_id = ?")) {
                        for (UUID id : userIds) {
                            ps.setObject(1, id);
                            ps.addBatch();
                        }
                        ps.executeBatch();
                    }
                }

                // 2. Delete audit
                if (!toDeleteRequests.isEmpty()) {
                    try (PreparedStatement ps = conn.prepareStatement("DELETE FROM tenvyr_review.audit WHERE request_id = ?")) {
                        for (UUID id : toDeleteRequests) {
                            ps.setObject(1, id);
                            ps.addBatch();
                        }
                        ps.executeBatch();
                    }
                }
                if (userIds != null && !userIds.isEmpty()) {
                    try (PreparedStatement ps = conn.prepareStatement("DELETE FROM tenvyr_review.audit WHERE actor_id = ?")) {
                        for (UUID id : userIds) {
                            ps.setObject(1, id);
                            ps.addBatch();
                        }
                        ps.executeBatch();
                    }
                }

                // 3. Delete review requests
                if (!toDeleteRequests.isEmpty()) {
                    try (PreparedStatement ps = conn.prepareStatement("DELETE FROM tenvyr_review.requests WHERE id = ?")) {
                        for (UUID id : toDeleteRequests) {
                            ps.setObject(1, id);
                            ps.addBatch();
                        }
                        ps.executeBatch();
                    }
                }
                if (userIds != null && !userIds.isEmpty()) {
                    try (PreparedStatement ps = conn.prepareStatement("DELETE FROM tenvyr_review.requests WHERE owner_id = ?")) {
                        for (UUID id : userIds) {
                            ps.setObject(1, id);
                            ps.addBatch();
                        }
                        ps.executeBatch();
                    }
                }

                // 4. Delete engine execution hierarchy
                if (!toDeleteExecutions.isEmpty()) {
                    // Break cycle: UPDATE executions SET "activePlanRevisionId" = NULL WHERE id = ?
                    try (PreparedStatement ps = conn.prepareStatement("UPDATE executions SET \"activePlanRevisionId\" = NULL WHERE id = ?")) {
                        for (UUID id : toDeleteExecutions) {
                            ps.setObject(1, id);
                            ps.addBatch();
                        }
                        ps.executeBatch();
                    }

                    // Delete state_write_evidence
                    try (PreparedStatement ps = conn.prepareStatement("DELETE FROM state_write_evidence WHERE \"executionId\" = ?")) {
                        for (UUID id : toDeleteExecutions) {
                            ps.setObject(1, id);
                            ps.addBatch();
                        }
                        ps.executeBatch();
                    }

                    // Delete artifact_exposures
                    try (PreparedStatement ps = conn.prepareStatement(
                            "DELETE FROM artifact_exposures WHERE \"stepAttemptId\" IN (" +
                                    "  SELECT id FROM step_attempts WHERE \"executionId\" = ?" +
                                    ")")) {
                        for (UUID id : toDeleteExecutions) {
                            ps.setObject(1, id);
                            ps.addBatch();
                        }
                        ps.executeBatch();
                    }

                    // Delete artifacts
                    try (PreparedStatement ps = conn.prepareStatement(
                            "DELETE FROM artifacts WHERE \"resultInboxId\" IN (" +
                                    "  SELECT id FROM result_inbox WHERE \"stepAttemptId\" IN (" +
                                    "    SELECT id FROM step_attempts WHERE \"executionId\" = ?" +
                                    "  )" +
                                    ")")) {
                        for (UUID id : toDeleteExecutions) {
                            ps.setObject(1, id);
                            ps.addBatch();
                        }
                        ps.executeBatch();
                    }

                    // Delete result_conflicts
                    try (PreparedStatement ps = conn.prepareStatement(
                            "DELETE FROM result_conflicts WHERE \"resultInboxId\" IN (" +
                                    "  SELECT id FROM result_inbox WHERE \"stepAttemptId\" IN (" +
                                    "    SELECT id FROM step_attempts WHERE \"executionId\" = ?" +
                                    "  )" +
                                    ")")) {
                        for (UUID id : toDeleteExecutions) {
                            ps.setObject(1, id);
                            ps.addBatch();
                        }
                        ps.executeBatch();
                    }

                    // Delete result_inbox
                    try (PreparedStatement ps = conn.prepareStatement(
                            "DELETE FROM result_inbox WHERE \"stepAttemptId\" IN (" +
                                    "  SELECT id FROM step_attempts WHERE \"executionId\" = ?" +
                                    ")")) {
                        for (UUID id : toDeleteExecutions) {
                            ps.setObject(1, id);
                            ps.addBatch();
                        }
                        ps.executeBatch();
                    }

                    // Delete dispatch_outbox
                    try (PreparedStatement ps = conn.prepareStatement(
                            "DELETE FROM dispatch_outbox WHERE \"stepAttemptId\" IN (" +
                                    "  SELECT id FROM step_attempts WHERE \"executionId\" = ?" +
                                    ")")) {
                        for (UUID id : toDeleteExecutions) {
                            ps.setObject(1, id);
                            ps.addBatch();
                        }
                        ps.executeBatch();
                    }

                    // Delete step_attempts
                    try (PreparedStatement ps = conn.prepareStatement("DELETE FROM step_attempts WHERE \"executionId\" = ?")) {
                        for (UUID id : toDeleteExecutions) {
                            ps.setObject(1, id);
                            ps.addBatch();
                        }
                        ps.executeBatch();
                    }

                    // Delete step_executions
                    try (PreparedStatement ps = conn.prepareStatement("DELETE FROM step_executions WHERE \"executionId\" = ?")) {
                        for (UUID id : toDeleteExecutions) {
                            ps.setObject(1, id);
                            ps.addBatch();
                        }
                        ps.executeBatch();
                    }

                    // Delete execution_plan_revisions
                    try (PreparedStatement ps = conn.prepareStatement("DELETE FROM execution_plan_revisions WHERE \"executionId\" = ?")) {
                        for (UUID id : toDeleteExecutions) {
                            ps.setObject(1, id);
                            ps.addBatch();
                        }
                        ps.executeBatch();
                    }

                    // Delete executions
                    try (PreparedStatement ps = conn.prepareStatement("DELETE FROM executions WHERE id = ?")) {
                        for (UUID id : toDeleteExecutions) {
                            ps.setObject(1, id);
                            ps.addBatch();
                        }
                        ps.executeBatch();
                    }
                }

                // 5. Delete users
                if (userIds != null && !userIds.isEmpty()) {
                    try (PreparedStatement ps = conn.prepareStatement("DELETE FROM tenvyr_review.users WHERE id = ?")) {
                        for (UUID id : userIds) {
                            ps.setObject(1, id);
                            ps.addBatch();
                        }
                        ps.executeBatch();
                    }
                }

                conn.commit();
            } catch (Throwable t) {
                conn.rollback();
                failures.add(t);
            }
        } catch (Throwable t) {
            failures.add(t);
        } finally {
            if (userIds != null) userIds.clear();
            if (requestIds != null) requestIds.clear();
            if (executionIds != null) executionIds.clear();
        }

        if (!failures.isEmpty()) {
            AssertionError err = new AssertionError("Cleanup failed: " + failures.get(0).getMessage(), failures.get(0));
            for (int i = 1; i < failures.size(); i++) {
                err.addSuppressed(failures.get(i));
            }
            throw err;
        }
    }
}
