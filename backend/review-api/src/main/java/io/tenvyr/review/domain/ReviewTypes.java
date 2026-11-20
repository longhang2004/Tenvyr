package io.tenvyr.review.domain;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * Public domain types, records, and enums for the asynchronous review workflow.
 */
public final class ReviewTypes {

    private ReviewTypes() {}

    public enum Role {
        SUBMITTER,
        REVIEWER
    }

    public enum ReviewStatus {
        PROCESSING,
        FAILED,
        CANCELLED,
        AWAITING_REVIEW,
        APPROVED,
        CHANGES_REQUESTED
    }

    public enum DecisionAction {
        APPROVE,
        REQUEST_CHANGES
    }

    public record Actor(UUID id, String username, Role role) {}

    public record CreateReview(String title, String language, String code) {}

    public record Submission(UUID id, String status, Instant createdAt, UUID executionId) {}

    public record ReviewSummary(UUID id, String title, String language,
                                 ReviewStatus status, Instant createdAt) {}

    public record Page<T>(List<T> items, String nextCursor) {
        public Page {
            items = items == null ? List.of() : List.copyOf(items);
        }
    }

    public record ReportEvidence(String mode, String provider, String model,
                                 boolean fallbackUsed, String usageSource) {}

    public record ReviewReport(int score, List<String> findings, ReportEvidence evidence) {
        public ReviewReport {
            findings = findings == null ? List.of() : List.copyOf(findings);
        }
    }

    public record DecisionCommand(DecisionAction action, String comment) {}

    public record DecisionView(UUID id, UUID requestId, UUID actorId, DecisionAction action,
                                String comment, UUID stepAttemptId, String resultHash,
                                Instant createdAt) {}

    public record ReviewDetail(UUID id, String title, String language, String code,
                                ReviewStatus status, Instant createdAt, UUID executionId,
                                int attemptCount, String errorCode, DecisionView decision) {}

    public record AuditEntry(UUID id, UUID actorId, String action, Instant createdAt) {}
}
