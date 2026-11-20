package io.tenvyr.review;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.tenvyr.control.ControlPlaneRuntime;
import io.tenvyr.platform.Json;
import io.tenvyr.review.ReviewTestSupport.AuthenticatedSession;
import io.tenvyr.review.ReviewTestSupport.CsrfToken;
import io.tenvyr.review.ReviewTestSupport.ReviewFixture;
import io.tenvyr.review.ReviewTestSupport.StepAttemptFixture;
import io.tenvyr.review.ReviewTestSupport.TestUser;
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
import java.io.ByteArrayInputStream;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.time.Instant;
import java.util.*;

import static org.junit.jupiter.api.Assertions.*;

/**
 * T08 Integration Test: Comprehensive Role/Object/State/Security Boundary Matrix.
 * Requires real disposable PostgreSQL (no H2/mocks).
 *
 * Verifies:
 * 1. Table-driven access matrix: SUBMITTER (own/foreign) vs REVIEWER on
 *    detail, report, audit, cancel, and decision endpoints across all lifecycle states:
 *    PROCESSING, AWAITING_REVIEW, APPROVED, CHANGES_REQUESTED, CANCELLED, and FAILED.
 * 2. Positive read and decision payload assertions verifying canonical fields
 *    (id, title, language, createdAt, attemptCount, DecisionView) match fixtures.
 * 3. Self-review rejection: Reviewer attempting to decide on own submitted review returns 403 Forbidden.
 * 4. Consistent 404 Not Found contract without UUID leaks on foreign or non-existent IDs.
 * 5. Stale/disabled session revocation: active session after DB account disable returns 401 across endpoints;
 *    dynamic role change in DB immediately strips former role privileges (403).
 * 6. CSRF defenses: missing or stale CSRF on all mutation endpoints (submit, cancel, decide) returns 403.
 * 7. Strict input validation and boundary enforcement:
 *    - Unknown fields rejected (400) on submit and decide.
 *    - URL/path type tricks (invalid UUID shape in URL) return safe 400 error.
 *    - Non-canonical UUID in Idempotency-Key rejected (400).
 *    - Streaming body > 1 MiB chunked excess returns 413 Payload Too Large.
 *    - Exact 65,536 UTF-8 bytes code accepted (202); 65,537 rejected (400).
 *    - Title 160 trimmed and comment 2000 trimmed limits enforced.
 *    - Malformed and oversize keyset cursors strictly rejected (400).
 * 8. Safe error responses: error JSON strictly {code, message, requestId} excluding SQL, code, comments, tokens.
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
public class ReviewAccessMatrixIT {

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

    private String reviewsUrl() {
        return "http://127.0.0.1:" + port + "/api/v1/reviews";
    }

    private String detailUrl(UUID id) {
        return "http://127.0.0.1:" + port + "/api/v1/reviews/" + id;
    }

    private String reportUrl(UUID id) {
        return "http://127.0.0.1:" + port + "/api/v1/reviews/" + id + "/report";
    }

    private String auditUrl(UUID id) {
        return "http://127.0.0.1:" + port + "/api/v1/reviews/" + id + "/audit";
    }

    private String cancelUrl(UUID id) {
        return "http://127.0.0.1:" + port + "/api/v1/reviews/" + id + "/cancel";
    }

    private String decisionUrl(UUID id) {
        return "http://127.0.0.1:" + port + "/api/v1/reviews/" + id + "/decisions";
    }

    private ReviewFixture createProcessingReview(TestUser submitter) throws Exception {
        try (Connection conn = dataSource.getConnection()) {
            conn.setAutoCommit(false);
            try {
                ReviewFixture fixture = ReviewTestSupport.createReviewFixture(conn, engineRuntime, trackedRequests, trackedExecutions,
                        submitter.id(), "Processing Review", "java", "public class InProcessing { int a = 1; }", Instant.now());
                conn.commit();
                return fixture;
            } catch (Exception e) {
                conn.rollback();
                throw e;
            }
        }
    }

    private ReviewFixture createCompletedValidReview(TestUser submitter) throws Exception {
        ReviewFixture fixture;
        StepAttemptFixture attemptFixture;
        try (Connection conn = dataSource.getConnection()) {
            conn.setAutoCommit(false);
            try {
                fixture = ReviewTestSupport.createReviewFixture(conn, engineRuntime, trackedRequests, trackedExecutions,
                        submitter.id(), "Awaiting Review", "java", "public class MatrixTest { int b = 2; }", Instant.now());
                attemptFixture = ReviewTestSupport.createStepAttemptFixture(conn, environment, fixture.executionId());
                conn.commit();
            } catch (Exception e) {
                conn.rollback();
                throw e;
            }
        }

        ObjectNode reportOutput = Json.object(
                "score", 88,
                "findings", Json.array("Matrix contract verified", "Clean boundary"),
                "_tenvyr", Json.object(
                        "metadata", Json.object(
                                "mode", "MOCK",
                                "provider", "matrix-provider",
                                "model", "matrix-model",
                                "fallbackUsed", false,
                                "usageSource", "matrix-test"
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

    private ReviewFixture createApprovedReview(TestUser submitter, AuthenticatedSession reviewerSession) throws Exception {
        ReviewFixture fixture = createCompletedValidReview(submitter);
        String body = Json.stringify(Json.object("action", "APPROVE", "comment", "Approved for matrix test"));
        HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create(decisionUrl(fixture.requestId())))
                .header("Content-Type", "application/json")
                .header(reviewerSession.csrf().headerName(), reviewerSession.csrf().token())
                .header("Idempotency-Key", UUID.randomUUID().toString())
                .POST(HttpRequest.BodyPublishers.ofString(body))
                .build();
        HttpResponse<String> resp = reviewerSession.client().send(req, HttpResponse.BodyHandlers.ofString());
        assertEquals(201, resp.statusCode(), "Approval decision must return 201 Created");
        return fixture;
    }

    private ReviewFixture createChangesRequestedReview(TestUser submitter, AuthenticatedSession reviewerSession) throws Exception {
        ReviewFixture fixture = createCompletedValidReview(submitter);
        String body = Json.stringify(Json.object("action", "REQUEST_CHANGES", "comment", "Needs modifications"));
        HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create(decisionUrl(fixture.requestId())))
                .header("Content-Type", "application/json")
                .header(reviewerSession.csrf().headerName(), reviewerSession.csrf().token())
                .header("Idempotency-Key", UUID.randomUUID().toString())
                .POST(HttpRequest.BodyPublishers.ofString(body))
                .build();
        HttpResponse<String> resp = reviewerSession.client().send(req, HttpResponse.BodyHandlers.ofString());
        assertEquals(201, resp.statusCode(), "Changes requested decision must return 201 Created");
        return fixture;
    }

    private ReviewFixture createCancelledReview(TestUser submitter, AuthenticatedSession submitterSession) throws Exception {
        ReviewFixture fixture = createProcessingReview(submitter);
        HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create(cancelUrl(fixture.requestId())))
                .header(submitterSession.csrf().headerName(), submitterSession.csrf().token())
                .header("Idempotency-Key", UUID.randomUUID().toString())
                .POST(HttpRequest.BodyPublishers.noBody())
                .build();
        HttpResponse<String> resp = submitterSession.client().send(req, HttpResponse.BodyHandlers.ofString());
        assertEquals(200, resp.statusCode(), "Cancel of processing review must return 200 OK");
        return fixture;
    }

    private ReviewFixture createFailedReview(TestUser submitter) throws Exception {
        ReviewFixture fixture;
        StepAttemptFixture attemptFixture;
        try (Connection conn = dataSource.getConnection()) {
            conn.setAutoCommit(false);
            try {
                fixture = ReviewTestSupport.createReviewFixture(conn, engineRuntime, trackedRequests, trackedExecutions,
                        submitter.id(), "Failed Review", "java", "public class FailedCode {}", Instant.now());
                attemptFixture = ReviewTestSupport.createStepAttemptFixture(conn, environment, fixture.executionId());
                conn.commit();
            } catch (Exception e) {
                conn.rollback();
                throw e;
            }
        }

        // Invalid output with negative score violates ReviewReport domain contract
        ObjectNode invalidOutput = Json.object(
                "score", -10,
                "findings", Json.array("invalid negative score"),
                "_tenvyr", Json.object(
                        "metadata", Json.object("mode", "MOCK")
                )
        );

        HttpResponse<String> callbackResp = ReviewTestSupport.postSignedCallback(
                port,
                attemptFixture.invocationId(),
                fixture.executionId().toString(),
                attemptFixture.logicalStepId(),
                invalidOutput
        );
        assertEquals(204, callbackResp.statusCode(), "Signed callback must be accepted with 204");

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
        assertEquals("COMPLETED", execRow.path("status").asText());

        return fixture;
    }

    private HttpResponse<String> sendGet(AuthenticatedSession session, String url) throws Exception {
        HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .GET()
                .build();
        return session.client().send(req, HttpResponse.BodyHandlers.ofString());
    }

    private HttpResponse<String> sendCancel(AuthenticatedSession session, UUID requestId, UUID key) throws Exception {
        HttpRequest.Builder builder = HttpRequest.newBuilder()
                .uri(URI.create(cancelUrl(requestId)))
                .POST(HttpRequest.BodyPublishers.noBody());
        if (session.csrf() != null) {
            builder.header(session.csrf().headerName(), session.csrf().token());
        }
        if (key != null) {
            builder.header("Idempotency-Key", key.toString());
        }
        return session.client().send(builder.build(), HttpResponse.BodyHandlers.ofString());
    }

    private HttpResponse<String> sendDecision(AuthenticatedSession session, UUID requestId, UUID key, String bodyJson) throws Exception {
        HttpRequest.Builder builder = HttpRequest.newBuilder()
                .uri(URI.create(decisionUrl(requestId)))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(bodyJson));
        if (session.csrf() != null) {
            builder.header(session.csrf().headerName(), session.csrf().token());
        }
        if (key != null) {
            builder.header("Idempotency-Key", key.toString());
        }
        return session.client().send(builder.build(), HttpResponse.BodyHandlers.ofString());
    }

    @Test
    @DisplayName("Matrix: Complete role/object/state boundary verification across PROCESSING state")
    void testAccessMatrix_ProcessingState() throws Exception {
        TestUser submitterOwn = ReviewTestSupport.createTestUser(dataSource, trackedUsers, "mat_sub_own_p", Role.SUBMITTER);
        TestUser submitterForeign = ReviewTestSupport.createTestUser(dataSource, trackedUsers, "mat_sub_for_p", Role.SUBMITTER);
        TestUser reviewer = ReviewTestSupport.createTestUser(dataSource, trackedUsers, "mat_rev_p", Role.REVIEWER);

        AuthenticatedSession ownSession = ReviewTestSupport.loginUser(port, submitterOwn);
        AuthenticatedSession foreignSession = ReviewTestSupport.loginUser(port, submitterForeign);
        AuthenticatedSession reviewerSession = ReviewTestSupport.loginUser(port, reviewer);

        ReviewFixture fixture = createProcessingReview(submitterOwn);
        UUID reqId = fixture.requestId();

        // 1. Detail endpoint asserts canonical fields
        HttpResponse<String> ownDetail = sendGet(ownSession, detailUrl(reqId));
        assertEquals(200, ownDetail.statusCode());
        JsonNode ownDetailNode = Json.parse(ownDetail.body());
        assertEquals(reqId.toString(), ownDetailNode.path("id").asText());
        assertEquals("Processing Review", ownDetailNode.path("title").asText());
        assertEquals("java", ownDetailNode.path("language").asText());
        assertEquals(fixture.executionId().toString(), ownDetailNode.path("executionId").asText());
        assertEquals(0, ownDetailNode.path("attemptCount").asInt());
        assertFalse(ownDetailNode.path("createdAt").asText().isBlank());
        assertEquals("PROCESSING", ownDetailNode.path("status").asText());
        assertTrue(ownDetailNode.path("decision").isNull());
        assertFalse(ownDetailNode.path("code").asText().isBlank(), "Code must be visible to owner");

        HttpResponse<String> foreignDetail = sendGet(foreignSession, detailUrl(reqId));
        ReviewTestSupport.assertSafeErrorJson(foreignDetail, 404, "NOT_FOUND");

        HttpResponse<String> revDetail = sendGet(reviewerSession, detailUrl(reqId));
        assertEquals(200, revDetail.statusCode());
        JsonNode revDetailNode = Json.parse(revDetail.body());
        assertEquals(reqId.toString(), revDetailNode.path("id").asText());
        assertEquals("PROCESSING", revDetailNode.path("status").asText());
        assertFalse(revDetailNode.path("code").asText().isBlank(), "Code must be visible to reviewer");

        // 2. Report endpoint (409 REPORT_NOT_READY for authorized, 404 NOT_FOUND for foreign submitter)
        HttpResponse<String> ownReport = sendGet(ownSession, reportUrl(reqId));
        ReviewTestSupport.assertSafeErrorJson(ownReport, 409, "REPORT_NOT_READY");

        HttpResponse<String> foreignReport = sendGet(foreignSession, reportUrl(reqId));
        ReviewTestSupport.assertSafeErrorJson(foreignReport, 404, "NOT_FOUND");

        HttpResponse<String> revReport = sendGet(reviewerSession, reportUrl(reqId));
        ReviewTestSupport.assertSafeErrorJson(revReport, 409, "REPORT_NOT_READY");

        // 3. Audit endpoint
        HttpResponse<String> ownAudit = sendGet(ownSession, auditUrl(reqId));
        assertEquals(200, ownAudit.statusCode());
        JsonNode ownAuditNode = Json.parse(ownAudit.body());
        assertTrue(ownAuditNode.path("items").size() >= 1);
        assertEquals("SUBMIT", ownAuditNode.path("items").get(0).path("action").asText());

        HttpResponse<String> foreignAudit = sendGet(foreignSession, auditUrl(reqId));
        ReviewTestSupport.assertSafeErrorJson(foreignAudit, 404, "NOT_FOUND");

        HttpResponse<String> revAudit = sendGet(reviewerSession, auditUrl(reqId));
        assertEquals(200, revAudit.statusCode());

        // 4. Decision endpoint (submitter rejected with 403, reviewer rejected with 409 because report not ready)
        String decisionBody = Json.stringify(Json.object("action", "APPROVE", "comment", "Valid code"));
        HttpResponse<String> ownDecide = sendDecision(ownSession, reqId, UUID.randomUUID(), decisionBody);
        ReviewTestSupport.assertSafeErrorJson(ownDecide, 403, "FORBIDDEN");

        HttpResponse<String> foreignDecide = sendDecision(foreignSession, reqId, UUID.randomUUID(), decisionBody);
        ReviewTestSupport.assertSafeErrorJson(foreignDecide, 403, "FORBIDDEN");

        HttpResponse<String> revDecide = sendDecision(reviewerSession, reqId, UUID.randomUUID(), decisionBody);
        ReviewTestSupport.assertSafeErrorJson(revDecide, 409, "REPORT_NOT_READY");

        // 5. Cancel endpoint (foreign gets 404, reviewer gets 403, owner gets 200)
        HttpResponse<String> foreignCancel = sendCancel(foreignSession, reqId, UUID.randomUUID());
        ReviewTestSupport.assertSafeErrorJson(foreignCancel, 404, "NOT_FOUND");

        HttpResponse<String> revCancel = sendCancel(reviewerSession, reqId, UUID.randomUUID());
        ReviewTestSupport.assertSafeErrorJson(revCancel, 403, "FORBIDDEN");

        HttpResponse<String> ownCancel = sendCancel(ownSession, reqId, UUID.randomUUID());
        assertEquals(200, ownCancel.statusCode());
        JsonNode cancelNode = Json.parse(ownCancel.body());
        assertEquals(reqId.toString(), cancelNode.path("id").asText());
        assertEquals("CANCELLED", cancelNode.path("status").asText());
    }

    @Test
    @DisplayName("Matrix: Complete role/object/state boundary verification across AWAITING_REVIEW state")
    void testAccessMatrix_AwaitingReviewState() throws Exception {
        TestUser submitterOwn = ReviewTestSupport.createTestUser(dataSource, trackedUsers, "mat_sub_own_a", Role.SUBMITTER);
        TestUser submitterForeign = ReviewTestSupport.createTestUser(dataSource, trackedUsers, "mat_sub_for_a", Role.SUBMITTER);
        TestUser reviewer = ReviewTestSupport.createTestUser(dataSource, trackedUsers, "mat_rev_a", Role.REVIEWER);

        AuthenticatedSession ownSession = ReviewTestSupport.loginUser(port, submitterOwn);
        AuthenticatedSession foreignSession = ReviewTestSupport.loginUser(port, submitterForeign);
        AuthenticatedSession reviewerSession = ReviewTestSupport.loginUser(port, reviewer);

        ReviewFixture fixture = createCompletedValidReview(submitterOwn);
        UUID reqId = fixture.requestId();

        // 1. Detail endpoint asserts canonical fields
        HttpResponse<String> ownDetail = sendGet(ownSession, detailUrl(reqId));
        assertEquals(200, ownDetail.statusCode());
        JsonNode ownDetailNode = Json.parse(ownDetail.body());
        assertEquals(reqId.toString(), ownDetailNode.path("id").asText());
        assertEquals("Awaiting Review", ownDetailNode.path("title").asText());
        assertEquals("java", ownDetailNode.path("language").asText());
        assertEquals(fixture.executionId().toString(), ownDetailNode.path("executionId").asText());
        assertEquals(1, ownDetailNode.path("attemptCount").asInt());
        assertEquals("AWAITING_REVIEW", ownDetailNode.path("status").asText());
        assertTrue(ownDetailNode.path("decision").isNull());

        HttpResponse<String> foreignDetail = sendGet(foreignSession, detailUrl(reqId));
        ReviewTestSupport.assertSafeErrorJson(foreignDetail, 404, "NOT_FOUND");

        HttpResponse<String> revDetail = sendGet(reviewerSession, detailUrl(reqId));
        assertEquals(200, revDetail.statusCode());
        assertEquals("AWAITING_REVIEW", Json.parse(revDetail.body()).path("status").asText());

        // 2. Report endpoint (200 OK with valid report for owner & reviewer, 404 for foreign submitter)
        HttpResponse<String> ownReport = sendGet(ownSession, reportUrl(reqId));
        assertEquals(200, ownReport.statusCode());
        JsonNode ownRepNode = Json.parse(ownReport.body());
        assertEquals(88, ownRepNode.path("score").asInt());
        assertEquals("MOCK", ownRepNode.path("evidence").path("mode").asText());

        HttpResponse<String> foreignReport = sendGet(foreignSession, reportUrl(reqId));
        ReviewTestSupport.assertSafeErrorJson(foreignReport, 404, "NOT_FOUND");

        HttpResponse<String> revReport = sendGet(reviewerSession, reportUrl(reqId));
        assertEquals(200, revReport.statusCode());
        assertEquals(88, Json.parse(revReport.body()).path("score").asInt());

        // 3. Audit endpoint
        HttpResponse<String> ownAudit = sendGet(ownSession, auditUrl(reqId));
        assertEquals(200, ownAudit.statusCode());

        HttpResponse<String> foreignAudit = sendGet(foreignSession, auditUrl(reqId));
        ReviewTestSupport.assertSafeErrorJson(foreignAudit, 404, "NOT_FOUND");

        HttpResponse<String> revAudit = sendGet(reviewerSession, auditUrl(reqId));
        assertEquals(200, revAudit.statusCode());

        // 4. Cancel endpoint (completed review cannot be cancelled: owner gets 409 IDEMPOTENCY_CONFLICT, foreign 404, reviewer 403)
        HttpResponse<String> ownCancel = sendCancel(ownSession, reqId, UUID.randomUUID());
        ReviewTestSupport.assertSafeErrorJson(ownCancel, 409, "IDEMPOTENCY_CONFLICT");

        HttpResponse<String> foreignCancel = sendCancel(foreignSession, reqId, UUID.randomUUID());
        ReviewTestSupport.assertSafeErrorJson(foreignCancel, 404, "NOT_FOUND");

        HttpResponse<String> revCancel = sendCancel(reviewerSession, reqId, UUID.randomUUID());
        ReviewTestSupport.assertSafeErrorJson(revCancel, 403, "FORBIDDEN");

        // 5. Decision endpoint (submitter rejected with 403, reviewer succeeds with 201)
        String decisionBody = Json.stringify(Json.object("action", "APPROVE", "comment", "Approved in matrix test"));
        HttpResponse<String> ownDecide = sendDecision(ownSession, reqId, UUID.randomUUID(), decisionBody);
        ReviewTestSupport.assertSafeErrorJson(ownDecide, 403, "FORBIDDEN");

        HttpResponse<String> foreignDecide = sendDecision(foreignSession, reqId, UUID.randomUUID(), decisionBody);
        ReviewTestSupport.assertSafeErrorJson(foreignDecide, 403, "FORBIDDEN");

        HttpResponse<String> revDecide = sendDecision(reviewerSession, reqId, UUID.randomUUID(), decisionBody);
        assertEquals(201, revDecide.statusCode(), "Reviewer decision on AWAITING_REVIEW must succeed with 201");
        JsonNode decView = Json.parse(revDecide.body());
        assertEquals(reqId.toString(), decView.path("requestId").asText());
        assertEquals("APPROVE", decView.path("action").asText());
        assertEquals("Approved in matrix test", decView.path("comment").asText());
    }

    @Test
    @DisplayName("Matrix: Complete role/object/state boundary verification across APPROVED final state")
    void testAccessMatrix_ApprovedState() throws Exception {
        TestUser submitterOwn = ReviewTestSupport.createTestUser(dataSource, trackedUsers, "mat_sub_own_app", Role.SUBMITTER);
        TestUser submitterForeign = ReviewTestSupport.createTestUser(dataSource, trackedUsers, "mat_sub_for_app", Role.SUBMITTER);
        TestUser reviewer = ReviewTestSupport.createTestUser(dataSource, trackedUsers, "mat_rev_app", Role.REVIEWER);

        AuthenticatedSession ownSession = ReviewTestSupport.loginUser(port, submitterOwn);
        AuthenticatedSession foreignSession = ReviewTestSupport.loginUser(port, submitterForeign);
        AuthenticatedSession reviewerSession = ReviewTestSupport.loginUser(port, reviewer);

        ReviewFixture fixture = createApprovedReview(submitterOwn, reviewerSession);
        UUID reqId = fixture.requestId();

        // 1. Detail endpoint reflects APPROVED status and DecisionView payload
        HttpResponse<String> ownDetail = sendGet(ownSession, detailUrl(reqId));
        assertEquals(200, ownDetail.statusCode());
        JsonNode ownDetailNode = Json.parse(ownDetail.body());
        assertEquals(reqId.toString(), ownDetailNode.path("id").asText());
        assertEquals("Awaiting Review", ownDetailNode.path("title").asText());
        assertEquals("APPROVED", ownDetailNode.path("status").asText());
        assertEquals(1, ownDetailNode.path("attemptCount").asInt());
        JsonNode decisionNode = ownDetailNode.path("decision");
        assertFalse(decisionNode.isNull(), "Decision must be populated");
        assertEquals("APPROVE", decisionNode.path("action").asText());
        assertEquals("Approved for matrix test", decisionNode.path("comment").asText());
        assertEquals(reviewer.id().toString(), decisionNode.path("actorId").asText());
        assertEquals(reqId.toString(), decisionNode.path("requestId").asText());

        HttpResponse<String> foreignDetail = sendGet(foreignSession, detailUrl(reqId));
        ReviewTestSupport.assertSafeErrorJson(foreignDetail, 404, "NOT_FOUND");

        HttpResponse<String> revDetail = sendGet(reviewerSession, detailUrl(reqId));
        assertEquals(200, revDetail.statusCode());
        assertEquals("APPROVED", Json.parse(revDetail.body()).path("status").asText());

        // 2. Report endpoint (200 OK for owner & reviewer, 404 for foreign)
        assertEquals(200, sendGet(ownSession, reportUrl(reqId)).statusCode());
        ReviewTestSupport.assertSafeErrorJson(sendGet(foreignSession, reportUrl(reqId)), 404, "NOT_FOUND");
        assertEquals(200, sendGet(reviewerSession, reportUrl(reqId)).statusCode());

        // 3. Audit endpoint (contains SUBMIT and DECIDE)
        HttpResponse<String> ownAudit = sendGet(ownSession, auditUrl(reqId));
        assertEquals(200, ownAudit.statusCode());
        JsonNode items = Json.parse(ownAudit.body()).path("items");
        assertTrue(items.size() >= 2);

        ReviewTestSupport.assertSafeErrorJson(sendGet(foreignSession, auditUrl(reqId)), 404, "NOT_FOUND");
        assertEquals(200, sendGet(reviewerSession, auditUrl(reqId)).statusCode());

        // 4. Cancel endpoint (completed/approved cannot be cancelled)
        ReviewTestSupport.assertSafeErrorJson(sendCancel(ownSession, reqId, UUID.randomUUID()), 409, "IDEMPOTENCY_CONFLICT");
        ReviewTestSupport.assertSafeErrorJson(sendCancel(foreignSession, reqId, UUID.randomUUID()), 404, "NOT_FOUND");
        ReviewTestSupport.assertSafeErrorJson(sendCancel(reviewerSession, reqId, UUID.randomUUID()), 403, "FORBIDDEN");

        // 5. Decision endpoint (second decision rejected with 409 conflict, submitter 403)
        String decisionBody = Json.stringify(Json.object("action", "REQUEST_CHANGES", "comment", "Late decision"));
        ReviewTestSupport.assertSafeErrorJson(sendDecision(ownSession, reqId, UUID.randomUUID(), decisionBody), 403, "FORBIDDEN");
        ReviewTestSupport.assertSafeErrorJson(sendDecision(foreignSession, reqId, UUID.randomUUID(), decisionBody), 403, "FORBIDDEN");
        ReviewTestSupport.assertSafeErrorJson(sendDecision(reviewerSession, reqId, UUID.randomUUID(), decisionBody), 409, "IDEMPOTENCY_CONFLICT");
    }

    @Test
    @DisplayName("Matrix: Complete role/object/state boundary verification across CHANGES_REQUESTED final state")
    void testAccessMatrix_ChangesRequestedState() throws Exception {
        TestUser submitterOwn = ReviewTestSupport.createTestUser(dataSource, trackedUsers, "mat_sub_own_cr", Role.SUBMITTER);
        TestUser submitterForeign = ReviewTestSupport.createTestUser(dataSource, trackedUsers, "mat_sub_for_cr", Role.SUBMITTER);
        TestUser reviewer = ReviewTestSupport.createTestUser(dataSource, trackedUsers, "mat_rev_cr", Role.REVIEWER);

        AuthenticatedSession ownSession = ReviewTestSupport.loginUser(port, submitterOwn);
        AuthenticatedSession foreignSession = ReviewTestSupport.loginUser(port, submitterForeign);
        AuthenticatedSession reviewerSession = ReviewTestSupport.loginUser(port, reviewer);

        ReviewFixture fixture = createChangesRequestedReview(submitterOwn, reviewerSession);
        UUID reqId = fixture.requestId();

        // 1. Detail endpoint reflects CHANGES_REQUESTED status and DecisionView payload
        HttpResponse<String> ownDetail = sendGet(ownSession, detailUrl(reqId));
        assertEquals(200, ownDetail.statusCode());
        JsonNode ownDetailNode = Json.parse(ownDetail.body());
        assertEquals(reqId.toString(), ownDetailNode.path("id").asText());
        assertEquals("Awaiting Review", ownDetailNode.path("title").asText());
        assertEquals("CHANGES_REQUESTED", ownDetailNode.path("status").asText());
        assertEquals(1, ownDetailNode.path("attemptCount").asInt());
        JsonNode decisionNode = ownDetailNode.path("decision");
        assertFalse(decisionNode.isNull(), "Decision must be populated");
        assertEquals("REQUEST_CHANGES", decisionNode.path("action").asText());
        assertEquals("Needs modifications", decisionNode.path("comment").asText());
        assertEquals(reviewer.id().toString(), decisionNode.path("actorId").asText());
        assertEquals(reqId.toString(), decisionNode.path("requestId").asText());

        HttpResponse<String> foreignDetail = sendGet(foreignSession, detailUrl(reqId));
        ReviewTestSupport.assertSafeErrorJson(foreignDetail, 404, "NOT_FOUND");

        HttpResponse<String> revDetail = sendGet(reviewerSession, detailUrl(reqId));
        assertEquals(200, revDetail.statusCode());
        assertEquals("CHANGES_REQUESTED", Json.parse(revDetail.body()).path("status").asText());

        // 2. Report endpoint (200 OK for owner & reviewer, 404 for foreign)
        assertEquals(200, sendGet(ownSession, reportUrl(reqId)).statusCode());
        ReviewTestSupport.assertSafeErrorJson(sendGet(foreignSession, reportUrl(reqId)), 404, "NOT_FOUND");
        assertEquals(200, sendGet(reviewerSession, reportUrl(reqId)).statusCode());

        // 3. Audit endpoint (contains SUBMIT and DECIDE)
        HttpResponse<String> ownAudit = sendGet(ownSession, auditUrl(reqId));
        assertEquals(200, ownAudit.statusCode());
        JsonNode items = Json.parse(ownAudit.body()).path("items");
        assertTrue(items.size() >= 2);

        ReviewTestSupport.assertSafeErrorJson(sendGet(foreignSession, auditUrl(reqId)), 404, "NOT_FOUND");
        assertEquals(200, sendGet(reviewerSession, auditUrl(reqId)).statusCode());

        // 4. Cancel endpoint (completed/changes_requested cannot be cancelled)
        ReviewTestSupport.assertSafeErrorJson(sendCancel(ownSession, reqId, UUID.randomUUID()), 409, "IDEMPOTENCY_CONFLICT");
        ReviewTestSupport.assertSafeErrorJson(sendCancel(foreignSession, reqId, UUID.randomUUID()), 404, "NOT_FOUND");
        ReviewTestSupport.assertSafeErrorJson(sendCancel(reviewerSession, reqId, UUID.randomUUID()), 403, "FORBIDDEN");

        // 5. Decision endpoint (second decision rejected with 409 conflict, submitter 403)
        String decisionBody = Json.stringify(Json.object("action", "APPROVE", "comment", "Cannot double-decide"));
        ReviewTestSupport.assertSafeErrorJson(sendDecision(ownSession, reqId, UUID.randomUUID(), decisionBody), 403, "FORBIDDEN");
        ReviewTestSupport.assertSafeErrorJson(sendDecision(foreignSession, reqId, UUID.randomUUID(), decisionBody), 403, "FORBIDDEN");
        ReviewTestSupport.assertSafeErrorJson(sendDecision(reviewerSession, reqId, UUID.randomUUID(), decisionBody), 409, "IDEMPOTENCY_CONFLICT");
    }

    @Test
    @DisplayName("Matrix: Complete role/object/state boundary verification across CANCELLED final state")
    void testAccessMatrix_CancelledState() throws Exception {
        TestUser submitterOwn = ReviewTestSupport.createTestUser(dataSource, trackedUsers, "mat_sub_own_c", Role.SUBMITTER);
        TestUser submitterForeign = ReviewTestSupport.createTestUser(dataSource, trackedUsers, "mat_sub_for_c", Role.SUBMITTER);
        TestUser reviewer = ReviewTestSupport.createTestUser(dataSource, trackedUsers, "mat_rev_c", Role.REVIEWER);

        AuthenticatedSession ownSession = ReviewTestSupport.loginUser(port, submitterOwn);
        AuthenticatedSession foreignSession = ReviewTestSupport.loginUser(port, submitterForeign);
        AuthenticatedSession reviewerSession = ReviewTestSupport.loginUser(port, reviewer);

        ReviewFixture fixture = createCancelledReview(submitterOwn, ownSession);
        UUID reqId = fixture.requestId();

        // 1. Detail endpoint asserts canonical fields
        HttpResponse<String> ownDetail = sendGet(ownSession, detailUrl(reqId));
        assertEquals(200, ownDetail.statusCode());
        JsonNode ownDetailNode = Json.parse(ownDetail.body());
        assertEquals(reqId.toString(), ownDetailNode.path("id").asText());
        assertEquals("Processing Review", ownDetailNode.path("title").asText());
        assertEquals("CANCELLED", ownDetailNode.path("status").asText());

        HttpResponse<String> foreignDetail = sendGet(foreignSession, detailUrl(reqId));
        ReviewTestSupport.assertSafeErrorJson(foreignDetail, 404, "NOT_FOUND");

        HttpResponse<String> revDetail = sendGet(reviewerSession, detailUrl(reqId));
        assertEquals(200, revDetail.statusCode());
        assertEquals("CANCELLED", Json.parse(revDetail.body()).path("status").asText());

        // 2. Report endpoint (409 REPORT_NOT_READY for owner & reviewer, 404 for foreign)
        ReviewTestSupport.assertSafeErrorJson(sendGet(ownSession, reportUrl(reqId)), 409, "REPORT_NOT_READY");
        ReviewTestSupport.assertSafeErrorJson(sendGet(foreignSession, reportUrl(reqId)), 404, "NOT_FOUND");
        ReviewTestSupport.assertSafeErrorJson(sendGet(reviewerSession, reportUrl(reqId)), 409, "REPORT_NOT_READY");

        // 3. Audit endpoint (contains SUBMIT and CANCEL)
        HttpResponse<String> ownAudit = sendGet(ownSession, auditUrl(reqId));
        assertEquals(200, ownAudit.statusCode());
        JsonNode items = Json.parse(ownAudit.body()).path("items");
        assertTrue(items.size() >= 2);

        ReviewTestSupport.assertSafeErrorJson(sendGet(foreignSession, auditUrl(reqId)), 404, "NOT_FOUND");
        assertEquals(200, sendGet(reviewerSession, auditUrl(reqId)).statusCode());

        // 4. Cancel endpoint with fresh key on cancelled review -> 409 IDEMPOTENCY_CONFLICT
        ReviewTestSupport.assertSafeErrorJson(sendCancel(ownSession, reqId, UUID.randomUUID()), 409, "IDEMPOTENCY_CONFLICT");
        ReviewTestSupport.assertSafeErrorJson(sendCancel(foreignSession, reqId, UUID.randomUUID()), 404, "NOT_FOUND");
        ReviewTestSupport.assertSafeErrorJson(sendCancel(reviewerSession, reqId, UUID.randomUUID()), 403, "FORBIDDEN");

        // 5. Decision endpoint on cancelled review -> 409 REPORT_NOT_READY for reviewer, 403 for submitter
        String decisionBody = Json.stringify(Json.object("action", "APPROVE", "comment", "Decision on cancelled"));
        ReviewTestSupport.assertSafeErrorJson(sendDecision(ownSession, reqId, UUID.randomUUID(), decisionBody), 403, "FORBIDDEN");
        ReviewTestSupport.assertSafeErrorJson(sendDecision(foreignSession, reqId, UUID.randomUUID(), decisionBody), 403, "FORBIDDEN");
        ReviewTestSupport.assertSafeErrorJson(sendDecision(reviewerSession, reqId, UUID.randomUUID(), decisionBody), 409, "REPORT_NOT_READY");
    }

    @Test
    @DisplayName("Matrix: Complete role/object/state boundary verification across FAILED state")
    void testAccessMatrix_FailedState() throws Exception {
        TestUser submitterOwn = ReviewTestSupport.createTestUser(dataSource, trackedUsers, "mat_sub_own_f", Role.SUBMITTER);
        TestUser submitterForeign = ReviewTestSupport.createTestUser(dataSource, trackedUsers, "mat_sub_for_f", Role.SUBMITTER);
        TestUser reviewer = ReviewTestSupport.createTestUser(dataSource, trackedUsers, "mat_rev_f", Role.REVIEWER);

        AuthenticatedSession ownSession = ReviewTestSupport.loginUser(port, submitterOwn);
        AuthenticatedSession foreignSession = ReviewTestSupport.loginUser(port, submitterForeign);
        AuthenticatedSession reviewerSession = ReviewTestSupport.loginUser(port, reviewer);

        ReviewFixture fixture = createFailedReview(submitterOwn);
        UUID reqId = fixture.requestId();

        // 1. Detail endpoint projects FAILED status with REVIEW_REPORT_INVALID error code
        HttpResponse<String> ownDetail = sendGet(ownSession, detailUrl(reqId));
        assertEquals(200, ownDetail.statusCode());
        JsonNode ownDetailNode = Json.parse(ownDetail.body());
        assertEquals(reqId.toString(), ownDetailNode.path("id").asText());
        assertEquals("Failed Review", ownDetailNode.path("title").asText());
        assertEquals("FAILED", ownDetailNode.path("status").asText());
        assertEquals("REVIEW_REPORT_INVALID", ownDetailNode.path("errorCode").asText());
        assertEquals(1, ownDetailNode.path("attemptCount").asInt());

        HttpResponse<String> foreignDetail = sendGet(foreignSession, detailUrl(reqId));
        ReviewTestSupport.assertSafeErrorJson(foreignDetail, 404, "NOT_FOUND");

        HttpResponse<String> revDetail = sendGet(reviewerSession, detailUrl(reqId));
        assertEquals(200, revDetail.statusCode());
        JsonNode revDetailNode = Json.parse(revDetail.body());
        assertEquals("FAILED", revDetailNode.path("status").asText());
        assertEquals("REVIEW_REPORT_INVALID", revDetailNode.path("errorCode").asText());

        // 2. Report endpoint returns 409 REVIEW_REPORT_INVALID for owner & reviewer, 404 for foreign submitter
        ReviewTestSupport.assertSafeErrorJson(sendGet(ownSession, reportUrl(reqId)), 409, "REVIEW_REPORT_INVALID");
        ReviewTestSupport.assertSafeErrorJson(sendGet(foreignSession, reportUrl(reqId)), 404, "NOT_FOUND");
        ReviewTestSupport.assertSafeErrorJson(sendGet(reviewerSession, reportUrl(reqId)), 409, "REVIEW_REPORT_INVALID");

        // 3. Audit endpoint
        HttpResponse<String> ownAudit = sendGet(ownSession, auditUrl(reqId));
        assertEquals(200, ownAudit.statusCode());
        JsonNode items = Json.parse(ownAudit.body()).path("items");
        assertTrue(items.size() >= 1);

        ReviewTestSupport.assertSafeErrorJson(sendGet(foreignSession, auditUrl(reqId)), 404, "NOT_FOUND");
        assertEquals(200, sendGet(reviewerSession, auditUrl(reqId)).statusCode());

        // 4. Cancel endpoint on completed/failed review returns 409 IDEMPOTENCY_CONFLICT (owner), 404 (foreign), 403 (reviewer)
        ReviewTestSupport.assertSafeErrorJson(sendCancel(ownSession, reqId, UUID.randomUUID()), 409, "IDEMPOTENCY_CONFLICT");
        ReviewTestSupport.assertSafeErrorJson(sendCancel(foreignSession, reqId, UUID.randomUUID()), 404, "NOT_FOUND");
        ReviewTestSupport.assertSafeErrorJson(sendCancel(reviewerSession, reqId, UUID.randomUUID()), 403, "FORBIDDEN");

        // 5. Decision endpoint on failed review returns 409 REVIEW_REPORT_INVALID (reviewer), 403 (submitter)
        String decisionBody = Json.stringify(Json.object("action", "APPROVE", "comment", "Decision on failed review"));
        ReviewTestSupport.assertSafeErrorJson(sendDecision(ownSession, reqId, UUID.randomUUID(), decisionBody), 403, "FORBIDDEN");
        ReviewTestSupport.assertSafeErrorJson(sendDecision(foreignSession, reqId, UUID.randomUUID(), decisionBody), 403, "FORBIDDEN");
        ReviewTestSupport.assertSafeErrorJson(sendDecision(reviewerSession, reqId, UUID.randomUUID(), decisionBody), 409, "REVIEW_REPORT_INVALID");
    }

    @Test
    @DisplayName("Self-review rejection: Reviewer who is also request owner is rejected with 403 Forbidden")
    void testSelfReviewRejected_whenReviewerIsOwner() throws Exception {
        // User created review while having SUBMITTER role, then user role in DB changed to REVIEWER
        TestUser user = ReviewTestSupport.createTestUser(dataSource, trackedUsers, "mat_self_rev", Role.SUBMITTER);
        ReviewFixture fixture = createCompletedValidReview(user);

        // Elevate user to REVIEWER in PostgreSQL
        try (Connection conn = dataSource.getConnection();
             PreparedStatement ps = conn.prepareStatement("UPDATE tenvyr_review.users SET role = 'REVIEWER' WHERE id = ?")) {
            ps.setObject(1, user.id());
            assertEquals(1, ps.executeUpdate());
        }

        // Login elevated user as REVIEWER
        AuthenticatedSession elevatedSession = ReviewTestSupport.loginUser(port,
                new TestUser(user.id(), user.username(), user.rawPassword(), Role.REVIEWER));

        String body = Json.stringify(Json.object("action", "APPROVE", "comment", "Attempting self-verdict"));
        HttpResponse<String> resp = sendDecision(elevatedSession, fixture.requestId(), UUID.randomUUID(), body);
        ReviewTestSupport.assertSafeErrorJson(resp, 403, "FORBIDDEN");
    }

    @Test
    @DisplayName("Non-existent UUID consistently returns 404 without leaking internal state")
    void testNonExistentUUID_consistentlyReturns404_noHiddenLeaks() throws Exception {
        TestUser submitter = ReviewTestSupport.createTestUser(dataSource, trackedUsers, "mat_none_sub", Role.SUBMITTER);
        TestUser reviewer = ReviewTestSupport.createTestUser(dataSource, trackedUsers, "mat_none_rev", Role.REVIEWER);

        AuthenticatedSession subSession = ReviewTestSupport.loginUser(port, submitter);
        AuthenticatedSession revSession = ReviewTestSupport.loginUser(port, reviewer);

        UUID nonExistentId = UUID.randomUUID();

        // Submitter queries non-existent UUID -> all return 404
        ReviewTestSupport.assertSafeErrorJson(sendGet(subSession, detailUrl(nonExistentId)), 404, "NOT_FOUND");
        ReviewTestSupport.assertSafeErrorJson(sendGet(subSession, reportUrl(nonExistentId)), 404, "NOT_FOUND");
        ReviewTestSupport.assertSafeErrorJson(sendGet(subSession, auditUrl(nonExistentId)), 404, "NOT_FOUND");
        ReviewTestSupport.assertSafeErrorJson(sendCancel(subSession, nonExistentId, UUID.randomUUID()), 404, "NOT_FOUND");

        // Reviewer queries non-existent UUID -> detail/report/audit/decide return 404; cancel returns 403 (role check first)
        ReviewTestSupport.assertSafeErrorJson(sendGet(revSession, detailUrl(nonExistentId)), 404, "NOT_FOUND");
        ReviewTestSupport.assertSafeErrorJson(sendGet(revSession, reportUrl(nonExistentId)), 404, "NOT_FOUND");
        ReviewTestSupport.assertSafeErrorJson(sendGet(revSession, auditUrl(nonExistentId)), 404, "NOT_FOUND");
        ReviewTestSupport.assertSafeErrorJson(sendCancel(revSession, nonExistentId, UUID.randomUUID()), 403, "FORBIDDEN");

        String body = Json.stringify(Json.object("action", "APPROVE", "comment", "Decision on missing"));
        ReviewTestSupport.assertSafeErrorJson(sendDecision(revSession, nonExistentId, UUID.randomUUID(), body), 404, "NOT_FOUND");
    }

    @Test
    @DisplayName("Active session after DB account disable returns 401 Unauthorized across all endpoints")
    void testOldSession_afterDBDisable_reflectsCurrentActorAcrossEndpoints() throws Exception {
        TestUser submitter = ReviewTestSupport.createTestUser(dataSource, trackedUsers, "mat_dis_sub", Role.SUBMITTER);
        TestUser reviewer = ReviewTestSupport.createTestUser(dataSource, trackedUsers, "mat_dis_rev", Role.REVIEWER);

        AuthenticatedSession subSession = ReviewTestSupport.loginUser(port, submitter);
        AuthenticatedSession revSession = ReviewTestSupport.loginUser(port, reviewer);

        ReviewFixture fixture = createCompletedValidReview(submitter);
        UUID reqId = fixture.requestId();

        // Disable submitter user in PostgreSQL
        try (Connection conn = dataSource.getConnection();
             PreparedStatement ps = conn.prepareStatement("UPDATE tenvyr_review.users SET enabled = false WHERE id = ?")) {
            ps.setObject(1, submitter.id());
            assertEquals(1, ps.executeUpdate());
        }

        // Submitter active session calls -> 401 UNAUTHORIZED
        ReviewTestSupport.assertSafeErrorJson(sendGet(subSession, detailUrl(reqId)), 401, "UNAUTHORIZED");
        ReviewTestSupport.assertSafeErrorJson(sendGet(subSession, reportUrl(reqId)), 401, "UNAUTHORIZED");
        ReviewTestSupport.assertSafeErrorJson(sendGet(subSession, auditUrl(reqId)), 401, "UNAUTHORIZED");
        ReviewTestSupport.assertSafeErrorJson(sendCancel(subSession, reqId, UUID.randomUUID()), 401, "UNAUTHORIZED");

        HttpRequest submitReq = HttpRequest.newBuilder()
                .uri(URI.create(reviewsUrl()))
                .header("Content-Type", "application/json")
                .header(subSession.csrf().headerName(), subSession.csrf().token())
                .header("Idempotency-Key", UUID.randomUUID().toString())
                .POST(HttpRequest.BodyPublishers.ofString(Json.stringify(Json.object("title", "T", "language", "java", "code", "C"))))
                .build();
        ReviewTestSupport.assertSafeErrorJson(subSession.client().send(submitReq, HttpResponse.BodyHandlers.ofString()), 401, "UNAUTHORIZED");

        // Disable reviewer user in PostgreSQL
        try (Connection conn = dataSource.getConnection();
             PreparedStatement ps = conn.prepareStatement("UPDATE tenvyr_review.users SET enabled = false WHERE id = ?")) {
            ps.setObject(1, reviewer.id());
            assertEquals(1, ps.executeUpdate());
        }

        String body = Json.stringify(Json.object("action", "APPROVE", "comment", "Valid"));
        ReviewTestSupport.assertSafeErrorJson(sendDecision(revSession, reqId, UUID.randomUUID(), body), 401, "UNAUTHORIZED");
    }

    @Test
    @DisplayName("Active session after DB role change immediately rejects stale role privileges (403 Forbidden)")
    void testOldSession_afterDBRoleChange_reflectsCurrentActorAcrossEndpoints() throws Exception {
        TestUser submitter = ReviewTestSupport.createTestUser(dataSource, trackedUsers, "mat_role_sub", Role.SUBMITTER);
        TestUser reviewer = ReviewTestSupport.createTestUser(dataSource, trackedUsers, "mat_role_rev", Role.REVIEWER);

        AuthenticatedSession subSession = ReviewTestSupport.loginUser(port, submitter);
        AuthenticatedSession revSession = ReviewTestSupport.loginUser(port, reviewer);

        ReviewFixture fixture = createCompletedValidReview(submitter);
        UUID reqId = fixture.requestId();

        // Demote reviewer to SUBMITTER in DB
        try (Connection conn = dataSource.getConnection();
             PreparedStatement ps = conn.prepareStatement("UPDATE tenvyr_review.users SET role = 'SUBMITTER' WHERE id = ?")) {
            ps.setObject(1, reviewer.id());
            assertEquals(1, ps.executeUpdate());
        }

        // Active session attempting DECIDE -> 403 Forbidden
        String body = Json.stringify(Json.object("action", "APPROVE", "comment", "Should be rejected"));
        ReviewTestSupport.assertSafeErrorJson(sendDecision(revSession, reqId, UUID.randomUUID(), body), 403, "FORBIDDEN");

        // Promote submitter to REVIEWER in DB
        try (Connection conn = dataSource.getConnection();
             PreparedStatement ps = conn.prepareStatement("UPDATE tenvyr_review.users SET role = 'REVIEWER' WHERE id = ?")) {
            ps.setObject(1, submitter.id());
            assertEquals(1, ps.executeUpdate());
        }

        // Active session attempting CANCEL -> 403 Forbidden
        ReviewTestSupport.assertSafeErrorJson(sendCancel(subSession, reqId, UUID.randomUUID()), 403, "FORBIDDEN");
    }

    @Test
    @DisplayName("CSRF protection: Missing or stale CSRF on all mutation endpoints returns 403 Forbidden")
    void testCsrfProtection_missingOrStale_onAllMutationEndpoints() throws Exception {
        TestUser submitter = ReviewTestSupport.createTestUser(dataSource, trackedUsers, "mat_csrf_sub", Role.SUBMITTER);
        TestUser reviewer = ReviewTestSupport.createTestUser(dataSource, trackedUsers, "mat_csrf_rev", Role.REVIEWER);

        AuthenticatedSession subSession = ReviewTestSupport.loginUser(port, submitter);
        AuthenticatedSession revSession = ReviewTestSupport.loginUser(port, reviewer);

        ReviewFixture fixture = createCompletedValidReview(submitter);
        UUID reqId = fixture.requestId();

        // 1. Submit review without CSRF -> 403
        HttpRequest reqNoCsrfSubmit = HttpRequest.newBuilder()
                .uri(URI.create(reviewsUrl()))
                .header("Content-Type", "application/json")
                .header("Idempotency-Key", UUID.randomUUID().toString())
                .POST(HttpRequest.BodyPublishers.ofString(Json.stringify(Json.object("title", "T", "language", "java", "code", "C"))))
                .build();
        ReviewTestSupport.assertSafeErrorJson(subSession.client().send(reqNoCsrfSubmit, HttpResponse.BodyHandlers.ofString()), 403, null);

        // 2. Cancel review without CSRF -> 403
        HttpRequest reqNoCsrfCancel = HttpRequest.newBuilder()
                .uri(URI.create(cancelUrl(reqId)))
                .header("Idempotency-Key", UUID.randomUUID().toString())
                .POST(HttpRequest.BodyPublishers.noBody())
                .build();
        ReviewTestSupport.assertSafeErrorJson(subSession.client().send(reqNoCsrfCancel, HttpResponse.BodyHandlers.ofString()), 403, null);

        // 3. Decide review without CSRF -> 403
        String decBody = Json.stringify(Json.object("action", "APPROVE", "comment", "Valid"));
        HttpRequest reqNoCsrfDecide = HttpRequest.newBuilder()
                .uri(URI.create(decisionUrl(reqId)))
                .header("Content-Type", "application/json")
                .header("Idempotency-Key", UUID.randomUUID().toString())
                .POST(HttpRequest.BodyPublishers.ofString(decBody))
                .build();
        ReviewTestSupport.assertSafeErrorJson(revSession.client().send(reqNoCsrfDecide, HttpResponse.BodyHandlers.ofString()), 403, null);

        // 4. Stale / tampered CSRF on decide -> 403
        HttpRequest reqStaleDecide = HttpRequest.newBuilder()
                .uri(URI.create(decisionUrl(reqId)))
                .header("Content-Type", "application/json")
                .header(revSession.csrf().headerName(), "invalid-csrf-token-value")
                .header("Idempotency-Key", UUID.randomUUID().toString())
                .POST(HttpRequest.BodyPublishers.ofString(decBody))
                .build();
        ReviewTestSupport.assertSafeErrorJson(revSession.client().send(reqStaleDecide, HttpResponse.BodyHandlers.ofString()), 403, null);

        // 5. Stale / tampered CSRF on cancel -> 403
        HttpRequest reqStaleCancel = HttpRequest.newBuilder()
                .uri(URI.create(cancelUrl(reqId)))
                .header(subSession.csrf().headerName(), "invalid-csrf-token-value")
                .header("Idempotency-Key", UUID.randomUUID().toString())
                .POST(HttpRequest.BodyPublishers.noBody())
                .build();
        ReviewTestSupport.assertSafeErrorJson(subSession.client().send(reqStaleCancel, HttpResponse.BodyHandlers.ofString()), 403, null);
    }

    @Test
    @DisplayName("Unknown fields, path URL type tricks, and non-canonical UUIDs return 400 Bad Request")
    void testUnknownFieldsAndUrlTypeTricks_strictlyRejected() throws Exception {
        TestUser submitter = ReviewTestSupport.createTestUser(dataSource, trackedUsers, "mat_field_sub", Role.SUBMITTER);
        TestUser reviewer = ReviewTestSupport.createTestUser(dataSource, trackedUsers, "mat_field_rev", Role.REVIEWER);

        AuthenticatedSession subSession = ReviewTestSupport.loginUser(port, submitter);
        AuthenticatedSession revSession = ReviewTestSupport.loginUser(port, reviewer);

        // 1. Unknown field in POST /reviews -> 400
        String unknownSubmit = "{\"title\":\"Valid\",\"language\":\"java\",\"code\":\"class A{}\",\"maliciousExtra\":true}";
        HttpRequest reqUnknownSubmit = HttpRequest.newBuilder()
                .uri(URI.create(reviewsUrl()))
                .header("Content-Type", "application/json")
                .header(subSession.csrf().headerName(), subSession.csrf().token())
                .header("Idempotency-Key", UUID.randomUUID().toString())
                .POST(HttpRequest.BodyPublishers.ofString(unknownSubmit))
                .build();
        ReviewTestSupport.assertSafeErrorJson(subSession.client().send(reqUnknownSubmit, HttpResponse.BodyHandlers.ofString()), 400, "BAD_REQUEST");

        // 2. Unknown field in POST /decisions -> 400
        ReviewFixture fixture = createCompletedValidReview(submitter);
        String unknownDecide = "{\"action\":\"APPROVE\",\"comment\":\"C\",\"maliciousField\":\"inject\"}";
        HttpRequest reqUnknownDecide = HttpRequest.newBuilder()
                .uri(URI.create(decisionUrl(fixture.requestId())))
                .header("Content-Type", "application/json")
                .header(revSession.csrf().headerName(), revSession.csrf().token())
                .header("Idempotency-Key", UUID.randomUUID().toString())
                .POST(HttpRequest.BodyPublishers.ofString(unknownDecide))
                .build();
        ReviewTestSupport.assertSafeErrorJson(revSession.client().send(reqUnknownDecide, HttpResponse.BodyHandlers.ofString()), 400, "BAD_REQUEST");

        // 3. Path / URL tricks: non-UUID string in path parameter -> 400
        String invalidPathUrl = "http://127.0.0.1:" + port + "/api/v1/reviews/not-a-valid-uuid";
        ReviewTestSupport.assertSafeErrorJson(sendGet(subSession, invalidPathUrl), 400, "BAD_REQUEST");
        ReviewTestSupport.assertSafeErrorJson(sendGet(subSession, invalidPathUrl + "/report"), 400, "BAD_REQUEST");
        ReviewTestSupport.assertSafeErrorJson(sendGet(subSession, invalidPathUrl + "/audit"), 400, "BAD_REQUEST");

        HttpRequest reqInvalidPathCancel = HttpRequest.newBuilder()
                .uri(URI.create(invalidPathUrl + "/cancel"))
                .header(subSession.csrf().headerName(), subSession.csrf().token())
                .header("Idempotency-Key", UUID.randomUUID().toString())
                .POST(HttpRequest.BodyPublishers.noBody())
                .build();
        ReviewTestSupport.assertSafeErrorJson(subSession.client().send(reqInvalidPathCancel, HttpResponse.BodyHandlers.ofString()), 400, "BAD_REQUEST");

        HttpRequest reqInvalidPathDecide = HttpRequest.newBuilder()
                .uri(URI.create(invalidPathUrl + "/decisions"))
                .header("Content-Type", "application/json")
                .header(revSession.csrf().headerName(), revSession.csrf().token())
                .header("Idempotency-Key", UUID.randomUUID().toString())
                .POST(HttpRequest.BodyPublishers.ofString(Json.stringify(Json.object("action", "APPROVE"))))
                .build();
        ReviewTestSupport.assertSafeErrorJson(revSession.client().send(reqInvalidPathDecide, HttpResponse.BodyHandlers.ofString()), 400, "BAD_REQUEST");

        // 4. Non-canonical Idempotency-Key header shapes -> 400
        String nonCanonicalKey = "{" + UUID.randomUUID() + "}"; // Curly braces disallowed
        HttpRequest reqNonCanonKey = HttpRequest.newBuilder()
                .uri(URI.create(reviewsUrl()))
                .header("Content-Type", "application/json")
                .header(subSession.csrf().headerName(), subSession.csrf().token())
                .header("Idempotency-Key", nonCanonicalKey)
                .POST(HttpRequest.BodyPublishers.ofString(Json.stringify(Json.object("title", "T", "language", "java", "code", "C"))))
                .build();
        ReviewTestSupport.assertSafeErrorJson(subSession.client().send(reqNonCanonKey, HttpResponse.BodyHandlers.ofString()), 400, "BAD_REQUEST");
    }

    @Test
    @DisplayName("Chunked request body > 1 MiB with unknown Content-Length returns 413 Payload Too Large")
    void testChunkedBody_excessOneMegabyte_streamingRejection() throws Exception {
        TestUser reviewer = ReviewTestSupport.createTestUser(dataSource, trackedUsers, "mat_chunk_rev", Role.REVIEWER);
        TestUser submitter = ReviewTestSupport.createTestUser(dataSource, trackedUsers, "mat_chunk_sub", Role.SUBMITTER);

        AuthenticatedSession revSession = ReviewTestSupport.loginUser(port, reviewer);
        ReviewFixture fixture = createCompletedValidReview(submitter);

        // 1 MiB = 1,048,576 bytes; send 1,048,577 bytes chunked stream
        byte[] oversizeData = new byte[1048577];
        Arrays.fill(oversizeData, (byte) ' ');

        HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create(decisionUrl(fixture.requestId())))
                .header("Content-Type", "application/json")
                .header(revSession.csrf().headerName(), revSession.csrf().token())
                .header("Idempotency-Key", UUID.randomUUID().toString())
                .POST(HttpRequest.BodyPublishers.ofInputStream(() -> new ByteArrayInputStream(oversizeData)))
                .build();

        HttpResponse<String> resp = revSession.client().send(req, HttpResponse.BodyHandlers.ofString());
        ReviewTestSupport.assertSafeErrorJson(resp, 413, "PAYLOAD_TOO_LARGE");
    }

    @Test
    @DisplayName("Unicode code limits (65,536 accepted, 65,537 rejected), title 160 trimmed, comment 2000 trimmed limits")
    void testInputLimits_codeUtf8_titleTrimmed_commentTrimmed() throws Exception {
        TestUser submitter = ReviewTestSupport.createTestUser(dataSource, trackedUsers, "mat_limit_sub", Role.SUBMITTER);
        TestUser reviewer = ReviewTestSupport.createTestUser(dataSource, trackedUsers, "mat_limit_rev", Role.REVIEWER);

        AuthenticatedSession subSession = ReviewTestSupport.loginUser(port, submitter);
        AuthenticatedSession revSession = ReviewTestSupport.loginUser(port, reviewer);

        // 1. Exact 65,536 UTF-8 bytes code: "中" (3 bytes) * 21845 = 65,535 bytes + 1 ASCII byte = 65,536 bytes
        String code65536 = "中".repeat(21845) + "a";
        byte[] bytes65536 = code65536.getBytes(StandardCharsets.UTF_8);
        assertEquals(65536, bytes65536.length);

        HttpRequest reqExactCode = HttpRequest.newBuilder()
                .uri(URI.create(reviewsUrl()))
                .header("Content-Type", "application/json")
                .header(subSession.csrf().headerName(), subSession.csrf().token())
                .header("Idempotency-Key", UUID.randomUUID().toString())
                .POST(HttpRequest.BodyPublishers.ofString(Json.stringify(Json.object(
                        "title", "Exact 65536 UTF-8 Limit",
                        "language", "java",
                        "code", code65536
                ))))
                .build();
        HttpResponse<String> respExactCode = subSession.client().send(reqExactCode, HttpResponse.BodyHandlers.ofString());
        assertEquals(202, respExactCode.statusCode(), "Exact 65,536 bytes code must be accepted (202)");
        UUID req65536Id = UUID.fromString(Json.parse(respExactCode.body()).path("id").asText());
        UUID exec65536Id = UUID.fromString(Json.parse(respExactCode.body()).path("executionId").asText());
        trackedRequests.add(req65536Id);
        trackedExecutions.add(exec65536Id);

        // 2. 65,537 UTF-8 bytes code -> 400 BAD_REQUEST
        String code65537 = "中".repeat(21845) + "ab";
        assertEquals(65537, code65537.getBytes(StandardCharsets.UTF_8).length);

        HttpRequest reqOversizeCode = HttpRequest.newBuilder()
                .uri(URI.create(reviewsUrl()))
                .header("Content-Type", "application/json")
                .header(subSession.csrf().headerName(), subSession.csrf().token())
                .header("Idempotency-Key", UUID.randomUUID().toString())
                .POST(HttpRequest.BodyPublishers.ofString(Json.stringify(Json.object(
                        "title", "Oversize 65537 UTF-8 Limit",
                        "language", "java",
                        "code", code65537
                ))))
                .build();
        ReviewTestSupport.assertSafeErrorJson(subSession.client().send(reqOversizeCode, HttpResponse.BodyHandlers.ofString()), 400, "BAD_REQUEST");

        // 3. Title 160 trimmed accepted, 161 rejected
        String title160Padded = "   " + "x".repeat(160) + "   ";
        HttpRequest reqTitle160 = HttpRequest.newBuilder()
                .uri(URI.create(reviewsUrl()))
                .header("Content-Type", "application/json")
                .header(subSession.csrf().headerName(), subSession.csrf().token())
                .header("Idempotency-Key", UUID.randomUUID().toString())
                .POST(HttpRequest.BodyPublishers.ofString(Json.stringify(Json.object(
                        "title", title160Padded,
                        "language", "java",
                        "code", "public class X {}"
                ))))
                .build();
        HttpResponse<String> respTitle160 = subSession.client().send(reqTitle160, HttpResponse.BodyHandlers.ofString());
        assertEquals(202, respTitle160.statusCode());
        trackedRequests.add(UUID.fromString(Json.parse(respTitle160.body()).path("id").asText()));
        trackedExecutions.add(UUID.fromString(Json.parse(respTitle160.body()).path("executionId").asText()));

        String title161 = "x".repeat(161);
        HttpRequest reqTitle161 = HttpRequest.newBuilder()
                .uri(URI.create(reviewsUrl()))
                .header("Content-Type", "application/json")
                .header(subSession.csrf().headerName(), subSession.csrf().token())
                .header("Idempotency-Key", UUID.randomUUID().toString())
                .POST(HttpRequest.BodyPublishers.ofString(Json.stringify(Json.object(
                        "title", title161,
                        "language", "java",
                        "code", "public class X {}"
                ))))
                .build();
        ReviewTestSupport.assertSafeErrorJson(subSession.client().send(reqTitle161, HttpResponse.BodyHandlers.ofString()), 400, "BAD_REQUEST");

        // 4. Decision comment 2000 trimmed accepted, 2001 rejected
        ReviewFixture fixture = createCompletedValidReview(submitter);
        String comment2000Padded = "  " + "c".repeat(2000) + "  ";
        String body2000 = Json.stringify(Json.object("action", "APPROVE", "comment", comment2000Padded));
        HttpRequest reqComment2000 = HttpRequest.newBuilder()
                .uri(URI.create(decisionUrl(fixture.requestId())))
                .header("Content-Type", "application/json")
                .header(revSession.csrf().headerName(), revSession.csrf().token())
                .header("Idempotency-Key", UUID.randomUUID().toString())
                .POST(HttpRequest.BodyPublishers.ofString(body2000))
                .build();
        HttpResponse<String> respComment2000 = revSession.client().send(reqComment2000, HttpResponse.BodyHandlers.ofString());
        assertEquals(201, respComment2000.statusCode());

        ReviewFixture fixture2 = createCompletedValidReview(submitter);
        String comment2001 = "c".repeat(2001);
        String body2001 = Json.stringify(Json.object("action", "APPROVE", "comment", comment2001));
        HttpRequest reqComment2001 = HttpRequest.newBuilder()
                .uri(URI.create(decisionUrl(fixture2.requestId())))
                .header("Content-Type", "application/json")
                .header(revSession.csrf().headerName(), revSession.csrf().token())
                .header("Idempotency-Key", UUID.randomUUID().toString())
                .POST(HttpRequest.BodyPublishers.ofString(body2001))
                .build();
        ReviewTestSupport.assertSafeErrorJson(revSession.client().send(reqComment2001, HttpResponse.BodyHandlers.ofString()), 400, "BAD_REQUEST");
    }

    @Test
    @DisplayName("Malformed, oversize, and out-of-bounds cursors and limits on review list and audit return 400")
    void testMalformedAndOversizeCursor_onReviewListAndAudit() throws Exception {
        TestUser submitter = ReviewTestSupport.createTestUser(dataSource, trackedUsers, "mat_cur_sub", Role.SUBMITTER);
        AuthenticatedSession subSession = ReviewTestSupport.loginUser(port, submitter);
        ReviewFixture fixture = createProcessingReview(submitter);

        String listUrl = reviewsUrl();
        String auditUrl = auditUrl(fixture.requestId());

        // 1. Raw cursor length > 512 chars -> 400
        String oversizeRawCursor = "a".repeat(513);
        ReviewTestSupport.assertSafeErrorJson(sendGet(subSession, listUrl + "?after=" + oversizeRawCursor), 400, "BAD_REQUEST");
        ReviewTestSupport.assertSafeErrorJson(sendGet(subSession, auditUrl + "?after=" + oversizeRawCursor), 400, "BAD_REQUEST");

        // 2. Decoded cursor bytes > 256 bytes -> 400
        byte[] oversizeDecoded = new byte[257];
        Arrays.fill(oversizeDecoded, (byte) 'z');
        String oversizeDecodedCursor = Base64.getUrlEncoder().encodeToString(oversizeDecoded);
        ReviewTestSupport.assertSafeErrorJson(sendGet(subSession, listUrl + "?after=" + oversizeDecodedCursor), 400, "BAD_REQUEST");
        ReviewTestSupport.assertSafeErrorJson(sendGet(subSession, auditUrl + "?after=" + oversizeDecodedCursor), 400, "BAD_REQUEST");

        // 3. Invalid Base64 string URL-encoded so client doesn't reject malformed URI percent-escape pair -> 400 from server
        String invalidBase64 = "%%%not-base64%%%";
        String encodedInvalidBase64 = URLEncoder.encode(invalidBase64, StandardCharsets.UTF_8);
        ReviewTestSupport.assertSafeErrorJson(sendGet(subSession, listUrl + "?after=" + encodedInvalidBase64), 400, "BAD_REQUEST");
        ReviewTestSupport.assertSafeErrorJson(sendGet(subSession, auditUrl + "?after=" + encodedInvalidBase64), 400, "BAD_REQUEST");

        // 4. Valid Base64 with invalid schema (missing id or createdAt) -> 400
        String badSchemaJson = Json.stringify(Json.object("createdAt", Instant.now().toString()));
        String badSchemaCursor = Base64.getUrlEncoder().encodeToString(badSchemaJson.getBytes(StandardCharsets.UTF_8));
        ReviewTestSupport.assertSafeErrorJson(sendGet(subSession, listUrl + "?after=" + badSchemaCursor), 400, "BAD_REQUEST");
        ReviewTestSupport.assertSafeErrorJson(sendGet(subSession, auditUrl + "?after=" + badSchemaCursor), 400, "BAD_REQUEST");

        // 5. Out of bounds limits (< 1 or > 100) -> 400
        ReviewTestSupport.assertSafeErrorJson(sendGet(subSession, listUrl + "?limit=0"), 400, "BAD_REQUEST");
        ReviewTestSupport.assertSafeErrorJson(sendGet(subSession, listUrl + "?limit=101"), 400, "BAD_REQUEST");
        ReviewTestSupport.assertSafeErrorJson(sendGet(subSession, auditUrl + "?limit=0"), 400, "BAD_REQUEST");
        ReviewTestSupport.assertSafeErrorJson(sendGet(subSession, auditUrl + "?limit=101"), 400, "BAD_REQUEST");
    }

    @Test
    @DisplayName("Stable error responses strictly exclude submitted code, comments, SQL injection, and tokens")
    void testStableErrorResponses_excludePrivatePayloadsAndSql() throws Exception {
        TestUser submitter = ReviewTestSupport.createTestUser(dataSource, trackedUsers, "mat_sec_err_sub", Role.SUBMITTER);
        AuthenticatedSession subSession = ReviewTestSupport.loginUser(port, submitter);

        // Submit malformed body with SQL injection and simulated secret token
        String maliciousPayload = "{\"title\":\"'; DROP TABLE tenvyr_review.requests; --\"," +
                "\"language\":\"malicious_lang\"," +
                "\"code\":\"PRIVATE_SOURCE_CODE_DO_NOT_LEAK; token=secret_bearer_12345;\"}";

        HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create(reviewsUrl()))
                .header("Content-Type", "application/json")
                .header(subSession.csrf().headerName(), subSession.csrf().token())
                .header("Idempotency-Key", UUID.randomUUID().toString())
                .POST(HttpRequest.BodyPublishers.ofString(maliciousPayload))
                .build();

        HttpResponse<String> resp = subSession.client().send(req, HttpResponse.BodyHandlers.ofString());
        ReviewTestSupport.assertSafeErrorJson(resp, 400, "BAD_REQUEST");

        String body = resp.body().toLowerCase(Locale.ROOT);
        assertFalse(body.contains("drop table"), "Error JSON must never leak SQL injection text");
        assertFalse(body.contains("secret_bearer"), "Error JSON must never leak secret tokens");
        assertFalse(body.contains("private_source_code"), "Error JSON must never leak private source code");
    }
}
