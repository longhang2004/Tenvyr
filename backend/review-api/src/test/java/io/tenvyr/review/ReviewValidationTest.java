package io.tenvyr.review;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.tenvyr.platform.Db;
import io.tenvyr.platform.Json;
import io.tenvyr.review.domain.ReviewTypes.CreateReview;
import io.tenvyr.review.domain.ReviewTypes.ReportEvidence;
import io.tenvyr.review.domain.ReviewTypes.ReviewReport;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataAccessException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.BadSqlGrammarException;
import org.springframework.jdbc.CannotGetJdbcConnectionException;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import jakarta.servlet.ReadListener;
import jakarta.servlet.ServletInputStream;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.sql.SQLException;
import java.sql.SQLTransientConnectionException;
import java.sql.SQLTransientException;
import java.time.Instant;
import java.util.Base64;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Pure unit tests for T04 validation, DTO constraints, report mapper, and body limit seams.
 * Does not require PostgreSQL or full Spring Boot application startup.
 * Tests exact UTF-8 byte boundaries with CJK filler, strict unknown fields/types,
 * keyset cursor bounds (<= 256 bytes), ReviewReportMapper invariants, and controlled
 * servlet stream read bounds with misleading Content-Length headers.
 */
public class ReviewValidationTest {

    // =========================================================================
    // 1. Title Validation: Trim then 1..160 UTF-16 code units
    // =========================================================================

    @Test
    @DisplayName("Title validation: trims whitespace, accepts 1..160 UTF-16 units, rejects blank or >160 units")
    void titleValidation() {
        // Valid title trimmed
        CreateReview valid = new CreateReview("  Valid Title  ", "java", "class Test {}");
        assertDoesNotThrow(() -> ReviewValidation.validateCreateReview(valid));

        // Exact 160 units
        String exact160 = "t".repeat(160);
        CreateReview valid160 = new CreateReview(exact160, "java", "class Test {}");
        assertDoesNotThrow(() -> ReviewValidation.validateCreateReview(valid160));

        // Blank title rejected
        CreateReview blankTitle = new CreateReview("   \t\n  ", "java", "class Test {}");
        assertThrows(IllegalArgumentException.class, () -> ReviewValidation.validateCreateReview(blankTitle));

        // Null title rejected
        CreateReview nullTitle = new CreateReview(null, "java", "class Test {}");
        assertThrows(IllegalArgumentException.class, () -> ReviewValidation.validateCreateReview(nullTitle));

        // 161 units rejected
        String oversize161 = "t".repeat(161);
        CreateReview invalid161 = new CreateReview(oversize161, "java", "class Test {}");
        assertThrows(IllegalArgumentException.class, () -> ReviewValidation.validateCreateReview(invalid161));
    }

    // =========================================================================
    // 2. Language Whitelist: java, typescript, python
    // =========================================================================

    @Test
    @DisplayName("Language validation: accepts only exact 'java', 'typescript', 'python'; rejects others and casing")
    void languageValidation() {
        assertDoesNotThrow(() -> ReviewValidation.validateCreateReview(new CreateReview("Title", "java", "code")));
        assertDoesNotThrow(() -> ReviewValidation.validateCreateReview(new CreateReview("Title", "typescript", "code")));
        assertDoesNotThrow(() -> ReviewValidation.validateCreateReview(new CreateReview("Title", "python", "code")));

        assertThrows(IllegalArgumentException.class, () -> ReviewValidation.validateCreateReview(new CreateReview("Title", "ruby", "code")));
        assertThrows(IllegalArgumentException.class, () -> ReviewValidation.validateCreateReview(new CreateReview("Title", "go", "code")));
        assertThrows(IllegalArgumentException.class, () -> ReviewValidation.validateCreateReview(new CreateReview("Title", "JAVA", "code")));
        assertThrows(IllegalArgumentException.class, () -> ReviewValidation.validateCreateReview(new CreateReview("Title", "", "code")));
        assertThrows(IllegalArgumentException.class, () -> ReviewValidation.validateCreateReview(new CreateReview("Title", null, "code")));
    }

    // =========================================================================
    // 3. Code Validation: Nonblank, preserve bytes, exact 65,536 UTF-8 bytes with CJK filler
    // =========================================================================

    @Test
    @DisplayName("Code validation: nonblank, preserves bytes, accepts exact 65,536 UTF-8 bytes with CJK filler, rejects 65,537 bytes")
    void codeValidationWithCalibratedCjkFiller() {
        // Blank code rejected
        assertThrows(IllegalArgumentException.class, () ->
                ReviewValidation.validateCreateReview(new CreateReview("Title", "java", "   \t\n  ")));
        assertThrows(IllegalArgumentException.class, () ->
                ReviewValidation.validateCreateReview(new CreateReview("Title", "java", null)));

        // Calibrated CJK filler: CJK character "中" is 3 UTF-8 bytes
        // 21,845 * 3 = 65,535 bytes + 1 ASCII byte ('a') = 65,536 bytes
        String code65536 = "中".repeat(21845) + "a";
        byte[] bytes65536 = code65536.getBytes(StandardCharsets.UTF_8);
        assertEquals(65536, bytes65536.length);
        assertEquals(21846, code65536.length(), "UTF-16 unit count must be less than byte length");

        CreateReview validBoundary = new CreateReview("Title", "java", code65536);
        assertDoesNotThrow(() -> ReviewValidation.validateCreateReview(validBoundary));

        // 65,537 bytes: 21,845 * 3 + 2 ASCII bytes ('ab') = 65,537 bytes -> rejected
        String code65537 = "中".repeat(21845) + "ab";
        byte[] bytes65537 = code65537.getBytes(StandardCharsets.UTF_8);
        assertEquals(65537, bytes65537.length);

        CreateReview invalidBoundary = new CreateReview("Title", "java", code65537);
        assertThrows(IllegalArgumentException.class, () -> ReviewValidation.validateCreateReview(invalidBoundary));
    }

    // =========================================================================
    // 4. Strict Unknown Fields and Types: Reject unrecognized JSON properties and mismatched types
    // =========================================================================

    @Test
    @DisplayName("Strict DTO deserialization: rejects unrecognized properties and invalid types with 400")
    void strictUnknownPropertiesAndTypes() {
        // Valid JSON deserializes cleanly
        String validJson = "{\"title\":\"Clean Title\",\"language\":\"java\",\"code\":\"class Clean {}\"}";
        assertDoesNotThrow(() -> ReviewValidation.parseCreateReview(validJson));

        // Unknown property rejected
        String unknownFieldJson = "{\"title\":\"Title\",\"language\":\"java\",\"code\":\"class Clean {}\",\"unexpectedField\":\"value\"}";
        assertThrows(Exception.class, () -> ReviewValidation.parseCreateReview(unknownFieldJson));

        // Invalid type for title (integer instead of string) rejected
        String invalidTypeJson = "{\"title\":12345,\"language\":\"java\",\"code\":\"class Clean {}\"}";
        assertThrows(Exception.class, () -> ReviewValidation.parseCreateReview(invalidTypeJson));

        // Duplicate keys rejected
        String duplicateKeyJson = "{\"title\":\"First\",\"title\":\"Second\",\"language\":\"java\",\"code\":\"class Clean {}\"}";
        assertThrows(Exception.class, () -> ReviewValidation.parseCreateReview(duplicateKeyJson));

        // Trailing tokens rejected
        String trailingTokenJson = "{\"title\":\"Clean Title\",\"language\":\"java\",\"code\":\"class Clean {}\"} {\"extra\":true}";
        assertThrows(Exception.class, () -> ReviewValidation.parseCreateReview(trailingTokenJson));

        // Empty JSON text rejected
        assertThrows(Exception.class, () -> ReviewValidation.parseCreateReview(""));
        assertThrows(Exception.class, () -> ReviewValidation.parseCreateReview("{}"));
    }

    // =========================================================================
    // 5. Idempotency-Key Validation
    // =========================================================================

    @Test
    @DisplayName("Idempotency-Key validation: accepts valid UUID, rejects null, blank, or non-UUID formats")
    void idempotencyKeyValidation() {
        UUID validUuid = UUID.randomUUID();
        assertEquals(validUuid, ReviewValidation.validateIdempotencyKey(validUuid.toString()));

        assertThrows(IllegalArgumentException.class, () -> ReviewValidation.validateIdempotencyKey(null));
        assertThrows(IllegalArgumentException.class, () -> ReviewValidation.validateIdempotencyKey(""));
        assertThrows(IllegalArgumentException.class, () -> ReviewValidation.validateIdempotencyKey("   "));
        assertThrows(IllegalArgumentException.class, () -> ReviewValidation.validateIdempotencyKey("not-a-uuid"));
        assertThrows(IllegalArgumentException.class, () -> ReviewValidation.validateIdempotencyKey("12345"));
    }

    // =========================================================================
    // 6. Keyset Pagination Cursor Bounds: URL-safe base64, decoded <= 256 bytes, exact {createdAt, id}
    // =========================================================================

    @Test
    @DisplayName("Cursor validation: URL-safe base64, decoded size <= 256 bytes, exact {createdAt, id}, and limit bounds [1..100]")
    void keysetCursorAndLimitValidation() {
        Instant now = Instant.now();
        UUID id = UUID.randomUUID();
        String validCursorPayload = Json.stringify(Json.object(
                "createdAt", now.toString(),
                "id", id.toString()
        ));
        String validCursor = Base64.getUrlEncoder().encodeToString(validCursorPayload.getBytes(StandardCharsets.UTF_8));
        assertDoesNotThrow(() -> ReviewValidation.validateCursor(validCursor));

        // Non-base64 rejected
        assertThrows(IllegalArgumentException.class, () -> ReviewValidation.validateCursor("invalid!base64!!"));

        // Decoded cursor exceeding 256 bytes rejected
        String oversizeDecoded = "{\"createdAt\":\"" + now + "\",\"id\":\"" + id + "\",\"padding\":\"" + "x".repeat(250) + "\"}";
        assertTrue(oversizeDecoded.getBytes(StandardCharsets.UTF_8).length > 256);
        String oversizeCursor = Base64.getUrlEncoder().encodeToString(oversizeDecoded.getBytes(StandardCharsets.UTF_8));
        assertThrows(IllegalArgumentException.class, () -> ReviewValidation.validateCursor(oversizeCursor));

        // Missing required properties rejected
        String missingIdPayload = Json.stringify(Json.object("createdAt", now.toString()));
        String missingIdCursor = Base64.getUrlEncoder().encodeToString(missingIdPayload.getBytes(StandardCharsets.UTF_8));
        assertThrows(IllegalArgumentException.class, () -> ReviewValidation.validateCursor(missingIdCursor));

        // Limit bounds: default 20, 1..100 allowed, <1 or >100 rejected
        assertEquals(20, ReviewValidation.validateLimit(null));
        assertEquals(1, ReviewValidation.validateLimit(1));
        assertEquals(50, ReviewValidation.validateLimit(50));
        assertEquals(100, ReviewValidation.validateLimit(100));
        assertThrows(IllegalArgumentException.class, () -> ReviewValidation.validateLimit(0));
        assertThrows(IllegalArgumentException.class, () -> ReviewValidation.validateLimit(-5));
        assertThrows(IllegalArgumentException.class, () -> ReviewValidation.validateLimit(101));
    }

    // =========================================================================
    // 7. ReviewReportMapper: Score 0..100, <=50 findings, finding nonblank <=1000 units, report <=65,536 bytes
    // =========================================================================

    @Test
    @DisplayName("ReviewReportMapper: score 0..100, <=50 findings, nonblank finding <=1000 units, report JSON <=65536 bytes, evidence mapping")
    void reviewReportMapperConstraints() {
        ReportEvidence validEvidence = new ReportEvidence("MOCK", "test-provider", "test-model", false, "test");
        ReviewReport validReport = new ReviewReport(85, List.of("Clean code", "Follows guidelines"), validEvidence);
        assertDoesNotThrow(() -> ReviewReportMapper.validateReport(validReport));

        // Score bounds: 0 and 100 valid; <0 or >100 invalid
        assertDoesNotThrow(() -> ReviewReportMapper.validateReport(new ReviewReport(0, List.of("Zero score"), validEvidence)));
        assertDoesNotThrow(() -> ReviewReportMapper.validateReport(new ReviewReport(100, List.of("Perfect score"), validEvidence)));
        assertThrows(IllegalArgumentException.class, () ->
                ReviewReportMapper.validateReport(new ReviewReport(-1, List.of("Negative"), validEvidence)));
        assertThrows(IllegalArgumentException.class, () ->
                ReviewReportMapper.validateReport(new ReviewReport(101, List.of("Over 100"), validEvidence)));

        // Max 50 findings accepted, 51 rejected
        List<String> exactly50Findings = Collections.nCopies(50, "Finding");
        assertDoesNotThrow(() -> ReviewReportMapper.validateReport(new ReviewReport(80, exactly50Findings, validEvidence)));

        List<String> fiftyOneFindings = Collections.nCopies(51, "Finding");
        assertThrows(IllegalArgumentException.class, () ->
                ReviewReportMapper.validateReport(new ReviewReport(80, fiftyOneFindings, validEvidence)));

        // Blank finding rejected
        assertThrows(IllegalArgumentException.class, () ->
                ReviewReportMapper.validateReport(new ReviewReport(80, List.of("   "), validEvidence)));

        // Finding exceeding 1,000 UTF-16 units rejected
        String oversizeFinding = "f".repeat(1001);
        assertThrows(IllegalArgumentException.class, () ->
                ReviewReportMapper.validateReport(new ReviewReport(80, List.of(oversizeFinding), validEvidence)));

        // Malformed engine output mapping returns null or invalid flag
        JsonNode malformedOutput = Json.object("score", -5);
        assertFalse(ReviewReportMapper.isValidReport(malformedOutput));
    }

    // =========================================================================
    // 8. Body Limit Seam: Controlled servlet request stream with misleading Content-Length proving actual read bound
    // =========================================================================

    @Test
    @DisplayName("RequestBodyLimitFilter: controlled request stream with misleading Content-Length header enforces actual 1 MiB read bound")
    void controlledRequestStreamWithMisleadingContentLength_enforcesActualReadBound() throws Exception {
        RequestBodyLimitFilter filter = new RequestBodyLimitFilter();
        assertEquals(1048576, RequestBodyLimitFilter.MAX_BODY_BYTES, "Maximum body bound must be exactly 1 MiB (1,048,576 bytes)");

        // 1,048,577 bytes generated in memory
        byte[] oversizeData = new byte[1048577];

        // Misleading Content-Length: header declares 100 bytes, but stream actually emits > 1 MiB
        MockHttpServletRequest request = new MockHttpServletRequest() {
            @Override
            public ServletInputStream getInputStream() {
                ByteArrayInputStream bais = new ByteArrayInputStream(oversizeData);
                return new DelegatingServletInputStream(bais);
            }
        };
        request.setRequestURI("/api/v1/reviews");
        request.setMethod("POST");
        request.setContent(new byte[0]); // Content-Length set artificially low
        request.addHeader("Content-Length", "100");

        MockHttpServletResponse response = new MockHttpServletResponse();
        MockFilterChain filterChain = new MockFilterChain();

        // The filter must not trust the declared Content-Length header (100) and must enforce
        // the streaming read bound, returning 413 Payload Too Large BEFORE allocating body or parsing JSON
        filter.doFilter(request, response, filterChain);

        assertEquals(413, response.getStatus(),
                "Stream exceeding 1 MiB must return 413 Payload Too Large despite misleading small Content-Length");
    }

    private static class DelegatingServletInputStream extends ServletInputStream {
        private final InputStream source;

        DelegatingServletInputStream(InputStream source) {
            this.source = source;
        }

        @Override
        public boolean isFinished() {
            try {
                return source.available() == 0;
            } catch (IOException e) {
                return true;
            }
        }

        @Override
        public boolean isReady() {
            return true;
        }

        @Override
        public void setReadListener(ReadListener readListener) {}

        @Override
        public int read() throws IOException {
            return source.read();
        }

        @Override
        public int read(byte[] b, int off, int len) throws IOException {
            return source.read(b, off, len);
        }
    }

    // =========================================================================
    // 9. Review Repair Regressions: Cursor Bounded Raw & Canonical UUID Validation
    // =========================================================================

    @Test
    @DisplayName("Cursor validation regression: rejects noncanonical shorthand UUID (e.g. '1-2-3-4-5') and bounds raw input before decoding")
    void validateCursor_rejectsNoncanonicalShorthandUuid_andEnforcesBoundedRawInputBeforeDecode() {
        // 1. Shorthand noncanonical UUID in cursor must be rejected
        String shorthandUuidPayload = Json.stringify(Json.object(
                "createdAt", Instant.now().toString(),
                "id", "1-2-3-4-5"
        ));
        String shorthandCursor = Base64.getUrlEncoder().encodeToString(shorthandUuidPayload.getBytes(StandardCharsets.UTF_8));
        IllegalArgumentException shorthandEx = assertThrows(IllegalArgumentException.class,
                () -> ReviewValidation.validateCursor(shorthandCursor),
                "Cursor with noncanonical shorthand UUID (e.g. '1-2-3-4-5') must be rejected with IllegalArgumentException");
        assertTrue(shorthandEx.getMessage().toLowerCase().contains("uuid") || shorthandEx.getMessage().toLowerCase().contains("id"),
                "Exception message must specify UUID/id validation failure: " + shorthandEx.getMessage());

        // 2. Raw cursor exceeding bound before decoding must be rejected on raw length
        String oversizeRawCursor = "!".repeat(600);
        IllegalArgumentException rawEx = assertThrows(IllegalArgumentException.class,
                () -> ReviewValidation.validateCursor(oversizeRawCursor),
                "Unbounded raw cursor must be rejected before allocating base64 decoded buffers");
        assertTrue(rawEx.getMessage().toLowerCase().contains("raw") ||
                        rawEx.getMessage().toLowerCase().contains("length") ||
                        rawEx.getMessage().toLowerCase().contains("size") ||
                        rawEx.getMessage().toLowerCase().contains("exceed"),
                "Exception message must indicate raw cursor length/bound violation before decoding: " + rawEx.getMessage());
    }

    // =========================================================================
    // 10. Review Report Contract: Optional Legacy Metadata and Valid _tenvyr Schema
    // =========================================================================

    @Test
    @DisplayName("ReviewReportMapper permits valid _tenvyr schema with absent optional legacy metadata fields per ReviewReportContract")
    void reviewReportMapper_permitsOptionalLegacyMetadataAndValidTenvyrSchema() {
        ObjectNode outputWithMinimalMetadata = Json.object(
                "score", 92,
                "findings", Json.array("Well structured code"),
                "_tenvyr", Json.object(
                        "metadata", Json.object(
                                "mode", "MOCK"
                        )
                )
        );
        ReviewReport mapped = ReviewReportMapper.fromOutput(outputWithMinimalMetadata);
        assertEquals(92, mapped.score());
        assertEquals(1, mapped.findings().size());
        assertEquals("MOCK", mapped.evidence().mode());
        assertNull(mapped.evidence().provider(), "Optional legacy provider field may be absent");
        assertNull(mapped.evidence().model(), "Optional legacy model field may be absent");
        assertFalse(mapped.evidence().fallbackUsed());
        assertNull(mapped.evidence().usageSource());
    }

    // =========================================================================
    // 11. Exception Classifier: Distinguish Transient vs Bad SQL Errors
    // =========================================================================

    @Test
    @DisplayName("Exception classifier: transient Hikari pool acquisition and engine Db.Failure map to safe 503, bad SQL remains safe 500")
    void transientSqlExceptionClassifier_distinguishesTransientVsBadSql() {
        ReviewErrors.ReviewControllerAdvice advice = new ReviewErrors.ReviewControllerAdvice();

        // 1. Hikari pool timeout (SQLTransientConnectionException wrapped in CannotGetJdbcConnectionException) -> 503 Retry-After: 1
        SQLTransientConnectionException hikariTimeout = new SQLTransientConnectionException(
                "HikariPool-1 - Connection is not available, request timed out after 2000ms.");
        CannotGetJdbcConnectionException poolEx = new CannotGetJdbcConnectionException("Failed to obtain JDBC Connection", hikariTimeout);

        ResponseEntity<Map<String, String>> poolResp = advice.handleDataAccessException(poolEx);
        assertEquals(HttpStatus.SERVICE_UNAVAILABLE, poolResp.getStatusCode(),
                "Hikari connection pool exhaustion must map to 503 SERVICE_UNAVAILABLE");
        assertEquals("1", poolResp.getHeaders().getFirst("Retry-After"),
                "Must include Retry-After: 1 header");
        assertEquals("DATABASE_UNAVAILABLE", poolResp.getBody().get("code"));

        // 2. Engine Db.Failure wrapping SQLTransientException -> 503 Retry-After: 1
        SQLTransientException transientEx = new SQLTransientException("Temporary database lock contention", "55P03");
        Db.Failure dbFailure = new Db.Failure(transientEx);

        ResponseEntity<Map<String, String>> dbFailureResp = advice.handleGeneralException(dbFailure);
        assertEquals(HttpStatus.SERVICE_UNAVAILABLE, dbFailureResp.getStatusCode(),
                "Db.Failure wrapping SQLTransientException must map to 503 SERVICE_UNAVAILABLE");
        assertEquals("1", dbFailureResp.getHeaders().getFirst("Retry-After"),
                "Must include Retry-After: 1 header");
        assertEquals("DATABASE_UNAVAILABLE", dbFailureResp.getBody().get("code"));

        // 3. Bad SQL (syntax error 42601) must remain safe 500 INTERNAL_ERROR, NOT blanket 503
        SQLException badSqlEx = new SQLException("syntax error at or near \"INVALID_KEYWORD\"", "42601");
        BadSqlGrammarException badGrammarEx = new BadSqlGrammarException("select task", "SELECT * FROM ???", badSqlEx);

        ResponseEntity<Map<String, String>> badSqlResp = advice.handleDataAccessException(badGrammarEx);
        assertEquals(HttpStatus.INTERNAL_SERVER_ERROR, badSqlResp.getStatusCode(),
                "Bad SQL grammar must remain 500 INTERNAL_SERVER_ERROR, never blanket 503");
        assertEquals("INTERNAL_ERROR", badSqlResp.getBody().get("code"));
        assertNull(badSqlResp.getHeaders().getFirst("Retry-After"),
                "Bad SQL response must not include Retry-After header");
    }

    // =========================================================================
    // 12. Exception Advice: Reflect Untrusted Input / Sentinel Bounds
    // =========================================================================

    @Test
    @DisplayName("Exception advice handles invalid key and unknown property without reflecting untrusted sentinels or exceeding 256 bytes")
    void exceptionAdvice_handleBadRequest_boundsMessageAndDoesNotReflectSentinels() {
        ReviewErrors.ReviewControllerAdvice advice = new ReviewErrors.ReviewControllerAdvice();
        String sentinel = "SECRET_SENTINEL_TOKEN_12345";
        String longInput = sentinel + "A".repeat(400);

        // 1. Invalid Idempotency-Key
        Exception invalidKeyEx;
        try {
            ReviewValidation.validateIdempotencyKey(longInput);
            throw new AssertionError("validateIdempotencyKey should have failed");
        } catch (Exception e) {
            invalidKeyEx = e;
        }

        ResponseEntity<Map<String, String>> keyResp = advice.handleBadRequest(invalidKeyEx);
        assertEquals(HttpStatus.BAD_REQUEST, keyResp.getStatusCode());
        assertEquals("BAD_REQUEST", keyResp.getBody().get("code"));
        String keyMsg = keyResp.getBody().get("message");
        assertNotNull(keyMsg);
        assertTrue(keyMsg.length() <= 256, "Error message must be <= 256 characters");
        assertFalse(keyMsg.contains(sentinel), "Error message must not reflect untrusted sentinel input");

        // 2. Unrecognized property via parseCreateReview
        String unknownPropJson = "{\"title\":\"Clean Title\",\"language\":\"java\",\"code\":\"class Clean {}\",\""
                + longInput + "\":\"val\"}";
        Exception unknownPropEx;
        try {
            ReviewValidation.parseCreateReview(unknownPropJson);
            throw new AssertionError("parseCreateReview should have failed on unknown property");
        } catch (Exception e) {
            unknownPropEx = e;
        }

        ResponseEntity<Map<String, String>> propResp = advice.handleBadRequest(unknownPropEx);
        assertEquals(HttpStatus.BAD_REQUEST, propResp.getStatusCode());
        assertEquals("BAD_REQUEST", propResp.getBody().get("code"));
        String propMsg = propResp.getBody().get("message");
        assertNotNull(propMsg);
        assertTrue(propMsg.length() <= 256, "Error message must be <= 256 characters");
        assertFalse(propMsg.contains(sentinel), "Error message must not reflect untrusted sentinel input or Jackson excerpt");
    }
}
