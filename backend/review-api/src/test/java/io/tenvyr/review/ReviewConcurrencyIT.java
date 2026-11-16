package io.tenvyr.review;

import com.fasterxml.jackson.databind.JsonNode;
import com.zaxxer.hikari.HikariDataSource;
import io.tenvyr.platform.Json;
import io.tenvyr.review.domain.ReviewTypes.Role;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import javax.sql.DataSource;
import java.net.URI;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;

import static org.junit.jupiter.api.Assertions.*;

/**
 * T08 Integration Test: Review Concurrency, Bounded Resources, and DB Lock Recovery.
 * Verifies real PostgreSQL and Hikari pool exhaustion resilience over HTTP without mocks/H2.
 * 1. Hikari pool saturation: holds all 10 connections, attempts valid submit -> 503 Retry-After: 1
 *    within bounded acquisition 2s; releasing connections permits same-key retry and replay
 *    converging to exact 1 request, execution, and SUBMIT audit row without orphan records.
 * 2. Real PostgreSQL table lock: blocks command SQL in pg_locks, triggers configured 2s lock_timeout
 *    -> safe 503 Retry-After: 1 rollback; releasing barrier permits same-key replay convergence
 *    and verifies pool/transaction recovery remains healthy.
 */
@SpringBootTest(
        classes = ReviewApplication.class,
        webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = {
                "HTTP_AGENT_ALLOW_INSECURE=true",
                "HTTP_AGENT_CALLBACK_BASE_URL=http://127.0.0.1:8080",
                "TEST_SECRET=" + ReviewTestSupport.TEST_SECRET,
                "TEST_TOKEN=" + ReviewTestSupport.TEST_TOKEN
        }
)
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
public class ReviewConcurrencyIT {

    @LocalServerPort
    private int port;

    @Autowired
    private DataSource dataSource;

    private final Set<UUID> trackedUsers = Collections.synchronizedSet(new HashSet<>());
    private final Set<UUID> trackedRequests = Collections.synchronizedSet(new HashSet<>());
    private final Set<UUID> trackedExecutions = Collections.synchronizedSet(new HashSet<>());

    @DynamicPropertySource
    static void configureProperties(DynamicPropertyRegistry registry) {
        int workerPort = ReviewTestSupport.startMockWorkerPeer();
        ReviewTestSupport.configureTestDatabaseProperties(registry, workerPort);
    }

    @BeforeAll
    static void requireRealDisposableDatabase() {
        String raw = System.getenv("TENVYR_REVIEW_TEST_DATABASE_URL");
        ReviewCallbackIT.validateDisposableDatabaseUrl(raw);
    }

    @AfterAll
    static void tearDownPeer() {
        ReviewTestSupport.stopMockWorkerPeer();
    }

    @AfterEach
    void cleanFixtures() throws SQLException {
        ReviewTestSupport.cleanup(dataSource, trackedUsers, trackedRequests, trackedExecutions);
    }

    private String reviewsUrl() {
        return "http://127.0.0.1:" + port + "/api/v1/reviews";
    }

    @Test
    @DisplayName("Hikari pool saturation returns safe 503 within bounded acquisition 2s, and connection release permits successful replay convergence")
    void poolSaturation_returnsSafe503_andReleasePermitsSuccessfulReplayConvergence() throws Exception {
        // Authenticated session + CSRF established BEFORE holding connections
        ReviewTestSupport.TestUser submitter = ReviewTestSupport.createTestUser(
                dataSource, trackedUsers, "conc_pool_sat", Role.SUBMITTER);
        ReviewTestSupport.AuthenticatedSession session = ReviewTestSupport.loginUser(port, submitter);

        // Assert Hikari pool sizing and acquisition timeout contracts
        assertInstanceOf(HikariDataSource.class, dataSource, "DataSource must be a HikariDataSource");
        HikariDataSource hikariDs = (HikariDataSource) dataSource;
        assertEquals(10, hikariDs.getMaximumPoolSize(), "Hikari maximum pool size must be exactly 10");
        assertEquals(2000L, hikariDs.getConnectionTimeout(), "Hikari connection acquisition timeout must be 2000ms");

        UUID idempotencyKey = UUID.randomUUID();
        Map<String, Object> payload = Map.of(
                "title", "Bounded Resource Saturation Review",
                "language", "java",
                "code", "public class SaturationTest { int x = 100; }"
        );
        String body = Json.stringify(Json.value(payload));

        HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create(reviewsUrl()))
                .header("Content-Type", "application/json")
                .header(session.csrf().headerName(), session.csrf().token())
                .header("Idempotency-Key", idempotencyKey.toString())
                .timeout(Duration.ofSeconds(10))
                .POST(HttpRequest.BodyPublishers.ofString(body))
                .build();

        List<Connection> heldConnections = new ArrayList<>();
        try {
            // Saturate all 10 pool connections
            for (int i = 0; i < 10; i++) {
                heldConnections.add(dataSource.getConnection());
            }
            assertEquals(10, heldConnections.size(), "All 10 Hikari connections must be borrowed");
            assertEquals(10, hikariDs.getHikariPoolMXBean().getActiveConnections(), "All 10 pool connections must be active");

            long start = System.nanoTime();
            HttpResponse<String> resp503 = session.client().send(req, HttpResponse.BodyHandlers.ofString());
            long elapsedMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start);

            assertTrue(elapsedMs >= 1500, "Acquisition must wait for configured ~2000ms connectionTimeout, elapsed: " + elapsedMs);
            assertEquals(503, resp503.statusCode(), "Exhausted pool must yield 503 Service Unavailable");
            assertEquals("1", resp503.headers().firstValue("Retry-After").orElse(""), "Must include Retry-After: 1 header");
            ReviewTestSupport.assertSafeErrorJson(resp503, 503, "DATABASE_UNAVAILABLE");

        } finally {
            // Ensure all connections are returned even if assertions fail
            for (Connection conn : heldConnections) {
                try {
                    conn.close();
                } catch (Exception ignored) {}
            }
            heldConnections.clear();
        }

        // After releasing pool connections, same key retry returns 202 Accepted
        HttpResponse<String> respRetry = session.client().send(req, HttpResponse.BodyHandlers.ofString());
        assertEquals(202, respRetry.statusCode(), "Retry after pool release must return 202 Accepted");
        String location = respRetry.headers().firstValue("Location").orElse("");
        assertFalse(location.isBlank(), "Location header must be present");

        JsonNode retryJson = Json.parse(respRetry.body());
        UUID requestId = UUID.fromString(retryJson.path("id").asText());
        UUID executionId = UUID.fromString(retryJson.path("executionId").asText());
        trackedRequests.add(requestId);
        trackedExecutions.add(executionId);

        // Replay with identical key returns 202 and identical identities
        HttpResponse<String> respReplay = session.client().send(req, HttpResponse.BodyHandlers.ofString());
        assertEquals(202, respReplay.statusCode(), "Replay must return 202 Accepted");
        JsonNode replayJson = Json.parse(respReplay.body());
        assertEquals(requestId.toString(), replayJson.path("id").asText(), "Replay must return same request ID");
        assertEquals(executionId.toString(), replayJson.path("executionId").asText(), "Replay must return same execution ID");

        // Verify DB contains exactly 1 request, 1 execution, and 1 SUBMIT audit row with zero 503 residuals
        try (Connection conn = dataSource.getConnection()) {
            try (PreparedStatement ps = conn.prepareStatement(
                    "SELECT count(*) FROM tenvyr_review.requests WHERE owner_id = ? AND idempotency_key = ?")) {
                ps.setObject(1, submitter.id());
                ps.setObject(2, idempotencyKey);
                try (ResultSet rs = ps.executeQuery()) {
                    assertTrue(rs.next());
                    assertEquals(1, rs.getInt(1), "Exactly one request row must exist for owner and idempotencyKey");
                }
            }
            try (PreparedStatement ps = conn.prepareStatement(
                    "SELECT count(*) FROM tenvyr_review.audit WHERE actor_id = ? AND operation_key = ? AND action = 'SUBMIT'")) {
                ps.setObject(1, submitter.id());
                ps.setObject(2, idempotencyKey);
                try (ResultSet rs = ps.executeQuery()) {
                    assertTrue(rs.next());
                    assertEquals(1, rs.getInt(1), "Exactly one SUBMIT audit row must exist");
                }
            }
            try (PreparedStatement ps = conn.prepareStatement(
                    "SELECT count(*) FROM executions WHERE id = ?")) {
                ps.setObject(1, executionId);
                try (ResultSet rs = ps.executeQuery()) {
                    assertTrue(rs.next());
                    assertEquals(1, rs.getInt(1), "Exactly one execution row must exist");
                }
            }
        }
    }

    @Test
    @DisplayName("Real PG table lock blocks command SQL, returns safe 503 Retry-After on 2s lock timeout, and release converges to exact single identity")
    void realPgTableLock_blocksCommandSql_returnsSafe503_andRollbackConvergesOnRelease() throws Exception {
        ReviewTestSupport.TestUser submitter = ReviewTestSupport.createTestUser(
                dataSource, trackedUsers, "conc_pg_lock", Role.SUBMITTER);
        ReviewTestSupport.AuthenticatedSession session = ReviewTestSupport.loginUser(port, submitter);

        UUID idempotencyKey = UUID.randomUUID();
        Map<String, Object> payload = Map.of(
                "title", "Real PG Table Lock Contention Review",
                "language", "python",
                "code", "def solve():\n    return 42\n"
        );
        String body = Json.stringify(Json.value(payload));

        HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create(reviewsUrl()))
                .header("Content-Type", "application/json")
                .header(session.csrf().headerName(), session.csrf().token())
                .header("Idempotency-Key", idempotencyKey.toString())
                .timeout(Duration.ofSeconds(10))
                .POST(HttpRequest.BodyPublishers.ofString(body))
                .build();

        ExecutorService clientExecutor = Executors.newSingleThreadExecutor();
        try (Connection lockConn = dataSource.getConnection()) {
            lockConn.setAutoCommit(false);

            // Determine blocker PID in PostgreSQL
            int blockerPid;
            try (Statement s = lockConn.createStatement();
                 ResultSet rs = s.executeQuery("SELECT pg_backend_pid()")) {
                assertTrue(rs.next(), "pg_backend_pid must return a row");
                blockerPid = rs.getInt(1);
            }

            // Acquire real table lock on tenvyr_review.requests that conflicts with command queries and inserts
            try (Statement s = lockConn.createStatement()) {
                s.execute("LOCK TABLE tenvyr_review.requests IN ACCESS EXCLUSIVE MODE");
            }

            // Dispatch command asynchronously from bounded client
            Future<HttpResponse<String>> futureResp = clientExecutor.submit(() ->
                    session.client().send(req, HttpResponse.BodyHandlers.ofString()));

            // Confirm command is actively blocked in PostgreSQL via pg_locks before timeout occurs
            int blockedPid = ReviewTestSupport.awaitPgBlockingPid(dataSource, blockerPid, 5000);
            assertTrue(blockedPid > 0, "Command SQL backend PID must be actively blocked by holder pid in pg_locks");

            // Configured 2s lock_timeout in ReviewService triggers safe 503 Retry-After: 1
            HttpResponse<String> resp503 = futureResp.get(10, TimeUnit.SECONDS);
            assertEquals(503, resp503.statusCode(), "Lock timeout must return 503 Service Unavailable");
            assertEquals("1", resp503.headers().firstValue("Retry-After").orElse(""), "Must include Retry-After: 1 header");
            ReviewTestSupport.assertSafeErrorJson(resp503, 503, "DATABASE_UNAVAILABLE");

            // Roll back the holding transaction and release the table lock
            lockConn.rollback();

        } finally {
            clientExecutor.shutdownNow();
        }

        // Verify that the timed-out attempt completely rolled back without partial writes
        try (Connection conn = dataSource.getConnection()) {
            try (PreparedStatement ps = conn.prepareStatement(
                    "SELECT count(*) FROM tenvyr_review.requests WHERE owner_id = ? AND idempotency_key = ?")) {
                ps.setObject(1, submitter.id());
                ps.setObject(2, idempotencyKey);
                try (ResultSet rs = ps.executeQuery()) {
                    assertTrue(rs.next());
                    assertEquals(0, rs.getInt(1), "No request row must exist after lock timeout rollback");
                }
            }
            try (PreparedStatement ps = conn.prepareStatement(
                    "SELECT count(*) FROM tenvyr_review.audit WHERE actor_id = ? AND operation_key = ?")) {
                ps.setObject(1, submitter.id());
                ps.setObject(2, idempotencyKey);
                try (ResultSet rs = ps.executeQuery()) {
                    assertTrue(rs.next());
                    assertEquals(0, rs.getInt(1), "No audit row must exist after lock timeout rollback");
                }
            }
        }

        // Release barrier -> same command key retry succeeds with 202 Accepted
        HttpResponse<String> respSuccess = session.client().send(req, HttpResponse.BodyHandlers.ofString());
        assertEquals(202, respSuccess.statusCode(), "Command retry after lock release must return 202 Accepted");

        JsonNode successJson = Json.parse(respSuccess.body());
        UUID requestId = UUID.fromString(successJson.path("id").asText());
        UUID executionId = UUID.fromString(successJson.path("executionId").asText());
        trackedRequests.add(requestId);
        trackedExecutions.add(executionId);

        // Replay with identical key converges to exact same identity
        HttpResponse<String> respReplay = session.client().send(req, HttpResponse.BodyHandlers.ofString());
        assertEquals(202, respReplay.statusCode(), "Replay must return 202 Accepted");
        JsonNode replayJson = Json.parse(respReplay.body());
        assertEquals(requestId.toString(), replayJson.path("id").asText(), "Replay must return identical request ID");
        assertEquals(executionId.toString(), replayJson.path("executionId").asText(), "Replay must return identical execution ID");

        // Verify exactly one request, execution, and audit row exist
        try (Connection conn = dataSource.getConnection()) {
            try (PreparedStatement ps = conn.prepareStatement(
                    "SELECT count(*) FROM tenvyr_review.requests WHERE owner_id = ? AND idempotency_key = ?")) {
                ps.setObject(1, submitter.id());
                ps.setObject(2, idempotencyKey);
                try (ResultSet rs = ps.executeQuery()) {
                    assertTrue(rs.next());
                    assertEquals(1, rs.getInt(1), "Exact one request row must exist");
                }
            }
            try (PreparedStatement ps = conn.prepareStatement(
                    "SELECT count(*) FROM tenvyr_review.audit WHERE actor_id = ? AND operation_key = ? AND action = 'SUBMIT'")) {
                ps.setObject(1, submitter.id());
                ps.setObject(2, idempotencyKey);
                try (ResultSet rs = ps.executeQuery()) {
                    assertTrue(rs.next());
                    assertEquals(1, rs.getInt(1), "Exact one SUBMIT audit row must exist");
                }
            }
            try (PreparedStatement ps = conn.prepareStatement(
                    "SELECT count(*) FROM executions WHERE id = ?")) {
                ps.setObject(1, executionId);
                try (ResultSet rs = ps.executeQuery()) {
                    assertTrue(rs.next());
                    assertEquals(1, rs.getInt(1), "Exact one execution row must exist");
                }
            }
        }

        // Verify transaction and pool recovery remains healthy with an authorized read
        HttpRequest getReq = HttpRequest.newBuilder()
                .uri(URI.create(reviewsUrl() + "/" + requestId))
                .header(session.csrf().headerName(), session.csrf().token())
                .timeout(Duration.ofSeconds(5))
                .GET()
                .build();
        HttpResponse<String> getResp = session.client().send(getReq, HttpResponse.BodyHandlers.ofString());
        assertEquals(200, getResp.statusCode(), "Authorized read must succeed after pool and lock recovery");
        assertEquals("PROCESSING", Json.parse(getResp.body()).path("status").asText(), "Review status must be PROCESSING");
    }
}
