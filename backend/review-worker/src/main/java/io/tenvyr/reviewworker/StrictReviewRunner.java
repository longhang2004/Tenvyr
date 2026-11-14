package io.tenvyr.reviewworker;

import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectReader;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.tenvyr.agents.AgentProcessor;
import io.tenvyr.agents.ReviewReportContract;
import io.tenvyr.platform.Json;

import java.util.List;
import java.util.Objects;

/**
 * Strict review runner decorating an underlying AgentProcessor.Runner delegate.
 * Enforces strict raw JSON validation (no duplicate keys, no trailing tokens,
 * valid score and findings, UTF-8 byte bounds) BEFORE AgentProcessor's lenient parseOutput.
 * Never allows fallback to score 80 or 90.
 */
public final class StrictReviewRunner implements AgentProcessor.Runner {

    private static final ObjectReader STRICT_READER = Json.MAPPER.reader()
            .with(JsonParser.Feature.STRICT_DUPLICATE_DETECTION)
            .with(DeserializationFeature.FAIL_ON_TRAILING_TOKENS);

    private final AgentProcessor.Runner delegate;
    private final String mode;

    public StrictReviewRunner(AgentProcessor.Runner delegate) {
        this(delegate, null);
    }

    public StrictReviewRunner(AgentProcessor.Runner delegate, String mode) {
        this.delegate = Objects.requireNonNull(delegate, "Delegate runner is required");
        this.mode = mode;
    }

    @Override
    public JsonNode run(String prompt, ObjectNode context, long timeoutMillis) throws Exception {
        JsonNode response = delegate.run(prompt, context, timeoutMillis);
        if (response == null || !response.isObject()) {
            throw new IllegalArgumentException("Agent Runner response must be a non-null JSON object");
        }

        JsonNode dataNode = response.get("data");
        if (dataNode == null || !dataNode.isObject()) {
            throw new IllegalArgumentException("Agent Runner data must be an object");
        }

        JsonNode outputNode = dataNode.get("output");
        if (outputNode == null || !outputNode.isTextual()) {
            throw new IllegalArgumentException("Agent Runner output must be a string");
        }

        String rawOutput = outputNode.asText();

        // Strict JSON parsing: fails on duplicate keys, trailing tokens, malformed JSON.
        // Stable sanitized message ensures raw output, secrets, and Jackson excerpts are never exposed.
        JsonNode parsedReport;
        try {
            parsedReport = STRICT_READER.readTree(rawOutput);
        } catch (Exception e) {
            throw new IllegalArgumentException("Agent Runner raw output is not strict JSON", e);
        }

        if (parsedReport == null || !parsedReport.isObject()) {
            throw new IllegalArgumentException("Agent Runner raw output must parse to a JSON object");
        }

        // Validate report business contract: score 0..100 integer, findings 0..50 nonblank strings, byte limits
        ReviewReportContract.requireOutput(parsedReport);

        // Augment / normalize metadata if data is an ObjectNode
        if (dataNode instanceof ObjectNode dataObj) {
            JsonNode metaNode = dataObj.get("metadata");
            if (metaNode != null && !metaNode.isNull()) {
                if (!metaNode.isObject()) {
                    throw new IllegalArgumentException("Agent Runner metadata must be an object if present");
                }
                ObjectNode metaObj = (ObjectNode) metaNode;

                // fallbackUsed: when supplied must be boolean
                if (metaObj.has("fallbackUsed")) {
                    JsonNode fbNode = metaObj.get("fallbackUsed");
                    if (fbNode == null || !fbNode.isBoolean()) {
                        throw new IllegalArgumentException("Agent Runner metadata fallbackUsed must be a boolean");
                    }
                } else {
                    metaObj.put("fallbackUsed", false);
                }

                // usageSource, provider, model, mode: when supplied must be textual or explicitly allowed null
                for (String field : List.of("usageSource", "provider", "model", "mode")) {
                    if (metaObj.has(field)) {
                        JsonNode val = metaObj.get(field);
                        if (val != null && !val.isNull() && !val.isTextual()) {
                            throw new IllegalArgumentException("Agent Runner metadata " + field + " must be a string if present");
                        }
                    }
                }

                // Preserve usageSource if textual; default absent/null to "unavailable"
                if (!metaObj.has("usageSource") || metaObj.get("usageSource").isNull()) {
                    metaObj.put("usageSource", "unavailable");
                }

                // Preserve existing mode or set configured mode if available
                if (!metaObj.has("mode") && this.mode != null) {
                    metaObj.put("mode", this.mode);
                }
            } else {
                // metadata absent or JSON null: strip explicit null so AgentProcessor sees no metadata key
                // (AgentProcessor guards with `metadata != null` Java-null check; a NullNode is not null
                //  and would be forwarded to result, failing the agent-result schema's "type":"object" constraint)
                if (metaNode != null) {
                    dataObj.remove("metadata");
                }
                if (this.mode != null) {
                    ObjectNode metaObj = Json.object();
                    metaObj.put("fallbackUsed", false);
                    metaObj.put("usageSource", "unavailable");
                    metaObj.put("mode", this.mode);
                    dataObj.set("metadata", metaObj);
                }
            }
        }

        return response;
    }
}
