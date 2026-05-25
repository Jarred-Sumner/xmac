// Cross-compiled Objective-C with ARC.
//
//   source ../xmac-sdk/env.sh
//   $CC -fobjc-arc -framework Foundation -o hello-objc hello.m
#import <Foundation/Foundation.h>

int main(void) {
  @autoreleasepool {
    NSLog(@"%@", [NSString stringWithFormat:@"objc on %@", @"macOS"]);
  }
  return 0;
}
