#import "MoneroModule.h"
#include "monero-methods.hpp"

// Global pointer so the C++ callback can reach the ObjC module instance
static __weak MoneroModule* g_module = nil;

@implementation MoneroModule

RCT_EXPORT_MODULE(MoneroLwsfModule);

+ (BOOL)requiresMainQueueSetup { return NO; }

- (instancetype)init {
  self = [super init];
  if (self) {
    g_module = self;

    // Wire the C++ wallet-event callback to this module's event emitter
    moneroSetEventCallback([](const std::string& walletId,
                              const std::string& eventName,
                              const std::string& jsonPayload) {
      MoneroModule* module = g_module;
      if (module == nil) return;

      NSString *nsWalletId  = [NSString stringWithUTF8String:walletId.c_str()];
      NSString *nsEventName = [NSString stringWithUTF8String:eventName.c_str()];
      NSString *nsPayload   = [NSString stringWithUTF8String:jsonPayload.c_str()];

      dispatch_async(dispatch_get_main_queue(), ^{
        [module sendEventWithName:@"MoneroWalletEvent" body:@{
          @"walletId":  nsWalletId,
          @"eventName": nsEventName,
          @"data":      nsPayload
        }];
      });
    });
  }
  return self;
}

- (NSArray<NSString *> *)supportedEvents {
  return @[@"MoneroWalletEvent"];
}

- (void)startObserving {}
- (void)stopObserving {}

RCT_REMAP_METHOD(
  callMonero,
  callMoneroMethod:(NSString *)method
  arguments:(NSArray *)arguments
  resolver:(RCTPromiseResolveBlock)resolve
  rejecter:(RCTPromiseRejectBlock)reject
) {
  const std::string methodString = [method UTF8String];

  // Re-package the arguments:
  NSUInteger length = [arguments count];
  std::vector<std::string> strings;
  strings.reserve(length);
  for (NSUInteger i = 0; i < length; ++i) {
    NSString *string = [arguments objectAtIndex:i];
    strings.push_back([string UTF8String]);
  }

  // Find the named method:
  for (int i = 0; i < moneroMethodCount; ++i) {
    if (moneroMethods[i].name != methodString) continue;

    // Validate the argument count:
    if (moneroMethods[i].argc != strings.size()) {
      reject(@"Error", @"monero incorrect C++ argument count", nil);
      return;
    }

    // Call the method, with error handling:
    try {
      const std::string out = moneroMethods[i].method(strings);
      resolve(
        [NSString stringWithCString:out.c_str() encoding:NSUTF8StringEncoding]
      );
    } catch (std::exception &e) {
      reject(
        @"Error",
        [NSString stringWithCString:e.what() encoding:NSUTF8StringEncoding],
        nil
      );
    } catch (...) {
      reject(@"Error", @"monero threw a C++ exception", nil);
    }
    return;
  }

  reject(
    @"TypeError",
    [NSString stringWithFormat:@"No monero C++ method %@", method],
    nil
  );
}

- (NSDictionary *)constantsToExport
{
  NSMutableArray *out = [NSMutableArray arrayWithCapacity:moneroMethodCount];
  for (int i = 0; i < moneroMethodCount; ++i) {
    NSString *name = [NSString stringWithCString:moneroMethods[i].name
      encoding:NSUTF8StringEncoding];
    out[i] = name;
  }

  NSFileManager *fileManager = [NSFileManager defaultManager];
  NSURL *docsDir = [fileManager URLForDirectory:NSDocumentDirectory
    inDomain:NSUserDomainMask
    appropriateForURL:nil
    create:YES
    error:nil];
  NSString *docsPath = [docsDir path];

  return @{
    @"methodNames": out,
    @"documentDirectory": docsPath
  };
}

@end
