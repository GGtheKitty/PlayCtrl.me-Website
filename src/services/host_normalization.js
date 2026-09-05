"use strict";

function normalizeHost(rawHost) {
  const host = String(rawHost || "").trim().toLowerCase();
  let end = host.length;

  while (end > 0 && host.charCodeAt(end - 1) === 47) {
    end -= 1;
  }

  return end === host.length ? host : host.slice(0, end);
}

module.exports = { normalizeHost };
