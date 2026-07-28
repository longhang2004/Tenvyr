package com.agentweave.runner.service;

import com.agentweave.runner.model.RunRequest;
import com.agentweave.runner.model.RunResponse;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.test.util.ReflectionTestUtils;

import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doReturn;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;

@ExtendWith(OutputCaptureExtension.class)
class LlmServiceTest {

    private RunRequest sampleRequest() {
        RunRequest request = new RunRequest();
        request.setPromptTemplate("Security audit agent: review {{code}} for code safety");
        request.setContext(Map.of("code", "const safe = true;"));
        return request;
    }

    private ServiceFixture service(String provider, String failureMode) {
        LlmService service = new LlmService();
        HttpClient httpClient = mock(HttpClient.class);
        ReflectionTestUtils.setField(service, "httpClient", httpClient);
        ReflectionTestUtils.setField(service, "llmProvider", provider);
        ReflectionTestUtils.setField(service, "llmFailureMode", failureMode);
        ReflectionTestUtils.setField(service, "openaiApiKey", "sk-openai-test");
        ReflectionTestUtils.setField(service, "openaiModel", "openai-test-model");
        ReflectionTestUtils.setField(service, "anthropicApiKey", "sk-ant-test");
        ReflectionTestUtils.setField(service, "anthropicModel", "anthropic-test-model");
        ReflectionTestUtils.setField(service, "ollamaApiUrl", "http://ollama.test:11434");
        ReflectionTestUtils.setField(service, "ollamaModel", "ollama-test-model");
        return new ServiceFixture(service, httpClient);
    }

    @SuppressWarnings({"rawtypes", "unchecked"})
    private void respond(HttpClient client, int status, String body) throws Exception {
        HttpResponse<String> response = mock(HttpResponse.class);
        doReturn(status).when(response).statusCode();
        doReturn(body).when(response).body();
        doReturn(response).when(client).send(any(HttpRequest.class), any(HttpResponse.BodyHandler.class));
    }

    private void assertMetadata(
        RunResponse response,
        String provider,
        String model,
        boolean fallbackUsed
    ) {
        assertThat(response.getMetadata()).containsEntry("provider", provider);
        assertThat(response.getMetadata()).containsEntry("model", model);
        assertThat(response.getMetadata()).containsEntry("fallbackUsed", fallbackUsed);
        assertThat(response.getMetadata()).containsEntry("usageSource", "estimated");
        assertThat(response.getTotalTokens())
            .isEqualTo(response.getPromptTokens() + response.getCompletionTokens());
    }

    @Test
    void defaultConfigurationUsesDeterministicMockWithoutNetwork() {
        ServiceFixture fixture = service(null, null);

        RunResponse response = fixture.service().execute(sampleRequest());

        assertMetadata(response, "mock", "local-heuristic", true);
        assertThat(response.getMetadata()).doesNotContainKey("requestedProvider");
        verifyNoInteractions(fixture.httpClient());
    }

    @Test
    void selectsOpenAiAndReportsConfiguredModel() throws Exception {
        ServiceFixture fixture = service(" OPENAI ", null);
        respond(fixture.httpClient(), 200, "{\"choices\":[{\"message\":{\"content\":\"openai output\"}}]}");

        RunResponse response = fixture.service().execute(sampleRequest());

        assertThat(response.getOutput()).isEqualTo("openai output");
        assertMetadata(response, "openai", "openai-test-model", false);
    }

    @Test
    void selectsAnthropicAndReportsConfiguredModel() throws Exception {
        ServiceFixture fixture = service("anthropic", "fail");
        respond(fixture.httpClient(), 200, "{\"content\":[{\"text\":\"anthropic output\"}]}");

        RunResponse response = fixture.service().execute(sampleRequest());

        assertThat(response.getOutput()).isEqualTo("anthropic output");
        assertMetadata(response, "anthropic", "anthropic-test-model", false);
    }

    @Test
    void selectsOllamaAndReportsConfiguredModel() throws Exception {
        ServiceFixture fixture = service("ollama", "fail");
        respond(fixture.httpClient(), 200, "{\"response\":\"ollama output\"}");

        RunResponse response = fixture.service().execute(sampleRequest());

        assertThat(response.getOutput()).isEqualTo("ollama output");
        assertMetadata(response, "ollama", "ollama-test-model", false);
    }

    @Test
    void rejectsUnsupportedProviderEvenWhenMockFailureModeWasRequested() {
        ServiceFixture fixture = service("unknown", "mock");

        assertThatThrownBy(() -> fixture.service().execute(sampleRequest()))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessage("Unsupported LLM_PROVIDER. Expected mock, openai, anthropic, or ollama.");
        verifyNoInteractions(fixture.httpClient());
    }

    @Test
    void rejectsUnsupportedFailureModeEvenForMockProvider() {
        ServiceFixture fixture = service("mock", "fallback");

        assertThatThrownBy(() -> fixture.service().execute(sampleRequest()))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessage("Unsupported LLM_FAILURE_MODE. Expected fail or mock.");
        verifyNoInteractions(fixture.httpClient());
    }

    @ParameterizedTest
    @ValueSource(strings = {"", "   ", "your-openai-api-key-here", "changeme"})
    void missingOrPlaceholderCredentialFailsByDefaultForRealProvider(String credential) {
        ServiceFixture fixture = service("openai", null);
        ReflectionTestUtils.setField(fixture.service(), "openaiApiKey", credential);

        assertThatThrownBy(() -> fixture.service().execute(sampleRequest()))
            .isInstanceOf(IllegalStateException.class)
            .hasMessage("LLM provider call failed for openai");
        verifyNoInteractions(fixture.httpClient());
    }

    @Test
    void explicitMockFailureModeFallsBackAndIdentifiesRequestedProvider() {
        ServiceFixture fixture = service("anthropic", "mock");
        ReflectionTestUtils.setField(fixture.service(), "anthropicApiKey", "");

        RunResponse response = fixture.service().execute(sampleRequest());

        assertMetadata(response, "mock", "local-heuristic", true);
        assertThat(response.getMetadata()).containsEntry("requestedProvider", "anthropic");
        verifyNoInteractions(fixture.httpClient());
    }

    @Test
    void blankModelFailsForRealProviderByDefault() {
        ServiceFixture fixture = service("ollama", null);
        ReflectionTestUtils.setField(fixture.service(), "ollamaModel", "   ");

        assertThatThrownBy(() -> fixture.service().execute(sampleRequest()))
            .isInstanceOf(IllegalStateException.class)
            .hasMessage("LLM provider call failed for ollama");
        verifyNoInteractions(fixture.httpClient());
    }

    @Test
    void providerErrorFailsWithoutLoggingSecretOrResponseBody(CapturedOutput output) throws Exception {
        ServiceFixture fixture = service("openai", "fail");
        ReflectionTestUtils.setField(fixture.service(), "openaiApiKey", "TOP_SECRET_KEY");
        respond(fixture.httpClient(), 401, "TOP_SECRET_RESPONSE_BODY");

        assertThatThrownBy(() -> fixture.service().execute(sampleRequest()))
            .isInstanceOf(IllegalStateException.class)
            .hasMessage("LLM provider call failed for openai")
            .hasMessageNotContaining("TOP_SECRET");
        assertThat(output.getAll()).doesNotContain("TOP_SECRET_KEY", "TOP_SECRET_RESPONSE_BODY");
    }

    @Test
    void providerErrorUsesExplicitMockFallbackWithSanitizedLog(CapturedOutput output) throws Exception {
        ServiceFixture fixture = service("openai", "mock");
        ReflectionTestUtils.setField(fixture.service(), "openaiApiKey", "TOP_SECRET_KEY");
        respond(fixture.httpClient(), 429, "TOP_SECRET_RESPONSE_BODY");

        RunResponse response = fixture.service().execute(sampleRequest());

        assertMetadata(response, "mock", "local-heuristic", true);
        assertThat(response.getMetadata()).containsEntry("requestedProvider", "openai");
        assertThat(output.getAll())
            .contains("LLM provider call failed for openai")
            .doesNotContain("TOP_SECRET_KEY", "TOP_SECRET_RESPONSE_BODY");
    }

    private record ServiceFixture(LlmService service, HttpClient httpClient) {}
}
