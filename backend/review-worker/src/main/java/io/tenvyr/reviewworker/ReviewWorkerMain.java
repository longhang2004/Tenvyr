package io.tenvyr.reviewworker;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.tenvyr.agents.AgentProcessor;
import io.tenvyr.agents.ReviewReportContract;
import io.tenvyr.platform.Json;
import io.tenvyr.worker.Worker;
import io.tenvyr.worker.WorkerConfig;

import java.net.URI;
import java.net.URISyntaxException;
import java.nio.file.Path;
import java.util.*;

/**
 * Entry point and factory for the strict asynchronous code-reviewer HTTP Worker.
 * Binds environment configuration, sets fixed worker bounds, constructs truthful
 * MOCK/RUNNER delegates, and hosts the Worker runtime.
 */
public final class ReviewWorkerMain {

    public static final String AGENT_NAME = "code-reviewer";
    public static final int FIXED_CONCURRENCY = 2;
    public static final int FIXED_MAX_QUEUED_RUNS = 16;
    public static final int FIXED_MAX_REQUEST_BYTES = 1_048_576; // 1 MiB
    public static final int FIXED_MAX_RESPONSE_BYTES = 65_536;
    public static final int FIXED_RUNNER_MAX_RESPONSE_BYTES = 1_048_576; // 1 MiB runner response bound

    private ReviewWorkerMain() {}

    public static WorkerConfig configuration(Map<String, String> env) {
        Objects.requireNonNull(env, "env map is required");
        WorkerConfig config = new WorkerConfig();
        config.agentName = AGENT_NAME;
        config.concurrency = FIXED_CONCURRENCY;
        config.maxQueuedRuns = FIXED_MAX_QUEUED_RUNS;
        config.maxRequestBytes = FIXED_MAX_REQUEST_BYTES;
        config.maxResponseBytes = FIXED_MAX_RESPONSE_BYTES;

        // Insecure HTTP opt-in check: exact case-sensitive "true"
        String allowHttpRaw = env.get("TENVYR_REVIEW_WORKER_ALLOW_INSECURE_HTTP");
        if (allowHttpRaw != null) {
            if (!"true".equals(allowHttpRaw)) {
                throw new IllegalArgumentException("TENVYR_REVIEW_WORKER_ALLOW_INSECURE_HTTP must be exactly 'true' if provided: " + allowHttpRaw);
            }
            config.allowInsecureHttp = true;
        } else {
            config.allowInsecureHttp = false;
        }

        // Bearer token: required, non-blank
        String bearer = env.get("TENVYR_REVIEW_WORKER_BEARER_TOKEN");
        if (bearer == null || bearer.isBlank()) {
            throw new IllegalArgumentException("TENVYR_REVIEW_WORKER_BEARER_TOKEN is required and must not be blank");
        }
        config.bearerToken = bearer.trim();

        // Callback keys: required non-empty JSON object of string -> string
        String keysRaw = env.get("TENVYR_REVIEW_WORKER_CALLBACK_KEYS");
        if (keysRaw == null || keysRaw.isBlank()) {
            throw new IllegalArgumentException("TENVYR_REVIEW_WORKER_CALLBACK_KEYS is required");
        }
        JsonNode keysNode;
        try {
            keysNode = Json.parse(keysRaw);
        } catch (Exception e) {
            throw new IllegalArgumentException("TENVYR_REVIEW_WORKER_CALLBACK_KEYS is not valid JSON", e);
        }
        if (!keysNode.isObject() || keysNode.isEmpty()) {
            throw new IllegalArgumentException("TENVYR_REVIEW_WORKER_CALLBACK_KEYS must be a non-empty JSON object");
        }
        Map<String, String> callbackKeys = new HashMap<>();
        Iterator<Map.Entry<String, JsonNode>> fieldIt = keysNode.fields();
        while (fieldIt.hasNext()) {
            Map.Entry<String, JsonNode> entry = fieldIt.next();
            String keyId = entry.getKey();
            JsonNode val = entry.getValue();
            if (keyId.isBlank() || !val.isTextual() || val.asText().isBlank()) {
                throw new IllegalArgumentException("Callback keys must have non-blank keys and non-blank string values");
            }
            callbackKeys.put(keyId, val.asText());
        }
        config.callbackKeys = Map.copyOf(callbackKeys);

        // Callback origins: required non-empty JSON array of strings
        String originsRaw = env.get("TENVYR_REVIEW_WORKER_CALLBACK_ORIGINS");
        if (originsRaw == null || originsRaw.isBlank()) {
            throw new IllegalArgumentException("TENVYR_REVIEW_WORKER_CALLBACK_ORIGINS is required");
        }
        JsonNode originsNode;
        try {
            originsNode = Json.parse(originsRaw);
        } catch (Exception e) {
            throw new IllegalArgumentException("TENVYR_REVIEW_WORKER_CALLBACK_ORIGINS is not valid JSON", e);
        }
        if (!originsNode.isArray() || originsNode.isEmpty()) {
            throw new IllegalArgumentException("TENVYR_REVIEW_WORKER_CALLBACK_ORIGINS must be a non-empty JSON array");
        }
        List<String> origins = new ArrayList<>();
        for (JsonNode item : originsNode) {
            if (!item.isTextual() || item.asText().isBlank()) {
                throw new IllegalArgumentException("Callback origin item must be a non-blank string");
            }
            String originStr = item.asText();
            parseOrigin(originStr, config.allowInsecureHttp);
            origins.add(originStr);
        }
        config.allowedOrigins = List.copyOf(origins);

        // Mode validation
        String mode = env.getOrDefault("TENVYR_REVIEW_WORKER_MODE", "MOCK");
        if (mode == null || mode.isBlank()) {
            mode = "MOCK";
        }
        if (!"MOCK".equals(mode) && !"RUNNER".equals(mode)) {
            throw new IllegalArgumentException("Unknown TENVYR_REVIEW_WORKER_MODE: " + mode);
        }
        if ("RUNNER".equals(mode)) {
            validateRunnerUrl(env.get("TENVYR_REVIEW_WORKER_RUNNER_URL"), config.allowInsecureHttp);
        }

        return config;
    }

    public static AgentProcessor.Runner runner(Map<String, String> env) {
        Objects.requireNonNull(env, "env map is required");
        String mode = env.getOrDefault("TENVYR_REVIEW_WORKER_MODE", "MOCK");
        if (mode == null || mode.isBlank()) {
            mode = "MOCK";
        }
        if ("MOCK".equals(mode)) {
            return (prompt, context, timeout) -> Json.object(
                    "success", true,
                    "data", Json.object(
                            "output", Json.stringify(Json.object(
                                    "score", 100,
                                    "findings", Json.array("Demonstration fixture: no source code or security analysis was performed.")
                            )),
                            "metadata", Json.object(
                                    "provider", "mock",
                                    "model", "demo-fixture",
                                    "mode", "MOCK",
                                    "usageSource", "unavailable",
                                    "fallbackUsed", false
                            )
                    )
            );
        } else if ("RUNNER".equals(mode)) {
            boolean allowHttp = "true".equals(env.get("TENVYR_REVIEW_WORKER_ALLOW_INSECURE_HTTP"));
            String runnerUrl = env.get("TENVYR_REVIEW_WORKER_RUNNER_URL");
            validateRunnerUrl(runnerUrl, allowHttp);
            AgentProcessor.Runner rawRunner = AgentProcessor.httpRunner(runnerUrl, FIXED_RUNNER_MAX_RESPONSE_BYTES);
            return new StrictReviewRunner(rawRunner, "RUNNER");
        } else {
            throw new IllegalArgumentException("Unknown TENVYR_REVIEW_WORKER_MODE: " + mode);
        }
    }

    public static Worker create(WorkerConfig config, AgentProcessor.Runner runner) {
        Objects.requireNonNull(config, "WorkerConfig is required");
        Objects.requireNonNull(runner, "AgentProcessor.Runner is required");

        AgentProcessor.Runner strictRunner = runner instanceof StrictReviewRunner s ? s : new StrictReviewRunner(runner);
        Path skillsPath = Path.of(System.getenv().getOrDefault("TENVYR_SKILLS_DIR", "skills"));
        AgentProcessor processor = new AgentProcessor(AGENT_NAME, skillsPath, strictRunner);

        Worker.Agent agent = (context, input) -> {
            ObjectNode result = processor.process(context.invocation);
            String status = result.path("status").asText();
            if ("succeeded".equals(status)) {
                JsonNode output = result.get("output");
                ReviewReportContract.requireOutput(output);
                return context.success(output, result.get("usage"), null, result.get("metadata"));
            } else if ("timed_out".equals(status)) {
                boolean retryable = result.path("error").path("retryable").asBoolean(true);
                String message = result.path("error").path("message").asText("Agent execution timed out");
                return context.fail("AGENT_TIMED_OUT", message, retryable);
            } else {
                boolean retryable = result.path("error").path("retryable").asBoolean(false);
                String code = result.path("error").path("code").asText("AGENT_EXECUTION_FAILED");
                String message = result.path("error").path("message").asText("Agent execution failed");
                return context.fail(code, message, retryable);
            }
        };

        return new Worker(config, agent);
    }

    public static void main(String[] args) throws Exception {
        Map<String, String> env = System.getenv();
        WorkerConfig config = configuration(env);
        AgentProcessor.Runner r = runner(env);
        Worker worker = create(config, r);
        String host = env.getOrDefault("TENVYR_REVIEW_WORKER_HOST", "127.0.0.1");
        int port = Integer.parseInt(env.getOrDefault("PORT", env.getOrDefault("TENVYR_REVIEW_WORKER_PORT", "3004")));
        worker.start(host, port);
        Runtime.getRuntime().addShutdownHook(new Thread(worker::close));
        System.out.println("ReviewWorker listening on http://" + host + ":" + port);
    }

    static URI parseOrigin(String value, boolean allowHttp) {
        URI uri;
        try {
            uri = new URI(value);
        } catch (URISyntaxException e) {
            throw new IllegalArgumentException("Invalid origin URL syntax: " + value, e);
        }
        String scheme = uri.getScheme();
        if (scheme == null) {
            throw new IllegalArgumentException("Origin URL missing scheme: " + value);
        }
        if (!"https".equalsIgnoreCase(scheme) && (!allowHttp || !"http".equalsIgnoreCase(scheme))) {
            throw new IllegalArgumentException("Origin must use https (or http if allowInsecureHttp): " + value);
        }
        if (uri.getHost() == null) {
            throw new IllegalArgumentException("Origin missing host: " + value);
        }
        if (uri.getRawUserInfo() != null) {
            throw new IllegalArgumentException("Origin cannot contain userinfo: " + value);
        }
        if (uri.getRawQuery() != null) {
            throw new IllegalArgumentException("Origin cannot contain query: " + value);
        }
        if (uri.getRawFragment() != null) {
            throw new IllegalArgumentException("Origin cannot contain fragment: " + value);
        }
        String path = uri.getRawPath();
        if (path != null && !path.isEmpty() && !path.equals("/")) {
            throw new IllegalArgumentException("Origin cannot contain path: " + value);
        }
        return uri;
    }

    static URI validateRunnerUrl(String runnerUrl, boolean allowInsecureHttp) {
        if (runnerUrl == null || runnerUrl.isBlank()) {
            throw new IllegalArgumentException("TENVYR_REVIEW_WORKER_RUNNER_URL is required in RUNNER mode");
        }
        URI uri;
        try {
            uri = new URI(runnerUrl);
        } catch (URISyntaxException e) {
            throw new IllegalArgumentException("Invalid runner URL syntax: " + runnerUrl, e);
        }
        String scheme = uri.getScheme();
        if (scheme == null) {
            throw new IllegalArgumentException("Runner URL missing scheme: " + runnerUrl);
        }
        if (!"https".equalsIgnoreCase(scheme) && (!allowInsecureHttp || !"http".equalsIgnoreCase(scheme))) {
            throw new IllegalArgumentException("Runner URL must use https (or http if allowInsecureHttp): " + runnerUrl);
        }
        if (uri.getHost() == null) {
            throw new IllegalArgumentException("Runner URL must have a host: " + runnerUrl);
        }
        if (uri.getRawUserInfo() != null) {
            throw new IllegalArgumentException("Runner URL cannot contain userinfo: " + runnerUrl);
        }
        if (uri.getRawQuery() != null) {
            throw new IllegalArgumentException("Runner URL cannot contain query: " + runnerUrl);
        }
        if (uri.getRawFragment() != null) {
            throw new IllegalArgumentException("Runner URL cannot contain fragment: " + runnerUrl);
        }
        String path = uri.getRawPath();
        if (path != null && !path.isEmpty() && !path.equals("/")) {
            throw new IllegalArgumentException("Runner URL cannot contain a path: " + runnerUrl);
        }
        return uri;
    }
}
