package io.tenvyr.review;

import com.fasterxml.jackson.databind.JsonNode;
import io.tenvyr.platform.Json;
import io.tenvyr.review.domain.ReviewTypes.ReportEvidence;
import io.tenvyr.review.domain.ReviewTypes.ReviewReport;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * Mapper and strict contract validator for ReviewReport domain models.
 * Enforces business output limits: score [0..100], <= 50 findings, nonblank finding <= 1000 units,
 * and report JSON payload <= 65,536 UTF-8 bytes.
 */
public final class ReviewReportMapper {

    public static final int MAX_FINDINGS = 50;
    public static final int MAX_FINDING_LENGTH = 1000;
    public static final int MAX_REPORT_BYTES = 65536;

    private ReviewReportMapper() {}

    /**
     * Validates that a ReviewReport conforms to all SPEC invariants.
     */
    public static void validateReport(ReviewReport report) {
        if (report == null) {
            throw new IllegalArgumentException("ReviewReport must not be null");
        }

        if (report.score() < 0 || report.score() > 100) {
            throw new IllegalArgumentException("Report score must be between 0 and 100, got: " + report.score());
        }

        List<String> findings = report.findings();
        if (findings == null || findings.size() > MAX_FINDINGS) {
            throw new IllegalArgumentException("Report findings count must be <= " + MAX_FINDINGS + ", got: " + (findings == null ? 0 : findings.size()));
        }

        for (String finding : findings) {
            if (finding == null || finding.isBlank()) {
                throw new IllegalArgumentException("Report finding must not be blank");
            }
            if (finding.length() > MAX_FINDING_LENGTH) {
                throw new IllegalArgumentException("Report finding length exceeds " + MAX_FINDING_LENGTH + " code units: " + finding.length());
            }
        }

        if (report.evidence() == null) {
            throw new IllegalArgumentException("Report evidence must not be null");
        }

        byte[] jsonBytes = Json.stringify(Json.value(report)).getBytes(StandardCharsets.UTF_8);
        if (jsonBytes.length > MAX_REPORT_BYTES) {
            throw new IllegalArgumentException("Report JSON payload size (" + jsonBytes.length + " bytes) exceeds maximum " + MAX_REPORT_BYTES + " bytes");
        }
    }

    /**
     * Maps engine step_attempt result/output JsonNode into typed ReviewReport.
     * Throws IllegalArgumentException if output does not satisfy business contracts.
     */
    public static ReviewReport fromOutput(JsonNode output) {
        if (output == null || !output.isObject()) {
            throw new IllegalArgumentException("Engine output must be a non-null JSON object");
        }

        JsonNode scoreNode = output.get("score");
        if (scoreNode == null || !scoreNode.isInt()) {
            throw new IllegalArgumentException("Engine output must have an integer 'score' field");
        }
        int score = scoreNode.asInt();

        JsonNode findingsNode = output.get("findings");
        if (findingsNode == null || !findingsNode.isArray()) {
            throw new IllegalArgumentException("Engine output must have an array 'findings' field");
        }

        List<String> findings = new ArrayList<>();
        for (JsonNode f : findingsNode) {
            if (!f.isTextual()) {
                throw new IllegalArgumentException("Each finding in 'findings' array must be a string");
            }
            findings.add(f.asText());
        }

        JsonNode tenvyr = output.path("_tenvyr");
        JsonNode metadata = tenvyr.path("metadata");

        String mode = metadata.hasNonNull("mode") ? metadata.path("mode").asText() : null;
        String provider = metadata.hasNonNull("provider") ? metadata.path("provider").asText() : null;
        String model = metadata.hasNonNull("model") ? metadata.path("model").asText() : null;
        boolean fallbackUsed = metadata.path("fallbackUsed").asBoolean(false);
        String usageSource = metadata.hasNonNull("usageSource") ? metadata.path("usageSource").asText() : null;

        ReportEvidence evidence = new ReportEvidence(mode, provider, model, fallbackUsed, usageSource);
        ReviewReport report = new ReviewReport(score, findings, evidence);
        validateReport(report);
        return report;
    }

    /**
     * Checks if engine step output represents a valid review report.
     * Never throws exceptions.
     */
    public static boolean isValidReport(JsonNode output) {
        if (output == null || !output.isObject()) {
            return false;
        }
        try {
            fromOutput(output);
            return true;
        } catch (Exception e) {
            return false;
        }
    }
}
