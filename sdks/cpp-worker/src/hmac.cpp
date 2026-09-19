#include "tenvyr/hmac.hpp"

#include <openssl/evp.h>
#include <openssl/hmac.h>

#include <iomanip>
#include <sstream>
#include <stdexcept>

namespace tenvyr {

std::string create_callback_signature(
    std::string_view secret,
    std::string_view timestamp,
    std::string_view delivery_id,
    const std::vector<std::uint8_t>& raw_body) {
  std::vector<unsigned char> payload;
  payload.reserve(timestamp.size() + delivery_id.size() + raw_body.size() + 2);
  payload.insert(payload.end(), timestamp.begin(), timestamp.end());
  payload.push_back(static_cast<unsigned char>('.'));
  payload.insert(payload.end(), delivery_id.begin(), delivery_id.end());
  payload.push_back(static_cast<unsigned char>('.'));
  payload.insert(payload.end(), raw_body.begin(), raw_body.end());

  unsigned char digest[EVP_MAX_MD_SIZE];
  unsigned int length = 0;
  unsigned char* ok = HMAC(
      EVP_sha256(),
      secret.data(),
      static_cast<int>(secret.size()),
      payload.data(),
      payload.size(),
      digest,
      &length);
  if (ok == nullptr || length != 32) {
    throw std::runtime_error("HMAC-SHA256 failed");
  }
  std::ostringstream hex;
  hex << "v1=";
  hex << std::hex << std::setfill('0');
  for (unsigned int i = 0; i < length; ++i) {
    hex << std::setw(2) << static_cast<int>(digest[i]);
  }
  return hex.str();
}

}  // namespace tenvyr
