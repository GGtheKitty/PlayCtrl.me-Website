"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  API_KEY_HASH_PREFIX,
  createApiKeyHasher,
} = require("../src/services/api_key_hashing");

test("API keys use a deterministic, versioned keyed hash", () => {
  const first = createApiKeyHasher({ pepper: "first-test-pepper" });
  const second = createApiKeyHasher({ pepper: "second-test-pepper" });
  const raw = "pc_example-api-key";

  const firstHash = first.hashApiKey(raw);
  assert.match(firstHash, new RegExp(`^${API_KEY_HASH_PREFIX}[a-f0-9]{64}$`));
  assert.equal(first.hashApiKey(raw), firstHash);
  assert.notEqual(second.hashApiKey(raw), firstHash);
  assert.equal(first.isCurrentApiKeyHash(firstHash), true);
});

test("legacy hashes remain detectable for one-time migration", () => {
  const hasher = createApiKeyHasher({ pepper: "test-pepper" });
  const legacyHash = hasher.hashLegacyApiKey("pc_example-api-key");

  assert.match(legacyHash, /^[a-f0-9]{64}$/);
  assert.equal(hasher.isCurrentApiKeyHash(legacyHash), false);
  assert.notEqual(hasher.hashApiKey("pc_example-api-key"), legacyHash);
});

test("API key hashing requires a server-side secret", () => {
  assert.throws(() => createApiKeyHasher(), /api_key_hash_pepper_required/);
});
