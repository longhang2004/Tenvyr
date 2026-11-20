package io.tenvyr.review;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.micrometer.core.instrument.MeterRegistry;
import io.tenvyr.control.ControlPlaneRuntime;
import io.tenvyr.platform.Json;
import io.tenvyr.platform.Protocol;
import io.tenvyr.review.ReviewTestSupport.AuthenticatedSession;
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
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.util.*;

import static org.junit.jupiter.api.Assertions.*;

/**
 * T07 Integration Test: HTTP-Only Actuator Health, Metrics, RBAC, and Bounded Capacity.
 * Requires real disposable PostgreSQL (no H2/mocks).
 *
 * Verifies:
 * 1. Public health endpoint /actuator/health is anonymous and returns minimal status (show-details: never).
 * 2. Unexposed Actuator endpoints (/actuator/env, /beans, /mappings, etc.) are strictly denied/unreachable.
 * 3. Metrics endpoint /actuator/metrics is restricted to REVIEWER role only:
 *    - Anonymous returns 401 Unauthorized (safe JSON error).
 *    - Submitter returns 403 Forbidden (safe JSON error).
 *    - Reviewer returns 200 OK with review.commands and review.backlog metrics.
 * 4. Stale session revocation against fresh DB state:
 *    - Disabled user session returns 401 Unauthorized.
 *    - Demoted user session (role changed to SUBMITTER) returns 403 Forbidden.
 * 5. Low-cardinality command metrics (review.commands):
 *    - Exact fixed tag names: 'command' and 'outcome' only.
 *    - Allowed values: command in ('SUBMIT', 'DECIDE', 'CANCEL'), outcome in allowlist.
 *    - Baseline count 0.0 present at startup (never 404).
 *    - No high-cardinality or sensitive labels (actor/request IDs, code, comments, tokens, URLs).
 *    - Actively drives SUBMIT, DECIDE, CANCEL lifecycle (success, replay, conflict, invalid)
 *      and verifies timer count and total time change.
 * 6. Dynamic backlog gauge (review.backlog):
 *    - Measures requests strictly in AWAITING_REVIEW state.
 *    - Excludes pending, cancelled (via real HTTP cancel), failed (invalid report), and decided requests.
 *    - Polling the gauge performs zero database writes.
 * 7. Bounded resource configuration:
 *    - Tomcat 50 threads / 50 accept-count, Hikari 10 connections / 2s timeout.
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
public class ReviewMetricsIT {

    @LocalServerPort
    private int port;

    @Autowired
    private DataSource dataSource;

    @Autowired
    private ControlPlaneRuntime engineRuntime;

    @Autowired
    private Environment environment;

    @Autowired(required = false)
    private MeterRegistry meterRegistry;

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

    @Test
    @DisplayName("1. Public health endpoint /actuator/health is anonymous and returns minimal status UP without internal component details")
    void publicHealthEndpoint_isAnonymousAndMinimal() throws Exception {
        HttpClient client = HttpClient.newHttpClient();
        HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create("http://127.0.0.1:" + port + "/actuator/health"))
                .GET()
                .build();

        HttpResponse<String> resp = client.send(req, HttpResponse.BodyHandlers.ofString());
        assertEquals(200, resp.statusCode(), "Health endpoint must be public and return 200 OK");

        JsonNode json = Json.parse(resp.body());
        assertEquals("UP", json.path("status").asText(), "Health status must be UP");
        assertFalse(json.has("components"), "Health endpoint must not expose component details (show-details: never)");
        assertFalse(json.has("details"), "Health endpoint must not expose internal probe details");
        assertFalse(json.has("diskSpace"), "Health endpoint must not expose diskSpace");
        assertFalse(json.has("db"), "Health endpoint must not expose database health details");
    }

    @Test
    @DisplayName("2. Sensitive actuator endpoints (/env, /beans, /mappings, /configprops, /heapdump) are not exposed")
    void actuatorEndpoints_exposureRestricted() throws Exception {
        HttpClient client = HttpClient.newHttpClient();
        String[] sensitiveEndpoints = {"/actuator/env", "/actuator/beans", "/actuator/mappings", "/actuator/configprops", "/actuator/heapdump"};

        for (String ep : sensitiveEndpoints) {
            HttpRequest req = HttpRequest.newBuilder()
                    .uri(URI.create("http://127.0.0.1:" + port + ep))
                    .GET()
                    .build();
            HttpResponse<String> resp = client.send(req, HttpResponse.BodyHandlers.ofString());
            assertNotEquals(200, resp.statusCode(), "Sensitive endpoint " + ep + " must not return 200 OK");
            assertTrue(
                    resp.statusCode() == 401 || resp.statusCode() == 403 || resp.statusCode() == 404,
                    "Sensitive endpoint " + ep + " must return 401, 403, or 404, got: " + resp.statusCode()
            );
        }
    }

    @Test
    @DisplayName("3a. Anonymous access to /actuator/metrics returns 401 Unauthorized safe JSON error")
    void metricsEndpoint_anonymousReturns401() throws Exception {
        HttpClient client = HttpClient.newHttpClient();
        HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create("http://127.0.0.1:" + port + "/actuator/metrics"))
                .GET()
                .build();

        HttpResponse<String> resp = client.send(req, HttpResponse.BodyHandlers.ofString());
        ReviewTestSupport.assertSafeErrorJson(resp, 401, "UNAUTHORIZED");
    }

    @Test
    @DisplayName("3b. SUBMITTER access to /actuator/metrics returns 403 Forbidden safe JSON error")
    void metricsEndpoint_submitterReturns403() throws Exception {
        TestUser submitter = ReviewTestSupport.createTestUser(dataSource, trackedUsers, "sub_met", Role.SUBMITTER);
        AuthenticatedSession session = ReviewTestSupport.loginUser(port, submitter);

        HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create("http://127.0.0.1:" + port + "/actuator/metrics"))
                .GET()
                .build();

        HttpResponse<String> resp = session.client().send(req, HttpResponse.BodyHandlers.ofString());
        ReviewTestSupport.assertSafeErrorJson(resp, 403, "FORBIDDEN");
    }

    @Test
    @DisplayName("3c. REVIEWER access to /actuator/metrics returns 200 OK containing review.commands and review.backlog")
    void metricsEndpoint_reviewerReturns200WithRequiredMetrics() throws Exception {
        TestUser reviewer = ReviewTestSupport.createTestUser(dataSource, trackedUsers, "rev_met", Role.REVIEWER);
        AuthenticatedSession session = ReviewTestSupport.loginUser(port, reviewer);

        HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create("http://127.0.0.1:" + port + "/actuator/metrics"))
                .GET()
                .build();

        HttpResponse<String> resp = session.client().send(req, HttpResponse.BodyHandlers.ofString());
        assertEquals(200, resp.statusCode(), "REVIEWER must be authorized to access /actuator/metrics");

        JsonNode json = Json.parse(resp.body());
        JsonNode namesNode = json.path("names");
        assertTrue(namesNode.isArray(), "Metrics endpoint must return a 'names' array");

        Set<String> names = new HashSet<>();
        namesNode.forEach(n -> names.add(n.asText()));

        assertTrue(names.contains("review.commands"), "Metrics names must contain 'review.commands'");
        assertTrue(names.contains("review.backlog"), "Metrics names must contain 'review.backlog'");
    }

    @Test
    @DisplayName("4a. Stale session revocation: disabled REVIEWER account receives 401 Unauthorized on next metrics request")
    void staleSessionRevocation_disabledUserReturns401() throws Exception {
        TestUser reviewer = ReviewTestSupport.createTestUser(dataSource, trackedUsers, "rev_dis", Role.REVIEWER);
        AuthenticatedSession session = ReviewTestSupport.loginUser(port, reviewer);

        try (Connection conn = dataSource.getConnection();
             PreparedStatement ps = conn.prepareStatement("UPDATE tenvyr_review.users SET enabled = false WHERE id = ?")) {
            ps.setObject(1, reviewer.id());
            assertEquals(1, ps.executeUpdate(), "User record must be disabled in DB");
        }

        HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create("http://127.0.0.1:" + port + "/actuator/metrics"))
                .GET()
                .build();

        HttpResponse<String> resp = session.client().send(req, HttpResponse.BodyHandlers.ofString());
        ReviewTestSupport.assertSafeErrorJson(resp, 401, "UNAUTHORIZED");
    }

    @Test
    @DisplayName("4b. Stale session revocation: demoted REVIEWER to SUBMITTER receives 403 Forbidden on next metrics request")
    void staleSessionRevocation_demotedRoleReturns403() throws Exception {
        TestUser reviewer = ReviewTestSupport.createTestUser(dataSource, trackedUsers, "rev_dem", Role.REVIEWER);
        AuthenticatedSession session = ReviewTestSupport.loginUser(port, reviewer);

        try (Connection conn = dataSource.getConnection();
             PreparedStatement ps = conn.prepareStatement("UPDATE tenvyr_review.users SET role = 'SUBMITTER' WHERE id = ?")) {
            ps.setObject(1, reviewer.id());
            assertEquals(1, ps.executeUpdate(), "User role must be updated to SUBMITTER in DB");
        }

        HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create("http://127.0.0.1:" + port + "/actuator/metrics"))
                .GET()
                .build();

        HttpResponse<String> resp = session.client().send(req, HttpResponse.BodyHandlers.ofString());
        ReviewTestSupport.assertSafeErrorJson(resp, 403, "FORBIDDEN");
    }

    @Test
    @DisplayName("5. Low-cardinality command metrics: exact fixed tag allowlist, drives SUBMIT/DECIDE/CANCEL lifecycle, asserts timer count and duration")
    void reviewCommandMetrics_exactFixedTagsAndDynamicCommands() throws Exception {
        TestUser submitter = ReviewTestSupport.createTestUser(dataSource, trackedUsers, "cmd_sub", Role.SUBMITTER);
        TestUser reviewer = ReviewTestSupport.createTestUser(dataSource, trackedUsers, "cmd_rev", Role.REVIEWER);

        AuthenticatedSession subSession = ReviewTestSupport.loginUser(port, submitter);
        AuthenticatedSession revSession = ReviewTestSupport.loginUser(port, reviewer);

        // 1. Initial tag schema and cardinality checks on /actuator/metrics/review.commands
        HttpRequest baseReq = HttpRequest.newBuilder()
                .uri(URI.create("http://127.0.0.1:" + port + "/actuator/metrics/review.commands"))
                .GET()
                .build();
        HttpResponse<String> baseResp = revSession.client().send(baseReq, HttpResponse.BodyHandlers.ofString());
        assertEquals(200, baseResp.statusCode(), "GET /actuator/metrics/review.commands must return 200 OK for REVIEWER even before any commands run");

        JsonNode json = Json.parse(baseResp.body());
        assertEquals("review.commands", json.path("name").asText());

        JsonNode availableTags = json.path("availableTags");
        assertTrue(availableTags.isArray(), "availableTags must be an array");

        Set<String> tagNames = new HashSet<>();
        availableTags.forEach(t -> tagNames.add(t.path("tag").asText()));

        assertTrue(tagNames.contains("command"), "Tags must include 'command'");
        assertTrue(tagNames.contains("outcome"), "Tags must include 'outcome'");
        assertTrue(tagNames.size() <= 2, "Tags must be restricted to exactly fixed 'command' and 'outcome', found: " + tagNames);

        Set<String> forbiddenTagSubstrings = Set.of(
                "actor", "user", "request", "execution", "code", "comment", "token", "url", "uri", "id", "status"
        );
        for (String tagName : tagNames) {
            String lower = tagName.toLowerCase(Locale.ROOT);
            for (String forbidden : forbiddenTagSubstrings) {
                assertFalse(lower.contains(forbidden), "Tag name must not leak sensitive label: " + forbidden);
            }
        }

        Set<String> allowedCommands = Set.of("SUBMIT", "DECIDE", "CANCEL");
        Set<String> allowedOutcomes = Set.of("success", "replay", "conflict", "invalid", "validation_error", "error");

        for (JsonNode tagNode : availableTags) {
            String tag = tagNode.path("tag").asText();
            JsonNode values = tagNode.path("values");
            if ("command".equals(tag)) {
                values.forEach(v -> assertTrue(allowedCommands.contains(v.asText()), "Unexpected command value: " + v.asText()));
            } else if ("outcome".equals(tag)) {
                values.forEach(v -> assertTrue(allowedOutcomes.contains(v.asText()), "Unexpected outcome value: " + v.asText()));
            }
        }

        // Verify baseline 0.0 timer count exists before any commands run (never 404)
        TimerSnapshot submitInitial = fetchTimer(revSession, "SUBMIT", "success");
        assertEquals(0.0, submitInitial.count(), "review.commands timer must be initialized at startup with baseline 0.0 count");

        // 2. Drive SUBMIT lifecycle: success, replay, conflict, invalid
        TimerSnapshot submitBefore = fetchTimer(revSession, "SUBMIT", null);

        UUID submitKey = UUID.randomUUID();
        String validSubmitBody = Json.stringify(Json.object(
                "title", "Timer Metric Submission",
                "language", "java",
                "code", "public class TimerMetricCode {}"
        ));
        HttpRequest submitReq = HttpRequest.newBuilder()
                .uri(URI.create("http://127.0.0.1:" + port + "/api/v1/reviews"))
                .header("Content-Type", "application/json")
                .header("Idempotency-Key", submitKey.toString())
                .header(subSession.csrf().headerName(), subSession.csrf().token())
                .POST(HttpRequest.BodyPublishers.ofString(validSubmitBody))
                .build();
        HttpResponse<String> submitResp = subSession.client().send(submitReq, HttpResponse.BodyHandlers.ofString());
        assertEquals(202, submitResp.statusCode());
        UUID requestId = UUID.fromString(Json.parse(submitResp.body()).path("id").asText());
        trackedRequests.add(requestId);

        TimerSnapshot submitAfterSuccess = fetchTimer(revSession, "SUBMIT", null);
        assertTrue(submitAfterSuccess.count() > submitBefore.count(), "SUBMIT timer count must increment on success");
        assertTrue(submitAfterSuccess.totalTime() >= submitBefore.totalTime(), "SUBMIT totalTime must be non-decreasing");

        // SUBMIT: replay
        HttpResponse<String> replayResp = subSession.client().send(submitReq, HttpResponse.BodyHandlers.ofString());
        assertEquals(202, replayResp.statusCode());
        TimerSnapshot submitAfterReplay = fetchTimer(revSession, "SUBMIT", null);
        assertTrue(submitAfterReplay.count() > submitAfterSuccess.count(), "SUBMIT timer count must increment on replay");

        // SUBMIT: conflict (same key, altered payload)
        String conflictSubmitBody = Json.stringify(Json.object(
                "title", "Altered Title for Conflict",
                "language", "java",
                "code", "public class AlteredCode {}"
        ));
        HttpRequest conflictReq = HttpRequest.newBuilder()
                .uri(URI.create("http://127.0.0.1:" + port + "/api/v1/reviews"))
                .header("Content-Type", "application/json")
                .header("Idempotency-Key", submitKey.toString())
                .header(subSession.csrf().headerName(), subSession.csrf().token())
                .POST(HttpRequest.BodyPublishers.ofString(conflictSubmitBody))
                .build();
        HttpResponse<String> conflictResp = subSession.client().send(conflictReq, HttpResponse.BodyHandlers.ofString());
        assertEquals(409, conflictResp.statusCode());
        TimerSnapshot submitAfterConflict = fetchTimer(revSession, "SUBMIT", null);
        assertTrue(submitAfterConflict.count() > submitAfterReplay.count(), "SUBMIT timer count must increment on conflict");

        // SUBMIT: invalid (bad language -> 400)
        String invalidSubmitBody = Json.stringify(Json.object(
                "title", "",
                "language", "ruby",
                "code", ""
        ));
        HttpRequest invalidReq = HttpRequest.newBuilder()
                .uri(URI.create("http://127.0.0.1:" + port + "/api/v1/reviews"))
                .header("Content-Type", "application/json")
                .header("Idempotency-Key", UUID.randomUUID().toString())
                .header(subSession.csrf().headerName(), subSession.csrf().token())
                .POST(HttpRequest.BodyPublishers.ofString(invalidSubmitBody))
                .build();
        HttpResponse<String> invalidResp = subSession.client().send(invalidReq, HttpResponse.BodyHandlers.ofString());
        assertEquals(400, invalidResp.statusCode());
        TimerSnapshot submitAfterInvalid = fetchTimer(revSession, "SUBMIT", null);
        assertTrue(submitAfterInvalid.count() > submitAfterConflict.count(), "SUBMIT timer count must increment on validation error");

        // 3. Drive CANCEL lifecycle: success, replay
        TimerSnapshot cancelBefore = fetchTimer(revSession, "CANCEL", null);

        UUID cancelKey = UUID.randomUUID();
        HttpRequest cancelReq = HttpRequest.newBuilder()
                .uri(URI.create("http://127.0.0.1:" + port + "/api/v1/reviews/" + requestId + "/cancel"))
                .header("Content-Type", "application/json")
                .header("Idempotency-Key", cancelKey.toString())
                .header(subSession.csrf().headerName(), subSession.csrf().token())
                .POST(HttpRequest.BodyPublishers.noBody())
                .build();
        HttpResponse<String> cancelResp = subSession.client().send(cancelReq, HttpResponse.BodyHandlers.ofString());
        assertEquals(200, cancelResp.statusCode());

        TimerSnapshot cancelAfterSuccess = fetchTimer(revSession, "CANCEL", null);
        assertTrue(cancelAfterSuccess.count() > cancelBefore.count(), "CANCEL timer count must increment on success");
        assertTrue(cancelAfterSuccess.totalTime() >= cancelBefore.totalTime(), "CANCEL totalTime must be non-decreasing");

        HttpResponse<String> cancelReplayResp = subSession.client().send(cancelReq, HttpResponse.BodyHandlers.ofString());
        assertEquals(200, cancelReplayResp.statusCode());
        TimerSnapshot cancelAfterReplay = fetchTimer(revSession, "CANCEL", null);
        assertTrue(cancelAfterReplay.count() > cancelAfterSuccess.count(), "CANCEL timer count must increment on replay");

        // 4. Drive DECIDE lifecycle: complete a review and decide
        TimerSnapshot decideBefore = fetchTimer(revSession, "DECIDE", null);

        ReviewFixture decideFixture;
        StepAttemptFixture attemptFixture;
        try (Connection conn = dataSource.getConnection()) {
            conn.setAutoCommit(false);
            try {
                decideFixture = ReviewTestSupport.createReviewFixture(conn, engineRuntime, trackedRequests, trackedExecutions,
                        submitter.id(), "Decide Metric Review", "java", "public class DecideMetric {}", Instant.now());
                attemptFixture = ReviewTestSupport.createStepAttemptFixture(conn, environment, decideFixture.executionId());
                conn.commit();
            } catch (Exception e) {
                conn.rollback();
                throw e;
            }
        }

        ObjectNode reportOutput = Json.object(
                "score", 90,
                "findings", Json.array("Clean code"),
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
        HttpResponse<String> cbResp = ReviewTestSupport.postSignedCallback(
                port, attemptFixture.invocationId(), decideFixture.executionId().toString(), attemptFixture.logicalStepId(), reportOutput
        );
        assertEquals(204, cbResp.statusCode());

        // DECIDE: success
        UUID decideKey = UUID.randomUUID();
        String decideBody = Json.stringify(Json.object("action", "APPROVE", "comment", "Approved for timer metrics"));
        HttpRequest decideReq = HttpRequest.newBuilder()
                .uri(URI.create("http://127.0.0.1:" + port + "/api/v1/reviews/" + decideFixture.requestId() + "/decisions"))
                .header("Content-Type", "application/json")
                .header("Idempotency-Key", decideKey.toString())
                .header(revSession.csrf().headerName(), revSession.csrf().token())
                .POST(HttpRequest.BodyPublishers.ofString(decideBody))
                .build();
        HttpResponse<String> decideResp = revSession.client().send(decideReq, HttpResponse.BodyHandlers.ofString());
        assertEquals(201, decideResp.statusCode());

        TimerSnapshot decideAfterSuccess = fetchTimer(revSession, "DECIDE", null);
        assertTrue(decideAfterSuccess.count() > decideBefore.count(), "DECIDE timer count must increment on success");
        assertTrue(decideAfterSuccess.totalTime() >= decideBefore.totalTime(), "DECIDE totalTime must be non-decreasing");

        // DECIDE: replay
        HttpResponse<String> decideReplayResp = revSession.client().send(decideReq, HttpResponse.BodyHandlers.ofString());
        assertEquals(200, decideReplayResp.statusCode());
        TimerSnapshot decideAfterReplay = fetchTimer(revSession, "DECIDE", null);
        assertTrue(decideAfterReplay.count() > decideAfterSuccess.count(), "DECIDE timer count must increment on replay");

        // DECIDE: conflict (different comment with same key)
        String conflictDecideBody = Json.stringify(Json.object("action", "APPROVE", "comment", "Conflicting comment"));
        HttpRequest conflictDecideReq = HttpRequest.newBuilder()
                .uri(URI.create("http://127.0.0.1:" + port + "/api/v1/reviews/" + decideFixture.requestId() + "/decisions"))
                .header("Content-Type", "application/json")
                .header("Idempotency-Key", decideKey.toString())
                .header(revSession.csrf().headerName(), revSession.csrf().token())
                .POST(HttpRequest.BodyPublishers.ofString(conflictDecideBody))
                .build();
        HttpResponse<String> conflictDecideResp = revSession.client().send(conflictDecideReq, HttpResponse.BodyHandlers.ofString());
        assertEquals(409, conflictDecideResp.statusCode());
        TimerSnapshot decideAfterConflict = fetchTimer(revSession, "DECIDE", null);
        assertTrue(decideAfterConflict.count() > decideAfterReplay.count(), "DECIDE timer count must increment on conflict");
    }

    @Test
    @DisplayName("6. Dynamic backlog gauge: counts strictly AWAITING_REVIEW, excludes pending/cancelled/failed/decided, polling is read-only")
    void reviewBacklogGauge_lifecycleTracksAwaitingReviewExcludingOtherStates() throws Exception {
        TestUser submitter = ReviewTestSupport.createTestUser(dataSource, trackedUsers, "sub_bg", Role.SUBMITTER);
        TestUser reviewer = ReviewTestSupport.createTestUser(dataSource, trackedUsers, "rev_bg", Role.REVIEWER);
        AuthenticatedSession subSession = ReviewTestSupport.loginUser(port, submitter);
        AuthenticatedSession revSession = ReviewTestSupport.loginUser(port, reviewer);

        long auditCountBefore;
        long requestCountBefore;
        try (Connection conn = dataSource.getConnection()) {
            auditCountBefore = countRows(conn, "tenvyr_review.audit");
            requestCountBefore = countRows(conn, "tenvyr_review.requests");
        }

        double baseline = fetchBacklogGauge(revSession);

        try (Connection conn = dataSource.getConnection()) {
            assertEquals(auditCountBefore, countRows(conn, "tenvyr_review.audit"), "Gauge polling must not write to audit table");
            assertEquals(requestCountBefore, countRows(conn, "tenvyr_review.requests"), "Gauge polling must not write to requests table");
        }

        // Case 1: Review in PROCESSING state (pending) -> MUST NOT be in backlog
        ReviewFixture pendingFixture;
        try (Connection conn = dataSource.getConnection()) {
            conn.setAutoCommit(false);
            try {
                pendingFixture = ReviewTestSupport.createReviewFixture(conn, engineRuntime, trackedRequests, trackedExecutions,
                        submitter.id(), "Pending Backlog Check", "java", "public class PendingCode {}", Instant.now());
                conn.commit();
            } catch (Exception e) {
                conn.rollback();
                throw e;
            }
        }
        assertEquals(baseline, fetchBacklogGauge(revSession), 0.001, "PENDING review must NOT increment backlog");

        // Case 2: Review in CANCELLED state via accepted HTTP cancel -> MUST NOT be in backlog
        ReviewFixture cancelFixture;
        try (Connection conn = dataSource.getConnection()) {
            conn.setAutoCommit(false);
            try {
                cancelFixture = ReviewTestSupport.createReviewFixture(conn, engineRuntime, trackedRequests, trackedExecutions,
                        submitter.id(), "Cancel Backlog Check", "java", "public class CancelCode {}", Instant.now());
                conn.commit();
            } catch (Exception e) {
                conn.rollback();
                throw e;
            }
        }
        UUID cancelKey = UUID.randomUUID();
        HttpRequest cancelReq = HttpRequest.newBuilder()
                .uri(URI.create("http://127.0.0.1:" + port + "/api/v1/reviews/" + cancelFixture.requestId() + "/cancel"))
                .header("Content-Type", "application/json")
                .header("Idempotency-Key", cancelKey.toString())
                .header(subSession.csrf().headerName(), subSession.csrf().token())
                .POST(HttpRequest.BodyPublishers.noBody())
                .build();
        HttpResponse<String> cancelResp = subSession.client().send(cancelReq, HttpResponse.BodyHandlers.ofString());
        assertEquals(200, cancelResp.statusCode(), "Cancel review must succeed (200)");
        assertEquals(baseline, fetchBacklogGauge(revSession), 0.001, "CANCELLED review must NOT increment backlog");

        // Case 3: Review in FAILED state (invalid report) -> MUST NOT be in backlog
        ReviewFixture failedFixture;
        StepAttemptFixture failedAttempt;
        try (Connection conn = dataSource.getConnection()) {
            conn.setAutoCommit(false);
            try {
                failedFixture = ReviewTestSupport.createReviewFixture(conn, engineRuntime, trackedRequests, trackedExecutions,
                        submitter.id(), "Failed Report Review", "java", "public class FailedCode {}", Instant.now());
                failedAttempt = ReviewTestSupport.createStepAttemptFixture(conn, environment, failedFixture.executionId());
                conn.commit();
            } catch (Exception e) {
                conn.rollback();
                throw e;
            }
        }
        ObjectNode invalidOutput = Json.object(
                "score", -10,
                "findings", Json.array("Invalid"),
                "_tenvyr", Json.object("metadata", Json.object("mode", "MOCK"))
        );
        HttpResponse<String> failCbResp = ReviewTestSupport.postSignedCallback(
                port, failedAttempt.invocationId(), failedFixture.executionId().toString(), failedAttempt.logicalStepId(), invalidOutput
        );
        assertEquals(204, failCbResp.statusCode());
        assertEquals(baseline, fetchBacklogGauge(revSession), 0.001, "FAILED review (invalid report) must NOT increment backlog");

        // Case 4: Review with valid completed report -> transitions to AWAITING_REVIEW -> MUST increment backlog (+1.0)
        ReviewFixture validFixture;
        StepAttemptFixture validAttempt;
        try (Connection conn = dataSource.getConnection()) {
            conn.setAutoCommit(false);
            try {
                validFixture = ReviewTestSupport.createReviewFixture(conn, engineRuntime, trackedRequests, trackedExecutions,
                        submitter.id(), "Valid Report Review", "java", "public class ValidCode {}", Instant.now());
                validAttempt = ReviewTestSupport.createStepAttemptFixture(conn, environment, validFixture.executionId());
                conn.commit();
            } catch (Exception e) {
                conn.rollback();
                throw e;
            }
        }
        ObjectNode validOutput = Json.object(
                "score", 88,
                "findings", Json.array("Finding A"),
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
        HttpResponse<String> validCbResp = ReviewTestSupport.postSignedCallback(
                port, validAttempt.invocationId(), validFixture.executionId().toString(), validAttempt.logicalStepId(), validOutput
        );
        assertEquals(204, validCbResp.statusCode());
        assertEquals(baseline + 1.0, fetchBacklogGauge(revSession), 0.001,
                "Valid completed review in AWAITING_REVIEW must increment backlog gauge by 1.0");

        // Case 5: Review decided by reviewer -> transitions to APPROVED -> MUST decrement backlog back to baseline
        UUID idempotencyKey = UUID.randomUUID();
        String decisionBody = Json.stringify(Json.object("action", "APPROVE", "comment", "Approved for backlog test"));
        HttpRequest decideReq = HttpRequest.newBuilder()
                .uri(URI.create("http://127.0.0.1:" + port + "/api/v1/reviews/" + validFixture.requestId() + "/decisions"))
                .header("Content-Type", "application/json")
                .header("Idempotency-Key", idempotencyKey.toString())
                .header(revSession.csrf().headerName(), revSession.csrf().token())
                .POST(HttpRequest.BodyPublishers.ofString(decisionBody, StandardCharsets.UTF_8))
                .build();
        HttpResponse<String> decideResp = revSession.client().send(decideReq, HttpResponse.BodyHandlers.ofString());
        assertEquals(201, decideResp.statusCode(), "Decision must be created (201)");

        assertEquals(baseline, fetchBacklogGauge(revSession), 0.001,
                "Decided review (APPROVED) must decrement backlog gauge back to baseline");
    }

    @Test
    @DisplayName("7. Bounded resource configuration: asserts Hikari type, pool bounds 10/2s, and Tomcat 50/50")
    void capacitySettings_boundedResourcesAndNoClaims() {
        assertInstanceOf(
                com.zaxxer.hikari.HikariDataSource.class,
                dataSource,
                "DataSource must be an instance of HikariDataSource"
        );
        com.zaxxer.hikari.HikariDataSource hikari = (com.zaxxer.hikari.HikariDataSource) dataSource;
        assertEquals(10, hikari.getMaximumPoolSize(), "Hikari maximum-pool-size must be bounded at 10");
        assertEquals(2000L, hikari.getConnectionTimeout(), "Hikari connection acquisition timeout must be 2000ms");

        Integer maxThreads = environment.getProperty("server.tomcat.threads.max", Integer.class);
        assertNotNull(maxThreads, "server.tomcat.threads.max must be explicitly configured");
        assertEquals(50, maxThreads.intValue(), "server.tomcat.threads.max must be 50");

        Integer acceptCount = environment.getProperty("server.tomcat.accept-count", Integer.class);
        assertNotNull(acceptCount, "server.tomcat.accept-count must be explicitly configured");
        assertEquals(50, acceptCount.intValue(), "server.tomcat.accept-count must be 50");
    }

    private record TimerSnapshot(double count, double totalTime) {}

    private TimerSnapshot fetchTimer(AuthenticatedSession session, String command, String outcome) throws Exception {
        String uri = "http://127.0.0.1:" + port + "/actuator/metrics/review.commands";
        List<String> queryParams = new ArrayList<>();
        if (command != null) queryParams.add("tag=command:" + command);
        if (outcome != null) queryParams.add("tag=outcome:" + outcome);
        if (!queryParams.isEmpty()) {
            uri += "?" + String.join("&", queryParams);
        }

        HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create(uri))
                .GET()
                .build();
        HttpResponse<String> resp = session.client().send(req, HttpResponse.BodyHandlers.ofString());
        assertEquals(200, resp.statusCode(), "GET " + uri + " must return 200 OK for REVIEWER");

        JsonNode json = Json.parse(resp.body());
        JsonNode measurements = json.path("measurements");
        double count = 0;
        double totalTime = 0;
        if (measurements.isArray()) {
            for (JsonNode m : measurements) {
                String stat = m.path("statistic").asText();
                if ("COUNT".equalsIgnoreCase(stat)) {
                    count = m.path("value").asDouble();
                } else if ("TOTAL_TIME".equalsIgnoreCase(stat)) {
                    totalTime = m.path("value").asDouble();
                }
            }
        }
        return new TimerSnapshot(count, totalTime);
    }

    private double fetchBacklogGauge(AuthenticatedSession session) throws Exception {
        HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create("http://127.0.0.1:" + port + "/actuator/metrics/review.backlog"))
                .GET()
                .build();
        HttpResponse<String> resp = session.client().send(req, HttpResponse.BodyHandlers.ofString());
        assertEquals(200, resp.statusCode(), "GET /actuator/metrics/review.backlog must return 200 OK");

        JsonNode json = Json.parse(resp.body());
        JsonNode measurements = json.path("measurements");
        assertTrue(measurements.isArray() && measurements.size() > 0, "review.backlog measurements must be non-empty");

        return measurements.get(0).path("value").asDouble();
    }

    private long countRows(Connection conn, String table) throws SQLException {
        try (PreparedStatement ps = conn.prepareStatement("SELECT count(*) FROM " + table);
             ResultSet rs = ps.executeQuery()) {
            assertTrue(rs.next());
            return rs.getLong(1);
        }
    }
}
