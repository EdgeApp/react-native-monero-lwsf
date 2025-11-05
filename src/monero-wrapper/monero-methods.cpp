#import <stdio.h>
#import <lws_frontend.h>

#include "monero-methods.hpp"

std::string hello(const std::vector<const std::string> &args) {
  printf("LWSF says hello\n");
  return "hello";
}

std::string getHeight(const std::vector<const std::string> &args) {
  Monero::WalletManager* m = lwsf::WalletManagerFactory::getWalletManager();
  uint64_t height = m->blockchainHeight();
  return lwsf::displayAmount(height);
}

const LwsfMethod lwsfMethods[] = {
  { "hello", 0, hello },
  { "getHeight", 0, getHeight },
};

const unsigned lwsfMethodCount = std::end(lwsfMethods) - std::begin(lwsfMethods);
