"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const ejs = require("ejs");

const viewsDir = path.join(__dirname, "..", "src", "views", "pages", "admin", "logs");

function extractKnownInlineScript(html) {
  const openingTag = "<script>";
  const closingTag = "</script>";
  const contentStart = html.indexOf(openingTag);
  assert.notEqual(contentStart, -1, "expected an inline script opening tag");

  const scriptStart = contentStart + openingTag.length;
  const scriptEnd = html.indexOf(closingTag, scriptStart);
  assert.notEqual(scriptEnd, -1, "expected an inline script closing tag");
  return html.slice(scriptStart, scriptEnd);
}

test("admin log modal clones a parsed image instead of reinterpreting a URL", async () => {
  const rendered = await ejs.renderFile(path.join(viewsDir, "logs_scripts.ejs"), {
    pages: 1,
    rows: [],
    user: { discord_id: "1" },
  });
  const script = extractKnownInlineScript(rendered);

  assert.doesNotThrow(() => new Function(script));
  assert.match(script, /previewImage\.cloneNode\(false\)/);
  assert.doesNotMatch(script, /getAttribute\(['"]data-fullscreen-image/);
  assert.doesNotMatch(script, /\.src\s*=/);
});

test("admin log preview URL stays escaped in its original image attribute", async () => {
  const rendered = await ejs.renderFile(path.join(viewsDir, "logs_cards.ejs"), {
    cards: [
      {
        type: "command_image",
        createdAt: 0,
        previewUrl: 'https://example.com/image.png" onerror="alert(1)',
        previewLabel: "Preview",
        pretty: "{}",
      },
    ],
    userChip: () => "",
  });

  assert.doesNotMatch(rendered, /data-fullscreen-image/);
  assert.match(rendered, /&#34; onerror=&#34;/);
  assert.doesNotMatch(rendered, /src="[^"]*" onerror=/);
});
