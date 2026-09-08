const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CHAT_MESSAGE_MAX_LENGTH,
  buildChatMessageContent,
  isChatImageUrl,
  isChatVideoUrl,
  normalizeChatMessageBody,
  normalizeMuteDuration,
} = require("../src/routes/chat");

test("normalizeChatMessageBody compacts whitespace and trims input", () => {
  assert.equal(normalizeChatMessageBody("  hello\n\t  world  "), "hello\n world");
});

test("normalizeChatMessageBody enforces the public message limit", () => {
  assert.equal(
    normalizeChatMessageBody("x".repeat(CHAT_MESSAGE_MAX_LENGTH + 25)).length,
    CHAT_MESSAGE_MAX_LENGTH,
  );
});

test("normalizeMuteDuration accepts supported values and defaults safely", () => {
  assert.equal(normalizeMuteDuration("7D"), "7d");
  assert.equal(normalizeMuteDuration("permanent"), "permanent");
  assert.equal(normalizeMuteDuration("unexpected"), "24h");
});

test("isChatImageUrl recognizes direct and formatted HTTP image URLs", () => {
  assert.equal(isChatImageUrl("https://cdn.example.test/photo.webp?size=large"), true);
  assert.equal(isChatImageUrl("https://cdn.example.test/render?id=1&format=png"), true);
  assert.equal(isChatImageUrl("https://example.test/page"), false);
  assert.equal(isChatImageUrl("javascript:alert(1)"), false);
});

test("isChatVideoUrl recognizes browser-playable video URLs", () => {
  assert.equal(isChatVideoUrl("https://cdn.example.test/clip.mp4?token=abc"), true);
  assert.equal(isChatVideoUrl("https://cdn.example.test/render?id=1&format=webm"), true);
  assert.equal(isChatVideoUrl("https://example.test/watch/123"), false);
  assert.equal(isChatVideoUrl("file:///tmp/video.mp4"), false);
});

test("buildChatMessageContent replaces image URLs while preserving message text", () => {
  assert.deepEqual(
    buildChatMessageContent("Look at https://cdn.example.test/photo.jpg! Nice."),
    {
      text: "Look at ! Nice.",
      imageUrls: ["https://cdn.example.test/photo.jpg"],
      videoUrls: [],
    },
  );
});

test("buildChatMessageContent supports image-only messages and caps embeds", () => {
  const urls = Array.from(
    { length: 5 },
    (_, index) => `https://cdn.example.test/${index}.png`,
  );
  const result = buildChatMessageContent(urls.join(" "));
  assert.equal(result.imageUrls.length, 4);
  assert.equal(result.videoUrls.length, 0);
  assert.equal(result.text, urls[4]);
});

test("buildChatMessageContent embeds videos and removes their URLs from text", () => {
  assert.deepEqual(
    buildChatMessageContent("Watch this https://cdn.example.test/clip.mp4"),
    {
      text: "Watch this",
      imageUrls: [],
      videoUrls: ["https://cdn.example.test/clip.mp4"],
    },
  );
});
