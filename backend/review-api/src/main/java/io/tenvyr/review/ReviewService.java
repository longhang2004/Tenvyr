package io.tenvyr.review;

import com.fasterxml.jackson.databind.node.ObjectNode;
import io.tenvyr.control.ControlPlaneRuntime;
import io.tenvyr.platform.Json;
import io.tenvyr.review.domain.ReviewTypes.Actor;
import io.tenvyr.review.domain.ReviewTypes.CreateReview;
import io.tenvyr.review.domain.ReviewTypes.Page;
import io.tenvyr.review.domain.ReviewTypes.ReviewDetail;
import io.tenvyr.review.domain.ReviewTypes.ReviewReport;
import io.tenvyr.review.domain.ReviewTypes.ReviewSummary;
import io.tenvyr.review.domain.ReviewTypes.Role;
import io.tenvyr.review.domain.ReviewTypes.Submission;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.datasource.DataSourceUtils;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionException;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.Locale;
import java.util.UUID;

/**
 * Service orchestrating atomic idempotent review submission, authorized bounded reads,
 * and report projections.
 * Submissions execute in a single Spring-managed TransactionTemplate transaction on the
 * same PostgreSQL connection, taking an operation advisory lock, resolving replay/conflict,
 * materializing the engine execution, and inserting business request and audit rows.
 */
@Service
public class ReviewService {

    @FunctionalInterface
    public interface PostMaterializationObserver {
        void onMaterialized(Connection connection, UUID executionId) throws Exception;
        PostMaterializationObserver NOOP = (conn, execId) -> {};
    }

    private final DataSource dataSource;
    private final PlatformTransactionManager transactionManager;
    private final ControlPlaneRuntime engineRuntime;
    private final ReviewRepository reviewRepository;
    private final PostMaterializationObserver postMaterializationObserver;

    @Autowired
    public ReviewService(
            DataSource dataSource,
            PlatformTransactionManager transactionManager,
            ControlPlaneRuntime engineRuntime,
            ReviewRepository reviewRepository,
            java.util.Optional<PostMaterializationObserver> postMaterializationObserver) {
        this.dataSource = dataSource;
        this.transactionManager = transactionManager;
        this.engineRuntime = engineRuntime;
        this.reviewRepository = reviewRepository;
        this.postMaterializationObserver = postMaterializationObserver != null && postMaterializationObserver.isPresent()
                ? postMaterializationObserver.get()
                : PostMaterializationObserver.NOOP;
    }

    public ReviewService(
            DataSource dataSource,
            PlatformTransactionManager transactionManager,
            ControlPlaneRuntime engineRuntime,
            ReviewRepository reviewRepository) {
        this(dataSource, transactionManager, engineRuntime, reviewRepository, java.util.Optional.empty());
    }

    /**
     * Derives deterministic 64-bit advisory lock key from (actorId, action, idempotencyKey).
     * Used by both production submission and test lock contention fixtures.
     */
    static long deriveAdvisoryLockKey(UUID actorId, String action, UUID idempotencyKey) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            ByteBuffer bb = ByteBuffer.allocate(32);
            bb.putLong(actorId.getMostSignificantBits());
            bb.putLong(actorId.getLeastSignificantBits());
            bb.putLong(idempotencyKey.getMostSignificantBits());
            bb.putLong(idempotencyKey.getLeastSignificantBits());
            md.update(bb.array());
            md.update(action.getBytes(StandardCharsets.UTF_8));
            byte[] digest = md.digest();
            return ByteBuffer.wrap(digest).getLong();
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 digest unavailable", e);
        }
    }

    static long deriveAdvisoryLockKey(UUID actorId, UUID idempotencyKey) {
        return deriveAdvisoryLockKey(actorId, "SUBMIT", idempotencyKey);
    }

    /**
     * Executes atomic idempotent review submission.
     * Enforces SUBMITTER role, applies timeouts, advisory locking, idempotency check,
     * engine materialization on SAME connection, and request + SUBMIT audit insertion.
     */
    public Submission submit(Actor actor, UUID key, CreateReview input) {
        if (actor.role() != Role.SUBMITTER) {
            throw new AccessDeniedException("Only SUBMITTER role can submit reviews; current role is " + actor.role());
        }

        ReviewValidation.validateCreateReview(input);
        ReviewValidation.validateIdempotencyKey(key.toString());

        String normalizedTitle = input.title().trim();
        String normalizedLanguage = input.language().trim().toLowerCase(Locale.ROOT);
        String code = input.code(); // Preserved exactly

        String requestHash = Json.hash(Json.object(
                "title", normalizedTitle,
                "language", normalizedLanguage,
                "code", code
        ));

        TransactionTemplate txTemplate = new TransactionTemplate(transactionManager);

        try {
            return txTemplate.execute(status -> {
                Connection conn = DataSourceUtils.getConnection(dataSource);
                try {
                    // 1. Apply local statement and lock timeouts for this transaction
                    try (Statement stmt = conn.createStatement()) {
                        stmt.execute("SET LOCAL lock_timeout = '2s'");
                        stmt.execute("SET LOCAL statement_timeout = '5s'");
                    }

                    // 2. Acquire transaction-scoped advisory lock derived from (owner, "SUBMIT", key)
                    long lockKey = deriveAdvisoryLockKey(actor.id(), "SUBMIT", key);
                    try (PreparedStatement ps = conn.prepareStatement("SELECT pg_advisory_xact_lock(?)")) {
                        ps.setLong(1, lockKey);
                        ps.execute();
                    }

                    // 3. Replay / conflict check: inspect existing request for (owner_id, idempotency_key)
                    try (PreparedStatement ps = conn.prepareStatement(
                            "SELECT id, request_hash, execution_id, created_at " +
                                    "FROM tenvyr_review.requests WHERE owner_id = ? AND idempotency_key = ?")) {
                        ps.setObject(1, actor.id());
                        ps.setObject(2, key);
                        try (ResultSet rs = ps.executeQuery()) {
                            if (rs.next()) {
                                String storedHash = rs.getString("request_hash").trim();
                                if (!storedHash.equals(requestHash)) {
                                    throw new ReviewErrors.IdempotencyConflictException(
                                            "Idempotency key already used with differing payload");
                                }
                                UUID existingId = rs.getObject("id", UUID.class);
                                UUID existingExecId = rs.getObject("execution_id", UUID.class);
                                Instant existingCreated = rs.getTimestamp("created_at").toInstant();
                                return new Submission(existingId, "PROCESSING", existingCreated, existingExecId);
                            }
                        }
                    }

                    // 4. Load fixed internal pipeline binding
                    ObjectNode pipeline = PipelineCatalog.ensure(conn);

                    // 5. Materialize execution on SAME connection with authority deadline now + 180s
                    Instant deadline = Instant.now().plusSeconds(180);
                    ObjectNode inputJson = Json.object("code", code, "language", normalizedLanguage);
                    ObjectNode execution = engineRuntime.executions().materializeExecutionWithManager(
                            conn, pipeline, inputJson, deadline);
                    UUID executionId = UUID.fromString(execution.path("id").asText());

                    // 6. Invoke test fault-injection observation seam on SAME connection
                    postMaterializationObserver.onMaterialized(conn, executionId);

                    // 7. Insert review request
                    UUID requestId = UUID.randomUUID();
                    Instant createdAt = Instant.now();
                    try (PreparedStatement ps = conn.prepareStatement(
                            "INSERT INTO tenvyr_review.requests " +
                                    "(id, owner_id, idempotency_key, request_hash, title, language, code, execution_id, created_at) " +
                                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")) {
                        ps.setObject(1, requestId);
                        ps.setObject(2, actor.id());
                        ps.setObject(3, key);
                        ps.setString(4, requestHash);
                        ps.setString(5, normalizedTitle);
                        ps.setString(6, normalizedLanguage);
                        ps.setString(7, code);
                        ps.setObject(8, executionId);
                        ps.setTimestamp(9, Timestamp.from(createdAt));
                        ps.executeUpdate();
                    }

                    // 8. Insert SUBMIT audit row
                    UUID auditId = UUID.randomUUID();
                    try (PreparedStatement ps = conn.prepareStatement(
                            "INSERT INTO tenvyr_review.audit " +
                                    "(id, request_id, actor_id, action, operation_key, payload_hash, created_at) " +
                                    "VALUES (?, ?, ?, 'SUBMIT', ?, ?, ?)")) {
                        ps.setObject(1, auditId);
                        ps.setObject(2, requestId);
                        ps.setObject(3, actor.id());
                        ps.setObject(4, key);
                        ps.setString(5, requestHash);
                        ps.setTimestamp(6, Timestamp.from(createdAt));
                        ps.executeUpdate();
                    }

                    return new Submission(requestId, "PROCESSING", createdAt, executionId);

                } catch (SQLException e) {
                    if (ReviewErrors.isTransient(e)) {
                        throw new ReviewErrors.DatabaseUnavailableException("Database temporarily unavailable", e);
                    }
                    throw new RuntimeException("Database error during submission", e);
                } catch (RuntimeException | Error e) {
                    throw e;
                } catch (Exception e) {
                    throw new RuntimeException("Materialization failed", e);
                } finally {
                    DataSourceUtils.releaseConnection(conn, dataSource);
                }
            });
        } catch (Exception e) {
            if (ReviewErrors.isTransient(e)) {
                throw new ReviewErrors.DatabaseUnavailableException("Database temporarily unavailable", e);
            }
            if (e instanceof RuntimeException re) {
                throw re;
            }
            throw new RuntimeException(e);
        }
    }

    /**
     * Retrieves review detail by ID. Enforces ownership/visibility.
     */
    public ReviewDetail get(Actor actor, UUID id) {
        ReviewDetail detail = reviewRepository.get(actor, id);
        if (detail == null) {
            throw new ReviewErrors.NotFoundException("Review not found: " + id);
        }
        return detail;
    }

    /**
     * Lists reviews with keyset pagination and visibility enforcement.
     */
    public Page<ReviewSummary> list(Actor actor, int limit, String after) {
        int validatedLimit = ReviewValidation.validateLimit(limit);
        ReviewValidation.Cursor cursor = (after != null && !after.isBlank())
                ? ReviewValidation.validateCursor(after)
                : null;
        return reviewRepository.list(actor, validatedLimit, cursor);
    }

    /**
     * Resolves typed ReviewReport for completed review.
     */
    public ReviewReport report(Actor actor, UUID id) {
        ReviewReport report = reviewRepository.getReport(actor, id);
        if (report == null) {
            throw new ReviewErrors.NotFoundException("Review not found: " + id);
        }
        return report;
    }
}
