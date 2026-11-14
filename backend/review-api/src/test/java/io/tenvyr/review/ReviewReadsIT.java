package io.tenvyr.review;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.tenvyr.control.ControlPlaneRuntime;
import io.tenvyr.control.engine.AgentTransportConfig;
import io.tenvyr.platform.Db;
import io.tenvyr.platform.Json;
import io.tenvyr.review.domain.ReviewTypes.Actor;
import io.tenvyr.review.domain.ReviewTypes.ReviewDetail;
import io.tenvyr.review.domain.ReviewTypes.ReviewReport;
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
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import javax.sql.DataSource;
import java.lang.reflect.Proxy;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;

/**
 * T04 Integration Test: Authorized Bounded Reads and State Projections.
 * Requires real disposable PostgreSQL (no H2/mocks).
 * Verifies visibility enforcement across every keyset page, list summaries excluding source code,
 * detail authorization, report-before-ready 409, valid signed callback report projection,
 * invalid result inbox status projection via signed callback, and cursor limit bounds.
 * Note: HTTP audit route (/api/v1/reviews/{id}/audit) is deferred to T06; SUBMIT audit DB proof is in ReviewSubmissionIT.
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
public class ReviewReadsIT {

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

    private record ReviewFixture(UUID requestId, UUID executionId, UUID ownerId) {}

    private record StepAttemptFixture(UUID stepAttemptId, String invocationId, String logicalStepId) {}

    private ReviewFixture createReviewFixture(
            Connection conn,
            UUID ownerId,
            String title,
            String language,
            String code,
            Instant createdAt) throws Exception {
        ObjectNode pipeline = PipelineCatalog.ensure(conn);
        ObjectNode execution = engineRuntime.executions().materializeExecutionWithManager(
                conn, pipeline, Json.object("code", code, "language", language), null);
        UUID executionId = UUID.fromString(execution.path("id").asText());
        trackedExecutions.add(executionId);

        UUID idempotencyKey = UUID.randomUUID();
        UUID requestId = ReviewTestSupport.createDirectReviewRequest(
                conn, trackedRequests, ownerId, idempotencyKey, title, language, code, executionId, createdAt);

        String payloadHash = Json.hash(Json.object("title", title, "language", language, "code", code));
        ReviewTestSupport.createDirectAuditEntry(
                conn, requestId, ownerId, "SUBMIT", idempotencyKey, payloadHash, createdAt);

        return new ReviewFixture(requestId, executionId, ownerId);
    }

    private StepAttemptFixture createStepAttemptFixture(Connection conn, UUID executionId) throws SQLException {
        Db tx = Db.on(conn);
        ObjectNode stepExec = tx.one("SELECT * FROM step_executions WHERE \"executionId\" = ?", executionId.toString());
        ObjectNode revision = tx.one("SELECT * FROM execution_plan_revisions WHERE \"executionId\" = ?", executionId.toString());

        ObjectNode executorSnapshot = new AgentTransportConfig(
                EngineConfiguration.validateReviewEnvironment(environment)
        ).descriptor(ReviewTestSupport.TEST_AGENT);

        String logicalStepId = stepExec.path("id").asText();
        String invocationId = logicalStepId + ":1";

        ObjectNode attempt = Json.object(
                "executionId", executionId.toString(),
                "logicalStepId", logicalStepId,
                "planRevisionId", revision.path("id").asText(),
                "attemptNumber", 1,
                "invocationId", invocationId,
                "frozenSpecHash", Json.hash(PipelineCatalog.definition().path("steps").get(0)),
                "inputSnapshot", Json.object(),
                "executorSnapshot", executorSnapshot,
                "status", "CREATED",
                "deadlineAt", Instant.now().plusSeconds(180).toString()
        );
        ObjectNode created = tx.insert("step_attempts", attempt);
        UUID stepAttemptId = UUID.fromString(created.path("id").asText());
        return new StepAttemptFixture(stepAttemptId, invocationId, logicalStepId);
    }

    @Test
    @DisplayName("Visibility is strictly enforced on every keyset page: submitter sees only own, reviewer sees all")
    void visibilityEnforcedOnEveryKeysetPage_submitterSeesOnlyOwn_reviewerSeesAll() throws Exception {
        ReviewTestSupport.TestUser submitterA = ReviewTestSupport.createTestUser(
                dataSource, trackedUsers, "read_sub_a", Role.SUBMITTER);
        ReviewTestSupport.TestUser submitterB = ReviewTestSupport.createTestUser(
                dataSource, trackedUsers, "read_sub_b", Role.SUBMITTER);
        ReviewTestSupport.TestUser reviewer = ReviewTestSupport.createTestUser(
                dataSource, trackedUsers, "read_rev", Role.REVIEWER);

        ReviewTestSupport.AuthenticatedSession sessionA = ReviewTestSupport.loginUser(port, submitterA);
        ReviewTestSupport.AuthenticatedSession sessionB = ReviewTestSupport.loginUser(port, submitterB);
        ReviewTestSupport.AuthenticatedSession sessionRev = ReviewTestSupport.loginUser(port, reviewer);

        List<UUID> reqsA = new ArrayList<>();
        List<UUID> reqsB = new ArrayList<>();

        Instant baseTime = Instant.parse("2026-11-14T10:00:00Z");
        try (Connection conn = dataSource.getConnection()) {
            conn.setAutoCommit(false);
            try {
                // Insert 5 reviews for Submitter A with staggered timestamps
                for (int i = 0; i < 5; i++) {
                    Instant timeA = baseTime.plusSeconds(i * 10);
                    ReviewFixture fA = createReviewFixture(conn, submitterA.id(), "Review A " + i, "java", "class A" + i + "{}", timeA);
                    reqsA.add(fA.requestId());
                }

                // Insert 5 reviews for Submitter B with interleaved staggered timestamps
                for (int i = 0; i < 5; i++) {
                    Instant timeB = baseTime.plusSeconds(i * 10 + 5);
                    ReviewFixture fB = createReviewFixture(conn, submitterB.id(), "Review B " + i, "typescript", "const b" + i + " = true;", timeB);
                    reqsB.add(fB.requestId());
                }
                conn.commit();
            } catch (Exception e) {
                conn.rollback();
                throw e;
            }
        }

        // Submitter A queries list with limit=2 over multiple keyset pages
        int pageCountA = 0;
        String cursorA = null;
        List<String> observedByA = new ArrayList<>();

        while (pageCountA < 10) {
            String uri = "http://127.0.0.1:" + port + "/api/v1/reviews?limit=2";
            if (cursorA != null) {
                uri += "&after=" + URLEncoder.encode(cursorA, StandardCharsets.UTF_8);
            }

            HttpRequest req = HttpRequest.newBuilder().uri(URI.create(uri)).GET().build();
            HttpResponse<String> resp = sessionA.client().send(req, HttpResponse.BodyHandlers.ofString());

            // First meaningful assertion in read flow: asserts 200 OK (absent route returns 404, giving behavioral RED)
            assertEquals(200, resp.statusCode(), "List reviews must return 200 OK");

            JsonNode body = Json.parse(resp.body());
            JsonNode items = body.path("items");
            assertTrue(items.isArray(), "items must be an array");

            if (items.isEmpty()) {
                break;
            }

            for (JsonNode item : items) {
                String idStr = item.path("id").asText();
                UUID id = UUID.fromString(idStr);
                observedByA.add(idStr);

                // Reapply visibility assertion on EVERY page item: must belong to A, never B
                assertTrue(reqsA.contains(id), "Submitter A must only see A's reviews, but found: " + id);
                assertFalse(reqsB.contains(id), "Submitter A must never see Submitter B's review: " + id);
            }

            cursorA = body.hasNonNull("nextCursor") ? body.path("nextCursor").asText() : null;
            pageCountA++;
            if (cursorA == null || cursorA.isBlank()) {
                break;
            }
        }

        assertEquals(5, observedByA.size(), "Submitter A must see all 5 own reviews across pages");

        // Submitter B queries list with limit=2 over multiple keyset pages
        int pageCountB = 0;
        String cursorB = null;
        List<String> observedByB = new ArrayList<>();

        while (pageCountB < 10) {
            String uri = "http://127.0.0.1:" + port + "/api/v1/reviews?limit=2";
            if (cursorB != null) {
                uri += "&after=" + URLEncoder.encode(cursorB, StandardCharsets.UTF_8);
            }

            HttpRequest req = HttpRequest.newBuilder().uri(URI.create(uri)).GET().build();
            HttpResponse<String> resp = sessionB.client().send(req, HttpResponse.BodyHandlers.ofString());
            assertEquals(200, resp.statusCode());

            JsonNode body = Json.parse(resp.body());
            JsonNode items = body.path("items");

            if (items.isEmpty()) {
                break;
            }

            for (JsonNode item : items) {
                String idStr = item.path("id").asText();
                UUID id = UUID.fromString(idStr);
                observedByB.add(idStr);

                assertTrue(reqsB.contains(id), "Submitter B must only see B's reviews, but found: " + id);
                assertFalse(reqsA.contains(id), "Submitter B must never see Submitter A's review: " + id);
            }

            cursorB = body.hasNonNull("nextCursor") ? body.path("nextCursor").asText() : null;
            pageCountB++;
            if (cursorB == null || cursorB.isBlank()) {
                break;
            }
        }

        assertEquals(5, observedByB.size(), "Submitter B must see all 5 own reviews across pages");

        // Reviewer queries list with limit=4 over multiple keyset pages
        int pageCountRev = 0;
        String cursorRev = null;
        List<String> observedByRev = new ArrayList<>();

        while (pageCountRev < 10) {
            String uri = "http://127.0.0.1:" + port + "/api/v1/reviews?limit=4";
            if (cursorRev != null) {
                uri += "&after=" + URLEncoder.encode(cursorRev, StandardCharsets.UTF_8);
            }

            HttpRequest req = HttpRequest.newBuilder().uri(URI.create(uri)).GET().build();
            HttpResponse<String> resp = sessionRev.client().send(req, HttpResponse.BodyHandlers.ofString());
            assertEquals(200, resp.statusCode());

            JsonNode body = Json.parse(resp.body());
            JsonNode items = body.path("items");

            if (items.isEmpty()) {
                break;
            }

            for (JsonNode item : items) {
                observedByRev.add(item.path("id").asText());
            }

            cursorRev = body.hasNonNull("nextCursor") ? body.path("nextCursor").asText() : null;
            pageCountRev++;
            if (cursorRev == null || cursorRev.isBlank()) {
                break;
            }
        }

        assertEquals(10, observedByRev.size(), "Reviewer must see all 10 reviews across both submitters");
    }

    @Test
    @DisplayName("Review list summaries exclude source code and report bodies according to SPEC")
    void sourceAbsentFromListSummaries() throws Exception {
        ReviewTestSupport.TestUser submitter = ReviewTestSupport.createTestUser(
                dataSource, trackedUsers, "read_source_sub", Role.SUBMITTER);
        ReviewTestSupport.AuthenticatedSession session = ReviewTestSupport.loginUser(port, submitter);

        String secretSnippet = "private String highlyConfidentialInternalSourceCode = \"SECRET\";";
        try (Connection conn = dataSource.getConnection()) {
            conn.setAutoCommit(false);
            try {
                createReviewFixture(conn, submitter.id(), "Confidential Review", "java", secretSnippet, Instant.now());
                conn.commit();
            } catch (Exception e) {
                conn.rollback();
                throw e;
            }
        }

        HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create("http://127.0.0.1:" + port + "/api/v1/reviews"))
                .GET()
                .build();
        HttpResponse<String> resp = session.client().send(req, HttpResponse.BodyHandlers.ofString());
        assertEquals(200, resp.statusCode(), "List reviews must return 200 OK");

        String rawResponseBody = resp.body();
        assertFalse(rawResponseBody.contains(secretSnippet), "List response must not contain source code");
        assertFalse(rawResponseBody.contains("highlyConfidentialInternalSourceCode"),
                "List response body must strictly exclude persisted code");

        JsonNode body = Json.parse(rawResponseBody);
        JsonNode items = body.path("items");
        assertFalse(items.isEmpty(), "Items must not be empty");

        for (JsonNode item : items) {
            assertTrue(item.hasNonNull("id"));
            assertTrue(item.hasNonNull("title"));
            assertTrue(item.hasNonNull("language"));
            assertTrue(item.hasNonNull("status"));
            assertTrue(item.hasNonNull("createdAt"));

            assertNull(item.get("code"), "ReviewSummary must not contain 'code' field");
            assertNull(item.get("report"), "ReviewSummary must not contain 'report' field");
        }
    }

    @Test
    @DisplayName("Review detail visibility: owner and reviewer can read, other submitter receives 404 Not Found")
    void reviewDetailVisibility_ownerAndReviewerCanRead_otherSubmitterReceives404() throws Exception {
        ReviewTestSupport.TestUser submitterA = ReviewTestSupport.createTestUser(
                dataSource, trackedUsers, "det_sub_a", Role.SUBMITTER);
        ReviewTestSupport.TestUser submitterB = ReviewTestSupport.createTestUser(
                dataSource, trackedUsers, "det_sub_b", Role.SUBMITTER);
        ReviewTestSupport.TestUser reviewer = ReviewTestSupport.createTestUser(
                dataSource, trackedUsers, "det_rev", Role.REVIEWER);

        ReviewTestSupport.AuthenticatedSession sessionA = ReviewTestSupport.loginUser(port, submitterA);
        ReviewTestSupport.AuthenticatedSession sessionB = ReviewTestSupport.loginUser(port, submitterB);
        ReviewTestSupport.AuthenticatedSession sessionRev = ReviewTestSupport.loginUser(port, reviewer);

        String sampleCode = "public class DetailVisibilityTest { boolean allowed = true; }";
        ReviewFixture fixtureA;
        try (Connection conn = dataSource.getConnection()) {
            conn.setAutoCommit(false);
            try {
                fixtureA = createReviewFixture(conn, submitterA.id(), "Detail Test Review", "java", sampleCode, Instant.now());
                conn.commit();
            } catch (Exception e) {
                conn.rollback();
                throw e;
            }
        }

        String detailUrl = "http://127.0.0.1:" + port + "/api/v1/reviews/" + fixtureA.requestId();

        // 1. Owner Submitter A reading own review detail -> 200 OK
        HttpRequest reqA = HttpRequest.newBuilder().uri(URI.create(detailUrl)).GET().build();
        HttpResponse<String> respA = sessionA.client().send(reqA, HttpResponse.BodyHandlers.ofString());
        assertEquals(200, respA.statusCode(), "Owner Submitter A reading own review detail must return 200 OK");

        JsonNode bodyA = Json.parse(respA.body());
        assertEquals(fixtureA.requestId().toString(), bodyA.path("id").asText());
        assertEquals("Detail Test Review", bodyA.path("title").asText());
        assertEquals("java", bodyA.path("language").asText());
        assertEquals(sampleCode, bodyA.path("code").asText(), "Detail endpoint must return code to authorized owner");
        assertEquals("PROCESSING", bodyA.path("status").asText());
        assertEquals(fixtureA.executionId().toString(), bodyA.path("executionId").asText());

        // 2. Reviewer reading Submitter A's review detail -> 200 OK
        HttpRequest reqRev = HttpRequest.newBuilder().uri(URI.create(detailUrl)).GET().build();
        HttpResponse<String> respRev = sessionRev.client().send(reqRev, HttpResponse.BodyHandlers.ofString());
        assertEquals(200, respRev.statusCode(), "Reviewer reading review detail must return 200 OK");

        JsonNode bodyRev = Json.parse(respRev.body());
        assertEquals(sampleCode, bodyRev.path("code").asText(), "Detail endpoint must return code to authorized reviewer");

        // 3. Other Submitter B reading Submitter A's review detail -> 404 Not Found (safe error JSON)
        HttpRequest reqB = HttpRequest.newBuilder().uri(URI.create(detailUrl)).GET().build();
        HttpResponse<String> respB = sessionB.client().send(reqB, HttpResponse.BodyHandlers.ofString());
        ReviewTestSupport.assertSafeErrorJson(respB, 404, "NOT_FOUND");

        // 4. Guessed random UUID reading detail -> 404 Not Found
        HttpRequest reqGuessed = HttpRequest.newBuilder()
                .uri(URI.create("http://127.0.0.1:" + port + "/api/v1/reviews/" + UUID.randomUUID()))
                .GET()
                .build();
        HttpResponse<String> respGuessed = sessionA.client().send(reqGuessed, HttpResponse.BodyHandlers.ofString());
        ReviewTestSupport.assertSafeErrorJson(respGuessed, 404, "NOT_FOUND");
    }

    @Test
    @DisplayName("Report before ready returns 409 Conflict with REPORT_NOT_READY code, and unowned requests return 404")
    void reportBeforeReadyReturns409() throws Exception {
        ReviewTestSupport.TestUser submitterA = ReviewTestSupport.createTestUser(
                dataSource, trackedUsers, "rep_sub_a", Role.SUBMITTER);
        ReviewTestSupport.TestUser submitterB = ReviewTestSupport.createTestUser(
                dataSource, trackedUsers, "rep_sub_b", Role.SUBMITTER);
        ReviewTestSupport.TestUser reviewer = ReviewTestSupport.createTestUser(
                dataSource, trackedUsers, "rep_rev", Role.REVIEWER);

        ReviewTestSupport.AuthenticatedSession sessionA = ReviewTestSupport.loginUser(port, submitterA);
        ReviewTestSupport.AuthenticatedSession sessionB = ReviewTestSupport.loginUser(port, submitterB);
        ReviewTestSupport.AuthenticatedSession sessionRev = ReviewTestSupport.loginUser(port, reviewer);

        ReviewFixture fixture;
        try (Connection conn = dataSource.getConnection()) {
            conn.setAutoCommit(false);
            try {
                fixture = createReviewFixture(conn, submitterA.id(), "In-Progress Report Review", "python", "x = 10", Instant.now());
                conn.commit();
            } catch (Exception e) {
                conn.rollback();
                throw e;
            }
        }

        String reportUrl = "http://127.0.0.1:" + port + "/api/v1/reviews/" + fixture.requestId() + "/report";

        // 1. Submitter A requests report while execution is still PROCESSING -> 409 Conflict REPORT_NOT_READY
        HttpRequest reqA = HttpRequest.newBuilder().uri(URI.create(reportUrl)).GET().build();
        HttpResponse<String> respA = sessionA.client().send(reqA, HttpResponse.BodyHandlers.ofString());
        ReviewTestSupport.assertSafeErrorJson(respA, 409, "REPORT_NOT_READY");

        // 2. Reviewer requests report while execution is still PROCESSING -> 409 Conflict REPORT_NOT_READY
        HttpRequest reqRev = HttpRequest.newBuilder().uri(URI.create(reportUrl)).GET().build();
        HttpResponse<String> respRev = sessionRev.client().send(reqRev, HttpResponse.BodyHandlers.ofString());
        ReviewTestSupport.assertSafeErrorJson(respRev, 409, "REPORT_NOT_READY");

        // 3. Submitter B requests Submitter A's unready report -> 404 Not Found (visibility takes precedence)
        HttpRequest reqB = HttpRequest.newBuilder().uri(URI.create(reportUrl)).GET().build();
        HttpResponse<String> respB = sessionB.client().send(reqB, HttpResponse.BodyHandlers.ofString());
        ReviewTestSupport.assertSafeErrorJson(respB, 404, "NOT_FOUND");
    }

    @Test
    @DisplayName("Valid signed callback projection transitions status to AWAITING_REVIEW and returns 200 typed ReviewReport")
    void validSignedCallbackProjection_transitionsToAwaitingReviewAndReturnsTypedReport() throws Exception {
        ReviewTestSupport.TestUser submitterA = ReviewTestSupport.createTestUser(
                dataSource, trackedUsers, "cb_sub_a", Role.SUBMITTER);
        ReviewTestSupport.TestUser submitterB = ReviewTestSupport.createTestUser(
                dataSource, trackedUsers, "cb_sub_b", Role.SUBMITTER);
        ReviewTestSupport.TestUser reviewer = ReviewTestSupport.createTestUser(
                dataSource, trackedUsers, "cb_rev", Role.REVIEWER);

        ReviewTestSupport.AuthenticatedSession sessionA = ReviewTestSupport.loginUser(port, submitterA);
        ReviewTestSupport.AuthenticatedSession sessionB = ReviewTestSupport.loginUser(port, submitterB);
        ReviewTestSupport.AuthenticatedSession sessionRev = ReviewTestSupport.loginUser(port, reviewer);

        ReviewFixture fixture;
        StepAttemptFixture attemptFixture;
        try (Connection conn = dataSource.getConnection()) {
            conn.setAutoCommit(false);
            try {
                fixture = createReviewFixture(conn, submitterA.id(), "Completed Review", "java", "class Done {}", Instant.now());
                attemptFixture = createStepAttemptFixture(conn, fixture.executionId());
                conn.commit();
            } catch (Exception e) {
                conn.rollback();
                throw e;
            }
        }

        // Deliver genuine HMAC signed callback for the attempt to /internal/agent-callbacks/http/code-reviewer
        ObjectNode reportOutput = Json.object(
                "score", 94,
                "findings", Json.array("No critical issues found", "Code adheres to standards"),
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
        assertEquals(204, callbackResp.statusCode(), "Signed callback must be accepted with 204 No Content");

        // Bounded wait for durable execution to reach COMPLETED status
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
        assertEquals("COMPLETED", execRow.path("status").asText(), "Execution must reach COMPLETED status");

        // 1. Detail endpoint projects business status AWAITING_REVIEW
        HttpRequest detailReq = HttpRequest.newBuilder()
                .uri(URI.create("http://127.0.0.1:" + port + "/api/v1/reviews/" + fixture.requestId()))
                .GET()
                .build();
        HttpResponse<String> detailResp = sessionA.client().send(detailReq, HttpResponse.BodyHandlers.ofString());
        assertEquals(200, detailResp.statusCode());
        JsonNode detailBody = Json.parse(detailResp.body());
        assertEquals("AWAITING_REVIEW", detailBody.path("status").asText(),
                "Completed execution with valid report must project status AWAITING_REVIEW");

        // 2. Report endpoint returns 200 OK typed ReviewReport
        HttpRequest reportReq = HttpRequest.newBuilder()
                .uri(URI.create("http://127.0.0.1:" + port + "/api/v1/reviews/" + fixture.requestId() + "/report"))
                .GET()
                .build();
        HttpResponse<String> reportResp = sessionA.client().send(reportReq, HttpResponse.BodyHandlers.ofString());
        assertEquals(200, reportResp.statusCode(), "Report endpoint must return 200 OK after completion");

        JsonNode reportBody = Json.parse(reportResp.body());
        assertEquals(94, reportBody.path("score").asInt(), "Report score must match output");
        JsonNode findings = reportBody.path("findings");
        assertEquals(2, findings.size());
        assertEquals("No critical issues found", findings.get(0).asText());
        assertEquals("Code adheres to standards", findings.get(1).asText());

        JsonNode evidence = reportBody.path("evidence");
        assertEquals("MOCK", evidence.path("mode").asText());
        assertEquals("test-provider", evidence.path("provider").asText());
        assertEquals("test-model", evidence.path("model").asText());
        assertFalse(evidence.path("fallbackUsed").asBoolean());

        // 3. Reviewer also reads 200 OK typed ReviewReport
        HttpResponse<String> revReportResp = sessionRev.client().send(reportReq, HttpResponse.BodyHandlers.ofString());
        assertEquals(200, revReportResp.statusCode());
        JsonNode revReportBody = Json.parse(revReportResp.body());
        assertEquals(94, revReportBody.path("score").asInt());

        // 4. Submitter B receives 404 Not Found
        HttpResponse<String> bReportResp = sessionB.client().send(reportReq, HttpResponse.BodyHandlers.ofString());
        ReviewTestSupport.assertSafeErrorJson(bReportResp, 404, "NOT_FOUND");
    }

    @Test
    @DisplayName("Wrong selected inbox or hash invalid report projects to status FAILED with REVIEW_REPORT_INVALID code via real signed callback")
    void wrongSelectedInboxOrHashInvalidReport_projectsToFailedReviewReportInvalid() throws Exception {
        ReviewTestSupport.TestUser submitter = ReviewTestSupport.createTestUser(
                dataSource, trackedUsers, "inv_sub", Role.SUBMITTER);
        ReviewTestSupport.AuthenticatedSession session = ReviewTestSupport.loginUser(port, submitter);

        ReviewFixture fixture;
        StepAttemptFixture attemptFixture;
        try (Connection conn = dataSource.getConnection()) {
            conn.setAutoCommit(false);
            try {
                fixture = createReviewFixture(conn, submitter.id(), "Invalid Output Review", "java", "class BadOutput {}", Instant.now());
                attemptFixture = createStepAttemptFixture(conn, fixture.executionId());
                conn.commit();
            } catch (Exception e) {
                conn.rollback();
                throw e;
            }
        }

        // Deliver signed callback with invalid report output (negative score violates ReviewReport constraints)
        // Uses real signed callback through HTTP callback endpoint; no fake snapshots or guessed SQL fields
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

        // Bounded wait for durable execution to complete
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

        // 1. Detail endpoint projects status FAILED with errorCode REVIEW_REPORT_INVALID
        HttpRequest detailReq = HttpRequest.newBuilder()
                .uri(URI.create("http://127.0.0.1:" + port + "/api/v1/reviews/" + fixture.requestId()))
                .GET()
                .build();
        HttpResponse<String> detailResp = session.client().send(detailReq, HttpResponse.BodyHandlers.ofString());
        assertEquals(200, detailResp.statusCode());

        JsonNode detailBody = Json.parse(detailResp.body());
        assertEquals("FAILED", detailBody.path("status").asText(),
                "Completed execution with invalid review output must project status FAILED");
        assertEquals("REVIEW_REPORT_INVALID", detailBody.path("errorCode").asText(),
                "errorCode must be REVIEW_REPORT_INVALID");

        // 2. Report endpoint returns 409 Conflict with safe error REVIEW_REPORT_INVALID
        HttpRequest reportReq = HttpRequest.newBuilder()
                .uri(URI.create("http://127.0.0.1:" + port + "/api/v1/reviews/" + fixture.requestId() + "/report"))
                .GET()
                .build();
        HttpResponse<String> reportResp = session.client().send(reportReq, HttpResponse.BodyHandlers.ofString());
        ReviewTestSupport.assertSafeErrorJson(reportResp, 409, "REVIEW_REPORT_INVALID");
    }

    @Test
    @DisplayName("Keyset pagination rejects invalid and oversize cursors and bounds limit between 1 and 100")
    void listReviewsRejectsInvalidAndOversizeCursor() throws Exception {
        ReviewTestSupport.TestUser submitter = ReviewTestSupport.createTestUser(
                dataSource, trackedUsers, "cur_sub", Role.SUBMITTER);
        ReviewTestSupport.AuthenticatedSession session = ReviewTestSupport.loginUser(port, submitter);

        // 1. Invalid non-base64 cursor -> 400 Bad Request
        HttpRequest reqInvalidBase64 = HttpRequest.newBuilder()
                .uri(URI.create("http://127.0.0.1:" + port + "/api/v1/reviews?after=not_a_valid_base64!"))
                .GET()
                .build();
        HttpResponse<String> respInvalidBase64 = session.client().send(reqInvalidBase64, HttpResponse.BodyHandlers.ofString());
        ReviewTestSupport.assertSafeErrorJson(respInvalidBase64, 400, "BAD_REQUEST");

        // 2. Decoded cursor size exceeding 256 bytes -> 400 Bad Request
        String oversizeDecoded = "x".repeat(257);
        String oversizeEncoded = Base64.getUrlEncoder().encodeToString(oversizeDecoded.getBytes(StandardCharsets.UTF_8));
        HttpRequest reqOversizeCursor = HttpRequest.newBuilder()
                .uri(URI.create("http://127.0.0.1:" + port + "/api/v1/reviews?after=" + oversizeEncoded))
                .GET()
                .build();
        HttpResponse<String> respOversizeCursor = session.client().send(reqOversizeCursor, HttpResponse.BodyHandlers.ofString());
        ReviewTestSupport.assertSafeErrorJson(respOversizeCursor, 400, "BAD_REQUEST");

        // 3. Limit < 1 -> 400 Bad Request
        HttpRequest reqLimitZero = HttpRequest.newBuilder()
                .uri(URI.create("http://127.0.0.1:" + port + "/api/v1/reviews?limit=0"))
                .GET()
                .build();
        HttpResponse<String> respLimitZero = session.client().send(reqLimitZero, HttpResponse.BodyHandlers.ofString());
        ReviewTestSupport.assertSafeErrorJson(respLimitZero, 400, "BAD_REQUEST");

        // 4. Limit > 100 -> 400 Bad Request
        HttpRequest reqLimit101 = HttpRequest.newBuilder()
                .uri(URI.create("http://127.0.0.1:" + port + "/api/v1/reviews?limit=101"))
                .GET()
                .build();
        HttpResponse<String> respLimit101 = session.client().send(reqLimit101, HttpResponse.BodyHandlers.ofString());
        ReviewTestSupport.assertSafeErrorJson(respLimit101, 400, "BAD_REQUEST");
    }

    @Test
    @DisplayName("Divergence/correlation regression: getReport must return verified committed inbox output, not unverified diverged attempt.result")
    void unverifiedDivergedAttemptResult_cannotBeReturnedAsReport_verifiedCommittedInboxOutputRequired() throws Exception {
        ReviewTestSupport.TestUser submitter = ReviewTestSupport.createTestUser(
                dataSource, trackedUsers, "div_sub", Role.SUBMITTER);
        ReviewTestSupport.AuthenticatedSession session = ReviewTestSupport.loginUser(port, submitter);

        ReviewFixture fixture;
        StepAttemptFixture attemptFixture;
        try (Connection conn = dataSource.getConnection()) {
            conn.setAutoCommit(false);
            try {
                fixture = createReviewFixture(conn, submitter.id(), "Divergence Check Review", "java", "class DivTest {}", Instant.now());
                attemptFixture = createStepAttemptFixture(conn, fixture.executionId());
                conn.commit();
            } catch (Exception e) {
                conn.rollback();
                throw e;
            }
        }

        // Deliver genuine HMAC signed callback with verified report output (score: 95)
        ObjectNode verifiedInboxOutput = Json.object(
                "score", 95,
                "findings", Json.array("Verified clean finding from inbox"),
                "_tenvyr", Json.object(
                        "metadata", Json.object(
                                "mode", "MOCK",
                                "provider", "verified-provider",
                                "model", "verified-model"
                        )
                )
        );

        HttpResponse<String> callbackResp = ReviewTestSupport.postSignedCallback(
                port,
                attemptFixture.invocationId(),
                fixture.executionId().toString(),
                attemptFixture.logicalStepId(),
                verifiedInboxOutput
        );
        assertEquals(204, callbackResp.statusCode(), "Signed callback must succeed with 204");

        // Bounded wait for durable execution to reach COMPLETED status
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

        // Now deliberately tamper / diverge step_attempts.result with unverified data (score: 30)
        // leaving result_inbox.payload (score: 95) verified and committed
        try (Connection conn = dataSource.getConnection();
             PreparedStatement ps = conn.prepareStatement(
                     "UPDATE step_attempts SET result = ?::jsonb WHERE \"executionId\" = ?")) {
            String tamperedResultJson = Json.stringify(Json.object(
                    "score", 30,
                    "findings", Json.array("Tampered unverified attempt result")
            ));
            ps.setString(1, tamperedResultJson);
            ps.setObject(2, fixture.executionId());
            assertEquals(1, ps.executeUpdate(), "Must update exactly 1 step attempt with diverged result");
        }

        // Query report endpoint: must return verified committed inbox output (score 95), NEVER unverified attempt.result (score 30)
        HttpRequest reportReq = HttpRequest.newBuilder()
                .uri(URI.create("http://127.0.0.1:" + port + "/api/v1/reviews/" + fixture.requestId() + "/report"))
                .GET()
                .build();
        HttpResponse<String> reportResp = session.client().send(reportReq, HttpResponse.BodyHandlers.ofString());
        assertEquals(200, reportResp.statusCode(), "Report endpoint must return 200 OK for completed execution");

        JsonNode reportBody = Json.parse(reportResp.body());
        assertEquals(95, reportBody.path("score").asInt(),
                "getReport must return verified committed inbox output (95), not unverified diverged attempt.result (30)");
        assertEquals("Verified clean finding from inbox", reportBody.path("findings").get(0).asText(),
                "getReport findings must match verified inbox output");
    }

    @Test
    @DisplayName("SQL visibility regression: get and getReport must enforce visibility predicate in SQL so foreign code is not loaded across JDBC query boundary")
    void repositoryGetAndGetReport_enforceVisibilityPredicateInSql_atJdbcQueryBoundary() throws Exception {
        ReviewTestSupport.TestUser submitterA = ReviewTestSupport.createTestUser(
                dataSource, trackedUsers, "sql_vis_a", Role.SUBMITTER);
        ReviewTestSupport.TestUser submitterB = ReviewTestSupport.createTestUser(
                dataSource, trackedUsers, "sql_vis_b", Role.SUBMITTER);
        ReviewTestSupport.TestUser reviewer = ReviewTestSupport.createTestUser(
                dataSource, trackedUsers, "sql_vis_rev", Role.REVIEWER);

        String secretSampleCode = "class SecretCodeForVisibilityBoundaryCheck { long privateKey = 0xDEADBEEF; }";
        ReviewFixture fixtureA;
        try (Connection conn = dataSource.getConnection()) {
            conn.setAutoCommit(false);
            try {
                fixtureA = createReviewFixture(conn, submitterA.id(), "SQL Vis Review", "java", secretSampleCode, Instant.now());
                conn.commit();
            } catch (Exception e) {
                conn.rollback();
                throw e;
            }
        }

        // Observe JDBC query boundary using a dynamic proxy around DataSource/Connection/ResultSet
        // without adding external frameworks or mirroring SQL text
        AtomicBoolean codeColumnRead = new AtomicBoolean(false);
        AtomicInteger rowsFetched = new AtomicInteger(0);

        DataSource spyingDataSource = (DataSource) Proxy.newProxyInstance(
                DataSource.class.getClassLoader(),
                new Class<?>[]{DataSource.class},
                (proxy, method, args) -> {
                    if ("getConnection".equals(method.getName())) {
                        Connection realConn = (args == null || args.length == 0)
                                ? dataSource.getConnection()
                                : dataSource.getConnection((String) args[0], (String) args[1]);
                        return Proxy.newProxyInstance(
                                Connection.class.getClassLoader(),
                                new Class<?>[]{Connection.class},
                                (cProxy, cMethod, cArgs) -> {
                                    Object res = cMethod.invoke(realConn, cArgs);
                                    if ("prepareStatement".equals(cMethod.getName()) && res instanceof PreparedStatement ps) {
                                        return Proxy.newProxyInstance(
                                                PreparedStatement.class.getClassLoader(),
                                                new Class<?>[]{PreparedStatement.class},
                                                (pProxy, pMethod, pArgs) -> {
                                                    Object pRes = pMethod.invoke(ps, pArgs);
                                                    if ("executeQuery".equals(pMethod.getName()) && pRes instanceof ResultSet rs) {
                                                        return Proxy.newProxyInstance(
                                                                ResultSet.class.getClassLoader(),
                                                                new Class<?>[]{ResultSet.class},
                                                                (rProxy, rMethod, rArgs) -> {
                                                                    if ("next".equals(rMethod.getName())) {
                                                                        boolean hasNext = (boolean) rMethod.invoke(rs, rArgs);
                                                                        if (hasNext) rowsFetched.incrementAndGet();
                                                                        return hasNext;
                                                                    }
                                                                    if ("getString".equals(rMethod.getName()) && rArgs != null && rArgs.length > 0) {
                                                                        if ("code".equals(rArgs[0])) {
                                                                            codeColumnRead.set(true);
                                                                        }
                                                                    }
                                                                    return rMethod.invoke(rs, rArgs);
                                                                }
                                                        );
                                                    }
                                                    return pRes;
                                                }
                                        );
                                    }
                                    return res;
                                }
                        );
                    }
                    return method.invoke(dataSource, args);
                }
        );

        ReviewRepository repo = new ReviewRepository(new JdbcTemplate(spyingDataSource));

        // 1. Submitter B (non-owner) querying get(): SQL predicate must prevent row/code from crossing JDBC boundary
        Actor actorB = new Actor(submitterB.id(), submitterB.username(), Role.SUBMITTER);
        codeColumnRead.set(false);
        rowsFetched.set(0);

        ReviewDetail detailB = repo.get(actorB, fixtureA.requestId());
        assertNull(detailB, "Foreign owner get must return null");
        assertFalse(codeColumnRead.get(),
                "SQL visibility predicate must prevent foreign code from being loaded across JDBC boundary in get()");
        assertEquals(0, rowsFetched.get(),
                "SQL query must return 0 rows for non-owner before reaching Java mapping layer");

        // 2. Submitter B (non-owner) querying getReport(): SQL predicate must prevent row/code from crossing JDBC boundary
        codeColumnRead.set(false);
        rowsFetched.set(0);

        ReviewReport reportB = repo.getReport(actorB, fixtureA.requestId());
        assertNull(reportB, "Foreign owner getReport must return null");
        assertFalse(codeColumnRead.get(),
                "SQL visibility predicate must prevent code from being loaded across JDBC boundary in getReport()");
        assertEquals(0, rowsFetched.get(),
                "SQL query must return 0 rows for non-owner in getReport()");

        // 3. Submitter A (authorized owner) querying get(): succeeds and reads authorized detail
        Actor actorA = new Actor(submitterA.id(), submitterA.username(), Role.SUBMITTER);
        ReviewDetail detailA = repo.get(actorA, fixtureA.requestId());
        assertNotNull(detailA, "Authorized owner must receive ReviewDetail");
        assertEquals(secretSampleCode, detailA.code());

        // 4. Reviewer (authorized role) querying get(): succeeds
        Actor actorRev = new Actor(reviewer.id(), reviewer.username(), Role.REVIEWER);
        ReviewDetail detailRev = repo.get(actorRev, fixtureA.requestId());
        assertNotNull(detailRev, "Authorized reviewer must receive ReviewDetail");
        assertEquals(secretSampleCode, detailRev.code());
    }

    @Test
    @DisplayName("Transient query exception while resolving completed report or decision propagates to 503 classifier without returning false FAILED")
    void transientQueryExceptionDuringProjectExecutionStatus_propagatesInsteadOfFalseFailed() throws Exception {
        ReviewTestSupport.TestUser submitter = ReviewTestSupport.createTestUser(
                dataSource, trackedUsers, "trans_sub", Role.SUBMITTER);
        ReviewFixture fixture;
        StepAttemptFixture attemptFixture;
        try (Connection conn = dataSource.getConnection()) {
            conn.setAutoCommit(false);
            try {
                fixture = createReviewFixture(conn, submitter.id(), "Transient Test", "java", "class TransientCheck {}", Instant.now());
                attemptFixture = createStepAttemptFixture(conn, fixture.executionId());
                conn.commit();
            } catch (Exception e) {
                conn.rollback();
                throw e;
            }
        }

        // Post valid signed callback to ensure durable execution reaches COMPLETED
        ObjectNode reportOutput = Json.object(
                "score", 98,
                "findings", Json.array("Excellent code"),
                "_tenvyr", Json.object(
                        "metadata", Json.object("mode", "MOCK")
                )
        );
        HttpResponse<String> callbackResp = ReviewTestSupport.postSignedCallback(
                port,
                attemptFixture.invocationId(),
                fixture.executionId().toString(),
                attemptFixture.logicalStepId(),
                reportOutput
        );
        assertEquals(204, callbackResp.statusCode());

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

        // Proxy DataSource that lets initial request query and executions query succeed,
        // but throws a transient query exception (57014 query_canceled / statement_timeout)
        // when querying step_attempts/result_inbox to resolve the report/decision.
        AtomicBoolean failNextQuery = new AtomicBoolean(false);
        AtomicInteger queriesSeen = new AtomicInteger(0);
        AtomicInteger injectedQueries = new AtomicInteger(0);

        DataSource transientThrowingDataSource = (DataSource) Proxy.newProxyInstance(
                DataSource.class.getClassLoader(),
                new Class<?>[]{DataSource.class},
                (proxy, method, args) -> {
                    if ("getConnection".equals(method.getName())) {
                        Connection realConn = (args == null || args.length == 0)
                                ? dataSource.getConnection()
                                : dataSource.getConnection((String) args[0], (String) args[1]);
                        return Proxy.newProxyInstance(
                                Connection.class.getClassLoader(),
                                new Class<?>[]{Connection.class},
                                (cProxy, cMethod, cArgs) -> {
                                    Object res = cMethod.invoke(realConn, cArgs);
                                    if ("prepareStatement".equals(cMethod.getName()) && res instanceof PreparedStatement ps) {
                                        return Proxy.newProxyInstance(
                                                PreparedStatement.class.getClassLoader(),
                                                new Class<?>[]{PreparedStatement.class},
                                                (pProxy, pMethod, pArgs) -> {
                                                    if ("executeQuery".equals(pMethod.getName())) {
                                                        int count = queriesSeen.incrementAndGet();
                                                        // Query 1: requests lookup (succeeds)
                                                        // Query 2: executions lookup (succeeds, returns COMPLETED)
                                                        // Query 3: resolveVerifiedReport (step_attempts join result_inbox) -> fail
                                                        // ponytail: ceiling is query-order coupling; upgrade to semantic query-boundary hook if repository order changes
                                                        if (count == 3 && failNextQuery.get()) {
                                                            injectedQueries.incrementAndGet();
                                                            throw new SQLException("canceling statement due to statement timeout", "57014");
                                                        }
                                                    }
                                                    return pMethod.invoke(ps, pArgs);
                                                }
                                        );
                                    }
                                    return res;
                                }
                        );
                    }
                    return method.invoke(dataSource, args);
                }
        );

        ReviewRepository repo = new ReviewRepository(new JdbcTemplate(transientThrowingDataSource));
        Actor actor = new Actor(submitter.id(), submitter.username(), Role.SUBMITTER);

        // Arm failure on subsequent query
        failNextQuery.set(true);

        ReviewErrors.ReviewControllerAdvice advice = new ReviewErrors.ReviewControllerAdvice();
        try {
            Exception ex = assertThrows(Exception.class, () -> repo.get(actor, fixture.requestId()),
                    "Repository get must propagate transient query exception instead of masking as FAILED");
            assertTrue(ReviewErrors.isTransient(ex), "Thrown exception must be classified as transient database failure");
            assertEquals(1, injectedQueries.get(), "Fault injection branch must be reached exactly once");
            org.springframework.http.ResponseEntity<Map<String, String>> resp = advice.handleGeneralException(ex);
            assertEquals(org.springframework.http.HttpStatus.SERVICE_UNAVAILABLE, resp.getStatusCode(),
                    "Transient exception must be classified as 503 SERVICE_UNAVAILABLE");
            assertEquals("DATABASE_UNAVAILABLE", resp.getBody().get("code"));

            // Verify repository list also propagates transient query exception instead of returning false FAILED
            queriesSeen.set(0);
            failNextQuery.set(true);
            Exception listEx = assertThrows(Exception.class, () -> repo.list(actor, 10, null),
                    "Repository list must propagate transient query exception instead of masking as FAILED");
            assertTrue(ReviewErrors.isTransient(listEx), "Repository list must propagate transient database failure");
            assertEquals(2, injectedQueries.get(), "Fault injection branch must be reached for list");
        } finally {
            failNextQuery.set(false);
        }
    }
}
