package com.agentweave.runner.controller;

import com.agentweave.runner.model.RunRequest;
import com.agentweave.runner.model.RunResponse;
import com.agentweave.runner.service.LlmService;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

import java.util.Map;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * Web-slice tests for {@link RunnerController}'s {@code POST /api/run} endpoint.
 *
 * <p>Uses {@code @WebMvcTest} so only the controller is loaded with a mocked
 * {@link LlmService}. Under this slice no {@code KafkaTemplate} bean exists, and because
 * the controller injects it with {@code @Autowired(required = false)} it stays {@code null};
 * therefore no Kafka broker is required and the test runs fully offline.</p>
 */
@WebMvcTest(RunnerController.class)
class RunnerControllerTest {

    @Autowired
    private MockMvc mockMvc;

    @MockBean
    private LlmService llmService;

    @Test
    void runEndpointReturnsOutputAndTokenCounts() throws Exception {
        int promptTokens = 12;
        int completionTokens = 30;
        int totalTokens = promptTokens + completionTokens;
        RunResponse stubbed = new RunResponse(
            "Hello! I am the Tenvyr LLM Runner.",
            promptTokens,
            completionTokens,
            totalTokens,
            Map.of(
                "provider", "mock",
                "model", "local-heuristic",
                "fallbackUsed", true,
                "usageSource", "estimated"
            )
        );
        when(llmService.execute(any(RunRequest.class))).thenReturn(stubbed);

        String requestBody = "{"
            + "\"promptTemplate\":\"Summarize the request\","
            + "\"context\":{\"executionId\":\"exec-1\"}"
            + "}";

        mockMvc.perform(post("/api/run")
                .contentType(MediaType.APPLICATION_JSON)
                .content(requestBody))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.success").value(true))
            .andExpect(jsonPath("$.data.output").exists())
            .andExpect(jsonPath("$.data.output").value(stubbed.getOutput()))
            .andExpect(jsonPath("$.data.promptTokens").value(promptTokens))
            .andExpect(jsonPath("$.data.completionTokens").value(completionTokens))
            .andExpect(jsonPath("$.data.totalTokens").value(totalTokens))
            .andExpect(jsonPath("$.data.totalTokens")
                .value(promptTokens + completionTokens))
            .andExpect(jsonPath("$.data.metadata.provider").value("mock"))
            .andExpect(jsonPath("$.data.metadata.model").value("local-heuristic"))
            .andExpect(jsonPath("$.data.metadata.fallbackUsed").value(true))
            .andExpect(jsonPath("$.data.metadata.usageSource").value("estimated"));
    }
}
