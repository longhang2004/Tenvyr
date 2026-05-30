package com.agentweave.runner.model;

import java.util.Map;

public class RunRequest {
    private String promptTemplate;
    private Map<String, Object> context;

    // Getters and Setters
    public String getPromptTemplate() {
        return promptTemplate;
    }

    public void setPromptTemplate(String promptTemplate) {
        this.promptTemplate = promptTemplate;
    }

    public Map<String, Object> getContext() {
        return context;
    }

    public void setContext(Map<String, Object> context) {
        this.context = context;
    }
}
