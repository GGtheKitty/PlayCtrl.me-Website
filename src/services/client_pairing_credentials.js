const crypto = require("crypto");

function createClientPairingCredentialService({ db, hmac, encryptionKey }) {
  const keyMaterial = String(encryptionKey || "");
  if (!keyMaterial) {
    throw new Error("Missing client pairing credential encryption key.");
  }
  const encryptionKeyBytes = crypto
    .createHash("sha256")
    .update(keyMaterial, "utf8")
    .digest();

  function normalizeUserId(value) {
    return String(value || "").trim();
  }

  function hashSecret(secret) {
    return hmac(`client-pairing-secret:${String(secret || "")}`);
  }

  function generateSecret() {
    return `pcs_${crypto.randomBytes(24).toString("base64url")}`;
  }

  function encryptSecret(userId, version, secret) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKeyBytes, iv);
    cipher.setAAD(Buffer.from(`${userId}:${version}`, "utf8"));
    const ciphertext = Buffer.concat([
      cipher.update(String(secret || ""), "utf8"),
      cipher.final(),
    ]);
    return {
      ciphertext: ciphertext.toString("base64url"),
      iv: iv.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
    };
  }

  function decryptSecret(row) {
    const userId = normalizeUserId(row?.user_id);
    const version = Math.max(1, Number(row?.secret_version || 1));
    if (!userId) throw new Error("Invalid client pairing credential.");
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      encryptionKeyBytes,
      Buffer.from(String(row.secret_iv || ""), "base64url"),
    );
    decipher.setAAD(Buffer.from(`${userId}:${version}`, "utf8"));
    decipher.setAuthTag(Buffer.from(String(row.secret_tag || ""), "base64url"));
    return Buffer.concat([
      decipher.update(
        Buffer.from(String(row.secret_ciphertext || ""), "base64url"),
      ),
      decipher.final(),
    ]).toString("utf8");
  }

  function getCredential(userId) {
    const uid = normalizeUserId(userId);
    if (!uid) return null;
    return (
      db
        .prepare(
          `SELECT * FROM client_pairing_credentials WHERE user_id=?`,
        )
        .get(uid) || null
    );
  }

  function writeCredential({ userId, secret, version, required, createdAt }) {
    const uid = normalizeUserId(userId);
    const now = Date.now();
    const safeVersion = Math.max(1, Number(version || 1));
    const encrypted = encryptSecret(uid, safeVersion, secret);
    db.prepare(
      `
        INSERT INTO client_pairing_credentials (
          user_id, secret_hash, secret_ciphertext, secret_iv, secret_tag,
          secret_version, secret_required, created_at, updated_at, activated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          secret_hash=excluded.secret_hash,
          secret_ciphertext=excluded.secret_ciphertext,
          secret_iv=excluded.secret_iv,
          secret_tag=excluded.secret_tag,
          secret_version=excluded.secret_version,
          secret_required=excluded.secret_required,
          updated_at=excluded.updated_at,
          activated_at=excluded.activated_at
      `,
    ).run(
      uid,
      hashSecret(secret),
      encrypted.ciphertext,
      encrypted.iv,
      encrypted.tag,
      safeVersion,
      required ? 1 : 0,
      Number(createdAt || now),
      now,
      required ? now : null,
    );
    return getCredential(uid);
  }

  function ensureCredential(userId) {
    const uid = normalizeUserId(userId);
    if (!uid) throw new Error("Missing user.");
    const existing = getCredential(uid);
    if (existing) return { row: existing, created: false, secret: null };
    const secret = generateSecret();
    const row = writeCredential({
      userId: uid,
      secret,
      version: 1,
      required: false,
      createdAt: Date.now(),
    });
    return { row, created: true, secret };
  }

  function revealSecret(userId) {
    const ensured = ensureCredential(userId);
    return {
      secret: ensured.secret || decryptSecret(ensured.row),
      row: ensured.row,
      created: ensured.created,
    };
  }

  function verifySecret(userId, candidate) {
    const row = getCredential(userId);
    const value = String(candidate || "").trim();
    if (!row || !value) return { ok: false, row };
    const actual = Buffer.from(String(row.secret_hash || ""), "hex");
    const supplied = Buffer.from(hashSecret(value), "hex");
    const ok =
      actual.length > 0 &&
      actual.length === supplied.length &&
      crypto.timingSafeEqual(actual, supplied);
    return { ok, row };
  }

  function rotateSecret(userId) {
    const uid = normalizeUserId(userId);
    if (!uid) throw new Error("Missing user.");
    const existing = getCredential(uid);
    const secret = generateSecret();
    const row = writeCredential({
      userId: uid,
      secret,
      version: Math.max(0, Number(existing?.secret_version || 0)) + 1,
      required: !!existing?.secret_required,
      createdAt: Number(existing?.created_at || Date.now()),
    });
    return { row, secret };
  }

  function getCredentialMeta(userId) {
    const row = getCredential(userId);
    return {
      exists: !!row,
      required: !!row?.secret_required,
      version: Number(row?.secret_version || 0),
      createdAt: Number(row?.created_at || 0),
      updatedAt: Number(row?.updated_at || 0),
      activatedAt: Number(row?.activated_at || 0),
    };
  }

  return {
    ensureCredential,
    getCredential,
    getCredentialMeta,
    revealSecret,
    rotateSecret,
    verifySecret,
  };
}

module.exports = { createClientPairingCredentialService };
