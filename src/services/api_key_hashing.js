"use strict";

const crypto = require("crypto");

const API_KEY_HASH_PREFIX = "hmac-sha256-v1:";
const API_KEY_PREFIX = "pc_";
const API_KEY_RANDOM_LENGTH = 43;

function isGeneratedApiKey(value) {
  const apiKey = String(value || "");
  if (
    apiKey.length !== API_KEY_PREFIX.length + API_KEY_RANDOM_LENGTH ||
    !apiKey.startsWith(API_KEY_PREFIX)
  ) {
    return false;
  }

  for (let index = API_KEY_PREFIX.length; index < apiKey.length; index += 1) {
    const code = apiKey.charCodeAt(index);
    const isDigit = code >= 48 && code <= 57;
    const isUppercase = code >= 65 && code <= 90;
    const isLowercase = code >= 97 && code <= 122;
    if (!isDigit && !isUppercase && !isLowercase && code !== 45 && code !== 95) {
      return false;
    }
  }

  return true;
}

function createApiKeyHasher({ pepper } = {}) {
  const secret = String(pepper || "");
  if (!secret) throw new Error("api_key_hash_pepper_required");

  function hashApiKey(rawValue) {
    const raw = String(rawValue || "");
    const digest = crypto
      .createHmac("sha256", secret)
      .update("playctrl-api-key\0", "utf8")
      .update(raw, "utf8")
      .digest("hex");
    return `${API_KEY_HASH_PREFIX}${digest}`;
  }

  function legacyApiKeyLookupDigest(rawValue) {
    if (!isGeneratedApiKey(rawValue)) return null;

    // Existing 256-bit random API keys cannot be migrated before their next
    // use because their cleartext values were never stored. A successful
    // compatibility lookup is immediately replaced with the keyed format.
    return crypto
      .createHash("sha256")
      // codeql[js/insufficient-password-hash] High-entropy API key migration.
      .update(String(rawValue || ""), "utf8")
      .digest("hex");
  }

  function isCurrentApiKeyHash(value) {
    return String(value || "").startsWith(API_KEY_HASH_PREFIX);
  }

  return {
    hashApiKey,
    legacyApiKeyLookupDigest,
    isCurrentApiKeyHash,
  };
}

module.exports = {
  API_KEY_HASH_PREFIX,
  createApiKeyHasher,
  isGeneratedApiKey,
};
