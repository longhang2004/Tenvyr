package com.tenvyr.worker;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.UUID;

final class CallbackClient {
  private static final String USER_AGENT = "Tenvyr-Worker/0.1.0";
  private final HttpClient http =
      HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).connectTimeout(Duration.ofSeconds(10)).build();

  void deliver(String url, String keyId, String secret, byte[] body, WorkerConfig config) {
    String deliveryId = UUID.randomUUID().toString();
    RuntimeException last = new RuntimeException("callback was not attempted");
    for (int attempt = 1; attempt <= config.callbackMaxAttempts; attempt += 1) {
      String timestamp = Long.toString(Instant.now().getEpochSecond());
      String signature = Hmac.sign(secret, timestamp, deliveryId, body);
      HttpRequest request =
          HttpRequest.newBuilder(URI.create(url))
              .timeout(Duration.ofSeconds(10))
              .header("Content-Type", "application/json")
              .header("Accept", "application/json")
              .header("User-Agent", USER_AGENT)
              .header(Hmac.HEADER_KEY_ID, keyId)
              .header(Hmac.HEADER_TIMESTAMP, timestamp)
              .header(Hmac.HEADER_DELIVERY_ID, deliveryId)
              .header(Hmac.HEADER_SIGNATURE, signature)
              .POST(HttpRequest.BodyPublishers.ofByteArray(body))
              .build();
      try {
        HttpResponse<byte[]> response = http.send(request, HttpResponse.BodyHandlers.ofByteArray());
        int status = response.statusCode();
        if (status >= 200 && status < 300) {
          return;
        }
        if (!retryable(status)) {
          throw new IllegalStateException("callback rejected with HTTP " + status);
        }
        last = new IllegalStateException("callback retryable HTTP " + status);
      } catch (InterruptedException error) {
        Thread.currentThread().interrupt();
        throw new IllegalStateException("callback interrupted", error);
      } catch (Exception error) {
        last = error instanceof RuntimeException runtime ? runtime : new IllegalStateException(error);
      }
      sleep(attempt, config.callbackRetryDelayMs, config.callbackMaxRetryDelayMs);
    }
    throw last;
  }

  private static boolean retryable(int status) {
    return status == 408 || status == 429 || status >= 500;
  }

  private static void sleep(int attempt, int delayMs, int maxDelayMs) {
    long waitMs = Math.min((long) delayMs * attempt, maxDelayMs);
    if (waitMs <= 0) {
      return;
    }
    try {
      Thread.sleep(waitMs);
    } catch (InterruptedException error) {
      Thread.currentThread().interrupt();
    }
  }
}
