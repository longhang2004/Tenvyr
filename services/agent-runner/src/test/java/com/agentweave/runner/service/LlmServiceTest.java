package com.agentweave.runner.service;

import com.agentweave.runner.model.RunRequest;
import com.agentweave.runner.model.RunResponse;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.test.util.ReflectionTestUtils;

import java.net.http.HttpClient;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;

/**
 * Plain JUnit 5 unit test (no Spring context) for {@link LlmService}'s Local_Fallback behavior.
 *
 * Feature: agentweave-verification-hardening, Property 3: Placeholder or blank credentials always produce an offline Local_Fallback
 *
 * Validates: Requirements 3.3
 *
 * The {@code httpClient} field is replaced with a Mockito mock so that any (unexpected) outbound
 * provider call is both offline and observable: {@code verifyNoInteractions} proves the provider
 * branch was never taken (R3.5 offline guarantee) because {@code hasCredential} returns false for
 * blank, whitespace-only, and placeholder credentials.
 */
class LlmServiceTest {

    private RunRequest sampleRequest() {
        RunRequest request = new RunRequest();
        request.setPromptTemplate("Security audit agent: review the following code for code safety");
        request.setContext(Map.of(
            "code", "const q = 'SELECT * FROM users WHERE id=' + id;",
            "language", "typescript"
        ));
        return request;
    }

    private void assertOfflineLocalFallback(RunResponse response, HttpClient httpClient) {
        // A non-null Local_Fallback heuristic response is returned.
        assertThat(response).isNotNull();
        assertThat(response.getOutput()).isNotBlank();

        // Positive token counts, with the documented totalTokens invariant.
        assertThat(response.getPromptTokens()).isPositive();
        assertThat(response.getCompletionTokens()).isPositive();
        assertThat(response.getTotalTokens()).isPositive();
        assertThat(response.getTotalTokens())
            .isEqualTo(response.getPromptTokens() + response.getCompletionTokens());

        // No outbound provider HTTP call occurred: the fallback branch was taken.
        verifyNoInteractions(httpClient);
    }

    @ParameterizedTest(name = "openai credential [{0}] -> offline Local_Fallback")
    @ValueSource(strings = {
        "",                          // blank
        "   ",                       // whitespace-only
        "your-openai-api-key-here",  // placeholder ("your-" + "api-key-here")
        "sk-test-api-key-here-0000", // contains "api-key-here"
        "changeme",                  // exact placeholder
        "Your-Key",                  // mixed-case "your-"
        "CHANGEME"                   // mixed-case "changeme"
    })
    void placeholderOrBlankOpenAiCredentialProducesOfflineFallback(String credential) {
        LlmService service = new LlmService();
        HttpClient httpClient = mock(HttpClient.class);
        ReflectionTestUtils.setField(service, "httpClient", httpClient);
        ReflectionTestUtils.setField(service, "llmProvider", "openai");
        ReflectionTestUtils.setField(service, "openaiApiKey", credential);

        RunResponse response = service.execute(sampleRequest());

        assertOfflineLocalFallback(response, httpClient);
    }

    @ParameterizedTest(name = "anthropic credential [{0}] -> offline Local_Fallback")
    @ValueSource(strings = {
        "",                             // blank
        "   ",                          // whitespace-only
        "your-anthropic-api-key-here",  // placeholder ("your-" + "api-key-here")
        "sk-ant-api-key-here-0000",     // contains "api-key-here"
        "changeme",                     // exact placeholder
        "Your-Key",                     // mixed-case "your-"
        "CHANGEME"                      // mixed-case "changeme"
    })
    void placeholderOrBlankAnthropicCredentialProducesOfflineFallback(String credential) {
        LlmService service = new LlmService();
        HttpClient httpClient = mock(HttpClient.class);
        ReflectionTestUtils.setField(service, "httpClient", httpClient);
        ReflectionTestUtils.setField(service, "llmProvider", "anthropic");
        ReflectionTestUtils.setField(service, "anthropicApiKey", credential);

        RunResponse response = service.execute(sampleRequest());

        assertOfflineLocalFallback(response, httpClient);
    }
}
