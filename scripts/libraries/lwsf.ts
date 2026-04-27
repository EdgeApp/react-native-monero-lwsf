import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'

import { getRepo } from '../utils/common'
import { defineLib } from '../utils/lib'
import { addTask } from '../utils/tasks'

const moneroHash = '38bc62741b82cca179fb8e3437a388b0e0f67842' // Nov 7, 2025
// const moneroHash = '1c9686cb45bec8cd1ca5142426b9ea9458ac4384' // Last compatible version?

addTask({
  name: 'monero.clone',
  cacheTag: moneroHash,
  async run(build) {
    await getRepo(
      'monero',
      'https://github.com/monero-project/monero.git',
      moneroHash
    )

    // Hack the build:
    const cmakePath = join(build.basePath, 'monero', 'CMakeLists.txt')
    const cmakeList = await readFile(cmakePath, 'utf8')
    await writeFile(
      cmakePath,
      cmakeList
        .replace(
          '  forbid_undefined_symbols()',
          '# $& # Disabled by react-native build'
        )
        .replace(
          'INCLUDE(CmakeLists_IOS.txt)',
          '# $& # Disabled by react-native build'
        ),
      'utf8'
    )

    const minerPath = join(
      build.basePath,
      'monero/src/cryptonote_basic/miner.cpp'
    )
    const minerCpp = await readFile(minerPath, 'utf8')
    await writeFile(
      minerPath,
      minerCpp
        .replace(
          '#include <IOKit/IOKitLib.h>',
          '// $& # Disabled by react-native build'
        )
        .replace(
          '#include <IOKit/ps/IOPSKeys.h>',
          '// $& # Disabled by react-native build'
        )
        .replace(
          '#include <IOKit/ps/IOPowerSources.h>',
          '// $& # Disabled by react-native build'
        ),
      'utf8'
    )

    // Patch monero/src/net/http.cpp so that `client_factory::create()`
    // returns a nym-aware http client when the nym-fetch interceptor is
    // enabled. This routes all wallet2-driven (monerod) HTTP calls through
    // the JS fetch bridge the same way the LWSF backend is routed via the
    // rpc.cpp patch. When nym is disabled the factory keeps returning the
    // default `client` and behavior is unchanged.
    const httpCppPath = join(build.basePath, 'monero/src/net/http.cpp')
    const httpCpp = await readFile(httpCppPath, 'utf8')
    await writeFile(
      httpCppPath,
      httpCpp
        .replace(
          '#include "socks_connect.h"',
          `#include "socks_connect.h"

// --- react-native build: nym-fetch interceptor ------------------------------
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <limits>

#include "net/http_base.h"

// Forward declarations for the nym-fetch interceptor. The actual symbols
// are defined in src/monero-wrapper/nym-fetch.cpp and linked together with
// the monero static libraries in the final ffi module.
namespace nymfetch {
  struct Response { int status; std::string body; };
  bool isEnabled();
  std::string getBaseUrl();
  Response performFetch(
      const std::string& url,
      const std::string& method,
      const std::string& headersJson,
      const std::string& body,
      std::uint64_t timeoutMs);
}

namespace rn_nym_http {

// Minimal concrete abstract_http_client that routes every invoke() call
// through nymfetch::performFetch. Connect / disconnect / proxy operations
// are accepted but treated as no-ops because the JS side owns the actual
// transport (mixFetch through the Nym mixnet).
class NymHttpClient final : public epee::net_utils::http::abstract_http_client {
public:
  NymHttpClient() = default;
  ~NymHttpClient() override = default;

  bool set_proxy(const std::string& /*address*/) override { return true; }

  void set_server(std::string host,
                  std::string port,
                  boost::optional<epee::net_utils::http::login> /*user*/,
                  epee::net_utils::ssl_options_t ssl_options =
                      epee::net_utils::ssl_support_t::e_ssl_support_autodetect)
      override {
    m_host = std::move(host);
    m_port = std::move(port);
    m_use_https = (ssl_options.support ==
                   epee::net_utils::ssl_support_t::e_ssl_support_enabled);
  }

  void set_auto_connect(bool /*auto_connect*/) override {}
  bool connect(std::chrono::milliseconds /*timeout*/) override { return true; }
  bool disconnect() override { return true; }
  bool is_connected(bool* ssl = nullptr) override {
    if (ssl != nullptr) *ssl = m_use_https;
    return true;
  }

  bool invoke(const boost::string_ref uri,
              const boost::string_ref method,
              const boost::string_ref body,
              std::chrono::milliseconds timeout,
              const epee::net_utils::http::http_response_info**
                  ppresponse_info = nullptr,
              const epee::net_utils::http::fields_list& additional_params =
                  epee::net_utils::http::fields_list()) override {
    return dispatch(uri, method, body, timeout, ppresponse_info,
                    additional_params);
  }

  bool invoke_get(const boost::string_ref uri,
                  std::chrono::milliseconds timeout,
                  const std::string& body = std::string(),
                  const epee::net_utils::http::http_response_info**
                      ppresponse_info = nullptr,
                  const epee::net_utils::http::fields_list& additional_params =
                      epee::net_utils::http::fields_list()) override {
    return dispatch(uri, boost::string_ref("GET", 3),
                    boost::string_ref(body.data(), body.size()), timeout,
                    ppresponse_info, additional_params);
  }

  std::uint64_t get_bytes_sent() const override { return m_bytes_sent; }
  std::uint64_t get_bytes_received() const override { return m_bytes_received; }

private:
  bool dispatch(const boost::string_ref uri,
                const boost::string_ref method,
                const boost::string_ref body,
                std::chrono::milliseconds timeout,
                const epee::net_utils::http::http_response_info**
                    ppresponse_info,
                const epee::net_utils::http::fields_list& additional_params) {
    // Monerod wallet2 calls carry their target through set_server(), so
    // use that per-client state instead of the global LWSF base URL.
    if (m_host.empty()) return false;
    std::string base = (m_use_https ? "https://" : "http://") + m_host;
    if (!m_port.empty()) base += ":" + m_port;
    std::string path(uri.data(), uri.size());
    if (path.empty() || path.front() != '/') path.insert(path.begin(), '/');
    const std::string url = base + path;

    // Serialize additional_params + a Host header into a tiny hand-rolled
    // JSON object. We keep this dependency-free to avoid pulling rapidjson
    // through the epee layer.
    std::string headersJson = "{";
    bool first = true;
    const auto appendHeader = [&](const std::string& name,
                                  const std::string& value) {
      if (!first) headersJson += ",";
      first = false;
      headersJson += "\\"";
      headersJson += escapeJson(name);
      headersJson += "\\":\\"";
      headersJson += escapeJson(value);
      headersJson += "\\"";
    };
    for (const auto& kv : additional_params) {
      appendHeader(kv.first, kv.second);
    }
    headersJson += "}";

    const std::string method_str(method.data(), method.size());
    const std::string body_str(body.data(), body.size());

    m_bytes_sent += body.size();

    try {
      const auto r = nymfetch::performFetch(
          url, method_str, headersJson, body_str,
          static_cast<std::uint64_t>(
              timeout.count() > 0 ? timeout.count() : 60000));
      if (r.status <= 0 || r.status > std::numeric_limits<int>::max()) {
        return false;
      }
      m_response_info.clear();
      m_response_info.m_response_code = r.status;
      m_response_info.m_body = r.body;
      m_response_info.m_http_ver_hi = 1;
      m_response_info.m_http_ver_lo = 1;
      m_bytes_received += r.body.size();
      if (ppresponse_info != nullptr) {
        *ppresponse_info = std::addressof(m_response_info);
      }
      return true;
    } catch (const std::exception&) {
      return false;
    }
  }

  static std::string escapeJson(const std::string& in) {
    std::string out;
    out.reserve(in.size());
    for (char c : in) {
      switch (c) {
        case '"': out += "\\\\\\""; break;
        case '\\\\': out += "\\\\\\\\"; break;
        case '\\n': out += "\\\\n"; break;
        case '\\r': out += "\\\\r"; break;
        case '\\t': out += "\\\\t"; break;
        default:
          if (static_cast<unsigned char>(c) < 0x20) {
            char buf[8];
            std::snprintf(buf, sizeof(buf), "\\\\u%04x",
                          static_cast<unsigned>(c) & 0xff);
            out += buf;
          } else {
            out += c;
          }
      }
    }
    return out;
  }

  epee::net_utils::http::http_response_info m_response_info;
  std::string m_host;
  std::string m_port;
  bool m_use_https = false;
  std::uint64_t m_bytes_sent = 0;
  std::uint64_t m_bytes_received = 0;
};

} // namespace rn_nym_http
// --- end react-native build patch -------------------------------------------`
        )
        .replace(
          `std::unique_ptr<epee::net_utils::http::abstract_http_client> client_factory::create()
{
  return std::unique_ptr<epee::net_utils::http::abstract_http_client>(new client());
}`,
          `std::unique_ptr<epee::net_utils::http::abstract_http_client> client_factory::create()
{
  // react-native build: divert to the JS fetch bridge when enabled so
  // monerod RPC calls travel through Nym like the lwsf backend does.
  if (nymfetch::isEnabled()) {
    return std::unique_ptr<epee::net_utils::http::abstract_http_client>(
        new rn_nym_http::NymHttpClient());
  }
  return std::unique_ptr<epee::net_utils::http::abstract_http_client>(new client());
}`
        ),
      'utf8'
    )

    return moneroHash
  }
})

export const lwsf = defineLib({
  name: 'lwsf',
  cacheTag: '0',
  libDeps: ['boost', 'libsodium', 'libunbound', 'libzmq', 'openssl'],
  deps: ['monero.clone'],

  url: 'https://github.com/vtnerd/lwsf.git',
  hash: 'cedb2164f9ccd418b91a4e54ee8479c8d5c3cad0', // Nov 7, 2025

  async build(build, platform, prefixPath) {
    // Patch rpc.cpp to support api_key injection in HTTP requests
    // and to optionally route requests through a JS-side fetch bridge
    // (used for Nym mixnet support).
    const rpcPath = join(build.cwd, 'src/rpc.cpp')
    const rpcCpp = await readFile(rpcPath, 'utf8')
    await writeFile(
      rpcPath,
      rpcCpp
        // Add api_key storage + nym-fetch declarations after includes.
        .replace(
          '#include "wire/wrappers_impl.h"',
          `#include "wire/wrappers_impl.h"
#include <chrono>
#include <cstdint>
#include <limits>
#include <stdexcept>

// API key storage for request injection (added by react-native build)
namespace lwsf { namespace config {
  static std::string g_api_key;
  const std::string& api_key() { return g_api_key; }
  void set_api_key(const std::string& k) { g_api_key = k; }
}}

// Forward declarations for the nym-fetch interceptor (added by
// react-native build). These symbols are defined in nym-fetch.cpp and
// linked into the ffi module at link time.
namespace nymfetch {
  struct Response { int status; std::string body; };
  bool isEnabled();
  std::string getBaseUrl();
  Response performFetch(
      const std::string& url,
      const std::string& method,
      const std::string& headersJson,
      const std::string& body,
      std::uint64_t timeoutMs);
}`
        )
        // Modify invoke_payload to (1) inject api_key into JSON body and
        // (2) redirect to the JS fetch bridge when Nym is enabled.
        .replace(
          `expect<std::string> invoke_payload(http_client& client, const boost::string_ref endpoint, const epee::byte_slice payload)
  {
    static const epee::net_utils::http::fields_list headers{
      {"Content-Type", "application/json; charset=utf-8"}
    };

    const epee::net_utils::http::http_response_info* response = nullptr;
    if (!client.invoke(endpoint, "POST", {reinterpret_cast<const char*>(payload.data()), payload.size()}, config::rpc_timeout, std::addressof(response), headers))
      return {error::no_response};`,
          `expect<std::string> invoke_payload(http_client& client, const boost::string_ref endpoint, epee::byte_slice payload)
  {
    static const epee::net_utils::http::fields_list headers{
      {"Content-Type", "application/json; charset=utf-8"}
    };

    // Inject api_key if set (added by react-native build)
    std::string body_str;
    const std::string& key = config::api_key();
    if (!key.empty()) {
      std::string original(reinterpret_cast<const char*>(payload.data()), payload.size());
      size_t pos = original.rfind('}');
      if (pos != std::string::npos && pos > 0) {
        body_str = original.substr(0, pos);
        if (original[pos-1] != '{') body_str += ",";
        body_str += "\\"api_key\\":\\"" + key + "\\"}";
      } else {
        body_str = original;
      }
    } else {
      body_str.assign(reinterpret_cast<const char*>(payload.data()), payload.size());
    }

    // Nym path: delegate to JS fetch bridge instead of hitting the network
    // directly. The JS layer is responsible for actually executing the
    // request through mixFetch.
    if (nymfetch::isEnabled()) {
      const std::string base = nymfetch::getBaseUrl();
      if (base.empty()) return {error::no_response};
      std::string path(endpoint.data(), endpoint.size());
      if (path.empty() || path.front() != '/') path.insert(path.begin(), '/');
      const std::string url = base + path;
      try {
        const auto r = nymfetch::performFetch(
          url, "POST",
          std::string("{\\"Content-Type\\":\\"application/json; charset=utf-8\\"}"),
          body_str,
          static_cast<std::uint64_t>(
            std::chrono::duration_cast<std::chrono::milliseconds>(
              config::rpc_timeout).count()));
        if (r.status == 200 || r.status == 201) return r.body;
        if (r.status <= 0 || std::numeric_limits<int>::max() < r.status)
          return {error::invalid_code};
        return {error(int(r.status))};
      } catch (const std::exception&) {
        return {error::no_response};
      }
    }

    const epee::net_utils::http::http_response_info* response = nullptr;
    if (!client.invoke(endpoint, "POST", body_str, config::rpc_timeout, std::addressof(response), headers))
      return {error::no_response};`
        ),
      'utf8'
    )
    build.log('Patched rpc.cpp for api_key and nym-fetch support')

    build.exportEnv({
      PKG_CONFIG_PATH: join(prefixPath, '/lib/pkgconfig')
    })

    // Works for Android:
    await build.exec('cmake', [
      // Source directory:
      `-S${build.cwd}`,
      // Build directory:
      `-B${join(build.cwd, 'cmake')}`,
      // Build options:
      `-DCMAKE_BUILD_TYPE=Release`,
      `-DCMAKE_CXX_FLAGS=-DLWSF_MASTER_ENABLE`,
      `-DCMAKE_C_FLAGS=-D_DARWIN_C_SOURCE`,
      `-DCMAKE_FIND_ROOT_PATH=${prefixPath};${platform.sysroot}"`,
      `-DCMAKE_INSTALL_PREFIX=${prefixPath}`,
      `-DCMAKE_PREFIX_PATH=${prefixPath}`,
      `-DMONERO_SOURCE_DIR=${join(build.basePath, 'monero')}`,
      `-DSTATIC=true`,
      `-DUSE_DEVICE_TREZOR=OFF`,
      ...platform.cmakeFlags
    ])
    await build.exec('cmake', [
      '--build',
      join(build.cwd, 'cmake'),
      '--config',
      'Release',
      '--target',
      'lwsf-api'
    ])

    build.log('done')
  }
})
