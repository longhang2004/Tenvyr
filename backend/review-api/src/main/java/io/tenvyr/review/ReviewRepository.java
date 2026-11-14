package io.tenvyr.review;

import com.fasterxml.jackson.databind.JsonNode;
import io.tenvyr.platform.Json;
import io.tenvyr.review.domain.ReviewTypes.Actor;
import io.tenvyr.review.domain.ReviewTypes.DecisionAction;
import io.tenvyr.review.domain.ReviewTypes.DecisionView;
import io.tenvyr.review.domain.ReviewTypes.Page;
import io.tenvyr.review.domain.ReviewTypes.ReviewDetail;
import io.tenvyr.review.domain.ReviewTypes.ReviewReport;
import io.tenvyr.review.domain.ReviewTypes.ReviewStatus;
import io.tenvyr.review.domain.ReviewTypes.ReviewSummary;
import io.tenvyr.review.domain.ReviewTypes.Role;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.nio.charset.StandardCharsets;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.UUID;

/**
 * Repository for authorized bounded reads and report projections.
 * Enforces ownership and visibility in prepared SQL queries.
 * Excludes source code and reports from list summaries.
 */
@Repository
public class ReviewRepository {

    private final JdbcTemplate jdbcTemplate;

    public ReviewRepository(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    private record RequestRow(UUID id, UUID ownerId, String title, String language,
                              String code, UUID executionId, Instant createdAt) {}

    /**
     * Finds a review request by ID with ownership and visibility enforcement in SQL.
     * Returns null if not found or invisible to the querying actor without materializing private code.
     */
    public ReviewDetail get(Actor actor, UUID id) {
        List<RequestRow> rows;
        if (actor.role() == Role.REVIEWER) {
            rows = jdbcTemplate.query(
                    "SELECT id, owner_id, title, language, code, execution_id, created_at " +
                            "FROM tenvyr_review.requests WHERE id = ?",
                    (rs, rowNum) -> mapRequestRow(rs),
                    id
            );
        } else {
            rows = jdbcTemplate.query(
                    "SELECT id, owner_id, title, language, code, execution_id, created_at " +
                            "FROM tenvyr_review.requests WHERE id = ? AND owner_id = ?",
                    (rs, rowNum) -> mapRequestRow(rs),
                    id,
                    actor.id()
            );
        }

        if (rows.isEmpty()) {
            return null;
        }

        RequestRow row = rows.get(0);
        StatusAndError se = projectExecutionStatus(row.id(), row.executionId());
        int attemptCount = queryAttemptCount(row.executionId());
        DecisionView decision = queryDecision(row.id());

        return new ReviewDetail(
                row.id(),
                row.title(),
                row.language(),
                row.code(),
                se.status(),
                row.createdAt(),
                row.executionId(),
                attemptCount,
                se.errorCode(),
                decision
        );
    }

    /**
     * Keyset-paginated list query with prepared statements and visibility enforcement.
     * SUBMITTER sees only own requests; REVIEWER sees all requests.
     */
    public Page<ReviewSummary> list(Actor actor, int limit, ReviewValidation.Cursor cursor) {
        int fetchLimit = limit + 1;
        List<ReviewSummaryRow> fetched;

        if (actor.role() == Role.REVIEWER) {
            if (cursor == null) {
                fetched = jdbcTemplate.query(
                        "SELECT id, title, language, execution_id, created_at FROM tenvyr_review.requests " +
                                "ORDER BY created_at DESC, id DESC LIMIT ?",
                        (rs, rowNum) -> mapSummaryRow(rs),
                        fetchLimit
                );
            } else {
                fetched = jdbcTemplate.query(
                        "SELECT id, title, language, execution_id, created_at FROM tenvyr_review.requests " +
                                "WHERE (created_at < ? OR (created_at = ? AND id < ?)) " +
                                "ORDER BY created_at DESC, id DESC LIMIT ?",
                        (rs, rowNum) -> mapSummaryRow(rs),
                        Timestamp.from(cursor.createdAt()),
                        Timestamp.from(cursor.createdAt()),
                        cursor.id(),
                        fetchLimit
                );
            }
        } else {
            if (cursor == null) {
                fetched = jdbcTemplate.query(
                        "SELECT id, title, language, execution_id, created_at FROM tenvyr_review.requests " +
                                "WHERE owner_id = ? " +
                                "ORDER BY created_at DESC, id DESC LIMIT ?",
                        (rs, rowNum) -> mapSummaryRow(rs),
                        actor.id(),
                        fetchLimit
                );
            } else {
                fetched = jdbcTemplate.query(
                        "SELECT id, title, language, execution_id, created_at FROM tenvyr_review.requests " +
                                "WHERE owner_id = ? AND (created_at < ? OR (created_at = ? AND id < ?)) " +
                                "ORDER BY created_at DESC, id DESC LIMIT ?",
                        (rs, rowNum) -> mapSummaryRow(rs),
                        actor.id(),
                        Timestamp.from(cursor.createdAt()),
                        Timestamp.from(cursor.createdAt()),
                        cursor.id(),
                        fetchLimit
                );
            }
        }

        boolean hasMore = fetched.size() > limit;
        List<ReviewSummaryRow> pageRows = hasMore ? fetched.subList(0, limit) : fetched;

        List<ReviewSummary> items = new ArrayList<>();
        for (ReviewSummaryRow r : pageRows) {
            StatusAndError se = projectExecutionStatus(r.id(), r.executionId());
            items.add(new ReviewSummary(r.id(), r.title(), r.language(), se.status(), r.createdAt()));
        }

        String nextCursor = null;
        if (hasMore && !pageRows.isEmpty()) {
            ReviewSummaryRow last = pageRows.get(pageRows.size() - 1);
            String payload = Json.stringify(Json.object(
                    "createdAt", last.createdAt().toString(),
                    "id", last.id().toString()
            ));
            nextCursor = Base64.getUrlEncoder().encodeToString(payload.getBytes(StandardCharsets.UTF_8));
        }

        return new Page<>(items, nextCursor);
    }

    /**
     * Resolves the typed ReviewReport for a given request ID.
     * Enforces visibility predicate in SQL without materializing private code.
     * Returns null if request is invisible/non-existent.
     * Throws ReportNotReadyException if execution is not completed.
     * Throws ReviewReportInvalidException if completed output is absent or violates contracts.
     */
    public ReviewReport getReport(Actor actor, UUID id) {
        List<UUID> execIds;
        if (actor.role() == Role.REVIEWER) {
            execIds = jdbcTemplate.query(
                    "SELECT execution_id FROM tenvyr_review.requests WHERE id = ?",
                    (rs, rowNum) -> rs.getObject("execution_id", UUID.class),
                    id
            );
        } else {
            execIds = jdbcTemplate.query(
                    "SELECT execution_id FROM tenvyr_review.requests WHERE id = ? AND owner_id = ?",
                    (rs, rowNum) -> rs.getObject("execution_id", UUID.class),
                    id,
                    actor.id()
            );
        }

        if (execIds.isEmpty()) {
            return null;
        }

        UUID executionId = execIds.get(0);
        List<String> execStatus = jdbcTemplate.query(
                "SELECT status FROM executions WHERE id = ?",
                (rs, rowNum) -> rs.getString("status"),
                executionId
        );

        if (execStatus.isEmpty() || !"COMPLETED".equalsIgnoreCase(execStatus.get(0))) {
            throw new ReviewErrors.ReportNotReadyException("Report is not ready: execution has not completed");
        }

        return resolveVerifiedReport(executionId);
    }

    private record ProvenanceRow(
            UUID attemptId,
            String attemptInvocationId,
            UUID attemptExecutionId,
            UUID logicalStepId,
            String inboxInvocationId,
            String payloadJson,
            String payloadHash
    ) {}

    /**
     * Shared report provenance helper for both report and status projections.
     * Uses canonical persisted successful review attempt and verified inbox payload output (not attempt.result),
     * checking payload hash and matching execution/step/invocation identity against real schema/engine.
     */
    private ReviewReport resolveVerifiedReport(UUID executionId) {
        List<ProvenanceRow> rows = jdbcTemplate.query(
                "SELECT a.id AS attempt_id, " +
                        "a.\"invocationId\" AS attempt_inv_id, " +
                        "a.\"executionId\" AS attempt_exec_id, " +
                        "a.\"logicalStepId\" AS logical_step_id, " +
                        "i.\"invocationId\" AS inbox_inv_id, " +
                        "i.payload, " +
                        "i.\"payloadHash\" " +
                        "FROM step_attempts a " +
                        "JOIN step_executions se ON a.\"logicalStepId\" = se.id " +
                        "JOIN result_inbox i ON i.\"stepAttemptId\" = a.id " +
                        "WHERE a.\"executionId\" = ? " +
                        "  AND se.\"stepId\" = 'review' " +
                        "  AND a.status = 'SUCCESS' " +
                        "  AND i.status = 'APPLIED' " +
                        "ORDER BY a.\"attemptNumber\" DESC LIMIT 1",
                (rs, rowNum) -> new ProvenanceRow(
                        rs.getObject("attempt_id", UUID.class),
                        rs.getString("attempt_inv_id"),
                        rs.getObject("attempt_exec_id", UUID.class),
                        rs.getObject("logical_step_id", UUID.class),
                        rs.getString("inbox_inv_id"),
                        rs.getString("payload"),
                        rs.getString("payloadHash")
                ),
                executionId
        );

        if (rows.isEmpty()) {
            throw new ReviewErrors.ReviewReportInvalidException("Missing successful applied review result inbox record");
        }

        ProvenanceRow row = rows.get(0);
        if (row.payloadJson() == null || row.payloadJson().isBlank() || row.payloadHash() == null) {
            throw new ReviewErrors.ReviewReportInvalidException("Result inbox payload or payloadHash is null/blank");
        }

        JsonNode payloadNode;
        try {
            payloadNode = Json.parse(row.payloadJson());
        } catch (Exception e) {
            throw new ReviewErrors.ReviewReportInvalidException("Corrupted result inbox JSON payload");
        }

        String calculatedHash = Json.hash(payloadNode);
        if (!row.payloadHash().trim().equals(calculatedHash.trim())) {
            throw new ReviewErrors.ReviewReportInvalidException("Result inbox payload hash mismatch");
        }

        // Match execution, step, and invocation identities
        String payloadExecId = payloadNode.path("executionId").asText();
        String payloadStepExecId = payloadNode.path("stepExecutionId").asText();
        String payloadInvId = payloadNode.path("invocationId").asText();

        if (!executionId.toString().equalsIgnoreCase(payloadExecId)) {
            throw new ReviewErrors.ReviewReportInvalidException("Result inbox payload executionId mismatch");
        }
        if (row.logicalStepId() == null || !row.logicalStepId().toString().equalsIgnoreCase(payloadStepExecId)) {
            throw new ReviewErrors.ReviewReportInvalidException("Result inbox payload stepExecutionId mismatch");
        }
        if (row.attemptInvocationId() == null || !row.attemptInvocationId().equals(payloadInvId)) {
            throw new ReviewErrors.ReviewReportInvalidException("Result inbox payload invocationId mismatch");
        }
        if (row.inboxInvocationId() != null && !row.inboxInvocationId().equals(row.attemptInvocationId())) {
            throw new ReviewErrors.ReviewReportInvalidException("Result inbox invocationId mismatch");
        }

        JsonNode outputNode = payloadNode.path("output");
        if (outputNode.isMissingNode() || outputNode.isNull() || !outputNode.isObject()) {
            throw new ReviewErrors.ReviewReportInvalidException("Verified inbox payload missing valid output object");
        }

        try {
            return ReviewReportMapper.fromOutput(outputNode);
        } catch (Exception e) {
            throw new ReviewErrors.ReviewReportInvalidException("Review report violates business contract: " + e.getMessage());
        }
    }

    private record StatusAndError(ReviewStatus status, String errorCode) {}

    private StatusAndError projectExecutionStatus(UUID requestId, UUID executionId) {
        List<String> execStatusList = jdbcTemplate.query(
                "SELECT status FROM executions WHERE id = ?",
                (rs, rowNum) -> rs.getString("status"),
                executionId
        );

        if (execStatusList.isEmpty()) {
            return new StatusAndError(ReviewStatus.PROCESSING, null);
        }

        String execStatus = execStatusList.get(0);
        if ("PENDING".equalsIgnoreCase(execStatus) || "RUNNING".equalsIgnoreCase(execStatus)) {
            return new StatusAndError(ReviewStatus.PROCESSING, null);
        }

        if ("CANCELLED".equalsIgnoreCase(execStatus)) {
            return new StatusAndError(ReviewStatus.CANCELLED, null);
        }

        if ("FAILED".equalsIgnoreCase(execStatus)) {
            return new StatusAndError(ReviewStatus.FAILED, "EXECUTION_FAILED");
        }

        if ("COMPLETED".equalsIgnoreCase(execStatus)) {
            try {
                resolveVerifiedReport(executionId);

                // Check decision on this request
                DecisionView decision = queryDecision(requestId);
                if (decision != null) {
                    if (decision.action() == DecisionAction.APPROVE) {
                        return new StatusAndError(ReviewStatus.APPROVED, null);
                    } else if (decision.action() == DecisionAction.REQUEST_CHANGES) {
                        return new StatusAndError(ReviewStatus.CHANGES_REQUESTED, null);
                    }
                }

                return new StatusAndError(ReviewStatus.AWAITING_REVIEW, null);
            } catch (ReviewErrors.ReviewReportInvalidException e) {
                return new StatusAndError(ReviewStatus.FAILED, "REVIEW_REPORT_INVALID");
            }
        }

        return new StatusAndError(ReviewStatus.PROCESSING, null);
    }

    private int queryAttemptCount(UUID executionId) {
        Integer count = jdbcTemplate.queryForObject(
                "SELECT count(*) FROM step_attempts WHERE \"executionId\" = ?",
                Integer.class,
                executionId
        );
        return count != null ? count : 0;
    }

    private DecisionView queryDecision(UUID requestId) {
        List<DecisionView> decisions = jdbcTemplate.query(
                "SELECT id, request_id, actor_id, action, comment, step_attempt_id, result_hash, created_at " +
                        "FROM tenvyr_review.decisions WHERE request_id = ?",
                (rs, rowNum) -> new DecisionView(
                        rs.getObject("id", UUID.class),
                        rs.getObject("request_id", UUID.class),
                        rs.getObject("actor_id", UUID.class),
                        DecisionAction.valueOf(rs.getString("action")),
                        rs.getString("comment"),
                        rs.getObject("step_attempt_id", UUID.class),
                        rs.getString("result_hash"),
                        rs.getTimestamp("created_at").toInstant()
                ),
                requestId
        );
        return decisions.isEmpty() ? null : decisions.get(0);
    }

    private RequestRow mapRequestRow(ResultSet rs) throws SQLException {
        return new RequestRow(
                rs.getObject("id", UUID.class),
                rs.getObject("owner_id", UUID.class),
                rs.getString("title"),
                rs.getString("language"),
                rs.getString("code"),
                rs.getObject("execution_id", UUID.class),
                rs.getTimestamp("created_at").toInstant()
        );
    }

    private record ReviewSummaryRow(UUID id, String title, String language,
                                    UUID executionId, Instant createdAt) {}

    private ReviewSummaryRow mapSummaryRow(ResultSet rs) throws SQLException {
        return new ReviewSummaryRow(
                rs.getObject("id", UUID.class),
                rs.getString("title"),
                rs.getString("language"),
                rs.getObject("execution_id", UUID.class),
                rs.getTimestamp("created_at").toInstant()
        );
    }
}
