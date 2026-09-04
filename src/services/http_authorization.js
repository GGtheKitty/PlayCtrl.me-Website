"use strict";

function parseBearerToken(rawAuthorization) {
  const authorization = String(rawAuthorization || "").trim();
  const separatorIndex = authorization.indexOf(" ");
  if (separatorIndex <= 0) return "";

  const scheme = authorization.slice(0, separatorIndex);
  if (scheme.toLowerCase() !== "bearer") return "";

  return authorization.slice(separatorIndex + 1).trim();
}

module.exports = { parseBearerToken };
