package io.tenvyr.review;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.tenvyr.control.ControlPlaneRuntime;
import io.tenvyr.platform.Db;
import io.tenvyr.platform.Json;
import io.tenvyr.platform.Protocol;
import io.tenvyr.review.domain.ReviewTypes.Role;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.core.env.Environment;
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
import java.time.Instant;
import java.util.*;
import java.util.concurrent.*;

import static org.junit.jupiter.api.Assertions.*;

/**
 * T06 Integration Test: Review Cancellation and Race Conditions against Result Delivery.
 * Tests POST /api/v1/reviews/{id}/cancel via real HTTP against real PostgreSQL.
 *
 * Requirements per SPEC / T06 plan:
 * 1. Owner SUBMITTER can cancel while in PROCESSING state -> 200 OK with ReviewDetail (status CANCELLED).
 * 2. Equivalent cancel replay with same key returns 200 OK with stored outcome.
 * 3. Non-owner / wrong role denied:
 *    - Another submitter attempting cancel returns 404 Not Found (visibility takes precedence).
 *    - Reviewer role attempting cancel returns 403 Forbidden.
 *    - Non-existent UUID returns 404 Not Found.
 * 4. Completion vs Cancellation race:
 *    - Case A: Cancellation wins race -> execution becomes CANCELLED, CANCEL audit written. Late signed callback is rejected (cannot contradict terminal state).
 *    - Case B: Completion wins race -> execution is COMPLETED, cancel returns 409 Conflict, and NO CANCEL success audit is written.
 * 5. Uses PG barriers and real same-DB engine cancellation plus REAL signed callbacks through existing HTTP adapter, not fake status flips.
 * 6. Lock contention / timeout failure path: held lock triggers safe 503 DATABASE_UNAVAILABLE, releasing barriers/locks, proving app continues after failure.
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
public class ReviewCancelIT {

    @LocalServerPort
    private int port;

    @Autowired
    private DataSource dataSource;

    @Autowired
    private ControlPlaneRuntime engineRuntime;

    @Autowired
    private Environment environment;

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

    private String cancelUrl(UUID requestId) {
        return "http://127.0.0.1:" + port + "/api/v1/reviews/" + requestId + "/cancel";
    }

    private ReviewTestSupport.ReviewFixture createProcessingReview(ReviewTestSupport.TestUser submitter) throws Exception {
        try (Connection conn = dataSource.getConnection()) {
            conn.setAutoCommit(false);
            try {
                ReviewTestSupport.ReviewFixture fixture = ReviewTestSupport.createReviewFixture(
                        conn, engineRuntime, trackedRequests, trackedExecutions,
                        submitter.id(), "Cancellation Target Review", "java", "public class CancelTarget {}", Instant.now());
                conn.commit();
                return fixture;
            } catch (Exception e) {
                conn.rollback();
                throw e;
            }
        }
    }

    @Test
    @DisplayName("Owner SUBMITTER can cancel while in PROCESSING, and repeat same command replay returns 200")
    void ownerCanCancelWhileProcessing_repeatReplayReturns200() throws Exception {
        ReviewTestSupport.TestUser submitter = ReviewTestSupport.createTestUser(
                dataSource, trackedUsers, "can_owner", Role.SUBMITTER);
        ReviewTestSupport.AuthenticatedSession session = ReviewTestSupport.loginUser(port, submitter);

        ReviewTestSupport.ReviewFixture fixture = createProcessingReview(submitter);

        // Precondition verification: review is visible and in PROCESSING state
        HttpRequest getReq = HttpRequest.newBuilder()
                .uri(URI.create("http://127.0.0.1:" + port + "/api/v1/reviews/" + fixture.requestId()))
                .GET()
                .build();
        HttpResponse<String> getResp = session.client().send(getReq, HttpResponse.BodyHandlers.ofString());
        assertEquals(200, getResp.statusCode());
        assertEquals("PROCESSING", Json.parse(getResp.body()).path("status").asText());

        UUID cancelKey = UUID.randomUUID();

        // 1. First cancel call -> 200 OK, status CANCELLED
        HttpRequest cancelReq = HttpRequest.newBuilder()
                .uri(URI.create(cancelUrl(fixture.requestId())))
                .header(session.csrf().headerName(), session.csrf().token())
                .header("Idempotency-Key", cancelKey.toString())
                .POST(HttpRequest.BodyPublishers.noBody())
                .build();

        HttpResponse<String> cancelResp = session.client().send(cancelReq, HttpResponse.BodyHandlers.ofString());
        assertEquals(200, cancelResp.statusCode(), "Cancel must return 200 OK");

        JsonNode body = Json.parse(cancelResp.body());
        assertEquals("CANCELLED", body.path("status").asText(), "Status in response must be CANCELLED");
        assertEquals(fixture.requestId().toString(), body.path("id").asText());

        // Verify database: engine execution status is CANCELLED and exactly 1 CANCEL audit row exists
        ObjectNode engineExec = engineRuntime.executions().getExecution(fixture.executionId().toString());
        assertEquals("CANCELLED", engineExec.path("status").asText(), "Engine execution must be CANCELLED");

        try (Connection conn = dataSource.getConnection()) {
            try (PreparedStatement ps = conn.prepareStatement(
                    "SELECT count(*) FROM tenvyr_review.audit WHERE request_id = ? AND action = 'CANCEL'")) {
                ps.setObject(1, fixture.requestId());
                try (ResultSet rs = ps.executeQuery()) {
                    assertTrue(rs.next());
                    assertEquals(1, rs.getInt(1), "Exactly one CANCEL audit row must exist in DB");
                }
            }
        }

        // 2. Equivalent cancel replay with same key -> 200 OK
        HttpResponse<String> replayResp = session.client().send(cancelReq, HttpResponse.BodyHandlers.ofString());
        assertEquals(200, replayResp.statusCode(), "Equivalent cancel replay must return 200 OK");
        assertEquals("CANCELLED", Json.parse(replayResp.body()).path("status").asText());
    }

    @Test
    @DisplayName("Wrong owner receives 404, wrong role (REVIEWER) receives 403, non-existent UUID receives 404")
    void cancelAuthorization_wrongOwner404_reviewer403_nonExistent404() throws Exception {
        ReviewTestSupport.TestUser submitterA = ReviewTestSupport.createTestUser(
                dataSource, trackedUsers, "can_sub_a", Role.SUBMITTER);
        ReviewTestSupport.TestUser submitterB = ReviewTestSupport.createTestUser(
                dataSource, trackedUsers, "can_sub_b", Role.SUBMITTER);
        ReviewTestSupport.TestUser reviewer = ReviewTestSupport.createTestUser(
                dataSource, trackedUsers, "can_rev", Role.REVIEWER);

        ReviewTestSupport.AuthenticatedSession sessionA = ReviewTestSupport.loginUser(port, submitterA);
        ReviewTestSupport.AuthenticatedSession sessionB = ReviewTestSupport.loginUser(port, submitterB);
        ReviewTestSupport.AuthenticatedSession sessionRev = ReviewTestSupport.loginUser(port, reviewer);

        ReviewTestSupport.ReviewFixture fixtureA = createProcessingReview(submitterA);

        // Precondition: Submitter A can view own review
        HttpRequest getReq = HttpRequest.newBuilder()
                .uri(URI.create("http://127.0.0.1:" + port + "/api/v1/reviews/" + fixtureA.requestId()))
                .GET()
                .build();
        assertEquals(200, sessionA.client().send(getReq, HttpResponse.BodyHandlers.ofString()).statusCode());

        // 1. Submitter B attempts to cancel Submitter A's review -> 404 Not Found
        HttpRequest reqB = HttpRequest.newBuilder()
                .uri(URI.create(cancelUrl(fixtureA.requestId())))
                .header(sessionB.csrf().headerName(), sessionB.csrf().token())
                .header("Idempotency-Key", UUID.randomUUID().toString())
                .POST(HttpRequest.BodyPublishers.noBody())
                .build();
        HttpResponse<String> respB = sessionB.client().send(reqB, HttpResponse.BodyHandlers.ofString());
        ReviewTestSupport.assertSafeErrorJson(respB, 404, "NOT_FOUND");

        // 2. Reviewer attempts to cancel Submitter A's review -> 403 Forbidden
        HttpRequest reqRev = HttpRequest.newBuilder()
                .uri(URI.create(cancelUrl(fixtureA.requestId())))
                .header(sessionRev.csrf().headerName(), sessionRev.csrf().token())
                .header("Idempotency-Key", UUID.randomUUID().toString())
                .POST(HttpRequest.BodyPublishers.noBody())
                .build();
        HttpResponse<String> respRev = sessionRev.client().send(reqRev, HttpResponse.BodyHandlers.ofString());
        ReviewTestSupport.assertSafeErrorJson(respRev, 403, "FORBIDDEN");

        // 3. Non-existent UUID -> 404 Not Found
        HttpRequest reqMissing = HttpRequest.newBuilder()
                .uri(URI.create(cancelUrl(UUID.randomUUID())))
                .header(sessionA.csrf().headerName(), sessionA.csrf().token())
                .header("Idempotency-Key", UUID.randomUUID().toString())
                .POST(HttpRequest.BodyPublishers.noBody())
                .build();
        HttpResponse<String> respMissing = sessionA.client().send(reqMissing, HttpResponse.BodyHandlers.ofString());
        ReviewTestSupport.assertSafeErrorJson(respMissing, 404, "NOT_FOUND");
    }

    @Test
    @DisplayName("Race condition Case A: Cancellation wins race -> execution cancelled, audit recorded, late signed callback rejected")
    void cancellationWinsRace_lateSignedCallbackRejected() throws Exception {
        ReviewTestSupport.TestUser submitter = ReviewTestSupport.createTestUser(
                dataSource, trackedUsers, "can_race_a", Role.SUBMITTER);
        ReviewTestSupport.AuthenticatedSession session = ReviewTestSupport.loginUser(port, submitter);

        ReviewTestSupport.ReviewFixture fixture;
        ReviewTestSupport.StepAttemptFixture attemptFixture;
        try (Connection conn = dataSource.getConnection()) {
            conn.setAutoCommit(false);
            try {
                fixture = ReviewTestSupport.createReviewFixture(conn, engineRuntime, trackedRequests, trackedExecutions,
                        submitter.id(), "Race Review A", "java", "public class RaceA {}", Instant.now());
                attemptFixture = ReviewTestSupport.createStepAttemptFixture(conn, environment, fixture.executionId());
                conn.commit();
            } catch (Exception e) {
                conn.rollback();
                throw e;
            }
        }

        // Prove fixture attempt and correlation match before starting race
        Db db = Db.fromDataSource(dataSource);
        ObjectNode attemptRow = db.one("SELECT * FROM step_attempts WHERE id = ?", attemptFixture.stepAttemptId().toString());
        assertNotNull(attemptRow, "Attempt fixture row must exist in database");
        assertEquals(attemptFixture.invocationId(), attemptRow.path("invocationId").asText());
        assertEquals("CREATED", attemptRow.path("status").asText());

        ExecutorService executor = Executors.newFixedThreadPool(2);
        try (Connection lockConn = dataSource.getConnection()) {
            lockConn.setAutoCommit(false);
            int blockerPid;
            try (Statement s = lockConn.createStatement();
                 ResultSet rs = s.executeQuery("SELECT pg_backend_pid()")) {
                assertTrue(rs.next());
                blockerPid = rs.getInt(1);
            }

            // Acquire SHARE lock on tenvyr_review.audit table in lockConn.
            // When cancelExecution runs, it first locks request row and updates engine executions/steps/attempts.
            // Then it attempts to INSERT the CANCEL audit row into tenvyr_review.audit, which requires ROW EXCLUSIVE.
            // ROW EXCLUSIVE conflicts with SHARE lock, so cancel blocks on the audit insert AFTER engine cancel has already executed and taken all engine locks!
            try (Statement s = lockConn.createStatement()) {
                s.execute("LOCK TABLE tenvyr_review.audit IN SHARE MODE");
            }

            // Launch cancel in background thread
            UUID cancelKey = UUID.randomUUID();
            Future<HttpResponse<String>> cancelFuture = executor.submit(() -> {
                HttpRequest cancelReq = HttpRequest.newBuilder()
                        .uri(URI.create(cancelUrl(fixture.requestId())))
                        .header(session.csrf().headerName(), session.csrf().token())
                        .header("Idempotency-Key", cancelKey.toString())
                        .POST(HttpRequest.BodyPublishers.noBody())
                        .build();
                return session.client().send(cancelReq, HttpResponse.BodyHandlers.ofString());
            });

            // Wait until cancel is blocked behind blockerPid on tenvyr_review.audit
            int cancelPid = ReviewTestSupport.awaitPgBlockingPid(dataSource, blockerPid, 5000);

            // Now cancel holds the engine execution/attempt locks (as cancelExecutionWithManager already ran in cancel's TX).
            // Post signed callback in another background thread.
            ObjectNode reportOutput = Json.object(
                    "score", 90,
                    "findings", Json.array("late finding"),
                    "_tenvyr", Json.object(
                            "metadata", Json.object("mode", "MOCK", "provider", "test", "model", "test", "fallbackUsed", false, "usageSource", "test")
                    )
            );
            Future<HttpResponse<String>> callbackFuture = executor.submit(() ->
                    ReviewTestSupport.postSignedCallback(
                            port,
                            attemptFixture.invocationId(),
                            fixture.executionId().toString(),
                            attemptFixture.logicalStepId(),
                            reportOutput
                    )
            );

            // Wait until callback is blocked behind cancelPid (on step_attempts FOR UPDATE)
            ReviewTestSupport.awaitPgBlockingPid(dataSource, cancelPid, 5000);

            // Release the audit table SHARE lock so cancel can insert its audit row and commit 200 OK
            lockConn.rollback();

            // Cancel unblocks and returns 200 OK
            HttpResponse<String> cancelResp = cancelFuture.get(5, TimeUnit.SECONDS);
            assertEquals(200, cancelResp.statusCode(), "Cancel must succeed with 200 OK");
            assertEquals("CANCELLED", Json.parse(cancelResp.body()).path("status").asText());

            // Verify exactly 1 CANCEL audit row recorded
            try (Connection conn = dataSource.getConnection()) {
                try (PreparedStatement ps = conn.prepareStatement(
                        "SELECT count(*) FROM tenvyr_review.audit WHERE request_id = ? AND action = 'CANCEL'")) {
                    ps.setObject(1, fixture.requestId());
                    try (ResultSet rs = ps.executeQuery()) {
                        assertTrue(rs.next());
                        assertEquals(1, rs.getInt(1), "Exactly one CANCEL audit row must exist in DB");
                    }
                }
            }

            // Callback thread unblocks and completes.
            // Per SPEC / protocol, HttpAgentAdapter returns 204 No Content for valid signed HMAC delivery.
            HttpResponse<String> cbResp = callbackFuture.get(5, TimeUnit.SECONDS);
            assertEquals(204, cbResp.statusCode(), "Valid HMAC callback returns 204 No Content");

            // Bounded wait for ResultInboxService to mark result_inbox as REJECTED (because execution is CANCELLED)
            long deadline = System.currentTimeMillis() + 5000;
            ObjectNode inboxRow = null;
            while (System.currentTimeMillis() < deadline) {
                inboxRow = db.one("SELECT * FROM result_inbox WHERE \"invocationId\" = ?", attemptFixture.invocationId());
                if (inboxRow != null && "REJECTED".equals(inboxRow.path("status").asText())) {
                    break;
                }
                Thread.sleep(25);
            }
            assertNotNull(inboxRow, "result_inbox row must exist");
            assertEquals("REJECTED", inboxRow.path("status").asText(), "Result inbox status must be REJECTED, never APPLIED");

            // Assert execution status is CANCELLED and never flipped
            ObjectNode exec = engineRuntime.executions().getExecution(fixture.executionId().toString());
            assertEquals("CANCELLED", exec.path("status").asText(), "Engine state must remain CANCELLED");
        } finally {
            executor.shutdownNow();
            executor.awaitTermination(5, TimeUnit.SECONDS);
        }
    }

    @Test
    @DisplayName("Race condition Case B: Completion wins race -> execution COMPLETED, cancel returns 409, and no CANCEL audit is stored")
    void completionWinsRace_cancelReturns409AndNoCancelAudit() throws Exception {
        ReviewTestSupport.TestUser submitter = ReviewTestSupport.createTestUser(
                dataSource, trackedUsers, "can_race_b", Role.SUBMITTER);
        ReviewTestSupport.AuthenticatedSession session = ReviewTestSupport.loginUser(port, submitter);

        ReviewTestSupport.ReviewFixture fixture;
        ReviewTestSupport.StepAttemptFixture attemptFixture;
        try (Connection conn = dataSource.getConnection()) {
            conn.setAutoCommit(false);
            try {
                fixture = ReviewTestSupport.createReviewFixture(conn, engineRuntime, trackedRequests, trackedExecutions,
                        submitter.id(), "Race Review B", "java", "public class RaceB {}", Instant.now());
                attemptFixture = ReviewTestSupport.createStepAttemptFixture(conn, environment, fixture.executionId());
                conn.commit();
            } catch (Exception e) {
                conn.rollback();
                throw e;
            }
        }

        // Prove fixture attempt and correlation match
        Db db = Db.fromDataSource(dataSource);
        ObjectNode attemptRow = db.one("SELECT * FROM step_attempts WHERE id = ?", attemptFixture.stepAttemptId().toString());
        assertNotNull(attemptRow, "Attempt fixture row must exist in database");
        assertEquals(attemptFixture.invocationId(), attemptRow.path("invocationId").asText());

        ExecutorService executor = Executors.newFixedThreadPool(2);
        try (Connection lockConn = dataSource.getConnection()) {
            lockConn.setAutoCommit(false);
            int blockerPid;
            try (Statement s = lockConn.createStatement();
                 ResultSet rs = s.executeQuery("SELECT pg_backend_pid()")) {
                assertTrue(rs.next());
                blockerPid = rs.getInt(1);
            }

            // Lock the review request row: cancel acquires request row lock first.
            // ResultInboxService does NOT touch tenvyr_review.requests!
            // Therefore, callback can complete normally while cancel is blocked on tenvyr_review.requests row lock.
            try (PreparedStatement ps = lockConn.prepareStatement(
                    "SELECT id FROM tenvyr_review.requests WHERE id = ? FOR UPDATE")) {
                ps.setObject(1, fixture.requestId());
                try (ResultSet rs = ps.executeQuery()) {
                    assertTrue(rs.next(), "lockConn must lock the review request row");
                }
            }

            // Start cancel in background thread
            UUID cancelKey = UUID.randomUUID();
            Future<HttpResponse<String>> cancelFuture = executor.submit(() -> {
                HttpRequest cancelReq = HttpRequest.newBuilder()
                        .uri(URI.create(cancelUrl(fixture.requestId())))
                        .header(session.csrf().headerName(), session.csrf().token())
                        .header("Idempotency-Key", cancelKey.toString())
                        .POST(HttpRequest.BodyPublishers.noBody())
                        .build();
                return session.client().send(cancelReq, HttpResponse.BodyHandlers.ofString());
            });

            // Wait until cancel is blocked behind blockerPid
            ReviewTestSupport.awaitPgBlockingPid(dataSource, blockerPid, 5000);

            // While cancel is blocked, post signed callback to completion
            ObjectNode reportOutput = Json.object(
                    "score", 95,
                    "findings", Json.array("Complete finding"),
                    "_tenvyr", Json.object(
                            "metadata", Json.object("mode", "MOCK", "provider", "test", "model", "test", "fallbackUsed", false, "usageSource", "test")
                    )
            );
            HttpResponse<String> cbResp = ReviewTestSupport.postSignedCallback(
                    port,
                    attemptFixture.invocationId(),
                    fixture.executionId().toString(),
                    attemptFixture.logicalStepId(),
                    reportOutput
            );
            assertEquals(204, cbResp.statusCode());

            // Await durable execution completion
            long deadline = System.currentTimeMillis() + 5000;
            ObjectNode execRow = null;
            while (System.currentTimeMillis() < deadline) {
                execRow = engineRuntime.executions().getExecution(fixture.executionId().toString());
                if (execRow != null && "COMPLETED".equals(execRow.path("status").asText())) {
                    break;
                }
                Thread.sleep(25);
            }
            assertNotNull(execRow);
            assertEquals("COMPLETED", execRow.path("status").asText());

            // Now release the request row lock so cancel can proceed
            lockConn.rollback();

            // Cancel unblocks, detects that completion won, and returns 409 Conflict
            HttpResponse<String> cancelResp = cancelFuture.get(5, TimeUnit.SECONDS);
            ReviewTestSupport.assertSafeErrorJson(cancelResp, 409, null);

            // Crucial SPEC assertion: NO CANCEL success audit row must exist in DB
            try (Connection conn = dataSource.getConnection()) {
                try (PreparedStatement ps = conn.prepareStatement(
                        "SELECT count(*) FROM tenvyr_review.audit WHERE request_id = ? AND action = 'CANCEL'")) {
                    ps.setObject(1, fixture.requestId());
                    try (ResultSet rs = ps.executeQuery()) {
                        assertTrue(rs.next());
                        assertEquals(0, rs.getInt(1), "No CANCEL audit row must exist when completion won");
                    }
                }
            }
        } finally {
            executor.shutdownNow();
            executor.awaitTermination(5, TimeUnit.SECONDS);
        }
    }

    @Test
    @DisplayName("Replaying same Idempotency-Key on a different review request for cancel returns 409 Conflict")
    void sameCancelIdempotencyKeyOnDifferentRequest_returns409Conflict() throws Exception {
        ReviewTestSupport.TestUser submitter = ReviewTestSupport.createTestUser(
                dataSource, trackedUsers, "can_idemp_dif", Role.SUBMITTER);
        ReviewTestSupport.AuthenticatedSession session = ReviewTestSupport.loginUser(port, submitter);

        ReviewTestSupport.ReviewFixture fixture1 = createProcessingReview(submitter);
        ReviewTestSupport.ReviewFixture fixture2 = createProcessingReview(submitter);

        UUID sharedKey = UUID.randomUUID();

        // 1. Cancel request 1 -> 200 OK
        HttpRequest req1 = HttpRequest.newBuilder()
                .uri(URI.create(cancelUrl(fixture1.requestId())))
                .header(session.csrf().headerName(), session.csrf().token())
                .header("Idempotency-Key", sharedKey.toString())
                .POST(HttpRequest.BodyPublishers.noBody())
                .build();
        HttpResponse<String> resp1 = session.client().send(req1, HttpResponse.BodyHandlers.ofString());
        assertEquals(200, resp1.statusCode());

        // 2. Cancel request 2 with same key -> 409 Conflict
        HttpRequest req2 = HttpRequest.newBuilder()
                .uri(URI.create(cancelUrl(fixture2.requestId())))
                .header(session.csrf().headerName(), session.csrf().token())
                .header("Idempotency-Key", sharedKey.toString())
                .POST(HttpRequest.BodyPublishers.noBody())
                .build();
        HttpResponse<String> resp2 = session.client().send(req2, HttpResponse.BodyHandlers.ofString());
        ReviewTestSupport.assertSafeErrorJson(resp2, 409, "IDEMPOTENCY_CONFLICT");
    }

    @Test
    @DisplayName("Lock timeout on cancel returns safe 503 Retry-After and application continues normally afterward")
    void cancelLockTimeoutReturns503_andAppContinues() throws Exception {
        ReviewTestSupport.TestUser submitter = ReviewTestSupport.createTestUser(
                dataSource, trackedUsers, "can_lock_to", Role.SUBMITTER);
        ReviewTestSupport.AuthenticatedSession session = ReviewTestSupport.loginUser(port, submitter);

        ReviewTestSupport.ReviewFixture fixture = createProcessingReview(submitter);
        UUID cancelKey = UUID.randomUUID();

        // Compute 64-bit advisory lock key derived from (submitter.id(), "CANCEL", cancelKey)
        long lockKey = ReviewService.deriveAdvisoryLockKey(submitter.id(), "CANCEL", cancelKey);

        // Hold advisory lock in external connection
        try (Connection lockConn = dataSource.getConnection()) {
            lockConn.setAutoCommit(false);
            try (PreparedStatement ps = lockConn.prepareStatement("SELECT pg_advisory_xact_lock(?)")) {
                ps.setLong(1, lockKey);
                ps.execute();
            }

            HttpRequest cancelReq = HttpRequest.newBuilder()
                    .uri(URI.create(cancelUrl(fixture.requestId())))
                    .header(session.csrf().headerName(), session.csrf().token())
                    .header("Idempotency-Key", cancelKey.toString())
                    .POST(HttpRequest.BodyPublishers.noBody())
                    .build();

            HttpResponse<String> resp = session.client().send(cancelReq, HttpResponse.BodyHandlers.ofString());
            assertEquals(503, resp.statusCode());
            assertEquals("1", resp.headers().firstValue("Retry-After").orElse(""));
            ReviewTestSupport.assertSafeErrorJson(resp, 503, "DATABASE_UNAVAILABLE");

            lockConn.rollback();
        }

        // Prove app continues normally: review can be queried and remains PROCESSING
        HttpRequest getReq = HttpRequest.newBuilder()
                .uri(URI.create("http://127.0.0.1:" + port + "/api/v1/reviews/" + fixture.requestId()))
                .GET()
                .build();
        HttpResponse<String> getResp = session.client().send(getReq, HttpResponse.BodyHandlers.ofString());
        assertEquals(200, getResp.statusCode());
        assertEquals("PROCESSING", Json.parse(getResp.body()).path("status").asText());
    }
}
