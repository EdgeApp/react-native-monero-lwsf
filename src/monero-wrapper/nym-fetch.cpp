#include "nym-fetch.hpp"

#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <future>
#include <memory>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <string>
#include <unordered_map>

namespace nymfetch {

namespace {

struct PendingRequest {
    std::promise<Response> promise;
};

std::mutex g_cbMutex;
FetchRequestCallback g_requestCb;

std::atomic<bool> g_enabled{false};

std::mutex g_baseUrlMutex;
std::string g_baseUrl;

std::mutex g_mapMutex;
std::unordered_map<std::string, std::shared_ptr<PendingRequest>> g_pending;
std::atomic<std::uint64_t> g_nextRequestId{1};

std::string makeRequestId() {
    std::ostringstream oss;
    oss << "nym-" << g_nextRequestId.fetch_add(1);
    return oss.str();
}

} // namespace

void setFetchRequestCallback(FetchRequestCallback cb) {
    std::lock_guard<std::mutex> lock(g_cbMutex);
    g_requestCb = std::move(cb);
}

void setEnabled(bool enabled) {
    g_enabled.store(enabled);
}

bool isEnabled() {
    return g_enabled.load();
}

void setBaseUrl(const std::string& baseUrl) {
    std::lock_guard<std::mutex> lock(g_baseUrlMutex);
    g_baseUrl = baseUrl;
    // Strip trailing slash so callers can always do base + "/" + path.
    while (!g_baseUrl.empty() && g_baseUrl.back() == '/') {
        g_baseUrl.pop_back();
    }
}

std::string getBaseUrl() {
    std::lock_guard<std::mutex> lock(g_baseUrlMutex);
    return g_baseUrl;
}

Response performFetch(
    const std::string& url,
    const std::string& method,
    const std::string& headersJson,
    const std::string& body,
    std::uint64_t timeoutMs) {
    FetchRequestCallback cb;
    {
        std::lock_guard<std::mutex> lock(g_cbMutex);
        cb = g_requestCb;
    }
    if (!cb) {
        throw std::runtime_error("nym fetch callback not registered");
    }

    const std::string requestId = makeRequestId();
    auto pending = std::make_shared<PendingRequest>();
    auto future = pending->promise.get_future();

    {
        std::lock_guard<std::mutex> lock(g_mapMutex);
        g_pending.emplace(requestId, pending);
    }

    // The JS side expects body bytes as base64 so it can preserve binary
    // request bodies for both JSON-RPC and binary monerod endpoints.
    static const char b64alphabet[] =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string bodyBase64;
    bodyBase64.reserve(((body.size() + 2) / 3) * 4);
    std::size_t i = 0;
    while (i + 3 <= body.size()) {
        const std::uint8_t b0 = static_cast<std::uint8_t>(body[i]);
        const std::uint8_t b1 = static_cast<std::uint8_t>(body[i + 1]);
        const std::uint8_t b2 = static_cast<std::uint8_t>(body[i + 2]);
        bodyBase64.push_back(b64alphabet[(b0 >> 2) & 0x3f]);
        bodyBase64.push_back(b64alphabet[((b0 << 4) | (b1 >> 4)) & 0x3f]);
        bodyBase64.push_back(b64alphabet[((b1 << 2) | (b2 >> 6)) & 0x3f]);
        bodyBase64.push_back(b64alphabet[b2 & 0x3f]);
        i += 3;
    }
    if (i < body.size()) {
        const std::uint8_t b0 = static_cast<std::uint8_t>(body[i]);
        const std::uint8_t b1 =
            (i + 1 < body.size()) ? static_cast<std::uint8_t>(body[i + 1]) : 0;
        bodyBase64.push_back(b64alphabet[(b0 >> 2) & 0x3f]);
        bodyBase64.push_back(b64alphabet[((b0 << 4) | (b1 >> 4)) & 0x3f]);
        if (i + 1 < body.size()) {
            bodyBase64.push_back(b64alphabet[(b1 << 2) & 0x3f]);
        } else {
            bodyBase64.push_back('=');
        }
        bodyBase64.push_back('=');
    }

    try {
        cb(requestId, url, method, headersJson, bodyBase64);
    } catch (...) {
        std::lock_guard<std::mutex> lock(g_mapMutex);
        g_pending.erase(requestId);
        throw;
    }

    const auto wait = std::chrono::milliseconds(timeoutMs == 0 ? 60000 : timeoutMs);
    if (future.wait_for(wait) != std::future_status::ready) {
        std::lock_guard<std::mutex> lock(g_mapMutex);
        g_pending.erase(requestId);
        throw std::runtime_error("nym fetch timed out");
    }
    // future.get() may throw if JS called rejectFetch.
    return future.get();
}

namespace {

// Decode a base64 string. Returns the raw bytes; malformed input yields what
// was successfully decoded. Handles both padded and unpadded input.
std::string base64Decode(const std::string& input) {
    static std::int8_t table[256];
    static bool tableReady = false;
    if (!tableReady) {
        for (int i = 0; i < 256; ++i) table[i] = -1;
        const char* alphabet =
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        for (int i = 0; i < 64; ++i) table[static_cast<std::uint8_t>(alphabet[i])] = i;
        table['-'] = 62;
        table['_'] = 63;
        tableReady = true;
    }

    std::string out;
    out.reserve(input.size() / 4 * 3);

    std::uint32_t buffer = 0;
    int bits = 0;
    for (char c : input) {
        if (c == '=' || c == '\n' || c == '\r' || c == ' ') continue;
        const std::int8_t v = table[static_cast<std::uint8_t>(c)];
        if (v < 0) continue;
        buffer = (buffer << 6) | static_cast<std::uint32_t>(v);
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out.push_back(static_cast<char>((buffer >> bits) & 0xff));
        }
    }
    return out;
}

} // namespace

void resolveFetch(
    const std::string& requestId,
    int status,
    const std::string& body) {
    std::shared_ptr<PendingRequest> pending;
    {
        std::lock_guard<std::mutex> lock(g_mapMutex);
        auto it = g_pending.find(requestId);
        if (it == g_pending.end()) return;
        pending = it->second;
        g_pending.erase(it);
    }

    Response response;
    response.status = status;
    response.body = base64Decode(body);
    try {
        pending->promise.set_value(std::move(response));
    } catch (...) {
    }
}

void rejectFetch(
    const std::string& requestId,
    const std::string& errorMessage) {
    std::shared_ptr<PendingRequest> pending;
    {
        std::lock_guard<std::mutex> lock(g_mapMutex);
        auto it = g_pending.find(requestId);
        if (it == g_pending.end()) return;
        pending = it->second;
        g_pending.erase(it);
    }

    try {
        pending->promise.set_exception(std::make_exception_ptr(
            std::runtime_error(errorMessage.empty() ? "nym fetch failed" : errorMessage)));
    } catch (...) {
    }
}

} // namespace nymfetch
