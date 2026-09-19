#include "tenvyr/worker.hpp"

#include "tenvyr/hmac.hpp"

#include <arpa/inet.h>
#include <cctype>
#include <netdb.h>
#include <netinet/in.h>
#include <openssl/sha.h>
#include <sys/socket.h>
#include <unistd.h>

#include <algorithm>
#include <chrono>
#include <cstring>
#include <ctime>
#include <iomanip>
#include <random>
#include <sstream>
#include <stdexcept>
#include <thread>

namespace tenvyr {
namespace {

bool const_eq(std::string_view left, std::string_view right) {
  if (left.size() != right.size()) {
    return false;
  }
  unsigned char diff = 0;
  for (std::size_t i = 0; i < left.size(); ++i) {
    diff = static_cast<unsigned char>(diff | (left[i] ^ right[i]));
  }
  return diff == 0;
}

std::string to_lower(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char character) {
    return static_cast<char>(std::tolower(character));
  });
  return value;
}

std::string sha256_hex(const std::string& body) {
  unsigned char digest[SHA256_DIGEST_LENGTH];
  SHA256(reinterpret_cast<const unsigned char*>(body.data()), body.size(), digest);
  std::ostringstream hex;
  hex << std::hex << std::setfill('0');
  for (unsigned char byte : digest) {
    hex << std::setw(2) << static_cast<int>(byte);
  }
  return hex.str();
}

std::string random_id() {
  std::random_device device;
  std::ostringstream out;
  out << std::hex << std::setfill('0');
  for (int i = 0; i < 16; ++i) {
    out << std::setw(2) << (device() & 0xFF);
  }
  return out.str();
}

std::string rfc3339_now() {
  const std::time_t now = std::time(nullptr);
  std::tm utc{};
  gmtime_r(&now, &utc);
  char buffer[40];
  std::strftime(buffer, sizeof(buffer), "%Y-%m-%dT%H:%M:%SZ", &utc);
  return buffer;
}

std::string json_error(const std::string& code, const std::string& message) {
  Json body;
  body.type = Json::Type::object;
  Json error;
  error.type = Json::Type::object;
  error.object.emplace_back("code", Json::from_string(code));
  error.object.emplace_back("message", Json::from_string(message));
  body.object.emplace_back("error", std::move(error));
  return dump_json(body);
}

std::string http_response(int status, const std::string& reason, const std::string& body,
                          const std::vector<std::pair<std::string, std::string>>& extra = {}) {
  std::ostringstream out;
  out << "HTTP/1.1 " << status << " " << reason << "\r\n";
  out << "Content-Type: application/json; charset=utf-8\r\n";
  out << "Content-Length: " << body.size() << "\r\n";
  out << "Connection: close\r\n";
  for (const auto& [name, value] : extra) {
    out << name << ": " << value << "\r\n";
  }
  out << "\r\n" << body;
  return out.str();
}

bool read_all(int fd, std::string& out, std::size_t bytes) {
  out.clear();
  out.reserve(bytes);
  while (out.size() < bytes) {
    char buffer[4096];
    const ssize_t got = ::recv(fd, buffer, std::min(sizeof(buffer), bytes - out.size()), 0);
    if (got <= 0) {
      return false;
    }
    out.append(buffer, static_cast<std::size_t>(got));
  }
  return true;
}

bool write_all(int fd, std::string_view data) {
  std::size_t offset = 0;
  while (offset < data.size()) {
    const ssize_t sent = ::send(fd, data.data() + offset, data.size() - offset, 0);
    if (sent <= 0) {
      return false;
    }
    offset += static_cast<std::size_t>(sent);
  }
  return true;
}

struct Url {
  std::string host;
  int port = 80;
  std::string path;
};

Url parse_http_url(const std::string& url) {
  const std::string prefix = "http://";
  if (url.rfind(prefix, 0) != 0) {
    throw JsonError("callback URL requires HTTP in this C++ worker subset");
  }
  const std::string rest = url.substr(prefix.size());
  const auto slash = rest.find('/');
  const std::string hostport = slash == std::string::npos ? rest : rest.substr(0, slash);
  Url parsed;
  parsed.path = slash == std::string::npos ? "/" : rest.substr(slash);
  const auto colon = hostport.rfind(':');
  if (colon == std::string::npos) {
    parsed.host = hostport;
  } else {
    parsed.host = hostport.substr(0, colon);
    parsed.port = std::stoi(hostport.substr(colon + 1));
  }
  if (parsed.host.size() >= 2 && parsed.host.front() == '[' && parsed.host.back() == ']') {
    parsed.host = parsed.host.substr(1, parsed.host.size() - 2);
  }
  return parsed;
}

std::string origin_of(const std::string& url) {
  const Url parsed = parse_http_url(url);
  std::ostringstream out;
  out << "http://" << parsed.host;
  if (parsed.port != 80) {
    out << ':' << parsed.port;
  }
  return out.str();
}

int connect_tcp(const Url& url) {
  addrinfo hints{};
  hints.ai_socktype = SOCK_STREAM;
  hints.ai_family = AF_UNSPEC;
  addrinfo* result = nullptr;
  if (getaddrinfo(url.host.c_str(), std::to_string(url.port).c_str(), &hints, &result) != 0) {
    throw std::runtime_error("callback DNS failed");
  }
  int fd = -1;
  for (addrinfo* item = result; item != nullptr; item = item->ai_next) {
    fd = ::socket(item->ai_family, item->ai_socktype, item->ai_protocol);
    if (fd < 0) {
      continue;
    }
    if (::connect(fd, item->ai_addr, item->ai_addrlen) == 0) {
      freeaddrinfo(result);
      return fd;
    }
    ::close(fd);
    fd = -1;
  }
  freeaddrinfo(result);
  throw std::runtime_error("callback connect failed");
}

int read_status(int fd) {
  std::string data;
  char buffer[1024];
  while (data.find("\r\n") == std::string::npos) {
    const ssize_t got = ::recv(fd, buffer, sizeof(buffer), 0);
    if (got <= 0) {
      return 0;
    }
    data.append(buffer, static_cast<std::size_t>(got));
    if (data.size() > 8192) {
      return 0;
    }
  }
  std::istringstream line(data.substr(0, data.find("\r\n")));
  std::string version;
  int status = 0;
  line >> version >> status;
  return status;
}

}  // namespace

Worker::Worker(WorkerConfig config) : config_(std::move(config)) {
  if (!config_.execute) {
    config_.execute = [](const Json& input) { return input; };
  }
}

Worker::~Worker() { stop(); }

int Worker::start(const std::string& host, int port) {
  listen_fd_ = ::socket(AF_INET, SOCK_STREAM, 0);
  if (listen_fd_ < 0) {
    throw std::runtime_error("socket");
  }
  int reuse = 1;
  setsockopt(listen_fd_, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));
  sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_port = htons(static_cast<uint16_t>(port));
  if (inet_pton(AF_INET, host.c_str(), &addr.sin_addr) != 1) {
    throw std::runtime_error("bind host");
  }
  if (bind(listen_fd_, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0) {
    throw std::runtime_error("bind");
  }
  socklen_t length = sizeof(addr);
  getsockname(listen_fd_, reinterpret_cast<sockaddr*>(&addr), &length);
  port_ = ntohs(addr.sin_port);
  if (listen(listen_fd_, 16) != 0) {
    throw std::runtime_error("listen");
  }
  running_ = true;
  thread_ = std::thread([this] { loop(); });
  return port_;
}

void Worker::stop() {
  running_ = false;
  if (listen_fd_ >= 0) {
    shutdown(listen_fd_, SHUT_RDWR);
    close(listen_fd_);
    listen_fd_ = -1;
  }
  if (thread_.joinable()) {
    thread_.join();
  }
}

void Worker::loop() {
  while (running_) {
    const int client = ::accept(listen_fd_, nullptr, nullptr);
    if (client < 0) {
      break;
    }
    try {
      handle_client(client);
    } catch (...) {
      const std::string response = http_response(500, "Internal Server Error", json_error("INTERNAL_ERROR", "internal error"));
      write_all(client, response);
    }
    close(client);
  }
}

void Worker::handle_client(int client) {
  std::string header;
  char buffer[4096];
  while (header.find("\r\n\r\n") == std::string::npos) {
    const ssize_t got = ::recv(client, buffer, sizeof(buffer), 0);
    if (got <= 0) {
      return;
    }
    header.append(buffer, static_cast<std::size_t>(got));
    if (header.size() > 64 * 1024) {
      write_all(client, http_response(413, "Payload Too Large", json_error("REQUEST_TOO_LARGE", "request too large")));
      return;
    }
  }
  const auto split = header.find("\r\n\r\n");
  const std::string head = header.substr(0, split);
  std::string extra = header.substr(split + 4);
  std::istringstream stream(head);
  std::string method;
  std::string path;
  std::string version;
  stream >> method >> path >> version;
  std::map<std::string, std::string> headers;
  std::string line;
  std::getline(stream, line);
  while (std::getline(stream, line)) {
    if (!line.empty() && line.back() == '\r') {
      line.pop_back();
    }
    const auto colon = line.find(':');
    if (colon == std::string::npos) {
      continue;
    }
    std::string name = to_lower(line.substr(0, colon));
    std::string value = line.substr(colon + 1);
    while (!value.empty() && (value.front() == ' ' || value.front() == '\t')) {
      value.erase(value.begin());
    }
    headers[name] = value;
  }
  std::size_t content_length = 0;
  if (headers.count("content-length")) {
    content_length = static_cast<std::size_t>(std::stoul(headers["content-length"]));
  }
  if (content_length > 1024 * 1024) {
    write_all(client, http_response(413, "Payload Too Large", json_error("REQUEST_TOO_LARGE", "request too large")));
    return;
  }
  std::string body = extra;
  if (body.size() < content_length) {
    std::string rest;
    if (!read_all(client, rest, content_length - body.size())) {
      return;
    }
    body += rest;
  } else {
    body.resize(content_length);
  }

  if (method == "GET" && path == "/health/live") {
    write_all(client, http_response(200, "OK", "{\"status\":\"ok\"}"));
    return;
  }
  if (method == "GET" && path == "/health/ready") {
    write_all(client, http_response(running_ ? 200 : 503, running_ ? "OK" : "Service Unavailable",
                                    running_ ? "{\"status\":\"ok\"}" : "{\"status\":\"unavailable\"}"));
    return;
  }
  if (method == "POST" && path == "/v1/runs") {
    write_all(client, handle_runs(headers, body));
    return;
  }
  write_all(client, http_response(404, "Not Found", json_error("NOT_FOUND", "not found")));
}

std::string Worker::handle_runs(const std::map<std::string, std::string>& headers, const std::string& body) {
  auto auth = headers.find("authorization");
  const std::string prefix = "Bearer ";
  if (auth == headers.end() || auth->second.size() < prefix.size() ||
      to_lower(auth->second.substr(0, prefix.size())) != "bearer " ||
      !const_eq(auth->second.substr(prefix.size()), config_.bearer_token)) {
    return http_response(401, "Unauthorized", json_error("UNAUTHORIZED", "unauthorized"),
                         {{"WWW-Authenticate", "Bearer"}});
  }
  auto content_type = headers.find("content-type");
  if (content_type == headers.end() || content_type->second.rfind("application/json", 0) != 0) {
    return http_response(415, "Unsupported Media Type", json_error("UNSUPPORTED_MEDIA_TYPE", "unsupported media type"));
  }
  Json root;
  try {
    root = parse_json(body);
    assert_safe_integers(root);
  } catch (const JsonError& error) {
    const bool too_big = std::string(error.what()).find("safe") != std::string::npos;
    return http_response(400, "Bad Request", json_error(too_big ? "INVALID_REQUEST" : "INVALID_JSON", error.what()));
  }
  try {
    if (root.type != Json::Type::object || require_string(root, "schemaVersion") != "1") {
      throw JsonError("run request is invalid");
    }
    const Json* invocation = object_get(root, "invocation");
    const Json* delivery = object_get(root, "resultDelivery");
    if (invocation == nullptr || delivery == nullptr) {
      throw JsonError("run request is invalid");
    }
    const Json* target = object_get(*invocation, "target");
    if (target == nullptr || require_string(*target, "agent") != config_.agent_name) {
      return http_response(404, "Not Found", json_error("AGENT_NOT_FOUND", "agent not found"));
    }
    const std::string invocation_id = require_string(*invocation, "invocationId");
    auto idempotency = headers.find("idempotency-key");
    if (idempotency == headers.end() || idempotency->second != invocation_id) {
      return http_response(400, "Bad Request", json_error("INVALID_IDEMPOTENCY_KEY", "Idempotency-Key must equal invocationId"));
    }
    if (require_string(*delivery, "mode") != "callback") {
      throw JsonError("resultDelivery is invalid");
    }
    const Json* authentication = object_get(*delivery, "authentication");
    if (authentication == nullptr || require_string(*authentication, "scheme") != "hmac-sha256") {
      throw JsonError("callback authentication is invalid");
    }
    const std::string key_id = require_string(*authentication, "keyId");
    auto secret = config_.callback_keys.find(key_id);
    if (secret == config_.callback_keys.end()) {
      return http_response(400, "Bad Request", json_error("UNKNOWN_CALLBACK_KEY", "unknown callback key"));
    }
    const std::string callback_url = require_string(*delivery, "callbackUrl");
    if (!config_.allow_insecure_http) {
      throw JsonError("callback URL requires HTTPS unless insecure HTTP is explicitly allowed");
    }
    if (origin_of(callback_url) != config_.allowed_origin) {
      return http_response(400, "Bad Request", json_error("CALLBACK_TARGET_REJECTED", "callback URL origin is not allowed"));
    }
    const std::string fingerprint = sha256_hex(body);
    std::string accepted;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      auto existing = idempotency_.find(invocation_id);
      if (existing != idempotency_.end()) {
        if (existing->second.first != fingerprint) {
          return http_response(409, "Conflict", json_error("IDEMPOTENCY_CONFLICT", "idempotency conflict"));
        }
        return http_response(202, "Accepted", existing->second.second);
      }
      Json acceptance;
      acceptance.type = Json::Type::object;
      acceptance.object.emplace_back("schemaVersion", Json::from_string("1"));
      acceptance.object.emplace_back("invocationId", Json::from_string(invocation_id));
      acceptance.object.emplace_back("runId", Json::from_string(random_id()));
      acceptance.object.emplace_back("status", Json::from_string("accepted"));
      acceptance.object.emplace_back("acceptedAt", Json::from_string(rfc3339_now()));
      accepted = dump_json(acceptance);
      idempotency_[invocation_id] = {fingerprint, accepted};
    }
    std::thread([this, invocation = *invocation, callback_url, key_id, secret = secret->second] {
      execute(invocation, callback_url, key_id, secret);
    }).detach();
    return http_response(202, "Accepted", accepted);
  } catch (const JsonError& error) {
    return http_response(400, "Bad Request", json_error("INVALID_REQUEST", error.what()));
  }
}

void Worker::execute(const Json& invocation, const std::string& callback_url, const std::string& key_id,
                     const std::string& secret) {
  Json result;
  result.type = Json::Type::object;
  result.object.emplace_back("schemaVersion", Json::from_string("1"));
  result.object.emplace_back("invocationId", Json::from_string(require_string(invocation, "invocationId")));
  result.object.emplace_back("executionId", Json::from_string(require_string(invocation, "executionId")));
  result.object.emplace_back("stepExecutionId", Json::from_string(require_string(invocation, "stepExecutionId")));
  try {
    const Json* input = object_get(invocation, "input");
    Json output = config_.execute(input == nullptr ? Json::nul() : *input);
    assert_safe_integers(output, "$.output");
    result.object.emplace_back("status", Json::from_string("succeeded"));
    result.object.emplace_back("completedAt", Json::from_string(rfc3339_now()));
    result.object.emplace_back("output", std::move(output));
  } catch (const std::exception& error) {
    result.object.emplace_back("status", Json::from_string("failed"));
    result.object.emplace_back("completedAt", Json::from_string(rfc3339_now()));
    Json failure;
    failure.type = Json::Type::object;
    failure.object.emplace_back("code", Json::from_string("AGENT_FAILED"));
    failure.object.emplace_back("message", Json::from_string(error.what()));
    failure.object.emplace_back("retryable", Json::from_bool(false));
    result.object.emplace_back("error", std::move(failure));
  }
  const std::string payload = dump_json(result);
  std::vector<std::uint8_t> bytes(payload.begin(), payload.end());
  try {
    deliver_callback(callback_url, key_id, secret, bytes, config_.callback_max_attempts);
  } catch (...) {
    // one terminal result; callback retries already exhausted
  }
}

bool deliver_callback(
    const std::string& url,
    const std::string& key_id,
    const std::string& secret,
    const std::vector<std::uint8_t>& body,
    int max_attempts) {
  const Url parsed = parse_http_url(url);
  const std::string delivery_id = random_id();
  for (int attempt = 1; attempt <= max_attempts; ++attempt) {
    const std::string timestamp = std::to_string(std::time(nullptr));
    const std::string signature = create_callback_signature(secret, timestamp, delivery_id, body);
    std::ostringstream request;
    request << "POST " << parsed.path << " HTTP/1.1\r\n";
    request << "Host: " << parsed.host << ":" << parsed.port << "\r\n";
    request << "Content-Type: application/json\r\n";
    request << "Accept: application/json\r\n";
    request << "User-Agent: Tenvyr-Worker/0.1.0\r\n";
    request << HEADER_KEY_ID << ": " << key_id << "\r\n";
    request << HEADER_TIMESTAMP << ": " << timestamp << "\r\n";
    request << HEADER_DELIVERY_ID << ": " << delivery_id << "\r\n";
    request << HEADER_SIGNATURE << ": " << signature << "\r\n";
    request << "Content-Length: " << body.size() << "\r\n";
    request << "Connection: close\r\n\r\n";
    request.write(reinterpret_cast<const char*>(body.data()), static_cast<std::streamsize>(body.size()));
    try {
      const int fd = connect_tcp(parsed);
      const bool sent = write_all(fd, request.str());
      const int status = sent ? read_status(fd) : 0;
      close(fd);
      if (status >= 200 && status < 300) {
        return true;
      }
      if (!(status == 408 || status == 429 || status >= 500)) {
        return false;
      }
    } catch (...) {
      // retry
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(50 * attempt));
  }
  return false;
}

}  // namespace tenvyr
