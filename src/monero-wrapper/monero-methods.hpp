#ifndef MONERO_METHODS_HPP_INCLUDED
#define MONERO_METHODS_HPP_INCLUDED

#include <string>
#include <vector>

struct MoneroMethod {
  const char *name;
  int argc;
  std::string (*method)(const std::vector<const std::string> &args);
};
extern const MoneroMethod moneroMethods[];
extern const unsigned moneroMethodCount;

#endif
