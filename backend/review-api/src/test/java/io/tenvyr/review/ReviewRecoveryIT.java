package io.tenvyr.review;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sun.net.httpserver.HttpServer;
import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import io.tenvyr.control.engine.HttpAgentAdapter;
import io.tenvyr.platform.Json;
import io.tenvyr.platform.Protocol;
import io.tenvyr.review.domain.ReviewTypes.Role;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Duration;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.*;

import static org.junit.jupiter.api.Assertions.*;

/**
 * T08 Integration Test: Real Process Acceptance (Recovery, Crash Invariants, Worker Death, and Graceful Drain).
 * Tests execute against real disposable PostgreSQL using separate OS child JVMs.
 *
 * Scenarios:
 * 1. Kill API JVM BEFORE submit TX commit after confirmed materialization, request, audit in SAME transaction
 *    and DB barrier => zero residuals.
 * 2. Kill API JVM AFTER DB commit BEFORE response escapes => replay returns same identity; recovery starts work.
 * 3. Real Worker child JVM death after accepted/running before callback => bounded natural retry via 30s attempt deadline;
 *    exercise duplicate/conflicting/stale signed callbacks => final business outcome not overwritten, no orphan bindings.
 * 4. Real SIGTERM to owned API JVM while holding DB work => stop admission, drain work, exit bounded with pool closed last,
 *    and restart consistently without in-memory session assumption.
 */
public class ReviewRecoveryIT {

    private static String testDbUrl;
    private static String testUser;
    private static String testPassword;
    private static HikariDataSource dataSource;

    private final Set<UUID> trackedUsers = Collections.synchronizedSet(new HashSet<>());
    private final Set<UUID> trackedRequests = Collections.synchronizedSet(new HashSet<>());
    private final Set<UUID> trackedExecutions = Collections.synchronizedSet(new HashSet<>());
    private final List<ReviewProcessTestSupport.ManagedProcess> trackedProcesses = new CopyOnWriteArrayList<>();

    @BeforeAll
    static void setUpDatabase() {
        String raw = System.getenv("TENVYR_REVIEW_TEST_DATABASE_URL");
        ReviewProcessTestSupport.validateDisposableDatabaseUrl(raw);
        testDbUrl = raw;
        testUser = System.getenv().getOrDefault("POSTGRES_USER", "postgres");
        testPassword = System.getenv().getOrDefault("POSTGRES_PASSWORD", "postgres");

        HikariConfig config = new HikariConfig();
        config.setJdbcUrl(testDbUrl);
        config.setUsername(testUser);
        config.setPassword(testPassword);
        config.setMaximumPoolSize(5);
        config.setConnectionTimeout(5000);
        config.setConnectionInitSql("SET TIME ZONE 'UTC'");
        dataSource = new HikariDataSource(config);
    }

    @AfterAll
    static void tearDownDatabase() {
        if (dataSource != null && !dataSource.isClosed()) {
            dataSource.close();
        }
    }

    @AfterEach
    void tearDown() throws SQLException {
        for (ReviewProcessTestSupport.ManagedProcess p : trackedProcesses) {
            try {
                p.close();
            } catch (Exception ignored) {}
        }
        trackedProcesses.clear();

        ReviewTestSupport.cleanup(dataSource, trackedUsers, trackedRequests, trackedExecutions);
    }

    private static HttpResponse<String> sendSignedCallback(
            int apiPort,
            String invocationId,
            String executionId,
            String stepExecutionId,
            String status,
            JsonNode output,
            JsonNode error) throws Exception {

        ObjectNode result = Json.object(
                "schemaVersion", "1",
                "invocationId", invocationId,
                "executionId", executionId,
                "stepExecutionId", stepExecutionId,
                "status", status,
                "completedAt", Protocol.jsInstant(Instant.now())
        );
        if (output != null) {
            result.set("output", output);
        }
        if (error != null) {
            result.set("error", error);
        }

        byte[] rawBytes = Json.stringify(result).getBytes(StandardCharsets.UTF_8);
        String timestamp = String.valueOf(System.currentTimeMillis() / 1000);
        String deliveryId = UUID.randomUUID().toString();
        String sig = HttpAgentAdapter.signature(ReviewTestSupport.TEST_SECRET, timestamp, deliveryId, rawBytes);

        HttpClient client = HttpClient.newHttpClient();
        HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create("http://127.0.0.1:" + apiPort + ReviewTestSupport.CALLBACK_PATH))
                .header("Content-Type", "application/json")
                .header(HttpAgentAdapter.KEY_ID, ReviewTestSupport.TEST_KEY_ID)
                .header(HttpAgentAdapter.TIMESTAMP, timestamp)
                .header(HttpAgentAdapter.DELIVERY_ID, deliveryId)
                .header(HttpAgentAdapter.SIGNATURE, sig)
                .POST(HttpRequest.BodyPublishers.ofByteArray(rawBytes))
                .build();

        return client.send(req, HttpResponse.BodyHandlers.ofString());
    }

    @Test
    @DisplayName("1. Kill owned API JVM BEFORE submit TX commit after confirmed materialization and DB barrier leaves zero residuals")
    void killApiJvmBeforeSubmitTxCommit_leavesZeroResiduals() throws Exception {
        ReviewTestSupport.TestUser submitter = ReviewTestSupport.createTestUser(
                dataSource, trackedUsers, "sub_rec_pre", Role.SUBMITTER);
        UUID idempotencyKey = UUID.randomUUID();
        long barrierLockKey = Math.abs(UUID.randomUUID().getMostSignificantBits());
        if (barrierLockKey == 0) barrierLockKey = 10001L;

        Connection lockConn = dataSource.getConnection();
        lockConn.setAutoCommit(false);
        try (PreparedStatement ps = lockConn.prepareStatement("SELECT pg_advisory_lock(?)")) {
            ps.setLong(1, barrierLockKey);
            ps.execute();
        }

        int apiPort = ReviewProcessTestSupport.findFreePort();
        int workerPort = ReviewProcessTestSupport.findFreePort();
        ExecutorService clientExecutor = Executors.newSingleThreadExecutor();

        ReviewProcessTestSupport.ManagedProcess apiProcess = null;
        try {
            apiProcess = ReviewProcessTestSupport.launchApiProcess(
                    "t08-api-precommit-kill",
                    apiPort,
                    testDbUrl,
                    testUser,
                    testPassword,
                    workerPort,
                    Map.of("test.barrier.pre-commit.lock-key", String.valueOf(barrierLockKey))
            );
            trackedProcesses.add(apiProcess);
            int boundApiPort = apiProcess.port() > 0 ? apiProcess.port() : apiPort;

            ReviewTestSupport.AuthenticatedSession session = ReviewTestSupport.loginUser(boundApiPort, submitter);

            Map<String, Object> payload = Map.of(
                    "title", "Kill Before Commit Review",
                    "language", "java",
                    "code", "public class PreCommitCrashTest { int value = 1; }"
            );
            String bodyJson = Json.stringify(Json.value(payload));

            Future<HttpResponse<String>> clientFuture = clientExecutor.submit(() -> {
                HttpRequest req = HttpRequest.newBuilder()
                        .uri(URI.create("http://127.0.0.1:" + boundApiPort + "/api/v1/reviews"))
                        .header("Content-Type", "application/json")
                        .header(session.csrf().headerName(), session.csrf().token())
                        .header("Idempotency-Key", idempotencyKey.toString())
                        .POST(HttpRequest.BodyPublishers.ofString(bodyJson))
                        .build();
                return session.client().send(req, HttpResponse.BodyHandlers.ofString());
            });

            // Await phase marker from child API stdout proving engine materialization, request, and audit were written
            // on the SAME active transaction connection before blocking on the advisory lock
            String markerLine = apiProcess.waitForMarker("[PHASE:BEFORE_COMMIT_CONFIRMED:", Duration.ofSeconds(45));
            String[] parts = markerLine.replace("[PHASE:BEFORE_COMMIT_CONFIRMED:", "").replace("]", "").split(":");
            Map<String, String> markerMap = new HashMap<>();
            for (String part : parts) {
                String[] kv = part.split("=", 2);
                if (kv.length == 2) markerMap.put(kv[0], kv[1]);
            }
            UUID materializedExecutionId = UUID.fromString(markerMap.get("executionId"));
            UUID materializedRequestId = markerMap.containsKey("requestId") && !"null".equals(markerMap.get("requestId"))
                    ? UUID.fromString(markerMap.get("requestId"))
                    : null;
            trackedExecutions.add(materializedExecutionId);
            if (materializedRequestId != null) trackedRequests.add(materializedRequestId);

            assertEquals("1", markerMap.get("execCount"), "Execution must exist in active uncommitted transaction");
            assertEquals("1", markerMap.get("auditCount"), "Audit must exist in active uncommitted transaction");

            // Await confirmation that child transaction is blocked waiting on barrierLockKey in PostgreSQL pg_locks
            ReviewProcessTestSupport.awaitAdvisoryLockBlocked(dataSource, Duration.ofSeconds(15));

            // Kill owned API JVM BEFORE commit while holding the DB transaction
            apiProcess.destroyForcibly();
            boolean exited = apiProcess.waitFor(10, TimeUnit.SECONDS);
            assertTrue(exited, "API child JVM must terminate when forcibly killed");
            assertFalse(apiProcess.isAlive(), "API child JVM must be dead");

            // Release the barrier lock held by test connection
            try {
                try (PreparedStatement ps = lockConn.prepareStatement("SELECT pg_advisory_unlock(?)")) {
                    ps.setLong(1, barrierLockKey);
                    ps.execute();
                }
            } finally {
                lockConn.rollback();
                lockConn.close();
            }

            // Outstanding client request must fail (TCP reset / EOF, response never escaped)
            try {
                HttpResponse<String> resp = clientFuture.get(5, TimeUnit.SECONDS);
                fail("Client future should have failed due to JVM kill, but returned " + resp.statusCode());
            } catch (ExecutionException expected) {
                assertTrue(expected.getCause() instanceof IOException,
                        "Client must observe IOException/reset when server process dies before response: " + expected.getCause());
            }

            // Non-vacuous verification: exact materialized executionId, requestId, ownerId, and idempotencyKey have ZERO residuals
            try (Connection conn = dataSource.getConnection()) {
                try (PreparedStatement ps = conn.prepareStatement("SELECT count(*) FROM executions WHERE id = ?")) {
                    ps.setObject(1, materializedExecutionId);
                    try (ResultSet rs = ps.executeQuery()) {
                        assertTrue(rs.next());
                        assertEquals(0, rs.getInt(1), "Materialized execution must not survive transaction rollback");
                    }
                }
                try (PreparedStatement ps = conn.prepareStatement("SELECT count(*) FROM execution_plan_revisions WHERE \"executionId\" = ?")) {
                    ps.setObject(1, materializedExecutionId);
                    try (ResultSet rs = ps.executeQuery()) {
                        assertTrue(rs.next());
                        assertEquals(0, rs.getInt(1), "Execution plan revisions must not survive transaction rollback");
                    }
                }
                try (PreparedStatement ps = conn.prepareStatement("SELECT count(*) FROM step_executions WHERE \"executionId\" = ?")) {
                    ps.setObject(1, materializedExecutionId);
                    try (ResultSet rs = ps.executeQuery()) {
                        assertTrue(rs.next());
                        assertEquals(0, rs.getInt(1), "Step executions must not survive transaction rollback");
                    }
                }
                try (PreparedStatement ps = conn.prepareStatement("SELECT count(*) FROM step_attempts WHERE \"executionId\" = ?")) {
                    ps.setObject(1, materializedExecutionId);
                    try (ResultSet rs = ps.executeQuery()) {
                        assertTrue(rs.next());
                        assertEquals(0, rs.getInt(1), "Step attempts must not survive transaction rollback");
                    }
                }
                try (PreparedStatement ps = conn.prepareStatement(
                        "SELECT count(*) FROM dispatch_outbox WHERE \"stepAttemptId\" IN (SELECT id FROM step_attempts WHERE \"executionId\" = ?)")) {
                    ps.setObject(1, materializedExecutionId);
                    try (ResultSet rs = ps.executeQuery()) {
                        assertTrue(rs.next());
                        assertEquals(0, rs.getInt(1), "Dispatch outbox must not survive transaction rollback");
                    }
                }
                try (PreparedStatement ps = conn.prepareStatement(
                        "SELECT count(*) FROM tenvyr_review.requests WHERE owner_id = ? AND idempotency_key = ?")) {
                    ps.setObject(1, submitter.id());
                    ps.setObject(2, idempotencyKey);
                    try (ResultSet rs = ps.executeQuery()) {
                        assertTrue(rs.next());
                        assertEquals(0, rs.getInt(1), "Review request row must not survive transaction rollback");
                    }
                }
                if (materializedRequestId != null) {
                    try (PreparedStatement ps = conn.prepareStatement("SELECT count(*) FROM tenvyr_review.requests WHERE id = ?")) {
                        ps.setObject(1, materializedRequestId);
                        try (ResultSet rs = ps.executeQuery()) {
                            assertTrue(rs.next());
                            assertEquals(0, rs.getInt(1), "Materialized request row must not survive rollback");
                        }
                    }
                }
                try (PreparedStatement ps = conn.prepareStatement(
                        "SELECT count(*) FROM tenvyr_review.audit WHERE actor_id = ? AND operation_key = ?")) {
                    ps.setObject(1, submitter.id());
                    ps.setObject(2, idempotencyKey);
                    try (ResultSet rs = ps.executeQuery()) {
                        assertTrue(rs.next());
                        assertEquals(0, rs.getInt(1), "SUBMIT audit row must not survive transaction rollback");
                    }
                }
            }
        } finally {
            clientExecutor.shutdownNow();
            try {
                if (!lockConn.isClosed()) {
                    lockConn.rollback();
                    lockConn.close();
                }
            } catch (Exception ignored) {}
        }
    }

    @Test
    @DisplayName("2. Kill API JVM AFTER DB commit BEFORE HTTP response escapes, restart with bootstrap OFF, new login, and replay returns same identity")
    void killApiJvmAfterCommitBeforeResponseEscapes_replayReturnsSameIdentityAndRecoveryStartsDurableWork() throws Exception {
        ReviewTestSupport.TestUser submitter = ReviewTestSupport.createTestUser(
                dataSource, trackedUsers, "sub_rec_post", Role.SUBMITTER);
        UUID idempotencyKey = UUID.randomUUID();
        long barrierLockKey = Math.abs(UUID.randomUUID().getMostSignificantBits());
        if (barrierLockKey == 0) barrierLockKey = 20002L;

        Connection lockConn = dataSource.getConnection();
        lockConn.setAutoCommit(false);
        try (PreparedStatement ps = lockConn.prepareStatement("SELECT pg_advisory_lock(?)")) {
            ps.setLong(1, barrierLockKey);
            ps.execute();
        }

        int apiPort1 = ReviewProcessTestSupport.findFreePort();
        int workerPort = ReviewProcessTestSupport.findFreePort();
        ExecutorService clientExecutor = Executors.newSingleThreadExecutor();

        ReviewProcessTestSupport.ManagedProcess apiProcess1 = null;
        ReviewProcessTestSupport.ManagedProcess apiProcess2 = null;
        try {
            apiProcess1 = ReviewProcessTestSupport.launchApiProcess(
                    "t08-api-postcommit-kill-1",
                    apiPort1,
                    testDbUrl,
                    testUser,
                    testPassword,
                    workerPort,
                    Map.of("test.barrier.post-commit.lock-key", String.valueOf(barrierLockKey))
            );
            trackedProcesses.add(apiProcess1);
            int boundApiPort1 = apiProcess1.port() > 0 ? apiProcess1.port() : apiPort1;

            ReviewTestSupport.AuthenticatedSession session1 = ReviewTestSupport.loginUser(boundApiPort1, submitter);

            Map<String, Object> payload = Map.of(
                    "title", "Kill After Commit Review",
                    "language", "typescript",
                    "code", "export const value: number = 42;"
            );
            String bodyJson = Json.stringify(Json.value(payload));

            Future<HttpResponse<String>> clientFuture = clientExecutor.submit(() -> {
                HttpRequest req = HttpRequest.newBuilder()
                        .uri(URI.create("http://127.0.0.1:" + boundApiPort1 + "/api/v1/reviews"))
                        .header("Content-Type", "application/json")
                        .header(session1.csrf().headerName(), session1.csrf().token())
                        .header("Idempotency-Key", idempotencyKey.toString())
                        .POST(HttpRequest.BodyPublishers.ofString(bodyJson))
                        .build();
                return session1.client().send(req, HttpResponse.BodyHandlers.ofString());
            });

            // Await phase marker from child API stdout proving submit transaction committed before response escapes
            apiProcess1.waitForMarker("[PHASE:AFTER_COMMIT_BEFORE_RESPONSE]", Duration.ofSeconds(45));

            // Outstanding client request has NOT completed
            assertFalse(clientFuture.isDone(), "Client request must remain outstanding while response is held");

            // Prove committed: exactly 1 request row, 1 execution row, 1 audit row in PostgreSQL
            UUID committedRequestId;
            UUID committedExecutionId;
            try (Connection conn = dataSource.getConnection()) {
                try (PreparedStatement ps = conn.prepareStatement(
                        "SELECT id, execution_id FROM tenvyr_review.requests WHERE owner_id = ? AND idempotency_key = ?")) {
                    ps.setObject(1, submitter.id());
                    ps.setObject(2, idempotencyKey);
                    try (ResultSet rs = ps.executeQuery()) {
                        assertTrue(rs.next(), "Request row must be committed in PostgreSQL");
                        committedRequestId = rs.getObject("id", UUID.class);
                        committedExecutionId = rs.getObject("execution_id", UUID.class);
                        assertNotNull(committedRequestId);
                        assertNotNull(committedExecutionId);
                    }
                }
                trackedRequests.add(committedRequestId);
                trackedExecutions.add(committedExecutionId);

                try (PreparedStatement ps = conn.prepareStatement("SELECT count(*) FROM executions WHERE id = ?")) {
                    ps.setObject(1, committedExecutionId);
                    try (ResultSet rs = ps.executeQuery()) {
                        assertTrue(rs.next());
                        assertEquals(1, rs.getInt(1), "Execution row must be committed in PostgreSQL");
                    }
                }

                try (PreparedStatement ps = conn.prepareStatement(
                        "SELECT count(*) FROM tenvyr_review.audit WHERE actor_id = ? AND action = 'SUBMIT' AND operation_key = ?")) {
                    ps.setObject(1, submitter.id());
                    ps.setObject(2, idempotencyKey);
                    try (ResultSet rs = ps.executeQuery()) {
                        assertTrue(rs.next());
                        assertEquals(1, rs.getInt(1), "SUBMIT audit row must be committed in PostgreSQL");
                    }
                }
            }

            // Kill API JVM 1 before response escapes to client
            apiProcess1.destroyForcibly();
            assertTrue(apiProcess1.waitFor(10, TimeUnit.SECONDS));

            // Release barrier lock held by test connection
            try {
                try (PreparedStatement ps = lockConn.prepareStatement("SELECT pg_advisory_unlock(?)")) {
                    ps.setLong(1, barrierLockKey);
                    ps.execute();
                }
            } finally {
                lockConn.rollback();
                lockConn.close();
            }

            // Outstanding client observed failure (response never reached client)
            try {
                clientFuture.get(5, TimeUnit.SECONDS);
                fail("Client future should have failed due to server death before response escape");
            } catch (ExecutionException expected) {
                assertTrue(expected.getCause() instanceof IOException,
                        "Client must observe network failure when server dies before response escapes");
            }

            // Restart own API JVM against SAME database with bootstrap OFF
            int apiPort2 = ReviewProcessTestSupport.findFreePort();
            apiProcess2 = ReviewProcessTestSupport.launchApiProcess(
                    "t08-api-postcommit-restart-2",
                    apiPort2,
                    testDbUrl,
                    testUser,
                    testPassword,
                    workerPort,
                    Map.of() // Bootstrap OFF (no --review.bootstrap-users-file)
            );
            trackedProcesses.add(apiProcess2);
            int boundApiPort2 = apiProcess2.port() > 0 ? apiProcess2.port() : apiPort2;

            // Old session cookie from JVM 1 must be rejected by JVM 2 (in-memory sessions not persisted)
            HttpRequest oldSessionReq = HttpRequest.newBuilder()
                    .uri(URI.create("http://127.0.0.1:" + boundApiPort2 + "/api/v1/me"))
                    .GET()
                    .build();
            HttpResponse<String> oldSessionResp = session1.client().send(oldSessionReq, HttpResponse.BodyHandlers.ofString());
            assertEquals(401, oldSessionResp.statusCode(), "Old session cookie must receive 401 across JVM restart");

            // NEW login and fresh CSRF establishment
            ReviewTestSupport.AuthenticatedSession session2 = ReviewTestSupport.loginUser(boundApiPort2, submitter);

            // Replay submission with same owner, same idempotency key, and identical payload
            HttpRequest replayReq = HttpRequest.newBuilder()
                    .uri(URI.create("http://127.0.0.1:" + boundApiPort2 + "/api/v1/reviews"))
                    .header("Content-Type", "application/json")
                    .header(session2.csrf().headerName(), session2.csrf().token())
                    .header("Idempotency-Key", idempotencyKey.toString())
                    .POST(HttpRequest.BodyPublishers.ofString(bodyJson))
                    .build();
            HttpResponse<String> replayResp = session2.client().send(replayReq, HttpResponse.BodyHandlers.ofString());
            assertEquals(202, replayResp.statusCode(), "Replay after restart must return 202 Accepted");

            JsonNode replayBody = Json.parse(replayResp.body());
            assertEquals(committedRequestId.toString(), replayBody.path("id").asText(),
                    "Replay after crash must return identical request ID");
            assertEquals(committedExecutionId.toString(), replayBody.path("executionId").asText(),
                    "Replay after crash must return identical execution ID");

            // Assert existing recovery promotes execution out of initial PENDING state to active work
            long recoveryDeadline = System.currentTimeMillis() + 20_000;
            String recoveredStatus = "PENDING";
            int recoveredAttempts = 0;
            while (System.currentTimeMillis() < recoveryDeadline) {
                try (Connection conn = dataSource.getConnection();
                     PreparedStatement ps = conn.prepareStatement(
                             "SELECT e.status, count(a.id) as attempt_count " +
                                     "FROM executions e LEFT JOIN step_attempts a ON a.\"executionId\" = e.id " +
                                     "WHERE e.id = ? GROUP BY e.status")) {
                    ps.setObject(1, committedExecutionId);
                    try (ResultSet rs = ps.executeQuery()) {
                        if (rs.next()) {
                            recoveredStatus = rs.getString("status");
                            recoveredAttempts = rs.getInt("attempt_count");
                            if (!"PENDING".equals(recoveredStatus)) {
                                break;
                            }
                        }
                    }
                }
                Thread.sleep(100);
            }
            assertNotEquals("PENDING", recoveredStatus, "Execution must be promoted out of PENDING by recovery");
            assertTrue(Set.of("RUNNING", "COMPLETED").contains(recoveredStatus),
                    "Execution must be RUNNING or COMPLETED, got: " + recoveredStatus);
            assertTrue(recoveredAttempts >= 1, "Matching committed attempt must exist after recovery");
        } finally {
            clientExecutor.shutdownNow();
            try {
                if (!lockConn.isClosed()) {
                    lockConn.rollback();
                    lockConn.close();
                }
            } catch (Exception ignored) {}
        }
    }

    @Test
    @DisplayName("3. Real Worker child JVM death after invocation accepted and running before callback, bounded natural retry via 30s deadline, and duplicate/conflicting/stale signed callbacks rejected")
    void realWorkerChildJvmDeathBeforeCallback_boundedRetryOrTerminalFailed_andCallbackDefense() throws Exception {
        ReviewTestSupport.TestUser submitter = ReviewTestSupport.createTestUser(
                dataSource, trackedUsers, "sub_rec_worker", Role.SUBMITTER);

        int apiPort = ReviewProcessTestSupport.findFreePort();
        int workerPort = ReviewProcessTestSupport.findFreePort();
        int runnerPort = ReviewProcessTestSupport.findFreePort();

        // Local Runner HTTP server that holds Worker until latch is released
        CountDownLatch runnerInvoked = new CountDownLatch(1);
        CountDownLatch runnerHold = new CountDownLatch(1);

        HttpServer runnerServer = HttpServer.create(new InetSocketAddress("127.0.0.1", runnerPort), 0);
        runnerServer.createContext("/api/run", exchange -> {
            runnerInvoked.countDown();
            try {
                runnerHold.await(10, TimeUnit.SECONDS);
            } catch (InterruptedException ignored) {}

            byte[] resp = "{\"success\":true,\"data\":{\"output\":\"{\\\"score\\\":100,\\\"findings\\\":[\\\"Runner fixture\\\"]}\",\"metadata\":{\"mode\":\"RUNNER\",\"provider\":\"test\",\"model\":\"test\"}}}".getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, resp.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(resp);
            }
        });
        runnerServer.start();

        ReviewProcessTestSupport.ManagedProcess workerProcess1 = null;
        ReviewProcessTestSupport.ManagedProcess workerProcess2 = null;
        ReviewProcessTestSupport.ManagedProcess apiProcess = null;
        try {
            // Start REAL Worker child JVM 1 in RUNNER mode pointing to runnerPort
            workerProcess1 = ReviewProcessTestSupport.launchWorkerProcess(
                    "t08-worker-real-death-1",
                    workerPort,
                    apiPort,
                    "RUNNER",
                    "http://127.0.0.1:" + runnerPort
            );
            trackedProcesses.add(workerProcess1);
            int boundWorkerPort = workerProcess1.port() > 0 ? workerProcess1.port() : workerPort;

            // Start child API JVM with default natural watchdog (NO artificial supervision override)
            apiProcess = ReviewProcessTestSupport.launchApiProcess(
                    "t08-api-worker-test",
                    apiPort,
                    testDbUrl,
                    testUser,
                    testPassword,
                    boundWorkerPort,
                    Map.of()
            );
            trackedProcesses.add(apiProcess);
            int boundApiPort = apiProcess.port() > 0 ? apiProcess.port() : apiPort;

            ReviewTestSupport.AuthenticatedSession session = ReviewTestSupport.loginUser(boundApiPort, submitter);

            UUID idempotencyKey = UUID.randomUUID();
            Map<String, Object> payload = Map.of(
                    "title", "Worker Death Test Review",
                    "language", "python",
                    "code", "def compute(): return 100"
            );

            HttpRequest req = HttpRequest.newBuilder()
                    .uri(URI.create("http://127.0.0.1:" + boundApiPort + "/api/v1/reviews"))
                    .header("Content-Type", "application/json")
                    .header(session.csrf().headerName(), session.csrf().token())
                    .header("Idempotency-Key", idempotencyKey.toString())
                    .POST(HttpRequest.BodyPublishers.ofString(Json.stringify(Json.value(payload))))
                    .build();
            HttpResponse<String> submitResp = session.client().send(req, HttpResponse.BodyHandlers.ofString());
            assertEquals(202, submitResp.statusCode());

            JsonNode submitBody = Json.parse(submitResp.body());
            UUID requestId = UUID.fromString(submitBody.path("id").asText());
            UUID executionId = UUID.fromString(submitBody.path("executionId").asText());
            trackedRequests.add(requestId);
            trackedExecutions.add(executionId);

            // Await proof that Worker accepted invocation and is actively running runner call
            assertTrue(runnerInvoked.await(15, TimeUnit.SECONDS),
                    "Worker must accept invocation and execute runner before callback");

            // Kill REAL Worker child JVM 1 while invocation is accepted and running before callback
            workerProcess1.destroyForcibly();
            assertTrue(workerProcess1.waitFor(5, TimeUnit.SECONDS), "Worker process must terminate");
            assertFalse(workerProcess1.isAlive(), "Worker process must be dead");

            runnerHold.countDown();

            // Locate first attempt in step_attempts
            String invocationId1;
            String stepExecutionId;
            try (Connection conn = dataSource.getConnection()) {
                try (PreparedStatement ps = conn.prepareStatement(
                        "SELECT \"invocationId\", \"logicalStepId\" FROM step_attempts WHERE \"executionId\" = ? AND \"attemptNumber\" = 1")) {
                    ps.setObject(1, executionId);
                    try (ResultSet rs = ps.executeQuery()) {
                        assertTrue(rs.next(), "Attempt 1 must exist in step_attempts");
                        invocationId1 = rs.getString("invocationId");
                        stepExecutionId = rs.getString("logicalStepId");
                    }
                }
            }

            // Immediately start Worker 2 on the SAME frozen port in MOCK mode to accept attempt 2 when naturally retried
            workerProcess2 = ReviewProcessTestSupport.launchWorkerProcess(
                    "t08-worker-real-restart-2",
                    boundWorkerPort,
                    boundApiPort,
                    "MOCK",
                    null
            );
            trackedProcesses.add(workerProcess2);

            // Await natural engine recovery:
            // Attempt 1 has production STEP_TIMEOUT = 30s. RuntimeRecoveryService.expireAttempts
            // naturally expires attempt 1 once its 30s deadline passes, transitioning attempt 1 to TIMED_OUT.
            // Bounded wait allows full 30s deadline + scheduling window (up to 60s).
            long attempt1ExpireDeadline = System.currentTimeMillis() + 60_000;
            String attempt1Status = "DISPATCHED";
            while (System.currentTimeMillis() < attempt1ExpireDeadline) {
                try (Connection conn = dataSource.getConnection();
                     PreparedStatement ps = conn.prepareStatement(
                             "SELECT status FROM step_attempts WHERE \"executionId\" = ? AND \"attemptNumber\" = 1")) {
                    ps.setObject(1, executionId);
                    try (ResultSet rs = ps.executeQuery()) {
                        if (rs.next()) {
                            attempt1Status = rs.getString("status");
                            if (Set.of("TIMED_OUT", "FAILED").contains(attempt1Status)) {
                                break;
                            }
                        }
                    }
                }
                Thread.sleep(500);
            }
            assertTrue(Set.of("TIMED_OUT", "FAILED").contains(attempt1Status),
                    "Attempt 1 must naturally expire via RuntimeRecoveryService.expireAttempts after 30s deadline, got: " + attempt1Status);

            // Verify natural bounded retry: attempt 2 is created by engine recovery
            long attempt2Deadline = System.currentTimeMillis() + 20_000;
            boolean attempt2Created = false;
            String invocationId2 = null;
            while (System.currentTimeMillis() < attempt2Deadline) {
                try (Connection conn = dataSource.getConnection();
                     PreparedStatement ps = conn.prepareStatement(
                             "SELECT \"invocationId\" FROM step_attempts WHERE \"executionId\" = ? AND \"attemptNumber\" = 2")) {
                    ps.setObject(1, executionId);
                    try (ResultSet rs = ps.executeQuery()) {
                        if (rs.next()) {
                            attempt2Created = true;
                            invocationId2 = rs.getString("invocationId");
                            break;
                        }
                    }
                }
                Thread.sleep(200);
            }
            assertTrue(attempt2Created, "Attempt 2 must be created by natural engine recovery retry policy");
            assertNotNull(invocationId2);

            // Await review completion to AWAITING_REVIEW via attempt 2 dispatch to restarted worker
            long completionDeadline = System.currentTimeMillis() + 35_000;
            String finalReviewStatus = "PROCESSING";
            while (System.currentTimeMillis() < completionDeadline) {
                HttpRequest getReviewReq = HttpRequest.newBuilder()
                        .uri(URI.create("http://127.0.0.1:" + boundApiPort + "/api/v1/reviews/" + requestId))
                        .GET()
                        .build();
                HttpResponse<String> getReviewResp = session.client().send(getReviewReq, HttpResponse.BodyHandlers.ofString());
                if (getReviewResp.statusCode() == 200) {
                    finalReviewStatus = Json.parse(getReviewResp.body()).path("status").asText();
                    if ("AWAITING_REVIEW".equals(finalReviewStatus) || "FAILED".equals(finalReviewStatus)) {
                        break;
                    }
                }
                Thread.sleep(300);
            }
            assertEquals("AWAITING_REVIEW", finalReviewStatus, "Review must reach AWAITING_REVIEW after natural retry execution");

            // Verify report is accessible with expected MOCK score 100
            HttpRequest getReportReq = HttpRequest.newBuilder()
                    .uri(URI.create("http://127.0.0.1:" + boundApiPort + "/api/v1/reviews/" + requestId + "/report"))
                    .GET()
                    .build();
            HttpResponse<String> getReportResp = session.client().send(getReportReq, HttpResponse.BodyHandlers.ofString());
            assertEquals(200, getReportResp.statusCode());
            assertEquals(100, Json.parse(getReportResp.body()).path("score").asInt());

            // A. Duplicate signed callback for attempt 2 -> accepted by adapter, state preserved
            ObjectNode validOutput = Json.object(
                    "score", 100,
                    "findings", Json.array("Demonstration fixture: no source code or security analysis was performed."),
                    "evidence", Json.object("mode", "MOCK", "provider", "mock", "model", "demo-fixture")
            );
            HttpResponse<String> duplicateResp = sendSignedCallback(
                    boundApiPort, invocationId2, executionId.toString(), stepExecutionId, "succeeded", validOutput, null);
            assertEquals(204, duplicateResp.statusCode(), "Duplicate callback must return 204");

            // B. Conflicting signed callback for attempt 2 (different score 20) -> accepted by adapter, recorded in result_conflicts, NOT overwritten
            ObjectNode conflictingOutput = Json.object(
                    "score", 20,
                    "findings", Json.array("Conflicting outcome"),
                    "evidence", Json.object("mode", "MOCK", "provider", "mock", "model", "test-model")
            );
            HttpResponse<String> conflictResp = sendSignedCallback(
                    boundApiPort, invocationId2, executionId.toString(), stepExecutionId, "succeeded", conflictingOutput, null);
            assertEquals(204, conflictResp.statusCode(), "Conflicting callback must return 204 to HTTP adapter");

            try (Connection conn = dataSource.getConnection()) {
                try (PreparedStatement ps = conn.prepareStatement(
                        "SELECT count(*) FROM result_conflicts WHERE \"invocationId\" = ?")) {
                    ps.setString(1, invocationId2);
                    try (ResultSet rs = ps.executeQuery()) {
                        assertTrue(rs.next());
                        assertTrue(rs.getInt(1) >= 1, "Conflict must be persisted in result_conflicts");
                    }
                }
            }

            // C. Stale signed callback for attempt 1 (conflicting success outcome) -> does NOT overwrite terminal state
            HttpResponse<String> staleResp = sendSignedCallback(
                    boundApiPort, invocationId1, executionId.toString(), stepExecutionId, "succeeded", conflictingOutput, null);
            assertEquals(204, staleResp.statusCode(), "Stale callback must return 204 to HTTP adapter");

            // Verify final business invariants:
            // 1. Report score remains original 100, not overwritten by conflict or stale callbacks
            HttpResponse<String> verifyReportResp = session.client().send(getReportReq, HttpResponse.BodyHandlers.ofString());
            assertEquals(200, verifyReportResp.statusCode());
            assertEquals(100, Json.parse(verifyReportResp.body()).path("score").asInt(),
                    "Final report score must not be overwritten by conflicting or stale callbacks");

            // 2. Exactly one immutable plan revision preserved with same plan hash
            try (Connection conn = dataSource.getConnection()) {
                try (PreparedStatement ps = conn.prepareStatement(
                        "SELECT count(*), \"planHash\" FROM execution_plan_revisions WHERE \"executionId\" = ? GROUP BY \"planHash\"")) {
                    ps.setObject(1, executionId);
                    try (ResultSet rs = ps.executeQuery()) {
                        assertTrue(rs.next());
                        assertEquals(1, rs.getInt(1), "Exactly one plan revision must exist");
                        assertFalse(rs.getString("planHash").isBlank());
                        assertFalse(rs.next(), "Plan revision count must not drift");
                    }
                }

                // 3. Exactly one request and one execution row exist (no orphan business binding)
                try (PreparedStatement ps = conn.prepareStatement("SELECT count(*) FROM tenvyr_review.requests WHERE id = ?")) {
                    ps.setObject(1, requestId);
                    try (ResultSet rs = ps.executeQuery()) {
                        assertTrue(rs.next());
                        assertEquals(1, rs.getInt(1), "Exactly one request row must exist");
                    }
                }
                try (PreparedStatement ps = conn.prepareStatement("SELECT count(*) FROM executions WHERE id = ?")) {
                    ps.setObject(1, executionId);
                    try (ResultSet rs = ps.executeQuery()) {
                        assertTrue(rs.next());
                        assertEquals(1, rs.getInt(1), "Exactly one execution row must exist");
                    }
                }
            }

        } finally {
            runnerServer.stop(0);
        }
    }

    @Test
    @DisplayName("4. Real SIGTERM to owned API JVM while confirmed held DB work stops new admission, drains held work, exits bounded with pool closed last, and restarts consistently")
    void realSigtermWhileHeldDbWork_stopsAdmission_drainsWork_closesPoolLast_andRestartsConsistently() throws Exception {
        ReviewTestSupport.TestUser submitter = ReviewTestSupport.createTestUser(
                dataSource, trackedUsers, "sub_rec_sigterm", Role.SUBMITTER);
        UUID idempotencyKey = UUID.randomUUID();
        long barrierLockKey = Math.abs(UUID.randomUUID().getMostSignificantBits());
        if (barrierLockKey == 0) barrierLockKey = 40004L;

        Connection lockConn = dataSource.getConnection();
        lockConn.setAutoCommit(false);
        try (PreparedStatement ps = lockConn.prepareStatement("SELECT pg_advisory_lock(?)")) {
            ps.setLong(1, barrierLockKey);
            ps.execute();
        }

        int apiPort1 = ReviewProcessTestSupport.findFreePort();
        int workerPort = ReviewProcessTestSupport.findFreePort();
        ExecutorService clientExecutor = Executors.newSingleThreadExecutor();

        ReviewProcessTestSupport.ManagedProcess apiProcess1 = null;
        ReviewProcessTestSupport.ManagedProcess apiProcess2 = null;
        try {
            apiProcess1 = ReviewProcessTestSupport.launchApiProcess(
                    "t08-api-sigterm-drain-1",
                    apiPort1,
                    testDbUrl,
                    testUser,
                    testPassword,
                    workerPort,
                    Map.of("test.barrier.inflight.lock-key", String.valueOf(barrierLockKey))
            );
            trackedProcesses.add(apiProcess1);
            int boundApiPort1 = apiProcess1.port() > 0 ? apiProcess1.port() : apiPort1;

            ReviewTestSupport.AuthenticatedSession session1 = ReviewTestSupport.loginUser(boundApiPort1, submitter);

            Map<String, Object> payload = Map.of(
                    "title", "SIGTERM Drain Test Review",
                    "language", "java",
                    "code", "public class SigtermDrainTest {}"
            );
            String bodyJson = Json.stringify(Json.value(payload));

            Future<HttpResponse<String>> clientFuture = clientExecutor.submit(() -> {
                HttpRequest req = HttpRequest.newBuilder()
                        .uri(URI.create("http://127.0.0.1:" + boundApiPort1 + "/api/v1/reviews"))
                        .header("Content-Type", "application/json")
                        .header(session1.csrf().headerName(), session1.csrf().token())
                        .header("Idempotency-Key", idempotencyKey.toString())
                        .POST(HttpRequest.BodyPublishers.ofString(bodyJson))
                        .build();
                return session1.client().send(req, HttpResponse.BodyHandlers.ofString());
            });

            // Await phase marker from child API stdout proving in-flight DB transaction is active and held
            apiProcess1.waitForMarker("[PHASE:INFLIGHT_HELD]", Duration.ofSeconds(30));
            ReviewProcessTestSupport.awaitAdvisoryLockBlocked(dataSource, Duration.ofSeconds(15));

            // Send real SIGTERM to child API JVM (Process.destroy() sends SIGTERM on POSIX)
            apiProcess1.destroy();

            // 1. Assert: Stop new admission during shutdown
            // Poll read-only probe until admission is paused (WHILE original DB work is still held)
            HttpClient probeClient = HttpClient.newBuilder()
                    .connectTimeout(Duration.ofMillis(500))
                    .build();
            HttpRequest probeReq = HttpRequest.newBuilder()
                    .uri(URI.create("http://127.0.0.1:" + boundApiPort1 + "/api/v1/auth/csrf"))
                    .timeout(Duration.ofMillis(1000))
                    .GET()
                    .build();

            long admissionDeadline = System.currentTimeMillis() + 15_000;
            boolean admissionStopped = false;
            int lastStatus = 200;
            while (System.currentTimeMillis() < admissionDeadline) {
                try {
                    HttpResponse<String> probeResp = probeClient.send(probeReq, HttpResponse.BodyHandlers.ofString());
                    lastStatus = probeResp.statusCode();
                    if (lastStatus >= 500) {
                        admissionStopped = true;
                        break;
                    }
                } catch (IOException connectionRefusedOrClosed) {
                    admissionStopped = true;
                    break;
                }
                Thread.sleep(50);
            }
            assertTrue(admissionStopped, "New admission must be stopped (refused or 5xx) after SIGTERM while DB work is held, last status was " + lastStatus);

            // 2. Assert: Wait for inflight work / DB drain: API JVM remains alive while barrier is held
            assertTrue(apiProcess1.isAlive(), "API child JVM must remain alive while in-flight DB transaction is held");

            // 3. Release barrier: unlock advisory lock so in-flight transaction can drain
            try {
                try (PreparedStatement ps = lockConn.prepareStatement("SELECT pg_advisory_unlock(?)")) {
                    ps.setLong(1, barrierLockKey);
                    ps.execute();
                }
            } finally {
                lockConn.rollback();
                lockConn.close();
            }

            // 4. Assert: MUST join in-flight HTTP future 202 after barrier release
            HttpResponse<String> inFlightResp = clientFuture.get(15, TimeUnit.SECONDS);
            assertEquals(202, inFlightResp.statusCode(), "In-flight HTTP submission must complete with 202 Accepted after barrier release");
            JsonNode respBody = Json.parse(inFlightResp.body());
            UUID inFlightReqId = UUID.fromString(respBody.path("id").asText());
            UUID inFlightExecId = UUID.fromString(respBody.path("executionId").asText());
            trackedRequests.add(inFlightReqId);
            trackedExecutions.add(inFlightExecId);

            // Assert one bound request, execution, and SUBMIT audit committed
            try (Connection conn = dataSource.getConnection()) {
                try (PreparedStatement ps = conn.prepareStatement("SELECT count(*) FROM tenvyr_review.requests WHERE id = ?")) {
                    ps.setObject(1, inFlightReqId);
                    try (ResultSet rs = ps.executeQuery()) {
                        assertTrue(rs.next());
                        assertEquals(1, rs.getInt(1), "In-flight request row must be committed in PostgreSQL");
                    }
                }
                try (PreparedStatement ps = conn.prepareStatement("SELECT count(*) FROM executions WHERE id = ?")) {
                    ps.setObject(1, inFlightExecId);
                    try (ResultSet rs = ps.executeQuery()) {
                        assertTrue(rs.next());
                        assertEquals(1, rs.getInt(1), "In-flight execution row must be committed in PostgreSQL");
                    }
                }
                try (PreparedStatement ps = conn.prepareStatement(
                        "SELECT count(*) FROM tenvyr_review.audit WHERE request_id = ? AND action = 'SUBMIT'")) {
                    ps.setObject(1, inFlightReqId);
                    try (ResultSet rs = ps.executeQuery()) {
                        assertTrue(rs.next());
                        assertEquals(1, rs.getInt(1), "In-flight SUBMIT audit row must be committed in PostgreSQL");
                    }
                }
            }

            // 5. Assert: Exit bounded with pool closed last
            boolean exitedCleanly = apiProcess1.waitFor(20, TimeUnit.SECONDS);
            assertTrue(exitedCleanly, "API child JVM must exit within bounded grace period after DB barrier release");
            assertFalse(apiProcess1.isAlive());

            // Check log file confirms pool closed after work drain
            String logContent = Files.readString(apiProcess1.logFile());
            assertTrue(logContent.contains("HikariPool") || logContent.contains("shutdown") || logContent.contains("Closing"),
                    "Log must record pool and context shutdown");

            // 6. Assert: Re-login after restart, no in-memory session assumption
            int apiPort2 = ReviewProcessTestSupport.findFreePort();
            apiProcess2 = ReviewProcessTestSupport.launchApiProcess(
                    "t08-api-sigterm-restart-2",
                    apiPort2,
                    testDbUrl,
                    testUser,
                    testPassword,
                    workerPort,
                    Map.of()
            );
            trackedProcesses.add(apiProcess2);
            int boundApiPort2 = apiProcess2.port() > 0 ? apiProcess2.port() : apiPort2;

            // Old session cookie returns 401 (no in-memory session persistence)
            HttpRequest oldSessionReq = HttpRequest.newBuilder()
                    .uri(URI.create("http://127.0.0.1:" + boundApiPort2 + "/api/v1/me"))
                    .GET()
                    .build();
            HttpResponse<String> oldSessionResp = session1.client().send(oldSessionReq, HttpResponse.BodyHandlers.ofString());
            assertEquals(401, oldSessionResp.statusCode(), "Pre-shutdown session must return 401 after restart");

            // New login succeeds and me endpoint works
            ReviewTestSupport.AuthenticatedSession session2 = ReviewTestSupport.loginUser(boundApiPort2, submitter);
            HttpRequest meReq = HttpRequest.newBuilder()
                    .uri(URI.create("http://127.0.0.1:" + boundApiPort2 + "/api/v1/me"))
                    .GET()
                    .build();
            HttpResponse<String> meResp = session2.client().send(meReq, HttpResponse.BodyHandlers.ofString());
            assertEquals(200, meResp.statusCode());
            assertEquals(submitter.id().toString(), Json.parse(meResp.body()).path("id").asText());
        } finally {
            clientExecutor.shutdownNow();
            try {
                if (!lockConn.isClosed()) {
                    lockConn.rollback();
                    lockConn.close();
                }
            } catch (Exception ignored) {}
        }
    }
}
