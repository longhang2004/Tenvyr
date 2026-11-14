package io.tenvyr.review;

import com.fasterxml.jackson.databind.JsonNode;
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
import java.io.ByteArrayInputStream;
import java.net.URI;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.*;

/**
 * T04 Integration Test: Atomic Idempotent Review Submission (POST /api/v1/reviews).
 * Requires real disposable PostgreSQL (no H2/mocks).
 * Verifies initial 202+Location, equivalent replay with identical IDs, conflicting payload 409,
 * 16 parallel submissions under same owner/key producing single execution and audit,
 * two owners independence with same key, role/CSRF/disabled defenses, streaming body bounds,
 * real PG fault-injection with zero residuals, and lock timeout safe 503 Retry-After after rollback.
 */
@SpringBootTest(
        classes = {ReviewApplication.class, ReviewSubmissionIT.TestHookConfiguration.class},
        webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = {
                "HTTP_AGENT_ALLOW_INSECURE=true",
                "HTTP_AGENT_CALLBACK_BASE_URL=http://127.0.0.1:8080",
                "TEST_SECRET=" + ReviewTestSupport.TEST_SECRET,
                "TEST_TOKEN=" + ReviewTestSupport.TEST_TOKEN
        }
)
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
public class ReviewSubmissionIT {

    @org.springframework.boot.test.context.TestConfiguration
    public static class TestHookConfiguration {
        @org.springframework.context.annotation.Bean
        public ReviewService.PostMaterializationObserver postMaterializationObserver() {
            return (connection, executionId) -> {
                if (ReviewTestSupport.postMaterializationHook != null) {
                    ReviewTestSupport.postMaterializationHook.onMaterialized(connection, executionId);
                }
            };
        }
    }

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
        ReviewTestSupport.postMaterializationHook = null;
        ReviewTestSupport.cleanup(dataSource, trackedUsers, trackedRequests, trackedExecutions);
    }

    private String reviewsUrl() {
        return "http://127.0.0.1:" + port + "/api/v1/reviews";
    }

    @Test
    @DisplayName("First meaningful test: POST /api/v1/reviews returns 202 with Location and summary, equivalent replay returns same IDs, and payload conflict returns 409")
    void postReviewReturns202_equivalentReplayReturnsSameIds_conflictingPayloadReturns409() throws Exception {
        ReviewTestSupport.TestUser submitter = ReviewTestSupport.createTestUser(
                dataSource, trackedUsers, "sub_idemp", Role.SUBMITTER);
        ReviewTestSupport.AuthenticatedSession session = ReviewTestSupport.loginUser(port, submitter);

        UUID idempotencyKey = UUID.randomUUID();
        Map<String, Object> initialPayload = Map.of(
                "title", "Initial Clean Review Submission",
                "language", "java",
                "code", "public class SampleTest { int value = 42; }"
        );

        HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create(reviewsUrl()))
                .header("Content-Type", "application/json")
                .header(session.csrf().headerName(), session.csrf().token())
                .header("Idempotency-Key", idempotencyKey.toString())
                .POST(HttpRequest.BodyPublishers.ofString(Json.stringify(Json.value(initialPayload))))
                .build();

        HttpResponse<String> resp1 = session.client().send(req, HttpResponse.BodyHandlers.ofString());

        // 1. Initial submission asserts 202 Accepted (absent route returns 404, giving behavioral RED)
        assertEquals(202, resp1.statusCode(), "Initial review submission must return 202 Accepted");

        String locationHeader = resp1.headers().firstValue("Location").orElse("");
        assertFalse(locationHeader.isBlank(), "Response must include non-blank Location header");
        assertTrue(locationHeader.contains("/api/v1/reviews/"), "Location header must point to /api/v1/reviews/{id}");

        JsonNode body1 = Json.parse(resp1.body());
        assertTrue(body1.hasNonNull("id"), "Submission response must include request id");
        assertTrue(body1.hasNonNull("executionId"), "Submission response must include executionId");
        assertEquals("PROCESSING", body1.path("status").asText(), "Initial status must be PROCESSING");

        UUID requestId1 = UUID.fromString(body1.path("id").asText());
        UUID executionId1 = UUID.fromString(body1.path("executionId").asText());
        trackedRequests.add(requestId1);
        trackedExecutions.add(executionId1);

        // Verify Location header contains exact request ID
        assertTrue(locationHeader.endsWith(requestId1.toString()),
                "Location header must end with created request ID: " + locationHeader);

        // 2. Equivalent replay: same owner, same key, identical payload returns 202 and identical IDs
        HttpResponse<String> respReplay = session.client().send(req, HttpResponse.BodyHandlers.ofString());
        assertEquals(202, respReplay.statusCode(), "Equivalent replay must return 202 Accepted");

        JsonNode bodyReplay = Json.parse(respReplay.body());
        assertEquals(requestId1.toString(), bodyReplay.path("id").asText(),
                "Equivalent replay must return original request ID");
        assertEquals(executionId1.toString(), bodyReplay.path("executionId").asText(),
                "Equivalent replay must return original execution ID");

        String replayLocation = respReplay.headers().firstValue("Location").orElse("");
        assertEquals(locationHeader, replayLocation, "Equivalent replay must return identical Location header");

        // 3. Conflicting replay: same owner, same key, altered title returns 409 Conflict
        Map<String, Object> alteredPayload = Map.of(
                "title", "Altered Title Review Submission",
                "language", "java",
                "code", "public class SampleTest { int value = 42; }"
        );
        HttpRequest conflictReq = HttpRequest.newBuilder()
                .uri(URI.create(reviewsUrl()))
                .header("Content-Type", "application/json")
                .header(session.csrf().headerName(), session.csrf().token())
                .header("Idempotency-Key", idempotencyKey.toString())
                .POST(HttpRequest.BodyPublishers.ofString(Json.stringify(Json.value(alteredPayload))))
                .build();

        HttpResponse<String> respConflict = session.client().send(conflictReq, HttpResponse.BodyHandlers.ofString());
        ReviewTestSupport.assertSafeErrorJson(respConflict, 409, "IDEMPOTENCY_CONFLICT");
    }

    @Test
    @DisplayName("16 parallel same owner and key submissions produce exactly one request, execution, and SUBMIT audit entry")
    void parallelSixteenSameOwnerAndKey_createsSingleRequestAndExecutionAndAudit() throws Exception {
        ReviewTestSupport.TestUser submitter = ReviewTestSupport.createTestUser(
                dataSource, trackedUsers, "sub_par16", Role.SUBMITTER);
        ReviewTestSupport.AuthenticatedSession session = ReviewTestSupport.loginUser(port, submitter);

        UUID idempotencyKey = UUID.randomUUID();
        Map<String, Object> payload = Map.of(
                "title", "Parallel 16 Concurrent Review Submission",
                "language", "typescript",
                "code", "export function calculateTotal(items: number[]): number { return items.reduce((a, b) => a + b, 0); }"
        );
        String bodyJson = Json.stringify(Json.value(payload));

        int concurrency = 16;
        ExecutorService executor = Executors.newFixedThreadPool(concurrency);
        try {
            CyclicBarrier barrier = new CyclicBarrier(concurrency);
            List<Future<HttpResponse<String>>> futures = new ArrayList<>();

            for (int i = 0; i < concurrency; i++) {
                futures.add(executor.submit(() -> {
                    barrier.await(5, TimeUnit.SECONDS);
                    HttpRequest req = HttpRequest.newBuilder()
                            .uri(URI.create(reviewsUrl()))
                            .header("Content-Type", "application/json")
                            .header(session.csrf().headerName(), session.csrf().token())
                            .header("Idempotency-Key", idempotencyKey.toString())
                            .POST(HttpRequest.BodyPublishers.ofString(bodyJson))
                            .build();
                    return session.client().send(req, HttpResponse.BodyHandlers.ofString());
                }));
            }

            Set<String> observedRequestIds = new HashSet<>();
            Set<String> observedExecutionIds = new HashSet<>();

            for (Future<HttpResponse<String>> future : futures) {
                HttpResponse<String> resp = future.get(10, TimeUnit.SECONDS);
                assertEquals(202, resp.statusCode(), "All parallel same-key submissions must return 202 Accepted");

                JsonNode body = Json.parse(resp.body());
                String reqId = body.path("id").asText();
                String execId = body.path("executionId").asText();
                assertFalse(reqId.isBlank());
                assertFalse(execId.isBlank());

                observedRequestIds.add(reqId);
                observedExecutionIds.add(execId);
            }

            // Exactly one identity returned across all 16 parallel attempts
            assertEquals(1, observedRequestIds.size(), "All 16 threads must receive the exact same request ID");
            assertEquals(1, observedExecutionIds.size(), "All 16 threads must receive the exact same execution ID");

            UUID singleRequestId = UUID.fromString(observedRequestIds.iterator().next());
            UUID singleExecutionId = UUID.fromString(observedExecutionIds.iterator().next());
            trackedRequests.add(singleRequestId);
            trackedExecutions.add(singleExecutionId);

            // Assert durable storage: exactly 1 request row, 1 execution row, 1 SUBMIT audit row
            try (Connection conn = dataSource.getConnection()) {
                try (PreparedStatement ps = conn.prepareStatement(
                        "SELECT count(*) FROM tenvyr_review.requests WHERE owner_id = ? AND idempotency_key = ?")) {
                    ps.setObject(1, submitter.id());
                    ps.setObject(2, idempotencyKey);
                    try (ResultSet rs = ps.executeQuery()) {
                        assertTrue(rs.next());
                        assertEquals(1, rs.getInt(1), "Exactly one request row must exist for (owner, idempotency_key)");
                    }
                }

                try (PreparedStatement ps = conn.prepareStatement(
                        "SELECT count(*) FROM executions WHERE id = ?")) {
                    ps.setObject(1, singleExecutionId);
                    try (ResultSet rs = ps.executeQuery()) {
                        assertTrue(rs.next());
                        assertEquals(1, rs.getInt(1), "Exactly one execution row must exist for materialized execution");
                    }
                }

                try (PreparedStatement ps = conn.prepareStatement(
                        "SELECT count(*) FROM tenvyr_review.audit WHERE actor_id = ? AND action = 'SUBMIT' AND operation_key = ?")) {
                    ps.setObject(1, submitter.id());
                    ps.setObject(2, idempotencyKey);
                    try (ResultSet rs = ps.executeQuery()) {
                        assertTrue(rs.next());
                        assertEquals(1, rs.getInt(1), "Exactly one SUBMIT audit row must exist for (actor, SUBMIT, operation_key)");
                    }
                }
            }
        } finally {
            executor.shutdown();
            executor.awaitTermination(5, TimeUnit.SECONDS);
        }
    }

    @Test
    @DisplayName("Two different owners submitting with the same Idempotency-Key UUID are completely independent")
    void twoOwnersWithSameIdempotencyKey_areIndependent() throws Exception {
        ReviewTestSupport.TestUser submitterA = ReviewTestSupport.createTestUser(
                dataSource, trackedUsers, "sub_owner_a", Role.SUBMITTER);
        ReviewTestSupport.TestUser submitterB = ReviewTestSupport.createTestUser(
                dataSource, trackedUsers, "sub_owner_b", Role.SUBMITTER);

        ReviewTestSupport.AuthenticatedSession sessionA = ReviewTestSupport.loginUser(port, submitterA);
        ReviewTestSupport.AuthenticatedSession sessionB = ReviewTestSupport.loginUser(port, submitterB);

        UUID sharedIdempotencyKey = UUID.randomUUID();

        Map<String, Object> payloadA = Map.of(
                "title", "Owner A Review Submission",
                "language", "python",
                "code", "def handle_event(e): return e.get('type')"
        );
        Map<String, Object> payloadB = Map.of(
                "title", "Owner B Review Submission",
                "language", "python",
                "code", "def process_data(d): return len(d)"
        );

        HttpRequest reqA = HttpRequest.newBuilder()
                .uri(URI.create(reviewsUrl()))
                .header("Content-Type", "application/json")
                .header(sessionA.csrf().headerName(), sessionA.csrf().token())
                .header("Idempotency-Key", sharedIdempotencyKey.toString())
                .POST(HttpRequest.BodyPublishers.ofString(Json.stringify(Json.value(payloadA))))
                .build();

        HttpRequest reqB = HttpRequest.newBuilder()
                .uri(URI.create(reviewsUrl()))
                .header("Content-Type", "application/json")
                .header(sessionB.csrf().headerName(), sessionB.csrf().token())
                .header("Idempotency-Key", sharedIdempotencyKey.toString())
                .POST(HttpRequest.BodyPublishers.ofString(Json.stringify(Json.value(payloadB))))
                .build();

        HttpResponse<String> respA = sessionA.client().send(reqA, HttpResponse.BodyHandlers.ofString());
        assertEquals(202, respA.statusCode(), "Submitter A must receive 202 Accepted");

        HttpResponse<String> respB = sessionB.client().send(reqB, HttpResponse.BodyHandlers.ofString());
        assertEquals(202, respB.statusCode(), "Submitter B must receive 202 Accepted despite same idempotency key");

        JsonNode bodyA = Json.parse(respA.body());
        JsonNode bodyB = Json.parse(respB.body());

        UUID reqIdA = UUID.fromString(bodyA.path("id").asText());
        UUID reqIdB = UUID.fromString(bodyB.path("id").asText());
        UUID execIdA = UUID.fromString(bodyA.path("executionId").asText());
        UUID execIdB = UUID.fromString(bodyB.path("executionId").asText());

        trackedRequests.add(reqIdA);
        trackedRequests.add(reqIdB);
        trackedExecutions.add(execIdA);
        trackedExecutions.add(execIdB);

        assertNotEquals(reqIdA, reqIdB, "Requests under different owners must have distinct request IDs");
        assertNotEquals(execIdA, execIdB, "Requests under different owners must have distinct execution IDs");

        try (Connection conn = dataSource.getConnection()) {
            try (PreparedStatement ps = conn.prepareStatement(
                    "SELECT count(*) FROM tenvyr_review.requests WHERE idempotency_key = ?")) {
                ps.setObject(1, sharedIdempotencyKey);
                try (ResultSet rs = ps.executeQuery()) {
                    assertTrue(rs.next());
                    assertEquals(2, rs.getInt(1), "Both independent requests must exist in tenvyr_review.requests");
                }
            }
        }
    }

    @Test
    @DisplayName("Reviewer role cannot submit reviews and receives 403 Forbidden safe error")
    void postReviewRequiresSubmitterRole_reviewerIsDenied403() throws Exception {
        ReviewTestSupport.TestUser reviewer = ReviewTestSupport.createTestUser(
                dataSource, trackedUsers, "rev_denied_sub", Role.REVIEWER);
        ReviewTestSupport.AuthenticatedSession session = ReviewTestSupport.loginUser(port, reviewer);

        UUID key = UUID.randomUUID();
        Map<String, Object> payload = Map.of(
                "title", "Reviewer Attempting Submission",
                "language", "java",
                "code", "class IllegalReviewerSubmission {}"
        );

        HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create(reviewsUrl()))
                .header("Content-Type", "application/json")
                .header(session.csrf().headerName(), session.csrf().token())
                .header("Idempotency-Key", key.toString())
                .POST(HttpRequest.BodyPublishers.ofString(Json.stringify(Json.value(payload))))
                .build();

        HttpResponse<String> resp = session.client().send(req, HttpResponse.BodyHandlers.ofString());
        ReviewTestSupport.assertSafeErrorJson(resp, 403, "FORBIDDEN");
    }

    @Test
    @DisplayName("Review submission without CSRF token returns 403 Forbidden safe error")
    void postReviewRequiresValidCsrf_missingCsrfReturns403() throws Exception {
        ReviewTestSupport.TestUser submitter = ReviewTestSupport.createTestUser(
                dataSource, trackedUsers, "sub_nocsrf", Role.SUBMITTER);
        ReviewTestSupport.AuthenticatedSession session = ReviewTestSupport.loginUser(port, submitter);

        UUID key = UUID.randomUUID();
        Map<String, Object> payload = Map.of(
                "title", "Submission Without CSRF",
                "language", "java",
                "code", "class NoCsrfTest {}"
        );

        HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create(reviewsUrl()))
                .header("Content-Type", "application/json")
                .header("Idempotency-Key", key.toString())
                .POST(HttpRequest.BodyPublishers.ofString(Json.stringify(Json.value(payload))))
                .build();

        HttpResponse<String> resp = session.client().send(req, HttpResponse.BodyHandlers.ofString());
        ReviewTestSupport.assertSafeErrorJson(resp, 403, "FORBIDDEN");
    }

    @Test
    @DisplayName("Disabled user session is rejected with 401 Unauthorized safe error")
    void disabledUserReceives401Unauthorized() throws Exception {
        ReviewTestSupport.TestUser submitter = ReviewTestSupport.createTestUser(
                dataSource, trackedUsers, "sub_disabled", Role.SUBMITTER);
        ReviewTestSupport.AuthenticatedSession session = ReviewTestSupport.loginUser(port, submitter);

        // Disable user in database while session cookie remains valid
        try (Connection conn = dataSource.getConnection();
             PreparedStatement ps = conn.prepareStatement("UPDATE tenvyr_review.users SET enabled = false WHERE id = ?")) {
            ps.setObject(1, submitter.id());
            assertEquals(1, ps.executeUpdate());
        }

        UUID key = UUID.randomUUID();
        Map<String, Object> payload = Map.of(
                "title", "Disabled User Attempt",
                "language", "java",
                "code", "class DisabledUserTest {}"
        );

        HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create(reviewsUrl()))
                .header("Content-Type", "application/json")
                .header(session.csrf().headerName(), session.csrf().token())
                .header("Idempotency-Key", key.toString())
                .POST(HttpRequest.BodyPublishers.ofString(Json.stringify(Json.value(payload))))
                .build();

        HttpResponse<String> resp = session.client().send(req, HttpResponse.BodyHandlers.ofString());
        ReviewTestSupport.assertSafeErrorJson(resp, 401, "UNAUTHORIZED");
    }

    @Test
    @DisplayName("Review submission rejects missing key, invalid key, blank code, invalid language, and oversize bounds with 400 Bad Request, accepting exact 65536 UTF-8 bytes with CJK filler")
    void postReviewValidationRejectsBlankCode_invalidLanguage_oversizeCode_missingKey() throws Exception {
        ReviewTestSupport.TestUser submitter = ReviewTestSupport.createTestUser(
                dataSource, trackedUsers, "sub_validation", Role.SUBMITTER);
        ReviewTestSupport.AuthenticatedSession session = ReviewTestSupport.loginUser(port, submitter);

        // 1. Missing Idempotency-Key header -> 400
        Map<String, Object> validPayload = Map.of(
                "title", "Valid Title",
                "language", "java",
                "code", "class Valid {}"
        );
        HttpRequest reqMissingKey = HttpRequest.newBuilder()
                .uri(URI.create(reviewsUrl()))
                .header("Content-Type", "application/json")
                .header(session.csrf().headerName(), session.csrf().token())
                .POST(HttpRequest.BodyPublishers.ofString(Json.stringify(Json.value(validPayload))))
                .build();
        HttpResponse<String> respMissingKey = session.client().send(reqMissingKey, HttpResponse.BodyHandlers.ofString());
        ReviewTestSupport.assertSafeErrorJson(respMissingKey, 400, "BAD_REQUEST");

        // 2. Invalid non-UUID Idempotency-Key header -> 400
        HttpRequest reqInvalidKey = HttpRequest.newBuilder()
                .uri(URI.create(reviewsUrl()))
                .header("Content-Type", "application/json")
                .header(session.csrf().headerName(), session.csrf().token())
                .header("Idempotency-Key", "not-a-valid-uuid-format")
                .POST(HttpRequest.BodyPublishers.ofString(Json.stringify(Json.value(validPayload))))
                .build();
        HttpResponse<String> respInvalidKey = session.client().send(reqInvalidKey, HttpResponse.BodyHandlers.ofString());
        ReviewTestSupport.assertSafeErrorJson(respInvalidKey, 400, "BAD_REQUEST");

        // 3. Blank code -> 400
        Map<String, Object> blankCodePayload = Map.of(
                "title", "Valid Title",
                "language", "java",
                "code", "   \t\n  "
        );
        HttpRequest reqBlankCode = HttpRequest.newBuilder()
                .uri(URI.create(reviewsUrl()))
                .header("Content-Type", "application/json")
                .header(session.csrf().headerName(), session.csrf().token())
                .header("Idempotency-Key", UUID.randomUUID().toString())
                .POST(HttpRequest.BodyPublishers.ofString(Json.stringify(Json.value(blankCodePayload))))
                .build();
        HttpResponse<String> respBlankCode = session.client().send(reqBlankCode, HttpResponse.BodyHandlers.ofString());
        ReviewTestSupport.assertSafeErrorJson(respBlankCode, 400, "BAD_REQUEST");

        // 4. Invalid language (not in 'java', 'typescript', 'python') -> 400
        Map<String, Object> invalidLangPayload = Map.of(
                "title", "Valid Title",
                "language", "ruby",
                "code", "puts 'hello'"
        );
        HttpRequest reqInvalidLang = HttpRequest.newBuilder()
                .uri(URI.create(reviewsUrl()))
                .header("Content-Type", "application/json")
                .header(session.csrf().headerName(), session.csrf().token())
                .header("Idempotency-Key", UUID.randomUUID().toString())
                .POST(HttpRequest.BodyPublishers.ofString(Json.stringify(Json.value(invalidLangPayload))))
                .build();
        HttpResponse<String> respInvalidLang = session.client().send(reqInvalidLang, HttpResponse.BodyHandlers.ofString());
        ReviewTestSupport.assertSafeErrorJson(respInvalidLang, 400, "BAD_REQUEST");

        // 5. Title exceeding 160 UTF-16 code units -> 400
        String oversizeTitle = "t".repeat(161);
        Map<String, Object> oversizeTitlePayload = Map.of(
                "title", oversizeTitle,
                "language", "java",
                "code", "class Valid {}"
        );
        HttpRequest reqOversizeTitle = HttpRequest.newBuilder()
                .uri(URI.create(reviewsUrl()))
                .header("Content-Type", "application/json")
                .header(session.csrf().headerName(), session.csrf().token())
                .header("Idempotency-Key", UUID.randomUUID().toString())
                .POST(HttpRequest.BodyPublishers.ofString(Json.stringify(Json.value(oversizeTitlePayload))))
                .build();
        HttpResponse<String> respOversizeTitle = session.client().send(reqOversizeTitle, HttpResponse.BodyHandlers.ofString());
        ReviewTestSupport.assertSafeErrorJson(respOversizeTitle, 400, "BAD_REQUEST");

        // 6. Calibrated CJK + ASCII code boundary: exact 65,536 UTF-8 bytes accepted, 65,537 rejected
        // CJK character "中" is 3 UTF-8 bytes: 21,845 * 3 = 65,535 bytes + 1 ASCII byte = 65,536 bytes
        String exact65536Code = "中".repeat(21845) + "a";
        byte[] exact65536Bytes = exact65536Code.getBytes(StandardCharsets.UTF_8);
        assertEquals(65536, exact65536Bytes.length, "Calibrated CJK+ASCII code must be exactly 65,536 bytes");
        assertTrue(exact65536Code.length() < 65536, "UTF-16 unit length (21846) is strictly less than byte count");

        UUID validBoundaryKey = UUID.randomUUID();
        Map<String, Object> exactBoundaryPayload = Map.of(
                "title", "Valid Exact 65536 Boundary",
                "language", "java",
                "code", exact65536Code
        );
        HttpRequest reqExactBoundary = HttpRequest.newBuilder()
                .uri(URI.create(reviewsUrl()))
                .header("Content-Type", "application/json")
                .header(session.csrf().headerName(), session.csrf().token())
                .header("Idempotency-Key", validBoundaryKey.toString())
                .POST(HttpRequest.BodyPublishers.ofString(Json.stringify(Json.value(exactBoundaryPayload))))
                .build();
        HttpResponse<String> respExactBoundary = session.client().send(reqExactBoundary, HttpResponse.BodyHandlers.ofString());
        assertEquals(202, respExactBoundary.statusCode(), "Exact 65,536 UTF-8 byte code must be accepted (202)");
        JsonNode boundaryBody = Json.parse(respExactBoundary.body());
        trackedRequests.add(UUID.fromString(boundaryBody.path("id").asText()));
        trackedExecutions.add(UUID.fromString(boundaryBody.path("executionId").asText()));

        // 65,537 UTF-8 bytes: 21,845 * 3 + 2 ASCII bytes = 65,537 bytes -> 400
        String oversize65537Code = "中".repeat(21845) + "ab";
        byte[] oversizeBytes = oversize65537Code.getBytes(StandardCharsets.UTF_8);
        assertEquals(65537, oversizeBytes.length, "Calibrated CJK+ASCII code must be exactly 65,537 bytes");

        Map<String, Object> oversizeCodePayload = Map.of(
                "title", "Oversize 65537 Boundary",
                "language", "java",
                "code", oversize65537Code
        );
        HttpRequest reqOversizeCode = HttpRequest.newBuilder()
                .uri(URI.create(reviewsUrl()))
                .header("Content-Type", "application/json")
                .header(session.csrf().headerName(), session.csrf().token())
                .header("Idempotency-Key", UUID.randomUUID().toString())
                .POST(HttpRequest.BodyPublishers.ofString(Json.stringify(Json.value(oversizeCodePayload))))
                .build();
        HttpResponse<String> respOversizeCode = session.client().send(reqOversizeCode, HttpResponse.BodyHandlers.ofString());
        ReviewTestSupport.assertSafeErrorJson(respOversizeCode, 400, "BAD_REQUEST");
    }

    @Test
    @DisplayName("Chunked authenticated HTTP request body > 1 MiB with unknown Content-Length returns 413 Payload Too Large before JSON allocation")
    void chunkedBodyBeyondOneMegabyte_withUnknownContentLength_returns413BeforeJsonAllocation() throws Exception {
        ReviewTestSupport.TestUser submitter = ReviewTestSupport.createTestUser(
                dataSource, trackedUsers, "sub_chunked_limit", Role.SUBMITTER);
        ReviewTestSupport.AuthenticatedSession session = ReviewTestSupport.loginUser(port, submitter);

        // 1 MiB = 1,048,576 bytes; generate 1,048,577 bytes
        byte[] oversizeRaw = new byte[1048577];
        Arrays.fill(oversizeRaw, (byte) 'x');

        // BodyPublishers.ofInputStream without length publishes chunked transfer with unknown Content-Length
        HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create(reviewsUrl()))
                .header("Content-Type", "application/json")
                .header(session.csrf().headerName(), session.csrf().token())
                .header("Idempotency-Key", UUID.randomUUID().toString())
                .POST(HttpRequest.BodyPublishers.ofInputStream(() -> new ByteArrayInputStream(oversizeRaw)))
                .build();

        HttpResponse<String> resp = session.client().send(req, HttpResponse.BodyHandlers.ofString());
        ReviewTestSupport.assertSafeErrorJson(resp, 413, "PAYLOAD_TOO_LARGE");
    }

    @Test
    @DisplayName("Real PG fault-injection after engine materialization rolls back all rows, leaving zero executions, plans, steps, requests, or audits")
    void realPostgresFaultInjection_rollsBackEngineExecutionAndAudit_zeroResiduals() throws Exception {
        ReviewTestSupport.TestUser submitter = ReviewTestSupport.createTestUser(
                dataSource, trackedUsers, "sub_fault_inj", Role.SUBMITTER);
        ReviewTestSupport.AuthenticatedSession session = ReviewTestSupport.loginUser(port, submitter);

        UUID idempotencyKey = UUID.randomUUID();
        AtomicReference<UUID> capturedExecutionId = new AtomicReference<>();
        AtomicBoolean hookInvoked = new AtomicBoolean(false);

        // Configure test-local seam invoked after engine materialization inside the submit transaction
        ReviewTestSupport.postMaterializationHook = (conn, executionId) -> {
            hookInvoked.set(true);
            capturedExecutionId.set(executionId);
            assertNotNull(executionId, "Materialized execution UUID must not be null");

            // Assert actual materialized rows exist inside the active transaction
            try (PreparedStatement ps = conn.prepareStatement("SELECT count(*) FROM executions WHERE id = ?")) {
                ps.setObject(1, executionId);
                try (ResultSet rs = ps.executeQuery()) {
                    assertTrue(rs.next());
                    assertEquals(1, rs.getInt(1), "Execution must be materialized inside the active transaction");
                }
            }
            try (PreparedStatement ps = conn.prepareStatement(
                    "SELECT count(*) FROM execution_plan_revisions WHERE \"executionId\" = ?")) {
                ps.setObject(1, executionId);
                try (ResultSet rs = ps.executeQuery()) {
                    assertTrue(rs.next());
                    assertTrue(rs.getInt(1) >= 1, "Execution plan revision must be materialized inside the active transaction");
                }
            }
            try (PreparedStatement ps = conn.prepareStatement(
                    "SELECT count(*) FROM step_executions WHERE \"executionId\" = ?")) {
                ps.setObject(1, executionId);
                try (ResultSet rs = ps.executeQuery()) {
                    assertTrue(rs.next());
                    assertTrue(rs.getInt(1) >= 1, "Step execution must be materialized inside the active transaction");
                }
            }

            // Force specific exception to trigger transaction rollback before request/audit completion
            throw new ReviewTestSupport.ForcedFaultInjectionException("Deliberate test fault after engine materialization");
        };

        Map<String, Object> payload = Map.of(
                "title", "Fault Injection Submission",
                "language", "java",
                "code", "public class FaultTest {}"
        );

        HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create(reviewsUrl()))
                .header("Content-Type", "application/json")
                .header(session.csrf().headerName(), session.csrf().token())
                .header("Idempotency-Key", idempotencyKey.toString())
                .POST(HttpRequest.BodyPublishers.ofString(Json.stringify(Json.value(payload))))
                .build();

        HttpResponse<String> resp = null;
        try {
            resp = session.client().send(req, HttpResponse.BodyHandlers.ofString());
        } catch (java.io.IOException | InterruptedException ignored) {
            // Network / reset is acceptable on forced rollback
        } finally {
            ReviewTestSupport.postMaterializationHook = null;
        }

        if (resp != null) {
            // Server must not return 202; should return 500 or error mapping
            assertNotEquals(202, resp.statusCode(), "Fault-injected request must not return 202 Accepted");
        }

        // Verify seam was reached and non-null UUID captured
        assertTrue(hookInvoked.get(), "Post-materialization fault injection hook must have been invoked");
        UUID executionId = capturedExecutionId.get();
        assertNotNull(executionId, "Captured execution UUID must be non-null");

        // Assert ZERO residual rows survive after transaction rollback across all engine and business tables
        try (Connection conn = dataSource.getConnection()) {
            try (PreparedStatement ps = conn.prepareStatement("SELECT count(*) FROM executions WHERE id = ?")) {
                ps.setObject(1, executionId);
                try (ResultSet rs = ps.executeQuery()) {
                    assertTrue(rs.next());
                    assertEquals(0, rs.getInt(1), "executions must be rolled back: zero rows residual");
                }
            }
            try (PreparedStatement ps = conn.prepareStatement("SELECT count(*) FROM execution_plan_revisions WHERE \"executionId\" = ?")) {
                ps.setObject(1, executionId);
                try (ResultSet rs = ps.executeQuery()) {
                    assertTrue(rs.next());
                    assertEquals(0, rs.getInt(1), "execution_plan_revisions must be rolled back: zero rows residual");
                }
            }
            try (PreparedStatement ps = conn.prepareStatement("SELECT count(*) FROM step_executions WHERE \"executionId\" = ?")) {
                ps.setObject(1, executionId);
                try (ResultSet rs = ps.executeQuery()) {
                    assertTrue(rs.next());
                    assertEquals(0, rs.getInt(1), "step_executions must be rolled back: zero rows residual");
                }
            }
            try (PreparedStatement ps = conn.prepareStatement("SELECT count(*) FROM step_attempts WHERE \"executionId\" = ?")) {
                ps.setObject(1, executionId);
                try (ResultSet rs = ps.executeQuery()) {
                    assertTrue(rs.next());
                    assertEquals(0, rs.getInt(1), "step_attempts must be rolled back: zero rows residual");
                }
            }
            try (PreparedStatement ps = conn.prepareStatement(
                    "SELECT count(*) FROM dispatch_outbox WHERE \"stepAttemptId\" IN (SELECT id FROM step_attempts WHERE \"executionId\" = ?)")) {
                ps.setObject(1, executionId);
                try (ResultSet rs = ps.executeQuery()) {
                    assertTrue(rs.next());
                    assertEquals(0, rs.getInt(1), "dispatch_outbox must be rolled back: zero rows residual");
                }
            }
            try (PreparedStatement ps = conn.prepareStatement(
                    "SELECT count(*) FROM tenvyr_review.requests WHERE owner_id = ? AND idempotency_key = ?")) {
                ps.setObject(1, submitter.id());
                ps.setObject(2, idempotencyKey);
                try (ResultSet rs = ps.executeQuery()) {
                    assertTrue(rs.next());
                    assertEquals(0, rs.getInt(1), "review requests must be rolled back: zero rows residual");
                }
            }
            try (PreparedStatement ps = conn.prepareStatement(
                    "SELECT count(*) FROM tenvyr_review.audit WHERE actor_id = ? AND operation_key = ?")) {
                ps.setObject(1, submitter.id());
                ps.setObject(2, idempotencyKey);
                try (ResultSet rs = ps.executeQuery()) {
                    assertTrue(rs.next());
                    assertEquals(0, rs.getInt(1), "audit must be rolled back: zero rows residual");
                }
            }
        }
    }

    @Test
    @DisplayName("Lock timeout on concurrent submission returns safe 503 Service Unavailable with Retry-After: 1 header after rollback")
    void lockTimeoutReturnsSafe503WithRetryAfter_afterRollback() throws Exception {
        ReviewTestSupport.TestUser submitter = ReviewTestSupport.createTestUser(
                dataSource, trackedUsers, "sub_lock_timeout", Role.SUBMITTER);
        ReviewTestSupport.AuthenticatedSession session = ReviewTestSupport.loginUser(port, submitter);

        UUID idempotencyKey = UUID.randomUUID();

        // Compute 64-bit advisory lock key derived from (owner_id, "SUBMIT", idempotency_key) via production helper
        long lockKey = ReviewService.deriveAdvisoryLockKey(submitter.id(), "SUBMIT", idempotencyKey);

        // Acquire advisory lock in an external connection with autoCommit=false to simulate lock contention
        try (Connection lockConn = dataSource.getConnection()) {
            lockConn.setAutoCommit(false);
            try (PreparedStatement ps = lockConn.prepareStatement("SELECT pg_advisory_xact_lock(?)")) {
                ps.setLong(1, lockKey);
                ps.execute();
            }

            Map<String, Object> payload = Map.of(
                    "title", "Lock Timeout Test Submission",
                    "language", "java",
                    "code", "class LockTimeoutTest {}"
            );

            HttpRequest req = HttpRequest.newBuilder()
                    .uri(URI.create(reviewsUrl()))
                    .header("Content-Type", "application/json")
                    .header(session.csrf().headerName(), session.csrf().token())
                    .header("Idempotency-Key", idempotencyKey.toString())
                    .POST(HttpRequest.BodyPublishers.ofString(Json.stringify(Json.value(payload))))
                    .build();

            // Client request must encounter local lock_timeout (2s) and return safe 503
            HttpResponse<String> resp = session.client().send(req, HttpResponse.BodyHandlers.ofString());

            assertEquals(503, resp.statusCode(), "Lock timeout must return 503 Service Unavailable");
            String retryAfter = resp.headers().firstValue("Retry-After").orElse("");
            assertEquals("1", retryAfter, "Must include Retry-After: 1 header per SPEC");
            ReviewTestSupport.assertSafeErrorJson(resp, 503, "DATABASE_UNAVAILABLE");

            // Release external lock
            lockConn.rollback();
        }

        // Verify that failed submission rolled back completely: 0 requests, 0 audit rows
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
    }

    @Test
    @DisplayName("Hikari pool saturation on review submission returns safe 503 Service Unavailable with Retry-After: 1 and leaves zero residuals")
    void poolSaturation_returnsSafe503WithRetryAfter_zeroResidualRowsSurvive() throws Exception {
        ReviewTestSupport.TestUser submitter = ReviewTestSupport.createTestUser(
                dataSource, trackedUsers, "sub_pool_sat", Role.SUBMITTER);
        ReviewTestSupport.AuthenticatedSession session = ReviewTestSupport.loginUser(port, submitter);

        UUID idempotencyKey = UUID.randomUUID();
        List<Connection> heldConnections = new ArrayList<>();
        int poolSize = 10; // Matches application.yml maximum-pool-size: 10

        try {
            // Saturate Hikari connection pool completely
            for (int i = 0; i < poolSize; i++) {
                heldConnections.add(dataSource.getConnection());
            }

            Map<String, Object> payload = Map.of(
                    "title", "Pool Saturation Test Submission",
                    "language", "java",
                    "code", "class PoolSaturationTest {}"
            );

            HttpRequest req = HttpRequest.newBuilder()
                    .uri(URI.create(reviewsUrl()))
                    .header("Content-Type", "application/json")
                    .header(session.csrf().headerName(), session.csrf().token())
                    .header("Idempotency-Key", idempotencyKey.toString())
                    .POST(HttpRequest.BodyPublishers.ofString(Json.stringify(Json.value(payload))))
                    .build();

            // Client request will encounter Hikari connectionTimeout (2000ms) and must receive safe 503
            HttpResponse<String> resp = session.client().send(req, HttpResponse.BodyHandlers.ofString());

            assertEquals(503, resp.statusCode(), "Hikari pool saturation must return 503 Service Unavailable");
            String retryAfter = resp.headers().firstValue("Retry-After").orElse("");
            assertEquals("1", retryAfter, "Must include Retry-After: 1 header per SPEC");
            ReviewTestSupport.assertSafeErrorJson(resp, 503, "DATABASE_UNAVAILABLE");

        } finally {
            // Release all held connections back to the pool
            for (Connection conn : heldConnections) {
                try {
                    conn.close();
                } catch (Exception ignored) {}
            }
            heldConnections.clear();
        }

        // Verify that failed submission left zero residual rows in database
        try (Connection conn = dataSource.getConnection()) {
            try (PreparedStatement ps = conn.prepareStatement(
                    "SELECT count(*) FROM tenvyr_review.requests WHERE owner_id = ? AND idempotency_key = ?")) {
                ps.setObject(1, submitter.id());
                ps.setObject(2, idempotencyKey);
                try (ResultSet rs = ps.executeQuery()) {
                    assertTrue(rs.next());
                    assertEquals(0, rs.getInt(1), "No request row must exist after pool saturation failure");
                }
            }
            try (PreparedStatement ps = conn.prepareStatement(
                    "SELECT count(*) FROM tenvyr_review.audit WHERE actor_id = ? AND operation_key = ?")) {
                ps.setObject(1, submitter.id());
                ps.setObject(2, idempotencyKey);
                try (ResultSet rs = ps.executeQuery()) {
                    assertTrue(rs.next());
                    assertEquals(0, rs.getInt(1), "No audit row must exist after pool saturation failure");
                }
            }
        }
    }
}
