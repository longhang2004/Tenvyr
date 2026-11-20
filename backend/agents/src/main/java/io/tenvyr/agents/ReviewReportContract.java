package io.tenvyr.agents;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.tenvyr.platform.Json;

import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.Set;

/**
 * Business-output schema validator for asynchronous code-review reports.
 * Validates score, findings, optional legacy _tenvyr metadata, and UTF-8 byte bounds.
 */
public final class ReviewReportContract {

    public static final int MAX_REPORT_UTF8_BYTES = 65536;
    public static final int MAX_FINDINGS_COUNT = 50;
    public static final int MAX_FINDING_UTF16_UNITS = 1000;

    private static final Set<String> ALLOWED_TOP_LEVEL_KEYS = Set.of("score", "findings", "_tenvyr");

    private ReviewReportContract() {}

    /**
     * Validates that the supplied JSON node conforms strictly to the review report business contract.
     * Throws IllegalArgumentException on invalid structure, types, bounds, or unknown fields.
     *
     * @param output raw JSON output from the reviewer agent
     * @return validated ObjectNode
     */
    public static ObjectNode requireOutput(JsonNode output) {
        if (output == null || !output.isObject()) {
            throw new IllegalArgumentException("Review report output must be a non-null JSON object");
        }

        ObjectNode obj = (ObjectNode) output;

        // Reject unknown top-level properties
        Iterator<String> fieldNames = obj.fieldNames();
        while (fieldNames.hasNext()) {
            String field = fieldNames.next();
            if (!ALLOWED_TOP_LEVEL_KEYS.contains(field)) {
                throw new IllegalArgumentException("Unallowed property in review report: " + field);
            }
        }

        // Validate score: isIntegralNumber plus safe range comparison 0..100 BEFORE int conversion (no overflow)
        JsonNode scoreNode = obj.get("score");
        if (scoreNode == null || scoreNode.isNull()) {
            throw new IllegalArgumentException("Review report must include a non-null 'score' property");
        }
        if (!scoreNode.isIntegralNumber()) {
            throw new IllegalArgumentException("Review report 'score' must be an integer, not string or floating-point");
        }
        if (!scoreNode.canConvertToLong()) {
            throw new IllegalArgumentException("Review report 'score' must be between 0 and 100 inclusive, got out-of-range integer");
        }
        long scoreLong = scoreNode.longValue();
        if (scoreLong < 0 || scoreLong > 100) {
            throw new IllegalArgumentException("Review report 'score' must be between 0 and 100 inclusive, got: " + scoreLong);
        }
        int score = (int) scoreLong;

        // Validate findings
        JsonNode findingsNode = obj.get("findings");
        if (findingsNode == null || findingsNode.isNull()) {
            throw new IllegalArgumentException("Review report must include a non-null 'findings' array");
        }
        if (!findingsNode.isArray()) {
            throw new IllegalArgumentException("Review report 'findings' must be an array");
        }
        if (findingsNode.size() > MAX_FINDINGS_COUNT) {
            throw new IllegalArgumentException("Review report 'findings' cannot exceed " + MAX_FINDINGS_COUNT + " items, got: " + findingsNode.size());
        }

        for (int i = 0; i < findingsNode.size(); i++) {
            JsonNode finding = findingsNode.get(i);
            if (!finding.isTextual()) {
                throw new IllegalArgumentException("Review report finding at index " + i + " must be a string");
            }
            String text = finding.textValue();
            if (text.isBlank()) {
                throw new IllegalArgumentException("Review report finding at index " + i + " must not be blank");
            }
            if (text.length() > MAX_FINDING_UTF16_UNITS) {
                throw new IllegalArgumentException("Review report finding at index " + i + " exceeds " + MAX_FINDING_UTF16_UNITS + " UTF-16 code units: " + text.length());
            }
        }

        // Validate optional _tenvyr: if present must be a non-null JSON object
        if (obj.has("_tenvyr")) {
            JsonNode tenvyrNode = obj.get("_tenvyr");
            if (tenvyrNode == null || !tenvyrNode.isObject()) {
                throw new IllegalArgumentException("Review report '_tenvyr' must be a non-null JSON object when present");
            }
        }

        // Validate UTF-8 byte bounds on serialized report JSON
        byte[] utf8Bytes = Json.stringify(obj).getBytes(StandardCharsets.UTF_8);
        if (utf8Bytes.length > MAX_REPORT_UTF8_BYTES) {
            throw new IllegalArgumentException("Review report serialized JSON exceeds " + MAX_REPORT_UTF8_BYTES + " UTF-8 bytes: " + utf8Bytes.length);
        }

        return obj;
    }
}
