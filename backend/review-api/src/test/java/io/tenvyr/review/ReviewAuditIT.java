package io.tenvyr.review;

import com.fasterxml.jackson.databind.JsonNode;
import io.tenvyr.control.ControlPlaneRuntime;
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
import org.springframework.core.env.Environment;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import javax.sql.DataSource;
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
 * T06 Integration Test: Authorized Audit Log Keyset Pagination and Security Filtering.
 * Tests GET /api/v1/reviews/{id}/audit via real HTTP against real PostgreSQL.
 *
 * Requirements per SPEC / T06 plan:
 * 1. Owner SUBMITTER and REVIEWER have visibility to review audit log.
 * 2. Another submitter receives 404 Not Found (visibility enforced at SQL query boundary).
 * 3. Keyset pagination:
 *    - Paginated ascending: createdAt ASC, id ASC.
 *    - Limits bounded between 1 and 100 (limit < 1 or > 100 returns 400).
 *    - Bounded cursor (invalid base64, oversize > 256 bytes, or missing fields returns 400).
 * 4. Content leak checks:
 *    - Returns identifiers, actions, timestamps only.
 *    - Strictly excludes source code, comments, review reports, and provider secrets.
 * 5. Durable command deduplication:
 *    - SUBMIT, DECIDE, CANCEL duplicates are suppressed by durable command identity.
 *    - Denied / conflicting / rolled back commands produce NO success audit rows.
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
public class ReviewAuditIT {

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

    private String auditUrl(UUID requestId) {
        return "http://127.0.0.1:" + port + "/api/v1/reviews/" + requestId + "/audit";
    }

    @Test
    @DisplayName("Audit GET visibility: owner SUBMITTER and REVIEWER can read, other submitter receives 404")
    void auditVisibility_ownerAndReviewerCanRead_otherSubmitterReceives404() throws Exception {
        ReviewTestSupport.TestUser submitterA = ReviewTestSupport.createTestUser(
                dataSource, trackedUsers, "aud_sub_a", Role.SUBMITTER);
        ReviewTestSupport.TestUser submitterB = ReviewTestSupport.createTestUser(
                dataSource, trackedUsers, "aud_sub_b", Role.SUBMITTER);
        ReviewTestSupport.TestUser reviewer = ReviewTestSupport.createTestUser(
                dataSource, trackedUsers, "aud_rev", Role.REVIEWER);

        ReviewTestSupport.AuthenticatedSession sessionA = ReviewTestSupport.loginUser(port, submitterA);
        ReviewTestSupport.AuthenticatedSession sessionB = ReviewTestSupport.loginUser(port, submitterB);
        ReviewTestSupport.AuthenticatedSession sessionRev = ReviewTestSupport.loginUser(port, reviewer);

        ReviewTestSupport.ReviewFixture fixtureA;
        try (Connection conn = dataSource.getConnection()) {
            conn.setAutoCommit(false);
            try {
                fixtureA = ReviewTestSupport.createReviewFixture(conn, engineRuntime, trackedRequests, trackedExecutions,
                        submitterA.id(), "Audit Visibility Review", "java", "public class AuditTest {}", Instant.now());
                conn.commit();
            } catch (Exception e) {
                conn.rollback();
                throw e;
            }
        }

        // 1. Owner Submitter A can read audit -> 200 OK
        HttpRequest reqA = HttpRequest.newBuilder()
                .uri(URI.create(auditUrl(fixtureA.requestId())))
                .GET()
                .build();
        HttpResponse<String> respA = sessionA.client().send(reqA, HttpResponse.BodyHandlers.ofString());
        assertEquals(200, respA.statusCode(), "Owner submitter must be able to read audit (200 OK)");

        JsonNode bodyA = Json.parse(respA.body());
        assertTrue(bodyA.hasNonNull("items"), "Response must have items array");
        JsonNode itemsA = bodyA.path("items");
        assertFalse(itemsA.isEmpty(), "Audit items must not be empty (should contain SUBMIT)");
        assertEquals("SUBMIT", itemsA.get(0).path("action").asText());
        assertEquals(submitterA.id().toString(), itemsA.get(0).path("actorId").asText());

        // 2. Reviewer can read audit -> 200 OK
        HttpRequest reqRev = HttpRequest.newBuilder()
                .uri(URI.create(auditUrl(fixtureA.requestId())))
                .GET()
                .build();
        HttpResponse<String> respRev = sessionRev.client().send(reqRev, HttpResponse.BodyHandlers.ofString());
        assertEquals(200, respRev.statusCode(), "Reviewer must be able to read audit (200 OK)");

        // 3. Foreign Submitter B receives 404 Not Found on first page
        HttpRequest reqB = HttpRequest.newBuilder()
                .uri(URI.create(auditUrl(fixtureA.requestId())))
                .GET()
                .build();
        HttpResponse<String> respB = sessionB.client().send(reqB, HttpResponse.BodyHandlers.ofString());
        ReviewTestSupport.assertSafeErrorJson(respB, 404, "NOT_FOUND");

        // 4. Foreign Submitter B also receives 404 with a valid after cursor from owner page
        // Insert a second audit entry to ensure owner can obtain a valid nextCursor
        try (Connection conn = dataSource.getConnection()) {
            ReviewTestSupport.createDirectAuditEntry(
                    conn, fixtureA.requestId(), submitterA.id(), "SUBMIT",
                    UUID.randomUUID(), Json.hash(Json.object("second", true)), Instant.now().plusSeconds(1));
        }

        HttpRequest reqOwnerPage1 = HttpRequest.newBuilder()
                .uri(URI.create(auditUrl(fixtureA.requestId()) + "?limit=1"))
                .GET()
                .build();
        HttpResponse<String> respOwnerPage1 = sessionA.client().send(reqOwnerPage1, HttpResponse.BodyHandlers.ofString());
        assertEquals(200, respOwnerPage1.statusCode());
        JsonNode ownerPage1Body = Json.parse(respOwnerPage1.body());
        String ownerNextCursor = ownerPage1Body.path("nextCursor").asText();
        assertFalse(ownerNextCursor.isBlank(), "Owner page 1 must produce a non-blank nextCursor");

        HttpRequest reqBCursor = HttpRequest.newBuilder()
                .uri(URI.create(auditUrl(fixtureA.requestId()) + "?after=" + URLEncoder.encode(ownerNextCursor, StandardCharsets.UTF_8)))
                .GET()
                .build();
        HttpResponse<String> respBCursor = sessionB.client().send(reqBCursor, HttpResponse.BodyHandlers.ofString());
        ReviewTestSupport.assertSafeErrorJson(respBCursor, 404, "NOT_FOUND");
    }

    @Test
    @DisplayName("Audit log keyset pagination: ascending order (createdAt ASC, id ASC), limits 1..100, bounded cursor validation")
    void auditPaginationAscending_limitsAndCursorValidation() throws Exception {
        ReviewTestSupport.TestUser submitter = ReviewTestSupport.createTestUser(
                dataSource, trackedUsers, "aud_page_sub", Role.SUBMITTER);
        ReviewTestSupport.AuthenticatedSession session = ReviewTestSupport.loginUser(port, submitter);

        ReviewTestSupport.ReviewFixture fixture;
        Instant baseTime = Instant.parse("2026-11-14T12:00:00Z");
        try (Connection conn = dataSource.getConnection()) {
            conn.setAutoCommit(false);
            try {
                fixture = ReviewTestSupport.createReviewFixture(conn, engineRuntime, trackedRequests, trackedExecutions,
                        submitter.id(), "Audit Pagination Review", "java", "public class AuditPage {}", baseTime);

                // Insert 5 additional direct audit rows with staggered ascending timestamps
                for (int i = 1; i <= 5; i++) {
                    Instant entryTime = baseTime.plusSeconds(i * 10);
                    ReviewTestSupport.createDirectAuditEntry(
                            conn, fixture.requestId(), submitter.id(), "SUBMIT",
                            UUID.randomUUID(), Json.hash(Json.object("index", i)), entryTime);
                }
                conn.commit();
            } catch (Exception e) {
                conn.rollback();
                throw e;
            }
        }

        // Page through with limit=2
        String cursor = null;
        int pageCount = 0;
        List<String> seenIds = new ArrayList<>();
        Instant previousTime = Instant.MIN;

        while (pageCount < 10) {
            String uri = auditUrl(fixture.requestId()) + "?limit=2";
            if (cursor != null) {
                uri += "&after=" + URLEncoder.encode(cursor, StandardCharsets.UTF_8);
            }

            HttpRequest req = HttpRequest.newBuilder().uri(URI.create(uri)).GET().build();
            HttpResponse<String> resp = session.client().send(req, HttpResponse.BodyHandlers.ofString());
            assertEquals(200, resp.statusCode());

            JsonNode body = Json.parse(resp.body());
            JsonNode items = body.path("items");
            if (items.isEmpty()) {
                break;
            }

            for (JsonNode item : items) {
                seenIds.add(item.path("id").asText());
                Instant itemTime = Instant.parse(item.path("createdAt").asText());
                assertTrue(!itemTime.isBefore(previousTime), "Audit entries must be ordered ascending by createdAt");
                previousTime = itemTime;
            }

            cursor = body.hasNonNull("nextCursor") ? body.path("nextCursor").asText() : null;
            pageCount++;
            if (cursor == null || cursor.isBlank()) {
                break;
            }
        }

        // Total 6 rows inserted (1 from fixture + 5 direct)
        assertEquals(6, seenIds.size(), "Must page through all 6 audit entries");

        // Validate cursor & limit error bounds
        // 1. Limit < 1 -> 400
        HttpResponse<String> rLim0 = session.client().send(
                HttpRequest.newBuilder().uri(URI.create(auditUrl(fixture.requestId()) + "?limit=0")).GET().build(),
                HttpResponse.BodyHandlers.ofString());
        ReviewTestSupport.assertSafeErrorJson(rLim0, 400, "BAD_REQUEST");

        // 2. Limit > 100 -> 400
        HttpResponse<String> rLim101 = session.client().send(
                HttpRequest.newBuilder().uri(URI.create(auditUrl(fixture.requestId()) + "?limit=101")).GET().build(),
                HttpResponse.BodyHandlers.ofString());
        ReviewTestSupport.assertSafeErrorJson(rLim101, 400, "BAD_REQUEST");

        // 3. Invalid non-base64 cursor -> 400
        HttpResponse<String> rBadB64 = session.client().send(
                HttpRequest.newBuilder().uri(URI.create(auditUrl(fixture.requestId()) + "?after=invalid_cursor_!*")).GET().build(),
                HttpResponse.BodyHandlers.ofString());
        ReviewTestSupport.assertSafeErrorJson(rBadB64, 400, "BAD_REQUEST");

        // 4. Oversize cursor (> 256 decoded bytes) -> 400
        String oversize = Base64.getUrlEncoder().encodeToString("x".repeat(257).getBytes(StandardCharsets.UTF_8));
        HttpResponse<String> rOver = session.client().send(
                HttpRequest.newBuilder().uri(URI.create(auditUrl(fixture.requestId()) + "?after=" + oversize)).GET().build(),
                HttpResponse.BodyHandlers.ofString());
        ReviewTestSupport.assertSafeErrorJson(rOver, 400, "BAD_REQUEST");
    }

    @Test
    @DisplayName("Audit entries strictly exclude source code, comments, reports, and secrets per SPEC")
    void auditEntriesExcludeCodeAndSecrets() throws Exception {
        ReviewTestSupport.TestUser submitter = ReviewTestSupport.createTestUser(
                dataSource, trackedUsers, "aud_sec_sub", Role.SUBMITTER);
        ReviewTestSupport.AuthenticatedSession session = ReviewTestSupport.loginUser(port, submitter);

        String secretSnippet = "private String myAuditSecretToken = \"CONFIDENTIAL_TOKEN_12345\";";
        ReviewTestSupport.ReviewFixture fixture;
        try (Connection conn = dataSource.getConnection()) {
            conn.setAutoCommit(false);
            try {
                fixture = ReviewTestSupport.createReviewFixture(conn, engineRuntime, trackedRequests, trackedExecutions,
                        submitter.id(), "Secret Code Review", "java", secretSnippet, Instant.now());
                conn.commit();
            } catch (Exception e) {
                conn.rollback();
                throw e;
            }
        }

        HttpRequest req = HttpRequest.newBuilder().uri(URI.create(auditUrl(fixture.requestId()))).GET().build();
        HttpResponse<String> resp = session.client().send(req, HttpResponse.BodyHandlers.ofString());
        assertEquals(200, resp.statusCode());

        String raw = resp.body();
        assertFalse(raw.contains(secretSnippet), "Audit response must not leak source code");
        assertFalse(raw.contains("CONFIDENTIAL_TOKEN_12345"), "Audit response must not contain confidential tokens");
        assertFalse(raw.toLowerCase(Locale.ROOT).contains("password"), "Audit response must not contain password");

        JsonNode body = Json.parse(raw);
        JsonNode items = body.path("items");
        assertFalse(items.isEmpty());

        for (JsonNode item : items) {
            Set<String> fields = new HashSet<>();
            item.fieldNames().forEachRemaining(fields::add);
            // Required AuditEntry fields: id, actorId, action, createdAt
            assertEquals(Set.of("id", "actorId", "action", "createdAt"), fields,
                    "Audit item must contain ONLY {id, actorId, action, createdAt}, got: " + fields);
        }
    }
}
