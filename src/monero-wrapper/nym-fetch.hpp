#ifndef NYM_FETCH_HPP_INCLUDED
#define NYM_FETCH_HPP_INCLUDED

#include <cstdint>
#include <functional>
#include <string>

namespace nymfetch {

/**
 * Callback invoked when C++ needs JS to perform an HTTP request.
 *
 * Parameters (all strings to keep the platform bridges simple):
 *   requestId    - unique ID used to match the response to this request
 *   url          - fully-qualified URL (scheme://host[:port]/path)
 *   method       - HTTP method ("GET", "POST", etc.)
 *   headersJson  - JSON object of header name -> value
 *   bodyBase64   - request body encoded as base64 (may be empty)
 *
 * The callback must arrange for either `resolveFetch` or `rejectFetch` to
 * eventually be invoked with the same requestId.
 */
using FetchRequestCallback = std::function<void(
    const std::string& requestId,
    const std::string& url,
    const std::string& method,
    const std::string& headersJson,
    const std::string& bodyBase64)>;

/** Register the callback that delivers outbound fetch requests to JS. */
void setFetchRequestCallback(FetchRequestCallback cb);

/**
 * Turn the Nym-over-JS-fetch interceptor on/off.
 *
 * While enabled, LWSF (and optionally wallet2) HTTP calls are redirected
 * through the registered FetchRequestCallback instead of the default
 * epee::http_client. Disabling returns the code path to normal behavior.
 */
void setEnabled(bool enabled);
bool isEnabled();

/**
 * Base URL (scheme://host[:port]) that all LWSF requests will be prefixed
 * with when the nym hook is active. We don't rely on epee::http_client's
 * stored host/port because those don't carry scheme information.
 */
void setBaseUrl(const std::string& baseUrl);
std::string getBaseUrl();

/** Response shape returned by performFetch. */
struct Response {
    int status = 0;
    std::string body;                    // Raw bytes (already base64-decoded).
};

/**
 * Synchronously perform a fetch by delegating to JS through the registered
 * callback. Blocks the calling thread on a std::future until JS resolves or
 * rejects the request, or until timeoutMs elapses.
 *
 * Throws std::runtime_error on rejection or timeout.
 */
Response performFetch(
    const std::string& url,
    const std::string& method,
    const std::string& headersJson,
    const std::string& body,
    std::uint64_t timeoutMs);

/** Called from the JS side to complete a pending request successfully. */
void resolveFetch(
    const std::string& requestId,
    int status,
    const std::string& body);

/** Called from the JS side to complete a pending request with an error. */
void rejectFetch(
    const std::string& requestId,
    const std::string& errorMessage);

} // namespace nymfetch

#endif
