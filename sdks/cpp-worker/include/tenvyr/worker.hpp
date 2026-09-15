#pragma once

#include "tenvyr/json.hpp"

#include <cstdint>
#include <functional>
#include <map>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace tenvyr {

struct WorkerConfig {
  std::string agent_name;
  std::string bearer_token;
  std::map<std::string, std::string> callback_keys;
  std::string allowed_origin;
  bool allow_insecure_http = false;
  int callback_max_attempts = 8;
  std::function<Json(const Json&)> execute;
};

class Worker {
 public:
  explicit Worker(WorkerConfig config);
  ~Worker();

  Worker(const Worker&) = delete;
  Worker& operator=(const Worker&) = delete;

  int start(const std::string& host, int port);
  void stop();
  int port() const { return port_; }

 private:
  void loop();
  void handle_client(int client);
  std::string handle_runs(const std::map<std::string, std::string>& headers, const std::string& body);
  void execute(const Json& invocation, const std::string& callback_url, const std::string& key_id,
               const std::string& secret);

  WorkerConfig config_;
  int listen_fd_ = -1;
  int stop_fd_ = -1;
  int port_ = 0;
  bool running_ = false;
  std::thread thread_;
  std::mutex mutex_;
  std::map<std::string, std::pair<std::string, std::string>> idempotency_;
};

bool deliver_callback(
    const std::string& url,
    const std::string& key_id,
    const std::string& secret,
    const std::vector<std::uint8_t>& body,
    int max_attempts);

}  // namespace tenvyr
