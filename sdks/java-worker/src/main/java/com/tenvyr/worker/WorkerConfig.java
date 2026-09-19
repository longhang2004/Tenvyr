package com.tenvyr.worker;

import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.function.Function;
import com.fasterxml.jackson.databind.JsonNode;

public final class WorkerConfig {
  public final String agentName;
  public final String bearerToken;
  public final Map<String, String> callbackKeys;
  public final List<String> allowedCallbackOrigins;
  public final boolean allowInsecureHttp;
  public final int executionConcurrency;
  public final int maxQueuedRuns;
  public final int callbackMaxAttempts;
  public final int callbackRetryDelayMs;
  public final int callbackMaxRetryDelayMs;
  public final int maxRequestBytes;
  public final Function<JsonNode, JsonNode> execute;

  private WorkerConfig(Builder builder) {
    this.agentName = builder.agentName;
    this.bearerToken = builder.bearerToken;
    this.callbackKeys = Map.copyOf(builder.callbackKeys);
    this.allowedCallbackOrigins = List.copyOf(builder.allowedCallbackOrigins);
    this.allowInsecureHttp = builder.allowInsecureHttp;
    this.executionConcurrency = builder.executionConcurrency;
    this.maxQueuedRuns = builder.maxQueuedRuns;
    this.callbackMaxAttempts = builder.callbackMaxAttempts;
    this.callbackRetryDelayMs = builder.callbackRetryDelayMs;
    this.callbackMaxRetryDelayMs = builder.callbackMaxRetryDelayMs;
    this.maxRequestBytes = builder.maxRequestBytes;
    this.execute = builder.execute;
  }

  public static Builder builder() {
    return new Builder();
  }

  public static final class Builder {
    private String agentName;
    private String bearerToken;
    private Map<String, String> callbackKeys = Map.of();
    private List<String> allowedCallbackOrigins = List.of();
    private boolean allowInsecureHttp;
    private int executionConcurrency = 4;
    private int maxQueuedRuns = 100;
    private int callbackMaxAttempts = 8;
    private int callbackRetryDelayMs = 250;
    private int callbackMaxRetryDelayMs = 1000;
    private int maxRequestBytes = 1024 * 1024;
    private Function<JsonNode, JsonNode> execute = input -> input;

    public Builder agentName(String agentName) {
      this.agentName = agentName;
      return this;
    }

    public Builder bearerToken(String bearerToken) {
      this.bearerToken = bearerToken;
      return this;
    }

    public Builder callbackKeys(Map<String, String> callbackKeys) {
      this.callbackKeys = callbackKeys;
      return this;
    }

    public Builder allowedCallbackOrigins(List<String> allowedCallbackOrigins) {
      this.allowedCallbackOrigins = allowedCallbackOrigins;
      return this;
    }

    public Builder allowInsecureHttp(boolean allowInsecureHttp) {
      this.allowInsecureHttp = allowInsecureHttp;
      return this;
    }

    public Builder executionConcurrency(int executionConcurrency) {
      this.executionConcurrency = executionConcurrency;
      return this;
    }

    public Builder maxQueuedRuns(int maxQueuedRuns) {
      this.maxQueuedRuns = maxQueuedRuns;
      return this;
    }

    public Builder callbackMaxAttempts(int callbackMaxAttempts) {
      this.callbackMaxAttempts = callbackMaxAttempts;
      return this;
    }

    public Builder callbackRetryDelayMs(int callbackRetryDelayMs) {
      this.callbackRetryDelayMs = callbackRetryDelayMs;
      return this;
    }

    public Builder callbackMaxRetryDelayMs(int callbackMaxRetryDelayMs) {
      this.callbackMaxRetryDelayMs = callbackMaxRetryDelayMs;
      return this;
    }

    public Builder maxRequestBytes(int maxRequestBytes) {
      this.maxRequestBytes = maxRequestBytes;
      return this;
    }

    public Builder execute(Function<JsonNode, JsonNode> execute) {
      this.execute = execute;
      return this;
    }

    public WorkerConfig build() {
      Objects.requireNonNull(agentName, "agentName");
      Objects.requireNonNull(bearerToken, "bearerToken");
      if (callbackKeys.isEmpty()) {
        throw new IllegalArgumentException("callbackKeys");
      }
      if (allowedCallbackOrigins.isEmpty()) {
        throw new IllegalArgumentException("allowedCallbackOrigins");
      }
      if (executionConcurrency < 1
          || maxQueuedRuns < 0
          || callbackMaxAttempts < 1
          || callbackRetryDelayMs < 0
          || callbackMaxRetryDelayMs < 0
          || maxRequestBytes < 1) {
        throw new IllegalArgumentException("bounds");
      }
      return new WorkerConfig(this);
    }
  }
}
