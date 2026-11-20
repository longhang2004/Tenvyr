package io.tenvyr.review;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.tenvyr.control.ControlPlaneRuntime;
import io.tenvyr.control.engine.AgentTransportConfig;
import io.tenvyr.platform.Db;
import io.tenvyr.platform.Json;
import io.tenvyr.platform.Migrator;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.core.env.Environment;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import javax.sql.DataSource;
import java.nio.charset.StandardCharsets;
import java.sql.*;
import java.time.Instant;
import java.util.*;

import static org.junit.jupiter.api.Assertions.*;

/**
 * T02 Integration Test: Review PostgreSQL Schema, Retained 27 Ledger Identities,
 * Exact Constraints, Indexes, and UTF-8 Byte Bounds.
 * Requires real disposable PostgreSQL (no H2/mocks).
 */
@SpringBootTest(classes = ReviewApplication.class,
        properties = {
                "HTTP_AGENT_ALLOW_INSECURE=true",
                "HTTP_AGENT_CALLBACK_BASE_URL=http://127.0.0.1:8080",
                "TEST_SECRET=" + ReviewCallbackIT.TEST_SECRET,
                "TEST_TOKEN=test-token"
        }
)
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
public class ReviewSchemaIT {

    @Autowired
    private DataSource dataSource;

    @Autowired
    private ControlPlaneRuntime engineRuntime;

    @Autowired
    private Environment environment;

    @DynamicPropertySource
    static void configureProperties(DynamicPropertyRegistry registry) {
        String raw = System.getenv("TENVYR_REVIEW_TEST_DATABASE_URL");
        if (raw == null || raw.isBlank()) {
            throw new IllegalStateException("ReviewSchemaIT requires real PostgreSQL: TENVYR_REVIEW_TEST_DATABASE_URL must be set");
        }

        ReviewCallbackIT.validateDisposableDatabaseUrl(raw);

        String user = System.getenv().getOrDefault("POSTGRES_USER", "postgres");
        String password = System.getenv().getOrDefault("POSTGRES_PASSWORD", "postgres");

        registry.add("spring.datasource.url", () -> raw);
        registry.add("spring.datasource.username", () -> user);
        registry.add("spring.datasource.password", () -> password);

        String transportConfig = Json.stringify(Json.object(
                ReviewCallbackIT.TEST_AGENT, Json.object(
                        "kind", "http",
                        "submitUrl", "http://127.0.0.1:8081/v1/runs",
                        "outboundAuthentication", Json.object("type", "bearer", "tokenEnv", "TEST_TOKEN"),
                        "callbackAuthentication", Json.object("keyId", ReviewCallbackIT.TEST_KEY_ID, "secretEnv", "TEST_SECRET"),
                        "requestTimeoutMs", 2000,
                        "maxResponseBytes", 65536
                )
        ));
        registry.add("AGENT_TRANSPORT_CONFIG", () -> transportConfig);
    }

    @BeforeAll
    static void requireRealDisposableDatabase() {
        String raw = System.getenv("TENVYR_REVIEW_TEST_DATABASE_URL");
        ReviewCallbackIT.validateDisposableDatabaseUrl(raw);
    }

    private record ValidFixture(UUID userId, UUID executionId, UUID requestId, UUID stepAttemptId) {}

    private UUID createValidUser(Connection conn, String role) throws SQLException {
        UUID userId = UUID.randomUUID();
        try (PreparedStatement ps = conn.prepareStatement(
                "INSERT INTO tenvyr_review.users (id, username, password_hash, role, enabled) " +
                        "VALUES (?, ?, '{bcrypt}$2a$10$dummyhash', ?, true)")) {
            ps.setObject(1, userId);
            ps.setString(2, "user_" + UUID.randomUUID().toString().replace("-", "").substring(0, 12));
            ps.setString(3, role != null ? role : "SUBMITTER");
            assertEquals(1, ps.executeUpdate());
        }
        return userId;
    }

    private ValidFixture createValidFixture(Connection conn, String language, String code) throws Exception {
        ObjectNode pipeline = PipelineCatalog.ensure(conn);
        UUID userId = createValidUser(conn, "SUBMITTER");

        ObjectNode execution = engineRuntime.executions().materializeExecutionWithManager(
                conn, pipeline, Json.object("source", "test"), null);
        UUID executionId = UUID.fromString(execution.path("id").asText());

        ObjectNode stepExec = Db.on(conn).one("SELECT * FROM step_executions WHERE \"executionId\" = ?", executionId.toString());
        ObjectNode revision = Db.on(conn).one("SELECT * FROM execution_plan_revisions WHERE \"executionId\" = ?", executionId.toString());

        ObjectNode executorSnapshot = new AgentTransportConfig(
                EngineConfiguration.validateReviewEnvironment(environment)
        ).descriptor("code-reviewer");

        ObjectNode attempt = Json.object(
                "executionId", executionId.toString(),
                "logicalStepId", stepExec.path("id").asText(),
                "planRevisionId", revision.path("id").asText(),
                "attemptNumber", 1,
                "invocationId", stepExec.path("id").asText() + ":1",
                "frozenSpecHash", Json.hash(PipelineCatalog.definition().path("steps").get(0)),
                "inputSnapshot", Json.object(),
                "executorSnapshot", executorSnapshot,
                "status", "SUCCESS",
                "terminalAt", Instant.now().toString()
        );
        ObjectNode createdAttempt = Db.on(conn).insert("step_attempts", attempt);
        UUID stepAttemptId = UUID.fromString(createdAttempt.path("id").asText());

        UUID requestId = UUID.randomUUID();
        try (PreparedStatement ps = conn.prepareStatement(
                "INSERT INTO tenvyr_review.requests (id, owner_id, idempotency_key, request_hash, title, language, code, execution_id, created_at) " +
                        "VALUES (?, ?, ?, 'req-hash', 'Title', ?, ?, ?, now())")) {
            ps.setObject(1, requestId);
            ps.setObject(2, userId);
            ps.setObject(3, UUID.randomUUID());
            ps.setString(4, language != null ? language : "typescript");
            ps.setString(5, code != null ? code : "const safe = true;");
            ps.setObject(6, executionId);
            assertEquals(1, ps.executeUpdate());
        }

        return new ValidFixture(userId, executionId, requestId, stepAttemptId);
    }

    @Test
    @DisplayName("Schema tenvyr_review and all 5 required tables exist in PostgreSQL")
    void testTenvyrReviewSchemaAndTablesExist() throws Exception {
        try (Connection conn = dataSource.getConnection()) {
            // Verify schema exists
            try (PreparedStatement ps = conn.prepareStatement(
                    "SELECT count(*) FROM information_schema.schemata WHERE schema_name = 'tenvyr_review'")) {
                try (ResultSet rs = ps.executeQuery()) {
                    assertTrue(rs.next());
                    assertEquals(1, rs.getInt(1), "Schema tenvyr_review must exist");
                }
            }

            // Verify all 5 SPEC tables exist
            Set<String> expectedTables = Set.of("users", "pipeline_bindings", "requests", "decisions", "audit");
            Set<String> foundTables = new HashSet<>();

            try (PreparedStatement ps = conn.prepareStatement(
                    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'tenvyr_review'")) {
                try (ResultSet rs = ps.executeQuery()) {
                    while (rs.next()) {
                        foundTables.add(rs.getString("table_name").toLowerCase(Locale.ROOT));
                    }
                }
            }

            for (String table : expectedTables) {
                assertTrue(foundTables.contains(table), "Table tenvyr_review." + table + " must exist");
            }
        }
    }

    @Test
    @DisplayName("Retained TypeORM migration ledger preserves exact 27 legacy entries, names, and timestamps in order")
    void testRetainedMigrationsLedgerPreservedExact27Identities() throws Exception {
        JsonNode ledger = Migrator.ledger();
        assertTrue(ledger.isArray());
        assertEquals(27, ledger.size(), "Migrator.ledger must define exactly 27 entries");

        try (Connection conn = dataSource.getConnection()) {
            try (PreparedStatement ps = conn.prepareStatement(
                    "SELECT \"timestamp\", \"name\" FROM \"migrations\" ORDER BY \"id\" ASC")) {
                try (ResultSet rs = ps.executeQuery()) {
                    int count = 0;
                    while (rs.next()) {
                        assertTrue(count < 27, "Must not have more than 27 migrations");
                        JsonNode expected = ledger.get(count);
                        assertEquals(expected.path("name").asText(), rs.getString("name"),
                                "Migration name at position " + count + " must match exact ledger identity");
                        assertEquals(expected.path("timestamp").asLong(), rs.getLong("timestamp"),
                                "Migration timestamp at position " + count + " must match exact ledger timestamp");
                        count++;
                    }
                    assertEquals(27, count, "Base ledger must retain exactly 27 migration entries");
                }
            }
        }
    }

    @Test
    @DisplayName("All leased pool connections after Flyway retain default search_path 'public'")
    void testAllLeasedPoolConnectionsRetainDefaultSearchPath() throws Exception {
        // Lease all 10 connections from the pool concurrently to verify none retain tenvyr_review search_path
        List<Connection> connections = new ArrayList<>();
        try {
            for (int i = 0; i < 10; i++) {
                Connection c = dataSource.getConnection();
                connections.add(c);
                try (PreparedStatement ps = c.prepareStatement("SELECT current_schema()")) {
                    try (ResultSet rs = ps.executeQuery()) {
                        assertTrue(rs.next());
                        assertEquals("public", rs.getString(1),
                                "Leased pool connection " + i + " must have search_path 'public', not tenvyr_review");
                    }
                }
            }
        } finally {
            for (Connection c : connections) {
                try {
                    c.close();
                } catch (Exception ignored) {}
            }
        }
    }

    @Test
    @DisplayName("requests.code enforces 65,536 UTF-8 byte bounds and distinguishes Unicode byte bounds from Java string length using valid distinct engine executions")
    void testRequestCodeUtf8ByteBounds() throws Exception {
        try (Connection conn = dataSource.getConnection()) {
            conn.setAutoCommit(false);
            try {
                ObjectNode pipeline = PipelineCatalog.ensure(conn);
                UUID userId = createValidUser(conn, "SUBMITTER");

                // 1. Boundary: exactly 65,536 ASCII UTF-8 bytes accepted with distinct execution
                ObjectNode exec1 = engineRuntime.executions().materializeExecutionWithManager(
                        conn, pipeline, Json.object("source", "test"), null);
                UUID executionId1 = UUID.fromString(exec1.path("id").asText());

                String exact65536Ascii = "x".repeat(65536);
                assertEquals(65536, exact65536Ascii.getBytes(StandardCharsets.UTF_8).length);

                UUID reqId1 = UUID.randomUUID();
                try (PreparedStatement ps = conn.prepareStatement(
                        "INSERT INTO tenvyr_review.requests (id, owner_id, idempotency_key, request_hash, title, language, code, execution_id, created_at) " +
                                "VALUES (?, ?, ?, 'req-hash-1', 'Title', 'typescript', ?, ?, now())")) {
                    ps.setObject(1, reqId1);
                    ps.setObject(2, userId);
                    ps.setObject(3, UUID.randomUUID());
                    ps.setString(4, exact65536Ascii);
                    ps.setObject(5, executionId1);
                    assertEquals(1, ps.executeUpdate(), "65,536 UTF-8 bytes must be accepted in requests.code");
                }

                // 2. Boundary: 65,537 ASCII UTF-8 bytes rejected by check constraint (SQLState 23514) with distinct execution
                ObjectNode exec2 = engineRuntime.executions().materializeExecutionWithManager(
                        conn, pipeline, Json.object("source", "test"), null);
                UUID executionId2 = UUID.fromString(exec2.path("id").asText());

                String exact65537Ascii = "x".repeat(65537);
                assertEquals(65537, exact65537Ascii.getBytes(StandardCharsets.UTF_8).length);

                UUID reqId2 = UUID.randomUUID();
                Savepoint sp2 = conn.setSavepoint();
                try (PreparedStatement ps = conn.prepareStatement(
                        "INSERT INTO tenvyr_review.requests (id, owner_id, idempotency_key, request_hash, title, language, code, execution_id, created_at) " +
                                "VALUES (?, ?, ?, 'req-hash-2', 'Title', 'typescript', ?, ?, now())")) {
                    ps.setObject(1, reqId2);
                    ps.setObject(2, userId);
                    ps.setObject(3, UUID.randomUUID());
                    ps.setString(4, exact65537Ascii);
                    ps.setObject(5, executionId2);

                    SQLException ex = assertThrows(SQLException.class, ps::executeUpdate,
                            "65,537 UTF-8 bytes in requests.code must be rejected by check constraint");
                    assertEquals("23514", ex.getSQLState(), "Expected PostgreSQL check_violation (23514)");
                } finally {
                    conn.rollback(sp2);
                }

                // 3. Multi-byte Unicode test distinguishing byte bounds from Java string length
                // 21,845 3-byte Chinese characters '\u4e16':
                // Java String length = 21,845; UTF-8 byte count = 21,845 * 3 = 65,535 bytes (<= 65,536).
                // Uses fresh distinct execution to prevent UNIQUE executionId (23505) violation
                ObjectNode exec3 = engineRuntime.executions().materializeExecutionWithManager(
                        conn, pipeline, Json.object("source", "test"), null);
                UUID executionId3 = UUID.fromString(exec3.path("id").asText());

                String validMultiByte = "\u4e16".repeat(21845);
                assertEquals(21845, validMultiByte.length());
                assertEquals(65535, validMultiByte.getBytes(StandardCharsets.UTF_8).length);

                UUID reqId3 = UUID.randomUUID();
                try (PreparedStatement ps = conn.prepareStatement(
                        "INSERT INTO tenvyr_review.requests (id, owner_id, idempotency_key, request_hash, title, language, code, execution_id, created_at) " +
                                "VALUES (?, ?, ?, 'req-hash-3', 'Title', 'typescript', ?, ?, now())")) {
                    ps.setObject(1, reqId3);
                    ps.setObject(2, userId);
                    ps.setObject(3, UUID.randomUUID());
                    ps.setString(4, validMultiByte);
                    ps.setObject(5, executionId3);
                    assertEquals(1, ps.executeUpdate(), "Multi-byte UTF-8 string <= 65,536 bytes must be accepted");
                }

                // 4. 21,846 3-byte Chinese characters:
                // Java String length = 21,846 (< 65,536); UTF-8 byte count = 21,846 * 3 = 65,538 bytes (> 65,536).
                ObjectNode exec4 = engineRuntime.executions().materializeExecutionWithManager(
                        conn, pipeline, Json.object("source", "test"), null);
                UUID executionId4 = UUID.fromString(exec4.path("id").asText());

                String oversizeMultiByte = "\u4e16".repeat(21846);
                assertEquals(21846, oversizeMultiByte.length());
                assertEquals(65538, oversizeMultiByte.getBytes(StandardCharsets.UTF_8).length);

                UUID reqId4 = UUID.randomUUID();
                Savepoint sp4 = conn.setSavepoint();
                try (PreparedStatement ps = conn.prepareStatement(
                        "INSERT INTO tenvyr_review.requests (id, owner_id, idempotency_key, request_hash, title, language, code, execution_id, created_at) " +
                                "VALUES (?, ?, ?, 'req-hash-4', 'Title', 'typescript', ?, ?, now())")) {
                    ps.setObject(1, reqId4);
                    ps.setObject(2, userId);
                    ps.setObject(3, UUID.randomUUID());
                    ps.setString(4, oversizeMultiByte);
                    ps.setObject(5, executionId4);

                    SQLException ex = assertThrows(SQLException.class, ps::executeUpdate,
                            "Multi-byte UTF-8 string exceeding 65,536 octets must be rejected even though string length < 65,536");
                    assertEquals("23514", ex.getSQLState(), "Expected PostgreSQL check_violation (23514)");
                } finally {
                    conn.rollback(sp4);
                }
            } finally {
                // Roll back so no test junk or recovery races are left
                conn.rollback();
            }
        }
    }

    @Test
    @DisplayName("Table constraints strictly reject invalid roles, usernames, actions, versions, language whitelist, and duplicate keys with exact SQLState")
    void testCheckAndConstraintViolationsWithExactSqlState() throws Exception {
        try (Connection conn = dataSource.getConnection()) {
            conn.setAutoCommit(false);
            try {
                // 1. users.role CHECK violation (23514)
                Savepoint sp = conn.setSavepoint();
                try (PreparedStatement ps = conn.prepareStatement(
                        "INSERT INTO tenvyr_review.users (id, username, password_hash, role, enabled) " +
                                "VALUES (?, 'admin_user', 'hash', 'ADMIN', true)")) {
                    ps.setObject(1, UUID.randomUUID());
                    SQLException ex = assertThrows(SQLException.class, ps::executeUpdate);
                    assertEquals("23514", ex.getSQLState(), "Invalid role 'ADMIN' must fail with SQLState 23514");
                } finally {
                    conn.rollback(sp);
                }

                // 2. users.username format CHECK violation (23514)
                sp = conn.setSavepoint();
                try (PreparedStatement ps = conn.prepareStatement(
                        "INSERT INTO tenvyr_review.users (id, username, password_hash, role, enabled) " +
                                "VALUES (?, 'UPPERCASE_NAME', 'hash', 'SUBMITTER', true)")) {
                    ps.setObject(1, UUID.randomUUID());
                    SQLException ex = assertThrows(SQLException.class, ps::executeUpdate);
                    assertEquals("23514", ex.getSQLState(), "Uppercase username must fail with SQLState 23514");
                } finally {
                    conn.rollback(sp);
                }

                // 3. users.username UNIQUE violation (23505)
                UUID u1 = UUID.randomUUID();
                try (PreparedStatement ps = conn.prepareStatement(
                        "INSERT INTO tenvyr_review.users (id, username, password_hash, role, enabled) " +
                                "VALUES (?, 'unique_user', 'hash', 'SUBMITTER', true)")) {
                    ps.setObject(1, u1);
                    assertEquals(1, ps.executeUpdate());
                }

                sp = conn.setSavepoint();
                try (PreparedStatement ps = conn.prepareStatement(
                        "INSERT INTO tenvyr_review.users (id, username, password_hash, role, enabled) " +
                                "VALUES (?, 'unique_user', 'hash', 'SUBMITTER', true)")) {
                    ps.setObject(1, UUID.randomUUID());
                    SQLException ex = assertThrows(SQLException.class, ps::executeUpdate);
                    assertEquals("23505", ex.getSQLState(), "Duplicate username must fail with SQLState 23505");
                } finally {
                    conn.rollback(sp);
                }

                // 4. pipeline_bindings.version CHECK violation (23514)
                ObjectNode pipeline = PipelineCatalog.ensure(conn);
                sp = conn.setSavepoint();
                try (PreparedStatement ps = conn.prepareStatement(
                        "INSERT INTO tenvyr_review.pipeline_bindings (version, pipeline_id, definition_hash) " +
                                "VALUES (2, ?::uuid, '0000000000000000000000000000000000000000000000000000000000000000')")) {
                    ps.setString(1, pipeline.path("id").asText());
                    SQLException ex = assertThrows(SQLException.class, ps::executeUpdate);
                    assertEquals("23514", ex.getSQLState(), "Version != 1 must fail with SQLState 23514");
                } finally {
                    conn.rollback(sp);
                }

                // 5. requests.language CHECK constraint violation (23514) on valid user/execution
                UUID validUser = createValidUser(conn, "SUBMITTER");
                ObjectNode execForLang = engineRuntime.executions().materializeExecutionWithManager(
                        conn, pipeline, Json.object("source", "test"), null);
                sp = conn.setSavepoint();
                try (PreparedStatement ps = conn.prepareStatement(
                        "INSERT INTO tenvyr_review.requests (id, owner_id, idempotency_key, request_hash, title, language, code, execution_id, created_at) " +
                                "VALUES (?, ?, ?, 'req-hash', 'Title', '', 'const safe = true;', ?::uuid, now())")) {
                    ps.setObject(1, UUID.randomUUID());
                    ps.setObject(2, validUser);
                    ps.setObject(3, UUID.randomUUID());
                    ps.setString(4, execForLang.path("id").asText());
                    SQLException ex = assertThrows(SQLException.class, ps::executeUpdate);
                    assertEquals("23514", ex.getSQLState(), "Blank language must fail with SQLState 23514");
                } finally {
                    conn.rollback(sp);
                }

                // 6. decisions.action CHECK violation (23514) mutating ONLY action on valid fixture
                ValidFixture fixForDecisionCheck = createValidFixture(conn, "typescript", "code");
                UUID reviewerForDecisionCheck = createValidUser(conn, "REVIEWER");
                sp = conn.setSavepoint();
                try (PreparedStatement ps = conn.prepareStatement(
                        "INSERT INTO tenvyr_review.decisions (id, request_id, actor_id, idempotency_key, payload_hash, action, comment, step_attempt_id, result_hash, created_at) " +
                                "VALUES (?, ?, ?, ?, 'hash', 'REJECT', 'bad', ?, 'res-hash', now())")) {
                    ps.setObject(1, UUID.randomUUID());
                    ps.setObject(2, fixForDecisionCheck.requestId());
                    ps.setObject(3, reviewerForDecisionCheck);
                    ps.setObject(4, UUID.randomUUID());
                    ps.setObject(5, fixForDecisionCheck.stepAttemptId());
                    SQLException ex = assertThrows(SQLException.class, ps::executeUpdate);
                    assertEquals("23514", ex.getSQLState(), "Invalid decision action 'REJECT' must fail with SQLState 23514");
                } finally {
                    conn.rollback(sp);
                }

                // 7. audit.action CHECK violation (23514) mutating ONLY action on valid fixture
                ValidFixture fixForAuditCheck = createValidFixture(conn, "typescript", "code");
                sp = conn.setSavepoint();
                try (PreparedStatement ps = conn.prepareStatement(
                        "INSERT INTO tenvyr_review.audit (id, request_id, actor_id, action, operation_key, payload_hash, created_at) " +
                                "VALUES (?, ?, ?, 'DELETE', ?, 'hash', now())")) {
                    ps.setObject(1, UUID.randomUUID());
                    ps.setObject(2, fixForAuditCheck.requestId());
                    ps.setObject(3, fixForAuditCheck.userId());
                    ps.setObject(4, UUID.randomUUID());
                    SQLException ex = assertThrows(SQLException.class, ps::executeUpdate);
                    assertEquals("23514", ex.getSQLState(), "Invalid audit action 'DELETE' must fail with SQLState 23514");
                } finally {
                    conn.rollback(sp);
                }

                // 8. Idempotency unique: uq_requests_owner_idempotency (23505)
                UUID ownerId = createValidUser(conn, "SUBMITTER");
                UUID reqIdempotencyKey = UUID.randomUUID();
                ObjectNode execA = engineRuntime.executions().materializeExecutionWithManager(conn, pipeline, Json.object("source", "test"), null);
                try (PreparedStatement ps = conn.prepareStatement(
                        "INSERT INTO tenvyr_review.requests (id, owner_id, idempotency_key, request_hash, title, language, code, execution_id, created_at) " +
                                "VALUES (?, ?, ?, 'hash', 'Title', 'typescript', 'code', ?::uuid, now())")) {
                    ps.setObject(1, UUID.randomUUID());
                    ps.setObject(2, ownerId);
                    ps.setObject(3, reqIdempotencyKey);
                    ps.setString(4, execA.path("id").asText());
                    assertEquals(1, ps.executeUpdate());
                }

                ObjectNode execB = engineRuntime.executions().materializeExecutionWithManager(conn, pipeline, Json.object("source", "test"), null);
                sp = conn.setSavepoint();
                try (PreparedStatement ps = conn.prepareStatement(
                        "INSERT INTO tenvyr_review.requests (id, owner_id, idempotency_key, request_hash, title, language, code, execution_id, created_at) " +
                                "VALUES (?, ?, ?, 'hash', 'Title', 'typescript', 'code', ?::uuid, now())")) {
                    ps.setObject(1, UUID.randomUUID());
                    ps.setObject(2, ownerId);
                    ps.setObject(3, reqIdempotencyKey);
                    ps.setString(4, execB.path("id").asText());
                    SQLException ex = assertThrows(SQLException.class, ps::executeUpdate);
                    assertEquals("23505", ex.getSQLState(), "Duplicate (owner_id, idempotency_key) must fail with SQLState 23505");
                } finally {
                    conn.rollback(sp);
                }

                // 9. Idempotency unique: uq_decisions_actor_idempotency (23505)
                ValidFixture fixD1 = createValidFixture(conn, "typescript", "code");
                ValidFixture fixD2 = createValidFixture(conn, "typescript", "code");
                UUID reviewerId = createValidUser(conn, "REVIEWER");
                UUID decisionIdempotencyKey = UUID.randomUUID();

                try (PreparedStatement ps = conn.prepareStatement(
                        "INSERT INTO tenvyr_review.decisions (id, request_id, actor_id, idempotency_key, payload_hash, action, comment, step_attempt_id, result_hash, created_at) " +
                                "VALUES (?, ?, ?, ?, 'hash', 'APPROVE', 'LGTM', ?, 'res-hash', now())")) {
                    ps.setObject(1, UUID.randomUUID());
                    ps.setObject(2, fixD1.requestId());
                    ps.setObject(3, reviewerId);
                    ps.setObject(4, decisionIdempotencyKey);
                    ps.setObject(5, fixD1.stepAttemptId());
                    assertEquals(1, ps.executeUpdate());
                }

                sp = conn.setSavepoint();
                try (PreparedStatement ps = conn.prepareStatement(
                        "INSERT INTO tenvyr_review.decisions (id, request_id, actor_id, idempotency_key, payload_hash, action, comment, step_attempt_id, result_hash, created_at) " +
                                "VALUES (?, ?, ?, ?, 'hash', 'APPROVE', 'LGTM', ?, 'res-hash', now())")) {
                    ps.setObject(1, UUID.randomUUID());
                    ps.setObject(2, fixD2.requestId());
                    ps.setObject(3, reviewerId);
                    ps.setObject(4, decisionIdempotencyKey);
                    ps.setObject(5, fixD2.stepAttemptId());
                    SQLException ex = assertThrows(SQLException.class, ps::executeUpdate);
                    assertEquals("23505", ex.getSQLState(), "Duplicate (actor_id, idempotency_key) must fail with SQLState 23505");
                } finally {
                    conn.rollback(sp);
                }

                // 10. Exactly one decision per request (request_id UNIQUE) (23505)
                UUID secondReviewer = createValidUser(conn, "REVIEWER");
                sp = conn.setSavepoint();
                try (PreparedStatement ps = conn.prepareStatement(
                        "INSERT INTO tenvyr_review.decisions (id, request_id, actor_id, idempotency_key, payload_hash, action, comment, step_attempt_id, result_hash, created_at) " +
                                "VALUES (?, ?, ?, ?, 'hash', 'APPROVE', 'Second review', ?, 'res-hash', now())")) {
                    ps.setObject(1, UUID.randomUUID());
                    ps.setObject(2, fixD1.requestId()); // Same request_id
                    ps.setObject(3, secondReviewer);
                    ps.setObject(4, UUID.randomUUID());
                    ps.setObject(5, fixD1.stepAttemptId());
                    SQLException ex = assertThrows(SQLException.class, ps::executeUpdate);
                    assertEquals("23505", ex.getSQLState(), "Multiple decisions for same request must fail with SQLState 23505");
                } finally {
                    conn.rollback(sp);
                }

                // 11. Audit operation unique: uq_audit_actor_action_op (23505)
                ValidFixture fixAudit = createValidFixture(conn, "typescript", "code");
                UUID opKey = UUID.randomUUID();
                try (PreparedStatement ps = conn.prepareStatement(
                        "INSERT INTO tenvyr_review.audit (id, request_id, actor_id, action, operation_key, payload_hash, created_at) " +
                                "VALUES (?, ?, ?, 'SUBMIT', ?, 'hash', now())")) {
                    ps.setObject(1, UUID.randomUUID());
                    ps.setObject(2, fixAudit.requestId());
                    ps.setObject(3, fixAudit.userId());
                    ps.setObject(4, opKey);
                    assertEquals(1, ps.executeUpdate());
                }

                sp = conn.setSavepoint();
                try (PreparedStatement ps = conn.prepareStatement(
                        "INSERT INTO tenvyr_review.audit (id, request_id, actor_id, action, operation_key, payload_hash, created_at) " +
                                "VALUES (?, ?, ?, 'SUBMIT', ?, 'hash', now())")) {
                    ps.setObject(1, UUID.randomUUID());
                    ps.setObject(2, fixAudit.requestId());
                    ps.setObject(3, fixAudit.userId());
                    ps.setObject(4, opKey);
                    SQLException ex = assertThrows(SQLException.class, ps::executeUpdate);
                    assertEquals("23505", ex.getSQLState(), "Duplicate (actor_id, action, operation_key) must fail with SQLState 23505");
                } finally {
                    conn.rollback(sp);
                }

                // 12. requests.execution_id UNIQUE (23505)
                UUID otherUser = createValidUser(conn, "SUBMITTER");
                sp = conn.setSavepoint();
                try (PreparedStatement ps = conn.prepareStatement(
                        "INSERT INTO tenvyr_review.requests (id, owner_id, idempotency_key, request_hash, title, language, code, execution_id, created_at) " +
                                "VALUES (?, ?, ?, 'hash', 'Title', 'typescript', 'code', ?, now())")) {
                    ps.setObject(1, UUID.randomUUID());
                    ps.setObject(2, otherUser);
                    ps.setObject(3, UUID.randomUUID());
                    ps.setObject(4, fixAudit.executionId()); // Reusing execution_id
                    SQLException ex = assertThrows(SQLException.class, ps::executeUpdate);
                    assertEquals("23505", ex.getSQLState(), "Reused execution_id in requests must fail with SQLState 23505");
                } finally {
                    conn.rollback(sp);
                }

                // 13. Foreign key constraints to review and engine tables (23503)
                // 13a. pipeline_bindings.pipeline_id -> pipelines(id)
                sp = conn.setSavepoint();
                try (PreparedStatement ps = conn.prepareStatement(
                        "UPDATE tenvyr_review.pipeline_bindings SET pipeline_id = ? WHERE version = 1")) {
                    ps.setObject(1, UUID.randomUUID());
                    SQLException ex = assertThrows(SQLException.class, ps::executeUpdate);
                    assertEquals("23503", ex.getSQLState(), "Invalid pipeline_id FK must fail with SQLState 23503");
                } finally {
                    conn.rollback(sp);
                }

                // 13b. requests.owner_id -> users(id)
                ObjectNode execFk = engineRuntime.executions().materializeExecutionWithManager(conn, pipeline, Json.object("source", "test"), null);
                sp = conn.setSavepoint();
                try (PreparedStatement ps = conn.prepareStatement(
                        "INSERT INTO tenvyr_review.requests (id, owner_id, idempotency_key, request_hash, title, language, code, execution_id, created_at) " +
                                "VALUES (?, ?, ?, 'hash', 'Title', 'typescript', 'code', ?::uuid, now())")) {
                    ps.setObject(1, UUID.randomUUID());
                    ps.setObject(2, UUID.randomUUID()); // Non-existent user
                    ps.setObject(3, UUID.randomUUID());
                    ps.setString(4, execFk.path("id").asText());
                    SQLException ex = assertThrows(SQLException.class, ps::executeUpdate);
                    assertEquals("23503", ex.getSQLState(), "Invalid owner_id FK must fail with SQLState 23503");
                } finally {
                    conn.rollback(sp);
                }

                // 13c. requests.execution_id -> executions(id)
                UUID validUserFk = createValidUser(conn, "SUBMITTER");
                sp = conn.setSavepoint();
                try (PreparedStatement ps = conn.prepareStatement(
                        "INSERT INTO tenvyr_review.requests (id, owner_id, idempotency_key, request_hash, title, language, code, execution_id, created_at) " +
                                "VALUES (?, ?, ?, 'hash', 'Title', 'typescript', 'code', ?, now())")) {
                    ps.setObject(1, UUID.randomUUID());
                    ps.setObject(2, validUserFk);
                    ps.setObject(3, UUID.randomUUID());
                    ps.setObject(4, UUID.randomUUID()); // Non-existent execution
                    SQLException ex = assertThrows(SQLException.class, ps::executeUpdate);
                    assertEquals("23503", ex.getSQLState(), "Invalid execution_id FK must fail with SQLState 23503");
                } finally {
                    conn.rollback(sp);
                }

                // 13d. decisions.request_id -> requests(id)
                UUID validRevFk = createValidUser(conn, "REVIEWER");
                sp = conn.setSavepoint();
                try (PreparedStatement ps = conn.prepareStatement(
                        "INSERT INTO tenvyr_review.decisions (id, request_id, actor_id, idempotency_key, payload_hash, action, comment, step_attempt_id, result_hash, created_at) " +
                                "VALUES (?, ?, ?, ?, 'hash', 'APPROVE', 'LGTM', ?, 'res-hash', now())")) {
                    ps.setObject(1, UUID.randomUUID());
                    ps.setObject(2, UUID.randomUUID()); // Non-existent request
                    ps.setObject(3, validRevFk);
                    ps.setObject(4, UUID.randomUUID());
                    ps.setObject(5, fixAudit.stepAttemptId());
                    SQLException ex = assertThrows(SQLException.class, ps::executeUpdate);
                    assertEquals("23503", ex.getSQLState(), "Invalid request_id FK in decisions must fail with SQLState 23503");
                } finally {
                    conn.rollback(sp);
                }

                // 13e. decisions.actor_id -> users(id)
                sp = conn.setSavepoint();
                try (PreparedStatement ps = conn.prepareStatement(
                        "INSERT INTO tenvyr_review.decisions (id, request_id, actor_id, idempotency_key, payload_hash, action, comment, step_attempt_id, result_hash, created_at) " +
                                "VALUES (?, ?, ?, ?, 'hash', 'APPROVE', 'LGTM', ?, 'res-hash', now())")) {
                    ps.setObject(1, UUID.randomUUID());
                    ps.setObject(2, fixAudit.requestId());
                    ps.setObject(3, UUID.randomUUID()); // Non-existent actor
                    ps.setObject(4, UUID.randomUUID());
                    ps.setObject(5, fixAudit.stepAttemptId());
                    SQLException ex = assertThrows(SQLException.class, ps::executeUpdate);
                    assertEquals("23503", ex.getSQLState(), "Invalid actor_id FK in decisions must fail with SQLState 23503");
                } finally {
                    conn.rollback(sp);
                }

                // 13f. decisions.step_attempt_id -> step_attempts(id)
                sp = conn.setSavepoint();
                try (PreparedStatement ps = conn.prepareStatement(
                        "INSERT INTO tenvyr_review.decisions (id, request_id, actor_id, idempotency_key, payload_hash, action, comment, step_attempt_id, result_hash, created_at) " +
                                "VALUES (?, ?, ?, ?, 'hash', 'APPROVE', 'LGTM', ?, 'res-hash', now())")) {
                    ps.setObject(1, UUID.randomUUID());
                    ps.setObject(2, fixAudit.requestId());
                    ps.setObject(3, validRevFk);
                    ps.setObject(4, UUID.randomUUID());
                    ps.setObject(5, UUID.randomUUID()); // Non-existent step_attempt
                    SQLException ex = assertThrows(SQLException.class, ps::executeUpdate);
                    assertEquals("23503", ex.getSQLState(), "Invalid step_attempt_id FK in decisions must fail with SQLState 23503");
                } finally {
                    conn.rollback(sp);
                }

                // 13g. audit.request_id -> requests(id)
                sp = conn.setSavepoint();
                try (PreparedStatement ps = conn.prepareStatement(
                        "INSERT INTO tenvyr_review.audit (id, request_id, actor_id, action, operation_key, payload_hash, created_at) " +
                                "VALUES (?, ?, ?, 'SUBMIT', ?, 'hash', now())")) {
                    ps.setObject(1, UUID.randomUUID());
                    ps.setObject(2, UUID.randomUUID()); // Non-existent request
                    ps.setObject(3, validUserFk);
                    ps.setObject(4, UUID.randomUUID());
                    SQLException ex = assertThrows(SQLException.class, ps::executeUpdate);
                    assertEquals("23503", ex.getSQLState(), "Invalid request_id FK in audit must fail with SQLState 23503");
                } finally {
                    conn.rollback(sp);
                }

                // 13h. audit.actor_id -> users(id)
                sp = conn.setSavepoint();
                try (PreparedStatement ps = conn.prepareStatement(
                        "INSERT INTO tenvyr_review.audit (id, request_id, actor_id, action, operation_key, payload_hash, created_at) " +
                                "VALUES (?, ?, ?, 'SUBMIT', ?, 'hash', now())")) {
                    ps.setObject(1, UUID.randomUUID());
                    ps.setObject(2, fixAudit.requestId());
                    ps.setObject(3, UUID.randomUUID()); // Non-existent actor
                    ps.setObject(4, UUID.randomUUID());
                    SQLException ex = assertThrows(SQLException.class, ps::executeUpdate);
                    assertEquals("23503", ex.getSQLState(), "Invalid actor_id FK in audit must fail with SQLState 23503");
                } finally {
                    conn.rollback(sp);
                }

            } finally {
                conn.rollback();
            }
        }
    }

    private String extractIndexKeys(String indexDef) {
        if (indexDef == null) {
            return "";
        }
        int start = indexDef.lastIndexOf('(');
        int end = indexDef.lastIndexOf(')');
        if (start != -1 && end != -1 && end > start) {
            return indexDef.substring(start + 1, end).replace("\"", "").replaceAll("\\s+", " ").trim().toLowerCase(Locale.ROOT);
        }
        return "";
    }

    @Test
    @DisplayName("Performance indices exist with exact ordered keys, DESC directions, and id tie-breakers")
    void testRequiredIndexesWithExactOrderingAndTieBreakers() throws Exception {
        try (Connection conn = dataSource.getConnection()) {
            Map<String, String> indexDefs = new HashMap<>();
            try (PreparedStatement ps = conn.prepareStatement(
                    "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'tenvyr_review'")) {
                try (ResultSet rs = ps.executeQuery()) {
                    while (rs.next()) {
                        indexDefs.put(rs.getString("indexname").toLowerCase(Locale.ROOT),
                                rs.getString("indexdef").toLowerCase(Locale.ROOT));
                    }
                }
            }

            // Verify idx_requests_owner_created_id: requests (owner_id, created_at DESC, id DESC)
            String ownerCreatedIdDef = indexDefs.get("idx_requests_owner_created_id");
            assertNotNull(ownerCreatedIdDef, "Index idx_requests_owner_created_id must exist");
            assertEquals("owner_id, created_at desc, id desc", extractIndexKeys(ownerCreatedIdDef),
                    "idx_requests_owner_created_id must match exact ordered keys, DESC directions, and id tie-breaker");

            // Verify idx_requests_created_id: requests (created_at DESC, id DESC)
            String createdIdDef = indexDefs.get("idx_requests_created_id");
            assertNotNull(createdIdDef, "Index idx_requests_created_id must exist");
            assertEquals("created_at desc, id desc", extractIndexKeys(createdIdDef),
                    "idx_requests_created_id must match exact ordered keys, DESC directions, and id tie-breaker");

            // Verify idx_audit_request_created_id: audit (request_id, created_at, id)
            String auditDef = indexDefs.get("idx_audit_request_created_id");
            assertNotNull(auditDef, "Index idx_audit_request_created_id must exist");
            assertEquals("request_id, created_at, id", extractIndexKeys(auditDef),
                    "idx_audit_request_created_id must match exact ordered keys and id tie-breaker");
        }
    }
}
