#include <stdio.h>
#include <string>
#include <stdexcept>
#include <map>
#include <memory>
#include <set>
#include <algorithm>
#include <vector>
#include <sstream>
#include <fstream>
#include "monero-methods.hpp"
#include "wallet/api/wallet2_api.h"
#include "lws_frontend.h"

/** Lower-level utilities for key generation without disk I/O. */
#include "cryptonote_basic/account.h"
#include "cryptonote_basic/cryptonote_basic_impl.h"
#include "cryptonote_basic/cryptonote_format_utils.h"
#include "mnemonics/electrum-words.h"
#include "string_tools.h"

/** Forward declaration for LWSF api_key support (defined in patched rpc.cpp). */
namespace lwsf { namespace config {
  void set_api_key(const std::string& k);
}}

/** Counter for unique temp file names. */
static uint64_t gTxFileCounter = 0;

/** Escapes a string for safe embedding in JSON (defined below). */
static std::string jsonEscape(const std::string& s);

/** Global wallet-event callback (thread-safe). */
static std::mutex g_eventCbMutex;
static WalletEventCallback g_walletEventCallback;

void moneroSetEventCallback(WalletEventCallback cb) {
  std::lock_guard<std::mutex> lock(g_eventCbMutex);
  g_walletEventCallback = std::move(cb);
}

static void emitWalletEvent(const std::string& walletId,
                            const std::string& eventName,
                            const std::string& jsonPayload) {
  std::lock_guard<std::mutex> lock(g_eventCbMutex);
  if (g_walletEventCallback) {
    g_walletEventCallback(walletId, eventName, jsonPayload);
  }
}

std::string hello(const std::vector<const std::string> &args) {
  printf("LWSF says hello\n");
  return "hello";
}

/** WalletListener implementation - handles wallet events and auto-saves during sync. */
class WalletListeners : public Monero::WalletListener {
public:
  WalletListeners(Monero::Wallet* wallet, const std::string& walletId)
    : m_wallet(wallet), m_walletId(walletId), m_lastSaveHeight(0) {}
  virtual ~WalletListeners() {}
  
  void moneySpent(const std::string &txId, uint64_t amount) override {}

  void moneyReceived(const std::string &txId, uint64_t amount) override {}

  void unconfirmedMoneyReceived(const std::string &txId, uint64_t amount) override {
    emitWalletEvent(m_walletId, "pendingTransactionReceived",
      "{\"txId\":\"" + txId + "\",\"amount\":" + std::to_string(amount) + "}");
  }
  
  void newBlock(uint64_t height) override {
    // Save progress every 1000 blocks during INITIAL sync only.
    // Once synchronized(), refreshed() takes over save responsibility.
    // This is safe because newBlock() is called from the refresh thread.
    const uint64_t SAVE_INTERVAL_BLOCKS = 1000;
    
    // Only save during initial sync (before wallet is fully synchronized)
    if (m_wallet->synchronized()) {
      return; // Let refreshed() handle saves once fully synced
    }
    
    if (height >= m_lastSaveHeight + SAVE_INTERVAL_BLOCKS) {
      try {
        m_wallet->store("");
        m_lastSaveHeight = height;
      } catch (...) {
        // Ignore store errors during sync - will retry on next interval
      }
    }
  }
  
  void updated() override {}
  
  void refreshed() override {
    // Called when refresh cycle completes - safe to store here
    try {
      m_wallet->store("");
      m_lastSaveHeight = m_wallet->blockChainHeight();
    } catch (...) {
      // Ignore store errors - will retry on next refresh
    }
  }

private:
  Monero::Wallet* m_wallet;
  std::string m_walletId;
  uint64_t m_lastSaveHeight;
};

/** Wallet tracking structure. */
struct WalletEntry {
  Monero::Wallet* wallet;
  std::unique_ptr<WalletListeners> listener;
  std::string backend;
  std::string path;
  std::string walletId;
  
  uint64_t cachedSyncedHeight = 0;
  uint64_t cachedBalance = 0;
  uint64_t cachedUnlockedBalance = 0;
};

/**
 * Global state - stores all open wallets by ID.
 *
 * Thread-safety: g_wallets is only ever accessed from the serial bridge queue
 * (iOS DISPATCH_QUEUE_SERIAL, Android single-thread executor), so map reads and
 * writes are never concurrent. The refresh-thread WalletListener uses its own
 * wallet pointer and never touches this map, and closeWallet stops the wallet
 * (joining its refresh thread) before erasing the entry. Do not access
 * g_wallets from any other thread without adding synchronization.
 */
static std::map<std::string, WalletEntry> g_wallets;

/** Helper to get wallet manager based on backend type. */
static Monero::WalletManager* getWalletManager(const std::string& backend) {
  if (backend == "lws") {
    return lwsf::WalletManagerFactory::getWalletManager();
  } else {
    return Monero::WalletManagerFactory::getWalletManager();
  }
}

/**
 * Validates that a walletId is safe to embed in a filesystem path. Wallet ids
 * are base64url strings, so we only allow [A-Za-z0-9_-]; anything else (e.g. a
 * '/', '.', or '\\') is rejected to prevent path traversal / unintended file
 * locations.
 */
static void requireSafeWalletId(const std::string& walletId) {
  if (walletId.empty()) {
    throw std::runtime_error("Invalid walletId: empty");
  }
  for (char c : walletId) {
    const bool ok = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
                    (c >= '0' && c <= '9') || c == '-' || c == '_';
    if (!ok) {
      throw std::runtime_error("Invalid walletId: unsafe character");
    }
  }
}

/** Helper to find wallet by ID or throw exception. */
static WalletEntry& findWalletOrThrow(const std::string& walletId) {
  auto it = g_wallets.find(walletId);
  if (it == g_wallets.end()) {
    throw std::runtime_error("Wallet not found");
  }
  return it->second;
}

/** Helper to find any open wallet matching the given nettype. */
static Monero::Wallet* findWalletByNettype(int nettype) {
  Monero::NetworkType network = static_cast<Monero::NetworkType>(nettype);
  for (const auto& pair : g_wallets) {
    if (pair.second.wallet->nettype() == network) {
      return pair.second.wallet;
    }
  }
  throw std::runtime_error("No open wallet found for the requested network type");
}

/**
 * Generate a new wallet's keys in memory (no disk I/O).
 * Args: nettype, language
 * Returns: JSON with mnemonic, secretSpendKey, publicSpendKey
 */
std::string generateWallet(const std::vector<const std::string> &args) {
  int nettype = std::stoi(args[0]);
  std::string language = args[1];
  
  // Generate keys in memory using account_base (no disk persistence)
  cryptonote::account_base account;
  account.generate();
  
  const auto& keys = account.get_keys();
  
  // Convert spend secret key to mnemonic
  epee::wipeable_string mnemonic;
  if (!crypto::ElectrumWords::bytes_to_words(keys.m_spend_secret_key, mnemonic, language)) {
    throw std::runtime_error("Failed to convert keys to mnemonic");
  }
  
  // Convert keys to hex strings (secret keys need unwrap() to get underlying POD)
  std::string secret_spend_key = epee::string_tools::pod_to_hex(unwrap(unwrap(keys.m_spend_secret_key)));
  std::string public_spend_key = epee::string_tools::pod_to_hex(keys.m_account_address.m_spend_public_key);
  
  // Build JSON response
  std::string json = "{";
  json += "\"mnemonic\":\"" + std::string(mnemonic.data(), mnemonic.size()) + "\",";
  json += "\"secretSpendKey\":\"" + secret_spend_key + "\",";
  json += "\"publicSpendKey\":\"" + public_spend_key + "\"";
  json += "}";
  
  return json;
}

/**
 * Derive all keys from a mnemonic (no disk I/O).
 * Args: mnemonic, nettype
 * Returns: JSON with address, secretViewKey, publicViewKey, secretSpendKey, publicSpendKey
 */
std::string seedAndKeysFromMnemonic(const std::vector<const std::string> &args) {
  std::string mnemonic_str = args[0];
  int nettype = std::stoi(args[1]);
  
  // Convert mnemonic to spend secret key
  crypto::secret_key spend_secret;
  std::string language_name;
  epee::wipeable_string mnemonic_ws(mnemonic_str);
  
  if (!crypto::ElectrumWords::words_to_bytes(mnemonic_ws, spend_secret, language_name)) {
    throw std::runtime_error("Invalid mnemonic");
  }
  
  // Recover account from spend key (derives view key automatically)
  cryptonote::account_base account;
  account.generate(spend_secret, true, false);  // recover=true
  
  const auto& keys = account.get_keys();
  
  // Get address string
  cryptonote::network_type network = static_cast<cryptonote::network_type>(nettype);
  std::string address = account.get_public_address_str(network);
  
  // Convert keys to hex strings (secret keys need unwrap() to get underlying POD)
  std::string secret_view_key = epee::string_tools::pod_to_hex(unwrap(unwrap(keys.m_view_secret_key)));
  std::string public_view_key = epee::string_tools::pod_to_hex(keys.m_account_address.m_view_public_key);
  std::string secret_spend_key = epee::string_tools::pod_to_hex(unwrap(unwrap(keys.m_spend_secret_key)));
  std::string public_spend_key = epee::string_tools::pod_to_hex(keys.m_account_address.m_spend_public_key);
  
  // Build JSON response
  std::string json = "{";
  json += "\"address\":\"" + address + "\",";
  json += "\"secretViewKey\":\"" + secret_view_key + "\",";
  json += "\"publicViewKey\":\"" + public_view_key + "\",";
  json += "\"secretSpendKey\":\"" + secret_spend_key + "\",";
  json += "\"publicSpendKey\":\"" + public_spend_key + "\"";
  json += "}";
  
  return json;
}

/**
 * Get network blockchain height from daemon.
 * Args: backend, nettype, daemonAddress
 * Returns: blockchain height as string
 */
std::string getNetworkBlockHeight(const std::vector<const std::string> &args) {
  std::string backend = args[0];
  int nettype = std::stoi(args[1]);
  std::string daemon_address = args[2];
  
  // The WalletManager is a shared singleton, but its daemon address is only
  // read by this method, which re-sets it on every call before querying. Wallet
  // operations connect via their own wallet->init(), not the manager's address,
  // so this transient mutation cannot perturb other wallets/sessions.
  Monero::WalletManager* manager = getWalletManager(backend);
  manager->setDaemonAddress(daemon_address);
  
  // Check if connected
  if (!manager->connected()) {
    throw std::runtime_error("Failed to connect to daemon at " + daemon_address);
  }
  
  uint64_t height = manager->blockchainHeight();
  return std::to_string(height);
}

/**
 * Validate a Monero address.
 * Args: address, nettype
 * Returns: "true" or "false"
 */
std::string isValidAddress(const std::vector<const std::string> &args) {
  std::string address = args[0];
  int nettype = std::stoi(args[1]);
  Monero::NetworkType network = static_cast<Monero::NetworkType>(nettype);

  // addressValid is a static method on Monero::Wallet
  bool valid = Monero::Wallet::addressValid(address, network);
  return valid ? "true" : "false";
}

/**
 * Open or create a wallet.
 * Args: documentDirectory, walletId, backend, mnemonic, password, nettype, restoreHeight, daemonAddress
 * Returns: JSON with syncedHeight, networkHeight, balance, and unlockedBalance
 */
std::string openWallet(const std::vector<const std::string> &args) {
  std::string documentDirectory = args[0];
  std::string walletId = args[1];
  std::string backend = args[2];
  std::string mnemonic = args[3];
  std::string password = args[4];
  int nettype = std::stoi(args[5]);
  uint64_t restoreHeight = std::stoull(args[6]);
  std::string daemonAddress = args[7];
  
  Monero::NetworkType network = static_cast<Monero::NetworkType>(nettype);
  Monero::WalletManager* manager = getWalletManager(backend);
  
  // Check if wallet is already open
  auto it = g_wallets.find(walletId);
  if (it != g_wallets.end()) {
    WalletEntry& entry = it->second;
    Monero::Wallet* wallet = entry.wallet;
    wallet->startRefresh();
    
    uint64_t syncedHeight = wallet->blockChainHeight();
    uint64_t networkHeight = wallet->daemonBlockChainHeight();
    uint64_t balance = wallet->balanceAll();
    uint64_t unlockedBalance = wallet->unlockedBalanceAll();
    
    entry.cachedSyncedHeight = syncedHeight;
    entry.cachedBalance = balance;
    entry.cachedUnlockedBalance = unlockedBalance;
    
    std::string json = "{";
    json += "\"syncedHeight\":" + std::to_string(syncedHeight) + ",";
    json += "\"networkHeight\":" + std::to_string(networkHeight) + ",";
    json += "\"balance\":\"" + std::to_string(balance) + "\",";
    json += "\"unlockedBalance\":\"" + std::to_string(unlockedBalance) + "\"";
    json += "}";
    return json;
  }
  
  requireSafeWalletId(walletId);
  std::string path = documentDirectory + "/" + backend + "_" + walletId;
  
  Monero::Wallet* wallet = nullptr;
  
  if (manager->walletExists(path)) {
    wallet = manager->openWallet(path, password, network);
    wallet->setRecoveringFromSeed(true);
  } else {
    wallet = manager->recoveryWallet(path, password, mnemonic, network, restoreHeight);
  }
  
  if (wallet == nullptr) {
    throw std::runtime_error("Failed to open or create wallet");
  }
  
  if (wallet->status() != Monero::Wallet::Status_Ok) {
    std::string error = wallet->errorString();
    manager->closeWallet(wallet);
    throw std::runtime_error("Wallet error: " + error);
  }
  
  bool isLws = (backend == "lws");
  wallet->init(daemonAddress, 0, "", "", false, isLws, "");

  auto listener = std::make_unique<WalletListeners>(wallet, walletId);
  wallet->setListener(listener.get());

  wallet->startRefresh();
  
  uint64_t syncedHeight = wallet->blockChainHeight();
  uint64_t networkHeight = wallet->daemonBlockChainHeight();
  uint64_t balance = wallet->balanceAll();
  uint64_t unlockedBalance = wallet->unlockedBalanceAll();
  
  WalletEntry entry;
  entry.wallet = wallet;
  entry.listener = std::move(listener);
  entry.backend = backend;
  entry.path = path;
  entry.walletId = walletId;
  entry.cachedSyncedHeight = syncedHeight;
  entry.cachedBalance = balance;
  entry.cachedUnlockedBalance = unlockedBalance;
  g_wallets[walletId] = std::move(entry);

  std::string json = "{";
  json += "\"syncedHeight\":" + std::to_string(syncedHeight) + ",";
  json += "\"networkHeight\":" + std::to_string(networkHeight) + ",";
  json += "\"balance\":\"" + std::to_string(balance) + "\",";
  json += "\"unlockedBalance\":\"" + std::to_string(unlockedBalance) + "\"";
  json += "}";
  
  return json;
}

/**
 * Get wallet status (synced and network heights, balances).
 * Args: walletId
 * Returns: JSON with syncedHeight, networkHeight, balance, and unlockedBalance
 */
std::string getWalletStatus(const std::vector<const std::string> &args) {
  std::string walletId = args[0];
  WalletEntry& entry = findWalletOrThrow(walletId);
  Monero::Wallet* wallet = entry.wallet;
  
  uint64_t syncedHeight = wallet->blockChainHeight();
  bool heightChanged = (syncedHeight != entry.cachedSyncedHeight);
  
  if (heightChanged) {
    entry.cachedBalance = wallet->balanceAll();
    entry.cachedUnlockedBalance = wallet->unlockedBalanceAll();
    entry.cachedSyncedHeight = syncedHeight;
  }

  uint64_t networkHeight = wallet->daemonBlockChainHeight();
  uint64_t balance = entry.cachedBalance;
  uint64_t unlockedBalance = entry.cachedUnlockedBalance;
  
  std::string json = "{";
  json += "\"syncedHeight\":" + std::to_string(syncedHeight) + ",";
  json += "\"networkHeight\":" + std::to_string(networkHeight) + ",";
  json += "\"balance\":\"" + std::to_string(balance) + "\",";
  json += "\"unlockedBalance\":\"" + std::to_string(unlockedBalance) + "\"";
  json += "}";
  
  return json;
}

/**
 * Close an open wallet.
 * Args: walletId
 * Returns: "ok"
 */
std::string closeWallet(const std::vector<const std::string> &args) {
  std::string walletId = args[0];
  WalletEntry& entry = findWalletOrThrow(walletId);
  Monero::WalletManager* manager = getWalletManager(entry.backend);

  entry.wallet->setListener(nullptr);

  manager->closeWallet(entry.wallet);
  
  g_wallets.erase(walletId);
  
  return "ok";
}

/**
 * Get all transactions with pagination.
 * Args: walletId, page (0-indexed), pageSize, sort ("asc" or "desc")
 * Returns: JSON with transactions array, totalCount, page, pageSize
 */
std::string getAllTransactions(const std::vector<const std::string> &args) {
  std::string walletId = args[0];
  int page = std::stoi(args[1]);
  int pageSize = std::stoi(args[2]);
  bool ascending = (args[3] == "asc");
  
  Monero::Wallet* wallet = findWalletOrThrow(walletId).wallet;
  
  Monero::TransactionHistory* history = wallet->history();
  history->refresh();
  std::vector<Monero::TransactionInfo*> txs = history->getAll();
  
  std::sort(txs.begin(), txs.end(), [ascending](Monero::TransactionInfo* a, Monero::TransactionInfo* b) {
    if (a->isPending() != b->isPending()) return !a->isPending();
    return ascending ? a->blockHeight() < b->blockHeight() : a->blockHeight() > b->blockHeight();
  });
  
  int totalCount = static_cast<int>(txs.size());
  int startIndex = page * pageSize;
  int endIndex = std::min(startIndex + pageSize, totalCount);
  
  std::string json = "{\"transactions\":[";
  for (int i = startIndex; i < endIndex; i++) {
    if (i > startIndex) json += ",";
    Monero::TransactionInfo* tx = txs[i];
    json += "{\"hash\":\"" + jsonEscape(tx->hash()) + "\",";
    json += "\"direction\":" + std::to_string(tx->direction()) + ",";
    json += "\"isPending\":" + std::string(tx->isPending() ? "true" : "false") + ",";
    json += "\"isFailed\":" + std::string(tx->isFailed() ? "true" : "false") + ",";
    json += "\"isCoinbase\":" + std::string(tx->isCoinbase() ? "true" : "false") + ",";
    json += "\"amount\":\"" + std::to_string(tx->amount()) + "\",";
    json += "\"fee\":\"" + std::to_string(tx->fee()) + "\",";
    json += "\"blockHeight\":" + std::to_string(tx->blockHeight()) + ",";
    json += "\"confirmations\":" + std::to_string(tx->confirmations()) + ",";
    json += "\"timestamp\":" + std::to_string(tx->timestamp()) + ",";
    json += "\"paymentId\":\"" + jsonEscape(tx->paymentId()) + "\",";
    json += "\"description\":\"" + jsonEscape(tx->description()) + "\",";
    json += "\"label\":\"" + jsonEscape(tx->label()) + "\",";
    json += "\"unlockTime\":" + std::to_string(tx->unlockTime()) + ",";
    json += "\"subaddrAccount\":" + std::to_string(tx->subaddrAccount());
    
    try {
      std::string txKey = wallet->getTxKey(tx->hash());
      if (!txKey.empty()) {
        json += ",\"txKey\":\"" + jsonEscape(txKey) + "\"";
      }
    } catch (...) {
    }
    
    json += "}";
  }
  json += "],\"totalCount\":" + std::to_string(totalCount) + ",";
  json += "\"page\":" + std::to_string(page) + ",\"pageSize\":" + std::to_string(pageSize) + "}";
  
  return json;
}

/** Helper to split a comma-separated string. */
static std::vector<std::string> splitString(const std::string& str, char delimiter) {
  std::vector<std::string> tokens;
  std::stringstream ss(str);
  std::string token;
  while (std::getline(ss, token, delimiter)) {
    tokens.push_back(token);
  }
  return tokens;
}

/**
 * Create a transaction (multi-recipient supported).
 * Args: walletId, addresses (comma-separated), amounts (comma-separated), priority, documentDirectory
 * Returns: JSON with txid, signedTxHex, and fee
 */
std::string createTransaction(const std::vector<const std::string> &args) {
  std::string walletId = args[0];
  std::string addressesStr = args[1];
  std::string amountsStr = args[2];
  int priority = std::stoi(args[3]);
  std::string documentDirectory = args[4];
  
  WalletEntry& entry = findWalletOrThrow(walletId);
  Monero::Wallet* wallet = entry.wallet;
  
  std::vector<std::string> addresses = splitString(addressesStr, ',');
  std::vector<std::string> amountStrs = splitString(amountsStr, ',');
  
  if (addresses.empty() || addresses.size() != amountStrs.size()) {
    throw std::runtime_error("Addresses and amounts must have same length and not be empty");
  }
  
  std::vector<uint64_t> amounts;
  for (const auto& amt : amountStrs) {
    amounts.push_back(std::stoull(amt));
  }

  Monero::optional<std::vector<uint64_t>> optAmounts;
  if (addresses.size() == 1 && amounts.size() == 1 && amounts[0] == 0) {
    optAmounts = std::nullopt;
  } else {
    optAmounts = amounts;
  }
  
  wallet->pauseRefresh();
  
  Monero::PendingTransaction* ptx = wallet->createTransactionMultDest(
    addresses,
    "",
    optAmounts,
    0,
    static_cast<Monero::PendingTransaction::Priority>(priority)
  );
  
  wallet->startRefresh();
  
  if (ptx == nullptr) {
    throw std::runtime_error("Failed to create transaction");
  }
  
  if (ptx->status() != Monero::PendingTransaction::Status_Ok) {
    std::string error = ptx->errorString();
    wallet->disposeTransaction(ptx);
    throw std::runtime_error("Transaction error: " + error);
  }
  
  std::vector<std::string> txIds = ptx->txid();
  std::string txHash = txIds.empty() ? "" : txIds[0];
  uint64_t fee = ptx->fee();
  
  std::string tempFile = documentDirectory + "/tx_" + std::to_string(++gTxFileCounter) + ".signed";
  
  if (!ptx->commit(tempFile, true)) {
    std::string error = ptx->errorString();
    wallet->disposeTransaction(ptx);
    throw std::runtime_error("Failed to save transaction: " + error);
  }
  
  wallet->disposeTransaction(ptx);
  
  std::ifstream file(tempFile, std::ios::binary);
  if (!file.is_open()) {
    throw std::runtime_error("Failed to read signed transaction file");
  }
  std::string fileContents((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
  file.close();
  
  std::remove(tempFile.c_str());
  
  std::string signedTxHex = epee::string_tools::buff_to_hex_nodelimer(fileContents);
  
  return "{\"txid\":\"" + txHash + "\",\"signedTxHex\":\"" + signedTxHex + "\",\"fee\":\"" + std::to_string(fee) + "\"}";
}

/**
 * Broadcast a previously created transaction.
 * Args: walletId, signedTxHex (hex string from createTransaction), documentDirectory
 * Returns: "success" on success (txid is obtained from createTransaction result)
 */
std::string broadcastTransaction(const std::vector<const std::string> &args) {
  std::string walletId = args[0];
  std::string signedTxHex = args[1];
  std::string documentDirectory = args[2];
  
  WalletEntry& entry = findWalletOrThrow(walletId);
  Monero::Wallet* wallet = entry.wallet;
  
  std::string signedTxBlob;
  if (!epee::string_tools::parse_hexstr_to_binbuff(signedTxHex, signedTxBlob)) {
    throw std::runtime_error("Invalid hex string");
  }
  
  std::string tempFile = documentDirectory + "/tx_broadcast_" + std::to_string(++gTxFileCounter) + ".signed";
  std::ofstream file(tempFile, std::ios::binary);
  if (!file.is_open()) {
    throw std::runtime_error("Failed to create temp file for broadcast");
  }
  file.write(signedTxBlob.data(), signedTxBlob.size());
  file.close();
  
  bool success = wallet->submitTransaction(tempFile);
  
  std::remove(tempFile.c_str());
  
  if (!success) {
    throw std::runtime_error("Broadcast failed: " + wallet->errorString());
  }
  
  return "success";
}

/** Helper: escape a string for JSON (escape backslash and double-quote). */
static std::string jsonEscape(const std::string& s) {
  std::string result;
  result.reserve(s.size());
  for (char c : s) {
    if (c == '\\') result += "\\\\";
    else if (c == '"') result += "\\\"";
    else if (c == '\n') result += "\\n";
    else if (c == '\r') result += "\\r";
    else if (c == '\t') result += "\\t";
    else result += c;
  }
  return result;
}

/**
 * Parse a monero: URI.
 * Args: uri, nettype
 * Returns: JSON with address, paymentId, amount, txDescription, recipientName, unknownParameters
 * or JSON with error field on failure
 */
std::string parseUri(const std::vector<const std::string> &args) {
  std::string uri = args[0];
  int nettype = std::stoi(args[1]);
  Monero::Wallet* wallet = findWalletByNettype(nettype);

  std::string address;
  std::string paymentId;
  uint64_t amount = 0;
  std::string txDescription;
  std::string recipientName;
  std::vector<std::string> unknownParameters;
  std::string error;

  if (!wallet->parse_uri(uri, address, paymentId, amount, txDescription, recipientName, unknownParameters, error)) {
    return "{\"error\":\"" + jsonEscape(error) + "\"}";
  }

  std::string json = "{";
  json += "\"address\":\"" + jsonEscape(address) + "\",";
  json += "\"paymentId\":\"" + jsonEscape(paymentId) + "\",";
  json += "\"amount\":\"" + std::to_string(amount) + "\",";
  json += "\"txDescription\":\"" + jsonEscape(txDescription) + "\",";
  json += "\"recipientName\":\"" + jsonEscape(recipientName) + "\",";
  json += "\"unknownParameters\":[";
  for (size_t i = 0; i < unknownParameters.size(); ++i) {
    if (i > 0) json += ",";
    json += "\"" + jsonEscape(unknownParameters[i]) + "\"";
  }
  json += "]}";

  return json;
}

/**
 * Encode a monero: URI.
 * Args: address, paymentId, amount (atomic string), txDescription, recipientName, nettype
 * Returns: URI string, or JSON with error field on failure
 */
std::string encodeUri(const std::vector<const std::string> &args) {
  std::string address = args[0];
  std::string paymentId = args[1];
  std::string amountStr = args[2];
  std::string txDescription = args[3];
  std::string recipientName = args[4];
  int nettype = std::stoi(args[5]);
  Monero::Wallet* wallet = findWalletByNettype(nettype);

  uint64_t amount = 0;
  if (!amountStr.empty() && amountStr != "0") {
    try {
      amount = std::stoull(amountStr);
    } catch (...) {
      return "{\"error\":\"Invalid amount: " + jsonEscape(amountStr) + "\"}";
    }
  }

  std::string error;
  std::string uri = wallet->make_uri(address, paymentId, amount, txDescription, recipientName, error);

  if (uri.empty()) {
    return "{\"error\":\"" + jsonEscape(error) + "\"}";
  }

  return uri;
}

/**
 * Set the API key for LWS requests.
 * Args: apiKey
 * Returns: "ok"
 */
std::string setLwsApiKey(const std::vector<const std::string> &args) {
  std::string apiKey = args[0];
  lwsf::config::set_api_key(apiKey);
  return "ok";
}

const MoneroMethod moneroMethods[] = {
  { "hello", 0, hello },
  { "generateWallet", 2, generateWallet },
  { "seedAndKeysFromMnemonic", 2, seedAndKeysFromMnemonic },
  { "getNetworkBlockHeight", 3, getNetworkBlockHeight },
  { "isValidAddress", 2, isValidAddress },
  { "openWallet", 8, openWallet },
  { "getWalletStatus", 1, getWalletStatus },
  { "getAllTransactions", 4, getAllTransactions },
  { "closeWallet", 1, closeWallet },
  { "createTransaction", 5, createTransaction },
  { "broadcastTransaction", 3, broadcastTransaction },
  { "parseUri", 2, parseUri },
  { "encodeUri", 6, encodeUri },
  { "setLwsApiKey", 1, setLwsApiKey },
};

const unsigned moneroMethodCount = std::end(moneroMethods) - std::begin(moneroMethods);
