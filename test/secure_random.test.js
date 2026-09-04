"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  randomSixDigitCode,
  randomStringFromAlphabet,
} = require("../src/services/secure_random");

test("selects each random string character with bounded randomInt", () => {
  const bounds = [];
  let nextIndex = 0;
  const result = randomStringFromAlphabet("ABCD", 6, (maximum) => {
    bounds.push(maximum);
    const selected = nextIndex % maximum;
    nextIndex += 1;
    return selected;
  });

  assert.equal(result, "ABCDAB");
  assert.deepEqual(bounds, [4, 4, 4, 4, 4, 4]);
});

test("rejects alphabets that could distort output probabilities", () => {
  assert.throws(
    () => randomStringFromAlphabet("AABC", 4),
    /random_alphabet_must_contain_unique_characters/,
  );
  assert.throws(
    () => randomStringFromAlphabet("A", 4),
    /random_alphabet_must_contain_unique_characters/,
  );
});

test("generates a six-digit code with secure integer bounds", () => {
  let receivedBounds = null;
  const code = randomSixDigitCode((minimum, maximum) => {
    receivedBounds = [minimum, maximum];
    return 654321;
  });

  assert.equal(code, "654321");
  assert.deepEqual(receivedBounds, [100000, 1000000]);
});

test("generated values have the expected format", () => {
  const inviteCode = randomStringFromAlphabet(
    "ABCDEFGHJKLMNPQRSTUVWXYZ23456789",
    12,
  );
  assert.match(inviteCode, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{12}$/);
  assert.match(randomSixDigitCode(), /^\d{6}$/);
});
