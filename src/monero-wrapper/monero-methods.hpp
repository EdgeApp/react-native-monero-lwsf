#ifndef LWSF_METHODS_HPP_INCLUDED
#define LWSF_METHODS_HPP_INCLUDED

#include <string>
#include <vector>

struct LwsfMethod {
  const char *name;
  int argc;
  std::string (*method)(const std::vector<const std::string> &args);
};
extern const LwsfMethod lwsfMethods[];
extern const unsigned lwsfMethodCount;

#endif
