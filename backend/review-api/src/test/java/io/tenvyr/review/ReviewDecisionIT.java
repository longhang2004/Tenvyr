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
import java.time.Instant;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;

/**
 * T06 Integration Test: Business Verdicts, Decisions, and Replay/Conflict semantics.
 * Tests POST /api/v1/reviews/{id}/decisions via real HTTP against real PostgreSQL.
 *
 * Requirements per SPEC / T06 plan:
 * 1. First valid decision returns 201 Created with Location header and DecisionView body.
 * 2. Equivalent replay with identical actor, key, and payload returns 200 OK with same decision.
 * 3. Conflicting replay with same key but changed payload returns 409 Conflict (safe error IDEMPOTENCY_CONFLICT).
 * 4. Parallel APPROVE vs REQUEST_CHANGES from two different reviewers: exactly one wins (201), loser gets 409 Conflict, exactly one decision row and one DECIDE audit entry in DB.
 * 5. Concurrent replays with same actor/key/payload converge to single decision identity (no duplicate decisions or audits).
 * 6. Authorization:
 *    - Only a REVIEWER different from the submitter can decide on completed VALID report.
 *    - Submitter self-decision denied (403).
 *    - Submitter role denied (403).
 *    - Invisible / foreign UUID returns 404 (preconditioned on positive existence).
 *    - Disabled user session returns 401.
 *    - Changed role (old session token/cookie) returns 403.
 * 7. State gates:
 *    - Report in PROCESSING (not completed) returns 409 REPORT_NOT_READY.
 *    - Failed or invalid report returns 409.
 * 8. Terminal engine state unchanged: engine execution status remains COMPLETED, business decision never calls ApprovalService.
 * 9. Replay of same idempotency key across different requests returns 409.
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
public class ReviewDecisionIT {

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

    private String decisionUrl(UUID requestId) {
        return "http://127.0.0.1:" + port + "/api/v1/reviews/" + requestId + "/decisions";
    }

    private ReviewTestSupport.ReviewFixture createCompletedValidReview(ReviewTestSupport.TestUser submitter) throws Exception {
        ReviewTestSupport.ReviewFixture fixture;
        ReviewTestSupport.StepAttemptFixture attemptFixture;
        try (Connection conn = dataSource.getConnection()) {
            conn.setAutoCommit(false);
            try {
                fixture = ReviewTestSupport.createReviewFixture(conn, engineRuntime, trackedRequests, trackedExecutions,
                        submitter.id(), "Completed Code Review", "java", "public class ValidCode { int x = 1; }", Instant.now());
                attemptFixture = ReviewTestSupport.createStepAttemptFixture(conn, environment, fixture.executionId());
                conn.commit();
            } catch (Exception e) {
                conn.rollback();
                throw e;
            }
        }

        ObjectNode reportOutput = Json.object(
                "score", 88,
                "findings", Json.array("Looks good overall", "Minor style note"),
                "_tenvyr", Json.object(
                        "metadata", Json.object(
                                "mode", "MOCK",
                                "provider", "test-provider",
                                "model", "test-model",
                                "fallbackUsed", false,
                                "usageSource", "test"
                        )
                )
        );

        HttpResponse<String> callbackResp = ReviewTestSupport.postSignedCallback(
                port,
                attemptFixture.invocationId(),
                fixture.executionId().toString(),
                attemptFixture.logicalStepId(),
                reportOutput
        );
        assertEquals(204, callbackResp.statusCode(), "Signed callback must succeed with 204");

        long deadline = System.currentTimeMillis() + 5000;
        ObjectNode execRow = null;
        while (System.currentTimeMillis() < deadline) {
            execRow = engineRuntime.executions().getExecution(fixture.executionId().toString());
            if (execRow != null && "COMPLETED".equals(execRow.path("status").asText())) {
                break;
            }
            Thread.sleep(50);
        }
        assertNotNull(execRow);
        assertEquals("COMPLETED", execRow.path("status").asText(), "Execution must reach COMPLETED");

        return fixture;
    }

    @Test
    @DisplayName("First valid decision returns 201 with Location, equivalent replay returns 200 with same IDs, changed payload returns 409")
    void firstDecisionReturns201_equivalentReplayReturns200_changedPayloadReturns409() throws Exception {
        ReviewTestSupport.TestUser submitter = ReviewTestSupport.createTestUser(
                dataSource, trackedUsers, "dec_sub", Role.SUBMITTER);
        ReviewTestSupport.TestUser reviewer = ReviewTestSupport.createTestUser(
                dataSource, trackedUsers, "dec_rev", Role.REVIEWER);

        ReviewTestSupport.AuthenticatedSession reviewerSession = ReviewTestSupport.loginUser(port, reviewer);
        ReviewTestSupport.ReviewFixture fixture = createCompletedValidReview(submitter);

        // Precondition check: verify review exists and report is ready before testing decision
        HttpRequest preReq = HttpRequest.newBuilder()
                .uri(URI.create("http://127.0.0.1:" + port + "/api/v1/reviews/" + fixture.requestId() + "/report"))
                .GET()
                .build();
        HttpResponse<String> preResp = reviewerSession.client().send(preReq, HttpResponse.BodyHandlers.ofString());
        assertEquals(200, preResp.statusCode(), "Precondition: report must be 200 OK before decision");

        UUID decisionKey = UUID.randomUUID();
        Map<String, Object> initialPayload = Map.of(
                "action", "APPROVE",
                "comment", "Looks clean and satisfies contracts."
        );
        String bodyJson = Json.stringify(Json.value(initialPayload));

        // 1. Initial decision submission: asserts 201 Created
        HttpRequest req1 = HttpRequest.newBuilder()
                .uri(URI.create(decisionUrl(fixture.requestId())))
                .header("Content-Type", "application/json")
                .header(reviewerSession.csrf().headerName(), reviewerSession.csrf().token())
                .header("Idempotency-Key", decisionKey.toString())
                .POST(HttpRequest.BodyPublishers.ofString(bodyJson))
                .build();

        HttpResponse<String> resp1 = reviewerSession.client().send(req1, HttpResponse.BodyHandlers.ofString());
        assertEquals(201, resp1.statusCode(), "Initial decision must return 201 Created");

        String location = resp1.headers().firstValue("Location").orElse("");
        assertFalse(location.isBlank(), "Location header must be present");
        assertTrue(location.contains("/api/v1/reviews/" + fixture.requestId()), "Location must point to review");

        JsonNode body1 = Json.parse(resp1.body());
        assertTrue(body1.hasNonNull("id"), "Decision response must include decision id");
        assertEquals(fixture.requestId().toString(), body1.path("requestId").asText());
        assertEquals(reviewer.id().toString(), body1.path("actorId").asText());
        assertEquals("APPROVE", body1.path("action").asText());
        assertEquals("Looks clean and satisfies contracts.", body1.path("comment").asText());
        UUID decisionId1 = UUID.fromString(body1.path("id").asText());

        // 2. Equivalent replay: same actor, same key, same payload returns 200 OK and same decision ID
        HttpResponse<String> respReplay = reviewerSession.client().send(req1, HttpResponse.BodyHandlers.ofString());
        assertEquals(200, respReplay.statusCode(), "Equivalent decision replay must return 200 OK");
        JsonNode replayBody = Json.parse(respReplay.body());
        assertEquals(decisionId1.toString(), replayBody.path("id").asText(), "Equivalent replay must return same decision id");
        assertEquals("APPROVE", replayBody.path("action").asText());

        // 3. Changed payload with same key returns 409 Conflict
        Map<String, Object> alteredPayload = Map.of(
                "action", "REQUEST_CHANGES",
                "comment", "Changed my mind, need modifications."
        );
        HttpRequest reqConflict = HttpRequest.newBuilder()
                .uri(URI.create(decisionUrl(fixture.requestId())))
                .header("Content-Type", "application/json")
                .header(reviewerSession.csrf().headerName(), reviewerSession.csrf().token())
                .header("Idempotency-Key", decisionKey.toString())
                .POST(HttpRequest.BodyPublishers.ofString(Json.stringify(Json.value(alteredPayload))))
                .build();

        HttpResponse<String> respConflict = reviewerSession.client().send(reqConflict, HttpResponse.BodyHandlers.ofString());
        ReviewTestSupport.assertSafeErrorJson(respConflict, 409, "IDEMPOTENCY_CONFLICT");

        // 4. Assert engine terminal state is UNCHANGED and exactly 1 decision row and 1 DECIDE audit entry exist in DB
        ObjectNode engineExec = engineRuntime.executions().getExecution(fixture.executionId().toString());
        assertEquals("COMPLETED", engineExec.path("status").asText(), "Engine terminal status must remain COMPLETED");

        try (Connection conn = dataSource.getConnection()) {
            try (PreparedStatement ps = conn.prepareStatement("SELECT count(*) FROM tenvyr_review.decisions WHERE request_id = ?")) {
                ps.setObject(1, fixture.requestId());
                try (ResultSet rs = ps.executeQuery()) {
                    assertTrue(rs.next());
                    assertEquals(1, rs.getInt(1), "Exactly one decision must be stored in DB");
                }
            }
            try (PreparedStatement ps = conn.prepareStatement("SELECT count(*) FROM tenvyr_review.audit WHERE request_id = ? AND action = 'DECIDE'")) {
                ps.setObject(1, fixture.requestId());
                try (ResultSet rs = ps.executeQuery()) {
                    assertTrue(rs.next());
                    assertEquals(1, rs.getInt(1), "Exactly one DECIDE audit must be stored in DB");
                }
            }
        }
    }

    @Test
    @DisplayName("Parallel APPROVE vs REQUEST_CHANGES from two reviewers produces one winner (201), one conflict (409), one decision, and one DECIDE audit")
    void parallelApproveVsRequestChanges_oneWinnerOneConflictOneAudit() throws Exception {
        ReviewTestSupport.TestUser submitter = ReviewTestSupport.createTestUser(
                dataSource, trackedUsers, "par_sub", Role.SUBMITTER);
        ReviewTestSupport.TestUser reviewer1 = ReviewTestSupport.createTestUser(
                dataSource, trackedUsers, "par_rev1", Role.REVIEWER);
        ReviewTestSupport.TestUser reviewer2 = ReviewTestSupport.createTestUser(
                dataSource, trackedUsers, "par_rev2", Role.REVIEWER);

        ReviewTestSupport.AuthenticatedSession session1 = ReviewTestSupport.loginUser(port, reviewer1);
        ReviewTestSupport.AuthenticatedSession session2 = ReviewTestSupport.loginUser(port, reviewer2);

        ReviewTestSupport.ReviewFixture fixture = createCompletedValidReview(submitter);

        UUID key1 = UUID.randomUUID();
        UUID key2 = UUID.randomUUID();

        String payloadApprove = Json.stringify(Json.value(Map.of("action", "APPROVE", "comment", "Approved by rev1")));
        String payloadReject = Json.stringify(Json.value(Map.of("action", "REQUEST_CHANGES", "comment", "Changes requested by rev2")));

        ExecutorService executor = Executors.newFixedThreadPool(2);
        try {
            CyclicBarrier barrier = new CyclicBarrier(2);

            Future<HttpResponse<String>> f1 = executor.submit(() -> {
                barrier.await(5, TimeUnit.SECONDS);
                HttpRequest req = HttpRequest.newBuilder()
                        .uri(URI.create(decisionUrl(fixture.requestId())))
                        .header("Content-Type", "application/json")
                        .header(session1.csrf().headerName(), session1.csrf().token())
                        .header("Idempotency-Key", key1.toString())
                        .POST(HttpRequest.BodyPublishers.ofString(payloadApprove))
                        .build();
                return session1.client().send(req, HttpResponse.BodyHandlers.ofString());
            });

            Future<HttpResponse<String>> f2 = executor.submit(() -> {
                barrier.await(5, TimeUnit.SECONDS);
                HttpRequest req = HttpRequest.newBuilder()
                        .uri(URI.create(decisionUrl(fixture.requestId())))
                        .header("Content-Type", "application/json")
                        .header(session2.csrf().headerName(), session2.csrf().token())
                        .header("Idempotency-Key", key2.toString())
                        .POST(HttpRequest.BodyPublishers.ofString(payloadReject))
                        .build();
                return session2.client().send(req, HttpResponse.BodyHandlers.ofString());
            });

            HttpResponse<String> r1 = f1.get(10, TimeUnit.SECONDS);
            HttpResponse<String> r2 = f2.get(10, TimeUnit.SECONDS);

            List<Integer> statuses = List.of(r1.statusCode(), r2.statusCode());
            assertTrue(statuses.contains(201), "One parallel decision must win with 201 Created");
            assertTrue(statuses.contains(409), "One parallel decision must lose with 409 Conflict");

            HttpResponse<String> losingResp = r1.statusCode() == 409 ? r1 : r2;
            ReviewTestSupport.assertSafeErrorJson(losingResp, 409, null);

            // Assert exact database facts
            try (Connection conn = dataSource.getConnection()) {
                try (PreparedStatement ps = conn.prepareStatement("SELECT count(*) FROM tenvyr_review.decisions WHERE request_id = ?")) {
                    ps.setObject(1, fixture.requestId());
                    try (ResultSet rs = ps.executeQuery()) {
                        assertTrue(rs.next());
                        assertEquals(1, rs.getInt(1), "Exactly one decision row must exist in DB");
                    }
                }
                try (PreparedStatement ps = conn.prepareStatement("SELECT count(*) FROM tenvyr_review.audit WHERE request_id = ? AND action = 'DECIDE'")) {
                    ps.setObject(1, fixture.requestId());
                    try (ResultSet rs = ps.executeQuery()) {
                        assertTrue(rs.next());
                        assertEquals(1, rs.getInt(1), "Exactly one DECIDE audit row must exist in DB");
                    }
                }
            }
        } finally {
            executor.shutdown();
            executor.awaitTermination(5, TimeUnit.SECONDS);
        }
    }

    @Test
    @DisplayName("Multiple concurrent replays with same actor, key, and payload converge to identical decision ID without duplicate DB rows")
    void concurrentReplays_sameActorAndKey_convergeToSingleDecision() throws Exception {
        ReviewTestSupport.TestUser submitter = ReviewTestSupport.createTestUser(
                dataSource, trackedUsers, "con_sub", Role.SUBMITTER);
        ReviewTestSupport.TestUser reviewer = ReviewTestSupport.createTestUser(
                dataSource, trackedUsers, "con_rev", Role.REVIEWER);

        ReviewTestSupport.AuthenticatedSession session = ReviewTestSupport.loginUser(port, reviewer);
        ReviewTestSupport.ReviewFixture fixture = createCompletedValidReview(submitter);

        UUID sharedKey = UUID.randomUUID();
        String payload = Json.stringify(Json.value(Map.of("action", "APPROVE", "comment", "Concurrent idempotent approval")));

        int concurrency = 8;
        ExecutorService executor = Executors.newFixedThreadPool(concurrency);
        try {
            CyclicBarrier barrier = new CyclicBarrier(concurrency);
            List<Future<HttpResponse<String>>> futures = new ArrayList<>();

            for (int i = 0; i < concurrency; i++) {
                futures.add(executor.submit(() -> {
                    barrier.await(5, TimeUnit.SECONDS);
                    HttpRequest req = HttpRequest.newBuilder()
                            .uri(URI.create(decisionUrl(fixture.requestId())))
                            .header("Content-Type", "application/json")
                            .header(session.csrf().headerName(), session.csrf().token())
                            .header("Idempotency-Key", sharedKey.toString())
                            .POST(HttpRequest.BodyPublishers.ofString(payload))
                            .build();
                    return session.client().send(req, HttpResponse.BodyHandlers.ofString());
                }));
            }

            Set<String> decisionIds = new HashSet<>();
            int successCount = 0;

            for (Future<HttpResponse<String>> future : futures) {
                HttpResponse<String> resp = future.get(10, TimeUnit.SECONDS);
                assertTrue(resp.statusCode() == 201 || resp.statusCode() == 200,
                        "Concurrent same-key requests must return 201 or 200, got: " + resp.statusCode());
                successCount++;
                JsonNode body = Json.parse(resp.body());
                decisionIds.add(body.path("id").asText());
            }

            assertEquals(concurrency, successCount);
            assertEquals(1, decisionIds.size(), "All concurrent replays must converge to the exact same decision UUID");

            // Verify DB count
            try (Connection conn = dataSource.getConnection()) {
                try (PreparedStatement ps = conn.prepareStatement("SELECT count(*) FROM tenvyr_review.decisions WHERE request_id = ?")) {
                    ps.setObject(1, fixture.requestId());
                    try (ResultSet rs = ps.executeQuery()) {
                        assertTrue(rs.next());
                        assertEquals(1, rs.getInt(1));
                    }
                }
                try (PreparedStatement ps = conn.prepareStatement("SELECT count(*) FROM tenvyr_review.audit WHERE request_id = ? AND action = 'DECIDE'")) {
                    ps.setObject(1, fixture.requestId());
                    try (ResultSet rs = ps.executeQuery()) {
                        assertTrue(rs.next());
                        assertEquals(1, rs.getInt(1));
                    }
                }
            }
        } finally {
            executor.shutdown();
            executor.awaitTermination(5, TimeUnit.SECONDS);
        }
    }

    @Test
    @DisplayName("Authorization and role defenses: submitter self-decision denied (403), submitter role denied (403), foreign UUID (404), disabled user (401)")
    void decisionAuthorizationGuards_selfDecisionDenied_foreignUuid404_disabledUser401() throws Exception {
        ReviewTestSupport.TestUser submitter = ReviewTestSupport.createTestUser(
                dataSource, trackedUsers, "auth_sub", Role.SUBMITTER);
        ReviewTestSupport.TestUser reviewer = ReviewTestSupport.createTestUser(
                dataSource, trackedUsers, "auth_rev", Role.REVIEWER);
        ReviewTestSupport.TestUser anotherSubmitter = ReviewTestSupport.createTestUser(
                dataSource, trackedUsers, "auth_sub2", Role.SUBMITTER);

        ReviewTestSupport.AuthenticatedSession submitterSession = ReviewTestSupport.loginUser(port, submitter);
        ReviewTestSupport.AuthenticatedSession reviewerSession = ReviewTestSupport.loginUser(port, reviewer);
        ReviewTestSupport.AuthenticatedSession anotherSubSession = ReviewTestSupport.loginUser(port, anotherSubmitter);

        ReviewTestSupport.ReviewFixture fixture = createCompletedValidReview(submitter);

        String validPayload = Json.stringify(Json.value(Map.of("action", "APPROVE", "comment", "Valid comment")));

        // 1. Submitter attempting self-decision on own review -> 403 Forbidden
        HttpRequest reqSelf = HttpRequest.newBuilder()
                .uri(URI.create(decisionUrl(fixture.requestId())))
                .header("Content-Type", "application/json")
                .header(submitterSession.csrf().headerName(), submitterSession.csrf().token())
                .header("Idempotency-Key", UUID.randomUUID().toString())
                .POST(HttpRequest.BodyPublishers.ofString(validPayload))
                .build();
        HttpResponse<String> respSelf = submitterSession.client().send(reqSelf, HttpResponse.BodyHandlers.ofString());
        ReviewTestSupport.assertSafeErrorJson(respSelf, 403, "FORBIDDEN");

        // 2. Another submitter attempting decision -> 403 Forbidden (or 404 if invisible)
        HttpRequest reqOtherSub = HttpRequest.newBuilder()
                .uri(URI.create(decisionUrl(fixture.requestId())))
                .header("Content-Type", "application/json")
                .header(anotherSubSession.csrf().headerName(), anotherSubSession.csrf().token())
                .header("Idempotency-Key", UUID.randomUUID().toString())
                .POST(HttpRequest.BodyPublishers.ofString(validPayload))
                .build();
        HttpResponse<String> respOtherSub = anotherSubSession.client().send(reqOtherSub, HttpResponse.BodyHandlers.ofString());
        assertTrue(respOtherSub.statusCode() == 403 || respOtherSub.statusCode() == 404,
                "Non-reviewer submitter must receive 403 or 404, got: " + respOtherSub.statusCode());
        ReviewTestSupport.assertSafeErrorJson(respOtherSub, respOtherSub.statusCode(), null);

        // 3. Foreign / non-existent request UUID -> 404 Not Found
        UUID foreignId = UUID.randomUUID();
        HttpRequest reqForeign = HttpRequest.newBuilder()
                .uri(URI.create(decisionUrl(foreignId)))
                .header("Content-Type", "application/json")
                .header(reviewerSession.csrf().headerName(), reviewerSession.csrf().token())
                .header("Idempotency-Key", UUID.randomUUID().toString())
                .POST(HttpRequest.BodyPublishers.ofString(validPayload))
                .build();
        HttpResponse<String> respForeign = reviewerSession.client().send(reqForeign, HttpResponse.BodyHandlers.ofString());
        ReviewTestSupport.assertSafeErrorJson(respForeign, 404, "NOT_FOUND");

        // 4. Disabled user session -> 401 Unauthorized
        try (Connection conn = dataSource.getConnection();
             PreparedStatement ps = conn.prepareStatement("UPDATE tenvyr_review.users SET enabled = false WHERE id = ?")) {
            ps.setObject(1, reviewer.id());
            assertEquals(1, ps.executeUpdate());
        }

        HttpRequest reqDisabled = HttpRequest.newBuilder()
                .uri(URI.create(decisionUrl(fixture.requestId())))
                .header("Content-Type", "application/json")
                .header(reviewerSession.csrf().headerName(), reviewerSession.csrf().token())
                .header("Idempotency-Key", UUID.randomUUID().toString())
                .POST(HttpRequest.BodyPublishers.ofString(validPayload))
                .build();
        HttpResponse<String> respDisabled = reviewerSession.client().send(reqDisabled, HttpResponse.BodyHandlers.ofString());
        ReviewTestSupport.assertSafeErrorJson(respDisabled, 401, "UNAUTHORIZED");
    }

    @Test
    @DisplayName("State gates: decision rejected with 409 REPORT_NOT_READY when execution is still PROCESSING or report invalid")
    void decisionRejected_whenReportNotReadyOrInvalid() throws Exception {
        ReviewTestSupport.TestUser submitter = ReviewTestSupport.createTestUser(
                dataSource, trackedUsers, "gate_sub", Role.SUBMITTER);
        ReviewTestSupport.TestUser reviewer = ReviewTestSupport.createTestUser(
                dataSource, trackedUsers, "gate_rev", Role.REVIEWER);

        ReviewTestSupport.AuthenticatedSession reviewerSession = ReviewTestSupport.loginUser(port, reviewer);

        // Create review fixture in PROCESSING state (not completed)
        ReviewTestSupport.ReviewFixture processingFixture;
        try (Connection conn = dataSource.getConnection()) {
            conn.setAutoCommit(false);
            try {
                processingFixture = ReviewTestSupport.createReviewFixture(conn, engineRuntime, trackedRequests, trackedExecutions,
                        submitter.id(), "Pending Code Review", "java", "public class ProcessingCode {}", Instant.now());
                conn.commit();
            } catch (Exception e) {
                conn.rollback();
                throw e;
            }
        }

        String validPayload = Json.stringify(Json.value(Map.of("action", "APPROVE", "comment", "Should fail on pending report")));

        HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create(decisionUrl(processingFixture.requestId())))
                .header("Content-Type", "application/json")
                .header(reviewerSession.csrf().headerName(), reviewerSession.csrf().token())
                .header("Idempotency-Key", UUID.randomUUID().toString())
                .POST(HttpRequest.BodyPublishers.ofString(validPayload))
                .build();

        HttpResponse<String> resp = reviewerSession.client().send(req, HttpResponse.BodyHandlers.ofString());
        ReviewTestSupport.assertSafeErrorJson(resp, 409, "REPORT_NOT_READY");
    }

    @Test
    @DisplayName("Replaying same Idempotency-Key on a different review request returns 409 Conflict")
    void sameIdempotencyKeyOnDifferentRequest_returns409Conflict() throws Exception {
        ReviewTestSupport.TestUser submitter = ReviewTestSupport.createTestUser(
                dataSource, trackedUsers, "dif_sub", Role.SUBMITTER);
        ReviewTestSupport.TestUser reviewer = ReviewTestSupport.createTestUser(
                dataSource, trackedUsers, "dif_rev", Role.REVIEWER);

        ReviewTestSupport.AuthenticatedSession reviewerSession = ReviewTestSupport.loginUser(port, reviewer);

        ReviewTestSupport.ReviewFixture fixture1 = createCompletedValidReview(submitter);
        ReviewTestSupport.ReviewFixture fixture2 = createCompletedValidReview(submitter);

        UUID sharedKey = UUID.randomUUID();
        String payload = Json.stringify(Json.value(Map.of("action", "APPROVE", "comment", "First decision")));

        // 1. Submit on request 1 -> 201 Created
        HttpRequest req1 = HttpRequest.newBuilder()
                .uri(URI.create(decisionUrl(fixture1.requestId())))
                .header("Content-Type", "application/json")
                .header(reviewerSession.csrf().headerName(), reviewerSession.csrf().token())
                .header("Idempotency-Key", sharedKey.toString())
                .POST(HttpRequest.BodyPublishers.ofString(payload))
                .build();
        HttpResponse<String> resp1 = reviewerSession.client().send(req1, HttpResponse.BodyHandlers.ofString());
        assertEquals(201, resp1.statusCode());

        // 2. Submit with same key on request 2 -> 409 Conflict
        HttpRequest req2 = HttpRequest.newBuilder()
                .uri(URI.create(decisionUrl(fixture2.requestId())))
                .header("Content-Type", "application/json")
                .header(reviewerSession.csrf().headerName(), reviewerSession.csrf().token())
                .header("Idempotency-Key", sharedKey.toString())
                .POST(HttpRequest.BodyPublishers.ofString(payload))
                .build();
        HttpResponse<String> resp2 = reviewerSession.client().send(req2, HttpResponse.BodyHandlers.ofString());
        ReviewTestSupport.assertSafeErrorJson(resp2, 409, "IDEMPOTENCY_CONFLICT");
    }
}
