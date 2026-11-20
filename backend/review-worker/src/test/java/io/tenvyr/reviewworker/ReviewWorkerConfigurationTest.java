package io.tenvyr.reviewworker;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.tenvyr.agents.AgentProcessor;
import io.tenvyr.platform.Json;
import io.tenvyr.worker.WorkerConfig;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Tests verifying environment configuration parsing, bounds, mode resolution,
 * truthful MOCK fixtures, and RUNNER metadata preservation.
 */
class ReviewWorkerConfigurationTest {

    private static Map<String, String> validMockEnv() {
        return Map.of(
                "TENVYR_REVIEW_WORKER_BEARER_TOKEN", "test-bearer-secret",
                "TENVYR_REVIEW_WORKER_CALLBACK_KEYS", "{\"key-1\":\"secret-1\"}",
                "TENVYR_REVIEW_WORKER_CALLBACK_ORIGINS", "[\"https://service.example:8443\"]"
        );
    }

    @Test
    @DisplayName("Default configuration resolves MOCK mode with fixed worker bounds and defaults")
    void validDefaultConfigurationUsesMockModeAndStandardBounds() {
        Map<String, String> env = validMockEnv();

        WorkerConfig config = ReviewWorkerMain.configuration(env);

        assertEquals("code-reviewer", config.agentName, "Agent name must be strictly code-reviewer");
        assertEquals("test-bearer-secret", config.bearerToken);
        assertEquals(Map.of("key-1", "secret-1"), config.callbackKeys);
        assertEquals(List.of("https://service.example:8443"), config.allowedOrigins);
        assertFalse(config.allowInsecureHttp, "Default allowInsecureHttp must be false");
        assertEquals(2, config.concurrency, "Fixed review worker concurrency must be 2");
        assertEquals(16, config.maxQueuedRuns, "Fixed queue size must be 16");
        assertEquals(1_048_576, config.maxRequestBytes, "Max request bytes must be 1 MiB (1048576)");
        assertEquals(65_536, config.maxResponseBytes, "Max response bytes must be 65536");
        assertEquals(1_048_576, ReviewWorkerMain.FIXED_RUNNER_MAX_RESPONSE_BYTES, "Runner response bound must be 1 MiB (1048576)");
    }

    @Test
    @DisplayName("Missing or blank bearer token throws IllegalArgumentException")
    void missingRequiredBearerTokenThrowsException() {
        Map<String, String> envNoToken = new HashMap<>(validMockEnv());
        envNoToken.remove("TENVYR_REVIEW_WORKER_BEARER_TOKEN");
        assertThrows(IllegalArgumentException.class, () -> ReviewWorkerMain.configuration(envNoToken));

        Map<String, String> envBlankToken = new HashMap<>(validMockEnv());
        envBlankToken.put("TENVYR_REVIEW_WORKER_BEARER_TOKEN", "   ");
        assertThrows(IllegalArgumentException.class, () -> ReviewWorkerMain.configuration(envBlankToken));
    }

    @Test
    @DisplayName("Missing, empty, or malformed callback keys throw IllegalArgumentException")
    void missingOrMalformedCallbackKeysThrowsException() {
        Map<String, String> base = validMockEnv();

        for (String badKeys : List.of("", "{}", "not-json", "[\"key\"]", "{\"key\":\"\"}")) {
            Map<String, String> env = new HashMap<>(base);
            env.put("TENVYR_REVIEW_WORKER_CALLBACK_KEYS", badKeys);
            assertThrows(IllegalArgumentException.class, () -> ReviewWorkerMain.configuration(env),
                    "Should reject callback keys: " + badKeys);
        }

        Map<String, String> noKeysEnv = new HashMap<>(base);
        noKeysEnv.remove("TENVYR_REVIEW_WORKER_CALLBACK_KEYS");
        assertThrows(IllegalArgumentException.class, () -> ReviewWorkerMain.configuration(noKeysEnv));
    }

    @Test
    @DisplayName("Missing, empty, or malformed callback origins throw IllegalArgumentException")
    void missingOrMalformedCallbackOriginsThrowsException() {
        Map<String, String> base = validMockEnv();

        for (String badOrigins : List.of("", "[]", "not-json", "{\"origin\":\"url\"}", "[\"\"]", "[\"http://disallowed-http.com\"]")) {
            Map<String, String> env = new HashMap<>(base);
            env.put("TENVYR_REVIEW_WORKER_CALLBACK_ORIGINS", badOrigins);
            assertThrows(IllegalArgumentException.class, () -> ReviewWorkerMain.configuration(env),
                    "Should reject callback origins: " + badOrigins);
        }

        Map<String, String> noOriginsEnv = new HashMap<>(base);
        noOriginsEnv.remove("TENVYR_REVIEW_WORKER_CALLBACK_ORIGINS");
        assertThrows(IllegalArgumentException.class, () -> ReviewWorkerMain.configuration(noOriginsEnv));
    }

    @Test
    @DisplayName("Insecure HTTP requires exact case-sensitive 'true' opt-in")
    void insecureHttpRequiresExactTrueOptIn() {
        Map<String, String> base = new HashMap<>(validMockEnv());
        base.put("TENVYR_REVIEW_WORKER_CALLBACK_ORIGINS", "[\"http://127.0.0.1:8080\"]");

        Map<String, String> optInEnv = new HashMap<>(base);
        optInEnv.put("TENVYR_REVIEW_WORKER_ALLOW_INSECURE_HTTP", "true");
        WorkerConfig optInConfig = ReviewWorkerMain.configuration(optInEnv);
        assertTrue(optInConfig.allowInsecureHttp);

        for (String notExactTrue : List.of("True", "TRUE", "1", "yes", "false", "", " true ")) {
            Map<String, String> nonTrueEnv = new HashMap<>(base);
            nonTrueEnv.put("TENVYR_REVIEW_WORKER_ALLOW_INSECURE_HTTP", notExactTrue);
            assertThrows(IllegalArgumentException.class, () -> ReviewWorkerMain.configuration(nonTrueEnv),
                    "Non-exact 'true' string must not allow insecure HTTP: " + notExactTrue);
        }
    }

    @Test
    @DisplayName("RUNNER mode requires valid fixed private origin without userinfo, query, fragment, or path")
    void runnerModeRequiresValidRunnerUrl() {
        Map<String, String> base = new HashMap<>(validMockEnv());
        base.put("TENVYR_REVIEW_WORKER_MODE", "RUNNER");

        Map<String, String> missingUrlEnv = new HashMap<>(base);
        assertThrows(IllegalArgumentException.class, () -> ReviewWorkerMain.configuration(missingUrlEnv));

        for (String invalidUrl : List.of(
                "http://user:pass@127.0.0.1:8080",
                "http://127.0.0.1:8080/api/run",
                "http://127.0.0.1:8080/path",
                "http://127.0.0.1:8080?query=1",
                "http://127.0.0.1:8080#fragment",
                "ftp://127.0.0.1:8080",
                "http://127.0.0.1:8080" // Insecure http without opt-in
        )) {
            Map<String, String> invalidEnv = new HashMap<>(base);
            invalidEnv.put("TENVYR_REVIEW_WORKER_RUNNER_URL", invalidUrl);
            assertThrows(IllegalArgumentException.class, () -> ReviewWorkerMain.configuration(invalidEnv),
                    "Should reject runner URL: " + invalidUrl);
        }

        Map<String, String> validHttpsEnv = new HashMap<>(base);
        validHttpsEnv.put("TENVYR_REVIEW_WORKER_RUNNER_URL", "https://runner.internal:8443");
        WorkerConfig httpsConfig = ReviewWorkerMain.configuration(validHttpsEnv);
        assertNotNull(httpsConfig);

        Map<String, String> validHttpOptInEnv = new HashMap<>(base);
        validHttpOptInEnv.put("TENVYR_REVIEW_WORKER_ALLOW_INSECURE_HTTP", "true");
        validHttpOptInEnv.put("TENVYR_REVIEW_WORKER_RUNNER_URL", "http://127.0.0.1:8080");
        validHttpOptInEnv.put("TENVYR_REVIEW_WORKER_CALLBACK_ORIGINS", "[\"http://127.0.0.1:8080\"]");
        WorkerConfig httpConfig = ReviewWorkerMain.configuration(validHttpOptInEnv);
        assertNotNull(httpConfig);
    }

    @Test
    @DisplayName("Unknown TENVYR_REVIEW_WORKER_MODE throws IllegalArgumentException")
    void unknownModeThrowsException() {
        Map<String, String> env = new HashMap<>(validMockEnv());
        env.put("TENVYR_REVIEW_WORKER_MODE", "UNKNOWN_MODE");
        assertThrows(IllegalArgumentException.class, () -> ReviewWorkerMain.configuration(env));
        assertThrows(IllegalArgumentException.class, () -> ReviewWorkerMain.runner(env));
    }

    @Test
    @DisplayName("MOCK runner returns exact provider mock, model demo-fixture, score 100, and explicit no-analysis finding")
    void mockRunnerReturnsFixedTruthfulDemoReport() throws Exception {
        AgentProcessor.Runner mockRunner = ReviewWorkerMain.runner(validMockEnv());

        JsonNode response = mockRunner.run("prompt template", Json.object("code", "const x = 1;"), 5000);

        assertTrue(response.path("success").asBoolean());
        JsonNode data = response.path("data");
        assertNotNull(data);

        // Metadata assertions
        JsonNode metadata = data.path("metadata");
        assertEquals("mock", metadata.path("provider").asText());
        assertEquals("demo-fixture", metadata.path("model").asText());
        assertEquals("MOCK", metadata.path("mode").asText());
        assertEquals("unavailable", metadata.path("usageSource").asText());
        assertFalse(metadata.path("fallbackUsed").asBoolean());

        // Token counts must be absent
        assertFalse(data.has("promptTokens"), "MOCK fixture must not invent prompt tokens");
        assertFalse(data.has("completionTokens"), "MOCK fixture must not invent completion tokens");
        assertFalse(data.has("totalTokens"), "MOCK fixture must not invent total tokens");

        // Output report assertions
        JsonNode report = Json.parse(data.path("output").asText());
        assertEquals(100, report.path("score").asInt(), "Fixed MOCK report score must be 100");
        assertTrue(report.path("findings").isArray());
        assertTrue(report.path("findings").size() >= 1);
        String findingText = report.path("findings").get(0).asText().toLowerCase();
        assertTrue(findingText.contains("no source") || findingText.contains("no security") || findingText.contains("demo"),
                "Finding must explicitly declare that no security or source analysis occurred");
    }

    @Test
    @DisplayName("MOCK runner is input-independent and produces no false detected vulnerabilities")
    void mockRunnerIsInputIndependentAndDetectsNoVulnerabilities() throws Exception {
        AgentProcessor.Runner mockRunner = ReviewWorkerMain.runner(validMockEnv());

        JsonNode benign = mockRunner.run("prompt", Json.object("code", "function add(a, b) { return a + b; }"), 5000);
        JsonNode exploit = mockRunner.run("prompt", Json.object("code", "eval('rm -rf /'); db.raw('SELECT * FROM ' + table);"), 5000);
        JsonNode empty = mockRunner.run("prompt", Json.object("code", ""), 5000);

        assertEquals(
                benign.path("data").path("output").asText(),
                exploit.path("data").path("output").asText(),
                "Mock outputs must be strictly input-independent"
        );
        assertEquals(
                benign.path("data").path("output").asText(),
                empty.path("data").path("output").asText()
        );

        JsonNode report = Json.parse(exploit.path("data").path("output").asText());
        assertEquals(100, report.path("score").asInt(), "Must not invent false vulnerability scores");
    }

    @Test
    @DisplayName("RUNNER mode augments metadata, preserves truthful fallbackUsed and usageSource, and does not invent provider/model")
    void runnerModeAugmentsMetadataAndPreservesTruthfulFallbackAndUsage() throws Exception {
        Map<String, String> runnerEnv = Map.of(
                "TENVYR_REVIEW_WORKER_MODE", "RUNNER",
                "TENVYR_REVIEW_WORKER_BEARER_TOKEN", "token",
                "TENVYR_REVIEW_WORKER_CALLBACK_KEYS", "{\"k\":\"s\"}",
                "TENVYR_REVIEW_WORKER_CALLBACK_ORIGINS", "[\"https://service.internal\"]",
                "TENVYR_REVIEW_WORKER_RUNNER_URL", "https://runner.internal:8080"
        );

        // Case 1: Delegate reports fallbackUsed = true, usageSource = "estimated", provider = "openai", model = "gpt-4o"
        AgentProcessor.Runner delegateTrueFallback = (prompt, context, timeout) -> Json.object(
                "success", true,
                "data", Json.object(
                        "output", "{\"score\":92,\"findings\":[\"ok\"]}",
                        "promptTokens", 10,
                        "completionTokens", 20,
                        "totalTokens", 30,
                        "metadata", Json.object(
                                "provider", "openai",
                                "model", "gpt-4o",
                                "fallbackUsed", true,
                                "usageSource", "estimated"
                        )
                )
        );

        AgentProcessor.Runner augmentedRunner1 = new StrictReviewRunner(delegateTrueFallback);
        JsonNode resp1 = augmentedRunner1.run("prompt", Json.object(), 1000);
        JsonNode meta1 = resp1.path("data").path("metadata");

        assertEquals("openai", meta1.path("provider").asText());
        assertEquals("gpt-4o", meta1.path("model").asText());
        assertTrue(meta1.path("fallbackUsed").asBoolean(), "Must preserve actual truth: fallbackUsed=true must NOT be forced to false");
        assertEquals("estimated", meta1.path("usageSource").asText());

        // Case 2: Delegate reports fallbackUsed = false, absent provider and model, absent usageSource
        AgentProcessor.Runner delegateAbsentMetadata = (prompt, context, timeout) -> Json.object(
                "success", true,
                "data", Json.object(
                        "output", "{\"score\":100,\"findings\":[]}",
                        "metadata", Json.object(
                                "fallbackUsed", false
                        )
                )
        );

        AgentProcessor.Runner augmentedRunner2 = new StrictReviewRunner(delegateAbsentMetadata);
        JsonNode resp2 = augmentedRunner2.run("prompt", Json.object(), 1000);
        JsonNode meta2 = resp2.path("data").path("metadata");

        assertFalse(meta2.path("fallbackUsed").asBoolean());
        assertEquals("unavailable", meta2.path("usageSource").asText("unavailable"), "Absent usageSource defaults to unavailable");
        assertFalse(meta2.has("provider"), "Absent provider must remain absent, not invented");
        assertFalse(meta2.has("model"), "Absent model must remain absent, not invented");
    }

    @Test
    @DisplayName("Configured RUNNER mode failure never falls back silently to MOCK")
    void configuredRunnerFailureNeverFallsBackToMock() {
        AgentProcessor.Runner failingRunner = new StrictReviewRunner((prompt, context, timeout) -> {
            throw new IOException("Target runner unreachable");
        });

        assertThrows(IOException.class, () -> failingRunner.run("prompt", Json.object(), 1000),
                "Runner failure must propagate directly and never silently fall back to MOCK");
    }
}
