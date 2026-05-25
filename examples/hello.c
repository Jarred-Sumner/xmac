/* Cross-compiled C using a macOS framework.
 *
 *   source ../xmac-sdk/env.sh
 *   $CC -framework CoreFoundation -o hello hello.c
 */
#include <CoreFoundation/CoreFoundation.h>
#include <TargetConditionals.h>
#include <stdio.h>

int main(void) {
  CFStringRef s = CFSTR("hello from a cross-compiled macOS binary");
  char buf[128];
  CFStringGetCString(s, buf, sizeof buf, kCFStringEncodingUTF8);
  printf("%s (TARGET_OS_OSX=%d)\n", buf, TARGET_OS_OSX);
  return 0;
}
