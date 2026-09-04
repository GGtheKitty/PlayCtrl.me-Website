"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  decodeHtmlAttribute,
  fetchHtmlDocument,
  isPublicIpAddress,
  validateOutboundUrl,
} = require("../src/services/media_url_resolvers");

test("decodes HTML attribute entities exactly once", () => {
  assert.equal(
    decodeHtmlAttribute("a&amp;b &quot;c&quot; &#39;d&#39; &lt;e&gt;"),
    `a&b "c" 'd' <e>`,
  );
  assert.equal(decodeHtmlAttribute("&amp;quot;"), "&quot;");
  assert.equal(decodeHtmlAttribute("&amp;#39;"), "&#39;");
  assert.equal(decodeHtmlAttribute("&amp;amp;"), "&amp;");
});

test("accepts publicly routable IP addresses", () => {
  assert.equal(isPublicIpAddress("8.8.8.8"), true);
  assert.equal(isPublicIpAddress("1.1.1.1"), true);
  assert.equal(isPublicIpAddress("2001:4860:4860::8888"), true);
});

test("rejects private and special-use IP addresses", () => {
  for (const address of [
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.0.1",
    "224.0.0.1",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
  ]) {
    assert.equal(isPublicIpAddress(address), false, address);
  }
});

test("rejects credentials and non-standard ports in upstream URLs", () => {
  assert.throws(
    () => validateOutboundUrl("https://user:secret@example.com/page"),
    /upstream_credentials_not_allowed/,
  );
  assert.throws(
    () => validateOutboundUrl("https://example.com:8443/page"),
    /non_standard_upstream_port/,
  );
  assert.throws(
    () => validateOutboundUrl("file:///etc/passwd"),
    /unsupported_upstream_protocol/,
  );
});

test("blocks literal internal destinations before connecting", async () => {
  await assert.rejects(
    fetchHtmlDocument("http://127.0.0.1/"),
    /non_public_upstream_address/,
  );
  await assert.rejects(
    fetchHtmlDocument("http://169.254.169.254/latest/meta-data/"),
    /non_public_upstream_address/,
  );
});
