#include "tenvyr/hmac.hpp"
#include "tenvyr/json.hpp"

#include <cstdlib>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

using tenvyr::Json;
using tenvyr::create_callback_signature;
using tenvyr::parse_json;
using tenvyr::require_string;

static std::string read_file(const std::string& path) {
  std::ifstream input(path);
  if (!input) {
    throw std::runtime_error("cannot open " + path);
  }
  std::ostringstream buffer;
  buffer << input.rdbuf();
  return buffer.str();
}

int main(int argc, char** argv) {
  const char* path = std::getenv("TENVYR_VECTORS_JSON");
  if (argc > 1) {
    path = argv[1];
  }
  if (path == nullptr) {
    path = TENVYR_VECTORS_JSON;
  }
  const Json vectors = parse_json(read_file(path));
  if (vectors.type != Json::Type::array || vectors.array.size() != 8) {
    std::cerr << "expected 8 HMAC vectors\n";
    return 1;
  }
  int matched = 0;
  for (const Json& vector : vectors.array) {
    const std::string body = require_string(vector, "rawBodyUtf8");
    std::vector<std::uint8_t> raw(body.begin(), body.end());
    const std::string signature = create_callback_signature(
        require_string(vector, "secret"),
        require_string(vector, "timestamp"),
        require_string(vector, "deliveryId"),
        raw);
    const std::string expected = require_string(vector, "expectedSignature");
    if (signature != expected) {
      std::cerr << require_string(vector, "name") << " expected " << expected << " got " << signature << "\n";
      return 1;
    }
    ++matched;
  }
  std::cout << "hmac vectors " << matched << "/8\n";
  return 0;
}
