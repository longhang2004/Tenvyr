#pragma once

#include <cstdint>
#include <map>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace tenvyr {

inline constexpr std::int64_t MAX_SAFE_INTEGER = 9007199254740991LL;

struct Json {
  enum class Type { nul, boolean, number, string, array, object };
  Type type = Type::nul;
  bool boolean = false;
  bool integral = false;
  double number = 0;
  std::int64_t integer = 0;
  std::string string;
  std::vector<Json> array;
  std::vector<std::pair<std::string, Json>> object;

  static Json nul() { return Json{}; }
  static Json from_bool(bool value) {
    Json json;
    json.type = Type::boolean;
    json.boolean = value;
    return json;
  }
  static Json from_int(std::int64_t value) {
    Json json;
    json.type = Type::number;
    json.integral = true;
    json.integer = value;
    json.number = static_cast<double>(value);
    return json;
  }
  static Json from_string(std::string value) {
    Json json;
    json.type = Type::string;
    json.string = std::move(value);
    return json;
  }
};

class JsonError : public std::runtime_error {
 public:
  explicit JsonError(const std::string& message) : std::runtime_error(message) {}
};

Json parse_json(std::string_view text);
std::string dump_json(const Json& value);
void assert_safe_integers(const Json& value, const std::string& path = "$");
const Json* object_get(const Json& value, std::string_view key);
std::string require_string(const Json& value, std::string_view key);

}  // namespace tenvyr
