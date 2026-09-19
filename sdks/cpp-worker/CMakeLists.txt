cmake_minimum_required(VERSION 3.16)
project(tenvyr_worker LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(OpenSSL REQUIRED)

add_library(tenvyr_worker
  src/hmac.cpp
  src/json.cpp
  src/worker.cpp
)
target_include_directories(tenvyr_worker PUBLIC include)
target_link_libraries(tenvyr_worker PUBLIC OpenSSL::Crypto pthread)

enable_testing()

add_executable(test_hmac tests/test_hmac.cpp)
target_link_libraries(test_hmac PRIVATE tenvyr_worker)
target_compile_definitions(test_hmac PRIVATE
  TENVYR_VECTORS_JSON="${CMAKE_CURRENT_SOURCE_DIR}/../../contracts/conformance/callback-signatures/vectors.json"
)
add_test(NAME hmac COMMAND test_hmac)

add_executable(test_worker tests/test_worker.cpp)
target_link_libraries(test_worker PRIVATE tenvyr_worker)
add_test(NAME worker COMMAND test_worker)
