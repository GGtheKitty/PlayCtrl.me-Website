"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { registerProfileRoutes } = require("../src/routes/profile");

function collectRoutes() {
  const routes = [];
  const app = {
    get(path, ...handlers) {
      routes.push({ method: "GET", path, handlers });
    },
    post(path, ...handlers) {
      routes.push({ method: "POST", path, handlers });
    },
  };

  return { app, routes };
}

test("list update exception text is never served as HTML", () => {
  const { app, routes } = collectRoutes();
  const attackerControlledMessage = '<img src=x onerror="alert(1)">';
  const passThrough = (_req, _res, next) => next();

  registerProfileRoutes(app, {
    requireDiscord: passThrough,
    requireNotBanned: passThrough,
    setUserItem() {
      throw new Error(attackerControlledMessage);
    },
    wantsJson: () => false,
  });

  const route = routes.find(
    (candidate) =>
      candidate.method === "POST" && candidate.path === "/profile/lists/toggle",
  );
  assert.ok(route);

  const req = {
    body: { listKey: "favorites", itemKey: "test-item", enabled: "1" },
    user: { discord_id: "123" },
  };
  const res = {
    statusCode: 200,
    contentType: "",
    body: "",
    status(code) {
      this.statusCode = code;
      return this;
    },
    type(value) {
      this.contentType = value;
      return this;
    },
    send(value) {
      this.body = value;
      return this;
    },
  };

  route.handlers.at(-1)(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.contentType, "text/plain");
  assert.equal(res.body, attackerControlledMessage);
});
