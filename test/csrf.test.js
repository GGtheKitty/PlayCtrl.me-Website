"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  CSRF_COOKIE_NAME,
  createCsrfProtection,
  csrfTokenForSession,
  tokensMatch,
} = require("../src/middleware/csrf");

const SECRET = "test-only-csrf-secret";

function makeResponse() {
  return {
    locals: {},
    cookies: [],
    statusCode: 200,
    headers: {},
    cookie(name, value, options) {
      this.cookies.push({ name, value, options });
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    type(value) {
      this.contentType = value;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
  };
}

function runMiddleware(request) {
  const req = {
    method: "GET",
    headers: {},
    cookies: {},
    body: {},
    ...request,
  };
  const res = makeResponse();
  let continued = false;
  createCsrfProtection({ secret: SECRET })(req, res, () => {
    continued = true;
  });
  return { res, continued };
}

test("creates stable, session-bound CSRF tokens", () => {
  const first = csrfTokenForSession("session-one", SECRET);
  const repeated = csrfTokenForSession("session-one", SECRET);
  const otherSession = csrfTokenForSession("session-two", SECRET);

  assert.equal(first, repeated);
  assert.notEqual(first, otherSession);
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(tokensMatch(first, repeated), true);
  assert.equal(tokensMatch(first, `${first}x`), false);
});

test("publishes a token and hardened cookie for authenticated safe requests", () => {
  const { res, continued } = runMiddleware({
    cookies: { sid: "session-one" },
    actorUser: { discord_id: "123" },
  });

  assert.equal(continued, true);
  assert.equal(res.locals.csrfToken, csrfTokenForSession("session-one", SECRET));
  assert.equal(res.headers["Cache-Control"], "private, no-store, max-age=0");
  assert.deepEqual(res.cookies, [
    {
      name: CSRF_COOKIE_NAME,
      value: res.locals.csrfToken,
      options: {
        httpOnly: true,
        sameSite: "strict",
        secure: true,
        path: "/",
        maxAge: 1000 * 60 * 60 * 24 * 15,
      },
    },
  ]);
});

test("accepts unsafe authenticated requests only with matching cookie and request tokens", () => {
  const token = csrfTokenForSession("session-one", SECRET);
  const { res, continued } = runMiddleware({
    method: "POST",
    cookies: { sid: "session-one", [CSRF_COOKIE_NAME]: token },
    actorUser: { discord_id: "123" },
    headers: { "x-csrf-token": token },
  });

  assert.equal(continued, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.cookies.length, 0);
});

test("accepts a matching token from a submitted form body", () => {
  const token = csrfTokenForSession("session-one", SECRET);
  const { res, continued } = runMiddleware({
    method: "POST",
    cookies: { sid: "session-one", [CSRF_COOKIE_NAME]: token },
    actorUser: { discord_id: "123" },
    body: { _csrf: token },
  });

  assert.equal(continued, true);
  assert.equal(res.statusCode, 200);
});

test("rejects missing and forged CSRF tokens", () => {
  const token = csrfTokenForSession("session-one", SECRET);
  const missing = runMiddleware({
    method: "POST",
    cookies: { sid: "session-one", [CSRF_COOKIE_NAME]: token },
    actorUser: { discord_id: "123" },
    headers: { accept: "application/json" },
  });
  const forged = runMiddleware({
    method: "DELETE",
    cookies: { sid: "session-one", [CSRF_COOKIE_NAME]: "forged" },
    actorUser: { discord_id: "123" },
    body: { _csrf: token },
  });

  assert.equal(missing.continued, false);
  assert.equal(missing.res.statusCode, 403);
  assert.equal(missing.res.body.code, "CSRF_INVALID");
  assert.equal(forged.continued, false);
  assert.equal(forged.res.statusCode, 403);
});

test("does not impose browser CSRF tokens on non-session clients", () => {
  const { res, continued } = runMiddleware({
    method: "POST",
    headers: { authorization: "Bearer device-or-api-token" },
  });

  assert.equal(continued, true);
  assert.equal(res.locals.csrfToken, "");
  assert.equal(res.cookies.length, 0);
});
