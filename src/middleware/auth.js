function createAuthMiddleware({
  db,
  renderWithLayout,
  isEnrolledUser,
  markUserEnrolled,
  isEnrollmentOpen,
}) {
  function wantsJson(req) {
    const accept = String(req.headers["accept"] || "");
    const xr = String(req.headers["x-requested-with"] || "");
    return (
      accept.includes("application/json") ||
      xr.toLowerCase() === "xmlhttprequest"
    );
  }

  function isAdminPath(req) {
    const path = String(req.path || req.originalUrl || req.url || "").trim();
    return path === "/admin" || path.startsWith("/admin/");
  }

  function renderObfuscatedAdminNotFound(req, res) {
    if (wantsJson(req)) {
      return res.status(404).json({
        ok: false,
        message: "Not found.",
      });
    }

    res.status(404);
    return renderWithLayout(res, "pages/404", {
      title: "Page Not Found",
    });
  }

  function isInvitedUser(user) {
    return !!(user && user.invited_at);
  }

  function loginRequiredPage(req, res, opts = {}) {
    const title = opts.title || "Login required";
    const nextUrl = opts.nextUrl || req.originalUrl || "/";
    const ogUrl = `https://playctrl.me${nextUrl}`;

    void title;
    void ogUrl;

    return res.status(403).type("html").send(`
      <h1>Access denied</h1>
      <p>You must login to access this page.</p>
    `);
  }

  function inviteGate(req, res, next) {
    const path = req.path || req.url || "";

    if (
      path === "/" ||
      path === "/discover" ||
      path === "/privacy" ||
      path === "/terms" ||
      path === "/preview/home-visitor" ||
      path === "/preview/home-member" ||
      path === "/api/pair" ||
      path.startsWith("/auth/discord") ||
      path === "/invite/redeem" ||
      path === "/invite" ||
      path === "/uploads" ||
      path.startsWith("/uploads/") ||
      path.startsWith("/upd/") ||
      path.startsWith("/invite/") ||
      path.startsWith("/public/") ||
      path === "/logout" ||
      path.startsWith("/assets/") ||
      path.startsWith("/avatars/") ||
      path.startsWith("/api/")
    ) {
      return next();
    }

    if (!req.viewUser) {
      if (req.method === "GET" && path.startsWith("/device/")) {
        return next();
      }

      const shareable = path === "/profile";

      if (req.method === "GET" && shareable) {
        return loginRequiredPage(req, res, {
          title: "Login required",
          message: "Login to view this page.",
          ogTitle: "PlayCtrl.me",
          ogDesc: "Login required to view this PlayCtrl.me page.",
        });
      }

      return res.redirect("/auth/discord");
    }

    if (req.viewIsAdmin) return next();

    if (typeof isEnrollmentOpen === "function" && isEnrollmentOpen()) {
      if (!req.viewUser.enrolled_at) {
        try {
          markUserEnrolled(req.viewUser.discord_id);
          req.viewUser.enrolled_at = Date.now();
        } catch {}
      }
      return next();
    }

    if (!isInvitedUser(req.viewUser) && !isEnrolledUser(req.viewUser)) {
      if (req.method === "GET") return res.redirect("/invite");
      return res.status(403).send("Invite required.");
    }

    return next();
  }

  function isAdmin(discordId) {
    if (!discordId) return false;
    const row = db
      .prepare("SELECT discord_id FROM admins WHERE discord_id=?")
      .get(discordId);
    return !!row;
  }

  function isBootstrapAdmin(discordId) {
    if (!discordId) return false;
    const row = db
      .prepare("SELECT is_bootstrap FROM admins WHERE discord_id=?")
      .get(discordId);
    return !!Number(row?.is_bootstrap || 0);
  }

  function requireAdmin(req, res, next) {
    if (!req.user) return renderObfuscatedAdminNotFound(req, res);
    if (!isAdmin(req.user.discord_id)) {
      return renderObfuscatedAdminNotFound(req, res);
    }
    return next();
  }

  function requireBootstrapAdmin(req, res, next) {
    if (!req.user) return renderObfuscatedAdminNotFound(req, res);
    if (!isBootstrapAdmin(req.user.discord_id)) {
      return renderObfuscatedAdminNotFound(req, res);
    }
    return next();
  }

  function requireDiscord(req, res, next) {
    const sid = req.cookies?.sid;
    if (!sid) {
      if (isAdminPath(req)) return renderObfuscatedAdminNotFound(req, res);
      return res.redirect("/auth/discord");
    }

    if (req.actorUser && req.viewUser) {
      req.user = req.viewUser;
      return next();
    }

    const user = db
      .prepare(
        `
          SELECT users.discord_id, users.username, users.global_name, users.avatar,
                users.discoverable, users.invited_at
          FROM sessions
          JOIN users ON users.discord_id = sessions.discord_id
          WHERE sessions.session_id = ?
        `,
      )
      .get(sid);

    if (!user) {
      if (isAdminPath(req)) return renderObfuscatedAdminNotFound(req, res);
      return res.redirect("/auth/discord");
    }

    req.actorUser = user;
    req.user = user;

    const delegatedSubId = String(req.cookies?.delegated_sub_id || "").trim();
    if (delegatedSubId && delegatedSubId !== user.discord_id) {
      const delegatedUser = db
        .prepare(
          `
            SELECT users.discord_id, users.username, users.global_name, users.avatar,
                  users.discoverable, users.invited_at
            FROM leash_delegations ld
            JOIN users ON users.discord_id = ld.sub_user_id
            LEFT JOIN bans b ON b.discord_id = users.discord_id
            WHERE ld.sub_user_id = ?
              AND ld.dom_user_id = ?
              AND b.discord_id IS NULL
          `,
        )
        .get(delegatedSubId, user.discord_id);

      if (delegatedUser) {
        req.delegatedUser = delegatedUser;
        req.user = delegatedUser;
      } else {
        res.clearCookie("delegated_sub_id", { path: "/" });
      }
    }

    return next();
  }

  return {
    inviteGate,
    isAdmin,
    isBootstrapAdmin,
    isAdminPath,
    isInvitedUser,
    loginRequiredPage,
    renderObfuscatedAdminNotFound,
    requireAdmin,
    requireBootstrapAdmin,
    requireDiscord,
    wantsJson,
  };
}

module.exports = {
  createAuthMiddleware,
};
