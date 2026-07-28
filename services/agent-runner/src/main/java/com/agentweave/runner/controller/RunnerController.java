package com.agentweave.runner.controller;

import com.agentweave.runner.model.RunRequest;
import com.agentweave.runner.model.RunResponse;
import com.agentweave.runner.service.LlmService;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import java.time.Instant;
import java.util.HashMap;
import java.util.Map;

@RestController
public class RunnerController {

    @Autowired
    private LlmService llmService;

    @Autowired(required = false)
    private KafkaTemplate<String, String> kafkaTemplate;

    @PostMapping("/api/run")
    public Map<String, Object> run(@RequestBody RunRequest request) {
        Map<String, Object> response = new HashMap<>();
        Map<String, Object> meta = new HashMap<>();

        try {
            RunResponse runResponse = llmService.execute(request);

            // Publish token usage analytics to Kafka if template is active
            if (kafkaTemplate != null) {
                try {
                    Map<String, Object> analytics = new HashMap<>();
                    analytics.put("promptTokens", runResponse.getPromptTokens());
                    analytics.put("completionTokens", runResponse.getCompletionTokens());
                    analytics.put("totalTokens", runResponse.getTotalTokens());
                    analytics.put("metadata", runResponse.getMetadata());
                    analytics.put("timestamp", Instant.now().toString());
                    
                    if (request.getContext() != null) {
                        analytics.put("executionId", request.getContext().get("executionId"));
                    }

                    String json = new com.fasterxml.jackson.databind.ObjectMapper().writeValueAsString(analytics);
                    kafkaTemplate.send("agentweave.analytics.token_usage", json);
                    System.out.println("Published token analytics to Kafka: " + json);
                } catch (Exception kafkaEx) {
                    System.err.println("Warning: Failed to publish token analytics to Kafka: " + kafkaEx.getMessage());
                }
            }

            meta.put("timestamp", Instant.now().toString());

            response.put("success", true);
            response.put("data", runResponse);
            response.put("error", null);
            response.put("meta", meta);

        } catch (Exception ex) {
            meta.put("timestamp", Instant.now().toString());
            response.put("success", false);
            response.put("data", null);
            response.put("error", ex.getMessage());
            response.put("meta", meta);
        }

        return response;
    }
}
