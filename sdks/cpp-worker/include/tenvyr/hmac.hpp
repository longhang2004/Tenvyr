#pragma once

#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace tenvyr {

inline constexpr char HEADER_KEY_ID[] = "X-AgentWeave-Key-Id";
inline constexpr char HEADER_TIMESTAMP[] = "X-AgentWeave-Timestamp";
inline constexpr char HEADER_DELIVERY_ID[] = "X-AgentWeave-Delivery-Id";
inline constexpr char HEADER_SIGNATURE[] = "X-AgentWeave-Signature";

std::string create_callback_signature(
    std::string_view secret,
    std::string_view timestamp,
    std::string_view delivery_id,
    const std::vector<std::uint8_t>& raw_body);

}  // namespace tenvyr
