"use strict";

const crypto = require("crypto");

const API_KEY_HASH_PREFIX = "hmac-sha256-v1:";

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

  function hashLegacyApiKey(rawValue) {
    // Compatibility only: a successful match is immediately replaced with
    // the keyed format. Existing API keys cannot otherwise be migrated
    // because their cleartext values were never stored.
    // lgtm[js/insufficient-password-hash]
    return crypto
      .createHash("sha256")
      .update(String(rawValue || ""), "utf8")
      .digest("hex");
  }

  function isCurrentApiKeyHash(value) {
    return String(value || "").startsWith(API_KEY_HASH_PREFIX);
  }

  return {
    hashApiKey,
    hashLegacyApiKey,
    isCurrentApiKeyHash,
  };
}

module.exports = {
  API_KEY_HASH_PREFIX,
  createApiKeyHasher,
};
