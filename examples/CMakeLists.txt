# Cross-compile to macOS from Linux:
#
#   bun ../xmac.ts splat --accept-license --output ../xmac-sdk
#   cmake -B build -G Ninja --toolchain ../xmac-sdk/arm64-apple-darwin.toolchain.cmake
#   cmake --build build
cmake_minimum_required(VERSION 3.21)
project(xmac-examples C CXX)

add_executable(hello hello.c)
target_link_libraries(hello PRIVATE "-framework CoreFoundation")

add_executable(hello-cpp hello.cpp)

# A shared library, to prove dylib emission works too.
add_library(greeter SHARED greeter.c)
target_link_libraries(greeter PRIVATE "-framework CoreFoundation")

if(APPLE)
  message(STATUS "APPLE is set — if(APPLE) code paths will be taken")
endif()
