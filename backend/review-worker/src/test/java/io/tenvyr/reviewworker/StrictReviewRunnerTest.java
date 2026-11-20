package io.tenvyr.reviewworker;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.tenvyr.agents.AgentProcessor;
import io.tenvyr.platform.Json;
import io.tenvyr.platform.Protocol;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.net.http.HttpTimeoutException;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.TimeoutException;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Unit tests verifying strict raw report validation when AgentProcessor runs via StrictReviewRunner.
 * Rejections must fail cleanly as nonretryable without output, never falling back to score 80 or 90.
 */
class StrictReviewRunnerTest {

    private static final Path FALLBACK_SKILLS = Path.of("empty-skills-path");

    private static ObjectNode invocation(String id, String code) {
        return Protocol.invocation(Json.object(
                "schemaVersion", "1",
                "invocationId", id,
                "executionId", "exec-" + id,
                "stepExecutionId", "step-" + id,
                "stepId", "review",
                "target", Json.object("agent", "code-reviewer"),
                "input", Json.object("code", code, "language", "typescript"),
                "attempt", 1,
                "createdAt", "2026-07-26T00:00:00.000Z",
                "trace", Json.object("traceId", "trace-" + id, "correlationId", id)
        ));
    }

    private static JsonNode runnerSuccess(String rawOutput) {
        return Json.object(
                "success", true,
                "data", Json.object(
                        "output", rawOutput,
                        "promptTokens", 12,
                        "completionTokens", 34,
                        "totalTokens", 46,
                        "metadata", Json.object(
                                "provider", "anthropic",
                                "model", "claude-3-5-sonnet",
                                "fallbackUsed", false,
                                "usageSource", "provider"
                        )
                )
        );
    }

    @Test
    @DisplayName("Valid report JSON passes strict validation and preserves usage and metadata")
    void validReportOutputSucceedsAndPreservesMetadataAndUsage() {
        String reportJson = "{\"score\":95,\"findings\":[\"Potential secret token in config.\"]}";
        AgentProcessor processor = new AgentProcessor("code-reviewer", FALLBACK_SKILLS,
                new StrictReviewRunner((prompt, context, timeout) -> runnerSuccess(reportJson)));

        ObjectNode result = processor.process(invocation("valid-run", "const safe = true;"));

        assertEquals("succeeded", result.path("status").asText());
        assertEquals(95, result.path("output").path("score").asInt());
        assertEquals(1, result.path("output").path("findings").size());
        assertEquals("Potential secret token in config.", result.path("output").path("findings").get(0).asText());

        assertEquals(12, result.path("usage").path("inputTokens").asInt());
        assertEquals(34, result.path("usage").path("outputTokens").asInt());
        assertEquals(46, result.path("usage").path("totalTokens").asInt());

        assertEquals("anthropic", result.path("metadata").path("provider").asText());
        assertEquals("claude-3-5-sonnet", result.path("metadata").path("model").asText());
        assertEquals(result.path("metadata"), result.path("output").path("_tenvyr").path("metadata"));
        assertEquals(result.path("usage"), result.path("output").path("_tenvyr").path("usage"));
    }

    @Test
    @DisplayName("Plaintext output is rejected as nonretryable failure with output absent, never invented score 80 or 90")
    void plaintextOutputRejectedAsFailedNonretryableWithoutInventingScore() {
        String plaintext = "This code looks fine, no issues detected.";
        AgentProcessor processor = new AgentProcessor("code-reviewer", FALLBACK_SKILLS,
                new StrictReviewRunner((prompt, context, timeout) -> runnerSuccess(plaintext)));

        ObjectNode result = processor.process(invocation("plain-run", "const x = 1;"));

        assertEquals("failed", result.path("status").asText());
        assertFalse(result.path("error").path("retryable").asBoolean());
        assertEquals("AGENT_EXECUTION_FAILED", result.path("error").path("code").asText());
        assertFalse(result.has("output"), "Output must be completely absent on failure");
        assertNotEquals(80, result.path("output").path("score").asInt(-1), "Must never invent fallback score 80");
        assertNotEquals(90, result.path("output").path("score").asInt(-1), "Must never invent fallback score 90");
    }

    @Test
    @DisplayName("Malformed JSON is rejected as nonretryable failure without output")
    void malformedJsonOutputRejectedAsFailedNonretryable() {
        String malformed = "{score: 90, findings: [unclosed";
        AgentProcessor processor = new AgentProcessor("code-reviewer", FALLBACK_SKILLS,
                new StrictReviewRunner((prompt, context, timeout) -> runnerSuccess(malformed)));

        ObjectNode result = processor.process(invocation("malformed-run", "const x = 1;"));

        assertEquals("failed", result.path("status").asText());
        assertFalse(result.path("error").path("retryable").asBoolean());
        assertFalse(result.has("output"));
    }

    @Test
    @DisplayName("JSON trailing tokens are strictly rejected as nonretryable failure")
    void trailingTokensInJsonRejectedAsFailedNonretryable() {
        String trailing = "{\"score\":90,\"findings\":[]} trailing text";
        AgentProcessor processor = new AgentProcessor("code-reviewer", FALLBACK_SKILLS,
                new StrictReviewRunner((prompt, context, timeout) -> runnerSuccess(trailing)));

        ObjectNode result = processor.process(invocation("trailing-run", "const x = 1;"));

        assertEquals("failed", result.path("status").asText());
        assertFalse(result.path("error").path("retryable").asBoolean());
        assertFalse(result.has("output"));
    }

    @Test
    @DisplayName("Duplicate keys in JSON are strictly rejected as nonretryable failure")
    void duplicateKeysInJsonRejectedAsFailedNonretryable() {
        String duplicateKeys = "{\"score\":90,\"score\":80,\"findings\":[]}";
        AgentProcessor processor = new AgentProcessor("code-reviewer", FALLBACK_SKILLS,
                new StrictReviewRunner((prompt, context, timeout) -> runnerSuccess(duplicateKeys)));

        ObjectNode result = processor.process(invocation("dup-keys-run", "const x = 1;"));

        assertEquals("failed", result.path("status").asText());
        assertFalse(result.path("error").path("retryable").asBoolean());
        assertFalse(result.has("output"));
    }

    @Test
    @DisplayName("Missing data or missing output field is rejected as nonretryable failure")
    void missingDataOrMissingOutputRejected() {
        AgentProcessor missingDataProcessor = new AgentProcessor("code-reviewer", FALLBACK_SKILLS,
                new StrictReviewRunner((prompt, context, timeout) -> Json.object("success", true)));
        ObjectNode missingDataResult = missingDataProcessor.process(invocation("no-data", "const x = 1;"));
        assertEquals("failed", missingDataResult.path("status").asText());
        assertFalse(missingDataResult.path("error").path("retryable").asBoolean());
        assertFalse(missingDataResult.has("output"));

        AgentProcessor missingOutputProcessor = new AgentProcessor("code-reviewer", FALLBACK_SKILLS,
                new StrictReviewRunner((prompt, context, timeout) -> Json.object("success", true, "data", Json.object())));
        ObjectNode missingOutputResult = missingOutputProcessor.process(invocation("no-output", "const x = 1;"));
        assertEquals("failed", missingOutputResult.path("status").asText());
        assertFalse(missingOutputResult.path("error").path("retryable").asBoolean());
        assertFalse(missingOutputResult.has("output"));
    }

    @Test
    @DisplayName("Non-textual data.output is rejected as nonretryable failure")
    void nonTextualOutputRejected() {
        AgentProcessor processor = new AgentProcessor("code-reviewer", FALLBACK_SKILLS,
                new StrictReviewRunner((prompt, context, timeout) -> Json.object(
                        "success", true,
                        "data", Json.object("output", Json.object("score", 100, "findings", Json.array()))
                )));

        ObjectNode result = processor.process(invocation("non-text-run", "const x = 1;"));

        assertEquals("failed", result.path("status").asText());
        assertFalse(result.path("error").path("retryable").asBoolean());
        assertFalse(result.has("output"));
    }

    @Test
    @DisplayName("Missing or non-integral score is rejected")
    void missingOrNonIntegralScoreRejected() {
        for (String badScoreJson : List.of(
                "{\"findings\":[]}",
                "{\"score\":\"90\",\"findings\":[]}",
                "{\"score\":true,\"findings\":[]}",
                "{\"score\":null,\"findings\":[]}"
        )) {
            AgentProcessor processor = new AgentProcessor("code-reviewer", FALLBACK_SKILLS,
                    new StrictReviewRunner((prompt, context, timeout) -> runnerSuccess(badScoreJson)));
            ObjectNode result = processor.process(invocation("bad-score", "const x = 1;"));
            assertEquals("failed", result.path("status").asText(), "Should reject: " + badScoreJson);
            assertFalse(result.path("error").path("retryable").asBoolean());
            assertFalse(result.has("output"));
        }
    }

    @Test
    @DisplayName("Fractional or out-of-range score is rejected")
    void fractionalOrOutOfRangeScoreRejected() {
        for (String outOfRangeJson : List.of(
                "{\"score\":85.5,\"findings\":[]}",
                "{\"score\":-1,\"findings\":[]}",
                "{\"score\":101,\"findings\":[]}",
                "{\"score\":9007199254740992,\"findings\":[]}"
        )) {
            AgentProcessor processor = new AgentProcessor("code-reviewer", FALLBACK_SKILLS,
                    new StrictReviewRunner((prompt, context, timeout) -> runnerSuccess(outOfRangeJson)));
            ObjectNode result = processor.process(invocation("range-score", "const x = 1;"));
            assertEquals("failed", result.path("status").asText(), "Should reject: " + outOfRangeJson);
            assertFalse(result.path("error").path("retryable").asBoolean());
            assertFalse(result.has("output"));
        }
    }

    @Test
    @DisplayName("Missing findings or non-array/non-text findings are rejected")
    void missingOrMalformedFindingsRejected() {
        for (String badFindingsJson : List.of(
                "{\"score\":90}",
                "{\"score\":90,\"findings\":\"not-an-array\"}",
                "{\"score\":90,\"findings\":null}",
                "{\"score\":90,\"findings\":[123]}",
                "{\"score\":90,\"findings\":[{\"text\":\"nested\"}]}"
        )) {
            AgentProcessor processor = new AgentProcessor("code-reviewer", FALLBACK_SKILLS,
                    new StrictReviewRunner((prompt, context, timeout) -> runnerSuccess(badFindingsJson)));
            ObjectNode result = processor.process(invocation("bad-findings", "const x = 1;"));
            assertEquals("failed", result.path("status").asText(), "Should reject: " + badFindingsJson);
            assertFalse(result.path("error").path("retryable").asBoolean());
            assertFalse(result.has("output"));
        }
    }

    @Test
    @DisplayName("Blank finding string is rejected")
    void blankFindingRejected() {
        for (String blankFindingJson : List.of(
                "{\"score\":90,\"findings\":[\"   \"]}",
                "{\"score\":90,\"findings\":[\"\t\n\"]}",
                "{\"score\":90,\"findings\":[\"\u2003\"]}"
        )) {
            AgentProcessor processor = new AgentProcessor("code-reviewer", FALLBACK_SKILLS,
                    new StrictReviewRunner((prompt, context, timeout) -> runnerSuccess(blankFindingJson)));
            ObjectNode result = processor.process(invocation("blank-finding", "const x = 1;"));
            assertEquals("failed", result.path("status").asText(), "Should reject blank finding: " + blankFindingJson);
            assertFalse(result.path("error").path("retryable").asBoolean());
            assertFalse(result.has("output"));
        }
    }

    @Test
    @DisplayName("Finding exceeding 1000 UTF-16 code units is rejected")
    void findingExceeding1000CharsRejected() {
        String longFindingJson = "{\"score\":90,\"findings\":[\"" + "a".repeat(1001) + "\"]}";
        AgentProcessor processor = new AgentProcessor("code-reviewer", FALLBACK_SKILLS,
                new StrictReviewRunner((prompt, context, timeout) -> runnerSuccess(longFindingJson)));

        ObjectNode result = processor.process(invocation("long-finding", "const x = 1;"));

        assertEquals("failed", result.path("status").asText());
        assertFalse(result.path("error").path("retryable").asBoolean());
        assertFalse(result.has("output"));
    }

    @Test
    @DisplayName("Findings array exceeding 50 items is rejected")
    void excessiveFindingsCountRejected() {
        ArrayNode findingsArray = Json.array();
        for (int i = 0; i < 51; i++) {
            findingsArray.add("Finding #" + i);
        }
        String excessiveJson = Json.stringify(Json.object("score", 90, "findings", findingsArray));

        AgentProcessor processor = new AgentProcessor("code-reviewer", FALLBACK_SKILLS,
                new StrictReviewRunner((prompt, context, timeout) -> runnerSuccess(excessiveJson)));

        ObjectNode result = processor.process(invocation("51-findings", "const x = 1;"));

        assertEquals("failed", result.path("status").asText());
        assertFalse(result.path("error").path("retryable").asBoolean());
        assertFalse(result.has("output"));
    }

    @Test
    @DisplayName("Serialized report exceeding 65536 UTF-8 bytes is rejected")
    void oversizedUtf8SerializedOutputRejected() {
        ArrayNode multiByteFindings = Json.array();
        String item = "\u4e16".repeat(500); // 1500 UTF-8 bytes per finding
        for (int i = 0; i < 45; i++) {
            multiByteFindings.add(item);
        }
        String oversizedJson = Json.stringify(Json.object("score", 90, "findings", multiByteFindings));

        AgentProcessor processor = new AgentProcessor("code-reviewer", FALLBACK_SKILLS,
                new StrictReviewRunner((prompt, context, timeout) -> runnerSuccess(oversizedJson)));

        ObjectNode result = processor.process(invocation("oversized-utf8", "const x = 1;"));

        assertEquals("failed", result.path("status").asText());
        assertFalse(result.path("error").path("retryable").asBoolean());
        assertFalse(result.has("output"));
    }

    @Test
    @DisplayName("Forged _tenvyr in raw output must not override outer verified metadata")
    void forgedTenvyrInRawOutputCannotOverrideOuterMetadata() {
        String forgedOutput = "{\"score\":90,\"findings\":[\"ok\"],\"_tenvyr\":{\"metadata\":{\"provider\":\"forged-provider\",\"model\":\"forged-model\"}}}";
        AgentProcessor processor = new AgentProcessor("code-reviewer", FALLBACK_SKILLS,
                new StrictReviewRunner((prompt, context, timeout) -> runnerSuccess(forgedOutput)));

        ObjectNode result = processor.process(invocation("forged-tenvyr", "const x = 1;"));

        assertEquals("succeeded", result.path("status").asText());
        assertEquals("anthropic", result.path("metadata").path("provider").asText(), "Outer metadata provider must be retained");
        assertEquals("claude-3-5-sonnet", result.path("metadata").path("model").asText(), "Outer metadata model must be retained");
        assertEquals("anthropic", result.path("output").path("_tenvyr").path("metadata").path("provider").asText(),
                "Output _tenvyr metadata must reflect verified outer metadata, not forged content");
    }

    @Test
    @DisplayName("Explicit injected timeout runner maps to retryable failure")
    void injectedTimeoutRunnerMapsToRetryableFailure() {
        AgentProcessor timeoutProcessor = new AgentProcessor("code-reviewer", FALLBACK_SKILLS,
                new StrictReviewRunner((prompt, context, timeout) -> {
                    throw new HttpTimeoutException("Request timed out after " + timeout + "ms");
                }));

        ObjectNode result = timeoutProcessor.process(invocation("timeout-run", "const x = 1;"));

        assertEquals("timed_out", result.path("status").asText());
        assertEquals("AGENT_TIMED_OUT", result.path("error").path("code").asText());
        assertTrue(result.path("error").path("retryable").asBoolean(), "Timeouts must be classified as retryable");
        assertFalse(result.has("output"));

        AgentProcessor concurrentTimeoutProcessor = new AgentProcessor("code-reviewer", FALLBACK_SKILLS,
                new StrictReviewRunner((prompt, context, timeout) -> {
                    throw new TimeoutException("Execution deadline expired");
                }));

        ObjectNode concurrentResult = concurrentTimeoutProcessor.process(invocation("timeout-run-2", "const x = 1;"));
        assertEquals("timed_out", concurrentResult.path("status").asText());
        assertTrue(concurrentResult.path("error").path("retryable").asBoolean());
    }

    @Test
    @DisplayName("Injected non-timeout exception maps to nonretryable failure")
    void injectedIoExceptionRunnerMapsToNonretryableFailure() {
        AgentProcessor processor = new AgentProcessor("code-reviewer", FALLBACK_SKILLS,
                new StrictReviewRunner((prompt, context, timeout) -> {
                    throw new java.io.IOException("Remote runner service unavailable");
                }));

        ObjectNode result = processor.process(invocation("io-error-run", "const x = 1;"));

        assertEquals("failed", result.path("status").asText());
        assertEquals("AGENT_EXECUTION_FAILED", result.path("error").path("code").asText());
        assertFalse(result.path("error").path("retryable").asBoolean(), "IO failures must not be retryable");
        assertFalse(result.has("output"));
    }

    @Test
    @DisplayName("Raw output JSON parse error uses stable sanitized message and never echoes secrets or Jackson excerpts")
    void rawOutputParseExceptionDoesNotEchoRawSecretOrJacksonExcerpts() {
        String malformedWithSecret = "{\"score\": 90, \"secret\": \"SENTINEL_LEAK_SECRET_TOKEN_XYZ_12345\", \"findings\": [unclosed";
        AgentProcessor processor = new AgentProcessor("code-reviewer", FALLBACK_SKILLS,
                new StrictReviewRunner((prompt, context, timeout) -> runnerSuccess(malformedWithSecret)));

        ObjectNode result = processor.process(invocation("secret-leak-run", "const x = 1;"));

        assertEquals("failed", result.path("status").asText());
        assertEquals("AGENT_EXECUTION_FAILED", result.path("error").path("code").asText());
        assertFalse(result.path("error").path("retryable").asBoolean());
        assertFalse(result.has("output"));

        String errorMessage = result.path("error").path("message").asText();
        assertEquals("Agent Runner raw output is not strict JSON", errorMessage,
                "Error message must be a stable sanitized string");
        assertFalse(errorMessage.contains("SENTINEL_LEAK_SECRET_TOKEN_XYZ_12345"),
                "Error message must never echo raw report text or secrets");
        assertFalse(errorMessage.contains("unclosed"),
                "Error message must never echo Jackson excerpt text");
        assertFalse(errorMessage.contains("Source:"),
                "Error message must not expose Jackson parser source details");
    }

    @Test
    @DisplayName("Malformed non-null data.metadata is rejected as nonretryable failure")
    void malformedNonNullMetadataRejectedAsNonretryableFailure() {
        for (JsonNode badMeta : List.of(
                Json.value("not-an-object"),
                Json.value(12345),
                Json.array(1, 2, 3),
                Json.value(true)
        )) {
            AgentProcessor processor = new AgentProcessor("code-reviewer", FALLBACK_SKILLS,
                    new StrictReviewRunner((prompt, context, timeout) -> Json.object(
                            "success", true,
                            "data", Json.object(
                                    "output", "{\"score\":95,\"findings\":[]}",
                                    "metadata", badMeta
                            )
                    )));

            ObjectNode result = processor.process(invocation("bad-meta-run", "const x = 1;"));

            assertEquals("failed", result.path("status").asText(), "Should reject non-object metadata: " + badMeta);
            assertEquals("AGENT_EXECUTION_FAILED", result.path("error").path("code").asText());
            assertFalse(result.path("error").path("retryable").asBoolean());
            assertFalse(result.has("output"));
        }
    }

    @Test
    @DisplayName("Malformed metadata fields are rejected as nonretryable failure")
    void malformedMetadataFieldsRejectedAsNonretryableFailure() {
        List<ObjectNode> badFieldMetadataList = List.of(
                Json.object("fallbackUsed", "true"),
                Json.object("fallbackUsed", 1),
                Json.object("fallbackUsed", Json.value(null)),
                Json.object("usageSource", 123),
                Json.object("usageSource", true),
                Json.object("provider", 456),
                Json.object("provider", false),
                Json.object("model", 789),
                Json.object("model", true),
                Json.object("mode", 999),
                Json.object("mode", false)
        );

        for (ObjectNode badMeta : badFieldMetadataList) {
            AgentProcessor processor = new AgentProcessor("code-reviewer", FALLBACK_SKILLS,
                    new StrictReviewRunner((prompt, context, timeout) -> Json.object(
                            "success", true,
                            "data", Json.object(
                                    "output", "{\"score\":95,\"findings\":[]}",
                                    "metadata", badMeta
                            )
                    )));

            ObjectNode result = processor.process(invocation("bad-meta-field", "const x = 1;"));

            assertEquals("failed", result.path("status").asText(), "Should reject malformed metadata: " + badMeta);
            assertEquals("AGENT_EXECUTION_FAILED", result.path("error").path("code").asText());
            assertFalse(result.path("error").path("retryable").asBoolean());
            assertFalse(result.has("output"));
        }
    }

    @Test
    @DisplayName("Valid legacy absent or null metadata succeeds without fabricating provider or model")
    void validLegacyAbsentOrNullMetadataSucceedsWithoutFabricatingFields() {
        // Case 1: metadata absent
        AgentProcessor absentProcessor = new AgentProcessor("code-reviewer", FALLBACK_SKILLS,
                new StrictReviewRunner((prompt, context, timeout) -> Json.object(
                        "success", true,
                        "data", Json.object(
                                "output", "{\"score\":95,\"findings\":[\"Clean\"]}"
                        )
                )));

        ObjectNode absentResult = absentProcessor.process(invocation("absent-meta-run", "const x = 1;"));
        assertEquals("succeeded", absentResult.path("status").asText());
        assertEquals(95, absentResult.path("output").path("score").asInt());
        assertFalse(absentResult.path("metadata").has("provider"), "Must not fabricate provider");
        assertFalse(absentResult.path("metadata").has("model"), "Must not fabricate model");

        // Case 2: metadata explicitly null
        AgentProcessor nullProcessor = new AgentProcessor("code-reviewer", FALLBACK_SKILLS,
                new StrictReviewRunner((prompt, context, timeout) -> Json.object(
                        "success", true,
                        "data", Json.object(
                                "output", "{\"score\":95,\"findings\":[\"Clean\"]}",
                                "metadata", null
                        )
                )));

        ObjectNode nullResult = nullProcessor.process(invocation("null-meta-run", "const x = 1;"));
        assertEquals("succeeded", nullResult.path("status").asText());
        assertEquals(95, nullResult.path("output").path("score").asInt());
        assertFalse(nullResult.path("metadata").has("provider"), "Must not fabricate provider");
        assertFalse(nullResult.path("metadata").has("model"), "Must not fabricate model");
    }
}
