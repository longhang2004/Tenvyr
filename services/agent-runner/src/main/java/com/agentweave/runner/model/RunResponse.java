package com.agentweave.runner.model;

import java.util.Map;

public class RunResponse {
    private String output;
    private int promptTokens;
    private int completionTokens;
    private int totalTokens;
    private Map<String, Object> metadata;

    public RunResponse() {}

    public RunResponse(String output, int promptTokens, int completionTokens, int totalTokens) {
        this(output, promptTokens, completionTokens, totalTokens, Map.of());
    }

    public RunResponse(
        String output,
        int promptTokens,
        int completionTokens,
        int totalTokens,
        Map<String, Object> metadata
    ) {
        this.output = output;
        this.promptTokens = promptTokens;
        this.completionTokens = completionTokens;
        this.totalTokens = totalTokens;
        this.metadata = metadata;
    }

    // Getters and Setters
    public String getOutput() {
        return output;
    }

    public void setOutput(String output) {
        this.output = output;
    }

    public int getPromptTokens() {
        return promptTokens;
    }

    public void setPromptTokens(int promptTokens) {
        this.promptTokens = promptTokens;
    }

    public int getCompletionTokens() {
        return completionTokens;
    }

    public void setCompletionTokens(int completionTokens) {
        this.completionTokens = completionTokens;
    }

    public int getTotalTokens() {
        return totalTokens;
    }

    public void setTotalTokens(int totalTokens) {
        this.totalTokens = totalTokens;
    }

    public Map<String, Object> getMetadata() {
        return metadata;
    }

    public void setMetadata(Map<String, Object> metadata) {
        this.metadata = metadata;
    }
}
