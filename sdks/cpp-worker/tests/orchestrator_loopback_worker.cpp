#include "tenvyr/worker.hpp"
#include <chrono>
#include <csignal>
#include <cstdlib>
#include <iostream>
#include <stdexcept>
#include <thread>

static volatile std::sig_atomic_t stopping = 0;
static void stop(int) { stopping = 1; }
static std::string required(const char* key) {
  const char* value = std::getenv(key);
  if (!value || !*value) throw std::runtime_error("missing worker configuration");
  return value;
}
int main() {
  try {
    tenvyr::WorkerConfig config;
    config.agent_name = "remote-echo-agent";
    config.bearer_token = required("TENVYR_WORKER_TOKEN");
    config.callback_keys = {{required("TENVYR_CALLBACK_KEY_ID"), required("TENVYR_CALLBACK_SECRET")}};
    config.allowed_origin = required("TENVYR_CALLBACK_ORIGIN");
    config.allow_insecure_http = true;
    config.execute = [](const tenvyr::Json& input) {
      const auto* mode = tenvyr::object_get(input, "mode");
      if (mode && mode->string == "safe-boundaries")
        return tenvyr::parse_json("{\"maximum\":9007199254740991,\"minimum\":-9007199254740991}");
      tenvyr::Json output;
      output.type = tenvyr::Json::Type::object;
      if (mode && mode->string == "unsafe-output") output.object = {{"unsafe", tenvyr::Json::from_int(9007199254740993LL)}};
      else output.object = {{"echo", tenvyr::Json::from_string(tenvyr::require_string(input, "message"))}};
      return output;
    };
    tenvyr::Worker worker(config);
    std::signal(SIGTERM, stop);
    std::signal(SIGINT, stop);
    int port = worker.start("127.0.0.1", 0);
    std::cout << "{\"event\":\"tenvyr.worker.ready\",\"host\":\"127.0.0.1\",\"port\":" << port << "}" << std::endl;
    while (!stopping) std::this_thread::sleep_for(std::chrono::milliseconds(20));
    worker.stop();
    std::cout << "{\"event\":\"tenvyr.worker.stopped\"}" << std::endl;
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "Worker fixture failed: " << error.what() << std::endl;
    return 1;
  }
}
