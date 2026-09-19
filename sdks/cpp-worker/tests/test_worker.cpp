#include "tenvyr/hmac.hpp"
#include "tenvyr/json.hpp"
#include "tenvyr/worker.hpp"

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <chrono>
#include <cstring>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

using tenvyr::Json;
using tenvyr::Worker;
using tenvyr::WorkerConfig;
using tenvyr::create_callback_signature;
using tenvyr::dump_json;
using tenvyr::parse_json;
using tenvyr::require_string;

struct Captured {
  std::string key_id;
  std::string timestamp;
  std::string delivery_id;
  std::string signature;
  std::string body;
  bool ready = false;
};

static std::string header_value(const std::string& head, const char* name) {
  const std::string prefix = std::string(name) + ": ";
  const auto start = head.find(prefix);
  if (start == std::string::npos) {
    return {};
  }
  const auto end = head.find("\r\n", start);
  return head.substr(start + prefix.size(), end - start - prefix.size());
}

static int listen_local() {
  const int fd = ::socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) {
    throw std::runtime_error("socket");
  }
  int reuse = 1;
  setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));
  sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  addr.sin_port = 0;
  if (bind(fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0) {
    throw std::runtime_error("bind");
  }
  listen(fd, 1);
  return fd;
}

static int port_of(int fd) {
  sockaddr_in addr{};
  socklen_t length = sizeof(addr);
  getsockname(fd, reinterpret_cast<sockaddr*>(&addr), &length);
  return ntohs(addr.sin_port);
}

static std::string post(const std::string& host_port_path, const std::string& headers, const std::string& body) {
  const auto slash = host_port_path.find('/');
  const std::string hostport = host_port_path.substr(0, slash);
  const std::string path = host_port_path.substr(slash);
  const auto colon = hostport.rfind(':');
  const std::string host = hostport.substr(0, colon);
  const int port = std::stoi(hostport.substr(colon + 1));
  const int fd = ::socket(AF_INET, SOCK_STREAM, 0);
  sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_port = htons(static_cast<uint16_t>(port));
  inet_pton(AF_INET, host.c_str(), &addr.sin_addr);
  if (connect(fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0) {
    close(fd);
    throw std::runtime_error("connect worker");
  }
  std::ostringstream request;
  request << "POST " << path << " HTTP/1.1\r\n" << headers << "Content-Length: " << body.size() << "\r\n\r\n" << body;
  const std::string raw = request.str();
  send(fd, raw.data(), raw.size(), 0);
  std::string response;
  char buffer[4096];
  while (true) {
    const ssize_t got = recv(fd, buffer, sizeof(buffer), 0);
    if (got <= 0) {
      break;
    }
    response.append(buffer, static_cast<std::size_t>(got));
  }
  close(fd);
  return response;
}

static std::string run_request(const std::string& invocation_id, const std::string& callback_url, const std::string& input) {
  return std::string("{\"schemaVersion\":\"1\",\"invocation\":{\"schemaVersion\":\"1\",\"invocationId\":\"") +
         invocation_id +
         "\",\"executionId\":\"execution-1\",\"stepExecutionId\":\"step-1\",\"stepId\":\"echo\",\"target\":{\"agent\":\"echo-agent\"},\"input\":" +
         input +
         ",\"attempt\":1,\"createdAt\":\"2026-07-26T00:00:00.000Z\",\"trace\":{\"traceId\":\"trace-1\",\"correlationId\":\"" +
         invocation_id +
         "\"}},\"resultDelivery\":{\"mode\":\"callback\",\"callbackUrl\":\"" + callback_url +
         "\",\"authentication\":{\"scheme\":\"hmac-sha256\",\"keyId\":\"conformance-v1\"}}}";
}

int main() {
  Captured captured;
  const int callback_fd = listen_local();
  const int callback_port = port_of(callback_fd);
  std::thread callback_thread([&] {
    const int client = accept(callback_fd, nullptr, nullptr);
    if (client < 0) {
      return;
    }
    std::string data;
    char buffer[4096];
    while (data.find("\r\n\r\n") == std::string::npos) {
      const ssize_t got = recv(client, buffer, sizeof(buffer), 0);
      if (got <= 0) {
        close(client);
        return;
      }
      data.append(buffer, static_cast<std::size_t>(got));
    }
    const auto split = data.find("\r\n\r\n");
    const std::string head = data.substr(0, split);
    std::size_t content_length = 0;
    const auto length_at = head.find("Content-Length: ");
    if (length_at != std::string::npos) {
      content_length = static_cast<std::size_t>(std::stoul(head.substr(length_at + 16)));
    }
    std::string body = data.substr(split + 4);
    while (body.size() < content_length) {
      const ssize_t got = recv(client, buffer, sizeof(buffer), 0);
      if (got <= 0) {
        break;
      }
      body.append(buffer, static_cast<std::size_t>(got));
    }
    captured.key_id = header_value(head, tenvyr::HEADER_KEY_ID);
    captured.timestamp = header_value(head, tenvyr::HEADER_TIMESTAMP);
    captured.delivery_id = header_value(head, tenvyr::HEADER_DELIVERY_ID);
    captured.signature = header_value(head, tenvyr::HEADER_SIGNATURE);
    captured.body = body.substr(0, content_length);
    captured.ready = true;
    const char* response = "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
    send(client, response, std::strlen(response), 0);
    close(client);
  });

  const std::string origin = "http://127.0.0.1:" + std::to_string(callback_port);
  WorkerConfig config;
  config.agent_name = "echo-agent";
  config.bearer_token = "token";
  config.callback_keys["conformance-v1"] = "tenvyr-conformance-secret";
  config.allowed_origin = origin;
  config.allow_insecure_http = true;
  config.callback_max_attempts = 3;
  Worker worker(config);
  const int worker_port = worker.start("127.0.0.1", 0);
  const std::string callback_url = origin + "/internal/agent-callbacks/http/echo-agent";
  const std::string body = run_request("invocation-1", callback_url, "null");
  const std::string headers =
      "Host: 127.0.0.1\r\nContent-Type: application/json\r\nAuthorization: Bearer token\r\nIdempotency-Key: invocation-1\r\n";
  const std::string accepted = post("127.0.0.1:" + std::to_string(worker_port) + "/v1/runs", headers, body);
  if (accepted.find("HTTP/1.1 202") != 0) {
    std::cerr << "expected 202, got:\n" << accepted << "\n";
    return 1;
  }
  const std::string duplicate = post("127.0.0.1:" + std::to_string(worker_port) + "/v1/runs", headers, body);
  const Json first = parse_json(accepted.substr(accepted.find("\r\n\r\n") + 4));
  const Json second = parse_json(duplicate.substr(duplicate.find("\r\n\r\n") + 4));
  if (require_string(first, "runId") != require_string(second, "runId")) {
    std::cerr << "idempotent retry changed runId\n";
    return 1;
  }
  for (int i = 0; i < 50 && !captured.ready; ++i) {
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
  }
  if (!captured.ready) {
    std::cerr << "callback not received\n";
    return 1;
  }
  std::vector<std::uint8_t> raw(captured.body.begin(), captured.body.end());
  const std::string expected = create_callback_signature(
      "tenvyr-conformance-secret", captured.timestamp, captured.delivery_id, raw);
  if (expected != captured.signature) {
    std::cerr << "callback HMAC mismatch\n";
    return 1;
  }
  const Json result = parse_json(captured.body);
  if (require_string(result, "status") != "succeeded" || require_string(result, "invocationId") != "invocation-1") {
    std::cerr << "result envelope mismatch\n";
    return 1;
  }

  const std::string unauthorized =
      post("127.0.0.1:" + std::to_string(worker_port) + "/v1/runs",
           "Host: 127.0.0.1\r\nContent-Type: application/json\r\n", "{}");
  if (unauthorized.find("HTTP/1.1 401") != 0) {
    std::cerr << "expected 401 without bearer\n";
    return 1;
  }

  const std::string unsafe = run_request(
      "invocation-unsafe", "https://orchestrator.example/callback", "9007199254740992");
  WorkerConfig safe_config = config;
  safe_config.allowed_origin = "https://orchestrator.example";
  safe_config.allow_insecure_http = false;
  Worker isolated(safe_config);
  const int isolated_port = isolated.start("127.0.0.1", 0);
  const std::string unsafe_headers =
      "Host: 127.0.0.1\r\nContent-Type: application/json\r\nAuthorization: Bearer token\r\nIdempotency-Key: invocation-unsafe\r\n";
  const std::string rejected =
      post("127.0.0.1:" + std::to_string(isolated_port) + "/v1/runs", unsafe_headers, unsafe);
  isolated.stop();
  if (rejected.find("HTTP/1.1 400") != 0) {
    std::cerr << "expected 400 for unsafe integer\n" << rejected << "\n";
    return 1;
  }

  worker.stop();
  shutdown(callback_fd, SHUT_RDWR);
  close(callback_fd);
  callback_thread.join();
  std::cout << "worker protocol mock ok\n";
  return 0;
}
