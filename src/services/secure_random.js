"use strict";

const crypto = require("crypto");

function randomStringFromAlphabet(
  rawAlphabet,
  length,
  randomInt = crypto.randomInt,
) {
  const alphabet = String(rawAlphabet || "");
  if (alphabet.length < 2 || new Set(alphabet).size !== alphabet.length) {
    throw new Error("random_alphabet_must_contain_unique_characters");
  }
  if (!Number.isSafeInteger(length) || length < 1 || length > 4096) {
    throw new Error("invalid_random_string_length");
  }

  let result = "";
  for (let index = 0; index < length; index += 1) {
    result += alphabet[randomInt(alphabet.length)];
  }
  return result;
}

function randomSixDigitCode(randomInt = crypto.randomInt) {
  return String(randomInt(100000, 1000000));
}

module.exports = {
  randomSixDigitCode,
  randomStringFromAlphabet,
};
