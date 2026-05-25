// Cross-compiled C++ using the SDK's libc++.
//
//   source ../xmac-sdk/env.sh
//   $CXX -o hello-cpp hello.cpp
#include <iostream>
#include <numeric>
#include <string>
#include <vector>

int main() {
  std::vector<std::string> v{"hello", "from", "libc++", "on", "macOS"};
  std::cout << std::accumulate(v.begin(), v.end(), std::string{},
                               [](auto a, auto b) {
                                 return a.empty() ? b : a + " " + b;
                               })
            << "\n";
}
