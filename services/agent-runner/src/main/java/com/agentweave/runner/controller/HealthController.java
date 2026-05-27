package com.agentweave.runner.controller;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.time.Instant;
import java.util.HashMap;
import java.util.Map;

@RestController
public class HealthController {

    @GetMapping("/health")
    public Map<String, Object> health() {
        Map<String, Object> response = new HashMap<>();
        Map<String, Object> data = new HashMap<>();
        Map<String, Object> meta = new HashMap<>();

        data.put("status", "UP");
        data.put("service", "agent-runner");

        meta.put("timestamp", Instant.now().toString());

        response.put("success", true);
        response.put("data", data);
        response.put("error", null);
        response.put("meta", meta);

        return response;
    }

    @GetMapping("/")
    public Map<String, Object> root() {
        Map<String, Object> response = new HashMap<>();
        Map<String, Object> data = new HashMap<>();
        Map<String, Object> meta = new HashMap<>();

        data.put("message", "Welcome to AgentWeave Core Agent Runner API");

        meta.put("timestamp", Instant.now().toString());

        response.put("success", true);
        response.put("data", data);
        response.put("error", null);
        response.put("meta", meta);

        return response;
    }
}
