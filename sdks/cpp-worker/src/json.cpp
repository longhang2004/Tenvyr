#include "tenvyr/json.hpp"

#include <cctype>
#include <cmath>
#include <iomanip>
#include <limits>
#include <sstream>

namespace tenvyr {
namespace {

struct Parser {
  std::string_view text;
  std::size_t index = 0;

  char peek() const { return index < text.size() ? text[index] : '\0'; }
  char next() { return index < text.size() ? text[index++] : '\0'; }

  void skip() {
    while (index < text.size() && std::isspace(static_cast<unsigned char>(text[index]))) {
      ++index;
    }
  }

  Json parse_value() {
    skip();
    const char current = peek();
    if (current == '{') {
      return parse_object();
    }
    if (current == '[') {
      return parse_array();
    }
    if (current == '"') {
      return Json::from_string(parse_string());
    }
    if (current == 't' || current == 'f') {
      return parse_bool();
    }
    if (current == 'n') {
      return parse_null();
    }
    if (current == '-' || std::isdigit(static_cast<unsigned char>(current))) {
      return parse_number();
    }
    throw JsonError("invalid JSON");
  }

  Json parse_object() {
    next();
    Json object;
    object.type = Json::Type::object;
    skip();
    if (peek() == '}') {
      next();
      return object;
    }
    while (true) {
      skip();
      if (peek() != '"') {
        throw JsonError("object key must be a string");
      }
      std::string key = parse_string();
      skip();
      if (next() != ':') {
        throw JsonError("expected colon");
      }
      object.object.emplace_back(std::move(key), parse_value());
      skip();
      const char separator = next();
      if (separator == '}') {
        return object;
      }
      if (separator != ',') {
        throw JsonError("expected comma or end of object");
      }
    }
  }

  Json parse_array() {
    next();
    Json array;
    array.type = Json::Type::array;
    skip();
    if (peek() == ']') {
      next();
      return array;
    }
    while (true) {
      array.array.push_back(parse_value());
      skip();
      const char separator = next();
      if (separator == ']') {
        return array;
      }
      if (separator != ',') {
        throw JsonError("expected comma or end of array");
      }
    }
  }

  std::string parse_string() {
    next();
    std::string out;
    while (index < text.size()) {
      const char current = next();
      if (current == '"') {
        return out;
      }
      if (current == '\\') {
        const char escaped = next();
        switch (escaped) {
          case '"':
          case '\\':
          case '/':
            out.push_back(escaped);
            break;
          case 'b':
            out.push_back('\b');
            break;
          case 'f':
            out.push_back('\f');
            break;
          case 'n':
            out.push_back('\n');
            break;
          case 'r':
            out.push_back('\r');
            break;
          case 't':
            out.push_back('\t');
            break;
          case 'u': {
            unsigned code = 0;
            for (int i = 0; i < 4; ++i) {
              const char hex = next();
              code <<= 4;
              if (hex >= '0' && hex <= '9') {
                code += static_cast<unsigned>(hex - '0');
              } else if (hex >= 'a' && hex <= 'f') {
                code += static_cast<unsigned>(hex - 'a' + 10);
              } else if (hex >= 'A' && hex <= 'F') {
                code += static_cast<unsigned>(hex - 'A' + 10);
              } else {
                throw JsonError("invalid unicode escape");
              }
            }
            if (code <= 0x7F) {
              out.push_back(static_cast<char>(code));
            } else if (code <= 0x7FF) {
              out.push_back(static_cast<char>(0xC0 | ((code >> 6) & 0x1F)));
              out.push_back(static_cast<char>(0x80 | (code & 0x3F)));
            } else {
              out.push_back(static_cast<char>(0xE0 | ((code >> 12) & 0x0F)));
              out.push_back(static_cast<char>(0x80 | ((code >> 6) & 0x3F)));
              out.push_back(static_cast<char>(0x80 | (code & 0x3F)));
            }
            break;
          }
          default:
            throw JsonError("invalid escape");
        }
        continue;
      }
      if (static_cast<unsigned char>(current) < 0x20) {
        throw JsonError("unescaped control in string");
      }
      out.push_back(current);
    }
    throw JsonError("unterminated string");
  }

  Json parse_bool() {
    if (text.substr(index, 4) == "true") {
      index += 4;
      return Json::from_bool(true);
    }
    if (text.substr(index, 5) == "false") {
      index += 5;
      return Json::from_bool(false);
    }
    throw JsonError("invalid boolean");
  }

  Json parse_null() {
    if (text.substr(index, 4) != "null") {
      throw JsonError("invalid null");
    }
    index += 4;
    return Json::nul();
  }

  Json parse_number() {
    const std::size_t start = index;
    if (peek() == '-') {
      next();
    }
    if (!std::isdigit(static_cast<unsigned char>(peek()))) {
      throw JsonError("invalid number");
    }
    if (peek() == '0') {
      next();
    } else {
      while (std::isdigit(static_cast<unsigned char>(peek()))) {
        next();
      }
    }
    bool is_integral = true;
    if (peek() == '.') {
      is_integral = false;
      next();
      if (!std::isdigit(static_cast<unsigned char>(peek()))) {
        throw JsonError("invalid number");
      }
      while (std::isdigit(static_cast<unsigned char>(peek()))) {
        next();
      }
    }
    if (peek() == 'e' || peek() == 'E') {
      is_integral = false;
      next();
      if (peek() == '+' || peek() == '-') {
        next();
      }
      if (!std::isdigit(static_cast<unsigned char>(peek()))) {
        throw JsonError("invalid number");
      }
      while (std::isdigit(static_cast<unsigned char>(peek()))) {
        next();
      }
    }
    const std::string token(text.substr(start, index - start));
    Json json;
    json.type = Json::Type::number;
    if (is_integral) {
      try {
        const long long parsed = std::stoll(token);
        json.integral = true;
        json.integer = parsed;
        json.number = static_cast<double>(parsed);
      } catch (...) {
        throw JsonError("integer must be within the interoperable safe range");
      }
    } else {
      json.number = std::stod(token);
      if (!std::isfinite(json.number)) {
        throw JsonError("must be a finite JSON number");
      }
      json.integral = json.number == std::nearbyint(json.number);
      json.integer = static_cast<std::int64_t>(json.number);
    }
    return json;
  }
};

void dump_string(std::ostringstream& out, const std::string& value) {
  out << '"';
  for (unsigned char character : value) {
    switch (character) {
      case '"':
        out << "\\\"";
        break;
      case '\\':
        out << "\\\\";
        break;
      case '\n':
        out << "\\n";
        break;
      case '\r':
        out << "\\r";
        break;
      case '\t':
        out << "\\t";
        break;
      default:
        if (character < 0x20) {
          out << "\\u00" << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(character)
              << std::dec;
        } else {
          out << static_cast<char>(character);
        }
    }
  }
  out << '"';
}

void dump_into(std::ostringstream& out, const Json& value) {
  switch (value.type) {
    case Json::Type::nul:
      out << "null";
      break;
    case Json::Type::boolean:
      out << (value.boolean ? "true" : "false");
      break;
    case Json::Type::number:
      if (value.integral) {
        out << value.integer;
      } else {
        out << value.number;
      }
      break;
    case Json::Type::string:
      dump_string(out, value.string);
      break;
    case Json::Type::array: {
      out << '[';
      for (std::size_t i = 0; i < value.array.size(); ++i) {
        if (i != 0) {
          out << ',';
        }
        dump_into(out, value.array[i]);
      }
      out << ']';
      break;
    }
    case Json::Type::object: {
      out << '{';
      for (std::size_t i = 0; i < value.object.size(); ++i) {
        if (i != 0) {
          out << ',';
        }
        dump_string(out, value.object[i].first);
        out << ':';
        dump_into(out, value.object[i].second);
      }
      out << '}';
      break;
    }
  }
}

}  // namespace

Json parse_json(std::string_view text) {
  Parser parser{text};
  Json value = parser.parse_value();
  parser.skip();
  if (parser.index != text.size()) {
    throw JsonError("trailing JSON content");
  }
  return value;
}

std::string dump_json(const Json& value) {
  std::ostringstream out;
  dump_into(out, value);
  return out.str();
}

void assert_safe_integers(const Json& value, const std::string& path) {
  if (value.type == Json::Type::number) {
    if (value.integral) {
      if (value.integer > MAX_SAFE_INTEGER || value.integer < -MAX_SAFE_INTEGER) {
        throw JsonError(path + " integer must be within the interoperable safe range");
      }
    }
    return;
  }
  if (value.type == Json::Type::array) {
    for (std::size_t i = 0; i < value.array.size(); ++i) {
      assert_safe_integers(value.array[i], path + "[" + std::to_string(i) + "]");
    }
    return;
  }
  if (value.type == Json::Type::object) {
    for (const auto& [key, child] : value.object) {
      assert_safe_integers(child, path + "." + key);
    }
  }
}

const Json* object_get(const Json& value, std::string_view key) {
  if (value.type != Json::Type::object) {
    return nullptr;
  }
  for (const auto& [name, child] : value.object) {
    if (name == key) {
      return &child;
    }
  }
  return nullptr;
}

std::string require_string(const Json& value, std::string_view key) {
  const Json* child = object_get(value, key);
  if (child == nullptr || child->type != Json::Type::string || child->string.empty()) {
    throw JsonError(std::string(key) + " is invalid");
  }
  return child->string;
}

}  // namespace tenvyr
