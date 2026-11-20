package io.tenvyr.review;

import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.core.StreamReadFeature;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.tenvyr.platform.Json;
import io.tenvyr.review.domain.ReviewTypes.CreateReview;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Base64;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;

/**
 * Validation rules and strict parser for T04 review submissions and keyset reads.
 * Enforces UTF-8 byte bounds, language allowlist, trimmed length bounds,
 * and exact cursor structures before allocations.
 */
public final class ReviewValidation {

    private static final Set<String> ALLOWED_LANGUAGES = Set.of("java", "typescript", "python");
    private static final Set<String> ALLOWED_FIELDS = Set.of("title", "language", "code");
    private static final Set<String> ALLOWED_DECISION_FIELDS = Set.of("action", "comment");
    private static final Pattern CANONICAL_UUID =
            Pattern.compile("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$");
    public static final int MAX_CODE_UTF8_BYTES = 65536;
    public static final int MAX_TITLE_LENGTH = 160;
    public static final int MAX_COMMENT_LENGTH = 2000;
    public static final int MAX_CURSOR_RAW_LENGTH = 512;
    public static final int MAX_CURSOR_DECODED_BYTES = 256;
    public static final int DEFAULT_LIMIT = 20;
    public static final int MAX_LIMIT = 100;
    public static final int MIN_LIMIT = 1;

    private static final ObjectMapper STRICT_MAPPER = new ObjectMapper()
            .enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION.mappedFeature())
            .enable(JsonParser.Feature.STRICT_DUPLICATE_DETECTION);

    private ReviewValidation() {}

    public record Cursor(Instant createdAt, UUID id) {}

    private static class StrictCursorDto {
        public String createdAt;
        public String id;
    }

    /**
     * Validates CreateReview domain object according to SPEC.
     */
    public static void validateCreateReview(CreateReview input) {
        if (input == null) {
            throw new IllegalArgumentException("Review submission body must not be null");
        }

        // Title: Trim then 1..160 UTF-16 code units
        if (input.title() == null || input.title().isBlank()) {
            throw new IllegalArgumentException("Title must not be blank");
        }
        String trimmedTitle = input.title().trim();
        if (trimmedTitle.length() > MAX_TITLE_LENGTH) {
            throw new IllegalArgumentException("Title trimmed length must not exceed " + MAX_TITLE_LENGTH + " code units");
        }

        // Language: Exactly one of 'java', 'typescript', 'python'
        if (input.language() == null || !ALLOWED_LANGUAGES.contains(input.language())) {
            throw new IllegalArgumentException("Language must be one of 'java', 'typescript', 'python'");
        }

        // Code: Nonblank, preserve bytes, <= 65,536 UTF-8 bytes
        if (input.code() == null || input.code().isBlank()) {
            throw new IllegalArgumentException("Code must not be blank");
        }
        byte[] codeBytes = input.code().getBytes(StandardCharsets.UTF_8);
        if (codeBytes.length > MAX_CODE_UTF8_BYTES) {
            throw new IllegalArgumentException("Code UTF-8 bytes (" + codeBytes.length + ") exceeds maximum " + MAX_CODE_UTF8_BYTES + " bytes");
        }
    }

    /**
     * Parses and validates raw JSON request body strictly.
     * Rejects unknown properties, duplicate keys, trailing tokens, invalid types, empty text, or schema mismatches.
     */
    public static CreateReview parseCreateReview(String json) throws Exception {
        if (json == null || json.isBlank()) {
            throw new IllegalArgumentException("Request body must not be blank");
        }
        JsonNode root = STRICT_MAPPER.readTree(json);
        if (!root.isObject()) {
            throw new IllegalArgumentException("Request body must be a JSON object");
        }
        ObjectNode obj = (ObjectNode) root;
        var fields = obj.fieldNames();
        while (fields.hasNext()) {
            String key = fields.next();
            if (!ALLOWED_FIELDS.contains(key)) {
                throw new IllegalArgumentException("Unrecognized property: " + key);
            }
        }
        JsonNode titleNode = obj.get("title");
        if (titleNode == null || !titleNode.isTextual()) {
            throw new IllegalArgumentException("Field 'title' must be a string");
        }
        JsonNode languageNode = obj.get("language");
        if (languageNode == null || !languageNode.isTextual()) {
            throw new IllegalArgumentException("Field 'language' must be a string");
        }
        JsonNode codeNode = obj.get("code");
        if (codeNode == null || !codeNode.isTextual()) {
            throw new IllegalArgumentException("Field 'code' must be a string");
        }

        CreateReview review = new CreateReview(titleNode.textValue(), languageNode.textValue(), codeNode.textValue());
        validateCreateReview(review);
        return review;
    }

    /**
     * Parses and validates raw JSON decision command body strictly.
     */
    public static io.tenvyr.review.domain.ReviewTypes.DecisionCommand parseDecisionCommand(String json) throws Exception {
        if (json == null || json.isBlank()) {
            throw new IllegalArgumentException("Decision body must not be blank");
        }
        JsonNode root = STRICT_MAPPER.readTree(json);
        if (!root.isObject()) {
            throw new IllegalArgumentException("Decision body must be a JSON object");
        }
        ObjectNode obj = (ObjectNode) root;
        var fields = obj.fieldNames();
        while (fields.hasNext()) {
            String key = fields.next();
            if (!ALLOWED_DECISION_FIELDS.contains(key)) {
                throw new IllegalArgumentException("Unrecognized property in decision command: " + key);
            }
        }
        JsonNode actionNode = obj.get("action");
        if (actionNode == null || !actionNode.isTextual()) {
            throw new IllegalArgumentException("Field 'action' must be a string");
        }
        String actionStr = actionNode.textValue().trim();
        io.tenvyr.review.domain.ReviewTypes.DecisionAction action;
        try {
            action = io.tenvyr.review.domain.ReviewTypes.DecisionAction.valueOf(actionStr);
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException("Invalid action: " + actionStr);
        }

        JsonNode commentNode = obj.get("comment");
        String comment = null;
        if (commentNode != null && !commentNode.isNull()) {
            if (!commentNode.isTextual()) {
                throw new IllegalArgumentException("Field 'comment' must be a string");
            }
            comment = commentNode.textValue().trim();
            if (comment.length() > MAX_COMMENT_LENGTH) {
                throw new IllegalArgumentException("Comment length exceeds " + MAX_COMMENT_LENGTH + " characters");
            }
        }

        return new io.tenvyr.review.domain.ReviewTypes.DecisionCommand(action, comment);
    }

    /**
     * Validates the Idempotency-Key header value.
     */
    public static UUID validateIdempotencyKey(String key) {
        if (key == null || key.isBlank()) {
            throw new IllegalArgumentException("Idempotency-Key header is required");
        }
        String trimmed = key.trim();
        if (trimmed.length() != 36 || !CANONICAL_UUID.matcher(trimmed).matches()) {
            throw new IllegalArgumentException("Idempotency-Key must be a canonical 36-character UUID string");
        }
        try {
            return UUID.fromString(trimmed);
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException("Invalid Idempotency-Key UUID", e);
        }
    }

    /**
     * Validates and decodes URL-safe Base64 keyset cursor.
     * Enforces raw length bound before allocation, <= 256 bytes decoded length,
     * canonical UUID shape, and exact {createdAt, id} schema.
     */
    public static Cursor validateCursor(String cursor) {
        if (cursor == null || cursor.isBlank()) {
            throw new IllegalArgumentException("Cursor must not be blank");
        }
        if (cursor.length() > MAX_CURSOR_RAW_LENGTH) {
            throw new IllegalArgumentException("Raw cursor length (" + cursor.length() + ") exceeds maximum allowed size " + MAX_CURSOR_RAW_LENGTH);
        }
        byte[] decoded;
        try {
            decoded = Base64.getUrlDecoder().decode(cursor);
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException("Cursor is not valid URL-safe Base64", e);
        }

        if (decoded.length > MAX_CURSOR_DECODED_BYTES) {
            throw new IllegalArgumentException("Cursor decoded size (" + decoded.length + " bytes) exceeds maximum " + MAX_CURSOR_DECODED_BYTES + " bytes");
        }

        StrictCursorDto dto;
        try {
            dto = STRICT_MAPPER.readValue(decoded, StrictCursorDto.class);
        } catch (Exception e) {
            throw new IllegalArgumentException("Cursor payload is invalid JSON or has unexpected properties", e);
        }

        if (dto.createdAt == null || dto.createdAt.isBlank() || dto.id == null || dto.id.isBlank()) {
            throw new IllegalArgumentException("Cursor must contain non-blank createdAt and id");
        }

        Instant createdAt;
        try {
            createdAt = Instant.parse(dto.createdAt);
        } catch (Exception e) {
            throw new IllegalArgumentException("Cursor createdAt is not a valid ISO-8601 instant: " + dto.createdAt, e);
        }

        if (dto.id.length() != 36 || !CANONICAL_UUID.matcher(dto.id).matches()) {
            throw new IllegalArgumentException("Cursor id is not a valid canonical UUID: " + dto.id);
        }

        UUID id;
        try {
            id = UUID.fromString(dto.id);
        } catch (Exception e) {
            throw new IllegalArgumentException("Cursor id is not a valid UUID: " + dto.id, e);
        }

        return new Cursor(createdAt, id);
    }

    /**
     * Validates pagination limit query parameter.
     */
    public static int validateLimit(Integer limit) {
        if (limit == null) {
            return DEFAULT_LIMIT;
        }
        if (limit < MIN_LIMIT || limit > MAX_LIMIT) {
            throw new IllegalArgumentException("Limit must be between " + MIN_LIMIT + " and " + MAX_LIMIT);
        }
        return limit;
    }
}
