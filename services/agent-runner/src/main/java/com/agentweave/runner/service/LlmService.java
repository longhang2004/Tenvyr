package com.agentweave.runner.service;

import com.agentweave.runner.model.RunRequest;
import com.agentweave.runner.model.RunResponse;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

@Service
public class LlmService {

    private static final ObjectMapper OBJECT_MAPPER = new ObjectMapper();

    @Value("${LLM_PROVIDER:openai}")
    private String llmProvider;

    @Value("${OPENAI_API_KEY:}")
    private String openaiApiKey;

    @Value("${OPENAI_MODEL:gpt-4o-mini}")
    private String openaiModel;

    @Value("${ANTHROPIC_API_KEY:}")
    private String anthropicApiKey;

    @Value("${ANTHROPIC_MODEL:claude-3-5-haiku-latest}")
    private String anthropicModel;

    @Value("${OLLAMA_API_URL:http://localhost:11434}")
    private String ollamaApiUrl;

    @Value("${OLLAMA_MODEL:llama3.1}")
    private String ollamaModel;

    private final HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .build();

    public RunResponse execute(RunRequest request) {
        Map<String, Object> context = request.getContext() != null ? request.getContext() : Map.of();
        String prompt = resolvePromptTemplate(request.getPromptTemplate(), context);

        System.out.println("Processing prompt: " + prompt.substring(0, Math.min(prompt.length(), 200)) + "...");

        String output = executeProviderOrFallback(prompt, context);
        int promptTokens = estimateTokens(prompt);
        int completionTokens = estimateTokens(output);

        return new RunResponse(
            output,
            promptTokens,
            completionTokens,
            promptTokens + completionTokens
        );
    }

    private String executeProviderOrFallback(String prompt, Map<String, Object> context) {
        String provider = llmProvider != null ? llmProvider.trim().toLowerCase() : "mock";

        try {
            if ("openai".equals(provider) && hasCredential(openaiApiKey)) {
                return callOpenAi(prompt);
            }
            if ("anthropic".equals(provider) && hasCredential(anthropicApiKey)) {
                return callAnthropic(prompt);
            }
            if ("ollama".equals(provider)) {
                return callOllama(prompt);
            }
        } catch (Exception ex) {
            System.err.println("LLM provider call failed. Falling back to local heuristic response: " + ex.getMessage());
        }

        return generateMockResponse(prompt, context);
    }

    private String callOpenAi(String prompt) throws Exception {
        Map<String, Object> body = Map.of(
            "model", openaiModel,
            "messages", List.of(Map.of("role", "user", "content", prompt)),
            "temperature", 0.2
        );

        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create("https://api.openai.com/v1/chat/completions"))
                .timeout(Duration.ofSeconds(60))
                .header("Content-Type", "application/json")
                .header("Authorization", "Bearer " + openaiApiKey)
                .POST(HttpRequest.BodyPublishers.ofString(OBJECT_MAPPER.writeValueAsString(body)))
                .build();

        JsonNode json = sendJsonRequest(request);
        JsonNode content = json.at("/choices/0/message/content");
        if (content.isMissingNode() || content.asText().isBlank()) {
            throw new IllegalStateException("OpenAI response did not include message content");
        }
        return content.asText();
    }

    private String callAnthropic(String prompt) throws Exception {
        Map<String, Object> body = Map.of(
            "model", anthropicModel,
            "max_tokens", 1200,
            "messages", List.of(Map.of("role", "user", "content", prompt))
        );

        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create("https://api.anthropic.com/v1/messages"))
                .timeout(Duration.ofSeconds(60))
                .header("Content-Type", "application/json")
                .header("x-api-key", anthropicApiKey)
                .header("anthropic-version", "2023-06-01")
                .POST(HttpRequest.BodyPublishers.ofString(OBJECT_MAPPER.writeValueAsString(body)))
                .build();

        JsonNode json = sendJsonRequest(request);
        JsonNode content = json.at("/content/0/text");
        if (content.isMissingNode() || content.asText().isBlank()) {
            throw new IllegalStateException("Anthropic response did not include text content");
        }
        return content.asText();
    }

    private String callOllama(String prompt) throws Exception {
        String baseUrl = ollamaApiUrl.endsWith("/") ? ollamaApiUrl.substring(0, ollamaApiUrl.length() - 1) : ollamaApiUrl;
        Map<String, Object> body = Map.of(
            "model", ollamaModel,
            "prompt", prompt,
            "stream", false
        );

        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(baseUrl + "/api/generate"))
                .timeout(Duration.ofSeconds(120))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(OBJECT_MAPPER.writeValueAsString(body)))
                .build();

        JsonNode json = sendJsonRequest(request);
        JsonNode response = json.get("response");
        if (response == null || response.asText().isBlank()) {
            throw new IllegalStateException("Ollama response did not include generated text");
        }
        return response.asText();
    }

    private JsonNode sendJsonRequest(HttpRequest request) throws Exception {
        HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() < 200 || response.statusCode() >= 300) {
            throw new IllegalStateException("Provider returned HTTP " + response.statusCode() + ": " + response.body());
        }
        return OBJECT_MAPPER.readTree(response.body());
    }

    private String generateMockResponse(String prompt, Map<String, Object> context) {
        String lowerPrompt = prompt.toLowerCase();

        if (lowerPrompt.contains("security audit agent") || lowerPrompt.contains("code safety")) {
            return generateSecurityReview(context);
        }

        if (lowerPrompt.contains("operations diagnostic agent") || lowerPrompt.contains("observability")) {
            return generateObservabilityReview(context);
        }

        return "Hello! I am the AgentWeave LLM Runner. Prompt received: " + prompt;
    }

    private String generateSecurityReview(Map<String, Object> context) {
        String codeSegment = asString(context.get("code"));
        String lowerCode = codeSegment.toLowerCase();

        boolean hasSqlInjection = lowerCode.contains("select")
                && (lowerCode.contains(" + ") || lowerCode.contains("${") || lowerCode.contains("`"));
        boolean hasSecrets = lowerCode.contains("sk_live")
                || codeSegment.contains("AKIA")
                || lowerCode.contains("api_key")
                || lowerCode.contains("secret");
        boolean hasMissingJwt = codeSegment.contains("@Controller") && !codeSegment.contains("@UseGuards");

        StringBuilder findings = new StringBuilder();
        int score = 100;

        if (hasSqlInjection) {
            score -= 25;
            findings.append("\"Found direct string interpolation or concatenation in a database query. Risk of SQL injection. Recommend parameterized queries.\",");
        }
        if (hasSecrets) {
            score -= 30;
            findings.append("\"Hardcoded authentication credentials or API keys found in source. Recommend loading secrets from the runtime environment.\",");
        }
        if (hasMissingJwt) {
            score -= 15;
            findings.append("\"Routes inside Controller do not have JWT auth guards configured. Route may be exposed publicly.\",");
        }

        if (findings.length() > 0) {
            findings.setLength(findings.length() - 1);
        } else {
            findings.append("\"No critical security vulnerabilities found. Code conforms to basic security guidelines.\"");
        }

        return "{\n" +
                "  \"score\": " + score + ",\n" +
                "  \"findings\": [" + findings + "]\n" +
                "}";
    }

    private String generateObservabilityReview(Map<String, Object> context) {
        String findings = asString(context.get("findings"));
        String logs = asString(context.get("logs"));
        String lowerFindings = findings.toLowerCase();
        String lowerLogs = logs.toLowerCase();

        boolean degraded = lowerFindings.contains("sql injection")
                || lowerFindings.contains("hardcoded")
                || lowerLogs.contains("error")
                || lowerLogs.contains("timeout")
                || lowerLogs.contains("critical");
        String status = lowerLogs.contains("critical") ? "CRITICAL" : degraded ? "DEGRADED" : "HEALTHY";
        String analysis = degraded
                ? "Correlated review findings and runtime logs indicate degraded pipeline health. Prioritize database query hardening and timeout investigation."
                : "System performance health is within normal thresholds. Latency metrics are nominal.";

        return "{\n" +
                "  \"status\": \"" + status + "\",\n" +
                "  \"analysis\": \"" + analysis + "\",\n" +
                "  \"latencySec\": " + (degraded ? 5 : 1) + "\n" +
                "}";
    }

    private String resolvePromptTemplate(String template, Map<String, Object> context) {
        if (template == null || template.isBlank()) {
            return "";
        }

        Pattern pattern = Pattern.compile("\\{\\{\\s*([a-zA-Z0-9_.-]+)\\s*\\}\\}");
        Matcher matcher = pattern.matcher(template);

        StringBuffer sb = new StringBuffer();
        while (matcher.find()) {
            String key = matcher.group(1);
            Object value = getNestedValue(context, key);
            String replacement = value != null ? value.toString() : "";
            matcher.appendReplacement(sb, Matcher.quoteReplacement(replacement));
        }
        matcher.appendTail(sb);
        return sb.toString();
    }

    private Object getNestedValue(Map<String, Object> context, String path) {
        String[] parts = path.split("\\.");
        Object current = context;

        for (String part : parts) {
            if (!(current instanceof Map<?, ?> currentMap)) {
                return null;
            }
            current = currentMap.get(part);
        }

        return current;
    }

    private boolean hasCredential(String value) {
        if (value == null || value.isBlank()) return false;
        String lowerValue = value.toLowerCase();
        return !lowerValue.contains("your-") && !lowerValue.contains("api-key-here") && !lowerValue.equals("changeme");
    }

    private String asString(Object value) {
        return value == null ? "" : value.toString();
    }

    private int estimateTokens(String text) {
        return Math.max(1, text.length() / 4);
    }
}
