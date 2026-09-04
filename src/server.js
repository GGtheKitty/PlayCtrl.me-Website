const path = require("path");
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");
const cors = require("cors");
const { rateLimit } = require("express-rate-limit");
const fs = require("fs");
const { Readable } = require("stream");
require("dotenv").config();
const cookieParser = require("cookie-parser");
const db = require("./db");
const { renderWithLayout } = require("./views/render");
const { createAuthMiddleware } = require("./middleware/auth");
const { createAdminActivityService } = require("./services/admin_activity");
const { createApiKeyHasher } = require("./services/api_key_hashing");
const {
  createMediaUrlResolverService,
} = require("./services/media_url_resolvers");
const { createNotificationService } = require("./services/notifications");
const {
  randomSixDigitCode,
  randomStringFromAlphabet,
} = require("./services/secure_random");
const {
  createClientPairingCredentialService,
} = require("./services/client_pairing_credentials");
const { createRealtimeService } = require("./realtime/devices");
const { registerAdminRoutes } = require("./routes/admin");
const { registerCommandRoutes } = require("./routes/commands");
const { registerControlLinkRoutes } = require("./routes/control_links");
const { registerDiscoveryRoutes } = require("./routes/discovery");
const { registerProfileRoutes } = require("./routes/profile");

const PORT = process.env.PORT || 8080;
const SITE_ORIGIN = String(process.env.SITE_ORIGIN || "https://playctrl.me")
  .trim()
  .replace(/\/+$/, "");
const INDEXABLE_ROBOTS_VALUE = "index, follow";
const NOINDEX_ROBOTS_VALUE =
  "noindex, nofollow, noarchive, nosnippet, noimageindex";

const PEPPER = process.env.PEPPER || "pepper_change_me";

function isEnvFlagEnabled(...values) {
  for (const raw of values) {
    const value = String(raw ?? "").trim().toLowerCase();
    if (!value) continue;
    if (["1", "true", "yes", "on"].includes(value)) return true;
    if (["0", "false", "no", "off"].includes(value)) return false;
  }
  return false;
}

const CATALOG_PRUNE = isEnvFlagEnabled(
  process.env.LIST_CATALOG_PRUNE,
  process.env.CATALOG_PRUNE,
);

const HEAVY_COOLDOWN_MS = 8000;

const MB = 1024 * 1024;
const GB = 1024 * 1024 * 1024;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const AWAY_WINDOW_MS = DAY_MS;
const WEB_RATE_LIMIT_WINDOW_MS = Math.max(
  1000,
  Number(process.env.WEB_RATE_LIMIT_WINDOW_MS) || 60 * 1000,
);
const WEB_RATE_LIMIT_MAX = Math.max(
  1,
  Number(process.env.WEB_RATE_LIMIT_MAX) || 300,
);
const WEB_WRITE_RATE_LIMIT_MAX = Math.max(
  1,
  Number(process.env.WEB_WRITE_RATE_LIMIT_MAX) || 60,
);
const QUEUED_COMMAND_SEND_DELAY_MS = Number(
  process.env.QUEUED_COMMAND_SEND_DELAY_MS || 5000,
);
const QUEUED_COMMAND_PURGE_EVERY_MS = Number(
  process.env.QUEUED_COMMAND_PURGE_EVERY_MS || 60 * 1000,
);
const QUEUED_COMMAND_PURGE_LIMIT = Number(
  process.env.QUEUED_COMMAND_PURGE_LIMIT || 200,
);

// How long to keep response files (default 6 hours)
const RESP_TTL_MS = Number(process.env.RESP_TTL_MS || 6 * 60 * 60 * 1000);

// How often to run cleanup (default every 10 minutes)
const RESP_JANITOR_EVERY_MS = Number(process.env.RESP_JANITOR_EVERY_MS || 10 * 60 * 1000);

// Safety: max deletions per run
const RESP_JANITOR_LIMIT = Number(process.env.RESP_JANITOR_LIMIT || 250);

const UPLOAD_TTL_MS = Number(
  process.env.UPLOAD_TTL_MS || 24 * 60 * 60 * 1000,
);
const QUEUED_UPLOAD_REPORT_GRACE_MS = Number(
  process.env.QUEUED_UPLOAD_REPORT_GRACE_MS || 10 * 60 * 1000,
);
const UPLOAD_JANITOR_EVERY_MS = Number(
  process.env.UPLOAD_JANITOR_EVERY_MS || 10 * 60 * 1000,
);
const UPLOAD_JANITOR_LIMIT = Number(process.env.UPLOAD_JANITOR_LIMIT || 500);
const UPLOADS_MAX_BYTES = Number(
  process.env.UPLOADS_MAX_BYTES || 25 * GB,
);
const UPLOADS_PER_USER_MAX_BYTES = Number(
  process.env.UPLOADS_PER_USER_MAX_BYTES || 250 * MB,
);
const UPLOADS_PER_USER_MAX_FILES = Number(
  process.env.UPLOADS_PER_USER_MAX_FILES || 50,
);
const SITE_AVATAR_FETCH_SIZE = Number(
  process.env.SITE_AVATAR_FETCH_SIZE || 256,
);
const UPLOAD_RECENT_LIST_LIMIT = Number(
  process.env.UPLOAD_RECENT_LIST_LIMIT || 18,
);
const UPLOAD_IMAGE_MAX_BYTES = Number(
  process.env.UPLOAD_IMAGE_MAX_BYTES || 8 * MB,
);
const UPLOAD_ANIMATED_MAX_BYTES = Number(
  process.env.UPLOAD_ANIMATED_MAX_BYTES || 30 * MB,
);
const UPLOAD_AUDIO_MAX_BYTES = Number(
  process.env.UPLOAD_AUDIO_MAX_BYTES || 15 * MB,
);
const UPLOAD_REQUEST_LIMIT_MB = Math.max(
  10,
  Math.ceil(
    ((Math.max(
      UPLOAD_IMAGE_MAX_BYTES,
      UPLOAD_ANIMATED_MAX_BYTES,
      UPLOAD_AUDIO_MAX_BYTES,
    ) *
      4) /
      3 +
      2 * MB) /
      MB,
  ),
);
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, "../uploads");
const REPORT_MEDIA_BACKUPS_DIR =
  process.env.REPORT_MEDIA_BACKUPS_DIR ||
  path.join(__dirname, "report_media_backups");
const RESPONSES_DIR =
  process.env.RESPONSES_DIR || path.join(__dirname, "responses_store");
const SITE_AVATARS_DIR =
  process.env.SITE_AVATARS_DIR || path.join(__dirname, "../site_avatars");
const SITE_CUSTOM_AVATARS_DIR = path.join(SITE_AVATARS_DIR, "custom");
const SITE_CUSTOM_BANNERS_DIR = path.join(SITE_AVATARS_DIR, "banners");
const SITE_CUSTOM_BACKGROUNDS_DIR = path.join(SITE_AVATARS_DIR, "backgrounds");
const DEFAULT_SITE_AVATAR_PATH = path.join(
  __dirname,
  "../public/default-avatar.svg",
);
const INLINE_DEFAULT_SITE_AVATAR_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" role="img" aria-label="Default avatar">
  <rect width="128" height="128" rx="28" fill="#232733"/>
  <circle cx="64" cy="46" r="24" fill="#9aa3b2"/>
  <path d="M28 108c4-20 20-32 36-32s32 12 36 32" fill="#9aa3b2"/>
</svg>
`.trim();
const CUSTOM_SITE_AVATAR_MAX_BYTES = Number(
  process.env.CUSTOM_SITE_AVATAR_MAX_BYTES || 4 * MB,
);
const CUSTOM_SITE_BANNER_MAX_BYTES = Number(
  process.env.CUSTOM_SITE_BANNER_MAX_BYTES || 8 * MB,
);
const CUSTOM_SITE_BACKGROUND_MAX_BYTES = Number(
  process.env.CUSTOM_SITE_BACKGROUND_MAX_BYTES || 12 * MB,
);
const NOTIFICATION_MENU_LIMIT = Number(
  process.env.NOTIFICATION_MENU_LIMIT || 6,
);
const NOTIFICATION_PAGE_LIMIT = Number(
  process.env.NOTIFICATION_PAGE_LIMIT || 200,
);
const NOTIFICATION_TITLE_MAX_LEN = Number(
  process.env.NOTIFICATION_TITLE_MAX_LEN || 120,
);
const NOTIFICATION_MESSAGE_MAX_LEN = Number(
  process.env.NOTIFICATION_MESSAGE_MAX_LEN || 600,
);
const NOTIFICATION_ACTION_LABEL_MAX_LEN = Number(
  process.env.NOTIFICATION_ACTION_LABEL_MAX_LEN || 40,
);
const NOTIFICATION_KIND_MAX_LEN = Number(
  process.env.NOTIFICATION_KIND_MAX_LEN || 64,
);
const REPORTS_PAGE_LIMIT = Number(process.env.REPORTS_PAGE_LIMIT || 200);
const REPORTS_PAGE_SIZE = Number(process.env.REPORTS_PAGE_SIZE || 25);
const PROFILE_STRIKE_HISTORY_LIMIT = Number(
  process.env.PROFILE_STRIKE_HISTORY_LIMIT || 100,
);
const CUSTOM_CONTROL_URL_MIN_COMMANDS = Number(
  process.env.CUSTOM_CONTROL_URL_MIN_COMMANDS || 200,
);
const CUSTOM_CONTROL_URL_MIN_LEN = Number(
  process.env.CUSTOM_CONTROL_URL_MIN_LEN || 4,
);
const CUSTOM_CONTROL_URL_MAX_LEN = Number(
  process.env.CUSTOM_CONTROL_URL_MAX_LEN || 32,
);
const CUSTOM_CONTROL_URL_CHANGE_COOLDOWN_MS = Number(
  process.env.CUSTOM_CONTROL_URL_CHANGE_COOLDOWN_MS || 24 * 60 * 60 * 1000,
);
const COMMUNITY_GROUP_PUBLIC_MIN_COMMANDS = Number(
  process.env.COMMUNITY_GROUP_PUBLIC_MIN_COMMANDS || 100,
);
const COMMUNITY_GROUP_COMMAND_OPTIONS = Object.freeze([
  {
    key: "popup",
    field: "allow_popup",
    label: "Send Message",
    description: "Allow regular text popups for this community group.",
  },
  {
    key: "subliminal_message",
    field: "allow_subliminal_message",
    label: "Subliminal Message",
    description: "Allow layered subliminal message sends.",
  },
  {
    key: "image_popup",
    field: "allow_image_popup",
    label: "Image Popup",
    description: "Allow normal image popup commands.",
  },
  {
    key: "fullscreen_popup",
    field: "allow_fullscreen_popup",
    label: "Fullscreen Popup",
    description: "Allow fullscreen image popups.",
  },
  {
    key: "spiral_overlay",
    field: "allow_spiral_overlay",
    label: "Spiral Overlay",
    description: "Allow swirl.3bu.dev spiral overlay links.",
    hiddenFromCommunitySettings: true,
  },
  {
    key: "open_url",
    field: "allow_open_url",
    label: "Open URL",
    description: "Allow sending URLs to open on member devices.",
  },
  {
    key: "set_wallpaper",
    field: "allow_set_wallpaper",
    label: "Set Wallpaper",
    description: "Allow wallpaper and supported wallpaper media commands.",
  },
  {
    key: "play_sound",
    field: "allow_play_sound",
    label: "Play Sound Effect",
    description: "Allow built-in or uploaded sound playback.",
  },
  {
    key: "write_for_me",
    field: "allow_write_for_me",
    label: "Write For Me",
    description: "Allow typed-text automation prompts.",
  },
]);
const PAIR_CODE_RESET_COOLDOWN_MS = Number(
  process.env.PAIR_CODE_RESET_COOLDOWN_MS || 10 * 60 * 1000,
);
const WHITELIST_SEARCH_MIN_LEN = Number(
  process.env.WHITELIST_SEARCH_MIN_LEN || 2,
);
const WHITELIST_SEARCH_RESULT_LIMIT = Number(
  process.env.WHITELIST_SEARCH_RESULT_LIMIT || 8,
);
const COMMAND_BLOCKS_PAGE_LIMIT = Number(
  process.env.COMMAND_BLOCKS_PAGE_LIMIT || 200,
);
const REPORT_DETAILS_MAX_LEN = Number(
  process.env.REPORT_DETAILS_MAX_LEN || 1000,
);
const MAX_USER_STRIKES = 3;
const REPORT_SUBJECT_TYPE_MAX_LEN = 64;
const ADMIN_REPORT_QUEUE_KIND = "admin_report_queue";
const ADMIN_REPORT_QUEUE_SOURCE_TYPE = "reports_queue";
const ADMIN_REPORT_QUEUE_SOURCE_ID = "control_link_reports";
const CONTROL_LINK_REPORT_REASON_OPTIONS = Object.freeze([
  {
    key: "non_consensual_or_harmful",
    label: "Non-consensual or harmful behavior",
    description: "Commands or behavior that feel coercive, threatening, or unsafe.",
  },
  {
    key: "underage_or_age_concern",
    label: "Underage or age concern",
    description: "Anything suggesting the user may be under 18 or misrepresenting age.",
  },
  {
    key: "spam_or_scam",
    label: "Spam or scam",
    description: "Mass messaging, phishing, scams, or deceptive links.",
  },
  {
    key: "malicious_or_unsafe_link",
    label: "Malicious or unsafe control link",
    description: "Contains content that is abusive, malware-related, or dangerous.",
  },
  {
    key: "impersonation_or_fake_profile",
    label: "Impersonation or fake profile",
    description: "Pretending to be someone else or misrepresenting identity.",
  },
  {
    key: "other",
    label: "Other",
    description: "Something else that should be reviewed by an admin.",
  },
]);
const COMMAND_HISTORY_REPORT_REASON_OPTIONS = Object.freeze([
  {
    key: "tos_non_consensual_or_harassment",
    label: "Harassment or non-consensual commands",
    description: "Commands that feel threatening, coercive, or targeted without consent.",
  },
  {
    key: "tos_spam_scam_or_phishing",
    label: "Spam, scam, or phishing",
    description: "Repeated command spam, deceptive links, phishing attempts, or scams.",
  },
  {
    key: "tos_malware_or_unsafe_media",
    label: "Malware or unsafe media",
    description: "Images, wallpapers, sounds, or URLs that appear malicious, exploitative, or unsafe.",
  },
  {
    key: "underage_or_age_concern",
    label: "Underage or age concern",
    description: "Anything suggesting the sender may be under 18 or misrepresenting age.",
  },
  {
    key: "command_abuse_or_disruption",
    label: "Command abuse or disruption",
    description: "Commands used to annoy, overwhelm, or repeatedly disrupt the recipient.",
  },
  {
    key: "other",
    label: "Other",
    description: "Something else about this command activity should be reviewed by an admin.",
  },
]);
const GROUP_CHAT_REPORT_REASON_OPTIONS = Object.freeze([
  {
    key: "group_chat_harassment",
    label: "Harassment or hateful content",
    description: "Abusive, threatening, hateful, or targeted messages.",
  },
  {
    key: "group_chat_spam_or_scam",
    label: "Spam, scam, or phishing",
    description: "Repeated spam, deceptive links, phishing attempts, or scams.",
  },
  {
    key: "group_chat_unsafe_content",
    label: "Unsafe or prohibited content",
    description: "Content that appears dangerous, exploitative, or otherwise prohibited.",
  },
  {
    key: "underage_or_age_concern",
    label: "Underage or age concern",
    description: "Anything suggesting a user may be under 18 or misrepresenting age.",
  },
  {
    key: "other",
    label: "Other",
    description: "Something else in this message should be reviewed by an admin.",
  },
]);
const CONTROL_LINK_REPORT_REASON_BY_KEY = new Map(
  CONTROL_LINK_REPORT_REASON_OPTIONS.map((option) => [option.key, option]),
);
const COMMAND_HISTORY_REPORT_REASON_BY_KEY = new Map(
  COMMAND_HISTORY_REPORT_REASON_OPTIONS.map((option) => [option.key, option]),
);
const GROUP_CHAT_REPORT_REASON_BY_KEY = new Map(
  GROUP_CHAT_REPORT_REASON_OPTIONS.map((option) => [option.key, option]),
);
const ALL_REPORT_REASON_BY_KEY = new Map(
  [
    ...CONTROL_LINK_REPORT_REASON_OPTIONS,
    ...COMMAND_HISTORY_REPORT_REASON_OPTIONS,
    ...GROUP_CHAT_REPORT_REASON_OPTIONS,
  ].map((option) => [option.key, option]),
);
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(REPORT_MEDIA_BACKUPS_DIR, { recursive: true });
fs.mkdirSync(RESPONSES_DIR, { recursive: true });
fs.mkdirSync(SITE_AVATARS_DIR, { recursive: true });
fs.mkdirSync(SITE_CUSTOM_AVATARS_DIR, { recursive: true });
fs.mkdirSync(SITE_CUSTOM_BANNERS_DIR, { recursive: true });
fs.mkdirSync(SITE_CUSTOM_BACKGROUNDS_DIR, { recursive: true });

function normalizedSitePath(pathname) {
  const rawPath = String(pathname || "").trim();
  if (!rawPath || rawPath === "/") return "/";
  return rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
}

function buildSiteUrl(pathname = "/") {
  const safePath = normalizedSitePath(pathname);
  if (safePath === "/") return `${SITE_ORIGIN}/`;
  return `${SITE_ORIGIN}${safePath}`;
}

function requestAllowsIndexing(req) {
  const method = String(req?.method || "").toUpperCase();
  if (method !== "GET" && method !== "HEAD") return false;
  return normalizedSitePath(req?.path) === "/";
}

function formatBytesCompact(bytes) {
  const n = Number(bytes || 0);
  if (!Number.isFinite(n) || n <= 0) return "0B";
  if (n >= GB) return `${(n / GB).toFixed(n >= 10 * GB ? 0 : 1)}GB`;
  if (n >= MB) return `${(n / MB).toFixed(n >= 10 * MB ? 0 : 1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(n >= 10 * 1024 ? 0 : 1)}KB`;
  return `${Math.round(n)}B`;
}

function formatWholeMegabytes(bytes, { spaced = true } = {}) {
  const n = Number(bytes || 0);
  if (!Number.isFinite(n) || n <= 0) return spaced ? "0 MB" : "0MB";
  const value = Math.round(n / MB);
  return spaced ? `${value} MB` : `${value}MB`;
}

const WALLPAPER_IMAGE_EXTENSIONS = ["png", "jpg", "jpeg"];
const WALLPAPER_MEDIA_IMAGE_EXTENSIONS = [
  ...WALLPAPER_IMAGE_EXTENSIONS,
  "webp",
  "gif",
];
const WALLPAPER_MEDIA_VIDEO_EXTENSIONS = ["webm", "ogg", "ogv"];
const WALLPAPER_MEDIA_EXTENSIONS = [
  ...WALLPAPER_MEDIA_IMAGE_EXTENSIONS,
  ...WALLPAPER_MEDIA_VIDEO_EXTENSIONS,
];
const IMAGE_POPUP_VISUAL_EXTENSIONS = [
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "webm",
  "mp4",
];

const UPLOAD_FILE_RULES = {
  png: {
    mimeTypes: ["image/png"],
    contexts: new Set([
      "image_popup",
      "fullscreen_popup",
      "set_wallpaper",
      "set_wallpaper_media",
    ]),
    maxBytes: UPLOAD_IMAGE_MAX_BYTES,
    previewKind: "image",
    mediaGroup: "visual",
    wallpaperCompatible: 1,
  },
  jpg: {
    mimeTypes: ["image/jpeg", "image/pjpeg"],
    contexts: new Set([
      "image_popup",
      "fullscreen_popup",
      "set_wallpaper",
      "set_wallpaper_media",
    ]),
    maxBytes: UPLOAD_IMAGE_MAX_BYTES,
    previewKind: "image",
    mediaGroup: "visual",
    wallpaperCompatible: 1,
  },
  jpeg: {
    mimeTypes: ["image/jpeg", "image/pjpeg"],
    contexts: new Set([
      "image_popup",
      "fullscreen_popup",
      "set_wallpaper",
      "set_wallpaper_media",
    ]),
    maxBytes: UPLOAD_IMAGE_MAX_BYTES,
    previewKind: "image",
    mediaGroup: "visual",
    wallpaperCompatible: 1,
  },
  webp: {
    mimeTypes: ["image/webp"],
    contexts: new Set(["image_popup", "fullscreen_popup", "set_wallpaper_media"]),
    maxBytes: UPLOAD_IMAGE_MAX_BYTES,
    previewKind: "image",
    mediaGroup: "visual",
    wallpaperCompatible: 0,
  },
  gif: {
    mimeTypes: ["image/gif"],
    contexts: new Set(["image_popup", "fullscreen_popup", "set_wallpaper_media"]),
    maxBytes: UPLOAD_ANIMATED_MAX_BYTES,
    previewKind: "image",
    mediaGroup: "visual",
    wallpaperCompatible: 0,
  },
  webm: {
    mimeTypes: ["video/webm"],
    contexts: new Set(["image_popup", "fullscreen_popup", "set_wallpaper_media"]),
    maxBytes: UPLOAD_ANIMATED_MAX_BYTES,
    previewKind: "video",
    mediaGroup: "visual",
    wallpaperCompatible: 0,
  },
  ogv: {
    mimeTypes: ["video/ogg", "video/ogv", "application/ogg"],
    contexts: new Set(["set_wallpaper_media"]),
    maxBytes: UPLOAD_ANIMATED_MAX_BYTES,
    previewKind: "video",
    mediaGroup: "visual",
    wallpaperCompatible: 0,
  },
  mp4: {
    mimeTypes: ["video/mp4"],
    contexts: new Set(["image_popup", "fullscreen_popup"]),
    maxBytes: UPLOAD_ANIMATED_MAX_BYTES,
    previewKind: "video",
    mediaGroup: "visual",
    wallpaperCompatible: 0,
  },
  mp3: {
    mimeTypes: ["audio/mpeg", "audio/mp3"],
    contexts: new Set(["play_sound"]),
    maxBytes: UPLOAD_AUDIO_MAX_BYTES,
    previewKind: "audio",
    mediaGroup: "audio",
    wallpaperCompatible: 0,
  },
  wav: {
    mimeTypes: ["audio/wav", "audio/wave", "audio/x-wav", "audio/vnd.wave"],
    contexts: new Set(["play_sound"]),
    maxBytes: UPLOAD_AUDIO_MAX_BYTES,
    previewKind: "audio",
    mediaGroup: "audio",
    wallpaperCompatible: 0,
  },
  m4a: {
    mimeTypes: ["audio/mp4", "audio/x-m4a", "audio/m4a"],
    contexts: new Set(["play_sound"]),
    maxBytes: UPLOAD_AUDIO_MAX_BYTES,
    previewKind: "audio",
    mediaGroup: "audio",
    wallpaperCompatible: 0,
  },
  aac: {
    mimeTypes: ["audio/aac", "audio/x-aac"],
    contexts: new Set(["play_sound"]),
    maxBytes: UPLOAD_AUDIO_MAX_BYTES,
    previewKind: "audio",
    mediaGroup: "audio",
    wallpaperCompatible: 0,
  },
  ogg: {
    mimeTypes: ["audio/ogg", "application/ogg"],
    contexts: new Set(["play_sound"]),
    maxBytes: UPLOAD_AUDIO_MAX_BYTES,
    previewKind: "audio",
    mediaGroup: "audio",
    wallpaperCompatible: 0,
  },
  oga: {
    mimeTypes: ["audio/ogg", "application/ogg"],
    contexts: new Set(["play_sound"]),
    maxBytes: UPLOAD_AUDIO_MAX_BYTES,
    previewKind: "audio",
    mediaGroup: "audio",
    wallpaperCompatible: 0,
  },
  flac: {
    mimeTypes: ["audio/flac", "audio/x-flac"],
    contexts: new Set(["play_sound"]),
    maxBytes: UPLOAD_AUDIO_MAX_BYTES,
    previewKind: "audio",
    mediaGroup: "audio",
    wallpaperCompatible: 0,
  },
  opus: {
    mimeTypes: ["audio/opus", "audio/ogg"],
    contexts: new Set(["play_sound"]),
    maxBytes: UPLOAD_AUDIO_MAX_BYTES,
    previewKind: "audio",
    mediaGroup: "audio",
    wallpaperCompatible: 0,
  },
  weba: {
    mimeTypes: ["audio/webm"],
    contexts: new Set(["play_sound"]),
    maxBytes: UPLOAD_AUDIO_MAX_BYTES,
    previewKind: "audio",
    mediaGroup: "audio",
    wallpaperCompatible: 0,
  },
  mpeg: {
    mimeTypes: ["audio/mpeg", "audio/mp3"],
    contexts: new Set(["play_sound"]),
    maxBytes: UPLOAD_AUDIO_MAX_BYTES,
    previewKind: "audio",
    mediaGroup: "audio",
    wallpaperCompatible: 0,
  },
  mpga: {
    mimeTypes: ["audio/mpeg", "audio/mp3"],
    contexts: new Set(["play_sound"]),
    maxBytes: UPLOAD_AUDIO_MAX_BYTES,
    previewKind: "audio",
    mediaGroup: "audio",
    wallpaperCompatible: 0,
  },
  wma: {
    mimeTypes: ["audio/x-ms-wma", "audio/wma", "application/vnd.ms-asf"],
    contexts: new Set(["play_sound"]),
    maxBytes: UPLOAD_AUDIO_MAX_BYTES,
    previewKind: "audio",
    mediaGroup: "audio",
    wallpaperCompatible: 0,
  },
  aif: {
    mimeTypes: ["audio/aiff", "audio/x-aiff"],
    contexts: new Set(["play_sound"]),
    maxBytes: UPLOAD_AUDIO_MAX_BYTES,
    previewKind: "audio",
    mediaGroup: "audio",
    wallpaperCompatible: 0,
  },
  aiff: {
    mimeTypes: ["audio/aiff", "audio/x-aiff"],
    contexts: new Set(["play_sound"]),
    maxBytes: UPLOAD_AUDIO_MAX_BYTES,
    previewKind: "audio",
    mediaGroup: "audio",
    wallpaperCompatible: 0,
  },
  mid: {
    mimeTypes: ["audio/midi", "audio/x-midi", "audio/mid"],
    contexts: new Set(["play_sound"]),
    maxBytes: UPLOAD_AUDIO_MAX_BYTES,
    previewKind: "audio",
    mediaGroup: "audio",
    wallpaperCompatible: 0,
  },
  midi: {
    mimeTypes: ["audio/midi", "audio/x-midi", "audio/mid"],
    contexts: new Set(["play_sound"]),
    maxBytes: UPLOAD_AUDIO_MAX_BYTES,
    previewKind: "audio",
    mediaGroup: "audio",
    wallpaperCompatible: 0,
  },
};

const WALLPAPER_MEDIA_OGG_VIDEO_UPLOAD_RULE = {
  mimeTypes: ["video/ogg", "video/ogv", "application/ogg"],
  contexts: new Set(["set_wallpaper_media"]),
  maxBytes: UPLOAD_ANIMATED_MAX_BYTES,
  previewKind: "video",
  mediaGroup: "visual",
  wallpaperCompatible: 0,
};

const UPLOAD_CONTEXT_UI = {
  image_popup: {
    accept: toUploadAcceptAttr(IMAGE_POPUP_VISUAL_EXTENSIONS),
    pickerAccept: toUploadAcceptAttr(IMAGE_POPUP_VISUAL_EXTENSIONS),
    title: "Upload",
    maxBytes: UPLOAD_ANIMATED_MAX_BYTES,
    hintLines: [
      `Images up to ${formatWholeMegabytes(UPLOAD_IMAGE_MAX_BYTES, { spaced: true })}`,
      `Animations and Videos up to ${formatWholeMegabytes(UPLOAD_ANIMATED_MAX_BYTES, { spaced: false })}`,
    ],
  },
  fullscreen_popup: {
    accept: toUploadAcceptAttr(IMAGE_POPUP_VISUAL_EXTENSIONS),
    pickerAccept: toUploadAcceptAttr(IMAGE_POPUP_VISUAL_EXTENSIONS),
    title: "Upload",
    maxBytes: UPLOAD_ANIMATED_MAX_BYTES,
    hintLines: [
      `Images up to ${formatWholeMegabytes(UPLOAD_IMAGE_MAX_BYTES, { spaced: true })}`,
      `Animations and Videos up to ${formatWholeMegabytes(UPLOAD_ANIMATED_MAX_BYTES, { spaced: false })}`,
    ],
  },
  set_wallpaper: {
    accept: toUploadAcceptAttr(WALLPAPER_IMAGE_EXTENSIONS),
    pickerAccept: toUploadAcceptAttr(WALLPAPER_IMAGE_EXTENSIONS),
    title: "Upload",
    maxBytes: UPLOAD_IMAGE_MAX_BYTES,
    hintLines: [
      `Images up to ${formatWholeMegabytes(UPLOAD_IMAGE_MAX_BYTES, { spaced: true })}`,
    ],
  },
  set_wallpaper_media: {
    accept: toUploadAcceptAttr(WALLPAPER_MEDIA_EXTENSIONS),
    pickerAccept: toUploadAcceptAttr(WALLPAPER_MEDIA_EXTENSIONS),
    title: "Upload",
    maxBytes: UPLOAD_ANIMATED_MAX_BYTES,
    hintLines: [
      `Images up to ${formatWholeMegabytes(UPLOAD_IMAGE_MAX_BYTES, { spaced: true })}`,
      `GIFs and Videos (.webm, .ogg, .ogv) up to ${formatWholeMegabytes(UPLOAD_ANIMATED_MAX_BYTES, { spaced: false })}`,
    ],
  },
  play_sound: {
    accept: "audio/*,.mp3,.mpeg,.mpga,.wav,.m4a,.aac,.ogg,.oga,.flac,.opus,.weba,.wma,.aif,.aiff,.mid,.midi",
    pickerAccept: "",
    title: "Upload",
    maxBytes: UPLOAD_AUDIO_MAX_BYTES,
    hintLines: [
      `Audio up to ${formatWholeMegabytes(UPLOAD_AUDIO_MAX_BYTES, { spaced: false })}`,
    ],
  },
};

const LISTS = {
  favorites: {
    key: "favorites",
    label: process.env.LIST_FAVORITES_LABEL || "Favorites",
    accent: "purple",
  },
  dislikes: {
    key: "dislikes",
    label: process.env.LIST_DISLIKES_LABEL || "Dislikes",
    accent: "danger",
  },
};

function resolveDataFilePath(value, defaultRelativePath) {
  const raw = String(value || "").trim();
  const target = raw || defaultRelativePath;
  return path.isAbsolute(target) ? target : path.join(__dirname, target);
}

const CATALOG = resolveDataFilePath(
  process.env.LIST_CATALOG,
  "data/kink_catalog.json",
);
const CLI_COMMAND = String(process.argv[2] || "").trim();
const IS_AVATAR_BACKFILL_CLI = CLI_COMMAND === "avatars:backfill";
const GROUPS = resolveDataFilePath(
  process.env.GROUPS_CATALOG,
  "data/groups_catalog.json",
);

const DISCORD_AUTH = "https://discord.com/oauth2/authorize";
const DISCORD_TOKEN = "https://discord.com/api/oauth2/token";
const DISCORD_ME = "https://discord.com/api/users/@me";

function b64url(buf) {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
function hmac(s) {
  return crypto.createHmac("sha256", PEPPER).update(s).digest("hex");
}
const CLIENT_PAIRING_ENCRYPTION_KEY =
  process.env.CLIENT_PAIRING_ENCRYPTION_KEY || `fallback:${PEPPER}`;
const API_KEY_HASH_PEPPER =
  process.env.API_KEY_HASH_PEPPER ||
  process.env.CLIENT_PAIRING_ENCRYPTION_KEY ||
  "";
if (!API_KEY_HASH_PEPPER && process.env.NODE_ENV === "production") {
  throw new Error(
    "API_KEY_HASH_PEPPER or CLIENT_PAIRING_ENCRYPTION_KEY is required in production",
  );
}
const {
  hashApiKey,
  hashLegacyApiKey,
  isCurrentApiKeyHash,
} = createApiKeyHasher({
  pepper: API_KEY_HASH_PEPPER || CLIENT_PAIRING_ENCRYPTION_KEY,
});
if (!process.env.CLIENT_PAIRING_ENCRYPTION_KEY) {
  console.warn(
    "[pairing] CLIENT_PAIRING_ENCRYPTION_KEY is not set; using the PEPPER-derived fallback.",
  );
}
const clientPairingCredentials = createClientPairingCredentialService({
  db,
  hmac,
  encryptionKey: CLIENT_PAIRING_ENCRYPTION_KEY,
});
function inviteHash(code) {
  return hmac("invite:" + String(code));
}

function genInviteCode() {
  return randomStringFromAlphabet(
    "ABCDEFGHJKLMNPQRSTUVWXYZ23456789",
    12,
  );
}

function gen6() {
  return randomSixDigitCode();
}

function genApiKey() {
  return "pc_" + crypto.randomBytes(32).toString("base64url");
}

function ensureUserApiKeyExists(userId) {
  const row = db
    .prepare(`SELECT key_hash FROM api_keys WHERE user_id=?`)
    .get(userId);
  if (row) return;

  const raw = genApiKey();
  const key_hash = hashApiKey(raw);
  const now = Date.now();

  db.prepare(
    `
    INSERT INTO api_keys (user_id, key_hash, created_at, last_reset_at)
    VALUES (?, ?, ?, ?)
  `,
  ).run(userId, key_hash, now, now);
}

function getApiKeyMeta(userId) {
  return (
    db
      .prepare(
        `
    SELECT created_at, last_reset_at
    FROM api_keys
    WHERE user_id=?
  `,
      )
      .get(userId) || null
  );
}

const DISCORD_EPOCH_MS = 1420070400000n;

function discordSnowflakeToMs(id) {
  try {
    const snowflake = BigInt(String(id));
    const timestamp = (snowflake >> 22n) + DISCORD_EPOCH_MS;
    return Number(timestamp);
  } catch {
    return null;
  }
}

function discordAccountAgeDays(discordId) {
  const createdMs = discordSnowflakeToMs(discordId);
  if (!createdMs) return null;
  const ageMs = Date.now() - createdMs;
  return ageMs / (1000 * 60 * 60 * 24);
}

function banDiscordIdSystem(targetId, req, payload = {}) {
  const reason = null;

  db.prepare(
    `
    INSERT INTO bans (discord_id, reason, banned_by, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(discord_id) DO UPDATE SET
      reason=excluded.reason,
      banned_by=excluded.banned_by,
      created_at=excluded.created_at
  `,
  ).run(targetId, reason, "system", Date.now());

  try {
    logEvent({
      type: "user_banned",
      actorUserId: "system",
      targetUserId: targetId,
      req,
      payload,
    });
  } catch {}
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  );
}

function inlineScriptJson(value) {
  const json = JSON.stringify(value);
  if (typeof json !== "string") return "undefined";
  return json
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function parseIntSafe(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : def;
}

function tryJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function isHttpUrl(s) {
  return /^https?:\/\//i.test(String(s || "").trim());
}

function toUploadAcceptAttr(extensions) {
  const list = Array.isArray(extensions) ? extensions : [];
  return list.map((ext) => `.${String(ext || "").trim().toLowerCase()}`).join(",");
}

function getUrlFileExtension(url) {
  const clean = String(url || "").split("#")[0].split("?")[0].toLowerCase();
  return path.extname(clean).slice(1);
}

function isAllowedWallpaperExt(url, { allowMedia = false } = {}) {
  const ext = getUrlFileExtension(url);
  const allowed = allowMedia
    ? WALLPAPER_MEDIA_EXTENSIONS
    : WALLPAPER_IMAGE_EXTENSIONS;
  return allowed.includes(ext);
}

const PENDING_COMMAND_CONTEXT_TTL_MS = 24 * HOUR_MS;
const pendingCommandContextById = new Map();

function purgeExpiredPendingCommandContexts(now = Date.now()) {
  const cutoff = Number(now || Date.now()) - PENDING_COMMAND_CONTEXT_TTL_MS;
  for (const [commandId, entry] of pendingCommandContextById.entries()) {
    if (Number(entry?.createdAt || 0) < cutoff) {
      pendingCommandContextById.delete(commandId);
    }
  }
}

function rememberPendingCommandContext(
  commandId,
  {
    actorUserId = null,
    ownerUserId = null,
    sourceKind = null,
    sourceId = null,
  } = {},
) {
  const id = String(commandId || "").trim();
  if (!id) return;

  purgeExpiredPendingCommandContexts();
  pendingCommandContextById.set(id, {
    actorUserId: String(actorUserId || "").trim() || null,
    ownerUserId: String(ownerUserId || "").trim() || null,
    sourceKind: String(sourceKind || "").trim() || null,
    sourceId: String(sourceId || "").trim() || null,
    createdAt: Date.now(),
  });
}

function getPendingCommandContext(commandId) {
  const id = String(commandId || "").trim();
  if (!id) return null;

  const entry = pendingCommandContextById.get(id) || null;
  if (!entry) return null;

  const createdAt = Number(entry.createdAt || 0);
  if (createdAt > 0 && Date.now() - createdAt > PENDING_COMMAND_CONTEXT_TTL_MS) {
    pendingCommandContextById.delete(id);
    return null;
  }

  return entry;
}

function incrementCommandsSentTotal({ senderDiscordId, targetOwnerDiscordId }) {
  if (!senderDiscordId) return;
  if (!targetOwnerDiscordId) return;

  if (String(senderDiscordId) === String(targetOwnerDiscordId)) return;

  incrementCommandsSentTotalOnce(senderDiscordId, {
    targetOwnerDiscordId,
  });
}

const incrementCommandsSentTotalStmt = db.prepare(`
  UPDATE users
  SET commands_sent_total = commands_sent_total + 1
  WHERE discord_id = ?
`);

const insertCommandSendCountStmt = db.prepare(`
  INSERT INTO command_send_counts (created_at, actor_user_id, target_user_id)
  VALUES (?, ?, ?)
`);

const recordCommandSendCount = db.transaction(
  (senderDiscordId, targetOwnerDiscordId = null) => {
    incrementCommandsSentTotalStmt.run(String(senderDiscordId));
    insertCommandSendCountStmt.run(
      Date.now(),
      String(senderDiscordId),
      targetOwnerDiscordId ? String(targetOwnerDiscordId) : null,
    );
  },
);

function incrementCommandsSentTotalOnce(
  senderDiscordId,
  { targetOwnerDiscordId = null } = {},
) {
  if (!senderDiscordId) return;
  recordCommandSendCount(senderDiscordId, targetOwnerDiscordId);
}

const LIVE_REQUIRED_COMMAND_TYPES = new Set(["screenshot", "webcam_capture"]);
const queueDrainTasksByUserId = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function getAwayDeadlineFromLastOnlineAt(lastOnlineAt) {
  const last = Number(lastOnlineAt || 0);
  if (!Number.isFinite(last) || last <= 0) return 0;
  return last + AWAY_WINDOW_MS;
}

function computePresenceState({
  awayEnabled = false,
  lastOnlineAt = 0,
  onlineCount = 0,
  deviceCount = 0,
  now = Date.now(),
} = {}) {
  const safeOnlineCount = Math.max(0, Number(onlineCount || 0));
  const safeDeviceCount = Math.max(0, Number(deviceCount || 0));
  const safeLastOnlineAt = Number(lastOnlineAt || 0);
  const awayUntil = getAwayDeadlineFromLastOnlineAt(safeLastOnlineAt);
  const status = safeOnlineCount > 0
    ? "online"
    : awayEnabled && awayUntil > now
      ? "away"
      : "offline";

  return {
    status,
    online: status === "online",
    away: status === "away",
    offline: status === "offline",
    onlineCount: safeOnlineCount,
    deviceCount: safeDeviceCount,
    awayEnabled: !!awayEnabled,
    lastOnlineAt: safeLastOnlineAt > 0 ? safeLastOnlineAt : 0,
    awayUntil: awayUntil > 0 ? awayUntil : 0,
  };
}

function listDeviceIdsByUserIds(userIds) {
  const ids = chunkUniqueStrings(userIds);
  const out = new Map();
  if (!ids.length) return out;

  for (const chunk of ids) {
    const placeholders = chunk.map(() => "?").join(",");
    const rows = db
      .prepare(
        `
        SELECT user_id, device_id
        FROM device_pairs
        WHERE user_id IN (${placeholders})
      `,
      )
      .all(...chunk);

    for (const row of rows) {
      const userId = String(row.user_id || "").trim();
      const deviceId = String(row.device_id || "").trim();
      if (!userId || !deviceId) continue;
      if (!out.has(userId)) out.set(userId, []);
      out.get(userId).push(deviceId);
    }
  }

  return out;
}

function listPresenceStateByUserIds(userIds, { now = Date.now() } = {}) {
  const ids = Array.from(
    new Set(
      (Array.isArray(userIds) ? userIds : [])
        .map((id) => String(id || "").trim())
        .filter(Boolean),
    ),
  );
  const out = new Map();
  if (!ids.length) return out;

  const userRows = [];
  for (const chunk of chunkUniqueStrings(ids)) {
    const placeholders = chunk.map(() => "?").join(",");
    userRows.push(
      ...db
        .prepare(
          `
          SELECT
            discord_id,
            IFNULL(away_enabled, 0) AS away_enabled,
            last_online_at
          FROM users
          WHERE discord_id IN (${placeholders})
        `,
        )
        .all(...chunk),
    );
  }
  const userRowById = new Map(
    userRows.map((row) => [String(row.discord_id || "").trim(), row]),
  );
  const deviceIdsByUser = listDeviceIdsByUserIds(ids);

  for (const userId of ids) {
    const row = userRowById.get(userId) || null;
    const deviceIds = deviceIdsByUser.get(userId) || [];
    let onlineCount = 0;
    for (const deviceId of deviceIds) {
      if (isDeviceOnline(deviceId)) onlineCount += 1;
    }

    out.set(
      userId,
      computePresenceState({
        awayEnabled: !!Number(row?.away_enabled || 0),
        lastOnlineAt: Number(row?.last_online_at || 0),
        onlineCount,
        deviceCount: deviceIds.length,
        now,
      }),
    );
  }

  return out;
}

function getUserPresenceState(
  userId,
  { deviceIds = null, now = Date.now() } = {},
) {
  const safeUserId = String(userId || "").trim();
  if (!safeUserId) {
    return computePresenceState({ now });
  }

  const row = db
    .prepare(
      `
      SELECT
        IFNULL(away_enabled, 0) AS away_enabled,
        last_online_at
      FROM users
      WHERE discord_id=?
      LIMIT 1
    `,
    )
    .get(safeUserId);

  const ids = Array.isArray(deviceIds)
    ? deviceIds.map((id) => String(id || "").trim()).filter(Boolean)
    : db
        .prepare(`SELECT device_id FROM device_pairs WHERE user_id=?`)
        .all(safeUserId)
        .map((entry) => String(entry.device_id || "").trim())
        .filter(Boolean);

  let onlineCount = 0;
  for (const deviceId of ids) {
    if (isDeviceOnline(deviceId)) onlineCount += 1;
  }

  return computePresenceState({
    awayEnabled: !!Number(row?.away_enabled || 0),
    lastOnlineAt: Number(row?.last_online_at || 0),
    onlineCount,
    deviceCount: ids.length,
    now,
  });
}

function markOwnerOnlineActivity(ownerUserId, at = Date.now()) {
  const userId = String(ownerUserId || "").trim();
  if (!userId) return;
  const ts = Number(at || Date.now()) || Date.now();
  try {
    db.prepare(
      `
      UPDATE users
      SET last_online_at=?, updated_at=?
      WHERE discord_id=?
    `,
    ).run(ts, ts, userId);
  } catch {}
}

function isAwayQueueableCommandType(commandType) {
  const type = String(commandType || "").trim();
  if (!type) return false;
  return !LIVE_REQUIRED_COMMAND_TYPES.has(type);
}

function countQueuedCommandsForUser(ownerUserId) {
  const userId = String(ownerUserId || "").trim();
  if (!userId) return 0;
  const row = db
    .prepare(
      `
      SELECT COUNT(*) AS n
      FROM queued_commands
      WHERE owner_user_id=?
    `,
    )
    .get(userId);
  return Math.max(0, Number(row?.n || 0));
}

function clearQueuedCommandsForUser(ownerUserId) {
  const userId = String(ownerUserId || "").trim();
  if (!userId) return 0;
  const info = db
    .prepare(`DELETE FROM queued_commands WHERE owner_user_id=?`)
    .run(userId);
  return Math.max(0, Number(info?.changes || 0));
}

function enqueueQueuedCommand({
  ownerUserId,
  actorUserId = null,
  sourceKind = "direct",
  sourceId = null,
  commandType,
  payload,
  uploadRows = [],
}) {
  const userId = String(ownerUserId || "").trim();
  const type = String(commandType || payload?.type || "").trim();
  if (!userId || !type || !payload || typeof payload !== "object") {
    throw new Error("Invalid queued command.");
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  const managedUploadRows = normalizeManagedUploadRows(uploadRows);

  const tx = db.transaction(() => {
    db.prepare(
      `
      INSERT INTO queued_commands (
        id,
        owner_user_id,
        actor_user_id,
        source_kind,
        source_id,
        command_type,
        payload_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      id,
      userId,
      actorUserId ? String(actorUserId || "").trim() : null,
      String(sourceKind || "direct").trim() || "direct",
      sourceId == null ? null : String(sourceId || "").trim(),
      type,
      JSON.stringify(payload),
      now,
    );

    for (const row of managedUploadRows) {
      const uploadId = String(row?.id || "").trim();
      if (!uploadId) continue;
      insertQueuedCommandUploadRef.run(id, uploadId, now);
    }
  });

  tx();

  return { id, createdAt: now };
}

function getNextQueuedCommandForUser(ownerUserId) {
  const userId = String(ownerUserId || "").trim();
  if (!userId) return null;
  return (
    db
      .prepare(
        `
        SELECT
          id,
          owner_user_id,
          actor_user_id,
          source_kind,
          source_id,
          command_type,
          payload_json,
          created_at
        FROM queued_commands
        WHERE owner_user_id=?
        ORDER BY created_at ASC, id ASC
        LIMIT 1
      `,
      )
      .get(userId) || null
  );
}

function deleteQueuedCommandById(id) {
  const safeId = String(id || "").trim();
  if (!safeId) return 0;
  const info = deleteQueuedCommandRow.run(safeId);
  return Math.max(0, Number(info?.changes || 0));
}

function purgeExpiredQueuedCommandsForUser(
  ownerUserId,
  { now = Date.now(), log = false } = {},
) {
  const userId = String(ownerUserId || "").trim();
  if (!userId) return 0;

  const row = db
    .prepare(
      `
      SELECT
        IFNULL(away_enabled, 0) AS away_enabled,
        last_online_at
      FROM users
      WHERE discord_id=?
      LIMIT 1
    `,
    )
    .get(userId);
  const awayEnabled = !!Number(row?.away_enabled || 0);
  const awayUntil = getAwayDeadlineFromLastOnlineAt(row?.last_online_at);
  if (!awayEnabled || !awayUntil || awayUntil > now) {
    return 0;
  }

  const clearedCount = clearQueuedCommandsForUser(userId);
  if (clearedCount > 0 && log) {
    logEvent({
      type: "away_queue_expired",
      actorUserId: userId,
      targetUserId: userId,
      payload: {
        clearedCount,
        awayUntil,
      },
    });
  }

  return clearedCount;
}

function purgeExpiredQueuedCommandsOnce(limit = QUEUED_COMMAND_PURGE_LIMIT) {
  const rows = db
    .prepare(
      `
      SELECT owner_user_id
      FROM queued_commands
      ORDER BY created_at ASC, id ASC
      LIMIT ?
    `,
    )
    .all(Math.max(1, Number(limit || QUEUED_COMMAND_PURGE_LIMIT)));
  if (!rows.length) return 0;

  const ownerIds = Array.from(
    new Set(
      rows
        .map((row) => String(row.owner_user_id || "").trim())
        .filter(Boolean),
    ),
  );

  let cleared = 0;
  for (const ownerId of ownerIds) {
    cleared += purgeExpiredQueuedCommandsForUser(ownerId, { log: true });
  }
  return cleared;
}

function getQueuedCommandTimeoutMs(commandType) {
  const type = String(commandType || "").trim();
  if (type === "popup" || type === "open_url") return 15000;
  if (
    type === "subliminal_message" ||
    type === "image_popup" ||
    type === "fullscreen_popup" ||
    type === "spiral_overlay" ||
    type === "set_wallpaper" ||
    type === "play_sound" ||
    type === "play_sound_loop" ||
    type === "write_for_me"
  ) {
    return 20000;
  }
  return 20000;
}

async function verifyWallpaperUrl(url) {
  const resp = await fetch(url, { method: "HEAD", redirect: "follow" });

  if (!resp.ok) throw new Error(`URL check failed (HTTP ${resp.status})`);

  const ct = String(resp.headers.get("content-type") || "").toLowerCase();
  const okType = ct.startsWith("image/png") || ct.startsWith("image/jpeg");
  if (!okType)
    throw new Error(`Not a PNG/JPEG (content-type=${ct || "unknown"})`);

  const len = Number(resp.headers.get("content-length") || "0");
  const MAX = 10 * 1024 * 1024;
  if (len && len > MAX)
    throw new Error(
      `Image too large (${Math.round(len / 1024 / 1024)}MB > 10MB)`,
    );

  return true;
}

function getSetting(key, fallback = null) {
  const row = db
    .prepare(`SELECT value FROM site_settings WHERE key=?`)
    .get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare(
    `
    INSERT INTO site_settings (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `,
  ).run(key, String(value));
}

function isEnrolledUser(user) {
  return !!user?.enrolled_at;
}

function markUserEnrolled(discordId) {
  db.prepare(`UPDATE users SET enrolled_at=? WHERE discord_id=?`).run(
    Date.now(),
    discordId,
  );
}

function isEnrollmentOpen() {
  return getSetting("enrollment_open", "0") === "1";
}

function ensurePairCode(userId) {
  const row = db
    .prepare("SELECT code_plain FROM pair_codes WHERE user_id=?")
    .get(userId);
  if (row?.code_plain) return row.code_plain;

  const code = gen6();
  db.prepare(
    `
    INSERT INTO pair_codes (user_id, code_hash, code_plain, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      code_hash=excluded.code_hash,
      code_plain=excluded.code_plain,
      updated_at=excluded.updated_at
  `,
  ).run(userId, hmac(code), code, Date.now());

  return code;
}

function loadGroupsCatalog() {
  try {
    const stat = fs.statSync(GROUPS);
    if (!stat.isFile()) return new Map();
    const raw = fs.readFileSync(GROUPS, "utf8");
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed?.groups) ? parsed.groups : [];
    const byKey = new Map();
    for (const g of list) {
      if (!g) continue;
      if (g.enabled === false) continue;
      const key = String(g.key || "").trim();
      if (!key) continue;
      byKey.set(key, {
        key,
        label: String(g.label || key).trim(),
        icon: String(g.icon || "").trim(),
      });
    }
    return byKey;
  } catch {
    return new Map();
  }
}

function getCommunityGroupCatalogEntry(groupKey) {
  const key = String(groupKey || "").trim();
  if (!key) return null;

  const row = db
    .prepare(
      `
      SELECT group_key, owner_user_id, name, custom_avatar_path
      FROM community_groups
      WHERE group_key=?
      LIMIT 1
    `,
    )
    .get(key);
  if (!row) return null;

  const ownerUserId = String(row.owner_user_id || "").trim();
  return {
    kind: "community",
    key,
    label: String(row.name || key).trim() || key,
    icon: row.custom_avatar_path
      ? groupAvatarUrl(key, 128)
      : ownerUserId
        ? siteAvatarUrl({ discord_id: ownerUserId }, 128)
        : "/groups/default.png",
    ownerUserId: ownerUserId || null,
  };
}

function getResolvedGroupCatalogEntry(groupKey) {
  const key = String(groupKey || "").trim();
  if (!key) return null;

  const staticGroup = loadGroupsCatalog().get(key);
  if (staticGroup) {
    return {
      kind: "static",
      key,
      label: String(staticGroup.label || key).trim() || key,
      icon: String(staticGroup.icon || "").trim(),
      ownerUserId: null,
    };
  }

  return getCommunityGroupCatalogEntry(key);
}

const pendingAcks = new Map();

function waitForAcks(commandId, expected, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const entry = {
      expected: Math.max(0, Number(expected) || 0),
      results: [],
      resolve,
      timer: null,
    };

    if (entry.expected <= 0) return resolve([]);

    entry.timer = setTimeout(() => {
      pendingAcks.delete(commandId);
      resolve(entry.results);
    }, timeoutMs);

    pendingAcks.set(commandId, entry);
  });
}

function handleIncomingAck(msg) {
  if (!msg || msg.type !== "ack" || !msg.commandId) return;

  const entry = pendingAcks.get(msg.commandId);
  if (!entry) return;

  entry.results.push(msg);

  if (entry.results.length >= entry.expected) {
    pendingAcks.delete(msg.commandId);
    try {
      if (entry.timer) clearTimeout(entry.timer);
    } catch {}
    entry.resolve(entry.results);
  }
}

function sendToPairedDevices(deviceIds, msgObj) {
  let sentTo = 0;
  for (const deviceId of deviceIds) {
    const ws = wsByDeviceId.get(deviceId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(msgObj));
        sentTo++;
      } catch {}
    }
  }
  return sentTo;
}

function isExplicitlyWhitelistedByOwner(ownerId, actorId) {
  const safeOwnerId = String(ownerId || "").trim();
  const safeActorId = String(actorId || "").trim();
  if (!safeOwnerId || !safeActorId || safeOwnerId === safeActorId) {
    return false;
  }

  const row = db
    .prepare(
      `
      SELECT 1
      FROM user_whitelist
      WHERE owner_id=? AND allowed_id=?
    `,
    )
    .get(safeOwnerId, safeActorId);

  return !!row;
}

function getCommandSenderContext(ownerUserId, actorUserId) {
  const ownerId = String(ownerUserId || "").trim();
  const actorId = String(actorUserId || "").trim();
  const isEffectivelyWhitelistedByRecipient =
    !actorId ||
    (ownerId && ownerId === actorId) ||
    isAdmin(actorId) ||
    isExplicitlyWhitelistedByOwner(ownerId, actorId);

  return {
    actorUserId: actorId || null,
    isExplicitlyWhitelistedByRecipient: isEffectivelyWhitelistedByRecipient,
  };
}

function shouldUseWhitelistedSenderCapabilities(ownerUserId, actorUserId) {
  const sender = getCommandSenderContext(ownerUserId, actorUserId);
  return sender.isExplicitlyWhitelistedByRecipient === true;
}

function normalizeSelfPreviewMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  if (mode === "standard" || mode === "whitelisted") return mode;
  return null;
}

function getResolvedEnabledCommandsForActor(
  ownerUserId,
  actorUserId = null,
  { selfPreviewMode = null } = {},
) {
  const ownerId = String(ownerUserId || "").trim();
  const actorId = String(actorUserId || "").trim();
  if (!ownerId) return null;

  const normalizedSelfPreviewMode = normalizeSelfPreviewMode(selfPreviewMode);
  const forceStandardSelfPreview =
    normalizedSelfPreviewMode === "standard" && actorId && actorId === ownerId;
  const forceWhitelistedSelfPreview =
    normalizedSelfPreviewMode === "whitelisted" &&
    actorId &&
    actorId === ownerId;
  const useWhitelistedSenderCapabilities =
    forceWhitelistedSelfPreview ||
    (!forceStandardSelfPreview &&
      shouldUseWhitelistedSenderCapabilities(ownerId, actorId || null));
  const onlineCaps = useWhitelistedSenderCapabilities
    ? getUnionCapsForWhitelistedSendersOnline(ownerId)
    : getUnionCapsForOwnerOnline(ownerId);

  if (onlineCaps.hasAnyReportingOnline) {
    return onlineCaps.enabled;
  }

  const lastEnabled = useWhitelistedSenderCapabilities
    ? getLastReportedCapabilitiesForWhitelistedSenders(ownerId)
    : getLastReportedCapabilitiesForOwner(ownerId);
  if (lastCapsByUserId.has(ownerId)) {
    return lastEnabled instanceof Set ? lastEnabled : new Set();
  }

  return null;
}

function getReportedCapabilitiesForActor(
  ownerUserId,
  actorUserId = null,
  { selfPreviewMode = null } = {},
) {
  const ownerId = String(ownerUserId || "").trim();
  if (!ownerId) return new Set();

  const actorId = String(actorUserId || "").trim();
  const normalizedSelfPreviewMode = normalizeSelfPreviewMode(selfPreviewMode);
  const forceStandardSelfPreview =
    normalizedSelfPreviewMode === "standard" && actorId && actorId === ownerId;
  const forceWhitelistedSelfPreview =
    normalizedSelfPreviewMode === "whitelisted" &&
    actorId &&
    actorId === ownerId;

  return forceWhitelistedSelfPreview ||
    (!forceStandardSelfPreview &&
      shouldUseWhitelistedSenderCapabilities(ownerId, actorId || null))
    ? getReportedCapabilitiesForWhitelistedSenders(ownerId)
    : getReportedCapabilitiesForOwner(ownerId);
}

function ownerHasReportedCapabilityForActor(
  ownerUserId,
  actorUserId,
  capability,
  options = {},
) {
  const cap = String(capability || "").trim();
  if (!cap) return false;
  return getReportedCapabilitiesForActor(ownerUserId, actorUserId, options).has(
    cap,
  );
}

function groupHasReportedCapabilityForActor(groupKey, actorUserId, capability) {
  const key = String(groupKey || "").trim();
  const cap = String(capability || "").trim();
  if (!key || !cap) return false;

  const rows = db
    .prepare(`SELECT user_id FROM group_memberships WHERE group_key=?`)
    .all(key);

  for (const row of rows) {
    if (
      ownerHasReportedCapabilityForActor(
        String(row.user_id || ""),
        actorUserId,
        cap,
      )
    ) {
      return true;
    }
  }

  return false;
}

function sanitizeCommandPayloadForDelivery(commandPayload) {
  if (!commandPayload || typeof commandPayload !== "object" || Array.isArray(commandPayload)) {
    return {};
  }

  const payload = { ...commandPayload };
  delete payload.serverContext;
  return payload;
}

function getServerCommandSourceContext(sourceKind = null, sourceId = null) {
  const safeSourceKind =
    sourceKind == null ? null : String(sourceKind || "").trim() || null;
  const safeSourceId =
    sourceId == null ? null : String(sourceId || "").trim() || null;
  let sourceLabel = null;

  if (safeSourceKind === "group" && safeSourceId) {
    const groupLabel = String(
      getResolvedGroupCatalogEntry(safeSourceId)?.label || "",
    ).trim();
    if (groupLabel) {
      sourceLabel = groupLabel;
    }
  }

  return {
    sourceKind: safeSourceKind,
    sourceId: safeSourceId,
    sourceLabel,
  };
}

function buildServerCommandMessage({
  commandId,
  commandPayload,
  ownerUserId = null,
  actorUserId = null,
  sourceKind = null,
  sourceId = null,
}) {
  const sourceContext = getServerCommandSourceContext(sourceKind, sourceId);

  rememberPendingCommandContext(commandId, {
    actorUserId,
    ownerUserId,
    sourceKind: sourceContext.sourceKind,
    sourceId: sourceContext.sourceId,
  });

  return {
    type: "command",
    commandId,
    command: sanitizeCommandPayloadForDelivery(commandPayload),
    serverContext: {
      version: 1,
      evaluatedAt: Date.now(),
      sourceKind: sourceContext.sourceKind,
      sourceId: sourceContext.sourceId,
      sourceLabel: sourceContext.sourceLabel,
      sender: getCommandSenderContext(ownerUserId, actorUserId),
    },
  };
}

async function sendPreparedCommandMessagesAndWait(preparedMessages, timeoutMs = 15000) {
  const list = Array.isArray(preparedMessages) ? preparedMessages : [];
  const normalized = [];

  for (const item of list) {
    const commandId = String(item?.commandId || "").trim();
    if (!commandId) continue;

    const deviceIds = Array.isArray(item?.deviceIds)
      ? item.deviceIds.map((did) => String(did || "").trim()).filter(Boolean)
      : [];
    const onlineDeviceIds = deviceIds.filter((did) => isDeviceOnline(did));
    if (!onlineDeviceIds.length) continue;

    normalized.push({
      commandId,
      onlineDeviceIds,
      message: buildServerCommandMessage({
        commandId,
        commandPayload: item?.commandPayload,
        ownerUserId: item?.ownerUserId,
        actorUserId: item?.actorUserId,
        sourceKind: item?.sourceKind,
        sourceId: item?.sourceId,
      }),
    });
  }

  if (!normalized.length) {
    return { ok: false, error: "No devices online", sent: 0, acks: [] };
  }

  let sent = 0;
  let commandId = null;
  for (const item of normalized) {
    commandId = commandId || item.commandId;
    sent += sendToPairedDevices(item.onlineDeviceIds, item.message);
  }

  if (sent <= 0) {
    return { ok: false, error: "No devices online", sent: 0, acks: [] };
  }

  const acks = await waitForAcks(commandId, sent, timeoutMs);
  return { ok: true, commandId, sent, acks };
}

function isCommandEnabledForOwner(
  ownerUserId,
  cmdKey,
  actorUserId = null,
  options = {},
) {
  const ownerId = String(ownerUserId || "").trim();
  const command = String(cmdKey || "").trim();
  if (!ownerId || !command) return true;

  const resolvedEnabledCommands = getResolvedEnabledCommandsForActor(
    ownerId,
    actorUserId,
    options,
  );
  if (resolvedEnabledCommands) {
    return resolvedEnabledCommands.has(command);
  }

  return isCommandEnabled(getCommandPrefsForUser(ownerId), command);
}

async function sendCommandToResolvedTarget({
  resolved,
  requestId = null,
  actorUserId = null,
  commandPayload,
  timeoutMs = 15000,
  sourceKind = "direct",
  sourceId = null,
  selfPreviewMode = null,
  req = null,
}) {
  const ownerUserId = String(resolved?.ownerUserId || "").trim();
  const deviceIds = Array.isArray(resolved?.deviceIds)
    ? resolved.deviceIds.map((id) => String(id || "").trim()).filter(Boolean)
    : [];
  const commandType = String(commandPayload?.type || "").trim();
  const presence = getUserPresenceState(ownerUserId, { deviceIds });

  if (
    !isCommandEnabledForOwner(ownerUserId, commandType, actorUserId, {
      selfPreviewMode,
    })
  ) {
    return {
      ok: false,
      delivery: "disabled",
      code: "COMMAND_DISABLED",
      error: "That command is disabled for this user right now.",
      presence,
      sent: 0,
      acks: [],
      queuedCount: 0,
      queuedTargets: [],
      targets: [],
    };
  }

  if (presence.online) {
    const commandId = requestId || crypto.randomUUID();
    const liveResult = await sendPreparedCommandMessagesAndWait(
      [
        {
          commandId,
          deviceIds,
          commandPayload,
          ownerUserId,
          actorUserId,
          sourceKind,
          sourceId,
        },
      ],
      timeoutMs,
    );
    return {
      ...liveResult,
      delivery: "sent",
      presence,
      commandId,
      queuedCount: 0,
      queuedTargets: [],
      targets: ownerUserId ? [{ ownerUserId, deviceIds }] : [],
    };
  }

  if (presence.away) {
    if (!isAwayQueueableCommandType(commandType)) {
      return {
        ok: false,
        delivery: "away_blocked",
        code: "COMMAND_UNAVAILABLE_WHILE_AWAY",
        error: "That command can only be sent while the user is online.",
        presence,
        sent: 0,
        acks: [],
        queuedCount: 0,
        queuedTargets: [],
        targets: [],
      };
    }

    let managedUploadRows = [];
    try {
      managedUploadRows = resolveManagedUploadRowsForQueuedCommand(
        req,
        commandPayload,
      );
    } catch (err) {
      return {
        ok: false,
        delivery: "queue_failed",
        code: "UPLOAD_UNAVAILABLE",
        error:
          String(err?.message || "").trim() ||
          "The uploaded file for this command is no longer available.",
        presence,
        sent: 0,
        acks: [],
        queuedCount: 0,
        queuedTargets: [],
        targets: [],
      };
    }

    const queued = enqueueQueuedCommand({
      ownerUserId,
      actorUserId,
      sourceKind,
      sourceId,
      commandType,
      payload: commandPayload,
      uploadRows: managedUploadRows,
    });

    return {
      ok: true,
      delivery: "queued",
      commandId: requestId || null,
      presence,
      sent: 0,
      acks: [],
      queuedCount: 1,
      queuedTargets: ownerUserId ? [{ ownerUserId }] : [],
      queuedCommandId: queued.id,
      targets: [],
    };
  }

  return {
    ok: false,
    delivery: "offline",
    code: "DEVICE_OFFLINE",
    error: "No devices online",
    presence,
    sent: 0,
    acks: [],
    queuedCount: 0,
    queuedTargets: [],
    targets: [],
  };
}

function resolveGroupTargets(groupKey) {
  const key = String(groupKey || "").trim();
  if (!key) return { ok: false, error: "bad_group_key" };

  if (!getResolvedGroupCatalogEntry(key)) {
    return { ok: false, error: "unknown_group" };
  }

  const mems = db.prepare(`
    SELECT user_id
    FROM group_memberships
    WHERE group_key = ?
  `).all(key);

  if (!mems.length) {
    return {
      ok: true,
      groupKey: key,
      members: [],
      targets: [],
    };
  }

  const userIds = Array.from(new Set(mems.map(r => String(r.user_id))));
  const deviceIdsByUser = listDeviceIdsByUserIds(userIds);
  const presenceByUserId = listPresenceStateByUserIds(userIds);

  const targets = [];

  for (const uid of userIds) {
    const devs = deviceIdsByUser.get(uid) || [];
    const onlineDeviceIds = devs.filter(did => isDeviceOnline(did));
    targets.push({
      ownerUserId: uid,
      deviceIds: devs,
      onlineDeviceIds,
      presence: presenceByUserId.get(uid) || computePresenceState(),
    });
  }

  return {
    ok: true,
    groupKey: key,
    members: userIds,
    targets,
  };
}

function filterTargetsByCommandEnabled(targets, cmdKey, actorUserId = null) {
  const allowedTargets = [];
  const disabledOwnerUserIds = [];

  for (const target of Array.isArray(targets) ? targets : []) {
    const ownerId = String(target?.ownerUserId || "").trim();
    if (!ownerId || isCommandEnabledForOwner(ownerId, cmdKey, actorUserId)) {
      allowedTargets.push(target);
      continue;
    }
    disabledOwnerUserIds.push(ownerId);
  }

  return { allowedTargets, disabledOwnerUserIds };
}

function buildDirectDeliveryMessage(result) {
  if (!result?.ok) return result?.error || "No devices online";
  if (result.delivery === "queued") {
    return "Command queued";
  }

  const failed = Array.isArray(result.acks)
    ? result.acks.some((ack) => !ack?.ok)
    : false;
  if (failed) {
    return renderAcks(result.acks);
  }
  return "Sent to device";
}

function buildGroupDeliveryMessage(result) {
  if (!result?.ok) return result?.error || "No target users are online or away";

  const liveRecipients = Array.isArray(result.targets) ? result.targets.length : 0;
  const queuedRecipients = Array.isArray(result.queuedTargets)
    ? result.queuedTargets.length
    : 0;
  const anyFail = Array.isArray(result.acks)
    ? result.acks.some((ack) => !ack?.ok)
    : false;
  const parts = [];

  if (liveRecipients > 0) {
    parts.push(
      `Sent to ${liveRecipients} online user${liveRecipients === 1 ? "" : "s"}`,
    );
  }
  if (queuedRecipients > 0) {
    parts.push(
      `queued for ${queuedRecipients} away user${queuedRecipients === 1 ? "" : "s"}`,
    );
  }

  if (!parts.length) {
    return result.error || "No target users are online or away";
  }

  let message = parts.join(", ").replace(", queued", " and queued");
  if (liveRecipients === 0 && queuedRecipients > 0) {
    message = `Queued for ${queuedRecipients} away user${
      queuedRecipients === 1 ? "" : "s"
    }`;
  }
  if (!anyFail) return message + ".";
  return `${message}. Some online devices rejected or failed.`;
}

async function sendToGroupAndWait({
  groupKey,
  cmdKey,
  commandPayload,
  timeoutMs = 20000,
  actorUserId = null,
  requestId = null,
  req = null,
}) {
  const resolved = resolveGroupTargets(groupKey);
  if (!resolved.ok) {
    return { ok: false, error: resolved.error || "group_resolve_failed", sent: 0, acks: [], targets: [] };
  }

  const {
    allowedTargets: enabledTargets,
    disabledOwnerUserIds,
  } = filterTargetsByCommandEnabled(resolved.targets, cmdKey, actorUserId);
  const {
    allowedTargets: filteredTargets,
    blockedOwnerUserIds,
  } = filterTargetsBlockedByActor(enabledTargets, actorUserId);
  const {
    allowedTargets: allowedTargets,
    whitelistDeniedOwnerUserIds,
  } = filterTargetsByWhitelist(filteredTargets, actorUserId);

  const onlineTargets = [];
  const awayTargets = [];

  for (const target of allowedTargets) {
    const status = String(target?.presence?.status || "").trim();
    if (status === "online" && Array.isArray(target.onlineDeviceIds) && target.onlineDeviceIds.length) {
      onlineTargets.push(target);
      continue;
    }
    if (status === "away" && isAwayQueueableCommandType(commandPayload?.type)) {
      awayTargets.push(target);
    }
  }

  let managedUploadRows = [];
  if (awayTargets.length) {
    try {
      managedUploadRows = resolveManagedUploadRowsForQueuedCommand(
        req,
        commandPayload,
      );
    } catch (err) {
      return {
        ok: false,
        error:
          String(err?.message || "").trim() ||
          "The uploaded file for this command is no longer available.",
        sent: 0,
        acks: [],
        targets: [],
        queuedTargets: [],
        queuedCount: 0,
        blockedOwnerUserIds,
        disabledOwnerUserIds,
        whitelistDeniedOwnerUserIds,
      };
    }
  }

  const onlineDeviceIds = [];
  for (const target of onlineTargets) {
    for (const deviceId of target.onlineDeviceIds) {
      onlineDeviceIds.push(deviceId);
    }
  }

  if (!onlineDeviceIds.length && !awayTargets.length) {
    const error = blockedOwnerUserIds.length
      ? disabledOwnerUserIds.length
        ? "No available recipients can receive that command right now"
        : "You are blocked by all available recipients"
      : whitelistDeniedOwnerUserIds.length
        ? "You are not whitelisted by any available recipients"
      : disabledOwnerUserIds.length
        ? "That command is disabled for all available recipients"
        : "No target users are online or away";
    return {
      ok: false,
      error,
      sent: 0,
      acks: [],
      targets: onlineTargets,
      queuedTargets: awayTargets,
      queuedCount: 0,
      blockedOwnerUserIds,
      disabledOwnerUserIds,
      whitelistDeniedOwnerUserIds,
    };
  }

  let liveResult = {
    ok: true,
    commandId: requestId || crypto.randomUUID(),
    sent: 0,
    acks: [],
  };

  if (onlineDeviceIds.length) {
    liveResult = await sendPreparedCommandMessagesAndWait(
      onlineTargets.map((target) => ({
        commandId: requestId || liveResult.commandId,
        deviceIds: target.onlineDeviceIds,
        commandPayload,
        ownerUserId: target.ownerUserId,
        actorUserId,
        sourceKind: "group",
        sourceId: groupKey,
      })),
      timeoutMs,
    );
  }

  if (liveResult.ok && Number(liveResult.sent || 0) > 0) {
    const deliveredCommandId = requestId || liveResult.commandId || null;
    for (const target of onlineTargets) {
      logDeliveredGroupCommandHistory({
        actorUserId,
        targetUserId: target?.ownerUserId,
        groupKey,
        commandPayload,
        commandId: deliveredCommandId,
        req,
      });
    }
  }

  const queuedTargets = [];
  for (const target of awayTargets) {
    enqueueQueuedCommand({
      ownerUserId: target.ownerUserId,
      actorUserId,
      sourceKind: "group",
      sourceId: groupKey,
      commandType: commandPayload?.type,
      payload: commandPayload,
      uploadRows: managedUploadRows,
    });
    queuedTargets.push({ ownerUserId: target.ownerUserId });
  }

  const hasQueued = queuedTargets.length > 0;
  if (!liveResult.ok && !hasQueued) {
    return {
      ok: false,
      error: liveResult.error || "No target devices online",
      sent: 0,
      acks: [],
      targets: onlineTargets,
      queuedTargets,
      queuedCount: 0,
      blockedOwnerUserIds,
      whitelistDeniedOwnerUserIds,
    };
  }

  return {
    ok: liveResult.ok || hasQueued,
    delivery:
      liveResult.sent > 0 && hasQueued
        ? "sent_and_queued"
        : hasQueued
          ? "queued"
          : "sent",
    commandId: requestId || liveResult.commandId,
    sent: liveResult.sent || 0,
    acks: Array.isArray(liveResult.acks) ? liveResult.acks : [],
    targets: onlineTargets,
    queuedTargets,
    queuedCount: queuedTargets.length,
    blockedOwnerUserIds,
    disabledOwnerUserIds,
    whitelistDeniedOwnerUserIds,
  };
}

async function drainQueuedCommandsForUser(ownerUserId) {
  const userId = String(ownerUserId || "").trim();
  if (!userId) return;
  if (queueDrainTasksByUserId.has(userId)) {
    return queueDrainTasksByUserId.get(userId);
  }

  const task = (async () => {
    while (true) {
      const presence = getUserPresenceState(userId);
      if (!presence.online) break;

      const nextItem = getNextQueuedCommandForUser(userId);
      if (!nextItem) break;

      let payload = null;
      try {
        payload = JSON.parse(String(nextItem.payload_json || "{}"));
      } catch {
        payload = null;
      }

      if (!payload || typeof payload !== "object" || !String(payload.type || "").trim()) {
        deleteQueuedCommandById(nextItem.id);
        continue;
      }

      const queuedActorUserId = String(nextItem.actor_user_id || "").trim() || null;
      const queuedSourceKind = String(nextItem.source_kind || "direct").trim() || "direct";
      const queuedSourceId = nextItem.source_id ? String(nextItem.source_id || "").trim() : null;

      if (queuedActorUserId) {
        const isBlocked = isCommandSenderBlockedByOwner(userId, queuedActorUserId);
        const shouldRecheckWhitelist =
          queuedSourceKind === "direct" ||
          queuedSourceKind === "api" ||
          queuedSourceKind === "group";
        const isWhitelistedNow = shouldRecheckWhitelist
          ? isAllowedByWhitelist(userId, queuedActorUserId)
          : true;
        const isBannedNow = !!getBanRecord(queuedActorUserId);

        if (isBlocked || !isWhitelistedNow || isBannedNow) {
          deleteQueuedCommandById(nextItem.id);
          logEvent({
            type: "queued_command_dropped",
            actorUserId: queuedActorUserId,
            targetUserId: userId,
            payload: {
              queuedCommandId: String(nextItem.id || ""),
              commandType: String(nextItem.command_type || payload.type || ""),
              sourceKind: queuedSourceKind,
              sourceId: queuedSourceId,
              reason: isBlocked
                ? "sender_blocked"
                : isBannedNow
                  ? "actor_banned"
                  : "whitelist_denied",
            },
          });
          continue;
        }
      }

      const deviceIds = db
        .prepare(`SELECT device_id FROM device_pairs WHERE user_id=?`)
        .all(userId)
        .map((row) => String(row.device_id || "").trim())
        .filter(Boolean);

      const commandId = crypto.randomUUID();
      const sendResult = await sendPreparedCommandMessagesAndWait(
        [
          {
            commandId,
            deviceIds,
            commandPayload: payload,
            ownerUserId: userId,
            actorUserId: queuedActorUserId,
            sourceKind: queuedSourceKind,
            sourceId: queuedSourceId,
          },
        ],
        getQueuedCommandTimeoutMs(nextItem.command_type),
      );

      if (!sendResult.ok) break;

      if (queuedSourceKind === "direct") {
        logDeliveredDirectCommandHistory({
          actorUserId: queuedActorUserId,
          targetUserId: userId,
          pairCode: queuedSourceId,
          commandPayload: payload,
          commandId,
        });
      } else if (queuedSourceKind === "group") {
        logDeliveredGroupCommandHistory({
          actorUserId: queuedActorUserId,
          targetUserId: userId,
          groupKey: queuedSourceId,
          commandPayload: payload,
          commandId,
        });
      }

      finalizeDeliveredQueuedCommand(nextItem.id);
      logEvent({
        type: "queued_command_delivered",
        actorUserId: queuedActorUserId,
        targetUserId: userId,
        payload: {
          queuedCommandId: String(nextItem.id || ""),
          commandId,
          commandType: String(nextItem.command_type || payload.type || ""),
          sourceKind: queuedSourceKind,
          sourceId: queuedSourceId,
          queuedAt: Number(nextItem.created_at || 0),
        },
      });

      if (!getUserPresenceState(userId).online) break;
      await sleep(QUEUED_COMMAND_SEND_DELAY_MS);
    }
  })().finally(() => {
    queueDrainTasksByUserId.delete(userId);
  });

  queueDrainTasksByUserId.set(userId, task);
  return task;
}

function renderAcks(acks) {
  if (!acks || !acks.length) return "No response from devices";

  return acks
    .map((a) => {
      if (a && a.ok) return "OK";

      if (a && a.status === "rejected") {
        const code = a.code || "unknown";
        const msg = a.message ? ` — ${String(a.message)}` : "";
        return `Rejected: ${code}${msg}`;
      }

      const code = (a && (a.code || a.message)) || "unknown";
      return `Failed: ${code}`;
    })
    .join("<br>");
}

function safeUnlink(filePath, label = "responses") {
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch (e) {
    if (e && (e.code === "ENOENT" || e.code === "ENOTDIR")) return false;
    console.warn(`[${label}] unlink failed:`, filePath, e?.message || e);
    return false;
  }
}

function runResponsesJanitorOnce() {
  const cutoff = Date.now() - RESP_TTL_MS;

  let rows = [];
  try {
    rows = db.prepare(`
      SELECT id, file_path, created_at
      FROM device_responses
      WHERE created_at < ?
      ORDER BY created_at ASC
      LIMIT ?
    `).all(cutoff, RESP_JANITOR_LIMIT);
  } catch (e) {
    console.warn("[responses] janitor query failed:", e?.message || e);
    return;
  }

  if (!rows.length) return;

  const delRow = db.prepare(`DELETE FROM device_responses WHERE id=?`);

  const tx = db.transaction((items) => {
    for (const r of items) {
      const fp = String(r.file_path || "");
      const abs = path.resolve(fp);
      const base = path.resolve(RESPONSES_DIR) + path.sep;

      if (!abs.startsWith(base)) {
        console.warn("[responses] janitor refused to delete outside RESPONSES_DIR:", abs);
        continue;
      }

      safeUnlink(abs);
      delRow.run(String(r.id));
    }
  });

  try {
    tx(rows);
    console.log("[responses] janitor deleted", rows.length, "expired responses");
  } catch (e) {
    console.warn("[responses] janitor tx failed:", e?.message || e);
  }
}

const responsesJanitorTimer = setInterval(runResponsesJanitorOnce, RESP_JANITOR_EVERY_MS);
responsesJanitorTimer.unref?.();
const queuedCommandsPurgeTimer = setInterval(
  purgeExpiredQueuedCommandsOnce,
  QUEUED_COMMAND_PURGE_EVERY_MS,
);
queuedCommandsPurgeTimer.unref?.();

if (!IS_AVATAR_BACKFILL_CLI) {
  runResponsesJanitorOnce();
  purgeExpiredQueuedCommandsOnce();
}

function mb(n) {
  const x = Number(n || 0);
  if (!Number.isFinite(x) || x <= 0) return null;
  return (x / 1024 / 1024).toFixed(1);
}

function formatAckForHttp(ack) {
  const ok = !!ack?.ok;
  if (ok) return { ok: true, ack };

  const clientCode = String(ack?.code || "unknown");
  let message = String(ack?.message || "Command rejected by client.");
  const details = ack?.details;

  if (clientCode === "file_too_large" && details && (details.sizeBytes || details.maxBytes)) {
    const s = mb(details.sizeBytes);
    const m = mb(details.maxBytes);
    if (s && m) message = `${message} (${s}MB > ${m}MB)`;
  }

  return {
    ok: false,
    code: "CLIENT_REJECTED",
    client_code: clientCode,
    message,
    details: details || null,
    ack
  };
}

async function sendCommandToOneOnlineAndWaitAck({ resolved, commandId, commandObj, timeoutMs = 20000 }) {
  const deviceIds = resolved.deviceIds || [];
  const targetDeviceId = deviceIds.find(did => isDeviceOnline(did));
  if (!targetDeviceId) {
    return { ok: false, httpStatus: 409, code: "DEVICE_OFFLINE", message: "No paired devices online." };
  }

  const sent = sendToPairedDevices(
    [targetDeviceId],
    buildServerCommandMessage({
      commandId,
      commandPayload: commandObj,
      ownerUserId: resolved?.ownerUserId || null,
    }),
  );

  if (sent <= 0) {
    return { ok: false, httpStatus: 409, code: "DEVICE_OFFLINE", message: "Target device not online." };
  }

  const ack = await waitForAck(commandId, targetDeviceId, timeoutMs);
  if (ack?.ok) {
    return { ok: true, httpStatus: 200, targetDeviceId, ack };
  }

  const formatted = formatAckForHttp(ack);
  return { ok: false, httpStatus: 422, targetDeviceId, ...formatted };
}

function enforceWebCooldownForNewUsers(req, res, next) {
  try {
    const senderId = getRequestActorUserId(req);
    if (!senderId) return next();

    const row = db
      .prepare(`SELECT commands_sent_total FROM users WHERE discord_id=?`)
      .get(senderId);
    const total = Number(row?.commands_sent_total || 0);
    if (total >= 100) return next();

    const now = Date.now();
    const cd = db
      .prepare(
        `SELECT next_allowed_at_ms FROM web_cmd_cooldowns WHERE user_id=?`,
      )
      .get(senderId);
    const nextAllowed = Number(cd?.next_allowed_at_ms || 0);

    if (now < nextAllowed) {
      const retry = Math.max(0, nextAllowed - now);
      return res.status(429).json({
        ok: false,
        code: "WEB_COOLDOWN",
        retry_after_ms: retry,
      });
    }

    const nextAt = now + 3000;
    db.prepare(
      `
      INSERT INTO web_cmd_cooldowns (user_id, next_allowed_at_ms)
      VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET next_allowed_at_ms=excluded.next_allowed_at_ms
    `,
    ).run(senderId, nextAt);

    next();
  } catch (e) {
    next();
  }
}

const URL_DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(URL_DATA_DIR)) fs.mkdirSync(URL_DATA_DIR);

const ALLOWLIST_PATH = path.join(URL_DATA_DIR, "url_allowlist.txt");
const BLOCKLIST_PATH = path.join(URL_DATA_DIR, "url_blocklist.txt");

function ensureListFilesExist() {
  fs.mkdirSync(path.dirname(ALLOWLIST_PATH), { recursive: true });
  if (!fs.existsSync(ALLOWLIST_PATH))
    fs.writeFileSync(ALLOWLIST_PATH, "", "utf8");
  if (!fs.existsSync(BLOCKLIST_PATH))
    fs.writeFileSync(BLOCKLIST_PATH, "", "utf8");
}

function parseHostLine(line) {
  const s = String(line || "").trim();
  if (!s || s.startsWith("#")) return null;

  try {
    if (s.includes("://")) {
      const u = new URL(s);
      return normalizeHost(u.host);
    }
  } catch {}
  return normalizeHost(s);
}

function normalizeHost(host) {
  const h = String(host || "")
    .trim()
    .toLowerCase();

  return h.replace(/\/+$/, "");
}

let cacheAllow = { mtimeMs: 0, set: new Set() };
let cacheBlock = { mtimeMs: 0, set: new Set() };

function loadHostSetCached(filePath, cacheObj) {
  ensureListFilesExist();
  let st;
  try {
    st = fs.statSync(filePath);
  } catch {
    st = null;
  }
  const mtimeMs = st ? st.mtimeMs : 0;

  if (mtimeMs && mtimeMs === cacheObj.mtimeMs && cacheObj.set.size) {
    return cacheObj.set;
  }

  let txt = "";
  try {
    txt = fs.readFileSync(filePath, "utf8");
  } catch {}

  const set = new Set();
  for (const line of txt.split(/\r?\n/)) {
    const host = parseHostLine(line);
    if (host) set.add(host);
  }

  cacheObj.mtimeMs = mtimeMs;
  cacheObj.set = set;
  return set;
}

function getAllowSet() {
  return loadHostSetCached(ALLOWLIST_PATH, cacheAllow);
}
function getBlockSet() {
  return loadHostSetCached(BLOCKLIST_PATH, cacheBlock);
}

function extractHostFromUrl(rawUrl) {
  const s = String(rawUrl || "").trim();
  if (!s) return null;

  let u;
  try {
    u = new URL(s);
  } catch {
    try {
      u = new URL("https://" + s);
    } catch {
      return null;
    }
  }

  const proto = (u.protocol || "").toLowerCase();
  if (proto !== "http:" && proto !== "https:") return null;

  return normalizeHost(u.host);
}

function upsertVerificationHost(db, host, sampleUrl) {
  const now = Date.now();
  db.prepare(
    `
    INSERT INTO url_verification_queue (host, sample_url, first_seen_at, last_seen_at, seen_count)
    VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(host) DO UPDATE SET
      last_seen_at=excluded.last_seen_at,
      sample_url=excluded.sample_url,
      seen_count=seen_count + 1
  `,
  ).run(host, String(sampleUrl || "").slice(0, 800), now, now);
}

function banUserSilently(db, logEvent, discordId, req, details = {}) {
  const now = Date.now();
  db.prepare(
    `
    INSERT INTO bans (discord_id, reason, banned_by, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(discord_id) DO UPDATE SET
      reason=excluded.reason,
      banned_by=excluded.banned_by,
      created_at=excluded.created_at
  `,
  ).run(discordId, null, "system", now);

  logEvent({
    type: "user_banned",
    actorUserId: "system",
    targetUserId: discordId,
    req,
    payload: { reason: null, auto: true, ...details },
  });
}

function enforceUrlPolicy({ db, logEvent }, req, res, rawUrl) {
  const host = extractHostFromUrl(rawUrl);

  if (!host) {
    res.status(400).json({ ok: false, message: "Invalid URL." });
    return { ok: false, blocked: true };
  }

  const allow = getAllowSet();
  const block = getBlockSet();

  if (block.has(host)) {
    const actorDiscordId = String(
      req.actorUser?.discord_id ||
        req.apiUser?.discord_id ||
        req.user?.discord_id ||
        "",
    ).trim();
    if (actorDiscordId) {
      banUserSilently(db, logEvent, actorDiscordId, req, {
        rule: "url_blocklist",
        host,
        url: String(rawUrl || "").slice(0, 800),
      });
    }

    res.status(403).json({ ok: false, message: "Not allowed." });
    return { ok: false, blocked: true };
  }

  if (allow.has(host)) {
    return { ok: true, host, status: "allowed" };
  }

  upsertVerificationHost(db, host, rawUrl);
  return { ok: true, host, status: "queued" };
}

function safeNowMs() {
  return Date.now();
}

function b64ToBuffer(b64) {
  const s = String(b64 || "");
  const comma = s.indexOf(",");
  const raw = comma >= 0 ? s.slice(comma + 1) : s;
  return Buffer.from(raw, "base64");
}

function recordScreenshotResponseFromAck({ db, deviceId, ack, ownerUserId, responsesDir }) {
  const details = ack && ack.details ? ack.details : null;
  if (!details || !details.webp_b64) return false;

  const buf = b64ToBuffer(details.webp_b64);

  const createdAt = Number(details.created_at || ack.created_at || safeNowMs());
  const width = Number(details.width || 0) || null;
  const height = Number(details.height || 0) || null;
  const monitors = Number(details.monitors || 0) || null;

  const mime = String(details.mime || "image/webp");
  const commandId = ack.commandId ? String(ack.commandId) : null;
  const actorUserId = resolveActorUserIdByCommandId(commandId);

  const id = crypto.randomUUID();

  const filename = `screenshot_${createdAt}_${deviceId}_${id}.webp`;
  const filePath = path.join(responsesDir, filename);

  fs.writeFileSync(filePath, buf);

  db.prepare(`
    INSERT INTO device_responses
      (id, owner_user_id, actor_user_id, device_id, created_at, response_type, mime, file_path, bytes, width, height, monitors, command_id)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    ownerUserId,
    actorUserId,
    deviceId,
    createdAt,
    "screenshot",
    mime,
    filePath,
    buf.length,
    width,
    height,
    monitors,
    commandId
  );

  console.log("[responses] saved screenshot", {
    id,
    deviceId,
    ownerUserId,
    actorUserId,
    file: filename,
    bytes: buf.length,
    width,
    height,
    monitors,
    commandId,
  });

  return true;
}

function resolveActorUserIdByCommandId(commandId) {
  const id = String(commandId || "").trim();
  if (!id) return null;

  const pendingContext = getPendingCommandContext(id);
  const pendingActorUserId = String(pendingContext?.actorUserId || "").trim();
  if (pendingActorUserId) {
    return pendingActorUserId;
  }

  const rows = db
    .prepare(
      `
    SELECT actor_user_id, payload
    FROM events
    WHERE actor_user_id IS NOT NULL
      AND payload LIKE ?
    ORDER BY created_at DESC
    LIMIT 20
  `,
    )
    .all(`%${id}%`);

  for (const row of rows) {
    const payload = tryJson(row.payload);
    if (String(payload?.commandId || "").trim() === id) {
      return String(row.actor_user_id || "").trim() || null;
    }
  }

  return null;
}

function appendHostToFile(filePath, host) {
  ensureListFilesExist();
  const h = normalizeHost(host);
  if (!h) return;

  const txt = fs.readFileSync(filePath, "utf8");
  const lines = txt
    .split(/\r?\n/)
    .map((l) => parseHostLine(l))
    .filter(Boolean);
  const set = new Set(lines);

  if (!set.has(h)) {
    fs.appendFileSync(
      filePath,
      (txt.endsWith("\n") || txt.length === 0 ? "" : "\n") + h + "\n",
      "utf8",
    );
  }
}

function removeHostFromFile(filePath, host) {
  ensureListFilesExist();
  const h = normalizeHost(host);
  const txt = fs.readFileSync(filePath, "utf8");
  const out = [];
  for (const line of txt.split(/\r?\n/)) {
    const parsed = parseHostLine(line);
    if (!parsed) {
      out.push(line);
      continue;
    }
    if (parsed === h) continue;
    out.push(parsed);
  }
  fs.writeFileSync(
    filePath,
    out
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd() + "\n",
    "utf8",
  );
}

module.exports = {
  ALLOWLIST_PATH,
  BLOCKLIST_PATH,
  getAllowSet,
  getBlockSet,
  extractHostFromUrl,
  enforceUrlPolicy,
  appendHostToFile,
  removeHostFromFile,
  discordAvatarUrl,
};

const { resourceLimits } = require("worker_threads");

db.exec(`
  CREATE TABLE IF NOT EXISTS group_memberships (
    group_key TEXT NOT NULL,
    user_id   TEXT NOT NULL,     -- your discord_id
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (group_key, user_id)
  );

  CREATE INDEX IF NOT EXISTS idx_group_memberships_user ON group_memberships(user_id);
  CREATE INDEX IF NOT EXISTS idx_group_memberships_group ON group_memberships(group_key);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS heavy_cooldowns (
    actor_id TEXT PRIMARY KEY,
    last_ms INTEGER NOT NULL
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS uploaded_files (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    original_name TEXT,
    stored_name TEXT NOT NULL UNIQUE,
    file_path TEXT NOT NULL,
    mime TEXT NOT NULL,
    ext TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    preview_kind TEXT NOT NULL,
    media_group TEXT NOT NULL,
    wallpaper_compatible INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    protected_until INTEGER,
    delete_after_queue INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY(user_id) REFERENCES users(discord_id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_uploaded_files_user_created
    ON uploaded_files(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_uploaded_files_expires
    ON uploaded_files(expires_at, created_at ASC);
  CREATE INDEX IF NOT EXISTS idx_uploaded_files_created
    ON uploaded_files(created_at ASC);
  CREATE INDEX IF NOT EXISTS idx_uploaded_files_protected_until
    ON uploaded_files(protected_until ASC, created_at ASC);
`);

try {
  const uploadCols = db.prepare(`PRAGMA table_info(uploaded_files)`).all();
  const hasDeleteAfterQueue = uploadCols.some(
    (col) => String(col.name) === "delete_after_queue",
  );
  if (!hasDeleteAfterQueue) {
    db.exec(
      `ALTER TABLE uploaded_files ADD COLUMN delete_after_queue INTEGER NOT NULL DEFAULT 0`,
    );
    console.log("[db] added uploaded_files.delete_after_queue");
  }
} catch (e) {
  console.warn(
    "[db] could not ensure uploaded_files.delete_after_queue:",
    e?.message || e,
  );
}

db.exec(`
  CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    action_url TEXT,
    action_label TEXT,
    meta_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    read_at INTEGER,
    created_by TEXT,
    source_type TEXT,
    source_id TEXT,
    FOREIGN KEY(user_id) REFERENCES users(discord_id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_notifications_user_created
    ON notifications(user_id, created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_notifications_user_read
    ON notifications(user_id, read_at, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_notifications_created_by
    ON notifications(created_by, created_at DESC);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY,
    subject_type TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    subject_pair_code TEXT,
    subject_display_name TEXT,
    reporter_user_id TEXT NOT NULL,
    reporter_display_name TEXT,
    reason_key TEXT NOT NULL,
    reason_label TEXT NOT NULL,
    details TEXT,
    meta_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    strike_count INTEGER NOT NULL DEFAULT 0,
    resolved_at INTEGER,
    resolved_by TEXT,
    FOREIGN KEY(reporter_user_id) REFERENCES users(discord_id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_reports_created
    ON reports(created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_reports_subject
    ON reports(subject_type, subject_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_reports_reporter
    ON reports(reporter_user_id, created_at DESC);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS user_strikes (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    strike_delta INTEGER NOT NULL,
    reason_label TEXT NOT NULL,
    source_label TEXT,
    details TEXT,
    source_type TEXT NOT NULL,
    source_id TEXT,
    report_id TEXT,
    meta_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    created_by TEXT,
    FOREIGN KEY(user_id) REFERENCES users(discord_id) ON DELETE CASCADE,
    FOREIGN KEY(created_by) REFERENCES users(discord_id) ON DELETE SET NULL,
    FOREIGN KEY(report_id) REFERENCES reports(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_user_strikes_user_created
    ON user_strikes(user_id, created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_user_strikes_report
    ON user_strikes(report_id, created_at DESC, id DESC);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS report_media_backups (
    id TEXT PRIMARY KEY,
    report_id TEXT NOT NULL UNIQUE,
    backup_kind TEXT NOT NULL,
    source_url TEXT,
    original_name TEXT,
    stored_name TEXT NOT NULL UNIQUE,
    file_path TEXT NOT NULL,
    mime TEXT NOT NULL,
    ext TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(report_id) REFERENCES reports(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_report_media_backups_created
    ON report_media_backups(created_at DESC, id DESC);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS command_sender_blocks (
    owner_user_id TEXT NOT NULL,
    blocked_user_id TEXT NOT NULL,
    source_event_id TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (owner_user_id, blocked_user_id),
    FOREIGN KEY(owner_user_id) REFERENCES users(discord_id) ON DELETE CASCADE,
    FOREIGN KEY(blocked_user_id) REFERENCES users(discord_id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_command_sender_blocks_owner_created
    ON command_sender_blocks(owner_user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_command_sender_blocks_blocked_created
    ON command_sender_blocks(blocked_user_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS command_history_likes (
    event_id TEXT PRIMARY KEY,
    liked_user_id TEXT NOT NULL,
    liker_user_id TEXT NOT NULL,
    source_kind TEXT NOT NULL DEFAULT 'direct',
    source_id TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(liked_user_id) REFERENCES users(discord_id) ON DELETE CASCADE,
    FOREIGN KEY(liker_user_id) REFERENCES users(discord_id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_command_history_likes_liked_created
    ON command_history_likes(liked_user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_command_history_likes_liker_created
    ON command_history_likes(liker_user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_command_history_likes_source
    ON command_history_likes(source_kind, source_id, created_at DESC);
`);

try {
  db.exec(`ALTER TABLE device_responses ADD COLUMN actor_user_id TEXT`);
  console.log("[db] added device_responses.actor_user_id");
} catch {}

try {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_device_responses_actor
    ON device_responses(actor_user_id, created_at DESC)
  `);
} catch {}

try {
  db.exec(`ALTER TABLE users ADD COLUMN allow_write_for_me INTEGER DEFAULT 1`);
} catch {}

try {
  db.exec(
    `ALTER TABLE users ADD COLUMN allow_subliminal_message INTEGER DEFAULT 1`,
  );
} catch {}

try {
  db.exec(`ALTER TABLE reports ADD COLUMN resolved_at INTEGER`);
} catch {}

try {
  db.exec(`ALTER TABLE reports ADD COLUMN resolved_by TEXT`);
} catch {}

try {
  db.exec(`ALTER TABLE reports ADD COLUMN strike_count INTEGER NOT NULL DEFAULT 0`);
} catch {}

try {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_reports_resolved
    ON reports(resolved_at, created_at DESC, id DESC)
  `);
} catch {}

try {
  db.exec(
    `ALTER TABLE users ADD COLUMN has_supporter_badge INTEGER NOT NULL DEFAULT 0`,
  );
} catch {}

try {
  db.exec(
    `ALTER TABLE users ADD COLUMN command_likes_total INTEGER NOT NULL DEFAULT 0`,
  );
} catch {}

try {
  const cols = db.prepare(`PRAGMA table_info(users)`).all();
  const has = cols.some(c => String(c.name) === "client_prefs_imported_at");
  if (!has) {
    db.exec(`ALTER TABLE users ADD COLUMN client_prefs_imported_at INTEGER`);
    console.log("[db] added users.client_prefs_imported_at");
  }
} catch (e) {
  console.warn("[db] could not ensure client_prefs_imported_at:", e?.message || e);
}

function tableExists(name) {
  return !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(name);
}

const deleteUploadedFileRow = db.prepare(`DELETE FROM uploaded_files WHERE id=?`);
const deleteQueuedCommandRow = db.prepare(`DELETE FROM queued_commands WHERE id=?`);
const updateDeviceResponseActorUserId = db.prepare(`
  UPDATE device_responses
  SET actor_user_id=?
  WHERE id=?
`);
const insertQueuedCommandUploadRef = db.prepare(`
  INSERT INTO queued_command_upload_refs (queue_id, upload_id, created_at)
  VALUES (?, ?, ?)
  ON CONFLICT(queue_id, upload_id) DO NOTHING
`);
const listQueuedCommandUploadRefs = db.prepare(`
  SELECT upload_id
  FROM queued_command_upload_refs
  WHERE queue_id=?
  ORDER BY created_at ASC, upload_id ASC
`);
const extendUploadedFileProtectionUntil = db.prepare(`
  UPDATE uploaded_files
  SET protected_until = CASE
    WHEN IFNULL(protected_until, 0) > ? THEN protected_until
    ELSE ?
  END
  WHERE id=?
`);
const markUploadedFileDeleteAfterQueue = db.prepare(`
  UPDATE uploaded_files
  SET delete_after_queue=1
  WHERE id=?
`);
const deleteReportMediaBackupRow = db.prepare(
  `DELETE FROM report_media_backups WHERE id=?`,
);
function getRequestOrigin(req) {
  return `${req.protocol}://${req.get("host")}`;
}

const {
  broadcastNotificationToAllUsers,
  clearAllNotificationsForUser,
  clearNotificationForUser,
  countNotificationsForUser,
  countUnreadNotificationsForUser,
  createNotificationsForUsers,
  createStrikeNotification,
  dispatchReport,
  ensureUserBannedForStrikes,
  formatCountLabel,
  formatNotificationTimeLabel,
  getNotificationSummaryForUser,
  getReportReasonOption,
  getStrikeSourceLabelForReport,
  getUserStrikeCount,
  getUserStrikeState,
  getUserStrikeStatesByUserIds,
  insertUserStrikeEntry,
  listNotificationsForUser,
  listUserStrikeHistory,
  markAdminReportQueueNotificationsReadForUser,
  markAllNotificationsReadForUser,
  normalizeNotificationActionLabel,
  normalizeNotificationActionUrl,
  normalizeNotificationMessage,
  normalizeNotificationTitle,
  normalizeReportDetails,
  normalizeReportSubjectType,
  normalizeStrikeCount,
  serializeNotificationMeta,
  setUserStrikeCountByAdmin,
  upsertCommandLikeNotification,
} = createNotificationService({
  db,
  crypto,
  tryJson,
  normalizeControlLinkDisplayName,
  logEvent,
  constants: {
    ADMIN_REPORT_QUEUE_KIND,
    ADMIN_REPORT_QUEUE_SOURCE_ID,
    ADMIN_REPORT_QUEUE_SOURCE_TYPE,
    ALL_REPORT_REASON_BY_KEY,
    MAX_USER_STRIKES,
    NOTIFICATION_ACTION_LABEL_MAX_LEN,
    NOTIFICATION_KIND_MAX_LEN,
    NOTIFICATION_MENU_LIMIT,
    NOTIFICATION_MESSAGE_MAX_LEN,
    NOTIFICATION_PAGE_LIMIT,
    NOTIFICATION_TITLE_MAX_LEN,
    PROFILE_STRIKE_HISTORY_LIMIT,
    REPORT_DETAILS_MAX_LEN,
    REPORT_SUBJECT_TYPE_MAX_LEN,
  },
});

function createControlLinkReport({
  ownerUserId,
  ownerUser = null,
  pairCode = null,
  reporterUser = null,
  reasonKey,
  reasonMap = CONTROL_LINK_REPORT_REASON_BY_KEY,
  details = "",
  req = null,
}) {
  const subjectUserId = String(ownerUserId || "").trim();
  const reporterUserId = String(
    reporterUser?.discord_id || reporterUser?.user_id || "",
  ).trim();
  const safePairCode = /^\d{6}$/.test(String(pairCode || "").trim())
    ? String(pairCode || "").trim()
    : null;
  const reason = getReportReasonOption(reasonKey, reasonMap);
  const safeDetails = normalizeReportDetails(details);

  if (!subjectUserId) {
    throw new Error("Missing report subject.");
  }
  if (!reporterUserId) {
    throw new Error("Missing reporter.");
  }
  if (!reason) {
    throw new Error("Please choose a valid reason.");
  }
  if (subjectUserId === reporterUserId) {
    throw new Error("You can't report your own control link.");
  }

  const report = {
    id: crypto.randomUUID(),
    subjectType: "control_link",
    subjectId: subjectUserId,
    subjectPairCode: safePairCode,
    subjectDisplayName: getPreferredDisplayName(
      ownerUser || { discord_id: subjectUserId },
    ),
    reporterUserId,
    reporterDisplayName: getPreferredDisplayName(
      reporterUser || { discord_id: reporterUserId },
    ),
    reasonKey: reason.key,
    reasonLabel: reason.label,
    details: safeDetails,
    meta: {
      reasonDescription: reason.description,
    },
    createdAt: Date.now(),
  };

  db.prepare(
    `
      INSERT INTO reports (
        id,
        subject_type,
        subject_id,
        subject_pair_code,
        subject_display_name,
        reporter_user_id,
        reporter_display_name,
        reason_key,
        reason_label,
        details,
        meta_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    report.id,
    report.subjectType,
    report.subjectId,
    report.subjectPairCode,
    report.subjectDisplayName,
    report.reporterUserId,
    report.reporterDisplayName,
    report.reasonKey,
    report.reasonLabel,
    report.details || null,
    serializeNotificationMeta(report.meta),
    report.createdAt,
  );

  const deliveries = dispatchReport(report);

  logEvent({
    type: "control_link_report_created",
    actorUserId: report.reporterUserId,
    targetUserId: report.subjectId,
    pairCode: report.subjectPairCode,
    req,
    payload: {
      reportId: report.id,
      subjectType: report.subjectType,
      reasonKey: report.reasonKey,
      reasonLabel: report.reasonLabel,
      detailsLength: report.details.length,
      deliveries: deliveries.map((delivery) => ({
        channel: delivery.channel,
        count: Number(delivery.count || 0),
      })),
    },
  });

  return {
    report,
    deliveries,
  };
}

function createCommunityGroupReport({
  groupKey,
  groupName,
  ownerUserId,
  reporterUser = null,
  reasonKey,
  reasonMap = CONTROL_LINK_REPORT_REASON_BY_KEY,
  details = "",
  meta = {},
  req = null,
}) {
  const safeGroupKey = String(groupKey || "").trim();
  const safeGroupName = String(groupName || safeGroupKey || "Community group").trim();
  const safeOwnerUserId = String(ownerUserId || "").trim();
  const reporterUserId = String(
    reporterUser?.discord_id || reporterUser?.user_id || "",
  ).trim();
  const reason = getReportReasonOption(reasonKey, reasonMap);
  const safeDetails = normalizeReportDetails(details);

  if (!safeGroupKey) {
    throw new Error("Missing report subject.");
  }
  if (!reporterUserId) {
    throw new Error("Missing reporter.");
  }
  if (!reason) {
    throw new Error("Please choose a valid reason.");
  }
  if (safeOwnerUserId && reporterUserId === safeOwnerUserId) {
    throw new Error("You can't report your own community group.");
  }

  const report = {
    id: crypto.randomUUID(),
    subjectType: "community_group",
    subjectId: safeGroupKey,
    subjectPairCode: null,
    subjectDisplayName: safeGroupName,
    reporterUserId,
    reporterDisplayName: getPreferredDisplayName(
      reporterUser || { discord_id: reporterUserId },
    ),
    reasonKey: reason.key,
    reasonLabel: reason.label,
    details: safeDetails,
    meta: {
      reasonDescription: reason.description,
      groupKey: safeGroupKey,
      groupName: safeGroupName,
      ownerUserId: safeOwnerUserId || null,
      ...meta,
    },
    createdAt: Date.now(),
  };

  db.prepare(
    `
      INSERT INTO reports (
        id,
        subject_type,
        subject_id,
        subject_pair_code,
        subject_display_name,
        reporter_user_id,
        reporter_display_name,
        reason_key,
        reason_label,
        details,
        meta_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    report.id,
    report.subjectType,
    report.subjectId,
    report.subjectPairCode,
    report.subjectDisplayName,
    report.reporterUserId,
    report.reporterDisplayName,
    report.reasonKey,
    report.reasonLabel,
    report.details || null,
    serializeNotificationMeta(report.meta),
    report.createdAt,
  );

  const deliveries = dispatchReport(report);

  logEvent({
    type: "community_group_report_created",
    actorUserId: report.reporterUserId,
    targetUserId: safeOwnerUserId || null,
    req,
    payload: {
      reportId: report.id,
      subjectType: report.subjectType,
      groupKey: safeGroupKey,
      reasonKey: report.reasonKey,
      reasonLabel: report.reasonLabel,
      detailsLength: report.details.length,
      deliveries: deliveries.map((delivery) => ({
        channel: delivery.channel,
        count: Number(delivery.count || 0),
      })),
    },
  });

  return { report, deliveries };
}

function createUserReport({
  subjectUserId,
  subjectUser = null,
  reporterUser = null,
  reasonKey,
  reasonMap = ALL_REPORT_REASON_BY_KEY,
  details = "",
  meta = {},
  req = null,
}) {
  const targetUserId = String(subjectUserId || "").trim();
  const reporterUserId = String(
    reporterUser?.discord_id || reporterUser?.user_id || "",
  ).trim();
  const reason = getReportReasonOption(reasonKey, reasonMap);
  const safeDetails = normalizeReportDetails(details);
  const pairRow = targetUserId
    ? db.prepare(`SELECT code_plain FROM pair_codes WHERE user_id=?`).get(targetUserId)
    : null;
  const safePairCode = /^\d{6}$/.test(String(pairRow?.code_plain || "").trim())
    ? String(pairRow.code_plain || "").trim()
    : null;

  if (!targetUserId) {
    throw new Error("Missing report subject.");
  }
  if (!reporterUserId) {
    throw new Error("Missing reporter.");
  }
  if (!reason) {
    throw new Error("Please choose a valid reason.");
  }
  if (targetUserId === reporterUserId) {
    throw new Error("You can't report yourself.");
  }

  const report = {
    id: crypto.randomUUID(),
    subjectType: "user",
    subjectId: targetUserId,
    subjectPairCode: safePairCode,
    subjectDisplayName: getPreferredDisplayName(
      subjectUser || { discord_id: targetUserId },
    ),
    reporterUserId,
    reporterDisplayName: getPreferredDisplayName(
      reporterUser || { discord_id: reporterUserId },
    ),
    reasonKey: reason.key,
    reasonLabel: reason.label,
    details: safeDetails,
    meta: {
      reasonDescription: reason.description,
      ...meta,
    },
    createdAt: Date.now(),
  };

  db.prepare(
    `
      INSERT INTO reports (
        id,
        subject_type,
        subject_id,
        subject_pair_code,
        subject_display_name,
        reporter_user_id,
        reporter_display_name,
        reason_key,
        reason_label,
        details,
        meta_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    report.id,
    report.subjectType,
    report.subjectId,
    report.subjectPairCode,
    report.subjectDisplayName,
    report.reporterUserId,
    report.reporterDisplayName,
    report.reasonKey,
    report.reasonLabel,
    report.details || null,
    serializeNotificationMeta(report.meta),
    report.createdAt,
  );

  const deliveries = dispatchReport(report);

  logEvent({
    type: "user_report_created",
    actorUserId: report.reporterUserId,
    targetUserId: report.subjectId,
    req,
    payload: {
      reportId: report.id,
      subjectType: report.subjectType,
      reasonKey: report.reasonKey,
      reasonLabel: report.reasonLabel,
      detailsLength: report.details.length,
      deliveries: deliveries.map((delivery) => ({
        channel: delivery.channel,
        count: Number(delivery.count || 0),
      })),
      meta,
    },
  });

  return {
    report,
    deliveries,
  };
}

function serializeReportRow(row) {
  const createdAt = Number(row?.created_at || 0);
  const subjectId = String(row?.subject_id || "").trim();
  const reporterUserId = String(row?.reporter_user_id || "").trim();
  const subjectDisplayName =
    normalizeControlLinkDisplayName(row?.subject_control_link_display_name) ||
    String(row?.subject_global_name || "").trim() ||
    String(row?.subject_username || "").trim() ||
    String(row?.subject_display_name || "").trim() ||
    subjectId ||
    "Unknown user";
  const reporterDisplayName =
    normalizeControlLinkDisplayName(row?.reporter_control_link_display_name) ||
    String(row?.reporter_global_name || "").trim() ||
    String(row?.reporter_username || "").trim() ||
    String(row?.reporter_display_name || "").trim() ||
    reporterUserId ||
    "Unknown user";
  const currentPairCode = String(row?.current_pair_code || "").trim();
  const snapshotPairCode = String(row?.subject_pair_code || "").trim();
  const preferredPairCode = currentPairCode || snapshotPairCode || "";
  const subjectType = normalizeReportSubjectType(row?.subject_type);
  const mediaBackupId = String(row?.media_backup_id || "").trim();
  const mediaBackupOriginalName = String(
    row?.media_backup_original_name || "",
  ).trim();
  const mediaBackupMime = normalizeStoredMime(row?.media_backup_mime, "");
  const mediaBackupBytes = Number(row?.media_backup_bytes || 0);
  const resolvedStrikeCount = Math.max(0, Number(row?.strike_count || 0));
  const resolvedAt = Number(row?.resolved_at || 0);
  const resolvedByUserId = String(row?.resolved_by || "").trim();
  const resolvedByDisplayName =
    normalizeControlLinkDisplayName(row?.resolved_by_control_link_display_name) ||
    String(row?.resolved_by_global_name || "").trim() ||
    String(row?.resolved_by_username || "").trim() ||
    resolvedByUserId ||
    "";

  return {
    id: String(row?.id || "").trim(),
    subjectType,
    subjectTypeLabel:
      subjectType === "control_link"
        ? "Control link"
        : subjectType === "user"
          ? "User"
          : subjectType === "community_group"
            ? "Community group"
            : "Subject",
    subjectId,
    subjectPairCode: snapshotPairCode || null,
    currentPairCode: currentPairCode || null,
    subjectDisplayName,
    reporterUserId,
    reporterDisplayName,
    reasonKey: String(row?.reason_key || "").trim(),
    reasonLabel:
      String(row?.reason_label || "").trim() ||
      getReportReasonOption(row?.reason_key, ALL_REPORT_REASON_BY_KEY)?.label ||
      "Other",
    details: String(row?.details || "").trim(),
    meta: tryJson(row?.meta_json) || {},
    createdAt,
    createdIso: createdAt ? new Date(createdAt).toISOString() : "",
    createdLabel: formatNotificationTimeLabel(createdAt),
    resolvedStrikeCount,
    isResolved: !!resolvedAt,
    resolvedAt: resolvedAt || null,
    resolvedIso: resolvedAt ? new Date(resolvedAt).toISOString() : "",
    resolvedLabel: resolvedAt ? formatNotificationTimeLabel(resolvedAt) : "",
    resolvedByUserId: resolvedByUserId || null,
    resolvedByDisplayName: resolvedByDisplayName || null,
    mediaBackupId: mediaBackupId || null,
    mediaBackupOriginalName: mediaBackupOriginalName || null,
    mediaBackupMime: mediaBackupMime || null,
    mediaBackupBytes,
    mediaBackupSizeLabel: mediaBackupBytes
      ? formatBytesCompact(mediaBackupBytes)
      : "",
    mediaBackupUrl:
      mediaBackupId && String(row?.id || "").trim()
        ? `/admin/reports/${encodeURIComponent(String(row.id))}/media-backup/${encodeURIComponent(mediaBackupId)}`
        : null,
    subjectLinkUrl: preferredPairCode
      ? `/device/${encodeURIComponent(preferredPairCode)}`
      : subjectType === "community_group" && subjectId
        ? `/group/${encodeURIComponent(subjectId)}`
        : null,
    subjectAdminUrl: subjectId
      ? `/admin/users?q=${encodeURIComponent(subjectId)}`
      : null,
    reporterAdminUrl: reporterUserId
      ? `/admin/users?q=${encodeURIComponent(reporterUserId)}`
      : null,
  };
}

function getReportsResolvedWhereSql(resolved) {
  if (resolved === true) return `r.resolved_at IS NOT NULL`;
  if (resolved === false) return `r.resolved_at IS NULL`;
  return `1=1`;
}

function countReports({ resolved = null } = {}) {
  const row = db
    .prepare(
      `
      SELECT COUNT(*) AS n
      FROM reports r
      WHERE ${getReportsResolvedWhereSql(resolved)}
    `,
    )
    .get();
  return Number(row?.n || 0);
}

function listRecentReports(
  limit = REPORTS_PAGE_LIMIT,
  { resolved = null, offset = 0 } = {},
) {
  const orderSql =
    resolved === true
      ? `r.resolved_at DESC, r.created_at DESC, r.id DESC`
      : `r.created_at DESC, r.id DESC`;
  const rows = db
    .prepare(
      `
      SELECT
        r.id,
        r.subject_type,
        r.subject_id,
        r.subject_pair_code,
        r.subject_display_name,
        r.reporter_user_id,
        r.reporter_display_name,
        r.reason_key,
        r.reason_label,
        r.details,
        r.meta_json,
        r.created_at,
        r.strike_count,
        r.resolved_at,
        r.resolved_by,
        rmb.id AS media_backup_id,
        rmb.original_name AS media_backup_original_name,
        rmb.mime AS media_backup_mime,
        rmb.bytes AS media_backup_bytes,
        reporter.username AS reporter_username,
        reporter.global_name AS reporter_global_name,
        reporter.control_link_display_name AS reporter_control_link_display_name,
        resolver.username AS resolved_by_username,
        resolver.global_name AS resolved_by_global_name,
        resolver.control_link_display_name AS resolved_by_control_link_display_name,
        subject.username AS subject_username,
        subject.global_name AS subject_global_name,
        subject.control_link_display_name AS subject_control_link_display_name,
        pc.code_plain AS current_pair_code
      FROM reports r
      LEFT JOIN report_media_backups rmb
        ON rmb.report_id = r.id
      LEFT JOIN users reporter
        ON reporter.discord_id = r.reporter_user_id
      LEFT JOIN users resolver
        ON resolver.discord_id = r.resolved_by
      LEFT JOIN users subject
        ON subject.discord_id = CASE
          WHEN r.subject_type IN ('control_link', 'user') THEN r.subject_id
          ELSE NULL
        END
      LEFT JOIN pair_codes pc
        ON pc.user_id = CASE
          WHEN r.subject_type IN ('control_link', 'user') THEN r.subject_id
          ELSE NULL
        END
      WHERE ${getReportsResolvedWhereSql(resolved)}
      ORDER BY ${orderSql}
      LIMIT ?
      OFFSET ?
    `,
    )
    .all(
      Math.max(
        1,
        Math.min(Number(limit || 0) || REPORTS_PAGE_LIMIT, REPORTS_PAGE_LIMIT),
      ),
      Math.max(0, Number(offset || 0) || 0),
    );

  return rows.map(serializeReportRow);
}

function findReportById(reportId) {
  const id = String(reportId || "").trim();
  if (!id) return null;

  return (
    db
      .prepare(
        `
        SELECT
          id,
          subject_type,
          subject_id,
          subject_pair_code,
          subject_display_name,
          reason_key,
          reason_label,
          details,
          meta_json,
          strike_count,
          resolved_at,
          resolved_by
        FROM reports
        WHERE id=?
        LIMIT 1
      `,
      )
      .get(id) || null
  );
}

function clearReportMediaBackupsForReport(reportId) {
  const id = String(reportId || "").trim();
  if (!id) return 0;

  const rows = db
    .prepare(
      `
      SELECT id, file_path
      FROM report_media_backups
      WHERE report_id=?
      ORDER BY created_at DESC, id DESC
    `,
    )
    .all(id);

  return deleteReportMediaBackups(rows, `report:${id}`);
}

function resolveReportForAdmin(
  reportId,
  resolvedByUserId,
  { req = null, requestedStrikeCount = 0 } = {},
) {
  const id = String(reportId || "").trim();
  const resolverId = String(resolvedByUserId || "").trim();
  const safeRequestedStrikeCount = normalizeStrikeCount(requestedStrikeCount);
  if (!id) {
    return { ok: false, code: "not_found", message: "Report not found." };
  }
  if (!resolverId) {
    return { ok: false, code: "not_allowed", message: "Admin required." };
  }
  if (safeRequestedStrikeCount === null) {
    return {
      ok: false,
      code: "bad_strike_count",
      message: `Strike count must be between 0 and ${MAX_USER_STRIKES}.`,
    };
  }

  const existing = findReportById(id);
  if (!existing) {
    return { ok: false, code: "not_found", message: "Report not found." };
  }
  if (Number(existing.resolved_at || 0) > 0) {
    return {
      ok: false,
      code: "already_resolved",
      message: "That report is already in history.",
    };
  }

  const subjectUserId = String(existing.subject_id || "").trim();
  const subjectExists = subjectUserId
    ? !!db
        .prepare(`SELECT discord_id FROM users WHERE discord_id=? LIMIT 1`)
        .get(subjectUserId)
    : false;
  const previousStrikeCount = subjectExists ? getUserStrikeCount(subjectUserId) : 0;
  const remainingStrikeCapacity = subjectExists
    ? Math.max(0, MAX_USER_STRIKES - previousStrikeCount)
    : 0;
  const appliedStrikeCount = Math.min(
    safeRequestedStrikeCount,
    remainingStrikeCapacity,
  );
  const resolvedAt = Date.now();
  let info = null;
  let banResult = { banned: false, alreadyBanned: false };

  const tx = db.transaction(() => {
    info = db
      .prepare(
        `
        UPDATE reports
        SET resolved_at=?, resolved_by=?, strike_count=?
        WHERE id=? AND resolved_at IS NULL
      `,
      )
      .run(resolvedAt, resolverId, appliedStrikeCount, id);

    if (Number(info?.changes || 0) !== 1) {
      throw new Error("already_resolved");
    }

    if (subjectExists && appliedStrikeCount > 0) {
      insertUserStrikeEntry({
        userId: subjectUserId,
        strikeDelta: appliedStrikeCount,
        reasonLabel:
          String(existing.reason_label || "").trim() || "Report resolved",
        sourceLabel: getStrikeSourceLabelForReport(existing),
        details:
          "Issued when admins resolved a report against your account or control link.",
        sourceType: "report_resolution",
        sourceId: id,
        reportId: id,
        createdByUserId: resolverId,
        meta: {
          reasonKey: String(existing.reason_key || "").trim() || null,
          subjectType: normalizeReportSubjectType(existing.subject_type),
          requestedStrikeCount: safeRequestedStrikeCount,
          appliedStrikeCount,
        },
      });

      createStrikeNotification({
        userId: subjectUserId,
        strikeDelta: appliedStrikeCount,
        finalStrikeCount: previousStrikeCount + appliedStrikeCount,
        reasonLabel:
          String(existing.reason_label || "").trim() || "Report resolved",
        createdByUserId: resolverId,
        sourceType: "report_resolution",
        sourceId: id,
        reportId: id,
      });
    }

    if (subjectExists && previousStrikeCount + appliedStrikeCount >= MAX_USER_STRIKES) {
      banResult = ensureUserBannedForStrikes(subjectUserId, resolverId, {
        req,
        strikeCount: previousStrikeCount + appliedStrikeCount,
      });
    }
  });

  try {
    tx();
  } catch (e) {
    if (String(e?.message || "").includes("already_resolved")) {
      return {
        ok: false,
        code: "already_resolved",
        message: "That report is already in history.",
      };
    }
    console.warn("[reports] resolve failed:", e?.message || e);
    return {
      ok: false,
      code: "resolve_failed",
      message: "Could not resolve that report.",
    };
  }

  if (Number(info?.changes || 0) !== 1) {
    return {
      ok: false,
      code: "already_resolved",
      message: "That report is already in history.",
    };
  }

  const finalStrikeCount = subjectExists
    ? Math.min(MAX_USER_STRIKES, previousStrikeCount + appliedStrikeCount)
    : 0;
  const backupDeletedCount = clearReportMediaBackupsForReport(id);

  logEvent({
    type: "report_resolved",
    actorUserId: resolverId,
    targetUserId: subjectUserId || null,
    req,
    payload: {
      reportId: id,
      requestedStrikeCount: safeRequestedStrikeCount,
      appliedStrikeCount,
      previousStrikeCount,
      finalStrikeCount,
      strikeCapped: appliedStrikeCount < safeRequestedStrikeCount,
      autoBanned: !!banResult?.banned,
      backupDeletedCount,
      resolvedAt,
    },
  });

  return {
    ok: true,
    reportId: id,
    backupDeletedCount,
    resolvedAt,
    requestedStrikeCount: safeRequestedStrikeCount,
    appliedStrikeCount,
    previousStrikeCount,
    finalStrikeCount,
    strikeCapped: appliedStrikeCount < safeRequestedStrikeCount,
    didBan: !!banResult?.banned,
    alreadyBanned: !!banResult?.alreadyBanned,
  };
}

function countCommandSenderBlocks() {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM command_sender_blocks`).get();
  return Number(row?.n || 0);
}

function listRecentCommandSenderBlocks(limit = COMMAND_BLOCKS_PAGE_LIMIT) {
  const rows = db
    .prepare(
      `
      SELECT
        b.owner_user_id,
        b.blocked_user_id,
        b.source_event_id,
        b.created_at,
        owner.username AS owner_username,
        owner.global_name AS owner_global_name,
        owner.control_link_display_name AS owner_control_link_display_name,
        blocked.username AS blocked_username,
        blocked.global_name AS blocked_global_name,
        blocked.control_link_display_name AS blocked_control_link_display_name
      FROM command_sender_blocks b
      LEFT JOIN users owner ON owner.discord_id = b.owner_user_id
      LEFT JOIN users blocked ON blocked.discord_id = b.blocked_user_id
      ORDER BY b.created_at DESC, b.owner_user_id ASC, b.blocked_user_id ASC
      LIMIT ?
    `,
    )
    .all(
      Math.max(
        1,
        Math.min(
          Number(limit || 0) || COMMAND_BLOCKS_PAGE_LIMIT,
          COMMAND_BLOCKS_PAGE_LIMIT,
        ),
      ),
    );

  return rows.map((row) => {
    const createdAt = Number(row?.created_at || 0);
    const ownerUserId = String(row?.owner_user_id || "").trim();
    const blockedUserId = String(row?.blocked_user_id || "").trim();
    return {
      ownerUserId,
      ownerDisplayName:
        normalizeControlLinkDisplayName(row?.owner_control_link_display_name) ||
        String(row?.owner_global_name || "").trim() ||
        String(row?.owner_username || "").trim() ||
        ownerUserId ||
        "Unknown user",
      blockedUserId,
      blockedDisplayName:
        normalizeControlLinkDisplayName(row?.blocked_control_link_display_name) ||
        String(row?.blocked_global_name || "").trim() ||
        String(row?.blocked_username || "").trim() ||
        blockedUserId ||
        "Unknown user",
      sourceEventId: String(row?.source_event_id || "").trim() || null,
      createdAt,
      createdIso: createdAt ? new Date(createdAt).toISOString() : "",
      createdLabel: formatNotificationTimeLabel(createdAt),
      ownerAdminUrl: ownerUserId
        ? `/admin/users?q=${encodeURIComponent(ownerUserId)}`
        : null,
      blockedAdminUrl: blockedUserId
        ? `/admin/users?q=${encodeURIComponent(blockedUserId)}`
        : null,
    };
  });
}

function listRecentAdminNotificationEvents(limit = 12) {
  const rows = db
    .prepare(
      `
      SELECT
        e.created_at,
        e.actor_user_id,
        e.payload,
        u.username,
        u.global_name
      FROM events e
      LEFT JOIN users u ON u.discord_id = e.actor_user_id
      WHERE e.type='admin_notifications_broadcast'
      ORDER BY e.created_at DESC
      LIMIT ?
    `,
    )
    .all(Math.max(1, Math.min(Number(limit || 0) || 12, 50)));

  return rows.map((row) => {
    const payload = tryJson(row.payload) || {};
    const createdAt = Number(row.created_at || 0);
    return {
      createdAt,
      createdIso: createdAt ? new Date(createdAt).toISOString() : "",
      createdLabel: formatNotificationTimeLabel(createdAt),
      actorUserId: String(row.actor_user_id || "").trim(),
      actorName:
        String(row.global_name || "").trim() ||
        String(row.username || "").trim() ||
        String(row.actor_user_id || "").trim() ||
        "Unknown admin",
      targetCount: Number(payload.targetCount || 0),
      title: String(payload.title || "").trim(),
      message: String(payload.message || "").trim(),
      actionUrl: normalizeNotificationActionUrl(payload.actionUrl),
      actionLabel: normalizeNotificationActionLabel(payload.actionLabel),
    };
  });
}

function getUploadContextUiConfig() {
  return UPLOAD_CONTEXT_UI;
}

function getRecentUploadsByContextForUser(req, userId) {
  const uid = String(userId || "").trim();
  if (!uid) {
    return {
      image_popup: [],
      fullscreen_popup: [],
      set_wallpaper: [],
      set_wallpaper_media: [],
      play_sound: [],
    };
  }

  return {
    image_popup: listRecentUploadedFilesForUser(
      req,
      uid,
      "image_popup",
      UPLOAD_RECENT_LIST_LIMIT,
    ),
    fullscreen_popup: listRecentUploadedFilesForUser(
      req,
      uid,
      "fullscreen_popup",
      UPLOAD_RECENT_LIST_LIMIT,
    ),
    set_wallpaper: listRecentUploadedFilesForUser(
      req,
      uid,
      "set_wallpaper",
      UPLOAD_RECENT_LIST_LIMIT,
    ),
    set_wallpaper_media: listRecentUploadedFilesForUser(
      req,
      uid,
      "set_wallpaper_media",
      UPLOAD_RECENT_LIST_LIMIT,
    ),
    play_sound: listRecentUploadedFilesForUser(
      req,
      uid,
      "play_sound",
      UPLOAD_RECENT_LIST_LIMIT,
    ),
  };
}

function getUploadRuleForFile({ context, filename, mime }) {
  const ctx = String(context || "").trim();
  const originalName = String(filename || "").trim();
  const normalizedMime = String(mime || "")
    .trim()
    .toLowerCase();
  const ext = path.extname(originalName).slice(1).toLowerCase();

  if (!UPLOAD_CONTEXT_UI[ctx]) {
    return { ok: false, message: "Invalid upload context." };
  }

  if (!ext) {
    return { ok: false, message: "File must include a valid extension." };
  }

  if (
    ctx === "set_wallpaper_media" &&
    ext === "ogg" &&
    normalizedMime.startsWith("audio/")
  ) {
    return { ok: false, message: "Only video .ogg files are allowed here." };
  }

  const rule =
    ctx === "set_wallpaper_media" && ext === "ogg"
      ? WALLPAPER_MEDIA_OGG_VIDEO_UPLOAD_RULE
      : UPLOAD_FILE_RULES[ext];
  if (!rule || !rule.contexts.has(ctx)) {
    return { ok: false, message: "That file type is not allowed here." };
  }

  const isGenericMime =
    !normalizedMime ||
    normalizedMime === "application/octet-stream" ||
    normalizedMime === "binary/octet-stream";
  let resolvedMime = normalizedMime || rule.mimeTypes[0];

  if (!isGenericMime) {
    const directMimeMatch = rule.mimeTypes.some(
      (allowed) =>
        normalizedMime === allowed || normalizedMime.startsWith(allowed + ";"),
    );

    const broadMimeMatch =
      (rule.mediaGroup === "audio" && normalizedMime.startsWith("audio/")) ||
      (rule.previewKind === "image" && normalizedMime.startsWith("image/")) ||
      (rule.previewKind === "video" && normalizedMime.startsWith("video/"));

    if (!directMimeMatch && !broadMimeMatch) {
      console.warn("[uploads] accepting file by extension despite mime mismatch", {
        context: ctx,
        filename: originalName,
        ext,
        mime: normalizedMime,
      });
      resolvedMime = rule.mimeTypes[0];
    }
  }

  return {
    ok: true,
    context: ctx,
    ext,
    rule,
    mime: resolvedMime,
  };
}

function getUploadListSqlForContext(context) {
  switch (String(context || "").trim()) {
    case "image_popup":
    case "fullscreen_popup":
      return "media_group='visual'";
    case "set_wallpaper":
      return "wallpaper_compatible=1";
    case "set_wallpaper_media":
      return `(
        (ext IN ('png', 'jpg', 'jpeg', 'webp', 'gif') AND preview_kind='image')
        OR
        (ext IN ('webm', 'ogg', 'ogv') AND preview_kind='video')
      )`;
    case "play_sound":
      return "media_group='audio'";
    default:
      return null;
  }
}

function isManagedPathInDir(filePath, baseDir) {
  const abs = path.resolve(String(filePath || ""));
  const base = path.resolve(baseDir) + path.sep;
  return abs.startsWith(base);
}

function isUploadedFileProtectedRow(row, now = Date.now()) {
  return (
    (!!Number(row?.is_queue_pinned || 0) &&
      !Number(row?.delete_after_queue || 0)) ||
    Number(row?.protected_until || 0) > Number(now || 0)
  );
}

function listManagedUploadUrlsFromCommandPayload(commandPayload) {
  const payload =
    commandPayload && typeof commandPayload === "object" ? commandPayload : null;
  if (!payload) return [];

  const type = String(payload.type || "").trim();
  if (
    type === "open_url" ||
    type === "image_popup" ||
    type === "fullscreen_popup" ||
    type === "set_wallpaper"
  ) {
    return [String(payload.url || "").trim()].filter(Boolean);
  }

  if (
    (type === "play_sound" || type === "play_sound_loop") &&
    String(payload.kind || "builtin").trim() === "url"
  ) {
    return [String(payload.url || "").trim()].filter(Boolean);
  }

  return [];
}

function normalizeManagedUploadRows(rows) {
  const items = Array.isArray(rows) ? rows : [];
  const seen = new Set();
  const out = [];

  for (const row of items) {
    const uploadId = String(row?.id || "").trim();
    if (!uploadId || seen.has(uploadId)) continue;
    seen.add(uploadId);
    out.push(row);
  }

  return out;
}

function resolveManagedUploadRowsForQueuedCommand(req, commandPayload) {
  if (!req) return [];

  const uploadRows = [];
  for (const rawUrl of listManagedUploadUrlsFromCommandPayload(commandPayload)) {
    if (!isManagedUploadUrl(req, rawUrl)) continue;

    const row = findManagedUploadRowByUrl(req, rawUrl);
    if (!row) {
      throw new Error("The uploaded file for this command is no longer available.");
    }

    uploadRows.push(row);
  }

  return normalizeManagedUploadRows(uploadRows);
}

function extendUploadProtectionUntilByIds(uploadIds, holdUntil) {
  const safeHoldUntil = Number(holdUntil || 0);
  if (!Number.isFinite(safeHoldUntil) || safeHoldUntil <= 0) return 0;

  const ids = Array.from(
    new Set(
      (Array.isArray(uploadIds) ? uploadIds : [])
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    ),
  );

  if (!ids.length) return 0;

  for (const uploadId of ids) {
    extendUploadedFileProtectionUntil.run(safeHoldUntil, safeHoldUntil, uploadId);
  }

  return ids.length;
}

function markUploadDeleteAfterQueueByIds(uploadIds) {
  const ids = Array.from(
    new Set(
      (Array.isArray(uploadIds) ? uploadIds : [])
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    ),
  );

  for (const uploadId of ids) {
    markUploadedFileDeleteAfterQueue.run(uploadId);
  }

  return ids.length;
}

function finalizeDeliveredQueuedCommand(queueId, deliveredAt = Date.now()) {
  const id = String(queueId || "").trim();
  if (!id) return { deleted: 0, protectedCount: 0 };

  const tx = db.transaction(() => {
    const uploadRows = db
      .prepare(
        `
        SELECT
          uf.id,
          uf.file_path,
          IFNULL(uf.delete_after_queue, 0) AS delete_after_queue
        FROM queued_command_upload_refs qr
        JOIN uploaded_files uf ON uf.id = qr.upload_id
        WHERE qr.queue_id=?
      `,
      )
      .all(id);

    const uploadIds = uploadRows
      .map((row) => String(row?.id || "").trim())
      .filter(Boolean);
    const deleteAfterQueueIds = uploadRows
      .filter((row) => !!Number(row?.delete_after_queue || 0))
      .map((row) => String(row?.id || "").trim())
      .filter(Boolean);

    const holdUntil = Number(deliveredAt || Date.now()) + QUEUED_UPLOAD_REPORT_GRACE_MS;
    const protectedCount = extendUploadProtectionUntilByIds(
      uploadIds.filter((uploadId) => !deleteAfterQueueIds.includes(uploadId)),
      holdUntil,
    );
    const info = deleteQueuedCommandRow.run(id);
    const uploadDeletes = deleteAfterQueueIds.length
      ? db
          .prepare(
            `
            SELECT id, file_path
            FROM uploaded_files uf
            WHERE uf.id IN (${deleteAfterQueueIds.map(() => "?").join(",")})
              AND NOT EXISTS (
                SELECT 1
                FROM queued_command_upload_refs qr
                WHERE qr.upload_id = uf.id
              )
          `,
          )
          .all(...deleteAfterQueueIds)
      : [];

    if (uploadDeletes.length) {
      deleteUploadedFiles(uploadDeletes, "queued delivery completed");
    }

    return {
      deleted: Math.max(0, Number(info?.changes || 0)),
      protectedCount,
      holdUntil,
      uploadDeletedCount: uploadDeletes.length,
    };
  });

  return tx();
}

function deleteUploadedFiles(rows, reason = "cleanup") {
  const items = Array.isArray(rows) ? rows : [];
  if (!items.length) return 0;

  const tx = db.transaction((list) => {
    for (const row of list) {
      const abs = path.resolve(String(row.file_path || ""));
      if (!isManagedPathInDir(abs, UPLOADS_DIR)) {
        console.warn(
          "[uploads] refusing to unlink outside uploads dir:",
          abs,
        );
      } else {
        safeUnlink(abs, "uploads");
      }

      deleteUploadedFileRow.run(String(row.id));
    }
  });

  try {
    tx(items);
    console.log("[uploads] deleted", items.length, "files for", reason);
    return items.length;
  } catch (e) {
    console.warn("[uploads] delete tx failed:", e?.message || e);
    return 0;
  }
}

function purgeExpiredUploadedFiles(limit = UPLOAD_JANITOR_LIMIT) {
  let rows = [];
  const now = Date.now();
  try {
    rows = db
      .prepare(
        `
      SELECT
        uf.id,
        uf.file_path,
        uf.created_at,
        uf.bytes,
        uf.protected_until,
        IFNULL(uf.delete_after_queue, 0) AS delete_after_queue,
        EXISTS (
          SELECT 1
          FROM queued_command_upload_refs qr
          WHERE qr.upload_id = uf.id
        ) AS is_queue_pinned
      FROM uploaded_files uf
      WHERE uf.expires_at <= ?
        AND IFNULL(uf.protected_until, 0) <= ?
        AND (
          IFNULL(uf.delete_after_queue, 0)=1
          OR NOT EXISTS (
            SELECT 1
            FROM queued_command_upload_refs qr
            WHERE qr.upload_id = uf.id
          )
        )
      ORDER BY created_at ASC, id ASC
      LIMIT ?
    `,
      )
      .all(now, now, limit);
  } catch (e) {
    console.warn("[uploads] janitor query failed:", e?.message || e);
    return 0;
  }

  if (!rows.length) return 0;
  return deleteUploadedFiles(rows, "expired");
}

function drainExpiredUploadedFiles(maxPasses = 25) {
  let total = 0;

  for (let i = 0; i < maxPasses; i++) {
    const deleted = purgeExpiredUploadedFiles(UPLOAD_JANITOR_LIMIT);
    total += deleted;
    if (deleted < UPLOAD_JANITOR_LIMIT) break;
  }

  return total;
}

function ensureUploadCapacityForNewFile({ userId, incomingBytes }) {
  const uid = String(userId || "").trim();
  const size = Number(incomingBytes || 0);

  if (!uid) return { ok: false, status: 400, message: "Missing upload user." };
  if (!Number.isFinite(size) || size <= 0) {
    return { ok: false, status: 400, message: "Invalid upload size." };
  }

  if (size > UPLOADS_MAX_BYTES) {
    return {
      ok: false,
      status: 413,
      message: `File is larger than the total upload storage limit (${formatBytesCompact(UPLOADS_MAX_BYTES)}).`,
    };
  }

  if (size > UPLOADS_PER_USER_MAX_BYTES) {
    return {
      ok: false,
      status: 413,
      message: `File is larger than your personal upload storage limit (${formatBytesCompact(UPLOADS_PER_USER_MAX_BYTES)}).`,
    };
  }

  drainExpiredUploadedFiles();

  const now = Date.now();
  const userRows = db
    .prepare(
      `
      SELECT
        uf.id,
        uf.file_path,
        uf.created_at,
        uf.bytes,
        uf.expires_at,
        uf.protected_until,
        IFNULL(uf.delete_after_queue, 0) AS delete_after_queue,
        EXISTS (
          SELECT 1
          FROM queued_command_upload_refs qr
          WHERE qr.upload_id = uf.id
        ) AS is_queue_pinned
      FROM uploaded_files uf
      WHERE uf.user_id=?
      ORDER BY created_at ASC, id ASC
    `,
    )
    .all(uid);

  const missingUserRows = userRows.filter((row) => {
    const abs = path.resolve(String(row.file_path || ""));
    return !isManagedPathInDir(abs, UPLOADS_DIR) || !fs.existsSync(abs);
  });
  if (missingUserRows.length) {
    deleteUploadedFiles(missingUserRows, "missing");
  }

  const activeUserRows = missingUserRows.length
    ? userRows.filter((row) => !missingUserRows.includes(row))
    : userRows;
  const deletableUserRows = activeUserRows.filter(
    (row) => !isUploadedFileProtectedRow(row, now),
  );
  const queuePinnedUserRows = activeUserRows.filter(
    (row) => !!Number(row.is_queue_pinned || 0),
  );

  let userBytes = 0;
  for (const row of activeUserRows) {
    if (Number(row.is_queue_pinned || 0)) continue;
    userBytes += Number(row.bytes || 0);
  }

  let userCount = activeUserRows.filter(
    (row) => !Number(row.is_queue_pinned || 0),
  ).length;
  const userDeletes = [];

  for (const row of deletableUserRows) {
    const overFileLimit = userCount >= UPLOADS_PER_USER_MAX_FILES;
    const overByteLimit = userBytes + size > UPLOADS_PER_USER_MAX_BYTES;
    if (!overFileLimit && !overByteLimit) break;

    userDeletes.push(row);
    userCount -= 1;
    userBytes -= Number(row.bytes || 0);
  }

  if (userDeletes.length) deleteUploadedFiles(userDeletes, "per-user limits");

  const rawUserBytes = activeUserRows.reduce(
    (sum, row) => sum + Number(row.bytes || 0),
    0,
  );
  const rawUserCount = activeUserRows.length;
  if (
    queuePinnedUserRows.length > 0 &&
    (rawUserBytes + size > UPLOADS_PER_USER_MAX_BYTES ||
      rawUserCount + 1 > UPLOADS_PER_USER_MAX_FILES)
  ) {
    markUploadDeleteAfterQueueByIds(queuePinnedUserRows.map((row) => row.id));
  }

  if (
    userCount >= UPLOADS_PER_USER_MAX_FILES ||
    userBytes + size > UPLOADS_PER_USER_MAX_BYTES
  ) {
    return {
      ok: false,
      status: 507,
      message: "Not enough personal upload storage is available right now.",
    };
  }

  const globalRows = db
    .prepare(
      `
      SELECT
        uf.id,
        uf.file_path,
        uf.created_at,
        uf.bytes,
        uf.expires_at,
        uf.protected_until,
        IFNULL(uf.delete_after_queue, 0) AS delete_after_queue,
        EXISTS (
          SELECT 1
          FROM queued_command_upload_refs qr
          WHERE qr.upload_id = uf.id
        ) AS is_queue_pinned
      FROM uploaded_files uf
      ORDER BY created_at ASC, id ASC
    `,
    )
    .all();

  const missingGlobalRows = globalRows.filter((row) => {
    const abs = path.resolve(String(row.file_path || ""));
    return !isManagedPathInDir(abs, UPLOADS_DIR) || !fs.existsSync(abs);
  });
  if (missingGlobalRows.length) {
    deleteUploadedFiles(missingGlobalRows, "missing");
  }

  const activeGlobalRows = missingGlobalRows.length
    ? globalRows.filter((row) => !missingGlobalRows.includes(row))
    : globalRows;
  const deletableGlobalRows = activeGlobalRows.filter(
    (row) => !isUploadedFileProtectedRow(row, now),
  );

  let totalBytes = 0;
  for (const row of activeGlobalRows) totalBytes += Number(row.bytes || 0);

  const globalDeletes = [];

  for (const row of deletableGlobalRows) {
    if (totalBytes + size <= UPLOADS_MAX_BYTES) break;
    globalDeletes.push(row);
    totalBytes -= Number(row.bytes || 0);
  }

  if (totalBytes + size > UPLOADS_MAX_BYTES) {
    return {
      ok: false,
      status: 507,
      message: "Not enough server upload storage is available right now.",
    };
  }

  if (globalDeletes.length) deleteUploadedFiles(globalDeletes, "global limit");

  return { ok: true };
}

function serializeUploadedFileRow(req, row) {
  const storedName = String(row.stored_name || "").trim();
  return {
    id: String(row.id),
    originalName: String(row.original_name || storedName || "").trim(),
    storedName,
    mime: String(row.mime || "").trim(),
    ext: String(row.ext || "").trim().toLowerCase(),
    bytes: Number(row.bytes || 0),
    previewKind: String(row.preview_kind || "").trim() || "image",
    mediaGroup: String(row.media_group || "").trim() || "visual",
    wallpaperCompatible: !!row.wallpaper_compatible,
    createdAt: Number(row.created_at || 0),
    expiresAt: Number(row.expires_at || 0),
    url: `${getRequestOrigin(req)}/uploads/${encodeURIComponent(storedName)}`,
  };
}

function listRecentUploadedFilesForUser(
  req,
  userId,
  context,
  limit = UPLOAD_RECENT_LIST_LIMIT,
) {
  const whereSql = getUploadListSqlForContext(context);
  if (!whereSql) return [];

  drainExpiredUploadedFiles();

  const rows = db
    .prepare(
      `
      SELECT
        id, original_name, stored_name, file_path, mime, ext, bytes,
        preview_kind, media_group, wallpaper_compatible, created_at, expires_at
      FROM uploaded_files
      WHERE user_id=? AND expires_at > ? AND IFNULL(delete_after_queue, 0)=0 AND ${whereSql}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `,
    )
    .all(
      String(userId),
      Date.now(),
      Math.max(Number(limit || 0), 1) * 3,
    );

  const staleRows = [];
  const items = [];

  for (const row of rows) {
    const abs = path.resolve(String(row.file_path || ""));
    if (!isManagedPathInDir(abs, UPLOADS_DIR) || !fs.existsSync(abs)) {
      staleRows.push(row);
      continue;
    }

    items.push(serializeUploadedFileRow(req, row));
    if (items.length >= limit) break;
  }

  if (staleRows.length) deleteUploadedFiles(staleRows, "missing");

  return items;
}

function listAllUploadedFilesForAdmin(req) {
  drainExpiredUploadedFiles();

  const rows = db
    .prepare(
      `
      SELECT
        uf.id,
        uf.user_id,
        uf.original_name,
        uf.stored_name,
        uf.file_path,
        uf.mime,
        uf.ext,
        uf.bytes,
        uf.preview_kind,
        uf.media_group,
        uf.wallpaper_compatible,
        uf.created_at,
        uf.expires_at,
        u.username,
        u.global_name,
        u.avatar
      FROM uploaded_files uf
      LEFT JOIN users u ON u.discord_id = uf.user_id
      WHERE uf.expires_at > ?
      ORDER BY uf.created_at DESC, uf.id DESC
    `,
    )
    .all(Date.now());

  const staleRows = [];
  const items = [];

  for (const row of rows) {
    const abs = path.resolve(String(row.file_path || ""));
    if (!isManagedPathInDir(abs, UPLOADS_DIR) || !fs.existsSync(abs)) {
      staleRows.push(row);
      continue;
    }

    const item = serializeUploadedFileRow(req, row);
    const uploaderId = String(row.user_id || "").trim();
    const uploader = {
      discordId: uploaderId,
      username: String(row.username || "").trim(),
      globalName: String(row.global_name || "").trim(),
      avatarUrl: siteAvatarUrl({ discord_id: uploaderId }, 64),
    };

    items.push({
      ...item,
      sizeLabel: formatBytesCompact(item.bytes),
      uploader,
      uploaderDisplayName:
        uploader.globalName || uploader.username || uploader.discordId || "(unknown user)",
    });
  }

  if (staleRows.length) deleteUploadedFiles(staleRows, "missing");

  return items;
}

function getReportMediaBackupCommandKey(commandType) {
  const normalized = String(commandType || "").trim().toLowerCase();

  if (
    normalized === "command_image" ||
    normalized === "group_command_image_popup" ||
    normalized === "image_popup"
  ) {
    return "image_popup";
  }

  if (
    normalized === "command_fullscreen_popup" ||
    normalized === "group_command_fullscreen_popup" ||
    normalized === "fullscreen_popup"
  ) {
    return "fullscreen_popup";
  }

  if (
    normalized === "command_set_wallpaper" ||
    normalized === "group_command_set_wallpaper" ||
    normalized === "set_wallpaper"
  ) {
    return "set_wallpaper";
  }

  if (
    normalized === "command_play_sound" ||
    normalized === "command_play_sound_loop" ||
    normalized === "group_command_play_sound" ||
    normalized === "play_sound" ||
    normalized === "play_sound_loop"
  ) {
    return "play_sound";
  }

  return null;
}

function getReportMediaBackupContexts(commandType) {
  const commandKey = getReportMediaBackupCommandKey(commandType);
  if (commandKey === "image_popup") return ["image_popup"];
  if (commandKey === "fullscreen_popup") return ["image_popup"];
  if (commandKey === "set_wallpaper") {
    return ["set_wallpaper", "set_wallpaper_media"];
  }
  if (commandKey === "play_sound") return ["play_sound"];
  return [];
}

function normalizeStoredMime(value, fallback = "application/octet-stream") {
  const mime = String(value || "")
    .trim()
    .toLowerCase()
    .split(";")[0]
    .trim();
  return mime || fallback;
}

function sanitizeReportMediaBackupName(name, fallbackBase = "reported-media") {
  const base = path
    .basename(
      String(name || "")
        .split("#")[0]
        .split("?")[0],
    )
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
  return base || fallbackBase;
}

function buildReportMediaBackupOriginalName({
  preferredName = "",
  rawUrl = "",
  ext = "",
  fallbackBase = "reported-media",
}) {
  const normalizedExt = String(ext || "").trim().toLowerCase();
  const candidates = [
    sanitizeReportMediaBackupName(preferredName, ""),
    (() => {
      try {
        const parsed = new URL(String(rawUrl || ""));
        return sanitizeReportMediaBackupName(parsed.pathname, "");
      } catch {
        return "";
      }
    })(),
  ].filter(Boolean);

  const fallback = sanitizeReportMediaBackupName(fallbackBase, "reported-media");
  const candidate = candidates[0] || fallback;
  const candidateExt = path.extname(candidate).slice(1).toLowerCase();
  const baseName = candidateExt
    ? candidate.slice(0, -(candidateExt.length + 1))
    : candidate;

  if (normalizedExt && candidateExt === normalizedExt) {
    return candidate;
  }

  return normalizedExt
    ? `${baseName || fallback}.${normalizedExt}`
    : candidate;
}

function resolveReportMediaBackupCaptureSpec({
  commandType,
  sourceUrl,
  sourceName = "",
  sourceMime = "",
}) {
  const commandKey = getReportMediaBackupCommandKey(commandType);
  if (!commandKey || !isHttpUrl(sourceUrl)) return null;

  const contexts = getReportMediaBackupContexts(commandType);
  if (!contexts.length) return null;

  const normalizedMime = normalizeStoredMime(sourceMime, "");
  const candidateExts = [];
  const seenExts = new Set();
  const pushExt = (value) => {
    const ext = String(value || "").trim().toLowerCase();
    if (!ext || seenExts.has(ext)) return;
    seenExts.add(ext);
    candidateExts.push(ext);
  };

  pushExt(path.extname(String(sourceName || "")).slice(1));
  pushExt(getUrlFileExtension(sourceUrl));

  if (normalizedMime) {
    for (const [ext, rule] of Object.entries(UPLOAD_FILE_RULES)) {
      const allowedInContext = contexts.some((context) => rule.contexts.has(context));
      if (!allowedInContext) continue;

      const directMimeMatch = rule.mimeTypes.some(
        (allowed) =>
          normalizedMime === allowed ||
          normalizedMime.startsWith(allowed + ";"),
      );
      const broadMimeMatch =
        (rule.mediaGroup === "audio" && normalizedMime.startsWith("audio/")) ||
        (rule.previewKind === "image" && normalizedMime.startsWith("image/")) ||
        (rule.previewKind === "video" && normalizedMime.startsWith("video/"));

      if (directMimeMatch || broadMimeMatch) {
        pushExt(ext);
      }
    }

    if (
      commandKey === "set_wallpaper" &&
      (normalizedMime === "video/ogg" ||
        normalizedMime === "video/ogv" ||
        normalizedMime.startsWith("video/webm"))
    ) {
      pushExt("ogv");
      pushExt("webm");
    }
  }

  for (const ext of candidateExts) {
    for (const context of contexts) {
      const originalName = buildReportMediaBackupOriginalName({
        preferredName: sourceName,
        rawUrl: sourceUrl,
        ext,
        fallbackBase: commandKey,
      });
      const matched = getUploadRuleForFile({
        context,
        filename: originalName,
        mime: normalizedMime,
      });
      if (matched.ok) {
        return {
          commandKey,
          context,
          ext: matched.ext,
          mime: normalizeStoredMime(matched.mime, matched.rule.mimeTypes[0]),
          rule: matched.rule,
          originalName,
        };
      }
    }
  }

  return null;
}

function findManagedUploadRowByUrl(req, rawUrl) {
  if (!isManagedUploadUrl(req, rawUrl)) return null;

  let storedName = "";
  try {
    const parsed = new URL(String(rawUrl || ""));
    storedName = decodeURIComponent(path.basename(String(parsed.pathname || "")));
  } catch {
    return null;
  }

  if (!storedName) return null;

  const row = db
    .prepare(
      `
      SELECT
        id,
        original_name,
        stored_name,
        file_path,
        mime,
        ext,
        bytes,
        created_at
      FROM uploaded_files
      WHERE stored_name=?
      LIMIT 1
    `,
    )
    .get(storedName);

  if (!row) return null;

  const abs = path.resolve(String(row.file_path || ""));
  if (!isManagedPathInDir(abs, UPLOADS_DIR) || !fs.existsSync(abs)) {
    return null;
  }

  return row;
}

async function readResponseBodyWithLimit(response, maxBytes) {
  const limit = Math.max(1, Number(maxBytes || 0) || UPLOAD_ANIMATED_MAX_BYTES);
  const contentLength = Number(response.headers.get("content-length") || "0");
  if (contentLength && contentLength > limit) {
    throw new Error("That file is too large to preserve with the report.");
  }

  if (!response.body) return Buffer.alloc(0);

  const stream =
    typeof Readable.fromWeb === "function" &&
    response.body &&
    typeof response.body.getReader === "function"
      ? Readable.fromWeb(response.body)
      : response.body;

  const chunks = [];
  let total = 0;

  for await (const chunk of stream) {
    const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bufferChunk.length;
    if (total > limit) {
      throw new Error("That file is too large to preserve with the report.");
    }
    chunks.push(bufferChunk);
  }

  return Buffer.concat(chunks, total);
}

function createReportMediaBackupRecord({
  reportId,
  backupKind,
  sourceUrl,
  originalName,
  mime,
  ext,
  buffer,
}) {
  const existing = db
    .prepare(
      `
      SELECT id, report_id, backup_kind, source_url, original_name, stored_name,
             file_path, mime, ext, bytes, created_at
      FROM report_media_backups
      WHERE report_id=?
      LIMIT 1
    `,
    )
    .get(String(reportId || "").trim());
  if (existing) return existing;

  const safeReportId = String(reportId || "").trim();
  const safeKind = String(backupKind || "").trim() || "media";
  const safeExt = String(ext || "").trim().toLowerCase();
  const safeOriginalName = buildReportMediaBackupOriginalName({
    preferredName: originalName,
    rawUrl: sourceUrl,
    ext: safeExt,
    fallbackBase: safeKind,
  });
  const safeMime = normalizeStoredMime(mime);
  const bytes = Buffer.isBuffer(buffer) ? buffer.length : 0;

  if (!safeReportId || !bytes || !safeExt) {
    throw new Error("Invalid report media backup.");
  }

  const id = crypto.randomUUID();
  const createdAt = Date.now();
  const storedName = `report_${createdAt}_${id}.${safeExt}`;
  const filePath = path.join(REPORT_MEDIA_BACKUPS_DIR, storedName);

  fs.writeFileSync(filePath, buffer);

  try {
    db.prepare(
      `
      INSERT INTO report_media_backups (
        id,
        report_id,
        backup_kind,
        source_url,
        original_name,
        stored_name,
        file_path,
        mime,
        ext,
        bytes,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      id,
      safeReportId,
      safeKind,
      String(sourceUrl || "").trim() || null,
      safeOriginalName,
      storedName,
      filePath,
      safeMime,
      safeExt,
      bytes,
      createdAt,
    );
  } catch (err) {
    safeUnlink(filePath, "report-media-backups");
    throw err;
  }

  return {
    id,
    report_id: safeReportId,
    backup_kind: safeKind,
    source_url: String(sourceUrl || "").trim() || null,
    original_name: safeOriginalName,
    stored_name: storedName,
    file_path: filePath,
    mime: safeMime,
    ext: safeExt,
    bytes,
    created_at: createdAt,
  };
}

async function captureReportMediaBackupFromCommand({
  report,
  commandType,
  sourceUrl,
  sourceName = "",
  sourceMime = "",
  req = null,
}) {
  const reportId = String(report?.id || "").trim();
  const safeUrl = String(sourceUrl || "").trim();
  const commandKey = getReportMediaBackupCommandKey(commandType);
  if (!reportId || !commandKey || !isHttpUrl(safeUrl)) return null;

  const managedUploadRow = req ? findManagedUploadRowByUrl(req, safeUrl) : null;
  let captureSpec = resolveReportMediaBackupCaptureSpec({
    commandType,
    sourceUrl: safeUrl,
    sourceName:
      sourceName ||
      managedUploadRow?.original_name ||
      managedUploadRow?.stored_name ||
      "",
    sourceMime: sourceMime || managedUploadRow?.mime || "",
  });
  if (!captureSpec) return null;

  let buffer = null;
  let finalMime =
    sourceMime ||
    managedUploadRow?.mime ||
    captureSpec.mime ||
    captureSpec.rule.mimeTypes[0];

  if (managedUploadRow) {
    const abs = path.resolve(String(managedUploadRow.file_path || ""));
    if (!isManagedPathInDir(abs, UPLOADS_DIR) || !fs.existsSync(abs)) {
      throw new Error("The uploaded file for this command is no longer available.");
    }

    const size = Number(managedUploadRow.bytes || 0);
    if (size && size > Number(captureSpec.rule.maxBytes || 0)) {
      throw new Error("That file is too large to preserve with the report.");
    }

    buffer = fs.readFileSync(abs);
    if (buffer.length > Number(captureSpec.rule.maxBytes || 0)) {
      throw new Error("That file is too large to preserve with the report.");
    }
  } else {
    const response = await fetch(safeUrl, {
      method: "GET",
      redirect: "follow",
    });
    if (!response.ok) {
      throw new Error(`Could not fetch report media backup (HTTP ${response.status}).`);
    }

    const responseMime = normalizeStoredMime(
      response.headers.get("content-type") || sourceMime || captureSpec.mime,
      captureSpec.mime,
    );
    const responseSpec = resolveReportMediaBackupCaptureSpec({
      commandType,
      sourceUrl: safeUrl,
      sourceName,
      sourceMime: responseMime,
    });
    if (responseSpec) {
      captureSpec = responseSpec;
    }

    buffer = await readResponseBodyWithLimit(
      response,
      captureSpec.rule.maxBytes,
    );
    finalMime = responseMime || finalMime;
  }

  if (!buffer || !buffer.length) {
    throw new Error("Could not read the media file for this report.");
  }

  const backup = createReportMediaBackupRecord({
    reportId,
    backupKind: commandKey,
    sourceUrl: safeUrl,
    originalName: captureSpec.originalName,
    mime: finalMime,
    ext: captureSpec.ext,
    buffer,
  });

  logEvent({
    type: "report_media_backup_created",
    actorUserId: String(report?.reporterUserId || "").trim() || null,
    targetUserId: String(report?.subjectId || "").trim() || null,
    req,
    payload: {
      reportId,
      backupId: backup.id,
      backupKind: commandKey,
      bytes: Number(backup.bytes || 0),
    },
  });

  return backup;
}

function deleteReportMediaBackups(rows, reason = "cleanup") {
  const items = Array.isArray(rows) ? rows : [];
  if (!items.length) return 0;

  const tx = db.transaction((list) => {
    for (const row of list) {
      const abs = path.resolve(String(row.file_path || ""));
      if (!isManagedPathInDir(abs, REPORT_MEDIA_BACKUPS_DIR)) {
        console.warn(
          "[report-backups] refusing to unlink outside backups dir:",
          abs,
        );
      } else {
        safeUnlink(abs, "report-media-backups");
      }

      deleteReportMediaBackupRow.run(String(row.id || ""));
    }
  });

  try {
    tx(items);
    console.log("[report-backups] deleted", items.length, "files for", reason);
    return items.length;
  } catch (e) {
    console.warn("[report-backups] delete tx failed:", e?.message || e);
    return 0;
  }
}

function appendCacheBust(url, version) {
  const base = String(url || "").trim();
  if (!base) return "";
  const v = Number(version || 0);
  if (!v) return base;
  return `${base}${base.includes("?") ? "&" : "?"}v=${encodeURIComponent(String(v))}`;
}

function buildControlLinkAssetAdminUrl(discordId, kind, updatedAt) {
  const user = { discord_id: discordId };
  switch (kind) {
    case "avatar":
      return appendCacheBust(siteAvatarUrl(user, 256), updatedAt);
    case "banner":
      return appendCacheBust(siteBannerUrl(user, 1600), updatedAt);
    case "background":
      return appendCacheBust(siteBackgroundUrl(user, 1920), updatedAt);
    default:
      return "";
  }
}

function listControlLinkAssetsForAdmin() {
  const rows = db
    .prepare(
      `
      SELECT
        discord_id,
        username,
        global_name,
        avatar,
        control_link_display_name,
        custom_avatar_path,
        custom_avatar_mime,
        custom_avatar_updated_at,
        custom_banner_path,
        custom_banner_mime,
        custom_banner_updated_at,
        custom_background_path,
        custom_background_mime,
        custom_background_updated_at
      FROM users
      WHERE
        TRIM(IFNULL(custom_avatar_path, '')) <> ''
        OR TRIM(IFNULL(custom_banner_path, '')) <> ''
        OR TRIM(IFNULL(custom_background_path, '')) <> ''
    `,
    )
    .all();

  const cards = [];
  let totalBytes = 0;
  let totalAssets = 0;

  const assetConfigs = [
    {
      kind: "avatar",
      label: "Profile Picture",
      pathField: "custom_avatar_path",
      mimeField: "custom_avatar_mime",
      updatedField: "custom_avatar_updated_at",
    },
    {
      kind: "banner",
      label: "Banner",
      pathField: "custom_banner_path",
      mimeField: "custom_banner_mime",
      updatedField: "custom_banner_updated_at",
    },
    {
      kind: "background",
      label: "Background",
      pathField: "custom_background_path",
      mimeField: "custom_background_mime",
      updatedField: "custom_background_updated_at",
    },
  ];

  for (const row of rows) {
    const discordId = String(row.discord_id || "").trim();
    if (!discordId) continue;

    const assets = [];
    let latestUpdatedAt = 0;

    for (const config of assetConfigs) {
      const storedPath = String(row[config.pathField] || "").trim();
      if (!storedPath) continue;

      const abs = resolveStoredSiteAvatarPath(storedPath);
      if (!abs || !isManagedPathInDir(abs, SITE_AVATARS_DIR) || !fs.existsSync(abs)) {
        continue;
      }

      let bytes = 0;
      try {
        bytes = Number(fs.statSync(abs).size || 0);
      } catch {}

      const updatedAt = Number(row[config.updatedField] || 0);
      latestUpdatedAt = Math.max(latestUpdatedAt, updatedAt);
      totalBytes += bytes;
      totalAssets += 1;

      assets.push({
        kind: config.kind,
        label: config.label,
        url: buildControlLinkAssetAdminUrl(discordId, config.kind, updatedAt),
        bytes,
        sizeLabel: formatBytesCompact(bytes),
        updatedAt,
        updatedAtLabel: updatedAt
          ? new Date(updatedAt).toLocaleString()
          : "Unknown",
        mime:
          String(row[config.mimeField] || "").trim() ||
          siteAvatarMimeFromPath(abs),
      });
    }

    if (!assets.length) continue;

    cards.push({
      user: {
        discordId,
        username: String(row.username || "").trim(),
        globalName: String(row.global_name || "").trim(),
        displayName: getPreferredDisplayName(row) || discordId,
        avatarUrl: siteAvatarUrl({ discord_id: discordId }, 64),
      },
      latestUpdatedAt,
      assets,
    });
  }

  cards.sort((a, b) => {
    if (b.latestUpdatedAt !== a.latestUpdatedAt) {
      return b.latestUpdatedAt - a.latestUpdatedAt;
    }
    return String(a.user.displayName || "").localeCompare(
      String(b.user.displayName || ""),
    );
  });

  return {
    cards,
    stats: {
      userCount: cards.length,
      assetCount: totalAssets,
      totalBytes,
      totalBytesLabel: formatBytesCompact(totalBytes),
    },
  };
}

function runUploadsJanitorOnce() {
  const deleted = purgeExpiredUploadedFiles(UPLOAD_JANITOR_LIMIT);
  if (deleted > 0) {
    console.log("[uploads] janitor deleted", deleted, "expired uploads");
  }
}

function isManagedUploadUrl(req, rawUrl) {
  const input = String(rawUrl || "").trim();
  if (!input) return false;

  try {
    const url = new URL(input);
    const proto = String(url.protocol || "").toLowerCase();
    if (proto !== "http:" && proto !== "https:") return false;

    const requestHost = normalizeHost(req.get("host"));
    if (!requestHost) return false;

    return (
      normalizeHost(url.host) === requestHost &&
      String(url.pathname || "").startsWith("/uploads/")
    );
  } catch {
    return false;
  }
}

function enforceManagedUrlPolicy({ db, logEvent }, req, res, rawUrl) {
  if (isManagedUploadUrl(req, rawUrl)) {
    return { ok: true, status: "managed_upload" };
  }

  return enforceUrlPolicy({ db, logEvent }, req, res, rawUrl);
}

function getActorId(req) {
  const u = req.actorUser || req.user || req.session?.user || null;

  const discordId =
    u?.discord_id || u?.discordId || u?.id || null;

  if (discordId) return String(discordId);

  if (req.apiUser?.discord_id) return String(req.apiUser.discord_id);

  return `ip:${req.ip}`;
}

function getRequestActorUserId(req) {
  return String(
    req.actorUser?.discord_id ||
      req.apiUser?.discord_id ||
      req.user?.discord_id ||
      req.viewUser?.discord_id ||
      "",
  ).trim();
}

function requestHasDelegatedControlForOwner(req, ownerUserId) {
  const actorId = getRequestActorUserId(req);
  const effectiveId = String(req.user?.discord_id || req.viewUser?.discord_id || "").trim();
  const ownerId = String(ownerUserId || "").trim();
  if (!actorId || !effectiveId || !ownerId) return false;
  if (actorId === ownerId) return false;
  if (effectiveId !== ownerId) return false;

  const row = db
    .prepare(
      `
      SELECT 1
      FROM leash_delegations
      WHERE sub_user_id=? AND dom_user_id=?
      LIMIT 1
    `,
    )
    .get(ownerId, actorId);
  return !!row;
}

const getHeavyRow = db.prepare(
  `SELECT last_ms FROM heavy_cooldowns WHERE actor_id=?`
);
const upsertHeavyRow = db.prepare(`
  INSERT INTO heavy_cooldowns (actor_id, last_ms)
  VALUES (?, ?)
  ON CONFLICT(actor_id) DO UPDATE SET last_ms=excluded.last_ms
`);

const enforceHeavyCooldown = db.transaction((actorId, now) => {
  const row = getHeavyRow.get(actorId);
  const last = row?.last_ms ?? 0;
  const elapsed = now - last;

  if (elapsed < HEAVY_COOLDOWN_MS) {
    return { ok: false, retryAfterMs: HEAVY_COOLDOWN_MS - elapsed };
  }

  upsertHeavyRow.run(actorId, now);
  return { ok: true, retryAfterMs: 0 };
});

function heavyCooldown(req, res, next) {
  const actorId = getActorId(req);
  const now = Date.now();

  let result;
  try {
    result = enforceHeavyCooldown(actorId, now);
  } catch (e) {
    return res.status(500).json({ ok: false, code: "cooldown_error" });
  }

  if (!result.ok) {
    res.set("Retry-After", String(Math.ceil(result.retryAfterMs / 1000)));
    return res.status(429).json({
      ok: false,
      code: "heavy_cooldown",
      message: "Please wait before sending another heavy command.",
      retryAfterMs: result.retryAfterMs,
    });
  }

  next();
}

function getBoardMessages(ownerUserId, limit = 10) {
  return db
    .prepare(
      `
    SELECT id, body, created_at
    FROM device_message_board
    WHERE owner_user_id=?
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `,
    )
    .all(ownerUserId, limit);
}

function getClientBoardMessages(ownerUserId, limit = 100) {
  const safeLimit = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 100));
  const owner =
    db
      .prepare(
        `
        SELECT discord_id, username, global_name, control_link_display_name
        FROM users
        WHERE discord_id=?
      `,
      )
      .get(ownerUserId) || { discord_id: ownerUserId };
  const authorName = getPreferredDisplayName(owner) || "Unknown user";

  return getBoardMessages(ownerUserId, safeLimit)
    .slice()
    .reverse()
    .map((row) => ({
      id: String(row.id),
      message: String(row.body || ""),
      authorName,
      createdAt: Number(row.created_at || 0),
    }));
}

const CONTROL_LINK_COMMAND_HISTORY_TYPES = Object.freeze({
  command_message: "Send Message",
  command_subliminal_message: "Send Subliminal Message",
  command_url: "Open URL",
  command_image: "Send Image Popup",
  command_fullscreen_popup: "Send Fullscreen Popup",
  command_spiral_overlay: "Spiral Overlay",
  command_set_wallpaper: "Set Wallpaper",
  command_screenshot: "Take Screenshot",
  command_webcam_capture: "Webcam Capture",
  command_play_sound: "Play Sound Effect",
  command_play_sound_loop: "Play Sound Loop",
  command_write_for_me: "Write For Me",
});
const CONTROL_LINK_HISTORY_EVENT_TYPE_BY_COMMAND_TYPE = Object.freeze({
  popup: "command_message",
  subliminal_message: "command_subliminal_message",
  open_url: "command_url",
  image_popup: "command_image",
  fullscreen_popup: "command_fullscreen_popup",
  spiral_overlay: "command_spiral_overlay",
  set_wallpaper: "command_set_wallpaper",
  screenshot: "command_screenshot",
  webcam_capture: "command_webcam_capture",
  play_sound: "command_play_sound",
  play_sound_loop: "command_play_sound_loop",
  write_for_me: "command_write_for_me",
});
const CONTROL_LINK_COMMAND_HISTORY_TYPE_KEYS = Object.keys(
  CONTROL_LINK_COMMAND_HISTORY_TYPES,
);

function normalizeSubliminalMessagesPayload(rawValue) {
  const rawList = Array.isArray(rawValue)
    ? rawValue
    : rawValue == null
      ? []
      : [rawValue];
  return rawList
    .map((item) => String(item ?? "").trim())
    .filter(Boolean);
}

function buildDeliveredCommandHistory({
  commandPayload,
  commandId = null,
  sourceKind = null,
  sourceId = null,
} = {}) {
  const payload = commandPayload && typeof commandPayload === "object"
    ? commandPayload
    : null;
  const commandType = String(payload?.type || "").trim();
  const eventType = CONTROL_LINK_HISTORY_EVENT_TYPE_BY_COMMAND_TYPE[commandType];
  if (!eventType) return null;

  const historyPayload = {};
  const safeCommandId = String(commandId || "").trim();
  if (safeCommandId) historyPayload.commandId = safeCommandId;

  if (commandType === "popup" || commandType === "write_for_me") {
    const message = String(payload?.message || "").trim();
    if (message) historyPayload.message = message;
  }

  if (
    commandType === "subliminal_message"
  ) {
    const messages = normalizeSubliminalMessagesPayload(payload?.messages);
    if (messages.length) {
      historyPayload.messages = messages;
    }
  }

  if (
    commandType === "open_url" ||
    commandType === "image_popup" ||
    commandType === "fullscreen_popup" ||
    commandType === "spiral_overlay" ||
    commandType === "set_wallpaper"
  ) {
    const url = String(payload?.url || "").trim();
    const originalUrl = String(payload?.originalUrl || "").trim();
    const resolvedUrl = String(payload?.resolvedUrl || "").trim();
    const mediaUrlResolvedBy = String(payload?.mediaUrlResolvedBy || "").trim();
    const resolvedUrlHost = String(payload?.resolvedUrlHost || "").trim();

    if (originalUrl) {
      historyPayload.url = originalUrl;
    } else if (url) {
      historyPayload.url = url;
    }
    if (resolvedUrl && resolvedUrl !== historyPayload.url) {
      historyPayload.resolvedUrl = resolvedUrl;
    }
    if (mediaUrlResolvedBy) {
      historyPayload.mediaUrlResolvedBy = mediaUrlResolvedBy;
    }
    if (resolvedUrlHost) {
      historyPayload.resolvedUrlHost = resolvedUrlHost;
    }
  }

  if (commandType === "play_sound") {
    const kind = String(payload?.kind || "").trim();
    const name = String(payload?.name || "").trim();
    const url = String(payload?.url || "").trim();
    if (kind) historyPayload.kind = kind;
    if (name) historyPayload.name = name;
    if (url) historyPayload.url = url;
  }

  if (commandType === "play_sound_loop") {
    const kind = String(payload?.kind || "").trim();
    const name = String(payload?.name || "").trim();
    const url = String(payload?.url || "").trim();
    const baseHz = Number(payload?.baseHz);
    const beatHz = Number(payload?.beatHz);
    if (kind) historyPayload.kind = kind;
    if (name) historyPayload.name = name;
    if (url) historyPayload.url = url;
    if (kind === "tone" && Number.isFinite(baseHz)) historyPayload.baseHz = baseHz;
    if (kind === "tone" && Number.isFinite(beatHz)) historyPayload.beatHz = beatHz;
  }

  if (commandType === "write_for_me") {
    const times = Number(payload?.times || 0);
    if (Number.isFinite(times) && times > 0) {
      historyPayload.times = times;
    }
  }

  const safeSourceKind = String(sourceKind || "").trim();
  const safeSourceId = String(sourceId || "").trim();
  if (safeSourceKind === "group") {
    historyPayload.sourceKind = "group";
    if (safeSourceId) {
      historyPayload.groupKey = safeSourceId;
      const groupLabel = String(
        loadGroupsCatalog().get(safeSourceId)?.label || "",
      ).trim();
      if (groupLabel) {
        historyPayload.groupLabel = groupLabel;
      }
    }
  }

  return {
    type: eventType,
    payload: historyPayload,
  };
}

function buildDeliveredDirectCommandHistory({
  commandPayload,
  commandId = null,
} = {}) {
  return buildDeliveredCommandHistory({
    commandPayload,
    commandId,
  });
}

function logDeliveredDirectCommandHistory({
  actorUserId = null,
  targetUserId = null,
  pairCode = null,
  commandPayload,
  commandId = null,
  req = null,
} = {}) {
  const event = buildDeliveredDirectCommandHistory({
    commandPayload,
    commandId,
  });
  if (!event) return false;

  logEvent({
    type: event.type,
    actorUserId,
    targetUserId,
    pairCode,
    req,
    payload: event.payload,
  });
  return true;
}

function logDeliveredGroupCommandHistory({
  actorUserId = null,
  targetUserId = null,
  groupKey = null,
  commandPayload,
  commandId = null,
  req = null,
} = {}) {
  const event = buildDeliveredCommandHistory({
    commandPayload,
    commandId,
    sourceKind: "group",
    sourceId: groupKey,
  });
  if (!event) return false;

  logEvent({
    type: event.type,
    actorUserId,
    targetUserId,
    req,
    payload: event.payload,
  });
  return true;
}

function getRecentReceivedCommandHistory(ownerUserId, limit = 15) {
  const uid = String(ownerUserId || "").trim();
  const max = Math.max(1, Math.min(Number(limit || 0) || 15, 15));
  if (!uid) return [];

  const rows = db
    .prepare(
      `
      SELECT id, created_at, type, actor_user_id, payload
      FROM events
      WHERE target_user_id=?
        AND type IN (${CONTROL_LINK_COMMAND_HISTORY_TYPE_KEYS.map(() => "?").join(",")})
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `,
    )
    .all(uid, ...CONTROL_LINK_COMMAND_HISTORY_TYPE_KEYS, max);
  const eventIds = rows
    .map((row) => String(row?.id || "").trim())
    .filter(Boolean);
  const likedEventIds = new Set();
  if (eventIds.length) {
    const placeholders = eventIds.map(() => "?").join(",");
    const likeRows = db
      .prepare(
        `
        SELECT event_id
        FROM command_history_likes
        WHERE liker_user_id=?
          AND event_id IN (${placeholders})
      `,
      )
      .all(uid, ...eventIds);
    for (const likeRow of likeRows) {
      likedEventIds.add(String(likeRow?.event_id || "").trim());
    }
  }

  return rows.map((row) => {
    const payload = tryJson(row.payload) || {};
    const messages = normalizeSubliminalMessagesPayload(payload?.messages);
    const message =
      messages.length === 1
        ? messages[0]
        : String(payload?.message || "").trim();
    const url = String(payload?.url || "").trim();
    const commandId = String(payload?.commandId || "").trim();
    const sourceKind = String(payload?.sourceKind || "").trim();
    const groupKey = String(payload?.groupKey || "").trim();
    const storedGroupLabel = String(payload?.groupLabel || "").trim();
    const groupLabel = groupKey
      ? storedGroupLabel ||
        String(getResolvedGroupCatalogEntry(groupKey)?.label || "").trim()
      : "";
    const createdAt = Number(row?.created_at || 0);
    const actorUserId = String(row?.actor_user_id || "").trim();
    const eventId = String(row?.id || "").trim();

    return {
      id: eventId,
      type: String(row?.type || "").trim(),
      typeLabel:
        CONTROL_LINK_COMMAND_HISTORY_TYPES[String(row?.type || "").trim()] ||
        "Command",
      commandId: commandId || null,
      sourceKind: sourceKind || (groupKey ? "group" : null),
      groupKey: groupKey || null,
      groupLabel: groupLabel || null,
      message: message || null,
      messages,
      url: url || null,
      liked: likedEventIds.has(eventId),
      canLike: !!actorUserId && actorUserId !== uid,
      createdAt,
      createdIso: createdAt ? new Date(createdAt).toISOString() : "",
    };
  });
}

function findReceivedCommandHistoryEvent(ownerUserId, eventId) {
  const ownerId = String(ownerUserId || "").trim();
  const id = String(eventId || "").trim();
  if (!ownerId || !id) return null;

  const row = db
    .prepare(
      `
      SELECT
        e.id,
        e.type,
        e.created_at,
        e.actor_user_id,
        e.target_user_id,
        e.pair_code,
        e.payload,
        actor.username AS actor_username,
        actor.global_name AS actor_global_name,
        actor.control_link_display_name AS actor_control_link_display_name,
        pc.code_plain AS actor_pair_code
      FROM events e
      LEFT JOIN users actor ON actor.discord_id = e.actor_user_id
      LEFT JOIN pair_codes pc ON pc.user_id = e.actor_user_id
      WHERE e.id=?
        AND e.target_user_id=?
        AND e.type IN (${CONTROL_LINK_COMMAND_HISTORY_TYPE_KEYS.map(() => "?").join(",")})
      LIMIT 1
    `,
    )
    .get(id, ownerId, ...CONTROL_LINK_COMMAND_HISTORY_TYPE_KEYS);

  if (!row) return null;

  return {
    ...row,
    payloadObj: tryJson(row.payload) || {},
  };
}

function isCommandSenderBlockedByOwner(ownerUserId, actorUserId) {
  const ownerId = String(ownerUserId || "").trim();
  const actorId = String(actorUserId || "").trim();
  if (!ownerId || !actorId || ownerId === actorId) return false;

  const row = db
    .prepare(
      `
      SELECT 1
      FROM command_sender_blocks
      WHERE owner_user_id=? AND blocked_user_id=?
    `,
    )
    .get(ownerId, actorId);

  return !!row;
}

function createCommandSenderBlock({
  ownerUserId,
  blockedUserId,
  sourceEventId = null,
  req = null,
}) {
  const ownerId = String(ownerUserId || "").trim();
  const blockedId = String(blockedUserId || "").trim();
  const safeSourceEventId = String(sourceEventId || "").trim() || null;
  if (!ownerId || !blockedId || ownerId === blockedId) {
    throw new Error("That sender cannot be blocked.");
  }

  const now = Date.now();
  db.prepare(
    `
      INSERT OR IGNORE INTO command_sender_blocks (
        owner_user_id,
        blocked_user_id,
        source_event_id,
        created_at
      ) VALUES (?, ?, ?, ?)
    `,
  ).run(ownerId, blockedId, safeSourceEventId, now);

  logEvent({
    type: "command_sender_blocked",
    actorUserId: ownerId,
    targetUserId: blockedId,
    req,
    payload: {
      sourceEventId: safeSourceEventId,
    },
  });

  return {
    ownerUserId: ownerId,
    blockedUserId: blockedId,
    sourceEventId: safeSourceEventId,
    createdAt: now,
  };
}

const insertCommandHistoryLikeStmt = db.prepare(`
  INSERT OR IGNORE INTO command_history_likes (
    event_id,
    liked_user_id,
    liker_user_id,
    source_kind,
    source_id,
    created_at
  ) VALUES (?, ?, ?, ?, ?, ?)
`);
const incrementCommandLikesTotalStmt = db.prepare(`
  UPDATE users
  SET command_likes_total = IFNULL(command_likes_total, 0) + 1
  WHERE discord_id=?
`);
const selectCommandLikesTotalStmt = db.prepare(`
  SELECT IFNULL(command_likes_total, 0) AS n
  FROM users
  WHERE discord_id=?
`);

const recordCommandHistoryLikeTx = db.transaction((row) => {
  const info = insertCommandHistoryLikeStmt.run(
    row.eventId,
    row.likedUserId,
    row.likerUserId,
    row.sourceKind,
    row.sourceId,
    row.createdAt,
  );
  const inserted = Number(info?.changes || 0) > 0;
  if (inserted) {
    incrementCommandLikesTotalStmt.run(row.likedUserId);
  }
  const totalRow = selectCommandLikesTotalStmt.get(row.likedUserId);
  return {
    inserted,
    likesTotal: Number(totalRow?.n || 0),
  };
});

function getUserSummaryForCommandLike(userId) {
  const safeUserId = String(userId || "").trim();
  if (!safeUserId) return null;

  return db
    .prepare(
      `
      SELECT discord_id, username, global_name, control_link_display_name
      FROM users
      WHERE discord_id=?
      LIMIT 1
    `,
    )
    .get(safeUserId) || { discord_id: safeUserId };
}

function createCommandHistoryLike({
  historyEvent,
  likerUserId,
  req = null,
} = {}) {
  const eventId = String(historyEvent?.id || "").trim();
  const likedUserId = String(historyEvent?.actor_user_id || "").trim();
  const safeLikerUserId = String(likerUserId || "").trim();

  if (!eventId) {
    throw new Error("Command history entry not found.");
  }
  if (!likedUserId || !safeLikerUserId || likedUserId === safeLikerUserId) {
    throw new Error("That command cannot be liked.");
  }

  const payload = historyEvent?.payloadObj || tryJson(historyEvent?.payload) || {};
  const groupKey = String(payload?.groupKey || "").trim();
  const sourceKind =
    String(payload?.sourceKind || "").trim() === "group" || groupKey
      ? "group"
      : "direct";
  const sourceId = sourceKind === "group" ? groupKey || null : safeLikerUserId;
  const createdAt = Date.now();

  const result = recordCommandHistoryLikeTx({
    eventId,
    likedUserId,
    likerUserId: safeLikerUserId,
    sourceKind,
    sourceId,
    createdAt,
  });

  if (!result.inserted) {
    return {
      ok: true,
      alreadyLiked: true,
      liked: true,
      likesTotal: result.likesTotal,
      likedUserId,
      likerUserId: safeLikerUserId,
    };
  }

  const likerUser = getUserSummaryForCommandLike(safeLikerUserId);
  const likerDisplayName = getPreferredDisplayName(likerUser);
  const groupLabel = sourceKind === "group"
    ? String(
        payload?.groupLabel ||
          getResolvedGroupCatalogEntry(groupKey)?.label ||
          groupKey ||
          "",
      ).trim()
    : "";
  const actionUrl = sourceKind === "group"
    ? groupKey
      ? `/group/${encodeURIComponent(groupKey)}`
      : ""
    : buildControlLinkPathForUser(safeLikerUserId);

  try {
    upsertCommandLikeNotification({
      likedUserId,
      likerUserId: safeLikerUserId,
      likerDisplayName,
      sourceKind,
      sourceId,
      groupLabel,
      actionUrl,
      eventId,
    });
  } catch (notificationErr) {
    console.warn("[command-likes] notification failed:", notificationErr?.message || notificationErr);
  }

  logEvent({
    type: "command_history_liked",
    actorUserId: safeLikerUserId,
    targetUserId: likedUserId,
    req,
    payload: {
      eventId,
      sourceKind,
      sourceId,
      likesTotal: result.likesTotal,
    },
  });

  return {
    ok: true,
    alreadyLiked: false,
    liked: true,
    likesTotal: result.likesTotal,
    likedUserId,
    likerUserId: safeLikerUserId,
  };
}

function filterTargetsBlockedByActor(targets, actorUserId) {
  const actorId = String(actorUserId || "").trim();
  const list = Array.isArray(targets) ? targets : [];
  if (!actorId || !list.length) {
    return { allowedTargets: list, blockedOwnerUserIds: [] };
  }

  const ownerIds = Array.from(
    new Set(
      list
        .map((target) => String(target?.ownerUserId || "").trim())
        .filter(Boolean),
    ),
  );

  if (!ownerIds.length) {
    return { allowedTargets: list, blockedOwnerUserIds: [] };
  }

  const placeholders = ownerIds.map(() => "?").join(",");
  const blockedRows = db
    .prepare(
      `
      SELECT owner_user_id
      FROM command_sender_blocks
      WHERE blocked_user_id=?
        AND owner_user_id IN (${placeholders})
    `,
    )
    .all(actorId, ...ownerIds);

  const blockedOwnerIds = new Set(
    blockedRows
      .map((row) => String(row.owner_user_id || "").trim())
      .filter(Boolean),
  );

  return {
    allowedTargets: list.filter(
      (target) => !blockedOwnerIds.has(String(target?.ownerUserId || "").trim()),
    ),
    blockedOwnerUserIds: Array.from(blockedOwnerIds),
  };
}

function filterTargetsByWhitelist(targets, actorUserId) {
  const actorId = String(actorUserId || "").trim();
  const list = Array.isArray(targets) ? targets : [];
  if (!actorId || !list.length) {
    return { allowedTargets: list, whitelistDeniedOwnerUserIds: [] };
  }

  const allowedTargets = [];
  const whitelistDeniedOwnerUserIds = [];

  for (const target of list) {
    const ownerId = String(target?.ownerUserId || "").trim();
    if (!ownerId || isAllowedByWhitelist(ownerId, actorId)) {
      allowedTargets.push(target);
      continue;
    }
    whitelistDeniedOwnerUserIds.push(ownerId);
  }

  return { allowedTargets, whitelistDeniedOwnerUserIds };
}

const postBoardMessageTx = db.transaction((ownerUserId, body) => {
  const now = Date.now();

  const insertResult = db.prepare(
    `
    INSERT INTO device_message_board (owner_user_id, body, created_at)
    VALUES (?, ?, ?)
  `,
  ).run(ownerUserId, body, now);

  db.prepare(
    `
    DELETE FROM device_message_board
    WHERE owner_user_id=?
      AND id NOT IN (
        SELECT id
        FROM device_message_board
        WHERE owner_user_id=?
        ORDER BY created_at DESC, id DESC
        LIMIT 100
      )
  `,
  ).run(ownerUserId, ownerUserId);

  return {
    id: String(insertResult.lastInsertRowid),
    createdAt: now,
  };
});

function saveResponseToDisk({ ownerUserId, actorUserId, deviceId, commandId, responseType, mime, b64, width, height, monitors }) {
  if (!ownerUserId) return null;
  if (!b64 || typeof b64 !== "string") return null;
  if (mime !== "image/webp") return null;

  let buf;
  try {
    buf = b64ToBuffer(b64);
  } catch {
    return null;
  }

  const MAX = 12 * 1024 * 1024;
  if (buf.length <= 0 || buf.length > MAX) return null;

  const id = crypto.randomUUID();
  const filename = `resp_${Date.now()}_${id}.webp`;
  const filePath = path.join(RESPONSES_DIR, filename);

  fs.writeFileSync(filePath, buf);

  db.prepare(`
    INSERT INTO device_responses (
      id, created_at, owner_user_id, actor_user_id, device_id, command_id,
      response_type, mime, file_path, bytes, width, height, monitors
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    Date.now(),
    String(ownerUserId),
    actorUserId ? String(actorUserId) : null,
    deviceId ? String(deviceId) : null,
    commandId ? String(commandId) : null,
    String(responseType || "unknown"),
    String(mime),
    String(filePath),
    buf.length,
    Number(width || 0) || null,
    Number(height || 0) || null,
    Number(monitors || 0) || null,
  );

  return { id, filename, bytes: buf.length };
}

function saveResponseFromAck({ ownerUserId, deviceId, ack }) {
  if (!ack || ack.type !== "ack") return null;

  const d = ack.details || null;
  if (!d || typeof d !== "object") return null;

  const kind = String(d.kind || "").trim();
  const mime = String(d.mime || "image/webp");
  const b64 = d.webp_b64;
  const commandId = ack.commandId ? String(ack.commandId) : null;

  if (!b64) return null;

  if (kind !== "screenshot" && kind !== "webcam_capture") return null;

  return saveResponseToDisk({
    ownerUserId,
    actorUserId: resolveActorUserIdByCommandId(commandId),
    deviceId,
    commandId,
    responseType: kind,
    mime,
    b64,
    width: d.width,
    height: d.height,
    monitors: d.monitors,
  });
}

const {
  getLastReportedCapabilitiesForOwner,
  getLastReportedCapabilitiesForWhitelistedSenders,
  getReportedCapabilitiesForOwner,
  getReportedCapabilitiesForWhitelistedSenders,
  getUnionCapsForOwnerOnline,
  getUnionCapsForWhitelistedSendersOnline,
  groupHasReportedCapability,
  isDeviceOnline,
  lastCapsByUserId,
  registerRealtimeServer,
  resolveOwnerUserIdByDeviceId,
  wsByDeviceId,
} = createRealtimeService({
  db,
  hmac,
  handleIncomingAck,
  saveResponseFromAck,
  handleDeviceConnected({ ownerUserId, at }) {
    const ts = Number(at || Date.now()) || Date.now();
    purgeExpiredQueuedCommandsForUser(ownerUserId, { now: ts, log: true });
    markOwnerOnlineActivity(ownerUserId, ts);
    void drainQueuedCommandsForUser(ownerUserId);
  },
  handleOwnerActivity({ ownerUserId, at, cause }) {
    if (String(cause || "").trim() === "connect") return;
    markOwnerOnlineActivity(ownerUserId, at);
  },
});

function bootstrapAdminsFromEnv() {
  const raw = String(process.env.BOOTSTRAP_ADMINS || "").trim();
  if (!raw) return;

  const ids = Array.from(new Set(raw
    .split(",")
    .map((s) => s.trim())
    .filter((id) => isDiscordId(id))));
  const now = Date.now();
  if (!ids.length) return;

  const ensureUser = db.prepare(`
    INSERT INTO users (
      discord_id,
      username,
      global_name,
      avatar,
      created_at,
      updated_at
    ) VALUES (?, ?, NULL, NULL, ?, ?)
    ON CONFLICT(discord_id) DO NOTHING
  `);

  const upsert = db.prepare(`
    INSERT INTO admins (discord_id, created_at, is_bootstrap)
    VALUES (?, ?, 1)
    ON CONFLICT(discord_id) DO UPDATE SET
      is_bootstrap=1
  `);

  const tx = db.transaction(() => {
    for (const id of ids) {
      ensureUser.run(id, id, now, now);
      upsert.run(id, now);
    }
  });
  tx();

  console.log("[admin] bootstrapped:", ids);
}
bootstrapAdminsFromEnv();

const {
  inviteGate,
  isAdmin,
  requireAdmin,
  requireBootstrapAdmin,
  requireDiscord,
  wantsJson,
} = createAuthMiddleware({
  db,
  renderWithLayout,
  isEnrolledUser,
  markUserEnrolled,
  isEnrollmentOpen,
});

function isDiscordId(s) {
  return typeof s === "string" && /^\d{10,20}$/.test(s.trim());
}

function isWhitelistEnabled(ownerId) {
  const row = db
    .prepare(`SELECT whitelist_enabled FROM users WHERE discord_id=?`)
    .get(ownerId);
  return !!row?.whitelist_enabled;
}

function normalizeWhitelistSearchQuery(rawQuery) {
  return String(rawQuery || "")
    .trim()
    .replace(/^@+/, "")
    .trim();
}

function getWhitelist(ownerId) {
  return db
    .prepare(
      `
    SELECT w.allowed_id, u.username, u.global_name, u.avatar, w.created_at
    FROM user_whitelist w
    LEFT JOIN users u ON u.discord_id = w.allowed_id
    WHERE w.owner_id=?
    ORDER BY w.created_at DESC
  `,
    )
    .all(ownerId);
}

function normalizeWhitelistUserItem(userLike) {
  const discordId = String(
    userLike?.discord_id || userLike?.allowed_id || "",
  ).trim();
  if (!discordId) return null;

  const username = String(userLike?.username || "").trim();
  const globalName = String(userLike?.global_name || "").trim();

  return {
    discordId,
    username,
    globalName,
    displayName: globalName || username || discordId,
    avatarUrl: siteAvatarUrl({ discord_id: discordId }, 64),
    createdAt: Number(userLike?.created_at || 0) || 0,
    alreadyWhitelisted: !!Number(userLike?.already_whitelisted || 0),
  };
}

function searchWhitelistUsers(ownerId, rawQuery, limit = WHITELIST_SEARCH_RESULT_LIMIT) {
  const query = normalizeWhitelistSearchQuery(rawQuery);
  if (query.length < WHITELIST_SEARCH_MIN_LEN) return [];

  const safeLimit = Math.max(
    1,
    Math.min(Number(limit) || WHITELIST_SEARCH_RESULT_LIMIT, 24),
  );
  const escapedQuery = query.replace(/[\\%_]/g, "\\$&");
  const like = `%${escapedQuery}%`;
  const starts = `${escapedQuery}%`;

  return db
    .prepare(
      `
        SELECT
          u.discord_id,
          u.username,
          u.global_name,
          CASE
            WHEN EXISTS (
              SELECT 1
              FROM user_whitelist w
              WHERE w.owner_id = @ownerId AND w.allowed_id = u.discord_id
            ) THEN 1
            ELSE 0
          END AS already_whitelisted
        FROM users u
        WHERE u.discord_id != @ownerId
          AND (
            u.discord_id LIKE @like ESCAPE '\\'
            OR IFNULL(u.username, '') LIKE @like ESCAPE '\\'
            OR IFNULL(u.global_name, '') LIKE @like ESCAPE '\\'
          )
        ORDER BY
          CASE
            WHEN u.discord_id = @exact THEN 0
            WHEN LOWER(IFNULL(u.username, '')) = LOWER(@exact) THEN 1
            WHEN LOWER(IFNULL(u.global_name, '')) = LOWER(@exact) THEN 2
            WHEN LOWER(IFNULL(u.username, '')) LIKE LOWER(@starts) ESCAPE '\\' THEN 3
            WHEN LOWER(IFNULL(u.global_name, '')) LIKE LOWER(@starts) ESCAPE '\\' THEN 4
            ELSE 5
          END ASC,
          already_whitelisted ASC,
          COALESCE(u.global_name, u.username, u.discord_id) COLLATE NOCASE ASC
        LIMIT ${safeLimit}
      `,
    )
    .all({
      ownerId,
      like,
      starts,
      exact: query,
    })
    .map(normalizeWhitelistUserItem)
    .filter(Boolean);
}

function isAllowedByWhitelist(ownerId, actorId) {
  if (!actorId) return false;

  if (ownerId === actorId) return true;

  if (isAdmin(actorId)) return true;

  if (!isWhitelistEnabled(ownerId)) return true;

  const row = db
    .prepare(
      `
    SELECT 1 FROM user_whitelist
    WHERE owner_id=? AND allowed_id=?
  `,
    )
    .get(ownerId, actorId);

  return !!row;
}

function getCommandBlockMessage() {
  return "This user has blocked you.";
}

function denyIfBlockedCommandSender(res, ownerId, actorId, { json = false } = {}) {
  if (!isCommandSenderBlockedByOwner(ownerId, actorId)) return false;

  const message = getCommandBlockMessage();
  if (json) {
    res.status(403).json({
      ok: false,
      code: "BLOCKED_BY_RECIPIENT",
      message,
    });
    return true;
  }

  res.status(403).send(message);
  return true;
}

function logEvent({
  type,
  actorUserId = null,
  targetUserId = null,
  pairCode = null,
  deviceId = null,
  req = null,
  payload = {},
}) {
  db.prepare(
    `
    INSERT INTO events (
      id, created_at, type,
      actor_user_id, target_user_id,
      pair_code, device_id,
      ip, ua, payload
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    crypto.randomUUID(),
    Date.now(),
    String(type),
    actorUserId,
    targetUserId,
    pairCode,
    deviceId,
    req ? req.headers["x-forwarded-for"] || req.ip || null : null,
    req ? req.headers["user-agent"] || null : null,
    JSON.stringify(payload ?? {}),
  );
}

function requestLooksLikeLinkPreview(req) {
  const ua = String(req?.headers?.["user-agent"] || "").toLowerCase();
  if (!ua) return false;

  return [
    "discordbot",
    "twitterbot",
    "slackbot",
    "slack-imgproxy",
    "facebookexternalhit",
    "linkedinbot",
    "skypeuripreview",
    "telegrambot",
    "whatsapp",
  ].some((token) => ua.includes(token));
}

function discordAvatarUrl(u, size = 64) {
  if (u && u.avatar) {
    return `https://cdn.discordapp.com/avatars/${u.discord_id}/${u.avatar}.png?size=${size}`;
  }

  return "https://cdn.discordapp.com/embed/avatars/0.png";
}

const SITE_AVATAR_EXT_BY_MIME = Object.freeze({
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
});

const SITE_AVATAR_MIME_BY_EXT = Object.freeze({
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
});

const CUSTOM_SITE_AVATAR_ALLOWED_EXTS = new Set(["png", "jpg", "webp", "gif"]);
const CUSTOM_SITE_AVATAR_ALLOWED_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

const CONTROL_LINK_THEME_OPTIONS = Object.freeze([
  { key: "purple", label: "Purple", color: "#a78bfa" },
  { key: "blue", label: "Blue", color: "#60a5fa" },
  { key: "green", label: "Green", color: "#34d399" },
  { key: "pink", label: "Pink", color: "#f472b6" },
]);

const TOP_FAVORITES_LIMIT = 3;
const COMMAND_MILESTONE_BADGE_LEVELS = Object.freeze([
  { threshold: 50, label: "50" },
  { threshold: 100, label: "100" },
  { threshold: 200, label: "200" },
  { threshold: 500, label: "500" },
  { threshold: 750, label: "750" },
  { threshold: 1000, label: "1000" },
  { threshold: 2000, label: "2000" },
  { threshold: 5000, label: "5000+" },
]);

const CONTROL_LINK_THEME_KEYS = new Set(
  CONTROL_LINK_THEME_OPTIONS.map((theme) => theme.key),
);

function normalizeControlLinkTheme(value) {
  const key = String(value || "")
    .trim()
    .toLowerCase();
  return CONTROL_LINK_THEME_KEYS.has(key) ? key : "purple";
}

function normalizeControlLinkDisplayName(value) {
  const normalized = String(value || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) return null;
  return normalized.slice(0, 40);
}

function normalizeCustomControlSlug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .slice(0, CUSTOM_CONTROL_URL_MAX_LEN);
}

function isValidCustomControlSlug(value) {
  const slug = normalizeCustomControlSlug(value);
  if (slug.length < CUSTOM_CONTROL_URL_MIN_LEN) return false;
  return /^[a-z0-9]+$/.test(slug);
}

function buildCustomControlUrl(slug) {
  const normalizedSlug = normalizeCustomControlSlug(slug);
  if (!isValidCustomControlSlug(normalizedSlug)) return "";
  return `https://playctrl.me/c/${normalizedSlug}`;
}

function buildControlLinkPathForUser(userId) {
  const safeUserId = String(userId || "").trim();
  if (!safeUserId) return "";

  const row = db
    .prepare(
      `
      SELECT
        u.custom_control_slug,
        pc.code_plain
      FROM users u
      LEFT JOIN pair_codes pc ON pc.user_id = u.discord_id
      WHERE u.discord_id=?
      LIMIT 1
    `,
    )
    .get(safeUserId);

  const customSlug = normalizeCustomControlSlug(row?.custom_control_slug);
  if (isValidCustomControlSlug(customSlug)) {
    return `/c/${encodeURIComponent(customSlug)}`;
  }

  const pairCode = String(row?.code_plain || "").trim();
  return /^\d{6}$/.test(pairCode)
    ? `/device/${encodeURIComponent(pairCode)}`
    : "";
}

function formatDateTimeLabel(value) {
  const ts = Number(value || 0);
  if (!Number.isFinite(ts) || ts <= 0) return "";

  return new Date(ts).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function getCustomControlUrlNextChangeAt(updatedAt, now = Date.now()) {
  const changedAt = Number(updatedAt || 0);
  if (!Number.isFinite(changedAt) || changedAt <= 0) return 0;
  return changedAt + CUSTOM_CONTROL_URL_CHANGE_COOLDOWN_MS;
}

function canChangeCustomControlUrl(updatedAt, now = Date.now()) {
  const nextChangeAt = getCustomControlUrlNextChangeAt(updatedAt, now);
  if (!nextChangeAt) {
    return {
      canChangeNow: true,
      nextChangeAt: 0,
    };
  }

  return {
    canChangeNow: Number(now) >= nextChangeAt,
    nextChangeAt,
  };
}

function getPairCodeResetNextAllowedAt(lastResetAt, now = Date.now()) {
  const resetAt = Number(lastResetAt || 0);
  if (!Number.isFinite(resetAt) || resetAt <= 0) return 0;
  return resetAt + PAIR_CODE_RESET_COOLDOWN_MS;
}

function getPairCodeResetState(lastResetAt, now = Date.now()) {
  const nextAllowedAt = getPairCodeResetNextAllowedAt(lastResetAt, now);
  if (!nextAllowedAt) {
    return {
      canResetNow: true,
      nextAllowedAt: 0,
    };
  }

  return {
    canResetNow: Number(now) >= nextAllowedAt,
    nextAllowedAt,
  };
}

function getProfileFlash(query) {
  const flashKey = String(query?.flash || "").trim();
  if (flashKey === "pair_code_reset") {
    return {
      text: "Your pairing code was reset.",
      isError: false,
    };
  }

  if (flashKey === "pair_code_reset_cooldown") {
    const nextResetAt = Number(query?.next_reset_at || 0);
    const nextResetLabel = formatDateTimeLabel(nextResetAt);
    return {
      text: nextResetLabel
        ? `You can reset your pairing code again after ${nextResetLabel}.`
        : "You can only reset your pairing code once every 10 minutes.",
      isError: true,
    };
  }

  return null;
}

function getPreferredDisplayName(userLike) {
  return (
    normalizeControlLinkDisplayName(userLike?.control_link_display_name) ||
    userLike?.global_name ||
    userLike?.username ||
    userLike?.discord_id ||
    ""
  );
}

const {
  ADMIN_ACTIVITY_RANGE_24H,
  ADMIN_ACTIVITY_RANGE_7D,
  HOME_LEADERBOARD_LIMIT,
  clampLeaderboardLimit,
  getAdminCommandActivityDatasets,
  getUtcDayWindow,
} = createAdminActivityService({
  db,
  HOUR_MS,
  DAY_MS,
  formatCountLabel,
});

const {
  deleteMediaUrlResolverSite,
  listMediaUrlResolverSites,
  listSupportedMediaUrlResolvers,
  resolvePopupMediaUrl,
  saveMediaUrlResolverSite,
} = createMediaUrlResolverService({
  db,
  logEvent,
});

function shapeLeaderboardEntry(row, rawCount) {
  return {
    discordId: String(row?.discord_id || "").trim(),
    username: row?.username || null,
    displayName: getPreferredDisplayName(row),
    avatarUrl: siteAvatarUrl(row, 64),
    commandsSent: Number(rawCount || 0),
  };
}

function getOnlineUserCount() {
  return listOnlineOwnerUserIds().length;
}

function listTopCommandSendersAllTime(limit = HOME_LEADERBOARD_LIMIT) {
  const max = clampLeaderboardLimit(limit);
  const rows = db
    .prepare(
      `
      SELECT
        discord_id,
        username,
        global_name,
        control_link_display_name,
        IFNULL(commands_sent_total, 0) AS commands_sent_total
      FROM users
      WHERE IFNULL(exclude_from_leaderboards, 0) = 0
        AND IFNULL(commands_sent_total, 0) > 0
        AND NOT EXISTS (
          SELECT 1
          FROM bans b
          WHERE b.discord_id = users.discord_id
        )
      ORDER BY
        commands_sent_total DESC,
        LOWER(COALESCE(control_link_display_name, global_name, username, discord_id)) ASC
      LIMIT ?
    `,
    )
    .all(max);

  return rows.map((row) =>
    shapeLeaderboardEntry(row, row.commands_sent_total),
  );
}

function listTopCommandSendersForUtcDay(
  limit = HOME_LEADERBOARD_LIMIT,
  nowMs = Date.now(),
) {
  const max = clampLeaderboardLimit(limit);
  const day = getUtcDayWindow(nowMs);

  const rows = db
    .prepare(
      `
      SELECT
        u.discord_id,
        u.username,
        u.global_name,
        u.control_link_display_name,
        COUNT(*) AS commands_sent,
        MAX(c.created_at) AS last_command_at
      FROM command_send_counts c
      JOIN users u ON u.discord_id = c.actor_user_id
      WHERE c.created_at >= ?
        AND c.created_at < ?
        AND IFNULL(u.exclude_from_leaderboards, 0) = 0
        AND NOT EXISTS (
          SELECT 1
          FROM bans b
          WHERE b.discord_id = u.discord_id
        )
      GROUP BY
        u.discord_id,
        u.username,
        u.global_name,
        u.control_link_display_name
      ORDER BY
        commands_sent DESC,
        last_command_at DESC,
        LOWER(COALESCE(u.control_link_display_name, u.global_name, u.username, u.discord_id)) ASC
      LIMIT ?
    `,
    )
    .all(day.startMs, day.endMs, max);

  return {
    ...day,
    items: rows.map((row) => shapeLeaderboardEntry(row, row.commands_sent)),
  };
}

function getCommandsSentMilestoneBadge(total) {
  const commandsSentTotal = Math.max(0, Number(total || 0));
  let matchedLevel = null;

  for (const level of COMMAND_MILESTONE_BADGE_LEVELS) {
    if (commandsSentTotal >= level.threshold) {
      matchedLevel = level;
    }
  }

  if (!matchedLevel) return null;

  const tier =
    COMMAND_MILESTONE_BADGE_LEVELS.indexOf(matchedLevel) + 1;
  const milestoneHoverLabel = matchedLevel.label.endsWith("+")
    ? matchedLevel.label
    : `${matchedLevel.label}+`;

  return {
    key: `commands-sent-${matchedLevel.threshold}`,
    kind: "commands-sent",
    icon: "trophy",
    tier,
    label: matchedLevel.label,
    title: `${milestoneHoverLabel} commands sent`,
    ariaLabel: `${milestoneHoverLabel} commands sent badge`,
  };
}

function getSupporterBadge(enabled) {
  if (!enabled) return null;

  return {
    key: "supporter",
    kind: "supporter",
    icon: "star",
    label: "",
    title: "Donator",
    ariaLabel: "Donator badge",
  };
}

function normalizeAvatarSize(size, fallback = 64) {
  const n = Number(size);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(16, Math.min(512, Math.round(n)));
}

function normalizeAvatarFileSegment(value, fallback = "avatar") {
  const clean = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "");
  return clean || fallback;
}

function resolveStoredSiteAvatarPath(storedPath) {
  const rel = String(storedPath || "").trim();
  if (!rel) return null;

  const base = path.resolve(SITE_AVATARS_DIR);
  const abs = path.resolve(base, rel);
  if (abs === base || abs.startsWith(base + path.sep)) return abs;
  return null;
}

function siteAvatarMimeFromPath(filePath) {
  const ext = path.extname(String(filePath || "")).slice(1).toLowerCase();
  return SITE_AVATAR_MIME_BY_EXT[ext] || "application/octet-stream";
}

function deleteStoredSiteAvatar(storedPath) {
  const abs = resolveStoredSiteAvatarPath(storedPath);
  if (!abs) return;
  try {
    fs.unlinkSync(abs);
  } catch (e) {
    if (e?.code !== "ENOENT") {
      console.warn("[avatar-cache] failed to delete cached avatar:", e?.message || e);
    }
  }
}

function resolvePersistedSiteAvatar(row) {
  const candidates = [
    {
      storedPath: row?.custom_avatar_path,
      mime: row?.custom_avatar_mime,
    },
    {
      storedPath: row?.avatar_cache_path,
      mime: row?.avatar_cache_mime,
    },
  ];

  for (const candidate of candidates) {
    const abs = resolveStoredSiteAvatarPath(candidate.storedPath);
    if (!abs || !fs.existsSync(abs)) continue;
    return {
      absolutePath: abs,
      mime: String(candidate.mime || "").trim() || siteAvatarMimeFromPath(abs),
    };
  }

  return null;
}

function resolvePersistedSiteBanner(row) {
  const abs = resolveStoredSiteAvatarPath(row?.custom_banner_path);
  if (!abs || !fs.existsSync(abs)) return null;

  return {
    absolutePath: abs,
    mime:
      String(row?.custom_banner_mime || "").trim() ||
      siteAvatarMimeFromPath(abs),
  };
}

function resolvePersistedSiteBackground(row) {
  const abs = resolveStoredSiteAvatarPath(row?.custom_background_path);
  if (!abs || !fs.existsSync(abs)) return null;

  return {
    absolutePath: abs,
    mime:
      String(row?.custom_background_mime || "").trim() ||
      siteAvatarMimeFromPath(abs),
  };
}

function sendDefaultSiteAvatar(res) {
  if (fs.existsSync(DEFAULT_SITE_AVATAR_PATH)) {
    return res.type("image/svg+xml").sendFile(DEFAULT_SITE_AVATAR_PATH);
  }

  return res.type("image/svg+xml").send(INLINE_DEFAULT_SITE_AVATAR_SVG);
}

function siteAvatarUrl(u, size = 64) {
  const discordId = String(
    u?.discord_id || u?.discordId || u?.id || "",
  ).trim();
  if (!discordId) return "/default-avatar.svg";

  const qs = new URLSearchParams({
    size: String(normalizeAvatarSize(size)),
  });
  return `/avatars/${encodeURIComponent(discordId)}?${qs.toString()}`;
}

function siteBannerUrl(u, size = 1600) {
  const discordId = String(
    u?.discord_id || u?.discordId || u?.id || "",
  ).trim();
  if (!discordId) return "";

  const qs = new URLSearchParams({
    size: String(normalizeAvatarSize(size, 1600)),
  });
  return `/banners/${encodeURIComponent(discordId)}?${qs.toString()}`;
}

function chunkUniqueStrings(values, chunkSize = 400) {
  const items = Array.from(
    new Set(
      (Array.isArray(values) ? values : [])
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    ),
  );
  const chunks = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }
  return chunks;
}

function fnv1a32(str) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < str.length; index++) {
    hash ^= str.charCodeAt(index);
    hash =
      (hash +
        ((hash << 1) +
          (hash << 4) +
          (hash << 7) +
          (hash << 8) +
          (hash << 24))) >>>
      0;
  }
  return hash >>> 0;
}

function windowIdNow10m(now = Date.now()) {
  return Math.floor(Number(now || Date.now()) / (10 * 60 * 1000));
}

function listOnlineOwnerUserIds() {
  const onlineDeviceIds = [];
  for (const [deviceId] of wsByDeviceId.entries()) {
    const safeDeviceId = String(deviceId || "").trim();
    if (!safeDeviceId) continue;
    if (!isDeviceOnline(safeDeviceId)) continue;
    onlineDeviceIds.push(safeDeviceId);
  }

  if (!onlineDeviceIds.length) return [];

  const userIds = new Set();
  for (const chunk of chunkUniqueStrings(onlineDeviceIds)) {
    const placeholders = chunk.map(() => "?").join(",");
    const rows = db
      .prepare(
        `
        SELECT DISTINCT user_id
        FROM device_pairs
        WHERE device_id IN (${placeholders})
      `,
      )
      .all(...chunk);

    for (const row of rows) {
      const userId = String(row.user_id || "").trim();
      if (userId) userIds.add(userId);
    }
  }

  return Array.from(userIds);
}

function sortLiveDiscoverUsers(rows, now = Date.now()) {
  const windowId = windowIdNow10m(now);
  const statusOrder = { online: 0, away: 0, offline: 1 };

  rows.sort((left, right) => {
    const leftStatus = String(left?.status || left?.presence?.status || "offline");
    const rightStatus = String(right?.status || right?.presence?.status || "offline");
    const statusDiff =
      (statusOrder[leftStatus] ?? 9) - (statusOrder[rightStatus] ?? 9);
    if (statusDiff !== 0) return statusDiff;

    const leftKey = fnv1a32(`${windowId}:${String(left?.pairCode || left?.code_plain || "")}`);
    const rightKey = fnv1a32(`${windowId}:${String(right?.pairCode || right?.code_plain || "")}`);
    if (leftKey !== rightKey) return leftKey - rightKey;

    return String(left?.displayName || left?.preferred_display_name || left?.username || left?.discordId || left?.discord_id || "")
      .localeCompare(
        String(right?.displayName || right?.preferred_display_name || right?.username || right?.discordId || right?.discord_id || ""),
        undefined,
        { sensitivity: "base" },
      );
  });

  return rows;
}

function listLiveDiscoverUsers({ now = Date.now() } = {}) {
  const userIds = new Set(listOnlineOwnerUserIds());
  const awayCutoff = Math.max(0, Number(now || Date.now()) - AWAY_WINDOW_MS);

  const awayRows = db
    .prepare(
      `
      SELECT u.discord_id
      FROM users u
      JOIN pair_codes pc ON pc.user_id = u.discord_id
      LEFT JOIN bans b ON b.discord_id = u.discord_id
      WHERE u.discoverable = 1
        AND IFNULL(u.whitelist_enabled, 0) = 0
        AND IFNULL(u.away_enabled, 0) = 1
        AND IFNULL(u.last_online_at, 0) > ?
        AND b.discord_id IS NULL
    `,
    )
    .all(awayCutoff);

  for (const row of awayRows) {
    const userId = String(row.discord_id || "").trim();
    if (userId) userIds.add(userId);
  }

  const candidateUserIds = Array.from(userIds);
  if (!candidateUserIds.length) return [];

  const rows = [];
  for (const chunk of chunkUniqueStrings(candidateUserIds)) {
    const placeholders = chunk.map(() => "?").join(",");
    rows.push(
      ...db
        .prepare(
          `
          SELECT
            u.discord_id,
            u.username,
            u.global_name,
            u.avatar,
            u.custom_banner_path,
            u.custom_banner_updated_at,
            u.control_link_display_name,
            pc.code_plain
          FROM users u
          JOIN pair_codes pc ON pc.user_id = u.discord_id
          LEFT JOIN bans b ON b.discord_id = u.discord_id
          WHERE u.discord_id IN (${placeholders})
            AND u.discoverable = 1
            AND IFNULL(u.whitelist_enabled, 0) = 0
            AND b.discord_id IS NULL
        `,
        )
        .all(...chunk),
    );
  }

  if (!rows.length) return [];

  const presenceByUser = listPresenceStateByUserIds(
    rows.map((row) => row.discord_id),
    { now },
  );
  const liveRows = rows
    .map((row) => {
      const presence = presenceByUser.get(row.discord_id) || computePresenceState({ now });
      const bannerUrl = row.custom_banner_path
        ? `${siteBannerUrl(row, 1200)}${
            row.custom_banner_updated_at
              ? `&v=${encodeURIComponent(row.custom_banner_updated_at)}`
              : ""
          }`
        : "";

      return {
        ...row,
        discordId: String(row.discord_id || "").trim(),
        pairCode: String(row.code_plain || "").trim(),
        preferred_display_name: getPreferredDisplayName(row),
        displayName: getPreferredDisplayName(row),
        avatarUrl: siteAvatarUrl(row, 128),
        bannerUrl,
        presence,
        status: presence.status,
        online: !!presence.online,
        away: !!presence.away,
        awayUntil: Number(presence.awayUntil || 0),
      };
    })
    .filter((row) => row.status === "online" || row.status === "away");

  return sortLiveDiscoverUsers(liveRows, now);
}

function normalizeDiscoverSearchQuery(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function listFilteredDiscoverUsers({
  now = Date.now(),
  query = "",
  statuses = ["online", "away"],
} = {}) {
  const normalizedQuery = normalizeDiscoverSearchQuery(query);
  const allowedStatuses = new Set(
    (Array.isArray(statuses) ? statuses : [statuses])
      .map((status) => String(status || "").trim().toLowerCase())
      .filter((status) => status === "online" || status === "away"),
  );
  if (!allowedStatuses.size) return [];

  return listLiveDiscoverUsers({ now }).filter((user) => {
    const status = String(user?.status || "offline").trim().toLowerCase();
    if (!allowedStatuses.has(status)) return false;
    if (!normalizedQuery) return true;

    const haystack = normalizeDiscoverSearchQuery(
      `${String(user?.displayName || "")} ${String(user?.username || "")}`,
    );
    return haystack.includes(normalizedQuery);
  });
}

function listPagedDiscoverUsers({
  now = Date.now(),
  page = 1,
  perPage = 12,
  query = "",
  statuses = ["online", "away"],
} = {}) {
  const safePerPage = Math.max(
    1,
    Math.min(48, Math.floor(Number(perPage || 0)) || 12),
  );
  const filteredUsers = listFilteredDiscoverUsers({ now, query, statuses });
  const total = filteredUsers.length;
  const totalPages = total > 0 ? Math.ceil(total / safePerPage) : 1;
  const safePage = Math.max(
    1,
    Math.min(totalPages, Math.floor(Number(page || 0)) || 1),
  );
  const startIndex = (safePage - 1) * safePerPage;

  return {
    users: filteredUsers.slice(startIndex, startIndex + safePerPage),
    total,
    totalPages,
    page: safePage,
    perPage: safePerPage,
  };
}

function siteBackgroundUrl(u, size = 1920) {
  const discordId = String(
    u?.discord_id || u?.discordId || u?.id || "",
  ).trim();
  if (!discordId) return "";

  const qs = new URLSearchParams({
    size: String(normalizeAvatarSize(size, 1920)),
  });
  return `/backgrounds/${encodeURIComponent(discordId)}?${qs.toString()}`;
}

function discordAvatarFetchUrl(discordId, avatarHash, size = SITE_AVATAR_FETCH_SIZE) {
  const ext = String(avatarHash || "").startsWith("a_") ? "gif" : "png";
  return `https://cdn.discordapp.com/avatars/${encodeURIComponent(discordId)}/${encodeURIComponent(avatarHash)}.${ext}?size=${normalizeAvatarSize(size, SITE_AVATAR_FETCH_SIZE)}`;
}

function siteAvatarExtFromContentType(contentType, fallbackExt = "png") {
  const mime = String(contentType || "").split(";")[0].trim().toLowerCase();
  return SITE_AVATAR_EXT_BY_MIME[mime] || fallbackExt;
}

function normalizeSiteAvatarMime(contentType) {
  return String(contentType || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
}

function normalizeCustomSiteAvatarExt(ext) {
  const normalized = String(ext || "").trim().toLowerCase();
  if (normalized === "jpeg") return "jpg";
  return normalized;
}

function matchCustomSiteAvatarUpload({ filename, mime }) {
  const rawExt = path.extname(String(filename || "")).slice(1);
  const ext = normalizeCustomSiteAvatarExt(rawExt);
  const normalizedMime = normalizeSiteAvatarMime(mime);

  if (!CUSTOM_SITE_AVATAR_ALLOWED_EXTS.has(ext)) {
    return {
      ok: false,
      status: 400,
      message: "Use a PNG, JPG, WEBP, or GIF image.",
    };
  }

  if (normalizedMime && !CUSTOM_SITE_AVATAR_ALLOWED_MIMES.has(normalizedMime)) {
    return {
      ok: false,
      status: 400,
      message: "Use a PNG, JPG, WEBP, or GIF image.",
    };
  }

  return {
    ok: true,
    ext,
    mime: normalizedMime || SITE_AVATAR_MIME_BY_EXT[ext] || "image/png",
  };
}

function writeStoredSiteAvatarBuffer(storedPath, body) {
  const abs = resolveStoredSiteAvatarPath(storedPath);
  if (!abs) return null;

  const tempPath = `${storedPath}.${process.pid}.${Date.now()}.tmp`;
  const tempAbs = resolveStoredSiteAvatarPath(tempPath);
  if (!tempAbs) return null;

  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(tempAbs, body);
    try {
      fs.unlinkSync(abs);
    } catch (e) {
      if (e?.code !== "ENOENT") throw e;
    }
    fs.renameSync(tempAbs, abs);
    return abs;
  } catch (e) {
    try {
      fs.unlinkSync(tempAbs);
    } catch {}
    console.warn(
      `[avatar-cache] failed to store avatar ${storedPath}: ${e?.message || e}`,
    );
    return null;
  }
}

async function refreshCachedDiscordAvatar(discordUser, existingRow = null, options = {}) {
  const discordId = String(
    discordUser?.id || discordUser?.discord_id || "",
  ).trim();
  if (!discordId) return null;

  const force = !!options.force;
  const avatarHash = String(discordUser?.avatar || "").trim();
  const current =
    existingRow ||
    db
      .prepare(
        `
        SELECT avatar, avatar_cache_path, avatar_cache_mime, avatar_cache_updated_at
        FROM users
        WHERE discord_id=?
      `,
      )
      .get(discordId);

  const previousPath = String(current?.avatar_cache_path || "").trim();
  const previousHash = String(current?.avatar || "").trim();

  if (!avatarHash) {
    if (previousPath) deleteStoredSiteAvatar(previousPath);
    db.prepare(
      `
      UPDATE users
      SET avatar_cache_path=NULL,
          avatar_cache_mime=NULL,
          avatar_cache_updated_at=NULL
      WHERE discord_id=?
    `,
    ).run(discordId);
    return null;
  }

  if (!force && previousHash === avatarHash && previousPath) {
    const existingAbs = resolveStoredSiteAvatarPath(previousPath);
    if (existingAbs && fs.existsSync(existingAbs)) {
      return {
        storedPath: previousPath,
        mime:
          String(current?.avatar_cache_mime || "").trim() ||
          siteAvatarMimeFromPath(existingAbs),
      };
    }
  }

  let avatarResp;
  try {
    avatarResp = await fetch(discordAvatarFetchUrl(discordId, avatarHash));
  } catch (e) {
    console.warn(
      `[avatar-cache] fetch failed for ${discordId}: ${e?.message || e}`,
    );
    return null;
  }

  if (!avatarResp.ok) {
    console.warn(
      `[avatar-cache] fetch failed for ${discordId}: HTTP ${avatarResp.status}`,
    );
    return null;
  }

  const body = Buffer.from(await avatarResp.arrayBuffer());
  if (!body.length) return null;

  const mime = String(avatarResp.headers.get("content-type") || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  const fallbackExt = avatarHash.startsWith("a_") ? "gif" : "png";
  const ext = siteAvatarExtFromContentType(mime, fallbackExt);
  const storedPath = `${normalizeAvatarFileSegment(discordId, "user")}-discord.${ext}`;
  if (!writeStoredSiteAvatarBuffer(storedPath, body)) {
    return null;
  }

  const normalizedMime =
    SITE_AVATAR_MIME_BY_EXT[ext] ||
    mime ||
    siteAvatarMimeFromPath(storedPath);
  const updatedAt = Date.now();
  db.prepare(
    `
    UPDATE users
    SET avatar_cache_path=?,
        avatar_cache_mime=?,
        avatar_cache_updated_at=?
    WHERE discord_id=?
  `,
  ).run(storedPath, normalizedMime, updatedAt, discordId);

  if (previousPath && previousPath !== storedPath) {
    deleteStoredSiteAvatar(previousPath);
  }

  return {
    storedPath,
    mime: normalizedMime,
    updatedAt,
  };
}

function setCustomSiteAvatar(discordId, payload = {}) {
  const userId = String(discordId || "").trim();
  if (!userId) {
    return { ok: false, status: 400, message: "Missing user." };
  }

  const matched = matchCustomSiteAvatarUpload(payload);
  if (!matched.ok) return matched;

  let body;
  try {
    body = b64ToBuffer(payload.data);
  } catch {
    return {
      ok: false,
      status: 400,
      message: "Could not read that image.",
    };
  }

  if (!body || !body.length) {
    return {
      ok: false,
      status: 400,
      message: "That image was empty.",
    };
  }

  if (body.length > CUSTOM_SITE_AVATAR_MAX_BYTES) {
    return {
      ok: false,
      status: 413,
      message: `That image is too large (${formatBytesCompact(body.length)} > ${formatBytesCompact(CUSTOM_SITE_AVATAR_MAX_BYTES)}).`,
    };
  }

  const current =
    db
      .prepare(
        `
        SELECT custom_avatar_path
        FROM users
        WHERE discord_id=?
      `,
      )
      .get(userId) || null;

  const previousPath = String(current?.custom_avatar_path || "").trim();
  const storedPath = `custom/${normalizeAvatarFileSegment(userId, "user")}-custom.${matched.ext}`;
  const written = writeStoredSiteAvatarBuffer(storedPath, body);
  if (!written) {
    return {
      ok: false,
      status: 500,
      message: "Could not save that image.",
    };
  }

  const updatedAt = Date.now();
  db.prepare(
    `
    UPDATE users
    SET custom_avatar_path=?,
        custom_avatar_mime=?,
        custom_avatar_updated_at=?,
        updated_at=?
    WHERE discord_id=?
  `,
  ).run(storedPath, matched.mime, updatedAt, updatedAt, userId);

  if (previousPath && previousPath !== storedPath) {
    deleteStoredSiteAvatar(previousPath);
  }

  return {
    ok: true,
    storedPath,
    mime: matched.mime,
    updatedAt,
  };
}

function clearCustomSiteAvatar(discordId) {
  const userId = String(discordId || "").trim();
  if (!userId) {
    return { ok: false, status: 400, message: "Missing user." };
  }

  const current =
    db
      .prepare(
        `
        SELECT custom_avatar_path
        FROM users
        WHERE discord_id=?
      `,
      )
      .get(userId) || null;

  const previousPath = String(current?.custom_avatar_path || "").trim();
  if (previousPath) {
    deleteStoredSiteAvatar(previousPath);
  }

  const updatedAt = Date.now();
  db.prepare(
    `
    UPDATE users
    SET custom_avatar_path=NULL,
        custom_avatar_mime=NULL,
        custom_avatar_updated_at=NULL,
        updated_at=?
    WHERE discord_id=?
  `,
  ).run(updatedAt, userId);

  return {
    ok: true,
    updatedAt,
  };
}

function setCustomSiteBanner(discordId, payload = {}) {
  const userId = String(discordId || "").trim();
  if (!userId) {
    return { ok: false, status: 400, message: "Missing user." };
  }

  const matched = matchCustomSiteAvatarUpload(payload);
  if (!matched.ok) return matched;

  let body;
  try {
    body = b64ToBuffer(payload.data);
  } catch {
    return {
      ok: false,
      status: 400,
      message: "Could not read that image.",
    };
  }

  if (!body || !body.length) {
    return {
      ok: false,
      status: 400,
      message: "That image was empty.",
    };
  }

  if (body.length > CUSTOM_SITE_BANNER_MAX_BYTES) {
    return {
      ok: false,
      status: 413,
      message: `That image is too large (${formatBytesCompact(body.length)} > ${formatBytesCompact(CUSTOM_SITE_BANNER_MAX_BYTES)}).`,
    };
  }

  const current =
    db
      .prepare(
        `
        SELECT custom_banner_path
        FROM users
        WHERE discord_id=?
      `,
      )
      .get(userId) || null;

  const previousPath = String(current?.custom_banner_path || "").trim();
  const storedPath = `banners/${normalizeAvatarFileSegment(userId, "user")}-banner.${matched.ext}`;
  const written = writeStoredSiteAvatarBuffer(storedPath, body);
  if (!written) {
    return {
      ok: false,
      status: 500,
      message: "Could not save that image.",
    };
  }

  const updatedAt = Date.now();
  db.prepare(
    `
    UPDATE users
    SET custom_banner_path=?,
        custom_banner_mime=?,
        custom_banner_updated_at=?,
        updated_at=?
    WHERE discord_id=?
  `,
  ).run(storedPath, matched.mime, updatedAt, updatedAt, userId);

  if (previousPath && previousPath !== storedPath) {
    deleteStoredSiteAvatar(previousPath);
  }

  return {
    ok: true,
    storedPath,
    mime: matched.mime,
    updatedAt,
  };
}

function clearCustomSiteBanner(discordId) {
  const userId = String(discordId || "").trim();
  if (!userId) {
    return { ok: false, status: 400, message: "Missing user." };
  }

  const current =
    db
      .prepare(
        `
        SELECT custom_banner_path
        FROM users
        WHERE discord_id=?
      `,
      )
      .get(userId) || null;

  const previousPath = String(current?.custom_banner_path || "").trim();
  if (previousPath) {
    deleteStoredSiteAvatar(previousPath);
  }

  const updatedAt = Date.now();
  db.prepare(
    `
    UPDATE users
    SET custom_banner_path=NULL,
        custom_banner_mime=NULL,
        custom_banner_updated_at=NULL,
        updated_at=?
    WHERE discord_id=?
  `,
  ).run(updatedAt, userId);

  return {
    ok: true,
    updatedAt,
  };
}

function groupAvatarUrl(groupKey, size = 128) {
  const key = String(groupKey || "").trim();
  if (!key) return "";
  const qs = new URLSearchParams({
    size: String(normalizeAvatarSize(size)),
  });
  return `/group-avatars/${encodeURIComponent(key)}?${qs.toString()}`;
}

function groupBannerUrl(groupKey, size = 1600) {
  const key = String(groupKey || "").trim();
  if (!key) return "";
  const qs = new URLSearchParams({
    size: String(normalizeAvatarSize(size, 1600)),
  });
  return `/group-banners/${encodeURIComponent(key)}?${qs.toString()}`;
}

function setCustomCommunityGroupAvatar(groupKey, payload = {}) {
  const key = String(groupKey || "").trim();
  if (!key) {
    return { ok: false, status: 400, message: "Missing group." };
  }

  const matched = matchCustomSiteAvatarUpload(payload);
  if (!matched.ok) return matched;

  let body;
  try {
    body = b64ToBuffer(payload.data);
  } catch {
    return {
      ok: false,
      status: 400,
      message: "Could not read that image.",
    };
  }

  if (!body || !body.length) {
    return {
      ok: false,
      status: 400,
      message: "That image was empty.",
    };
  }

  if (body.length > CUSTOM_SITE_AVATAR_MAX_BYTES) {
    return {
      ok: false,
      status: 413,
      message: `That image is too large (${formatBytesCompact(body.length)} > ${formatBytesCompact(CUSTOM_SITE_AVATAR_MAX_BYTES)}).`,
    };
  }

  const current =
    db
      .prepare(
        `
        SELECT custom_avatar_path
        FROM community_groups
        WHERE group_key=?
      `,
      )
      .get(key) || null;
  if (!current) {
    return { ok: false, status: 404, message: "Group not found." };
  }

  const previousPath = String(current?.custom_avatar_path || "").trim();
  const storedPath = `groups/${normalizeAvatarFileSegment(key, "group")}-avatar.${matched.ext}`;
  const written = writeStoredSiteAvatarBuffer(storedPath, body);
  if (!written) {
    return {
      ok: false,
      status: 500,
      message: "Could not save that image.",
    };
  }

  const updatedAt = Date.now();
  db.prepare(
    `
    UPDATE community_groups
    SET custom_avatar_path=?,
        custom_avatar_mime=?,
        custom_avatar_updated_at=?,
        updated_at=?
    WHERE group_key=?
  `,
  ).run(storedPath, matched.mime, updatedAt, updatedAt, key);

  if (previousPath && previousPath !== storedPath) {
    deleteStoredSiteAvatar(previousPath);
  }

  return {
    ok: true,
    storedPath,
    mime: matched.mime,
    updatedAt,
  };
}

function clearCustomCommunityGroupAvatar(groupKey) {
  const key = String(groupKey || "").trim();
  if (!key) {
    return { ok: false, status: 400, message: "Missing group." };
  }

  const current =
    db
      .prepare(
        `
        SELECT custom_avatar_path
        FROM community_groups
        WHERE group_key=?
      `,
      )
      .get(key) || null;
  if (!current) {
    return { ok: false, status: 404, message: "Group not found." };
  }

  const previousPath = String(current?.custom_avatar_path || "").trim();
  if (previousPath) {
    deleteStoredSiteAvatar(previousPath);
  }

  const updatedAt = Date.now();
  db.prepare(
    `
    UPDATE community_groups
    SET custom_avatar_path=NULL,
        custom_avatar_mime=NULL,
        custom_avatar_updated_at=NULL,
        updated_at=?
    WHERE group_key=?
  `,
  ).run(updatedAt, key);

  return {
    ok: true,
    updatedAt,
  };
}

function setCustomCommunityGroupBanner(groupKey, payload = {}) {
  const key = String(groupKey || "").trim();
  if (!key) {
    return { ok: false, status: 400, message: "Missing group." };
  }

  const matched = matchCustomSiteAvatarUpload(payload);
  if (!matched.ok) return matched;

  let body;
  try {
    body = b64ToBuffer(payload.data);
  } catch {
    return {
      ok: false,
      status: 400,
      message: "Could not read that image.",
    };
  }

  if (!body || !body.length) {
    return {
      ok: false,
      status: 400,
      message: "That image was empty.",
    };
  }

  if (body.length > CUSTOM_SITE_BANNER_MAX_BYTES) {
    return {
      ok: false,
      status: 413,
      message: `That image is too large (${formatBytesCompact(body.length)} > ${formatBytesCompact(CUSTOM_SITE_BANNER_MAX_BYTES)}).`,
    };
  }

  const current =
    db
      .prepare(
        `
        SELECT custom_banner_path
        FROM community_groups
        WHERE group_key=?
      `,
      )
      .get(key) || null;
  if (!current) {
    return { ok: false, status: 404, message: "Group not found." };
  }

  const previousPath = String(current?.custom_banner_path || "").trim();
  const storedPath = `groups/${normalizeAvatarFileSegment(key, "group")}-banner.${matched.ext}`;
  const written = writeStoredSiteAvatarBuffer(storedPath, body);
  if (!written) {
    return {
      ok: false,
      status: 500,
      message: "Could not save that image.",
    };
  }

  const updatedAt = Date.now();
  db.prepare(
    `
    UPDATE community_groups
    SET custom_banner_path=?,
        custom_banner_mime=?,
        custom_banner_updated_at=?,
        updated_at=?
    WHERE group_key=?
  `,
  ).run(storedPath, matched.mime, updatedAt, updatedAt, key);

  if (previousPath && previousPath !== storedPath) {
    deleteStoredSiteAvatar(previousPath);
  }

  return {
    ok: true,
    storedPath,
    mime: matched.mime,
    updatedAt,
  };
}

function clearCustomCommunityGroupBanner(groupKey) {
  const key = String(groupKey || "").trim();
  if (!key) {
    return { ok: false, status: 400, message: "Missing group." };
  }

  const current =
    db
      .prepare(
        `
        SELECT custom_banner_path
        FROM community_groups
        WHERE group_key=?
      `,
      )
      .get(key) || null;
  if (!current) {
    return { ok: false, status: 404, message: "Group not found." };
  }

  const previousPath = String(current?.custom_banner_path || "").trim();
  if (previousPath) {
    deleteStoredSiteAvatar(previousPath);
  }

  const updatedAt = Date.now();
  db.prepare(
    `
    UPDATE community_groups
    SET custom_banner_path=NULL,
        custom_banner_mime=NULL,
        custom_banner_updated_at=NULL,
        updated_at=?
    WHERE group_key=?
  `,
  ).run(updatedAt, key);

  return {
    ok: true,
    updatedAt,
  };
}

function setCustomSiteBackground(discordId, payload = {}) {
  const userId = String(discordId || "").trim();
  if (!userId) {
    return { ok: false, status: 400, message: "Missing user." };
  }

  const matched = matchCustomSiteAvatarUpload(payload);
  if (!matched.ok) return matched;

  let body;
  try {
    body = b64ToBuffer(payload.data);
  } catch {
    return {
      ok: false,
      status: 400,
      message: "Could not read that image.",
    };
  }

  if (!body || !body.length) {
    return {
      ok: false,
      status: 400,
      message: "That image was empty.",
    };
  }

  if (body.length > CUSTOM_SITE_BACKGROUND_MAX_BYTES) {
    return {
      ok: false,
      status: 413,
      message: `That image is too large (${formatBytesCompact(body.length)} > ${formatBytesCompact(CUSTOM_SITE_BACKGROUND_MAX_BYTES)}).`,
    };
  }

  const current =
    db
      .prepare(
        `
        SELECT custom_background_path
        FROM users
        WHERE discord_id=?
      `,
      )
      .get(userId) || null;

  const previousPath = String(current?.custom_background_path || "").trim();
  const storedPath = `backgrounds/${normalizeAvatarFileSegment(userId, "user")}-background.${matched.ext}`;
  const written = writeStoredSiteAvatarBuffer(storedPath, body);
  if (!written) {
    return {
      ok: false,
      status: 500,
      message: "Could not save that image.",
    };
  }

  const updatedAt = Date.now();
  db.prepare(
    `
    UPDATE users
    SET custom_background_path=?,
        custom_background_mime=?,
        custom_background_updated_at=?,
        updated_at=?
    WHERE discord_id=?
  `,
  ).run(storedPath, matched.mime, updatedAt, updatedAt, userId);

  if (previousPath && previousPath !== storedPath) {
    deleteStoredSiteAvatar(previousPath);
  }

  return {
    ok: true,
    storedPath,
    mime: matched.mime,
    updatedAt,
  };
}

function clearCustomSiteBackground(discordId) {
  const userId = String(discordId || "").trim();
  if (!userId) {
    return { ok: false, status: 400, message: "Missing user." };
  }

  const current =
    db
      .prepare(
        `
        SELECT custom_background_path
        FROM users
        WHERE discord_id=?
      `,
      )
      .get(userId) || null;

  const previousPath = String(current?.custom_background_path || "").trim();
  if (previousPath) {
    deleteStoredSiteAvatar(previousPath);
  }

  const updatedAt = Date.now();
  db.prepare(
    `
    UPDATE users
    SET custom_background_path=NULL,
        custom_background_mime=NULL,
        custom_background_updated_at=NULL,
        updated_at=?
    WHERE discord_id=?
  `,
  ).run(updatedAt, userId);

  return {
    ok: true,
    updatedAt,
  };
}

async function runAvatarCacheBackfillCommand({ force = false } = {}) {
  const rows = db
    .prepare(
      `
      SELECT
        discord_id,
        username,
        global_name,
        avatar,
        avatar_cache_path,
        avatar_cache_mime,
        avatar_cache_updated_at,
        custom_avatar_path
      FROM users
      ORDER BY updated_at DESC, created_at DESC, discord_id ASC
    `,
    )
    .all();

  const stats = {
    total: rows.length,
    noAvatar: 0,
    skippedCustom: 0,
    downloaded: 0,
    reusedExisting: 0,
    failed: 0,
  };

  const startedAt = Date.now();

  console.log(
    `[avatar-cache] backfill starting for ${stats.total} users${force ? " (force mode)" : ""} using ${db.DB_PATH || process.env.DB_PATH || "ggbot.db"}`,
  );

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const discordId = String(row.discord_id || "").trim();
    const avatarHash = String(row.avatar || "").trim();
    const displayName =
      String(row.global_name || "").trim() ||
      String(row.username || "").trim() ||
      discordId;

    if (!discordId) continue;

    if (!avatarHash) {
      stats.noAvatar++;
      continue;
    }

    if (!force && String(row.custom_avatar_path || "").trim()) {
      stats.skippedCustom++;
      continue;
    }

    const existingCacheAbs = resolveStoredSiteAvatarPath(row.avatar_cache_path);
    const hadExistingCache = !!(existingCacheAbs && fs.existsSync(existingCacheAbs));

    try {
      const result = await refreshCachedDiscordAvatar(
        { discord_id: discordId, avatar: avatarHash },
        row,
        { force },
      );

      if (result) {
        if (hadExistingCache && !force) {
          stats.reusedExisting++;
        } else {
          stats.downloaded++;
        }
      } else {
        stats.failed++;
        console.warn(
          `[avatar-cache] failed to cache avatar for ${displayName} (${discordId})`,
        );
      }
    } catch (e) {
      stats.failed++;
      console.warn(
        `[avatar-cache] failed to cache avatar for ${displayName} (${discordId}): ${e?.message || e}`,
      );
    }

    if ((i + 1) % 25 === 0 || i === rows.length - 1) {
      console.log(
        `[avatar-cache] processed ${i + 1}/${stats.total} users`,
      );
    }
  }

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log("[avatar-cache] backfill finished", {
    ...stats,
    durationSeconds: Number(seconds),
  });

  return stats;
}

function getLoggedInUser(req) {
  const sid = req.cookies?.sid;
  if (!sid) return null;

  return (
    db
      .prepare(
        `
    SELECT
      u.discord_id,
      u.username,
      u.global_name,
      u.avatar,
      u.control_link_display_name,

      IFNULL(u.discoverable, 0)        AS discoverable,
      IFNULL(u.whitelist_enabled, 0)   AS whitelist_enabled,
      IFNULL(u.disable_custom_backgrounds, 0) AS disable_custom_backgrounds,
      IFNULL(u.away_enabled, 0)        AS away_enabled,
      u.last_online_at,

      u.invited_at,
      u.enrolled_at,

      s.created_at AS session_created_at
    FROM sessions s
    JOIN users u ON u.discord_id = s.discord_id
    WHERE s.session_id = ?
  `,
      )
      .get(sid) || null
  );
}

function getDelegatedUserForActor(actorUser, delegatedSubId) {
  const actorId = String(actorUser?.discord_id || "").trim();
  const subId = String(delegatedSubId || "").trim();
  if (!actorId || !subId || actorId === subId) return null;

  return (
    db
      .prepare(
        `
    SELECT
      u.discord_id,
      u.username,
      u.global_name,
      u.avatar,
      u.control_link_display_name,

      IFNULL(u.discoverable, 0)        AS discoverable,
      IFNULL(u.whitelist_enabled, 0)   AS whitelist_enabled,
      IFNULL(u.disable_custom_backgrounds, 0) AS disable_custom_backgrounds,
      IFNULL(u.away_enabled, 0)        AS away_enabled,
      u.last_online_at,

      u.invited_at,
      u.enrolled_at,

      NULL AS session_created_at
    FROM leash_delegations ld
    JOIN users u ON u.discord_id = ld.sub_user_id
    LEFT JOIN bans b ON b.discord_id = u.discord_id
    WHERE ld.sub_user_id = ?
      AND ld.dom_user_id = ?
      AND b.discord_id IS NULL
  `,
      )
      .get(subId, actorId) || null
  );
}

function getCommandPrefsForUser(discordId) {
  try {
    const row =
      db
        .prepare(
          `
      SELECT allow_popup, allow_open_url, allow_image_popup, allow_set_wallpaper, allow_screenshot, allow_webcam_capture, allow_play_sound, allow_write_for_me
             , allow_fullscreen_popup, allow_spiral_overlay, allow_subliminal_message
      FROM users WHERE discord_id=?
    `,
        )
        .get(discordId) || null;
    const subliminalEnabled = Number(row?.allow_subliminal_message ?? 1)
      ? 1
      : 0;
    return {
      allow_popup: 1,
      allow_open_url: 1,
      allow_image_popup: 1,
      allow_fullscreen_popup: 1,
      allow_spiral_overlay: 1,
      allow_set_wallpaper: 1,
      allow_screenshot: 0,
      allow_webcam_capture: 0,
      allow_play_sound: 0,
      allow_write_for_me: 0,
      allow_subliminal_message: subliminalEnabled,
      ...(row || {}),
      allow_subliminal_message: subliminalEnabled,
    };
  } catch {
    return {
      allow_popup: 1,
      allow_open_url: 1,
      allow_image_popup: 1,
      allow_fullscreen_popup: 1,
      allow_spiral_overlay: 1,
      allow_set_wallpaper: 1,
      allow_screenshot: 0,
      allow_webcam_capture: 0,
      allow_play_sound: 0,
      allow_write_for_me: 0,
      allow_subliminal_message: 1,
    };
  }
}

function getDefaultCommunityGroupCommandPrefs() {
  return COMMUNITY_GROUP_COMMAND_OPTIONS.reduce((prefs, option) => {
    prefs[option.field] = 1;
    return prefs;
  }, {});
}

function getCommunityGroupCommandPrefs(groupKey) {
  const key = String(groupKey || "").trim();
  const defaults = getDefaultCommunityGroupCommandPrefs();
  if (!key) return defaults;

  try {
    const row =
      db
        .prepare(
          `
      SELECT
        allow_popup,
        allow_open_url,
        allow_image_popup,
        allow_fullscreen_popup,
        allow_spiral_overlay,
        allow_set_wallpaper,
        allow_play_sound,
        allow_write_for_me,
        allow_subliminal_message
      FROM community_group_command_prefs
      WHERE group_key=?
    `,
        )
        .get(key) || null;

    return {
      ...defaults,
      ...(row || {}),
    };
  } catch {
    return defaults;
  }
}

function isCommunityGroupCommandEnabled(groupKey, commandKey) {
  return isCommandEnabled(
    getCommunityGroupCommandPrefs(groupKey),
    String(commandKey || "").trim(),
  );
}

function isCommandEnabled(prefs, cmd) {
  if (!prefs) return true;
  if (cmd === "popup") return !!prefs.allow_popup;
  if (cmd === "open_url") return !!prefs.allow_open_url;
  if (cmd === "image_popup") return !!prefs.allow_image_popup;
  if (cmd === "fullscreen_popup") return !!prefs.allow_fullscreen_popup;
  if (cmd === "spiral_overlay") return !!prefs.allow_spiral_overlay;
  if (cmd === "set_wallpaper") return !!prefs.allow_set_wallpaper;
  if (cmd === "screenshot") return !!prefs.allow_screenshot;
  if (cmd === "webcam_capture") return !!prefs.allow_webcam_capture;
  if (cmd === "play_sound") return !!prefs.allow_play_sound;
  if (cmd === "play_sound_loop" || cmd === "play_sound_loop_url") return false;
  if (cmd === "write_for_me") return !!prefs.allow_write_for_me;
  if (cmd === "subliminal_message") {
    return !!prefs.allow_subliminal_message;
  }
  return true;
}

function getBanRecord(discordId) {
  const safeDiscordId = String(discordId || "").trim();
  if (!safeDiscordId) return null;

  return (
    db
      .prepare("SELECT discord_id, reason FROM bans WHERE discord_id=?")
      .get(safeDiscordId) || null
  );
}

function resolveOwnerUserIdByPairCode(pairCode) {
  const safePairCode = String(pairCode || "").trim();
  if (!/^\d{6}$/.test(safePairCode)) return null;

  const row = db
    .prepare(
      `
      SELECT pc.user_id
      FROM pair_codes pc
      LEFT JOIN bans b ON b.discord_id = pc.user_id
      WHERE pc.code_hash=?
        AND b.discord_id IS NULL
    `,
    )
    .get(hmac(safePairCode));

  return String(row?.user_id || "").trim() || null;
}

function resolveOwnerAndDevicesByPairCode(pairCode) {
  const ownerUserId = resolveOwnerUserIdByPairCode(pairCode);
  if (!ownerUserId) return null;

  const deviceRows = db
    .prepare("SELECT device_id FROM device_pairs WHERE user_id=?")
    .all(ownerUserId);
  return {
    ownerUserId,
    deviceIds: deviceRows.map((r) => r.device_id),
  };
}

function getAboutMe(userId) {
  try {
    const row = db
      .prepare(`SELECT about_me FROM users WHERE discord_id=?`)
      .get(userId);
    return String(row?.about_me || "");
  } catch {
    return "";
  }
}

function setAboutMe(userId, text) {
  const clean = String(text || "").slice(0, 500);
  db.prepare(`UPDATE users SET about_me=? WHERE discord_id=?`).run(
    clean,
    userId,
  );
  return clean;
}

function getApiKeyFromReq(req) {
  const h = req.headers["authorization"];
  if (h && typeof h === "string" && h.toLowerCase().startsWith("bearer ")) {
    return h.slice(7).trim();
  }
  const x = req.headers["x-api-key"];
  if (x && typeof x === "string") return x.trim();
  return null;
}

const API_MIN_COMMANDS = 500;

function getCommandsSentTotal(discordId) {
  const r = db
    .prepare(
      `SELECT IFNULL(commands_sent_total, 0) AS n FROM users WHERE discord_id=?`,
    )
    .get(discordId);
  return r ? Number(r.n || 0) : 0;
}

function requireApiKey(req, res, next) {
  const raw = getApiKeyFromReq(req);
  if (!raw) return res.status(401).json({ ok: false, code: "NO_API_KEY" });

  const key_hash = hashApiKey(raw);
  const legacyKeyHash = hashLegacyApiKey(raw);

  const row = db
    .prepare(
      `
    SELECT
      k.user_id,
      k.key_hash AS stored_key_hash,
      IFNULL(u.commands_sent_total, 0) AS commands_sent_total
    FROM api_keys k
    JOIN users u ON u.discord_id = k.user_id
    WHERE k.key_hash IN (?, ?)
    ORDER BY CASE WHEN k.key_hash = ? THEN 0 ELSE 1 END
  `,
    )
    .get(key_hash, legacyKeyHash, key_hash);

  if (!row) return res.status(401).json({ ok: false, code: "INVALID_API_KEY" });

  if (!isCurrentApiKeyHash(row.stored_key_hash)) {
    db.prepare(
      `UPDATE api_keys SET key_hash=? WHERE user_id=? AND key_hash=?`,
    ).run(key_hash, row.user_id, legacyKeyHash);
  }

  if (row.commands_sent_total < API_MIN_COMMANDS) {
    return res.status(403).json({
      ok: false,
      code: "API_LOCKED",
      message: `API requires ${API_MIN_COMMANDS}+ commands sent.`,
      required: API_MIN_COMMANDS,
      have: row.commands_sent_total,
    });
  }

  req.api = { key_hash, user_id: row.user_id };
  next();
}

function enforceDailyQuota(req, res, next) {
  const LIMIT = 10_000;
  const nowUnix = Math.floor(Date.now() / 1000);

  function nextReset() {
    const d = new Date();
    d.setUTCHours(1, 0, 0, 0);
    return Math.floor(d.getTime() / 1000);
  }

  const key_hash = req.api?.key_hash;
  if (!key_hash)
    return res.status(500).json({ ok: false, code: "API_MISSING_CONTEXT" });

  let row = db
    .prepare(
      `
    SELECT
      IFNULL(requests_today, 0) AS requests_today,
      IFNULL(reset_unix, 0) AS reset_unix
    FROM api_keys
    WHERE key_hash=?
  `,
    )
    .get(key_hash);

  if (!row) return res.status(401).json({ ok: false, code: "INVALID_API_KEY" });

  let used = row.requests_today || 0;
  let resetUnix = row.reset_unix || 0;

  if (resetUnix <= 0 || nowUnix >= resetUnix) {
    resetUnix = nextReset();
    used = 0;
    db.prepare(
      `
      UPDATE api_keys
      SET requests_today=0, reset_unix=?
      WHERE key_hash=?
    `,
    ).run(resetUnix, key_hash);
  }

  let remaining = LIMIT - used;
  if (remaining < 0) remaining = 0;

  res.set("X-RateLimit-Limit", String(LIMIT));
  res.set("X-RateLimit-Remaining", String(remaining));
  res.set("X-RateLimit-Reset", String(resetUnix));

  try {
    const authedUserId = req.apiUserId || req.user?.discord_id || null;
    if (authedUserId) {
      const prev =
        db
          .prepare(`SELECT api_rate_limit FROM users WHERE discord_id=?`)
          .get(authedUserId)?.api_rate_limit || 0;
      const next = Number(used) || 0;
      if (prev !== next) {
        db.prepare(`UPDATE users SET api_rate_limit=? WHERE discord_id=?`).run(
          next,
          authedUserId,
        );
      }
    }
  } catch (e) {}

  if (remaining <= 0) {
    res.set("Retry-After", String(Math.max(0, resetUnix - nowUnix)));
    return res
      .status(429)
      .json({ ok: false, code: "RATE_LIMITED", reset: resetUnix });
  }

  db.prepare(
    `
    UPDATE api_keys
    SET requests_today = requests_today + 1
    WHERE key_hash=?
  `,
  ).run(key_hash);

  res.set("X-RateLimit-Remaining", String(Math.max(0, remaining - 1)));

  next();
}

const app = express();
const defaultJsonParser = express.json({ strict: true });
const uploadJsonParser = express.json({
  strict: true,
  limit: `${UPLOAD_REQUEST_LIMIT_MB}mb`,
});
const generalRequestLimiter = rateLimit({
  windowMs: WEB_RATE_LIMIT_WINDOW_MS,
  limit: WEB_RATE_LIMIT_MAX,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skip: (req) => req.method === "OPTIONS",
});
const writeRequestLimiter = rateLimit({
  windowMs: WEB_RATE_LIMIT_WINDOW_MS,
  limit: WEB_WRITE_RATE_LIMIT_MAX,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skip: (req) =>
    req.method === "GET" ||
    req.method === "HEAD" ||
    req.method === "OPTIONS",
});
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "./views"));
app.set("trust proxy", 1);
app.use(
  cors({
    origin: true,
    credentials: true,
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Device-Id",
      "X-Requested-With",
    ],
    exposedHeaders: [
      "RateLimit",
      "RateLimit-Policy",
      "X-RateLimit-Limit",
      "X-RateLimit-Remaining",
      "X-RateLimit-Reset",
      "Retry-After",
    ],
  }),
);
app.use(generalRequestLimiter);
app.use(writeRequestLimiter);
app.use(express.static(path.join(__dirname, "../public")));
app.use(cookieParser());
app.use((req, res, next) => {
  const wantsLargeJson =
    req.method === "POST" &&
    (req.path === "/api/uploads" ||
      /^\/api\/device\/[^/]+\/avatar$/.test(req.path) ||
      /^\/api\/device\/[^/]+\/banner$/.test(req.path) ||
      /^\/api\/device\/[^/]+\/background$/.test(req.path));

  if (wantsLargeJson) {
    return uploadJsonParser(req, res, next);
  }
  return defaultJsonParser(req, res, next);
});
app.use(express.urlencoded({ extended: false }));

app.use((req, res, next) => {
  const canonicalUrl = buildSiteUrl(req.path);
  const robotsValue = requestAllowsIndexing(req)
    ? INDEXABLE_ROBOTS_VALUE
    : NOINDEX_ROBOTS_VALUE;

  res.locals.meta = {
    ...(res.locals.meta || {}),
    canonicalUrl,
    robots: robotsValue,
  };

  if (!requestAllowsIndexing(req)) {
    res.set("X-Robots-Tag", robotsValue);
  }

  next();
});

app.use((req, res, next) => {
  const actorUser = getLoggedInUser(req);
  const delegatedSubId = String(req.cookies?.delegated_sub_id || "").trim();
  const delegatedUser = getDelegatedUserForActor(actorUser, delegatedSubId);
  if (actorUser && delegatedSubId && !delegatedUser) {
    res.clearCookie("delegated_sub_id", { path: "/" });
  }

  req.actorUser = actorUser || null;
  req.delegatedUser = delegatedUser || null;
  req.viewUser = delegatedUser || actorUser || null;
  req.viewIsAdmin = req.viewUser ? isAdmin(req.viewUser.discord_id) : false;
  req.actorIsAdmin = actorUser ? isAdmin(actorUser.discord_id) : false;
  next();
});

app.use(inviteGate);

app.use((req, res, next) => {
  const user = req.viewUser || null;
  const isAdmin = req.viewIsAdmin || null;

  res.locals.user = user;
  res.locals.isAdmin = isAdmin;
  res.locals.displayName = user
    ? getPreferredDisplayName(user)
    : null;
  res.locals.avatarUrl = user ? siteAvatarUrl(user, 64) : "/default-avatar.svg";
  res.locals.meta = {
    ...(res.locals.meta || {}),
    ogTitle: "PlayCtrl.me",
    ogDesc: "Remote play & control",
    ogUrl: res.locals.meta?.canonicalUrl || buildSiteUrl(req.path),
    ogImage: `${SITE_ORIGIN}/favicon-96x96.png`,
  };

  res.locals.LISTS = LISTS;
  res.locals.uploadUi = getUploadContextUiConfig();

  next();
});

app.use((req, res, next) => {
  const me = req.viewUser;

  if (!me) {
    res.locals.notificationMenuItems = [];
    res.locals.notificationUnreadCount = 0;
    res.locals.notificationTotalCount = 0;
    return next();
  }

  const summary = getNotificationSummaryForUser(me.discord_id, {
    limit: NOTIFICATION_MENU_LIMIT,
  });

  res.locals.notificationMenuItems = summary.items;
  res.locals.notificationUnreadCount = summary.unreadCount;
  res.locals.notificationTotalCount = summary.totalCount;
  next();
});

app.use((req, res, next) => {
  const me = req.viewUser;

  if (!me) {
    res.locals.commandsSentTotal = null;
    res.locals.commandLikesTotal = null;
    return next();
  }

  const row = db
    .prepare(
      `
      SELECT
        IFNULL(commands_sent_total, 0) AS commands_sent_total,
        IFNULL(command_likes_total, 0) AS command_likes_total
      FROM users
      WHERE discord_id=?
    `,
    )
    .get(me.discord_id);

  res.locals.commandsSentTotal = row?.commands_sent_total ?? 0;
  res.locals.commandLikesTotal = row?.command_likes_total ?? 0;
  next();
});

app.use((req, res, next) => {
  res.locals.discordAvatarUrl = discordAvatarUrl;
  res.locals.siteAvatarUrl = siteAvatarUrl;
  res.locals.siteBannerUrl = siteBannerUrl;
  res.locals.siteBackgroundUrl = siteBackgroundUrl;
  res.locals.inlineScriptJson = inlineScriptJson;
  next();
});

app.get("/avatars/:discordId", (req, res) => {
  const discordId = String(req.params.discordId || "").trim();
  const row =
    db
      .prepare(
        `
        SELECT
          custom_avatar_path,
          custom_avatar_mime,
          avatar_cache_path,
          avatar_cache_mime
        FROM users
        WHERE discord_id=?
      `,
      )
      .get(discordId) || null;

  res.set("Cache-Control", "private, no-cache, max-age=0, must-revalidate");
  const asset = resolvePersistedSiteAvatar(row);
  if (!asset) {
    return sendDefaultSiteAvatar(res);
  }

  res.type(asset.mime);
  return res.sendFile(asset.absolutePath);
});

app.get("/default-avatar.svg", (_req, res) => {
  res.set("Cache-Control", "private, no-cache, max-age=0, must-revalidate");
  return sendDefaultSiteAvatar(res);
});

app.get("/banners/:discordId", (req, res) => {
  const discordId = String(req.params.discordId || "").trim();
  const row =
    db
      .prepare(
        `
        SELECT
          custom_banner_path,
          custom_banner_mime
        FROM users
        WHERE discord_id=?
      `,
      )
      .get(discordId) || null;

  const asset = resolvePersistedSiteBanner(row);
  if (!asset) {
    return res.status(404).type("text/plain").send("Banner not found.");
  }

  res.set("Cache-Control", "private, no-cache, max-age=0, must-revalidate");
  res.type(asset.mime);
  res.sendFile(asset.absolutePath);
});

app.get("/group-avatars/:groupKey", (req, res) => {
  const groupKey = String(req.params.groupKey || "").trim();
  const row =
    db
      .prepare(
        `
        SELECT
          custom_avatar_path,
          custom_avatar_mime
        FROM community_groups
        WHERE group_key=?
      `,
      )
      .get(groupKey) || null;

  res.set("Cache-Control", "private, no-cache, max-age=0, must-revalidate");
  const asset = resolvePersistedSiteAvatar(row);
  if (!asset) {
    return sendDefaultSiteAvatar(res);
  }

  res.type(asset.mime);
  return res.sendFile(asset.absolutePath);
});

app.get("/group-banners/:groupKey", (req, res) => {
  const groupKey = String(req.params.groupKey || "").trim();
  const row =
    db
      .prepare(
        `
        SELECT
          custom_banner_path,
          custom_banner_mime
        FROM community_groups
        WHERE group_key=?
      `,
      )
      .get(groupKey) || null;

  const asset = resolvePersistedSiteBanner(row);
  if (!asset) {
    return res.status(404).type("text/plain").send("Banner not found.");
  }

  res.set("Cache-Control", "private, no-cache, max-age=0, must-revalidate");
  res.type(asset.mime);
  return res.sendFile(asset.absolutePath);
});

app.get("/backgrounds/:discordId", (req, res) => {
  const discordId = String(req.params.discordId || "").trim();
  const row =
    db
      .prepare(
        `
        SELECT
          custom_background_path,
          custom_background_mime
        FROM users
        WHERE discord_id=?
      `,
      )
      .get(discordId) || null;

  const asset = resolvePersistedSiteBackground(row);
  if (!asset) {
    return res.status(404).type("text/plain").send("Background not found.");
  }

  res.set("Cache-Control", "private, no-cache, max-age=0, must-revalidate");
  res.type(asset.mime);
  res.sendFile(asset.absolutePath);
});

const api = express.Router();

api.use(
  express.json({
    limit: "32kb",
    type: ["application/json", "application/*+json"],
  }),
);

api.use(requireApiKey);
api.use(enforceDailyQuota);

app.use("/api/v1", api);

function requireNotBanned(req, res, next) {
  const u = req.user || req.viewUser;
  if (!u?.discord_id) return next();

  const banned = getBanRecord(u.discord_id);
  if (!banned) return next();

  return res.status(403).type("html").send(`
    <h1>Access denied</h1>
    <p>Your account is banned.</p>
    ${banned.reason ? `<p>Reason: ${escapeHtml(banned.reason)}</p>` : ""}
  `);
}

function denyIfDisabled(req, res, ownerId, cmd) {
  const actorUserId =
    req.actorUser?.discord_id ||
    req.api?.user_id ||
    req.user?.discord_id ||
    req.viewUser?.discord_id ||
    null;
  const effectiveUserId =
    req.user?.discord_id ||
    req.viewUser?.discord_id ||
    null;
  const selfPreviewMode =
    effectiveUserId && String(effectiveUserId || "").trim() === String(ownerId || "").trim()
      ? normalizeSelfPreviewMode(req.body?.preview_mode)
      : null;
  if (
    isCommandEnabledForOwner(ownerId, cmd, actorUserId, {
      selfPreviewMode,
    })
  ) {
    return false;
  }

  const msg = "That command is disabled for this user right now.";
  if (wantsJson(req)) {
    res.status(403).json({ ok: false, reason: "command_disabled", cmd, message: msg });
  } else {
    res.status(403).type("html").send(
      `${msg} <a href="/device/${encodeURIComponent(req.params.pairCode)}">Back</a>`
    );
  }
  return true;
}

app.use((err, req, res, next) => {
  if (err && err.type === "entity.parse.failed") {
    return res.status(400).json({ ok: false, reason: "bad_json" });
  }
  if (err && err.type === "entity.too.large") {
    return res.status(413).json({
      ok: false,
      message:
        req.path === "/api/uploads"
          ? "Upload payload is too large."
          : "Request payload is too large.",
    });
  }
  next(err);
});

app.get("/", requireNotBanned, (req, res) => {
  const dailyLeaders = listTopCommandSendersForUtcDay(HOME_LEADERBOARD_LIMIT);
  const memberId = String(req.viewUser?.discord_id || "").trim();
  const memberPairCode = memberId
    ? String(
        db.prepare("SELECT code_plain FROM pair_codes WHERE user_id=?").get(memberId)
          ?.code_plain || "",
      ).trim()
    : "";

  renderWithLayout(res, memberId ? "pages/home_member" : "pages/home_visitor", {
    title: "PlayCtrl.me",
    extraStylesheets: ["/css/home_preview.css"],
    onlineUserCount: getOnlineUserCount(),
    topSendersToday: dailyLeaders.items,
    topSendersAllTime: listTopCommandSendersAllTime(HOME_LEADERBOARD_LIMIT),
    leaderboardUtcDate: dailyLeaders.isoDate,
    memberControlPath: memberPairCode
      ? `/device/${encodeURIComponent(memberPairCode)}`
      : "/profile",
  });
});

app.get("/preview/home-visitor", requireNotBanned, (req, res) => {
  const dailyLeaders = listTopCommandSendersForUtcDay(HOME_LEADERBOARD_LIMIT);

  renderWithLayout(res, "pages/home_visitor", {
    title: "Visitor Homepage Preview · PlayCtrl.me",
    extraStylesheets: ["/css/home_preview.css"],
    onlineUserCount: getOnlineUserCount(),
    topSendersToday: dailyLeaders.items,
    topSendersAllTime: listTopCommandSendersAllTime(HOME_LEADERBOARD_LIMIT),
    leaderboardUtcDate: dailyLeaders.isoDate,
    meta: {
      robots: NOINDEX_ROBOTS_VALUE,
    },
  });
});

app.get("/preview/home-member", requireNotBanned, (req, res) => {
  const dailyLeaders = listTopCommandSendersForUtcDay(HOME_LEADERBOARD_LIMIT);
  const memberId = String(req.viewUser?.discord_id || "").trim();
  const memberPairCode = memberId
    ? String(
        db.prepare("SELECT code_plain FROM pair_codes WHERE user_id=?").get(memberId)
          ?.code_plain || "",
      ).trim()
    : "";

  renderWithLayout(res, "pages/home_member", {
    title: "Member Homepage Preview · PlayCtrl.me",
    extraStylesheets: ["/css/home_preview.css"],
    onlineUserCount: getOnlineUserCount(),
    topSendersToday: dailyLeaders.items,
    topSendersAllTime: listTopCommandSendersAllTime(HOME_LEADERBOARD_LIMIT),
    leaderboardUtcDate: dailyLeaders.isoDate,
    memberControlPath: memberPairCode
      ? `/device/${encodeURIComponent(memberPairCode)}`
      : "/profile",
    meta: {
      robots: NOINDEX_ROBOTS_VALUE,
    },
  });
});

app.get("/terms", requireNotBanned, (req, res) => {
  renderWithLayout(res, "pages/terms", {
    title: "Terms of Service",
  });
});

app.get("/privacy", requireNotBanned, (req, res) => {
  renderWithLayout(res, "pages/privacy", {
    title: "Privacy · PlayCtrl.me",
  });
});

app.post("/logout", (req, res) => {
  const sid = req.cookies?.sid;
  if (sid) {
    db.prepare("DELETE FROM sessions WHERE session_id=?").run(sid);
  }
  res.clearCookie("sid");
  res.clearCookie("delegated_sub_id", { path: "/" });
  res.redirect("/");
});

app.use(
  "/upd",
  express.static(path.join(__dirname, "../playctrl-updates"), {
    index: false,
    cacheControl: false,
  }),
);

app.use(
  "/public",
  express.static(path.join(__dirname, "../public"), {
    index: false,
    cacheControl: false,
  }),
);

function requireDeviceAuth(req, res, next) {
  try {
    const deviceId = String(req.body?.deviceId || req.query?.deviceId || "").trim();
    const deviceToken = String(req.body?.deviceToken || req.query?.deviceToken || "").trim();
    if (!deviceId || !deviceToken) {
      return res.status(401).json({ ok: false, code: "MISSING_DEVICE_AUTH" });
    }

    const row = db
      .prepare("SELECT device_token_hash FROM devices_v2 WHERE device_id=?")
      .get(deviceId);
    if (!row) return res.status(401).json({ ok: false, code: "UNKNOWN_DEVICE" });

    if (hmac(deviceToken) !== row.device_token_hash) {
      return res.status(401).json({ ok: false, code: "BAD_DEVICE_TOKEN" });
    }

    const ownerUserId = resolveOwnerUserIdByDeviceId(deviceId);
    if (!ownerUserId) {
      return res.status(401).json({ ok: false, code: "UNPAIRED_DEVICE" });
    }

    req.deviceAuth = { deviceId, ownerUserId };
    next();
  } catch (e) {
    return res.status(500).json({ ok: false, code: "SERVER_ERROR" });
  }
}

app.post("/api/client/bootstrap-prefs", requireDeviceAuth, (req, res) => {
  const ownerUserId = req.deviceAuth.ownerUserId;

  const row = db
    .prepare(`SELECT client_prefs_imported_at FROM users WHERE discord_id=?`)
    .get(ownerUserId);

  const importedAt = Number(row?.client_prefs_imported_at || 0);
  if (importedAt > 0) {
    return res.json({ ok: true, imported: true, importedAt });
  }

  const prefs = getCommandPrefsForUser(ownerUserId);
  return res.json({ ok: true, imported: false, prefs });
});

app.post("/api/client/confirm-prefs-import", requireDeviceAuth, (req, res) => {
  const ownerUserId = req.deviceAuth.ownerUserId;

  db.prepare(`UPDATE users SET client_prefs_imported_at=? WHERE discord_id=?`)
    .run(Date.now(), ownerUserId);

  return res.json({ ok: true });
});

app.get("/auth/discord", (req, res) => {
  const state = b64url(crypto.randomBytes(16));
  const nextUrl = String(req.query.next || "/").trim();
  res.cookie("oauth_state", state, {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
  });
  res.cookie("oauth_next", nextUrl, {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
  });

  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    redirect_uri: process.env.DISCORD_REDIRECT_URI,
    response_type: "code",
    scope: "identify",
    state,
  });

  res.redirect(`${DISCORD_AUTH}?${params.toString()}`);
});

app.get("/auth/discord/callback", async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state || state !== req.cookies.oauth_state)
    return res.status(400).send("Bad OAuth state");

  const tokenResp = await fetch(DISCORD_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.DISCORD_CLIENT_ID,
      client_secret: process.env.DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code: String(code),
      redirect_uri: process.env.DISCORD_REDIRECT_URI,
    }),
  });

  if (!tokenResp.ok) return res.status(500).send("Token exchange failed");
  const token = await tokenResp.json();

  const meResp = await fetch(DISCORD_ME, {
    headers: { authorization: `${token.token_type} ${token.access_token}` },
  });

  if (!meResp.ok) return res.status(500).send("Failed to fetch user");
  const me = await meResp.json();

  const existing = db
    .prepare(
      `
      SELECT discord_id, avatar, avatar_cache_path, avatar_cache_mime, avatar_cache_updated_at
      FROM users
      WHERE discord_id=?
    `,
    )
    .get(me.id);

  db.prepare(
    `
    INSERT INTO users (discord_id, username, global_name, avatar, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(discord_id) DO UPDATE SET
      username=excluded.username,
      global_name=excluded.global_name,
      avatar=excluded.avatar,
      updated_at=excluded.updated_at
  `,
  ).run(me.id, me.username, me.global_name, me.avatar, Date.now(), Date.now());

  try {
    await refreshCachedDiscordAvatar(me, existing || null);
  } catch (e) {
    console.warn(
      `[avatar-cache] could not refresh avatar for ${me.id}: ${e?.message || e}`,
    );
  }

  logEvent({
    type: existing ? "user_updated" : "user_created",
    actorUserId: me.id,
    targetUserId: me.id,
    req,
    payload: { username: me.username, global_name: me.global_name },
  });

  const sessionId = crypto.randomUUID();

  db.prepare(
    `
    INSERT INTO sessions (session_id, discord_id, created_at)
    VALUES (?, ?, ?)
  `,
  ).run(sessionId, me.id, Date.now());

  res.cookie("sid", sessionId, {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    maxAge: 1000 * 60 * 60 * 24 * 15,
    path: "/",
  });

  const discordId = String(me.id);

  const ageDays = discordAccountAgeDays(discordId);
  if (ageDays !== null && ageDays < 15) {
    banDiscordIdSystem(discordId, req, { rule: "discord_age_lt_15d", ageDays });

    return res.status(403).type("html").send("Access denied.");
  }

  console.log(
    "ID: " +
      me.id +
      " Username: " +
      me.username +
      " Global Name: " +
      me.global_name +
      " Avatar: " +
      me.avatar,
  );

  const nextUrl = req.cookies.oauth_next || "/";
  res.clearCookie("oauth_next");
  res.redirect(nextUrl);
});

const pairAttemptBuckets = new Map();
const PAIR_ATTEMPT_WINDOW_MS = 5 * 60 * 1000;
const PAIR_ATTEMPT_LIMIT = 20;

function consumePairAttempt(req) {
  const key = String(req.ip || req.socket?.remoteAddress || "unknown");
  const now = Date.now();
  const current = pairAttemptBuckets.get(key);
  const bucket =
    !current || now - Number(current.startedAt || 0) >= PAIR_ATTEMPT_WINDOW_MS
      ? { startedAt: now, count: 0 }
      : current;
  bucket.count += 1;
  pairAttemptBuckets.set(key, bucket);
  return {
    allowed: bucket.count <= PAIR_ATTEMPT_LIMIT,
    retryAfterMs: Math.max(1000, PAIR_ATTEMPT_WINDOW_MS - (now - bucket.startedAt)),
  };
}

app.options("/api/pair", cors());

app.post("/api/pair", (req, res) => {
  try {
    const pairAttempt = consumePairAttempt(req);
    if (!pairAttempt.allowed) {
      res.set("Retry-After", String(Math.ceil(pairAttempt.retryAfterMs / 1000)));
      return res.status(429).json({
        ok: false,
        reason: "too_many_attempts",
        retryAfterMs: pairAttempt.retryAfterMs,
      });
    }
    const pairCode = String(req.body?.pairCode || "").trim();
    const deviceId = String(req.body?.deviceId || "").trim();
    const clientSecret = String(req.body?.clientSecret || "").trim();
    const deviceName = String(req.body?.deviceName || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);

    if (!/^\d{6}$/.test(pairCode) || !deviceId) {
      return res.status(400).json({ ok: false, reason: "bad_request" });
    }

    const ownerUserId = resolveOwnerUserIdByPairCode(pairCode);

    if (!ownerUserId) {
      return res.status(404).json({ ok: false, reason: "invalid_code" });
    }

    const credentialMeta = clientPairingCredentials.getCredentialMeta(ownerUserId);
    const secretCheck = clientSecret
      ? clientPairingCredentials.verifySecret(ownerUserId, clientSecret)
      : { ok: false, row: clientPairingCredentials.getCredential(ownerUserId) };

    if (clientSecret && !secretCheck.ok) {
      return res.status(403).json({
        ok: false,
        reason: "invalid_client_secret",
        message: "The client secret is invalid.",
      });
    }
    if (credentialMeta.required && !secretCheck.ok) {
      return res.status(403).json({
        ok: false,
        reason: "client_secret_required",
        message: "This account requires a client secret.",
      });
    }

    const token = crypto.randomBytes(24).toString("base64url");
    const now = Date.now();
    const isVerified = !!secretCheck.ok;
    const isActivatingProtection = isVerified && !credentialMeta.required;
    let revokedDeviceIds = [];

    const pairTx = db.transaction(() => {
      if (isActivatingProtection) {
        revokedDeviceIds = db
          .prepare(`SELECT device_id FROM device_pairs WHERE user_id=?`)
          .all(ownerUserId)
          .map((row) => String(row.device_id || "").trim())
          .filter(Boolean);
        db.prepare(`DELETE FROM device_pairs WHERE user_id=?`).run(ownerUserId);
        db.prepare(
          `UPDATE client_pairing_credentials
           SET secret_required=1, activated_at=?, updated_at=?
           WHERE user_id=?`,
        ).run(now, now, ownerUserId);
      }

      db.prepare(
        `
        INSERT INTO devices_v2 (device_id, device_token_hash, created_at, last_seen_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(device_id) DO UPDATE SET
          device_token_hash=excluded.device_token_hash,
          last_seen_at=excluded.last_seen_at
      `,
      ).run(deviceId, hmac(token), now, now);

      db.prepare(
        `
        INSERT INTO device_pairs (
          device_id, user_id, paired_at, auth_level, secret_version,
          verified_at, device_name
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(device_id) DO UPDATE SET
          user_id=excluded.user_id,
          paired_at=excluded.paired_at,
          auth_level=excluded.auth_level,
          secret_version=excluded.secret_version,
          verified_at=excluded.verified_at,
          device_name=excluded.device_name
      `,
      ).run(
        deviceId,
        ownerUserId,
        now,
        isVerified ? "verified" : "legacy",
        isVerified ? Number(secretCheck.row?.secret_version || 1) : null,
        isVerified ? now : null,
        deviceName || null,
      );
    });
    pairTx();

    if (isActivatingProtection) {
      for (const revokedDeviceId of revokedDeviceIds) {
        const ws = wsByDeviceId.get(revokedDeviceId);
        if (ws && ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(JSON.stringify({
              type: "unauthorized",
              reason: "client_secret_activated",
            }));
          } catch {}
          try {
            ws.close(1008, "client_secret_activated");
          } catch {}
        }
        wsByDeviceId.delete(revokedDeviceId);
      }
    }

    logEvent({
      type: "device_paired",
      actorUserId: ownerUserId,
      targetUserId: ownerUserId,
      deviceId,
      req,
      payload: {
        authLevel: isVerified ? "verified" : "legacy",
        protectionActivated: isActivatingProtection,
        revokedDeviceCount: revokedDeviceIds.length,
      },
    });

    return res.json({
      ok: true,
      deviceToken: token,
      userId: ownerUserId,
      authLevel: isVerified ? "verified" : "legacy",
      scopes: isVerified ? ["commands", "command_history"] : ["commands"],
      commandHistoryAccess: isVerified,
      commandHistoryEndpoint: isVerified
        ? "/api/client/v1/command-history"
        : null,
      clientSecretRequired: credentialMeta.required || isActivatingProtection,
      revokedLegacyDeviceCount: revokedDeviceIds.length,
    });
  } catch (e) {
    console.error("[/api/pair] ERROR", e);
    return res.status(500).json({ ok: false, reason: "server_error" });
  }
});

app.get("/invite", requireDiscord, (req, res) => {
  if (req.user.invited_at || isAdmin(req.user.discord_id))
    return res.redirect("/profile");

  res.type("html").send(
    layout({
      title: "Invite Required",
      user: req.viewUser,
      isAdmin: req.viewIsAdmin,
      body: `
      <h1>Invite only</h1>
      <p>This site is currently invite-only. Enter an invite code to continue.</p>

      <form method="POST" action="/invite/redeem" style="margin-top:14px;display:flex;gap:10px;align-items:center;">
        <input name="code" placeholder="Invite code" style="width:320px;padding:10px;" autocomplete="off" />
        <button type="submit">Unlock</button>
      </form>

      <p style="opacity:.7;margin-top:10px;">
        Invite codes are one-time use.
      </p>
    `,
    }),
  );
});

app.post("/invite/redeem", requireDiscord, (req, res) => {
  if (req.user.invited_at || isAdmin(req.user.discord_id))
    return res.redirect("/profile");

  const code = String(req.body?.code || "")
    .trim()
    .toUpperCase();
  if (!code || code.length < 6 || code.length > 32) {
    return res
      .status(400)
      .type("html")
      .send(
        layout({
          title: "Invite Required",
          user: req.viewUser,
          isAdmin: req.viewIsAdmin,
          body: `<p>Invalid invite code format.</p><p><a href="/invite">Back</a></p>`,
        }),
      );
  }

  const codeHash = inviteHash(code);

  const inv = db
    .prepare(
      `
    SELECT code_hash, used_at
    FROM invite_codes
    WHERE code_hash = ?
  `,
    )
    .get(codeHash);

  if (!inv || inv.used_at) {
    return res
      .status(403)
      .type("html")
      .send(
        layout({
          title: "Invite Required",
          user: req.viewUser,
          isAdmin: req.viewIsAdmin,
          body: `<p>That invite code is invalid or already used.</p><p><a href="/invite">Try again</a></p>`,
        }),
      );
  }

  const now = Date.now();

  const tx = db.transaction(() => {
    const spent = db
      .prepare(
        `
      UPDATE invite_codes
      SET used_at = ?, used_by = ?
      WHERE code_hash = ? AND used_at IS NULL
    `,
      )
      .run(now, req.user.discord_id, codeHash);

    if (spent.changes !== 1) throw new Error("invite_race_lost");

    db.prepare(
      `
      UPDATE users
      SET invited_at = COALESCE(invited_at, ?)
      WHERE discord_id = ?
    `,
    ).run(now, req.user.discord_id);
  });

  try {
    tx();

    logEvent({
      type: "invite_redeemed",
      actorUserId: req.user.discord_id,
      targetUserId: req.user.discord_id,
      req,
      payload: {},
    });

    return res.redirect("/profile");
  } catch (e) {
    console.error("invite redeem failed:", e);
    return res
      .status(500)
      .type("html")
      .send(
        layout({
          title: "Invite Required",
          user: req.viewUser,
          isAdmin: req.viewIsAdmin,
          body: `<p>Something went wrong redeeming that invite code. Try again.</p><p><a href="/invite">Back</a></p>`,
        }),
      );
  }
});

app.get("/api-docs", (req, res) => {
  const host = `${req.protocol}://${req.get("host")}`;
  const base = `${host}/api/v1`;

  res.locals.base = base;

  renderWithLayout(res, "pages/api_docs", {
    title: "API Docs",
  });
});

app.get("/notifications", requireDiscord, requireNotBanned, (req, res) => {
  const userId = String(req.user.discord_id || "").trim();

  markAllNotificationsReadForUser(userId);

  const totalCount = countNotificationsForUser(userId);
  const items = listNotificationsForUser(userId, {
    limit: NOTIFICATION_PAGE_LIMIT,
  });

  res.locals.notificationPageItems = items;
  res.locals.notificationPageCount = totalCount;
  res.locals.notificationPageTruncated = totalCount > items.length;
  res.locals.notificationMenuItems = items.slice(0, NOTIFICATION_MENU_LIMIT);
  res.locals.notificationUnreadCount = 0;
  res.locals.notificationTotalCount = totalCount;

  renderWithLayout(res, "pages/notifications/noti_main", {
    title: "Notifications",
    layoutBodyClass: "page-notifications",
  });
});

app.get(
  "/notifications/summary",
  requireDiscord,
  requireNotBanned,
  (req, res) => {
    const userId = String(req.user?.discord_id || "").trim();
    const summary = getNotificationSummaryForUser(userId, {
      limit: NOTIFICATION_MENU_LIMIT,
    });

    return res.json({
      ok: true,
      items: summary.items,
      unreadCount: summary.unreadCount,
      totalCount: summary.totalCount,
    });
  },
);

app.post("/notifications/mark-read", requireDiscord, requireNotBanned, (req, res) => {
  const userId = String(req.user.discord_id || "").trim();
  const changed = markAllNotificationsReadForUser(userId);
  const totalCount = countNotificationsForUser(userId);

  if (!wantsJson(req)) {
    return res.redirect("/notifications");
  }

  return res.json({
    ok: true,
    changed,
    unreadCount: 0,
    totalCount,
  });
});

app.post("/notifications/clear-all", requireDiscord, requireNotBanned, (req, res) => {
  const userId = String(req.user.discord_id || "").trim();
  const clearedCount = clearAllNotificationsForUser(userId);

  if (!wantsJson(req)) {
    return res.redirect("/notifications");
  }

  return res.json({
    ok: true,
    clearedCount,
    unreadCount: 0,
    totalCount: 0,
  });
});

app.post(
  "/notifications/:id/clear",
  requireDiscord,
  requireNotBanned,
  (req, res) => {
    const userId = String(req.user.discord_id || "").trim();
    const notificationId = String(req.params.id || "").trim();
    const cleared = clearNotificationForUser(userId, notificationId);

    if (!cleared) {
      if (!wantsJson(req)) {
        return res.redirect("/notifications");
      }
      return res.status(404).json({
        ok: false,
        message: "Notification not found.",
      });
    }

    const unreadCount = countUnreadNotificationsForUser(userId);
    const totalCount = countNotificationsForUser(userId);

    if (!wantsJson(req)) {
      return res.redirect("/notifications");
    }

    return res.json({
      ok: true,
      id: notificationId,
      unreadCount,
      totalCount,
    });
  },
);

api.get("/favorites", (req, res) => {
  const me = req.api.user_id;

  const rows = db
    .prepare(
      `
      SELECT
        u.discord_id,
        u.username,
        u.global_name,
        u.avatar,
        pc.code_plain
      FROM favorites f
      JOIN users u ON u.discord_id = f.favorite_user_id
      JOIN pair_codes pc ON pc.user_id = u.discord_id
      WHERE f.user_id = ?
      ORDER BY f.created_at ASC
      LIMIT 500
    `,
    )
    .all(me);

  const presenceByUser = listPresenceStateByUserIds(
    rows.map((row) => row.discord_id),
  );

  const users = rows.map((u) => {
    const displayName = u.global_name || u.username || u.discord_id;
    const avatarUrl = discordAvatarUrl(u, 128);
    const presence = presenceByUser.get(u.discord_id) || computePresenceState();

    return {
      displayName,
      username: u.username || null,
      discordId: u.discord_id,
      pairCode: u.code_plain,
      avatarUrl,
      online: !!presence.online,
      status: presence.status,
      away: !!presence.away,
      awayUntil: Number(presence.awayUntil || 0),
    };
  });

  res.json({ ok: true, users });
});

function resolveDevicesForPairCode(pairCode) {
  const userId = resolveOwnerUserIdByPairCode(pairCode);
  if (!userId) return { ok: false, reason: "invalid_code" };

  const devices = db
    .prepare(
      `
    SELECT device_id FROM device_pairs WHERE user_id=?
  `,
    )
    .all(userId);

  return {
    ok: true,
    userId,
    deviceIds: devices.map((r) => r.device_id),
  };
}

function unpairAllDevicesForUser(userId) {
  const deviceRows = db
    .prepare(
      `
    SELECT device_id FROM device_pairs WHERE user_id=?
  `,
    )
    .all(userId);

  const deviceIds = deviceRows.map((r) => r.device_id);

  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM device_pairs WHERE user_id=?`).run(userId);

    const invalidate = db.prepare(
      `UPDATE devices_v2 SET device_token_hash=? WHERE device_id=?`,
    );
    for (const deviceId of deviceIds) {
      invalidate.run(
        hmac(crypto.randomBytes(24).toString("base64url")),
        deviceId,
      );
    }
  });

  tx();
  return deviceIds;
}

app.get("/api/presence/discover", (req, res) => {
  const now = Date.now();
  const statuses = [];
  if (String(req.query.online ?? "1").trim() !== "0") statuses.push("online");
  if (String(req.query.away ?? "1").trim() !== "0") statuses.push("away");
  const pageData = listPagedDiscoverUsers({
    now,
    page: req.query.page,
    perPage: req.query.perPage,
    query: req.query.q,
    statuses,
  });

  res.json({
    ok: true,
    users: pageData.users.map((user) => ({
      displayName: user.displayName,
      username: user.username || null,
      discordId: user.discordId,
      pairCode: user.pairCode,
      avatarUrl: user.avatarUrl,
      bannerUrl: user.bannerUrl,
      status: user.status,
      online: !!user.online,
      away: !!user.away,
      awayUntil: Number(user.awayUntil || 0),
    })),
    total: pageData.total,
    totalPages: pageData.totalPages,
    page: pageData.page,
    perPage: pageData.perPage,
    ts: now,
  });
});

app.get("/api/presence/groups", requireNotBanned, (req, res) => {
  try {
    const memberRows = db.prepare(`
      SELECT group_key, COUNT(*) AS n
      FROM group_memberships
      GROUP BY group_key
    `).all();

    const memberCountByKey = new Map(memberRows.map(r => [String(r.group_key), Number(r.n || 0)]));

    const mems = db.prepare(`
      SELECT group_key, user_id
      FROM group_memberships
    `).all();

    if (!mems.length) {
      return res.json({ ok: true, map: {}, ts: Date.now() });
    }

    const userIds = Array.from(new Set(mems.map(r => String(r.user_id))));

    const placeholders = userIds.map(() => "?").join(",");
    const pairs = db.prepare(`
      SELECT user_id, device_id
      FROM device_pairs
      WHERE user_id IN (${placeholders})
    `).all(...userIds);

    const deviceIdsByUser = new Map();
    for (const p of pairs) {
      const uid = String(p.user_id);
      if (!deviceIdsByUser.has(uid)) deviceIdsByUser.set(uid, []);
      deviceIdsByUser.get(uid).push(String(p.device_id));
    }

    const onlineByUser = new Map();
    for (const uid of userIds) {
      const devs = deviceIdsByUser.get(uid) || [];
      onlineByUser.set(uid, devs.some(did => isDeviceOnline(did)));
    }

    const onlineCountByKey = new Map();
    for (const row of mems) {
      const gk = String(row.group_key);
      const uid = String(row.user_id);
      if (!onlineByUser.get(uid)) continue;
      onlineCountByKey.set(gk, (onlineCountByKey.get(gk) || 0) + 1);
    }

    const out = {};
    for (const [gk, members] of memberCountByKey.entries()) {
      out[gk] = {
        members,
        online: Number(onlineCountByKey.get(gk) || 0),
      };
    }

    const groupsByKey = loadGroupsCatalog();
    for (const gk of groupsByKey.keys()) {
      if (!out[gk]) out[gk] = { members: 0, online: 0 };
    }

    res.json({ ok: true, map: out, ts: Date.now() });
  } catch (e) {
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.get("/api/presence/favorites", (req, res) => {
  if (!req.viewUser)
    return res.status(401).json({ ok: false, error: "not_logged_in" });

  const me = req.viewUser.discord_id;

  const rows = db
    .prepare(
      `
    SELECT u.discord_id, pc.code_plain
    FROM favorites f
    JOIN users u ON u.discord_id = f.favorite_user_id
    JOIN pair_codes pc ON pc.user_id = u.discord_id
    WHERE f.user_id = ?
    ORDER BY f.created_at ASC
    LIMIT 500
  `,
    )
    .all(me);

  if (!rows.length) return res.json({ ok: true, map: {}, ts: Date.now() });

  const presenceByUser = listPresenceStateByUserIds(
    rows.map((row) => row.discord_id),
  );

  const map = {};
  for (const r of rows) {
    const presence = presenceByUser.get(r.discord_id) || computePresenceState();
    map[String(r.code_plain)] = {
      status: presence.status,
      online: !!presence.online,
      away: !!presence.away,
      awayUntil: Number(presence.awayUntil || 0),
    };
  }

  res.json({ ok: true, map, ts: Date.now() });
});

app.get("/api/presence/:pairCode", (req, res) => {
  const pairCode = String(req.params.pairCode || "").trim();
  if (!/^\d{6}$/.test(pairCode))
    return res.status(400).json({ ok: false, message: "bad_pair_code" });

  const resolved = resolveOwnerAndDevicesByPairCode(pairCode);
  if (!resolved)
    return res.status(404).json({ ok: false, message: "unknown_code" });

  const presence = getUserPresenceState(resolved.ownerUserId, {
    deviceIds: resolved.deviceIds || [],
  });

  return res.json({
    ok: true,
    pairCode,
    ownerUserId: resolved.ownerUserId,
    status: presence.status,
    online: !!presence.online,
    away: !!presence.away,
    awayUntil: Number(presence.awayUntil || 0),
    onlineCount: Number(presence.onlineCount || 0),
    deviceCount: Number(presence.deviceCount || 0),
    ts: Date.now(),
  });
});

function apiFail(res, httpStatus, code, extra = {}) {
  return res.status(httpStatus).json({ ok: false, code, ...extra });
}

api.post("/commands", async (req, res) => {
  const body = req.body || {};
  const actorId = req.api.user_id;
  const SUBLIMINAL_MESSAGE_MAX_COUNT = 20;
  const SUBLIMINAL_MESSAGE_MAX_LENGTH = 2000;

  function validateSubliminalMessages(rawValue) {
    const rawList = Array.isArray(rawValue)
      ? rawValue
      : rawValue == null
        ? []
        : [rawValue];
    const messages = [];

    for (const item of rawList) {
      const message = String(item ?? "").trim();
      if (!message) continue;

      messages.push(message.slice(0, SUBLIMINAL_MESSAGE_MAX_LENGTH));
      if (messages.length > SUBLIMINAL_MESSAGE_MAX_COUNT) {
        return {
          ok: false,
          message: `You can send up to ${SUBLIMINAL_MESSAGE_MAX_COUNT} messages at once`,
        };
      }
    }

    if (!messages.length) {
      return { ok: false, message: "Required parameter missing: messages" };
    }

    return { ok: true, value: messages };
  }

  const pairCode = String(body.pairCode || "").trim();
  if (!pairCode) {
    return apiFail(res, 400, "INVALID_PAIRCODE", {
      message: "pairCode is either missing or invalid",
    });
  }

  const resolved = resolveOwnerAndDevicesByPairCode(pairCode);
  if (!resolved) {
    return apiFail(res, 400, "INVALID_PAIRCODE", {
      message: "pairCode is either missing or invalid",
    });
  }

  const ownerId = resolved.ownerUserId;
  const deviceIds = resolved.deviceIds || [];

  if (!isAllowedByWhitelist(ownerId, actorId)) {
    return apiFail(res, 403, "NOT_WHITELISTED");
  }
  if (denyIfBlockedCommandSender(res, ownerId, actorId, { json: true })) {
    return;
  }

  const type = String(body.command || "").trim();
  const normalizedType = type;
  const allowed = new Set(["popup", "subliminal_message", "open_url", "image_popup", "fullscreen_popup", "spiral_overlay", "set_wallpaper", "screenshot", "webcam_capture", "play_sound", "write_for_me"]);
  if (!allowed.has(type)) {
    return apiFail(res, 400, "BAD_REQUEST", { message: "Unknown command type." });
  }

  const paramsObj = body.parameters || {};
  const params = new Set(Object.keys(paramsObj));

  switch (normalizedType) {
    case "popup": {
      const msg = String(paramsObj.message || "").trim();
      if (!msg) {
        return apiFail(res, 400, "MISSING_PARAMETER", {
          message: "Required parameter missing: message",
        });
      }
      break;
    }

    case "subliminal_message": {
      const messagesCheck = validateSubliminalMessages(paramsObj.messages);
      if (!messagesCheck.ok) {
        return apiFail(res, 400, "BAD_REQUEST", {
          message: messagesCheck.message,
        });
      }
      break;
    }

    case "open_url":
    case "image_popup":
    case "fullscreen_popup":
    case "spiral_overlay":
    case "set_wallpaper": {
      const url = String(paramsObj.url || "").trim();
      if (!url) {
        return apiFail(res, 400, "MISSING_PARAMETER", {
          message: "Required parameter missing: url",
        });
      }
      if (!/^https?:\/\//i.test(url)) {
        return apiFail(res, 400, "BAD_URL", { message: "Url must start with http(s)" });
      }

      const policy = enforceManagedUrlPolicy({ db, logEvent }, req, res, url);
      if (!policy.ok) return;

      if (type === "spiral_overlay") {
        let spiralHost = "";
        try {
          spiralHost = String(new URL(url).hostname || "").trim().toLowerCase();
        } catch {}
        if (spiralHost !== "swirl.3bu.dev") {
          return apiFail(res, 400, "BAD_URL", {
            message: "Spiral overlay URLs must use swirl.3bu.dev",
          });
        }
      }

      if (type === "set_wallpaper") {
        const allowWallpaperMedia = ownerHasReportedCapabilityForActor(
          ownerId,
          actorId,
          "set_wallpaper_media",
        );
        if (!isAllowedWallpaperExt(url, { allowMedia: allowWallpaperMedia })) {
          return apiFail(res, 400, "BAD_REQUEST", { message: "Invalid file type" });
        }
      }
      break;
    }
    case "play_sound": {
      const kind = String(paramsObj.kind || "builtin").trim();
      if (kind !== "builtin" && kind !== "url") {
        return apiFail(res, 400, "BAD_REQUEST", { message: "kind must be builtin or url" });
      }

      if (kind === "builtin") {
        const name = String(paramsObj.name || "").trim();
        if (!name) {
          return apiFail(res, 400, "MISSING_PARAMETER", { message: "Required parameter missing: name" });
        }
        if (name.includes("..") || name.includes("/") || name.includes("\\")) {
          return apiFail(res, 400, "BAD_REQUEST", { message: "Invalid sound name" });
        }
      }

      if (kind === "url") {
        const url = String(paramsObj.url || "").trim();
        if (!url) {
          return apiFail(res, 400, "MISSING_PARAMETER", { message: "Required parameter missing: url" });
        }
        if (!isHttpUrl(url)) {
          return apiFail(res, 400, "BAD_URL", { message: "Url must start with http(s)" });
        }

        const policy = enforceManagedUrlPolicy({ db, logEvent }, req, res, url);
        if (!policy.ok) return;
      }

      break;
    }
  }

  let commandPayload = { type: normalizedType, ...(paramsObj || {}) };
  if (normalizedType === "subliminal_message") {
    commandPayload = {
      type: normalizedType,
      messages: validateSubliminalMessages(paramsObj.messages).value,
    };
  }
  if (normalizedType === "image_popup" || normalizedType === "fullscreen_popup") {
    const popupResolution = await resolvePopupMediaUrl({
      commandType: normalizedType,
      url: String(paramsObj.url || "").trim(),
      actorUserId: actorId,
      targetUserId: ownerId,
      req,
    });

    if (popupResolution?.changed) {
      commandPayload = {
        type: normalizedType,
        ...(paramsObj || {}),
        url: String(popupResolution.resolvedUrl || "").trim(),
        originalUrl: String(popupResolution.originalUrl || "").trim(),
        resolvedUrl: String(popupResolution.resolvedUrl || "").trim(),
        mediaUrlResolvedBy: String(popupResolution.resolverKey || "").trim(),
        resolvedUrlHost: String(
          popupResolution.resolvedUrlHost || "",
        ).trim(),
      };
    }
  }

  const commandId = crypto.randomUUID();

  logEvent({
    type: "api_command_" + normalizedType,
    actorUserId: actorId,
    targetUserId: ownerId,
    pairCode,
    req,
    payload: {
      commandId,
      command: normalizedType,
      parameters: paramsObj,
      deviceCount: deviceIds.length,
    },
  });

  const result = await sendCommandToResolvedTarget({
    resolved,
    requestId: commandId,
    actorUserId: actorId,
    commandPayload,
    timeoutMs: 20000,
    sourceKind: "api",
    sourceId: pairCode,
    req,
  });

  if (!result.ok) {
    return apiFail(res, 409, result.code || "DEVICE_OFFLINE", {
      message: result.error || "No devices online",
    });
  }

  const anyFail = Array.isArray(result.acks)
    ? result.acks.some((a) => !a?.ok)
    : false;

  if (result.delivery === "queued" || !anyFail) {
    incrementCommandsSentTotal({
      senderDiscordId: actorId,
      targetOwnerDiscordId: ownerId,
    });
  }

  return res.json({
    ok: result.delivery === "queued" ? true : !anyFail,
    delivery: result.delivery,
    message:
      result.delivery === "queued"
        ? "Command queued"
        : anyFail
          ? "Some devices rejected or failed."
          : "Sent to device",
    sent: result.sent,
    queued: Number(result.queuedCount || 0),
    acks: result.acks,
  });
});

const uploadsJanitorTimer = setInterval(
  runUploadsJanitorOnce,
  UPLOAD_JANITOR_EVERY_MS,
);
uploadsJanitorTimer.unref?.();
runUploadsJanitorOnce();

app.use(
  "/uploads",
  express.static(UPLOADS_DIR, {
    fallthrough: false,
    maxAge: "1h",
    setHeaders(res) {
      res.set("X-Content-Type-Options", "nosniff");
    },
  }),
);

app.use("/responses", express.static(RESPONSES_DIR, {
  fallthrough: false,
  maxAge: "1h",
}));

app.get("/api/uploads", requireDiscord, requireNotBanned, (req, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");

  const context = String(req.query?.context || "").trim();
  if (!UPLOAD_CONTEXT_UI[context]) {
    return res.status(400).json({ ok: false, message: "Invalid upload context." });
  }

  const items = listRecentUploadedFilesForUser(
    req,
    req.user.discord_id,
    context,
    UPLOAD_RECENT_LIST_LIMIT,
  );

  return res.json({
    ok: true,
    context,
    limits: UPLOAD_CONTEXT_UI[context],
    items,
  });
});

app.post("/api/uploads", requireDiscord, requireNotBanned, (req, res) => {
  const context = String(req.body?.context || "").trim();
  const filename = String(req.body?.filename || "").trim();
  const mime = String(req.body?.mime || "").trim();
  const data = String(req.body?.data || "");

  console.log("[uploads] request", {
    userId: String(req.user?.discord_id || ""),
    context,
    filename,
    mime,
    dataLength: data.length,
  });

  if (!filename) {
    return res.status(400).json({ ok: false, message: "Missing file name." });
  }
  if (!data) {
    return res.status(400).json({ ok: false, message: "Missing file data." });
  }

  const matched = getUploadRuleForFile({ context, filename, mime });
  if (!matched.ok) {
    console.warn("[uploads] rejected before decode", {
      userId: String(req.user?.discord_id || ""),
      context,
      filename,
      mime,
      message: matched.message,
    });
    return res.status(400).json({ ok: false, message: matched.message });
  }

  let buf;
  try {
    buf = b64ToBuffer(data);
  } catch {
    console.warn("[uploads] failed to decode base64", {
      userId: String(req.user?.discord_id || ""),
      context,
      filename,
    });
    return res.status(400).json({ ok: false, message: "Could not read uploaded file." });
  }

  if (!buf || buf.length <= 0) {
    console.warn("[uploads] empty decoded buffer", {
      userId: String(req.user?.discord_id || ""),
      context,
      filename,
    });
    return res.status(400).json({ ok: false, message: "Uploaded file was empty." });
  }

  if (buf.length > matched.rule.maxBytes) {
    console.warn("[uploads] rejected for size", {
      userId: String(req.user?.discord_id || ""),
      context,
      filename,
      bytes: buf.length,
      maxBytes: matched.rule.maxBytes,
    });
    return res.status(413).json({
      ok: false,
      message: `That file is too large for ${context.replace(/_/g, " ")} (${formatBytesCompact(buf.length)} > ${formatBytesCompact(matched.rule.maxBytes)}).`,
    });
  }

  const capacity = ensureUploadCapacityForNewFile({
    userId: req.user.discord_id,
    incomingBytes: buf.length,
  });
  if (!capacity.ok) {
    console.warn("[uploads] rejected for capacity", {
      userId: String(req.user?.discord_id || ""),
      context,
      filename,
      bytes: buf.length,
      message: capacity.message,
    });
    return res.status(capacity.status || 400).json({
      ok: false,
      message: capacity.message || "Could not store upload.",
    });
  }

  const now = Date.now();
  const id = crypto.randomUUID();
  const storedName = `${now}_${crypto.randomUUID()}.${matched.ext}`;
  const filePath = path.join(UPLOADS_DIR, storedName);

  try {
    fs.writeFileSync(filePath, buf);
  } catch (e) {
    console.warn("[uploads] write failed:", e?.message || e);
    return res.status(500).json({ ok: false, message: "Could not save uploaded file." });
  }

  try {
    db.prepare(
      `
      INSERT INTO uploaded_files (
        id, user_id, original_name, stored_name, file_path, mime, ext, bytes,
        preview_kind, media_group, wallpaper_compatible, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      id,
      req.user.discord_id,
      filename.slice(0, 255),
      storedName,
      filePath,
      matched.mime,
      matched.ext,
      buf.length,
      matched.rule.previewKind,
      matched.rule.mediaGroup,
      matched.rule.wallpaperCompatible ? 1 : 0,
      now,
      now + UPLOAD_TTL_MS,
    );
  } catch (e) {
    safeUnlink(filePath, "uploads");
    console.warn("[uploads] insert failed:", e?.message || e);
    return res.status(500).json({ ok: false, message: "Could not index uploaded file." });
  }

  const row = db
    .prepare(
      `
      SELECT
        id, original_name, stored_name, file_path, mime, ext, bytes,
        preview_kind, media_group, wallpaper_compatible, created_at, expires_at
      FROM uploaded_files
      WHERE id=?
    `,
    )
    .get(id);

  return res.status(201).json({
    ok: true,
    item: serializeUploadedFileRow(req, row),
  });
});

app.get("/api/device/:pairCode/responses", requireDiscord, requireNotBanned, (req, res) => {
  const pairCode = String(req.params.pairCode || "").trim();
  if (!/^\d{6}$/.test(pairCode)) return res.status(400).json({ ok: false, code: "BAD_PAIR_CODE" });

  const resolved = resolveOwnerAndDevicesByPairCode(pairCode);
  if (!resolved) return res.status(404).json({ ok: false, code: "UNKNOWN_CODE" });

  const actorUserId = getRequestActorUserId(req);
  const hasDelegatedControl = requestHasDelegatedControlForOwner(
    req,
    resolved.ownerUserId,
  );

  if (
    !hasDelegatedControl &&
    !isAllowedByWhitelist(resolved.ownerUserId, actorUserId)
  ) {
    return res.status(403).json({ ok: false, code: "NOT_WHITELISTED" });
  }

  console.log("[responses] pairCode=", pairCode, "viewer=", actorUserId, "owner=", resolved.ownerUserId);
  console.log("[responses] resolved deviceIds=", resolved.deviceIds || resolved.devices || resolved.ownerDeviceIds);

  const deviceIds =
    (resolved.deviceIds && Array.isArray(resolved.deviceIds) ? resolved.deviceIds : null) ||
    (resolved.ownerDeviceIds && Array.isArray(resolved.ownerDeviceIds) ? resolved.ownerDeviceIds : null) ||
    (resolved.devices && Array.isArray(resolved.devices) ? resolved.devices.map(d => d.device_id || d.deviceId).filter(Boolean) : null) ||
    [];

  if (!deviceIds.length) {
    console.warn("[responses] no deviceIds resolved for pairCode", pairCode);
    return res.json({ ok: true, items: [] });
  }

  const placeholders = deviceIds.map(() => "?").join(",");
  const viewerId = actorUserId;

  const rows = db.prepare(`
    SELECT id, created_at, response_type, mime, file_path, bytes, width, height, monitors, command_id, device_id, actor_user_id
    FROM device_responses
    WHERE device_id IN (${placeholders})
    ORDER BY created_at DESC
    LIMIT 100
  `).all(...deviceIds);

  console.log("[responses] rows=", rows.length);

  const items = [];

  for (const r of rows) {
    let actorUserId = String(r.actor_user_id || "").trim();
    if (!actorUserId) {
      actorUserId = resolveActorUserIdByCommandId(r.command_id);
      if (actorUserId) {
        updateDeviceResponseActorUserId.run(actorUserId, String(r.id || ""));
      }
    }

    if (actorUserId !== viewerId) {
      continue;
    }

    const filename = path.basename(String(r.file_path || ""));
    items.push({
      id: r.id,
      created_at: r.created_at,
      response_type: r.response_type,
      mime: r.mime,
      bytes: r.bytes,
      width: r.width,
      height: r.height,
      monitors: r.monitors,
      command_id: r.command_id || null,
      device_id: r.device_id || null,
      url: filename ? `/responses/${encodeURIComponent(filename)}` : null,
    });

    if (items.length >= 50) break;
  }

  res.json({ ok: true, items });
});

app.get(
  "/api/device/:pairCode/board",
  requireDiscord,
  requireNotBanned,
  (req, res) => {
    const pairCode = String(req.params.pairCode || "").trim();
    if (!/^\d{6}$/.test(pairCode))
      return res.status(400).json({ ok: false, code: "BAD_PAIR_CODE" });

    const resolved = resolveOwnerAndDevicesByPairCode(pairCode);
    if (!resolved)
      return res.status(404).json({ ok: false, code: "UNKNOWN_CODE" });

    const actorUserId = getRequestActorUserId(req);
    const hasDelegatedControl = requestHasDelegatedControlForOwner(
      req,
      resolved.ownerUserId,
    );

    if (
      !hasDelegatedControl &&
      !isAllowedByWhitelist(resolved.ownerUserId, actorUserId)
    ) {
      return res.status(403).json({ ok: false, code: "NOT_WHITELISTED" });
    }

    const messages = getBoardMessages(resolved.ownerUserId, 10);
    const latestCreatedAt = messages.length
      ? Number(messages[0].created_at)
      : 0;

    res.json({
      ok: true,
      ownerUserId: resolved.ownerUserId,
      latest_created_at: latestCreatedAt,
      messages,
    });
  },
);

app.get(
  "/api/device/:pairCode/command-history",
  requireDiscord,
  requireNotBanned,
  (req, res) => {
    const pairCode = String(req.params.pairCode || "").trim();
    if (!/^\d{6}$/.test(pairCode)) {
      return res.status(400).json({ ok: false, code: "BAD_PAIR_CODE" });
    }

    const resolved = resolveOwnerAndDevicesByPairCode(pairCode);
    if (!resolved) {
      return res.status(404).json({ ok: false, code: "UNKNOWN_CODE" });
    }

    if (req.user.discord_id !== resolved.ownerUserId) {
      return res.status(403).json({ ok: false, code: "NOT_OWNER" });
    }

    const items = getRecentReceivedCommandHistory(resolved.ownerUserId, 15);
    return res.json({
      ok: true,
      ownerUserId: resolved.ownerUserId,
      items,
    });
  },
);

app.post(
  "/api/device/:pairCode/command-history/:eventId/like",
  requireDiscord,
  requireNotBanned,
  (req, res) => {
    const pairCode = String(req.params.pairCode || "").trim();
    const eventId = String(req.params.eventId || "").trim();

    if (!/^\d{6}$/.test(pairCode)) {
      return res.status(400).json({ ok: false, code: "BAD_PAIR_CODE" });
    }
    if (!eventId) {
      return res.status(400).json({ ok: false, message: "Missing event." });
    }

    const resolved = resolveOwnerAndDevicesByPairCode(pairCode);
    if (!resolved) {
      return res.status(404).json({ ok: false, code: "UNKNOWN_CODE" });
    }

    const ownerUserId = String(resolved.ownerUserId || "").trim();
    const viewerUserId = String(req.user?.discord_id || "").trim();
    if (!ownerUserId || viewerUserId !== ownerUserId) {
      return res.status(403).json({ ok: false, code: "NOT_OWNER" });
    }

    const historyEvent = findReceivedCommandHistoryEvent(ownerUserId, eventId);
    if (!historyEvent) {
      return res.status(404).json({
        ok: false,
        message: "Command history entry not found.",
      });
    }

    try {
      const result = createCommandHistoryLike({
        historyEvent,
        likerUserId: ownerUserId,
        req,
      });

      return res.json({
        ok: true,
        liked: true,
        alreadyLiked: !!result.alreadyLiked,
        likesTotal: Number(result.likesTotal || 0),
        message: result.alreadyLiked
          ? "You already liked that command."
          : "Command liked.",
      });
    } catch (err) {
      return res.status(400).json({
        ok: false,
        message: err?.message || "Could not like that command.",
      });
    }
  },
);

app.post(
  "/api/device/:pairCode/command-history/:eventId/block",
  requireDiscord,
  requireNotBanned,
  (req, res) => {
    const pairCode = String(req.params.pairCode || "").trim();
    const eventId = String(req.params.eventId || "").trim();

    if (!/^\d{6}$/.test(pairCode)) {
      return res.status(400).json({ ok: false, code: "BAD_PAIR_CODE" });
    }
    if (!eventId) {
      return res.status(400).json({ ok: false, message: "Missing event." });
    }

    const resolved = resolveOwnerAndDevicesByPairCode(pairCode);
    if (!resolved) {
      return res.status(404).json({ ok: false, code: "UNKNOWN_CODE" });
    }

    const ownerUserId = String(resolved.ownerUserId || "").trim();
    const viewerUserId = String(req.user?.discord_id || "").trim();
    if (!ownerUserId || viewerUserId !== ownerUserId) {
      return res.status(403).json({ ok: false, code: "NOT_OWNER" });
    }

    const historyEvent = findReceivedCommandHistoryEvent(ownerUserId, eventId);
    if (!historyEvent) {
      return res.status(404).json({
        ok: false,
        message: "Command history entry not found.",
      });
    }

    const blockedUserId = String(historyEvent.actor_user_id || "").trim();
    if (!blockedUserId || blockedUserId === ownerUserId) {
      return res.status(400).json({
        ok: false,
        message: "That sender cannot be blocked from this history entry.",
      });
    }

    try {
      createCommandSenderBlock({
        ownerUserId,
        blockedUserId,
        sourceEventId: historyEvent.id,
        req,
      });

      return res.json({
        ok: true,
        message: "Future commands from this sender will be blocked.",
      });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        message: err?.message || "Could not block that sender.",
      });
    }
  },
);

app.post(
  "/api/device/:pairCode/command-history/:eventId/report",
  requireDiscord,
  requireNotBanned,
  async (req, res) => {
    const pairCode = String(req.params.pairCode || "").trim();
    const eventId = String(req.params.eventId || "").trim();

    if (!/^\d{6}$/.test(pairCode)) {
      return res.status(400).json({ ok: false, code: "BAD_PAIR_CODE" });
    }
    if (!eventId) {
      return res.status(400).json({ ok: false, message: "Missing event." });
    }

    const resolved = resolveOwnerAndDevicesByPairCode(pairCode);
    if (!resolved) {
      return res.status(404).json({ ok: false, code: "UNKNOWN_CODE" });
    }

    const ownerUserId = String(resolved.ownerUserId || "").trim();
    const reporterUser = req.viewUser || req.user || null;
    const reporterUserId = String(reporterUser?.discord_id || "").trim();
    if (!ownerUserId || reporterUserId !== ownerUserId) {
      return res.status(403).json({ ok: false, code: "NOT_OWNER" });
    }

    const reasonKey = String(
      req.body?.reason || req.body?.reason_key || "",
    ).trim();
    const details = normalizeReportDetails(req.body?.details);
    if (!getReportReasonOption(reasonKey, COMMAND_HISTORY_REPORT_REASON_BY_KEY)) {
      return res.status(400).json({
        ok: false,
        message: "Please choose a reason for the report.",
      });
    }

    const historyEvent = findReceivedCommandHistoryEvent(ownerUserId, eventId);
    if (!historyEvent) {
      return res.status(404).json({
        ok: false,
        message: "Command history entry not found.",
      });
    }

    const subjectUserId = String(historyEvent.actor_user_id || "").trim();
    if (!subjectUserId || subjectUserId === ownerUserId) {
      return res.status(400).json({
        ok: false,
        message: "That sender cannot be reported from this history entry.",
      });
    }

    const subjectUser =
      db
        .prepare(
          `
          SELECT discord_id, username, global_name, control_link_display_name
          FROM users
          WHERE discord_id=?
        `,
        )
        .get(subjectUserId) || { discord_id: subjectUserId };

    const payload = historyEvent.payloadObj || {};
    const commandType = String(historyEvent.type || "").trim();
    const commandId = String(payload.commandId || "").trim();
    const message = String(payload.message || "").trim();
    const messages = normalizeSubliminalMessagesPayload(payload.messages);
    const url = String(payload.url || "").trim();
    const resolvedUrl = String(payload.resolvedUrl || "").trim();
    const kind = String(payload.kind || "").trim();
    const name = String(payload.name || "").trim();
    const reportMediaSourceUrl = resolvedUrl || url;

    try {
      const created = createUserReport({
        subjectUserId,
        subjectUser,
        reporterUser,
        reasonKey,
        reasonMap: COMMAND_HISTORY_REPORT_REASON_BY_KEY,
        details,
        meta: {
          source: "command_history",
          sourceEventId: historyEvent.id,
          commandType,
          commandTypeLabel:
            CONTROL_LINK_COMMAND_HISTORY_TYPES[commandType] || "Command",
          commandId: commandId || null,
          kind: kind || null,
          name: name || null,
          message: message || null,
          messages: messages.length ? messages : null,
          url: url || null,
          resolvedUrl: resolvedUrl || null,
          targetOwnerUserId: ownerUserId,
          targetPairCode: pairCode,
        },
        req,
      });

      if (reportMediaSourceUrl && getReportMediaBackupCommandKey(commandType)) {
        try {
          await captureReportMediaBackupFromCommand({
            report: created.report,
            commandType,
            sourceUrl: reportMediaSourceUrl,
            sourceName: name,
            sourceMime: "",
            req,
          });
        } catch (backupErr) {
          logEvent({
            type: "report_media_backup_failed",
            actorUserId: created.report.reporterUserId,
            targetUserId: created.report.subjectId,
            req,
            payload: {
              reportId: created.report.id,
              commandType,
              url,
              resolvedUrl: resolvedUrl || null,
              error: String(backupErr?.message || backupErr || "backup_failed"),
            },
          });
        }
      }

      return res.json({
        ok: true,
        message: "Report sent. Thank you.",
      });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        message: err?.message || "Could not send that report.",
      });
    }
  },
);

function requireVerifiedClientDevice(req, res, next) {
  const deviceId = String(req.get("X-Device-Id") || "").trim();
  const authorization = String(req.get("Authorization") || "").trim();
  const tokenMatch = authorization.match(/^Bearer\s+(.+)$/i);
  const deviceToken = String(tokenMatch?.[1] || "").trim();
  if (!deviceId || !deviceToken) {
    return res.status(401).json({
      ok: false,
      code: "DEVICE_AUTH_REQUIRED",
      message: "Device authentication is required.",
    });
  }

  const row = db
    .prepare(
      `
        SELECT
          dp.device_id,
          dp.user_id,
          dp.auth_level,
          dp.secret_version,
          d.device_token_hash,
          c.secret_required,
          c.secret_version AS current_secret_version,
          b.discord_id AS banned_user_id
        FROM device_pairs dp
        JOIN devices_v2 d ON d.device_id=dp.device_id
        LEFT JOIN client_pairing_credentials c ON c.user_id=dp.user_id
        LEFT JOIN bans b ON b.discord_id=dp.user_id
        WHERE dp.device_id=?
      `,
    )
    .get(deviceId);
  if (!row || row.banned_user_id || hmac(deviceToken) !== row.device_token_hash) {
    return res.status(401).json({
      ok: false,
      code: "INVALID_DEVICE_AUTH",
      message: "Device authentication is invalid.",
    });
  }
  if (String(row.auth_level || "legacy") !== "verified") {
    return res.status(403).json({
      ok: false,
      code: "VERIFIED_PAIRING_REQUIRED",
      message: "Pair this device with the client secret to access protected client features.",
    });
  }

  req.clientDevice = {
    deviceId,
    ownerUserId: String(row.user_id || "").trim(),
    authLevel: "verified",
    secretVersion: Number(row.secret_version || 0),
  };
  try {
    db.prepare(`UPDATE devices_v2 SET last_seen_at=? WHERE device_id=?`)
      .run(Date.now(), deviceId);
  } catch {}
  return next();
}

app.get(
  "/api/client/v1/command-history/report-reasons",
  requireVerifiedClientDevice,
  (_req, res) => {
    const reasons = COMMAND_HISTORY_REPORT_REASON_OPTIONS.map((option) => ({
      id: option.key,
      label: option.label,
      description: option.description,
    }));
    return res.json({
      ok: true,
      reasons,
      // Retain the original shape for clients released before this contract.
      items: COMMAND_HISTORY_REPORT_REASON_OPTIONS.map((option) => ({
        key: option.key,
        label: option.label,
        description: option.description,
      })),
    });
  },
);

app.get(
  "/api/client/v1/message-board/messages",
  requireVerifiedClientDevice,
  (req, res) => {
    const messages = getClientBoardMessages(
      req.clientDevice.ownerUserId,
      req.query?.limit,
    );
    return res.json({
      ok: true,
      messages,
      nextCursor: null,
    });
  },
);

app.post(
  "/api/client/v1/message-board/messages",
  requireVerifiedClientDevice,
  (req, res) => {
    const ownerUserId = req.clientDevice.ownerUserId;
    let body = String(req.body?.message || "").trim();
    if (!body) {
      return res.status(400).json({
        ok: false,
        code: "MESSAGE_REQUIRED",
        message: "Message required.",
      });
    }
    if (body.length > 200) body = body.slice(0, 200);

    const created = postBoardMessageTx(ownerUserId, body);
    const message = getClientBoardMessages(ownerUserId, 100).find(
      (item) => item.id === created.id,
    );

    logEvent({
      type: "device_board_post",
      actorUserId: ownerUserId,
      targetUserId: ownerUserId,
      deviceId: req.clientDevice.deviceId,
      req,
      payload: { body, createdAt: created.createdAt, source: "client" },
    });

    return res.json({
      ok: true,
      message: message || {
        id: created.id,
        message: body,
        authorName: "Unknown user",
        createdAt: created.createdAt,
      },
    });
  },
);

app.get(
  "/api/client/v1/command-history",
  requireVerifiedClientDevice,
  (req, res) => {
    const ownerUserId = req.clientDevice.ownerUserId;
    const items = getRecentReceivedCommandHistory(ownerUserId, 15).map((item) => ({
      ...item,
      canReport: !!item.canLike,
      canBlock: !!item.canLike,
    }));
    return res.json({
      ok: true,
      ownerUserId,
      items,
      actions: ["like", "report", "block"],
    });
  },
);

app.post(
  "/api/client/v1/command-history/:eventId/like",
  requireVerifiedClientDevice,
  (req, res) => {
    const ownerUserId = req.clientDevice.ownerUserId;
    const eventId = String(req.params.eventId || "").trim();
    const historyEvent = findReceivedCommandHistoryEvent(ownerUserId, eventId);
    if (!historyEvent) {
      return res.status(404).json({ ok: false, message: "Command history entry not found." });
    }
    try {
      const result = createCommandHistoryLike({
        historyEvent,
        likerUserId: ownerUserId,
        req,
      });
      return res.json({
        ok: true,
        liked: true,
        alreadyLiked: !!result.alreadyLiked,
        likesTotal: Number(result.likesTotal || 0),
        message: result.alreadyLiked ? "You already liked that command." : "Command liked.",
      });
    } catch (err) {
      return res.status(400).json({ ok: false, message: err?.message || "Could not like that command." });
    }
  },
);

app.post(
  "/api/client/v1/command-history/:eventId/block",
  requireVerifiedClientDevice,
  (req, res) => {
    const ownerUserId = req.clientDevice.ownerUserId;
    const eventId = String(req.params.eventId || "").trim();
    const historyEvent = findReceivedCommandHistoryEvent(ownerUserId, eventId);
    if (!historyEvent) {
      return res.status(404).json({ ok: false, message: "Command history entry not found." });
    }
    const blockedUserId = String(historyEvent.actor_user_id || "").trim();
    if (!blockedUserId || blockedUserId === ownerUserId) {
      return res.status(400).json({ ok: false, message: "That sender cannot be blocked." });
    }
    try {
      createCommandSenderBlock({
        ownerUserId,
        blockedUserId,
        sourceEventId: historyEvent.id,
        req,
      });
      return res.json({
        ok: true,
        blocked: true,
        message: "Future commands from this sender will be blocked.",
      });
    } catch (err) {
      return res.status(500).json({ ok: false, message: err?.message || "Could not block that sender." });
    }
  },
);

app.post(
  "/api/client/v1/command-history/:eventId/report",
  requireVerifiedClientDevice,
  async (req, res) => {
    const ownerUserId = req.clientDevice.ownerUserId;
    const eventId = String(req.params.eventId || "").trim();
    const reasonKey = String(req.body?.reason || req.body?.reason_key || "").trim();
    const details = normalizeReportDetails(req.body?.details);
    if (!getReportReasonOption(reasonKey, COMMAND_HISTORY_REPORT_REASON_BY_KEY)) {
      return res.status(400).json({ ok: false, message: "Please choose a reason for the report." });
    }
    const historyEvent = findReceivedCommandHistoryEvent(ownerUserId, eventId);
    if (!historyEvent) {
      return res.status(404).json({ ok: false, message: "Command history entry not found." });
    }
    const subjectUserId = String(historyEvent.actor_user_id || "").trim();
    if (!subjectUserId || subjectUserId === ownerUserId) {
      return res.status(400).json({ ok: false, message: "That sender cannot be reported." });
    }
    const reporterUser =
      db.prepare(`SELECT * FROM users WHERE discord_id=?`).get(ownerUserId) ||
      { discord_id: ownerUserId };
    const subjectUser =
      db
        .prepare(`SELECT discord_id, username, global_name, control_link_display_name FROM users WHERE discord_id=?`)
        .get(subjectUserId) || { discord_id: subjectUserId };
    const payload = historyEvent.payloadObj || {};
    const commandType = String(historyEvent.type || "").trim();
    const url = String(payload.url || "").trim();
    const resolvedUrl = String(payload.resolvedUrl || "").trim();
    const name = String(payload.name || "").trim();
    try {
      const created = createUserReport({
        subjectUserId,
        subjectUser,
        reporterUser,
        reasonKey,
        reasonMap: COMMAND_HISTORY_REPORT_REASON_BY_KEY,
        details,
        meta: {
          source: "command_history",
          sourceEventId: historyEvent.id,
          commandType,
          commandTypeLabel: CONTROL_LINK_COMMAND_HISTORY_TYPES[commandType] || "Command",
          commandId: String(payload.commandId || "").trim() || null,
          kind: String(payload.kind || "").trim() || null,
          name: name || null,
          message: String(payload.message || "").trim() || null,
          messages: normalizeSubliminalMessagesPayload(payload.messages),
          url: url || null,
          resolvedUrl: resolvedUrl || null,
          targetOwnerUserId: ownerUserId,
          sourceDeviceId: req.clientDevice.deviceId,
        },
        req,
      });
      const mediaSourceUrl = resolvedUrl || url;
      if (mediaSourceUrl && getReportMediaBackupCommandKey(commandType)) {
        try {
          await captureReportMediaBackupFromCommand({
            report: created.report,
            commandType,
            sourceUrl: mediaSourceUrl,
            sourceName: name,
            sourceMime: "",
            req,
          });
        } catch (backupErr) {
          logEvent({
            type: "report_media_backup_failed",
            actorUserId: ownerUserId,
            targetUserId: subjectUserId,
            deviceId: req.clientDevice.deviceId,
            req,
            payload: {
              reportId: created.report.id,
              commandType,
              error: String(backupErr?.message || backupErr || "backup_failed"),
            },
          });
        }
      }
      return res.json({ ok: true, reported: true, message: "Report sent. Thank you." });
    } catch (err) {
      return res.status(500).json({ ok: false, message: err?.message || "Could not send that report." });
    }
  },
);

app.post(
  "/api/device/:pairCode/board",
  requireDiscord,
  requireNotBanned,
  (req, res) => {
    const pairCode = String(req.params.pairCode || "").trim();
    if (!/^\d{6}$/.test(pairCode))
      return res.status(400).json({ ok: false, code: "BAD_PAIR_CODE" });

    const resolved = resolveOwnerAndDevicesByPairCode(pairCode);
    if (!resolved)
      return res.status(404).json({ ok: false, code: "UNKNOWN_CODE" });

    if (req.user.discord_id !== resolved.ownerUserId) {
      return res.status(403).json({ ok: false, code: "NOT_OWNER" });
    }

    let body = String(req.body?.body || "").trim();

    if (!body) {
      return res.status(400).json({ ok: false, message: "Message required." });
    }

    if (body.length > 200) {
      body = body.slice(0, 200);
    }

    const created = postBoardMessageTx(resolved.ownerUserId, body);
    const createdAt = created.createdAt;

    logEvent({
      type: "device_board_post",
      actorUserId: getRequestActorUserId(req),
      targetUserId: resolved.ownerUserId,
      pairCode,
      req,
      payload: { body, createdAt },
    });

    const messages = getBoardMessages(resolved.ownerUserId, 10);
    return res.json({ ok: true, createdAt, messages });
  },
);

app.post(
  "/api/device/:pairCode/theme",
  requireDiscord,
  requireNotBanned,
  (req, res) => {
    const pairCode = String(req.params.pairCode || "").trim();
    if (!/^\d{6}$/.test(pairCode)) {
      return res.status(400).json({ ok: false, code: "BAD_PAIR_CODE" });
    }

    const resolved = resolveOwnerAndDevicesByPairCode(pairCode);
    if (!resolved) {
      return res.status(404).json({ ok: false, code: "UNKNOWN_CODE" });
    }

    if (req.user.discord_id !== resolved.ownerUserId) {
      return res.status(403).json({ ok: false, code: "NOT_OWNER" });
    }

    const theme = String(req.body?.theme || "")
      .trim()
      .toLowerCase();
    if (!CONTROL_LINK_THEME_KEYS.has(theme)) {
      return res.status(400).json({ ok: false, code: "INVALID_THEME" });
    }

    const displayName = normalizeControlLinkDisplayName(req.body?.displayName);
    const aboutMe = setAboutMe(resolved.ownerUserId, req.body?.aboutMe);

    db.prepare(
      `
      UPDATE users
      SET control_link_theme=?, control_link_display_name=?, updated_at=?
      WHERE discord_id=?
    `,
    ).run(theme, displayName, Date.now(), resolved.ownerUserId);

    logEvent({
      type: "control_link_profile_updated",
      actorUserId: getRequestActorUserId(req),
      targetUserId: resolved.ownerUserId,
      pairCode,
      req,
      payload: { theme, displayName, aboutMe },
    });

    return res.json({
      ok: true,
      theme,
      displayName: displayName || "",
      aboutMe,
    });
  },
);

app.post(
  "/api/device/:pairCode/top-favorite",
  requireDiscord,
  requireNotBanned,
  (req, res) => {
    const pairCode = String(req.params.pairCode || "").trim();
    if (!/^\d{6}$/.test(pairCode)) {
      return res.status(400).json({ ok: false, code: "BAD_PAIR_CODE" });
    }

    const resolved = resolveOwnerAndDevicesByPairCode(pairCode);
    if (!resolved) {
      return res.status(404).json({ ok: false, code: "UNKNOWN_CODE" });
    }

    if (req.user.discord_id !== resolved.ownerUserId) {
      return res.status(403).json({ ok: false, code: "NOT_OWNER" });
    }

    const itemKey = String(req.body?.itemKey || "").trim();
    const rawEnabled = req.body?.enabled;
    const enabled =
      rawEnabled === true ||
      rawEnabled === 1 ||
      String(rawEnabled || "0").trim().toLowerCase() === "1" ||
      String(rawEnabled || "").trim().toLowerCase() === "true";

    try {
      const topFavoriteKeys = setTopFavoriteState(
        resolved.ownerUserId,
        itemKey,
        enabled,
      );
      const catalog = getCatalogItems();
      const ownerSelections = getUserSelections(resolved.ownerUserId);
      const orderedFavoriteKeys = orderFavoriteKeys(
        Array.from(ownerSelections.favorites || []),
        catalog,
        topFavoriteKeys,
      );

      logEvent({
        type: "control_link_top_favorite_updated",
        actorUserId: getRequestActorUserId(req),
        targetUserId: resolved.ownerUserId,
        pairCode,
        req,
        payload: {
          itemKey,
          enabled,
          topCount: topFavoriteKeys.length,
        },
      });

      return res.json({
        ok: true,
        itemKey,
        enabled,
        limit: TOP_FAVORITES_LIMIT,
        topFavoriteKeys,
        orderedFavoriteKeys,
      });
    } catch (e) {
      const code = String(e?.message || "top_favorite_failed");
      if (code === "bad_item_key") {
        return res.status(400).json({
          ok: false,
          code: "BAD_ITEM_KEY",
          message: "That favorite could not be found.",
        });
      }
      if (code === "not_a_favorite") {
        return res.status(400).json({
          ok: false,
          code: "NOT_A_FAVORITE",
          message: "Only favorites can be pinned to the top.",
        });
      }
      if (code === "top_favorites_limit") {
        return res.status(400).json({
          ok: false,
          code: "TOP_FAVORITES_LIMIT",
          message: `You can only set ${TOP_FAVORITES_LIMIT} top favorites. Unstar one first.`,
        });
      }

      return res.status(400).json({
        ok: false,
        code: "TOP_FAVORITE_FAILED",
        message: "Could not update top favorites.",
      });
    }
  },
);

app.post(
  "/api/device/:pairCode/avatar",
  requireDiscord,
  requireNotBanned,
  (req, res) => {
    const pairCode = String(req.params.pairCode || "").trim();
    if (!/^\d{6}$/.test(pairCode)) {
      return res.status(400).json({ ok: false, code: "BAD_PAIR_CODE" });
    }

    const resolved = resolveOwnerAndDevicesByPairCode(pairCode);
    if (!resolved) {
      return res.status(404).json({ ok: false, code: "UNKNOWN_CODE" });
    }

    if (req.user.discord_id !== resolved.ownerUserId) {
      return res.status(403).json({ ok: false, code: "NOT_OWNER" });
    }

    const result = setCustomSiteAvatar(resolved.ownerUserId, {
      filename: req.body?.filename,
      mime: req.body?.mime,
      data: req.body?.data,
    });

    if (!result.ok) {
      return res.status(result.status || 400).json({
        ok: false,
        message: result.message || "Could not update avatar.",
      });
    }

    logEvent({
      type: "control_link_avatar_updated",
      actorUserId: getRequestActorUserId(req),
      targetUserId: resolved.ownerUserId,
      pairCode,
      req,
      payload: {
        mime: result.mime,
        updatedAt: result.updatedAt,
      },
    });

    return res.json({
      ok: true,
      hasCustomAvatar: true,
      updatedAt: result.updatedAt,
      avatarUrl: siteAvatarUrl({ discord_id: resolved.ownerUserId }, 128),
    });
  },
);

app.post(
  "/api/device/:pairCode/avatar/delete",
  requireDiscord,
  requireNotBanned,
  (req, res) => {
    const pairCode = String(req.params.pairCode || "").trim();
    if (!/^\d{6}$/.test(pairCode)) {
      return res.status(400).json({ ok: false, code: "BAD_PAIR_CODE" });
    }

    const resolved = resolveOwnerAndDevicesByPairCode(pairCode);
    if (!resolved) {
      return res.status(404).json({ ok: false, code: "UNKNOWN_CODE" });
    }

    if (req.user.discord_id !== resolved.ownerUserId) {
      return res.status(403).json({ ok: false, code: "NOT_OWNER" });
    }

    const result = clearCustomSiteAvatar(resolved.ownerUserId);
    if (!result.ok) {
      return res.status(result.status || 400).json({
        ok: false,
        message: result.message || "Could not remove avatar.",
      });
    }

    logEvent({
      type: "control_link_avatar_removed",
      actorUserId: getRequestActorUserId(req),
      targetUserId: resolved.ownerUserId,
      pairCode,
      req,
      payload: {
        updatedAt: result.updatedAt,
      },
    });

    return res.json({
      ok: true,
      hasCustomAvatar: false,
      updatedAt: result.updatedAt,
      avatarUrl: siteAvatarUrl({ discord_id: resolved.ownerUserId }, 128),
    });
  },
);

app.post(
  "/api/device/:pairCode/banner",
  requireDiscord,
  requireNotBanned,
  (req, res) => {
    const pairCode = String(req.params.pairCode || "").trim();
    if (!/^\d{6}$/.test(pairCode)) {
      return res.status(400).json({ ok: false, code: "BAD_PAIR_CODE" });
    }

    const resolved = resolveOwnerAndDevicesByPairCode(pairCode);
    if (!resolved) {
      return res.status(404).json({ ok: false, code: "UNKNOWN_CODE" });
    }

    if (req.user.discord_id !== resolved.ownerUserId) {
      return res.status(403).json({ ok: false, code: "NOT_OWNER" });
    }

    const result = setCustomSiteBanner(resolved.ownerUserId, {
      filename: req.body?.filename,
      mime: req.body?.mime,
      data: req.body?.data,
    });

    if (!result.ok) {
      return res.status(result.status || 400).json({
        ok: false,
        message: result.message || "Could not update banner.",
      });
    }

    logEvent({
      type: "control_link_banner_updated",
      actorUserId: getRequestActorUserId(req),
      targetUserId: resolved.ownerUserId,
      pairCode,
      req,
      payload: {
        mime: result.mime,
        updatedAt: result.updatedAt,
      },
    });

    return res.json({
      ok: true,
      hasCustomBanner: true,
      updatedAt: result.updatedAt,
      bannerUrl: siteBannerUrl({ discord_id: resolved.ownerUserId }, 1600),
    });
  },
);

app.post(
  "/api/device/:pairCode/banner/delete",
  requireDiscord,
  requireNotBanned,
  (req, res) => {
    const pairCode = String(req.params.pairCode || "").trim();
    if (!/^\d{6}$/.test(pairCode)) {
      return res.status(400).json({ ok: false, code: "BAD_PAIR_CODE" });
    }

    const resolved = resolveOwnerAndDevicesByPairCode(pairCode);
    if (!resolved) {
      return res.status(404).json({ ok: false, code: "UNKNOWN_CODE" });
    }

    if (req.user.discord_id !== resolved.ownerUserId) {
      return res.status(403).json({ ok: false, code: "NOT_OWNER" });
    }

    const result = clearCustomSiteBanner(resolved.ownerUserId);
    if (!result.ok) {
      return res.status(result.status || 400).json({
        ok: false,
        message: result.message || "Could not remove banner.",
      });
    }

    logEvent({
      type: "control_link_banner_removed",
      actorUserId: getRequestActorUserId(req),
      targetUserId: resolved.ownerUserId,
      pairCode,
      req,
      payload: {
        updatedAt: result.updatedAt,
      },
    });

    return res.json({
      ok: true,
      hasCustomBanner: false,
      updatedAt: result.updatedAt,
      bannerUrl: "",
    });
  },
);

app.post(
  "/api/device/:pairCode/background",
  requireDiscord,
  requireNotBanned,
  (req, res) => {
    const pairCode = String(req.params.pairCode || "").trim();
    if (!/^\d{6}$/.test(pairCode)) {
      return res.status(400).json({ ok: false, code: "BAD_PAIR_CODE" });
    }

    const resolved = resolveOwnerAndDevicesByPairCode(pairCode);
    if (!resolved) {
      return res.status(404).json({ ok: false, code: "UNKNOWN_CODE" });
    }

    if (req.user.discord_id !== resolved.ownerUserId) {
      return res.status(403).json({ ok: false, code: "NOT_OWNER" });
    }

    const result = setCustomSiteBackground(resolved.ownerUserId, {
      filename: req.body?.filename,
      mime: req.body?.mime,
      data: req.body?.data,
    });

    if (!result.ok) {
      return res.status(result.status || 400).json({
        ok: false,
        message: result.message || "Could not update background.",
      });
    }

    logEvent({
      type: "control_link_background_updated",
      actorUserId: getRequestActorUserId(req),
      targetUserId: resolved.ownerUserId,
      pairCode,
      req,
      payload: {
        mime: result.mime,
        updatedAt: result.updatedAt,
      },
    });

    return res.json({
      ok: true,
      hasCustomBackground: true,
      updatedAt: result.updatedAt,
      backgroundUrl: siteBackgroundUrl(
        { discord_id: resolved.ownerUserId },
        1920,
      ),
    });
  },
);

app.post(
  "/api/device/:pairCode/background/delete",
  requireDiscord,
  requireNotBanned,
  (req, res) => {
    const pairCode = String(req.params.pairCode || "").trim();
    if (!/^\d{6}$/.test(pairCode)) {
      return res.status(400).json({ ok: false, code: "BAD_PAIR_CODE" });
    }

    const resolved = resolveOwnerAndDevicesByPairCode(pairCode);
    if (!resolved) {
      return res.status(404).json({ ok: false, code: "UNKNOWN_CODE" });
    }

    if (req.user.discord_id !== resolved.ownerUserId) {
      return res.status(403).json({ ok: false, code: "NOT_OWNER" });
    }

    const result = clearCustomSiteBackground(resolved.ownerUserId);
    if (!result.ok) {
      return res.status(result.status || 400).json({
        ok: false,
        message: result.message || "Could not remove background.",
      });
    }

    logEvent({
      type: "control_link_background_removed",
      actorUserId: getRequestActorUserId(req),
      targetUserId: resolved.ownerUserId,
      pairCode,
      req,
      payload: {
        updatedAt: result.updatedAt,
      },
    });

    return res.json({
      ok: true,
      hasCustomBackground: false,
      updatedAt: result.updatedAt,
      backgroundUrl: "",
    });
  },
);

registerCommandRoutes(app, {
  buildDirectDeliveryMessage,
  buildGroupDeliveryMessage,
  crypto,
  db,
  denyIfBlockedCommandSender,
  denyIfDisabled,
  enforceManagedUrlPolicy,
  enforceWebCooldownForNewUsers,
  groupHasReportedCapabilityForActor,
  heavyCooldown,
  incrementCommandsSentTotal,
  incrementCommandsSentTotalOnce,
  isCommunityGroupCommandEnabled,
  isAllowedByWhitelist,
  isAllowedWallpaperExt,
  isHttpUrl,
  logEvent,
  logDeliveredDirectCommandHistory,
  ownerHasReportedCapabilityForActor,
  requireDiscord,
  requireNotBanned,
  resolvePopupMediaUrl,
  resolveOwnerAndDevicesByPairCode,
  sendCommandToResolvedTarget,
  sendToGroupAndWait,
});

app.post("/favorites/toggle", requireDiscord, (req, res) => {
  const me = req.viewUser.discord_id;
  const target = String(req.body?.discordId || "");

  if (!target)
    return res.status(400).json({ ok: false, error: "missing_discordId" });
  if (target === me)
    return res.status(400).json({ ok: false, error: "cannot_favorite_self" });

  const exists = db
    .prepare(
      `
    SELECT 1 FROM favorites
    WHERE user_id = ? AND favorite_user_id = ?
  `,
    )
    .get(me, target);

  if (exists) {
    db.prepare(
      `DELETE FROM favorites WHERE user_id = ? AND favorite_user_id = ?`,
    ).run(me, target);
    return res.json({ ok: true, favorited: false });
  } else {
    db.prepare(
      `INSERT OR IGNORE INTO favorites (user_id, favorite_user_id) VALUES (?, ?)`,
    ).run(me, target);
    return res.json({ ok: true, favorited: true });
  }
});

app.use(express.static(path.join(__dirname, "../public")));

function loadCatalogItems() {
  try {
    const stat = fs.statSync(CATALOG);
    if (!stat.isFile()) {
      console.warn(`[catalog] skipped sync, not a file: ${CATALOG}`);
      return null;
    }

    const raw = fs.readFileSync(CATALOG, "utf8");
    const data = JSON.parse(raw);
    const items = Array.isArray(data.items) ? data.items : [];
    return items
      .map((it, index) => ({
        key: String(it.key || "").trim(),
        label: String(it.label || "").trim(),
        sort: Number.isFinite(Number(it.sort)) ? Number(it.sort) : index,
      }))
      .filter((it) => it.key && it.label);
  } catch (err) {
    console.warn(
      `[catalog] skipped sync, failed to load ${CATALOG}: ${err?.message || err}`,
    );
    return null;
  }
}

function syncCatalogToDb() {
  const items = loadCatalogItems();
  if (!items) return;
  const now = Date.now();

  const upsert = db.prepare(`
    INSERT INTO list_items (key, label, sort_order, created_at)
    VALUES (@key, @label, @sort, @created_at)
    ON CONFLICT(key) DO UPDATE SET
      label=excluded.label,
      sort_order=excluded.sort_order
  `);

  const tx = db.transaction(() => {
    for (const it of items) upsert.run({ ...it, created_at: now });

    if (CATALOG_PRUNE) {
      const delMissing = db.prepare(`
        DELETE FROM list_items
        WHERE key NOT IN (${items.map((_, i) => `@k${i}`).join(",") || "''"})
      `);

      const args = {};
      items.forEach((it, i) => (args[`k${i}`] = it.key));
      delMissing.run(args);
    }
  });

  tx();
  console.log(
    `[catalog] synced ${items.length} items` +
      (CATALOG_PRUNE ? " (prune ON)" : " (prune OFF)"),
  );
}

if (!IS_AVATAR_BACKFILL_CLI) {
  syncCatalogToDb();
}

function getCatalogItems() {
  return db
    .prepare(
      `
    SELECT key, label
    FROM list_items
    ORDER BY label COLLATE NOCASE ASC, key COLLATE NOCASE ASC
  `,
    )
    .all();
}

function getUserSelections(userId) {
  const rows = db
    .prepare(
      `
    SELECT list_key, item_key
    FROM user_list_items
    WHERE user_id=?
  `,
    )
    .all(userId);

  const out = { favorites: new Set(), dislikes: new Set() };
  for (const r of rows) {
    if (!out[r.list_key]) out[r.list_key] = new Set();
    out[r.list_key].add(r.item_key);
  }
  return out;
}

function orderSelectionKeysByCatalog(keys, catalog) {
  const wanted = new Set(
    Array.isArray(keys)
      ? keys.map((key) => String(key || "").trim()).filter(Boolean)
      : [],
  );
  const ordered = [];

  for (const item of catalog || []) {
    const key = String(item?.key || "").trim();
    if (!key || !wanted.has(key)) continue;
    ordered.push(key);
    wanted.delete(key);
  }

  for (const key of wanted) ordered.push(key);
  return ordered;
}

function getTopFavoriteKeys(userId) {
  const rows = db
    .prepare(
      `
    SELECT utf.item_key
    FROM user_top_favorites utf
    JOIN user_list_items uli
      ON uli.user_id = utf.user_id
     AND uli.list_key = 'favorites'
     AND uli.item_key = utf.item_key
    WHERE utf.user_id = ?
    ORDER BY utf.created_at DESC, utf.item_key COLLATE NOCASE ASC
  `,
    )
    .all(userId);

  return rows
    .map((row) => String(row?.item_key || "").trim())
    .filter(Boolean);
}

function orderFavoriteKeys(favoriteKeys, catalog, topFavoriteKeys = []) {
  const base = orderSelectionKeysByCatalog(favoriteKeys, catalog);
  const favoriteSet = new Set(base);
  const topOrdered = [];
  const seen = new Set();

  for (const key of topFavoriteKeys || []) {
    const normalized = String(key || "").trim();
    if (!normalized || seen.has(normalized) || !favoriteSet.has(normalized)) {
      continue;
    }
    topOrdered.push(normalized);
    seen.add(normalized);
  }

  const rest = base.filter((key) => !seen.has(key));
  return topOrdered.concat(rest);
}

function setTopFavoriteState(userId, itemKey, enabled) {
  const normalizedItemKey = String(itemKey || "").trim();
  if (!normalizedItemKey) throw new Error("bad_item_key");

  const exists = db
    .prepare(`SELECT 1 FROM list_items WHERE key=?`)
    .get(normalizedItemKey);
  if (!exists) throw new Error("bad_item_key");

  const favoriteExists = !!db
    .prepare(
      `
    SELECT 1
    FROM user_list_items
    WHERE user_id=? AND list_key='favorites' AND item_key=?
  `,
    )
    .get(userId, normalizedItemKey);

  const tx = db.transaction(() => {
    if (enabled) {
      if (!favoriteExists) throw new Error("not_a_favorite");

      const alreadyTop = !!db
        .prepare(
          `
        SELECT 1
        FROM user_top_favorites
        WHERE user_id=? AND item_key=?
      `,
        )
        .get(userId, normalizedItemKey);

      if (!alreadyTop) {
        const countRow = db
          .prepare(
            `
          SELECT COUNT(*) AS n
          FROM user_top_favorites utf
          JOIN user_list_items uli
            ON uli.user_id = utf.user_id
           AND uli.list_key = 'favorites'
           AND uli.item_key = utf.item_key
          WHERE utf.user_id=?
        `,
          )
          .get(userId);

        const count = Number(countRow?.n || 0);
        if (count >= TOP_FAVORITES_LIMIT) {
          throw new Error("top_favorites_limit");
        }

        db.prepare(
          `
          INSERT INTO user_top_favorites (user_id, item_key, created_at)
          VALUES (?, ?, ?)
        `,
        ).run(userId, normalizedItemKey, Date.now());
      }
    } else {
      db.prepare(
        `
        DELETE FROM user_top_favorites
        WHERE user_id=? AND item_key=?
      `,
      ).run(userId, normalizedItemKey);
    }
  });

  tx();
  return getTopFavoriteKeys(userId);
}

function setUserItem(userId, listKey, itemKey, enabled) {
  if (!LISTS[listKey]) throw new Error("bad_list_key");

  const exists = db
    .prepare(`SELECT key FROM list_items WHERE key=?`)
    .get(itemKey);
  if (!exists) throw new Error("bad_item_key");

  const otherListKey = listKey === "favorites" ? "dislikes" : "favorites";

  const tx = db.transaction(() => {
    if (enabled) {
      db.prepare(
        `
        DELETE FROM user_list_items
        WHERE user_id=? AND list_key=? AND item_key=?
      `,
      ).run(userId, otherListKey, itemKey);

      if (listKey === "dislikes") {
        db.prepare(
          `
          DELETE FROM user_top_favorites
          WHERE user_id=? AND item_key=?
        `,
        ).run(userId, itemKey);
      }

      db.prepare(
        `
        INSERT OR IGNORE INTO user_list_items (user_id, list_key, item_key, created_at)
        VALUES (?, ?, ?, ?)
      `,
      ).run(userId, listKey, itemKey, Date.now());
    } else {
      db.prepare(
        `
        DELETE FROM user_list_items
        WHERE user_id=? AND list_key=? AND item_key=?
      `,
      ).run(userId, listKey, itemKey);

      if (listKey === "favorites") {
        db.prepare(
          `
          DELETE FROM user_top_favorites
          WHERE user_id=? AND item_key=?
        `,
        ).run(userId, itemKey);
      }
    }
  });

  tx();
}

registerProfileRoutes(app, {
  API_MIN_COMMANDS,
  CONTROL_LINK_THEME_OPTIONS,
  CUSTOM_CONTROL_URL_MAX_LEN,
  CUSTOM_CONTROL_URL_MIN_COMMANDS,
  CUSTOM_CONTROL_URL_MIN_LEN,
  MAX_USER_STRIKES,
  PAIR_CODE_RESET_COOLDOWN_MS,
  WHITELIST_SEARCH_MIN_LEN,
  WebSocket,
  buildCustomControlUrl,
  canChangeCustomControlUrl,
  clearQueuedCommandsForUser,
  clientPairingCredentials,
  createNotificationsForUsers,
  db,
  ensurePairCode,
  ensureUserApiKeyExists,
  formatDateTimeLabel,
  gen6,
  genApiKey,
  getAboutMe,
  getApiKeyMeta,
  getCatalogItems,
  getCommandsSentTotal,
  getPairCodeResetNextAllowedAt,
  getPairCodeResetState,
  getProfileFlash,
  getUserPresenceState,
  getUserSelections,
  getUserStrikeCount,
  getUserStrikeState,
  getWhitelist,
  getPreferredDisplayName,
  hashApiKey,
  hmac,
  isDiscordId,
  isDeviceOnline,
  isValidCustomControlSlug,
  listUserStrikeHistory,
  logEvent,
  normalizeControlLinkDisplayName,
  normalizeControlLinkTheme,
  normalizeCustomControlSlug,
  normalizeWhitelistSearchQuery,
  renderWithLayout,
  requireDiscord,
  requireNotBanned,
  searchWhitelistUsers,
  siteAvatarUrl,
  setAboutMe,
  setUserItem,
  unpairAllDevicesForUser,
  wantsJson,
  wsByDeviceId,
});

registerControlLinkRoutes(app, {
  COMMAND_HISTORY_REPORT_REASON_OPTIONS,
  CONTROL_LINK_REPORT_REASON_BY_KEY,
  CONTROL_LINK_REPORT_REASON_OPTIONS,
  CONTROL_LINK_THEME_OPTIONS,
  TOP_FAVORITES_LIMIT,
  createControlLinkReport,
  db,
  ensurePairCode,
  getBoardMessages,
  getCatalogItems,
  getCommandPrefsForUser,
  getCommandsSentMilestoneBadge,
  getResolvedEnabledCommandsForActor,
  getUserPresenceState,
  getRecentUploadsByContextForUser,
  getReportReasonOption,
  getSupporterBadge,
  getTopFavoriteKeys,
  getUserSelections,
  hmac,
  isCommandEnabled,
  isDeviceOnline,
  isValidCustomControlSlug,
  normalizeControlLinkDisplayName,
  normalizeControlLinkTheme,
  normalizeCustomControlSlug,
  normalizeReportDetails,
  orderFavoriteKeys,
  orderSelectionKeysByCatalog,
  ownerHasReportedCapabilityForActor,
  renderWithLayout,
  requestLooksLikeLinkPreview,
  requireDiscord,
  requireNotBanned,
});

registerDiscoveryRoutes({ app, api }, {
  CONTROL_LINK_REPORT_REASON_BY_KEY,
  CONTROL_LINK_REPORT_REASON_OPTIONS,
  COMMUNITY_GROUP_PUBLIC_MIN_COMMANDS,
  COMMUNITY_GROUP_COMMAND_OPTIONS,
  GROUP_CHAT_REPORT_REASON_BY_KEY,
  GROUP_CHAT_REPORT_REASON_OPTIONS,
  createCommunityGroupReport,
  createUserReport,
  db,
  discordAvatarUrl,
  clearCustomCommunityGroupAvatar,
  clearCustomCommunityGroupBanner,
  groupAvatarUrl,
  groupBannerUrl,
  getCommunityGroupCommandPrefs,
  getUserPresenceState,
  getRecentUploadsByContextForUser,
  groupHasReportedCapability,
  isAdmin,
  listFilteredDiscoverUsers,
  listPagedDiscoverUsers,
  listPresenceStateByUserIds,
  loadGroupsCatalog,
  logEvent,
  renderWithLayout,
  requireDiscord,
  requireNotBanned,
  siteAvatarUrl,
  setCustomCommunityGroupAvatar,
  setCustomCommunityGroupBanner,
});

app.get("/download/client", requireDiscord, requireNotBanned, (req, res) => {
  const filePath = path.join(
    __dirname,
    "../downloads",
    "PlayCtrl.me Client-setup.exe",
  );

  if (!fs.existsSync(filePath)) {
    return res.status(404).type("html").send("Client installer not found.");
  }

  res.download(filePath, "PlayCtrl.me-setup.exe");
});

registerAdminRoutes(app, {
  ALLOWLIST_PATH,
  ADMIN_ACTIVITY_RANGE_24H,
  ADMIN_ACTIVITY_RANGE_7D,
  BLOCKLIST_PATH,
  COMMAND_BLOCKS_PAGE_LIMIT,
  CONTROL_LINK_COMMAND_HISTORY_TYPE_KEYS,
  MAX_USER_STRIKES,
  NOTIFICATION_MENU_LIMIT,
  RESPONSES_DIR,
  REPORTS_PAGE_SIZE,
  REPORT_MEDIA_BACKUPS_DIR,
  appendHostToFile,
  broadcastNotificationToAllUsers,
  clearCustomSiteAvatar,
  clearCustomSiteBackground,
  clearCustomSiteBanner,
  clearCustomCommunityGroupAvatar,
  clearCustomCommunityGroupBanner,
  countCommandSenderBlocks,
  countReports,
  db,
  deleteUploadedFiles,
  escapeHtml,
  formatBytesCompact,
  formatCountLabel,
  genInviteCode,
  getAdminCommandActivityDatasets,
  getAllowSet,
  getBlockSet,
  getNotificationSummaryForUser,
  getPreferredDisplayName,
  getUserStrikeStatesByUserIds,
  inviteHash,
  isEnrollmentOpen,
  isManagedPathInDir,
  listAllUploadedFilesForAdmin,
  listControlLinkAssetsForAdmin,
  listRecentAdminNotificationEvents,
  listRecentCommandSenderBlocks,
  listRecentReports,
  loadGroupsCatalog,
  logEvent,
  markAdminReportQueueNotificationsReadForUser,
  normalizeNotificationActionLabel,
  normalizeNotificationActionUrl,
  normalizeNotificationMessage,
  normalizeNotificationTitle,
  normalizeStoredMime,
  normalizeStrikeCount,
  parseIntSafe,
  removeHostFromFile,
  renderWithLayout,
  requireAdmin,
  requireBootstrapAdmin,
  requireDiscord,
  requireNotBanned,
  deleteMediaUrlResolverSite,
  listMediaUrlResolverSites,
  listSupportedMediaUrlResolvers,
  resolveReportForAdmin,
  groupAvatarUrl,
  groupBannerUrl,
  resolveStoredSiteAvatarPath,
  saveMediaUrlResolverSite,
  setSetting,
  setUserStrikeCountByAdmin,
  siteAvatarUrl,
  tryJson,
  wantsJson,
});

const server = http.createServer(app);
registerRealtimeServer(server);

app.locals.discordAvatarUrl = discordAvatarUrl;
app.locals.siteAvatarUrl = siteAvatarUrl;
app.locals.siteBannerUrl = siteBannerUrl;
app.locals.siteBackgroundUrl = siteBackgroundUrl;
app.locals.escapeHtml = escapeHtml;
app.locals.inlineScriptJson = inlineScriptJson;

app.use((req, res) => {
  res.status(404);
  renderWithLayout(res, "pages/404", {
    title: "Page Not Found"
  });
});

async function main() {
  const args = process.argv.slice(2);
  const command = CLI_COMMAND;

  if (command === "avatars:backfill") {
    const force = args.includes("--force");
    try {
      await runAvatarCacheBackfillCommand({ force });
      try {
        db.close();
      } catch {}
      process.exit(0);
    } catch (e) {
      console.error("[avatar-cache] backfill command failed:", e?.message || e);
      try {
        db.close();
      } catch {}
      process.exit(1);
    }
    return;
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`HTTP: http://0.0.0.0:${PORT}`);
    console.log(`WS: ws://0.0.0.0:${PORT}/ws?deviceId=...&secret=...`);
    console.log("Discord ID:", process.env.DISCORD_CLIENT_ID);
  });
}

void main();
