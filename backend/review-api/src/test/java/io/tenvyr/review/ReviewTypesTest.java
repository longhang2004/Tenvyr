package io.tenvyr.review;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.LongNode;
import com.fasterxml.jackson.databind.node.NullNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.tenvyr.agents.ReviewReportContract;
import io.tenvyr.platform.Json;
import io.tenvyr.review.domain.ReviewTypes;
import io.tenvyr.review.domain.ReviewTypes.*;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.*;

import static org.junit.jupiter.api.Assertions.*;

/**
 * T02 Unit tests for ReviewTypes public domain contracts, copy-safety/immutability,
 * and ReviewReportContract business report validation rules.
 */
public class ReviewTypesTest {

    @Test
    @DisplayName("ReviewTypes enums define exact agreed constants")
    void testEnumConstants() {
        assertEquals(2, Role.values().length);
        assertEquals(Role.SUBMITTER, Role.valueOf("SUBMITTER"));
        assertEquals(Role.REVIEWER, Role.valueOf("REVIEWER"));

        assertEquals(6, ReviewStatus.values().length);
        assertEquals(ReviewStatus.PROCESSING, ReviewStatus.valueOf("PROCESSING"));
        assertEquals(ReviewStatus.FAILED, ReviewStatus.valueOf("FAILED"));
        assertEquals(ReviewStatus.CANCELLED, ReviewStatus.valueOf("CANCELLED"));
        assertEquals(ReviewStatus.AWAITING_REVIEW, ReviewStatus.valueOf("AWAITING_REVIEW"));
        assertEquals(ReviewStatus.APPROVED, ReviewStatus.valueOf("APPROVED"));
        assertEquals(ReviewStatus.CHANGES_REQUESTED, ReviewStatus.valueOf("CHANGES_REQUESTED"));

        assertEquals(2, DecisionAction.values().length);
        assertEquals(DecisionAction.APPROVE, DecisionAction.valueOf("APPROVE"));
        assertEquals(DecisionAction.REQUEST_CHANGES, DecisionAction.valueOf("REQUEST_CHANGES"));
    }

    @Test
    @DisplayName("ReviewTypes records enforce copy-safety and list immutability")
    void testImmutabilityAndCopySafety() {
        List<String> mutableFindings = new ArrayList<>();
        mutableFindings.add("Initial finding");

        ReportEvidence evidence = new ReportEvidence("MOCK", null, null, true, "estimated");
        ReviewReport report = new ReviewReport(92, mutableFindings, evidence);

        mutableFindings.add("Caller added finding");
        assertEquals(1, report.findings().size(),
                "ReviewReport must defend its findings list against subsequent caller modifications");

        assertThrows(UnsupportedOperationException.class, () -> report.findings().add("Illegal direct mutation"),
                "ReviewReport.findings() must return an unmodifiable list");

        List<String> mutableItems = new ArrayList<>();
        mutableItems.add("item-1");
        Page<String> page = new Page<>(mutableItems, "cursor-next");

        mutableItems.add("item-2");
        assertEquals(1, page.items().size(),
                "Page must defend its items list against caller modifications");

        assertThrows(UnsupportedOperationException.class, () -> page.items().add("Illegal page mutation"),
                "Page.items() must return an unmodifiable list");
    }

    @Test
    @DisplayName("ReviewDetail accepts null errorCode and null decision according to SPEC")
    void testReviewDetailAllowsNullOptionalFields() {
        UUID id = UUID.randomUUID();
        UUID execId = UUID.randomUUID();
        Instant now = Instant.now();

        ReviewDetail pendingDetail = new ReviewDetail(id, "Title", "java", "code",
                ReviewStatus.PROCESSING, now, execId, 0, null, null);

        assertNull(pendingDetail.errorCode(), "errorCode must be nullable");
        assertNull(pendingDetail.decision(), "decision must be nullable");

        ReviewDetail failedDetail = new ReviewDetail(id, "Title", "java", "code",
                ReviewStatus.FAILED, now, execId, 2, "REVIEW_REPORT_INVALID", null);

        assertEquals("REVIEW_REPORT_INVALID", failedDetail.errorCode());
        assertNull(failedDetail.decision());
    }

    @Test
    @DisplayName("ReviewReportContract accepts valid report output with score, findings, and optional _tenvyr")
    void testReviewReportContractValidCases() {
        ObjectNode minimal = Json.object(
                "score", 85,
                "findings", Json.array().add("First finding").add("Second finding")
        );
        ObjectNode result = ReviewReportContract.requireOutput(minimal);
        assertNotNull(result);
        assertEquals(85, result.path("score").asInt());
        assertEquals(2, result.path("findings").size());

        ObjectNode emptyFindings = Json.object("score", 100, "findings", Json.array());
        assertNotNull(ReviewReportContract.requireOutput(emptyFindings));

        ObjectNode withLegacy = Json.object(
                "score", 70,
                "findings", Json.array().add("A finding"),
                "_tenvyr", Json.object(
                        "metadata", Json.object("provider", "mock", "model", "local-heuristic", "fallbackUsed", true),
                        "usage", Json.object("inputTokens", 10, "outputTokens", 20, "totalTokens", 30)
                )
        );
        ObjectNode legacyResult = ReviewReportContract.requireOutput(withLegacy);
        assertNotNull(legacyResult);
        assertTrue(legacyResult.has("_tenvyr"));
    }

    @Test
    @DisplayName("ReviewReportContract strictly enforces integer score in 0..100 and rejects non-integer/string types without coercion")
    void testReviewReportContractScoreValidation() {
        assertNotNull(ReviewReportContract.requireOutput(Json.object("score", 0, "findings", Json.array())));
        assertNotNull(ReviewReportContract.requireOutput(Json.object("score", 100, "findings", Json.array())));
        assertNotNull(ReviewReportContract.requireOutput(Json.object("score", new LongNode(90L), "findings", Json.array())));
        assertNotNull(ReviewReportContract.requireOutput(Json.object("score", new LongNode(0L), "findings", Json.array())));
        assertNotNull(ReviewReportContract.requireOutput(Json.object("score", new LongNode(100L), "findings", Json.array())));

        // String score must NOT coerce
        assertThrows(IllegalArgumentException.class,
                () -> ReviewReportContract.requireOutput(Json.object("score", "90", "findings", Json.array())),
                "String score '90' must be rejected without coercion");

        // Floating point must NOT coerce
        assertThrows(IllegalArgumentException.class,
                () -> ReviewReportContract.requireOutput(Json.object("score", 85.5, "findings", Json.array())),
                "Floating point score must be rejected");

        // Negative score
        assertThrows(IllegalArgumentException.class,
                () -> ReviewReportContract.requireOutput(Json.object("score", -1, "findings", Json.array())),
                "Score < 0 must be rejected");
        assertThrows(IllegalArgumentException.class,
                () -> ReviewReportContract.requireOutput(Json.object("score", new LongNode(-1L), "findings", Json.array())),
                "LongNode score < 0 must be rejected");

        // Score > 100
        assertThrows(IllegalArgumentException.class,
                () -> ReviewReportContract.requireOutput(Json.object("score", 101, "findings", Json.array())),
                "Score > 100 must be rejected");
        assertThrows(IllegalArgumentException.class,
                () -> ReviewReportContract.requireOutput(Json.object("score", new LongNode(101L), "findings", Json.array())),
                "LongNode score > 100 must be rejected");

        // Non-number score types
        assertThrows(IllegalArgumentException.class,
                () -> ReviewReportContract.requireOutput(Json.object("score", true, "findings", Json.array())),
                "Boolean score must be rejected");
        assertThrows(IllegalArgumentException.class,
                () -> ReviewReportContract.requireOutput(Json.object("score", Json.array(), "findings", Json.array())),
                "Array score must be rejected");
        assertThrows(IllegalArgumentException.class,
                () -> ReviewReportContract.requireOutput(Json.object("score", Json.object(), "findings", Json.array())),
                "Object score must be rejected");

        // Missing score
        assertThrows(IllegalArgumentException.class,
                () -> ReviewReportContract.requireOutput(Json.object("findings", Json.array())),
                "Missing score must be rejected");
    }

    @Test
    @DisplayName("ReviewReportContract validates findings constraints: <=50 items, each nonblank <=1000 UTF-16 code units")
    void testReviewReportContractFindingsValidation() {
        // Missing findings
        assertThrows(IllegalArgumentException.class,
                () -> ReviewReportContract.requireOutput(Json.object("score", 90)),
                "Missing findings must be rejected");

        // Non-array findings
        assertThrows(IllegalArgumentException.class,
                () -> ReviewReportContract.requireOutput(Json.object("score", 90, "findings", "none")),
                "Non-array findings must be rejected");
        assertThrows(IllegalArgumentException.class,
                () -> ReviewReportContract.requireOutput(Json.object("score", 90, "findings", 123)),
                "Numeric findings must be rejected");

        // Array containing non-string
        assertThrows(IllegalArgumentException.class,
                () -> ReviewReportContract.requireOutput(Json.object("score", 90, "findings", Json.array().add(123))),
                "Array containing non-string must be rejected");
        assertThrows(IllegalArgumentException.class,
                () -> ReviewReportContract.requireOutput(Json.object("score", 90, "findings", Json.array().add(Json.object()))),
                "Array containing object must be rejected");

        // Blank finding
        assertThrows(IllegalArgumentException.class,
                () -> ReviewReportContract.requireOutput(Json.object("score", 90, "findings", Json.array().add(""))),
                "Empty finding string must be rejected");
        assertThrows(IllegalArgumentException.class,
                () -> ReviewReportContract.requireOutput(Json.object("score", 90, "findings", Json.array().add("   \t\n  "))),
                "Whitespace-only finding must be rejected");
        assertThrows(IllegalArgumentException.class,
                () -> ReviewReportContract.requireOutput(Json.object("score", 90, "findings", Json.array().add("\u2003"))),
                "U+2003 whitespace-only finding must be rejected");
        assertThrows(IllegalArgumentException.class,
                () -> ReviewReportContract.requireOutput(Json.object("score", 90, "findings", Json.array().add("  \u2003  \t"))),
                "Mixed U+2003 whitespace finding must be rejected");

        // Finding length boundary: 1,000 UTF-16 code units accepted
        String exact1000 = "a".repeat(1000);
        assertNotNull(ReviewReportContract.requireOutput(Json.object("score", 90, "findings", Json.array().add(exact1000))));

        // Finding length boundary: 1,001 UTF-16 code units rejected
        String exact1001 = "a".repeat(1001);
        assertThrows(IllegalArgumentException.class,
                () -> ReviewReportContract.requireOutput(Json.object("score", 90, "findings", Json.array().add(exact1001))),
                "Finding exceeding 1,000 UTF-16 code units must be rejected");

        // Findings count boundary: 50 items accepted
        ArrayNode fiftyFindings = Json.array();
        for (int i = 0; i < 50; i++) {
            fiftyFindings.add("Finding #" + (i + 1));
        }
        assertNotNull(ReviewReportContract.requireOutput(Json.object("score", 90, "findings", fiftyFindings)));

        // Findings count boundary: 51 items rejected
        ArrayNode fiftyOneFindings = Json.array();
        for (int i = 0; i < 51; i++) {
            fiftyOneFindings.add("Finding #" + (i + 1));
        }
        assertThrows(IllegalArgumentException.class,
                () -> ReviewReportContract.requireOutput(Json.object("score", 90, "findings", fiftyOneFindings)),
                "Findings count exceeding 50 must be rejected");
    }

    @Test
    @DisplayName("ReviewReportContract rejects unallowed business fields and non-object inputs")
    void testReviewReportContractDisallowedFieldsAndInputs() {
        assertThrows(IllegalArgumentException.class,
                () -> ReviewReportContract.requireOutput(null),
                "null input must be rejected");
        assertThrows(IllegalArgumentException.class,
                () -> ReviewReportContract.requireOutput(Json.array()),
                "Array input must be rejected");
        assertThrows(IllegalArgumentException.class,
                () -> ReviewReportContract.requireOutput(Json.value("text")),
                "Primitive input must be rejected");

        // _tenvyr non-object or null rejected
        assertThrows(IllegalArgumentException.class,
                () -> ReviewReportContract.requireOutput(Json.object("score", 90, "findings", Json.array(), "_tenvyr", NullNode.getInstance())),
                "null _tenvyr must be rejected");
        assertThrows(IllegalArgumentException.class,
                () -> ReviewReportContract.requireOutput(Json.object("score", 90, "findings", Json.array(), "_tenvyr", "non-object-string")),
                "string _tenvyr must be rejected");
        assertThrows(IllegalArgumentException.class,
                () -> ReviewReportContract.requireOutput(Json.object("score", 90, "findings", Json.array(), "_tenvyr", 12345)),
                "numeric _tenvyr must be rejected");
        assertThrows(IllegalArgumentException.class,
                () -> ReviewReportContract.requireOutput(Json.object("score", 90, "findings", Json.array(), "_tenvyr", Json.array())),
                "array _tenvyr must be rejected");

        // Extra unexpected business fields
        assertThrows(IllegalArgumentException.class,
                () -> ReviewReportContract.requireOutput(Json.object("score", 90, "findings", Json.array(), "extraField", "unexpected")),
                "Extra unallowed fields must be rejected");
        assertThrows(IllegalArgumentException.class,
                () -> ReviewReportContract.requireOutput(Json.object("score", 90, "findings", Json.array(), "status", "APPROVED")),
                "Shadowing status field must be rejected");
    }

    @Test
    @DisplayName("ReviewReportContract enforces exact 65,536 accepted and 65,537 rejected UTF-8 byte bounds and distinguishes Unicode byte bounds from Java string length")
    void testReviewReportContractUtf8ByteBoundsAndUnicodeDistinction() {
        // Construct 31 findings of 700 3-byte Chinese characters '\u4e16'
        // Each finding has length 700 UTF-16 units (<= 1,000) and 2,100 UTF-8 bytes.
        // 31 findings = 65,100 UTF-8 bytes.
        // The 32nd finding is calibrated ASCII characters (1 byte per char) to hit EXACTLY 65,536 bytes.
        ArrayNode findings65536 = Json.array();
        String block700 = "\u4e16".repeat(700);
        for (int i = 0; i < 31; i++) {
            findings65536.add(block700);
        }
        findings65536.add("a"); // Placeholder 32nd finding

        ObjectNode report65536 = Json.object("score", 90, "findings", findings65536);
        int initialBytes = Json.stringify(report65536).getBytes(StandardCharsets.UTF_8).length;
        int diff = 65536 - initialBytes;
        assertTrue(diff > 0 && diff < 1000, "Calibration offset must be valid ASCII filler: " + diff);

        String filler65536 = "a".repeat(1 + diff);
        assertTrue(filler65536.length() <= 1000, "Filler must be <= 1,000 UTF-16 code units");
        findings65536.set(31, Json.value(filler65536));

        byte[] bytes65536 = Json.stringify(report65536).getBytes(StandardCharsets.UTF_8);
        assertEquals(65536, bytes65536.length, "Report serialized UTF-8 bytes must equal exactly 65,536");
        assertTrue(findings65536.size() <= 50, "Findings count must be <= 50");
        // Java string length is ~22,100, which is far below 65,536
        assertTrue(Json.stringify(report65536).length() < 30000,
                "Java String length must be far below 65,536 to prove distinction from UTF-8 byte bounds");

        // Exactly 65,536 UTF-8 bytes must be accepted
        assertNotNull(ReviewReportContract.requireOutput(report65536));

        // Now construct report with exactly 65,537 UTF-8 bytes by incrementing filler by 1 char
        ArrayNode findings65537 = Json.array();
        for (int i = 0; i < 31; i++) {
            findings65537.add(block700);
        }
        String filler65537 = "a".repeat(1 + diff + 1);
        assertTrue(filler65537.length() <= 1000, "Filler must be <= 1,000 UTF-16 code units");
        findings65537.add(filler65537);

        ObjectNode report65537 = Json.object("score", 90, "findings", findings65537);
        byte[] bytes65537 = Json.stringify(report65537).getBytes(StandardCharsets.UTF_8);
        assertEquals(65537, bytes65537.length, "Report serialized UTF-8 bytes must equal exactly 65,537");
        assertTrue(findings65537.size() <= 50, "Findings count must be <= 50");
        assertTrue(Json.stringify(report65537).length() < 30000,
                "Java String length must be far below 65,536");

        // Exactly 65,537 UTF-8 bytes must be rejected
        IllegalArgumentException ex = assertThrows(IllegalArgumentException.class,
                () -> ReviewReportContract.requireOutput(report65537));
        assertTrue(ex.getMessage().contains("65,536") || ex.getMessage().contains("65536"));
    }
}
