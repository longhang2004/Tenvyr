package io.tenvyr.review;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.tenvyr.control.ControlPlaneRuntime;
import io.tenvyr.platform.Db;
import io.tenvyr.platform.Json;
import io.tenvyr.review.domain.ReviewTypes.Actor;
import io.tenvyr.review.domain.ReviewTypes.AuditEntry;
import io.tenvyr.review.domain.ReviewTypes.DecisionAction;
import io.tenvyr.review.domain.ReviewTypes.DecisionCommand;
import io.tenvyr.review.domain.ReviewTypes.DecisionView;
import io.tenvyr.review.domain.ReviewTypes.Page;
import io.tenvyr.review.domain.ReviewTypes.ReviewDetail;
import io.tenvyr.review.domain.ReviewTypes.Role;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.datasource.DataSourceUtils;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.authentication.DisabledException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.UUID;

/**
 * Service orchestrating human decisions, owner cancellation, and audit log retrieval.
 * Enforces strict transaction timeout, advisory locking, request row locking,
 * authorization checks, and durable command deduplication.
 */
@Service
public class ReviewDecisionService {

    private final DataSource dataSource;
    private final PlatformTransactionManager transactionManager;
    private final ControlPlaneRuntime engineRuntime;
    private final ReviewRepository reviewRepository;

    @Autowired
    public ReviewDecisionService(
            DataSource dataSource,
            PlatformTransactionManager transactionManager,
            ControlPlaneRuntime engineRuntime,
            ReviewRepository reviewRepository) {
        this.dataSource = dataSource;
        this.transactionManager = transactionManager;
        this.engineRuntime = engineRuntime;
        this.reviewRepository = reviewRepository;
    }

    public record DecisionResult(DecisionView decision, boolean replay) {}

    /**
     * Records a business verdict (APPROVE or REQUEST_CHANGES).
     * Requirements:
     * - Only a REVIEWER different from request owner can decide.
     * - Execution must be COMPLETED with valid verified report.
     * - Locks: advisory lock (actor, "DECIDE", key) -> request row lock -> engine attempt/step/execution lock order.
     * - Idempotency: exact same key, actor, request, and payload -> 200 replay.
     * - Changed payload or duplicate key on differing request -> 409 conflict.
     * - Opposite or parallel decision on same request -> one winner, other gets 409.
     * - Atomically inserts one decision row and one DECIDE audit entry.
     * - Never invokes ApprovalService or alters engine terminal status.
     */
    public DecisionResult decide(Actor actor, UUID requestId, UUID key, DecisionCommand command) {
        if (actor.role() != Role.REVIEWER) {
            throw new AccessDeniedException("Only REVIEWER role can record decisions; current role is " + actor.role());
        }

        ReviewValidation.validateIdempotencyKey(key.toString());
        if (command == null || command.action() == null) {
            throw new IllegalArgumentException("Decision command and action must not be null");
        }

        String comment = command.comment() != null ? command.comment().trim() : null;
        if (comment != null && comment.length() > ReviewValidation.MAX_COMMENT_LENGTH) {
            throw new IllegalArgumentException("Comment length exceeds " + ReviewValidation.MAX_COMMENT_LENGTH + " code units");
        }

        TransactionTemplate txTemplate = new TransactionTemplate(transactionManager);
        try {
            return txTemplate.execute(status -> {
                Connection conn = DataSourceUtils.getConnection(dataSource);
                try {
                    // Local timeouts for this transaction
                    try (Statement stmt = conn.createStatement()) {
                        stmt.execute("SET LOCAL lock_timeout = '2s'");
                        stmt.execute("SET LOCAL statement_timeout = '5s'");
                    }

                    // Recheck user enabled and role in TX to defend against disabled user or changed role in old session
                    try (PreparedStatement ps = conn.prepareStatement(
                            "SELECT role, enabled FROM tenvyr_review.users WHERE id = ?")) {
                        ps.setObject(1, actor.id());
                        try (ResultSet rs = ps.executeQuery()) {
                            if (!rs.next() || !rs.getBoolean("enabled")) {
                                throw new DisabledException("User account is disabled or missing");
                            }
                            if (!"REVIEWER".equals(rs.getString("role"))) {
                                throw new AccessDeniedException("User role is no longer REVIEWER");
                            }
                        }
                    }

                    // Advisory lock for (actorId, "DECIDE", key)
                    long lockKey = ReviewService.deriveAdvisoryLockKey(actor.id(), "DECIDE", key);
                    try (PreparedStatement ps = conn.prepareStatement("SELECT pg_advisory_xact_lock(?)")) {
                        ps.setLong(1, lockKey);
                        ps.execute();
                    }

                    // Check idempotency across ANY request for this actor + key
                    String payloadHash = Json.hash(Json.object(
                            "requestId", requestId.toString(),
                            "action", command.action().name(),
                            "comment", comment == null ? "" : comment
                    ));

                    try (PreparedStatement ps = conn.prepareStatement(
                            "SELECT id, request_id, actor_id, action, comment, step_attempt_id, result_hash, created_at, payload_hash " +
                                    "FROM tenvyr_review.decisions WHERE actor_id = ? AND idempotency_key = ?")) {
                        ps.setObject(1, actor.id());
                        ps.setObject(2, key);
                        try (ResultSet rs = ps.executeQuery()) {
                            if (rs.next()) {
                                UUID storedReqId = rs.getObject("request_id", UUID.class);
                                String storedPayloadHash = rs.getString("payload_hash").trim();
                                if (!requestId.equals(storedReqId) || !storedPayloadHash.equals(payloadHash)) {
                                    throw new ReviewErrors.IdempotencyConflictException("Idempotency key already used with differing payload or request");
                                }
                                DecisionView existingView = new DecisionView(
                                        rs.getObject("id", UUID.class),
                                        storedReqId,
                                        rs.getObject("actor_id", UUID.class),
                                        DecisionAction.valueOf(rs.getString("action")),
                                        rs.getString("comment"),
                                        rs.getObject("step_attempt_id", UUID.class),
                                        rs.getString("result_hash"),
                                        rs.getTimestamp("created_at").toInstant()
                                );
                                return new DecisionResult(existingView, true);
                            }
                        }
                    }

                    // Lock request row FOR UPDATE
                    UUID ownerId;
                    UUID executionId;
                    try (PreparedStatement ps = conn.prepareStatement(
                            "SELECT owner_id, execution_id FROM tenvyr_review.requests WHERE id = ? FOR UPDATE")) {
                        ps.setObject(1, requestId);
                        try (ResultSet rs = ps.executeQuery()) {
                            if (!rs.next()) {
                                throw new ReviewErrors.NotFoundException("Review request not found: " + requestId);
                            }
                            ownerId = rs.getObject("owner_id", UUID.class);
                            executionId = rs.getObject("execution_id", UUID.class);
                        }
                    }

                    // Self-decision guard: reviewer cannot be the owner
                    if (actor.id().equals(ownerId)) {
                        throw new AccessDeniedException("Reviewer cannot record decision on own submitted review");
                    }

                    // Check if a decision already exists on this request (by anyone)
                    try (PreparedStatement ps = conn.prepareStatement(
                            "SELECT id, action FROM tenvyr_review.decisions WHERE request_id = ?")) {
                        ps.setObject(1, requestId);
                        try (ResultSet rs = ps.executeQuery()) {
                            if (rs.next()) {
                                throw new ReviewErrors.IdempotencyConflictException("A final decision has already been recorded for this review");
                            }
                        }
                    }

                    // Check execution state and verified report
                    String execStatus;
                    try (PreparedStatement ps = conn.prepareStatement("SELECT status FROM executions WHERE id = ?")) {
                        ps.setObject(1, executionId);
                        try (ResultSet rs = ps.executeQuery()) {
                            if (!rs.next()) {
                                throw new ReviewErrors.NotFoundException("Execution not found: " + executionId);
                            }
                            execStatus = rs.getString("status");
                        }
                    }

                    if (!"COMPLETED".equalsIgnoreCase(execStatus)) {
                        throw new ReviewErrors.ReportNotReadyException("Report is not ready: execution has not completed");
                    }

                    // Verify provenance (SUCCESS attempt, APPLIED inbox row, matching hashes)
                    ReviewRepository.ProvenanceRow provenance = reviewRepository.findVerifiedProvenance(executionId);
                    if (provenance == null) {
                        throw new ReviewErrors.ReviewReportInvalidException("Missing verified report provenance");
                    }
                    // Validate report strictly
                    try {
                        JsonNode payloadNode = Json.parse(provenance.payloadJson());
                        String calcHash = Json.hash(payloadNode);
                        if (!provenance.payloadHash().trim().equals(calcHash.trim())) {
                            throw new ReviewErrors.ReviewReportInvalidException("Report payload hash mismatch");
                        }
                        ReviewReportMapper.fromOutput(payloadNode.path("output"));
                    } catch (Exception e) {
                        throw new ReviewErrors.ReviewReportInvalidException("Report invalid: " + e.getMessage());
                    }

                    // Insert decision
                    UUID decisionId = UUID.randomUUID();
                    Instant now = Instant.now();
                    try (PreparedStatement ps = conn.prepareStatement(
                            "INSERT INTO tenvyr_review.decisions " +
                                    "(id, request_id, actor_id, idempotency_key, payload_hash, action, comment, step_attempt_id, result_hash, created_at) " +
                                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")) {
                        ps.setObject(1, decisionId);
                        ps.setObject(2, requestId);
                        ps.setObject(3, actor.id());
                        ps.setObject(4, key);
                        ps.setString(5, payloadHash);
                        ps.setString(6, command.action().name());
                        ps.setString(7, comment);
                        ps.setObject(8, provenance.attemptId());
                        ps.setString(9, provenance.payloadHash().trim());
                        ps.setTimestamp(10, Timestamp.from(now));
                        ps.executeUpdate();
                    }

                    // Insert DECIDE audit row
                    UUID auditId = UUID.randomUUID();
                    try (PreparedStatement ps = conn.prepareStatement(
                            "INSERT INTO tenvyr_review.audit " +
                                    "(id, request_id, actor_id, action, operation_key, payload_hash, created_at) " +
                                    "VALUES (?, ?, ?, 'DECIDE', ?, ?, ?)")) {
                        ps.setObject(1, auditId);
                        ps.setObject(2, requestId);
                        ps.setObject(3, actor.id());
                        ps.setObject(4, key);
                        ps.setString(5, payloadHash);
                        ps.setTimestamp(6, Timestamp.from(now));
                        ps.executeUpdate();
                    }

                    DecisionView view = new DecisionView(
                            decisionId,
                            requestId,
                            actor.id(),
                            command.action(),
                            comment,
                            provenance.attemptId(),
                            provenance.payloadHash().trim(),
                            now
                    );
                    return new DecisionResult(view, false);

                } catch (SQLException e) {
                    if (ReviewErrors.isTransient(e)) {
                        throw new ReviewErrors.DatabaseUnavailableException("Database temporarily unavailable", e);
                    }
                    throw new RuntimeException("Database error during decision", e);
                } catch (RuntimeException | Error e) {
                    throw e;
                } catch (Exception e) {
                    throw new RuntimeException("Decision processing failed", e);
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

    public record CancelResult(ReviewDetail detail, boolean replay) {}

    public ReviewDetail cancel(Actor actor, UUID requestId, UUID key) {
        return cancelWithResult(actor, requestId, key).detail();
    }

    /**
     * Cancels an ongoing review.
     * Requirements:
     * - Only owner SUBMITTER can cancel.
     * - Only permitted while in PROCESSING.
     * - Lock order: advisory lock (actor, "CANCEL", key) -> request row lock -> engine lock order.
     * - Invokes cancelExecutionWithManager on SAME connection.
     * - Re-reads authoritative engine state: if completion won, rolls back and returns 409.
     * - Writes CANCEL audit row only when cancellation actually won.
     * - Idempotent replay with same key returns 200 with stored outcome.
     * - Same key on different request returns 409 conflict.
     */
    public CancelResult cancelWithResult(Actor actor, UUID requestId, UUID key) {
        if (actor.role() != Role.SUBMITTER) {
            throw new AccessDeniedException("Only SUBMITTER role can cancel reviews; current role is " + actor.role());
        }

        ReviewValidation.validateIdempotencyKey(key.toString());

        TransactionTemplate txTemplate = new TransactionTemplate(transactionManager);
        try {
            return txTemplate.execute(status -> {
                Connection conn = DataSourceUtils.getConnection(dataSource);
                try {
                    try (Statement stmt = conn.createStatement()) {
                        stmt.execute("SET LOCAL lock_timeout = '2s'");
                        stmt.execute("SET LOCAL statement_timeout = '5s'");
                    }

                    // Recheck actor in DB
                    try (PreparedStatement ps = conn.prepareStatement(
                            "SELECT role, enabled FROM tenvyr_review.users WHERE id = ?")) {
                        ps.setObject(1, actor.id());
                        try (ResultSet rs = ps.executeQuery()) {
                            if (!rs.next() || !rs.getBoolean("enabled")) {
                                throw new DisabledException("User account is disabled or missing");
                            }
                            if (!"SUBMITTER".equals(rs.getString("role"))) {
                                throw new AccessDeniedException("User role is no longer SUBMITTER");
                            }
                        }
                    }

                    // Operation advisory lock (actorId, "CANCEL", key)
                    long lockKey = ReviewService.deriveAdvisoryLockKey(actor.id(), "CANCEL", key);
                    try (PreparedStatement ps = conn.prepareStatement("SELECT pg_advisory_xact_lock(?)")) {
                        ps.setLong(1, lockKey);
                        ps.execute();
                    }

                    // Payload hash for cancel binds request ID
                    String payloadHash = Json.hash(Json.object(
                            "requestId", requestId.toString(),
                            "action", "CANCEL"
                    ));

                    // Check existing CANCEL audit for this actor and key across ANY request
                    try (PreparedStatement ps = conn.prepareStatement(
                            "SELECT request_id, payload_hash FROM tenvyr_review.audit WHERE actor_id = ? AND action = 'CANCEL' AND operation_key = ?")) {
                        ps.setObject(1, actor.id());
                        ps.setObject(2, key);
                        try (ResultSet rs = ps.executeQuery()) {
                            if (rs.next()) {
                                UUID storedReqId = rs.getObject("request_id", UUID.class);
                                String storedHash = rs.getString("payload_hash").trim();
                                if (!requestId.equals(storedReqId) || !storedHash.equals(payloadHash)) {
                                    throw new ReviewErrors.IdempotencyConflictException("Cancel idempotency key already used on a different request or payload");
                                }
                                // Replay: return current review detail
                                ReviewDetail detail = reviewRepository.get(actor, requestId);
                                return new CancelResult(detail, true);
                            }
                        }
                    }

                    // Request row lock FOR UPDATE
                    UUID ownerId;
                    UUID executionId;
                    try (PreparedStatement ps = conn.prepareStatement(
                            "SELECT owner_id, execution_id FROM tenvyr_review.requests WHERE id = ? FOR UPDATE")) {
                        ps.setObject(1, requestId);
                        try (ResultSet rs = ps.executeQuery()) {
                            if (!rs.next()) {
                                throw new ReviewErrors.NotFoundException("Review request not found: " + requestId);
                            }
                            ownerId = rs.getObject("owner_id", UUID.class);
                            executionId = rs.getObject("execution_id", UUID.class);
                        }
                    }

                    // Ownership check: must be owner
                    if (!actor.id().equals(ownerId)) {
                        throw new ReviewErrors.NotFoundException("Review request not found: " + requestId);
                    }

                    // Check current execution status
                    String execStatus;
                    try (PreparedStatement ps = conn.prepareStatement("SELECT status FROM executions WHERE id = ?")) {
                        ps.setObject(1, executionId);
                        try (ResultSet rs = ps.executeQuery()) {
                            if (!rs.next()) {
                                throw new ReviewErrors.NotFoundException("Execution not found: " + executionId);
                            }
                            execStatus = rs.getString("status");
                        }
                    }

                    if (!"PENDING".equalsIgnoreCase(execStatus) && !"RUNNING".equalsIgnoreCase(execStatus)) {
                        throw new ReviewErrors.IdempotencyConflictException("Cannot cancel review in status: " + execStatus);
                    }

                    // Execute engine cancellation on SAME connection
                    ObjectNode cancelledExec = engineRuntime.executions().cancelExecutionWithManager(
                            conn, executionId.toString(), "Cancelled by owner");

                    // Re-read authoritative execution state to confirm cancellation won over concurrent completion
                    String postCancelStatus;
                    try (PreparedStatement ps = conn.prepareStatement("SELECT status FROM executions WHERE id = ?")) {
                        ps.setObject(1, executionId);
                        try (ResultSet rs = ps.executeQuery()) {
                            rs.next();
                            postCancelStatus = rs.getString("status");
                        }
                    }

                    if (!"CANCELLED".equalsIgnoreCase(postCancelStatus)) {
                        // Concurrent completion won! Rollback cancel audit / changes
                        throw new ReviewErrors.IdempotencyConflictException("Completion won the race; execution status is " + postCancelStatus);
                    }

                    // Cancellation won! Insert CANCEL audit row
                    UUID auditId = UUID.randomUUID();
                    Instant now = Instant.now();
                    try (PreparedStatement ps = conn.prepareStatement(
                            "INSERT INTO tenvyr_review.audit " +
                                    "(id, request_id, actor_id, action, operation_key, payload_hash, created_at) " +
                                    "VALUES (?, ?, ?, 'CANCEL', ?, ?, ?)")) {
                        ps.setObject(1, auditId);
                        ps.setObject(2, requestId);
                        ps.setObject(3, actor.id());
                        ps.setObject(4, key);
                        ps.setString(5, payloadHash);
                        ps.setTimestamp(6, Timestamp.from(now));
                        ps.executeUpdate();
                    }

                    ReviewDetail detail = reviewRepository.get(actor, requestId);
                    return new CancelResult(detail, false);

                } catch (SQLException e) {
                    if (ReviewErrors.isTransient(e)) {
                        throw new ReviewErrors.DatabaseUnavailableException("Database temporarily unavailable", e);
                    }
                    throw new RuntimeException("Database error during cancel", e);
                } catch (RuntimeException | Error e) {
                    throw e;
                } catch (Exception e) {
                    throw new RuntimeException("Cancellation failed", e);
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
     * Retrieves keyset-paginated audit log for a review request.
     * Reapplies visibility filter: owner SUBMITTER or REVIEWER can read, other submitter receives 404.
     */
    public Page<AuditEntry> audit(Actor actor, UUID requestId, int limit, String after) {
        int validatedLimit = ReviewValidation.validateLimit(limit);
        ReviewValidation.Cursor cursor = (after != null && !after.isBlank())
                ? ReviewValidation.validateCursor(after)
                : null;

        Page<AuditEntry> page = reviewRepository.listAudit(actor, requestId, validatedLimit, cursor);
        if (page == null) {
            throw new ReviewErrors.NotFoundException("Review request not found: " + requestId);
        }
        return page;
    }
}
