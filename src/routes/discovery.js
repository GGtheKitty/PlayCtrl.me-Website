const crypto = require("crypto");

function registerDiscoveryRoutes({ app, api }, deps) {
  const {
    COMMUNITY_GROUP_PUBLIC_MIN_COMMANDS,
    COMMUNITY_GROUP_COMMAND_OPTIONS,
    CONTROL_LINK_REPORT_REASON_BY_KEY,
    CONTROL_LINK_REPORT_REASON_OPTIONS,
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
    renderWithLayout,
    requireDiscord,
    requireNotBanned,
    siteAvatarUrl,
    setCustomCommunityGroupAvatar,
    setCustomCommunityGroupBanner,
  } = deps;

  const COMMUNITY_GROUP_NAME_MAX_LEN = 48;
  const COMMUNITY_GROUP_DESCRIPTION_MAX_LEN = 220;
  const COMMUNITY_GROUP_KEY_MAX_LEN = 48;
  const COMMUNITY_GROUP_DISCOVER_DEFAULT_PER_PAGE = 12;
  const COMMUNITY_GROUP_DISCOVER_MAX_PER_PAGE = 24;
  const COMMUNITY_GROUP_INVITE_TTL_MS = 24 * 60 * 60 * 1000;
  const GROUP_BOARD_MESSAGE_MAX_LEN = 300;
  const GROUP_BOARD_MESSAGE_LIMIT = 50;
  const communityGroupCommandOptions = Array.isArray(
    COMMUNITY_GROUP_COMMAND_OPTIONS,
  )
    ? COMMUNITY_GROUP_COMMAND_OPTIONS
    : [];
  const visibleCommunityGroupCommandOptions = communityGroupCommandOptions.filter(
    (option) => !option?.hiddenFromCommunitySettings,
  );

  function listPresenceByUserIds(userIds) {
    return listPresenceStateByUserIds(userIds);
  }

  function toUniqueStrings(values) {
    return Array.from(
      new Set(
        (Array.isArray(values) ? values : [])
          .map((value) => String(value || "").trim())
          .filter(Boolean),
      ),
    );
  }

  function toBoolean(value) {
    const normalized = String(value ?? "").trim().toLowerCase();
    if (!normalized) return false;
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
    return !!value;
  }

  function normalizeCommunityGroupName(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, COMMUNITY_GROUP_NAME_MAX_LEN);
  }

  function normalizeCommunityGroupDescription(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, COMMUNITY_GROUP_DESCRIPTION_MAX_LEN);
  }

  function normalizeCommunityInviteCode(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";

    if (raw.includes("communityInvite=")) {
      try {
        const url = raw.startsWith("http://") || raw.startsWith("https://")
          ? new URL(raw)
          : new URL(raw, "https://playctrl.me");
        return String(url.searchParams.get("communityInvite") || "").trim();
      } catch {}
    }

    return raw.slice(0, 160);
  }

  function isCommunityInviteActive(invite, now = Date.now()) {
    if (!invite) return false;
    if (Number(invite.revoked_at || 0) > 0) return false;
    const createdAt = Number(invite.created_at || 0);
    return createdAt > 0 && now - createdAt <= COMMUNITY_GROUP_INVITE_TTL_MS;
  }

  function normalizeSearchQuery(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
  }

  function normalizePage(value) {
    const page = Math.round(Number(value || 1));
    return Number.isFinite(page) && page > 0 ? page : 1;
  }

  function normalizePerPage(value) {
    const perPage = Math.round(
      Number(value || COMMUNITY_GROUP_DISCOVER_DEFAULT_PER_PAGE),
    );
    return Math.max(
      1,
      Math.min(
        Number.isFinite(perPage)
          ? perPage
          : COMMUNITY_GROUP_DISCOVER_DEFAULT_PER_PAGE,
        COMMUNITY_GROUP_DISCOVER_MAX_PER_PAGE,
      ),
    );
  }

  function slugifyCommunityGroupName(name) {
    const slug = String(name || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return slug || "group";
  }

  function communityGroupKeyExists(groupKey) {
    return !!db
      .prepare(
        `
          SELECT 1
          FROM community_groups
          WHERE group_key=?
          LIMIT 1
        `,
      )
      .get(groupKey);
  }

  function buildCommunityGroupKey(name) {
    const rawBase = `community-${slugifyCommunityGroupName(name)}`;
    const base = rawBase.slice(0, COMMUNITY_GROUP_KEY_MAX_LEN);
    let key = base;
    let suffix = 2;

    while (communityGroupKeyExists(key) || loadGroupsCatalog().has(key)) {
      const suffixText = `-${suffix}`;
      key = `${base.slice(0, COMMUNITY_GROUP_KEY_MAX_LEN - suffixText.length)}${suffixText}`;
      suffix += 1;
    }

    return key;
  }

  function getViewerCommandsSentTotal(userId) {
    const safeUserId = String(userId || "").trim();
    if (!safeUserId) return 0;

    const row = db
      .prepare(
        `
          SELECT IFNULL(commands_sent_total, 0) AS commands_sent_total
          FROM users
          WHERE discord_id=?
          LIMIT 1
        `,
      )
      .get(safeUserId);
    return Number(row?.commands_sent_total || 0);
  }

  function getCommunityGroupRecord(groupKey) {
    const key = String(groupKey || "").trim();
    if (!key) return null;

    return (
      db
        .prepare(
          `
          SELECT
            cg.group_key,
            cg.owner_user_id,
            cg.name,
            cg.description,
            IFNULL(cg.is_public, 0) AS is_public,
            cg.custom_avatar_path,
            cg.custom_avatar_mime,
            cg.custom_avatar_updated_at,
            cg.custom_banner_path,
            cg.custom_banner_mime,
            cg.custom_banner_updated_at,
            cg.created_at,
            cg.updated_at,
            u.username AS owner_username,
            u.global_name AS owner_global_name,
            IFNULL(u.commands_sent_total, 0) AS owner_commands_sent_total
          FROM community_groups cg
          JOIN users u ON u.discord_id = cg.owner_user_id
          WHERE cg.group_key=?
          LIMIT 1
        `,
        )
        .get(key) || null
    );
  }

  function getResolvedGroupForKey(groupKey) {
    const key = String(groupKey || "").trim();
    if (!key) return null;

    const staticGroup = loadGroupsCatalog().get(key) || null;
    if (staticGroup) {
      return {
        kind: "static",
        key,
        label: String(staticGroup.label || key).trim() || key,
        icon: String(staticGroup.icon || staticGroup.iconUrl || "").trim(),
        banner: String(staticGroup.banner || staticGroup.bannerUrl || "").trim(),
        description: String(staticGroup.description || "").trim(),
        ownerUserId: null,
        row: staticGroup,
      };
    }

    const communityGroup = getCommunityGroupRecord(key);
    if (!communityGroup) return null;
    const ownerUserId = String(communityGroup.owner_user_id || "").trim();
    return {
      kind: "community",
      key,
      label: String(communityGroup.name || key).trim() || key,
      icon: communityGroup.custom_avatar_path
        ? groupAvatarUrl(key, 128)
        : ownerUserId
          ? siteAvatarUrl({ discord_id: ownerUserId }, 128)
          : "",
      banner: communityGroup.custom_banner_path ? groupBannerUrl(key, 1600) : "",
      hasCustomAvatar: !!communityGroup.custom_avatar_path,
      hasCustomBanner: !!communityGroup.custom_banner_path,
      avatarVersion: Number(communityGroup.custom_avatar_updated_at || 0) || 0,
      bannerVersion: Number(communityGroup.custom_banner_updated_at || 0) || 0,
      description: String(communityGroup.description || "").trim(),
      ownerUserId,
      row: communityGroup,
    };
  }

  function getGroupAccess(groupKey, viewerId) {
    const group = getResolvedGroupForKey(groupKey);
    const safeViewerId = String(viewerId || "").trim();
    if (!group) {
      return {
        ok: false,
        statusCode: 404,
        error: "unknown_group",
        message: "Unknown group",
      };
    }

    const isOwner =
      group.kind === "community" &&
      !!safeViewerId &&
      String(group.ownerUserId || "").trim() === safeViewerId;
    const isSiteAdmin =
      !!safeViewerId && typeof isAdmin === "function" && isAdmin(safeViewerId);
    const memberRow = safeViewerId
      ? db
          .prepare(
            `
              SELECT 1
              FROM group_memberships
              WHERE group_key=? AND user_id=?
              LIMIT 1
            `,
          )
          .get(group.key, safeViewerId)
      : null;
    const isMember = isOwner || !!memberRow;

    if (
      group.kind === "community" &&
      !isSiteAdmin &&
      !isOwner &&
      !isMember &&
      !isCommunityGroupPubliclyVisible(group.row)
    ) {
      return {
        ok: false,
        statusCode: 404,
        error: "unknown_group",
        message: "Unknown group",
      };
    }

    return {
      ok: true,
      group,
      isOwner,
      isSiteAdmin,
      isMember,
      canPost: isMember,
    };
  }

  function getGroupBoardMessages(groupKey, limit = GROUP_BOARD_MESSAGE_LIMIT) {
    const key = String(groupKey || "").trim();
    if (!key) return [];

    const max = Math.max(1, Math.min(Number(limit || 0) || GROUP_BOARD_MESSAGE_LIMIT, 100));
    const rows = db
      .prepare(
        `
          SELECT
            gb.id,
            gb.group_key,
            gb.author_user_id,
            gb.body,
            gb.created_at,
            u.username,
            u.global_name,
            u.avatar,
            u.control_link_display_name
          FROM group_message_board gb
          LEFT JOIN users u ON u.discord_id = gb.author_user_id
          WHERE gb.group_key=?
          ORDER BY gb.created_at DESC, gb.id DESC
          LIMIT ?
        `,
      )
      .all(key, max);

    return rows.map((row) => {
      const author = {
        discord_id: String(row.author_user_id || "").trim(),
        username: row.username || "",
        global_name: row.global_name || "",
        avatar: row.avatar || "",
      };
      const displayName = String(
        row.control_link_display_name ||
          row.global_name ||
          row.username ||
          row.author_user_id ||
          "Member",
      ).trim();
      return {
        id: row.id,
        group_key: row.group_key,
        author_user_id: author.discord_id,
        author_display_name: displayName || "Member",
        author_avatar_url: siteAvatarUrl(author, 64),
        body: String(row.body || ""),
        created_at: Number(row.created_at || 0),
      };
    });
  }

  const postGroupBoardMessageTx = db.transaction((groupKey, authorUserId, body) => {
    const now = Date.now();
    db.prepare(
      `
        INSERT INTO group_message_board (
          group_key,
          author_user_id,
          body,
          created_at
        ) VALUES (?, ?, ?, ?)
      `,
    ).run(groupKey, authorUserId, body, now);

    db.prepare(
      `
        DELETE FROM group_message_board
        WHERE group_key=?
          AND id NOT IN (
            SELECT id
            FROM group_message_board
            WHERE group_key=?
            ORDER BY created_at DESC, id DESC
            LIMIT ?
          )
      `,
    ).run(groupKey, groupKey, GROUP_BOARD_MESSAGE_LIMIT);

    return now;
  });

  function serializeCommunityGroupCommandPrefs(groupKey) {
    const prefs =
      typeof getCommunityGroupCommandPrefs === "function"
        ? getCommunityGroupCommandPrefs(groupKey)
        : {};

    const fields = {};
    for (const option of communityGroupCommandOptions) {
      const field = String(option?.field || "").trim();
      if (!field) continue;
      fields[field] = !!prefs[field];
    }
    return fields;
  }

  function normalizeCommunityGroupCommandPrefsInput(body, groupKey = "") {
    const next = {};
    const currentPrefs =
      typeof getCommunityGroupCommandPrefs === "function"
        ? getCommunityGroupCommandPrefs(groupKey)
        : {};
    for (const option of communityGroupCommandOptions) {
      const field = String(option?.field || "").trim();
      if (!field) continue;
      if (option?.hiddenFromCommunitySettings) {
        next[field] = currentPrefs[field] ? 1 : 0;
        continue;
      }
      next[field] = toBoolean(body?.[field]) ? 1 : 0;
    }
    return next;
  }

  function isCommunityGroupPubliclyVisible(groupRow) {
    return (
      !!Number(groupRow?.is_public || 0) &&
      Number(groupRow?.owner_commands_sent_total || 0) >=
        COMMUNITY_GROUP_PUBLIC_MIN_COMMANDS
    );
  }

  function isGroupMember(groupKey, userId) {
    const safeGroupKey = String(groupKey || "").trim();
    const safeUserId = String(userId || "").trim();
    if (!safeGroupKey || !safeUserId) return false;

    return !!db
      .prepare(
        `
          SELECT 1
          FROM group_memberships
          WHERE group_key=? AND user_id=?
          LIMIT 1
        `,
      )
      .get(safeGroupKey, safeUserId);
  }

  function ensureGroupMembership(groupKey, userId) {
    const safeGroupKey = String(groupKey || "").trim();
    const safeUserId = String(userId || "").trim();
    if (!safeGroupKey || !safeUserId) return;

    db.prepare(
      `
        INSERT OR IGNORE INTO group_memberships (group_key, user_id, joined_at)
        VALUES (?, ?, ?)
      `,
    ).run(safeGroupKey, safeUserId, Date.now());
  }

  function getGroupMemberIds(groupKey) {
    return db
      .prepare(
        `
          SELECT user_id
          FROM group_memberships
          WHERE group_key=?
        `,
      )
      .all(groupKey)
      .map((row) => String(row.user_id || "").trim())
      .filter(Boolean);
  }

  function hydrateCommunityGroups(rows, viewerId = "") {
    const safeViewerId = String(viewerId || "").trim();
    const safeRows = Array.isArray(rows) ? rows : [];
    const groupKeys = toUniqueStrings(safeRows.map((row) => row?.group_key));
    const memberRows = [];

    if (groupKeys.length) {
      const placeholders = groupKeys.map(() => "?").join(",");
      memberRows.push(
        ...db
          .prepare(
            `
              SELECT group_key, user_id
              FROM group_memberships
              WHERE group_key IN (${placeholders})
            `,
          )
          .all(...groupKeys),
      );
    }

    const memberIdsByGroupKey = new Map();
    for (const row of memberRows) {
      const groupKey = String(row.group_key || "").trim();
      const userId = String(row.user_id || "").trim();
      if (!groupKey || !userId) continue;
      if (!memberIdsByGroupKey.has(groupKey)) {
        memberIdsByGroupKey.set(groupKey, []);
      }
      memberIdsByGroupKey.get(groupKey).push(userId);
    }

    const allMemberIds = [];
    for (const row of safeRows) {
      const ownerUserId = String(row.owner_user_id || "").trim();
      if (ownerUserId) allMemberIds.push(ownerUserId);
      allMemberIds.push(...(memberIdsByGroupKey.get(String(row.group_key || "").trim()) || []));
    }
    const presenceByUserId = listPresenceByUserIds(toUniqueStrings(allMemberIds));

    return safeRows.map((row) => {
      const key = String(row.group_key || "").trim();
      const ownerUserId = String(row.owner_user_id || "").trim();
      const ownerDisplayName = String(
        row.owner_global_name || row.owner_username || ownerUserId || "Unknown",
      ).trim();
      const memberIds = toUniqueStrings(
        [ownerUserId].concat(memberIdsByGroupKey.get(key) || []),
      );
      const onlineCount = memberIds.reduce(
        (count, userId) => count + (presenceByUserId.get(userId)?.online ? 1 : 0),
        0,
      );
      const isOwner = !!safeViewerId && safeViewerId === ownerUserId;
      const isMember = isOwner || (!!safeViewerId && memberIds.includes(safeViewerId));
      const publicEligible =
        Number(row.owner_commands_sent_total || 0) >=
        COMMUNITY_GROUP_PUBLIC_MIN_COMMANDS;
      const publicVisible = isCommunityGroupPubliclyVisible(row);

      return {
        key,
        name: String(row.name || key).trim() || key,
        description: String(row.description || "").trim(),
        ownerUserId,
        ownerDisplayName,
        ownerAvatarUrl: row.custom_avatar_path
          ? groupAvatarUrl(key, 64)
          : ownerUserId
            ? siteAvatarUrl({ discord_id: ownerUserId }, 64)
            : "/default-avatar.svg",
        memberCount: memberIds.length,
        onlineCount,
        isMember,
        isOwner,
        isPublic: !!Number(row.is_public || 0),
        publicEligible,
        publicVisible,
        commandsRequiredForPublic: COMMUNITY_GROUP_PUBLIC_MIN_COMMANDS,
        ownerCommandsSentTotal: Number(row.owner_commands_sent_total || 0),
        groupUrl: `/group/${encodeURIComponent(key)}`,
      };
    });
  }

  function buildCommunityGroupSearchClause(query, params) {
    const safeQuery = normalizeSearchQuery(query);
    if (!safeQuery) return "";

    const like = `%${safeQuery.toLowerCase()}%`;
    params.push(like, like, like, like, like);
    return `
      AND (
        LOWER(cg.name) LIKE ?
        OR LOWER(IFNULL(cg.description, '')) LIKE ?
        OR LOWER(cg.group_key) LIKE ?
        OR LOWER(IFNULL(u.username, '')) LIKE ?
        OR LOWER(IFNULL(u.global_name, '')) LIKE ?
      )
    `;
  }

  function createPagination(total, page, perPage) {
    const safeTotal = Math.max(0, Number(total || 0));
    const safePerPage = normalizePerPage(perPage);
    const totalPages = Math.max(1, Math.ceil(safeTotal / safePerPage));
    const safePage = Math.max(1, Math.min(normalizePage(page), totalPages));
    return {
      total: safeTotal,
      totalPages,
      page: safePage,
      perPage: safePerPage,
      offset: (safePage - 1) * safePerPage,
    };
  }

  function queryCommunityGroupPage({
    whereSql,
    params,
    orderParams = [],
    orderSql,
    page,
    perPage,
    viewerId,
  }) {
    const countRow = db
      .prepare(
        `
          SELECT COUNT(*) AS total
          FROM community_groups cg
          JOIN users u ON u.discord_id = cg.owner_user_id
          ${whereSql}
        `,
      )
      .get(...params);
    const pagination = createPagination(Number(countRow?.total || 0), page, perPage);

    const rows = db
      .prepare(
        `
          SELECT
            cg.group_key,
            cg.owner_user_id,
            cg.name,
            cg.description,
            IFNULL(cg.is_public, 0) AS is_public,
            cg.custom_avatar_path,
            cg.created_at,
            cg.updated_at,
            u.username AS owner_username,
            u.global_name AS owner_global_name,
            IFNULL(u.commands_sent_total, 0) AS owner_commands_sent_total
          FROM community_groups cg
          JOIN users u ON u.discord_id = cg.owner_user_id
          ${whereSql}
          ${orderSql}
          LIMIT ?
          OFFSET ?
        `,
      )
      .all(...params, ...orderParams, pagination.perPage, pagination.offset);

    return {
      groups: hydrateCommunityGroups(rows, viewerId),
      pagination: {
        total: pagination.total,
        totalPages: pagination.totalPages,
        page: pagination.page,
        perPage: pagination.perPage,
      },
    };
  }

  function listDiscoverCommunityGroups(viewerId, options = {}) {
    const safeViewerId = String(viewerId || "").trim();
    const query = normalizeSearchQuery(options.query);
    const perPage = normalizePerPage(options.perPage);

    const myParams = [];
    const myWhereParts = [];
    if (safeViewerId) {
      myParams.push(safeViewerId, safeViewerId);
      myWhereParts.push(`
        (
          cg.owner_user_id = ?
          OR EXISTS (
            SELECT 1
            FROM group_memberships gm
            WHERE gm.group_key = cg.group_key
              AND gm.user_id = ?
          )
        )
      `);
    } else {
      myWhereParts.push("0 = 1");
    }
    const mySearchClause = buildCommunityGroupSearchClause(query, myParams);
    const myPage = queryCommunityGroupPage({
      whereSql: `WHERE ${myWhereParts.join(" AND ")} ${mySearchClause}`,
      params: myParams,
      orderParams: safeViewerId ? [safeViewerId] : [],
      orderSql: safeViewerId
        ? `ORDER BY
            CASE WHEN cg.owner_user_id = ? THEN 0 ELSE 1 END,
            cg.updated_at DESC,
            cg.created_at DESC`
        : "ORDER BY cg.updated_at DESC, cg.created_at DESC",
      page: options.myPage,
      perPage,
      viewerId: safeViewerId,
    });

    const publicParams = [COMMUNITY_GROUP_PUBLIC_MIN_COMMANDS];
    let publicWhereSql = `
      WHERE IFNULL(cg.is_public, 0) = 1
        AND IFNULL(u.commands_sent_total, 0) >= ?
        AND NOT EXISTS (
          SELECT 1
          FROM bans b
          WHERE b.discord_id = cg.owner_user_id
        )
    `;
    if (safeViewerId) {
      publicWhereSql += `
        AND cg.owner_user_id <> ?
        AND NOT EXISTS (
          SELECT 1
          FROM group_memberships gm
          WHERE gm.group_key = cg.group_key
            AND gm.user_id = ?
        )
      `;
      publicParams.push(safeViewerId, safeViewerId);
    }
    publicWhereSql += buildCommunityGroupSearchClause(query, publicParams);
    const publicPage = queryCommunityGroupPage({
      whereSql: publicWhereSql,
      params: publicParams,
      orderSql: "ORDER BY cg.updated_at DESC, cg.created_at DESC",
      page: options.publicPage,
      perPage,
      viewerId: safeViewerId,
    });

    return {
      myGroups: myPage.groups,
      publicGroups: publicPage.groups,
      myPagination: myPage.pagination,
      publicPagination: publicPage.pagination,
      query,
      viewerCommandsSentTotal: getViewerCommandsSentTotal(safeViewerId),
      publicMinCommands: COMMUNITY_GROUP_PUBLIC_MIN_COMMANDS,
    };
  }

  function listDiscoverGroupsForUser(userId) {
    const groups = Array.from(loadGroupsCatalog().values()).map((group) => ({
      key: String(group.key || "").trim(),
      label: String(group.label || group.key || "").trim(),
      icon: String(group.icon || group.iconUrl || "").trim(),
    }));

    const safeUserId = String(userId || "").trim();
    if (!safeUserId) {
      return groups.map((group) => ({ ...group, is_member: 0 }));
    }

    const joinedRows = db
      .prepare(
        `
          SELECT group_key
          FROM group_memberships
          WHERE user_id=?
        `,
      )
      .all(safeUserId);
    const joinedSet = new Set(
      joinedRows.map((row) => String(row.group_key || "").trim()),
    );

    return groups.map((group) => ({
      ...group,
      is_member: joinedSet.has(group.key) ? 1 : 0,
    }));
  }

  app.get("/group/:key", requireDiscord, requireNotBanned, (req, res) => {
    const groupKey = String(req.params.key || "").trim();
    const viewerId = String(req.user.discord_id || "").trim();
    const access = getGroupAccess(groupKey, viewerId);
    if (!access.ok) {
      return res.status(access.statusCode || 404).send(access.message || "Unknown group");
    }
    const { group } = access;
    const staticGroup = group.kind === "static" ? group.row : null;
    const communityGroup = group.kind === "community" ? group.row : null;

    res.locals.groupKey = groupKey;
    res.locals.layoutBodyClass = "page-control-link";
    res.locals.layoutBodyDataControlTheme = "purple";

    res.locals.groupLabel = group.label;
    res.locals.groupIconUrl = group.icon || null;
    res.locals.groupBannerUrl = group.banner || "";
    res.locals.groupHasCustomAvatar = !!group.hasCustomAvatar;
    res.locals.groupHasCustomBanner = !!group.hasCustomBanner;
    res.locals.groupAvatarVersion = Number(group.avatarVersion || 0) || 0;
    res.locals.groupBannerVersion = Number(group.bannerVersion || 0) || 0;
    res.locals.groupAboutText =
      group.description ||
      `A shared space for the ${group.label} group. Join in to send commands and post in the group chat.`;
    res.locals.isCommunityGroup = !!communityGroup;
    res.locals.isOwner = access.isOwner;
    res.locals.canReportCommunityGroup = !!communityGroup && !access.isOwner;
    res.locals.communityGroupReportReasonOptions = Array.isArray(
      CONTROL_LINK_REPORT_REASON_OPTIONS,
    ) ? CONTROL_LINK_REPORT_REASON_OPTIONS : [];
    res.locals.communityGroupDescription = group.description;
    res.locals.isMember = access.isMember;
    res.locals.communityJoinRequired =
      !!communityGroup && !res.locals.isMember;
    res.locals.groupBoardMsgs = getGroupBoardMessages(groupKey);
    res.locals.canPostGroupBoard = access.canPost;
    res.locals.viewerIsGroupChatAdmin = !!isAdmin(viewerId);
    res.locals.groupChatReportReasonOptions = Array.isArray(
      GROUP_CHAT_REPORT_REASON_OPTIONS,
    ) ? GROUP_CHAT_REPORT_REASON_OPTIONS : [];
    res.locals.communityGroupCommandOptions = visibleCommunityGroupCommandOptions;
    res.locals.communityGroupCommandPrefs = serializeCommunityGroupCommandPrefs(
      groupKey,
    );
    res.locals.communityGroupHasAnyEnabledCommand =
      visibleCommunityGroupCommandOptions.some(
        (option) => !!res.locals.communityGroupCommandPrefs[option.field],
      ) || !communityGroup;

    res.locals.canSetWallpaperMedia = groupHasReportedCapability(
      groupKey,
      "set_wallpaper_media",
    );
    res.locals.setWallpaperUploadContext = res.locals.canSetWallpaperMedia
      ? "set_wallpaper_media"
      : "set_wallpaper";
    res.locals.uploadRecentItemsByContext = getRecentUploadsByContextForUser(
      req,
      viewerId,
    );

    const memberIds = getGroupMemberIds(groupKey);
    const presenceByUser = listPresenceByUserIds(memberIds);

    res.locals.memberCount = memberIds.length;
    res.locals.onlineCount = memberIds.reduce(
      (count, userId) => count + (presenceByUser.get(userId)?.online ? 1 : 0),
      0,
    );

    const viewerCommandsSentTotal = getViewerCommandsSentTotal(viewerId);
    res.locals.cooldownApplies = viewerCommandsSentTotal < 100;

    const groupControlTitle = `Control ${res.locals.groupLabel || "group"} group!`;

    renderWithLayout(res, "pages/group/grpcon_main", {
      title: groupControlTitle,
      meta: {
        ogTitle: groupControlTitle,
        ogDesc: `Send commands to the ${res.locals.groupLabel} group.`,
      },
    });
  });

  app.get(
    "/api/group/:key/board",
    requireDiscord,
    requireNotBanned,
    (req, res) => {
      const key = String(req.params.key || "").trim();
      const viewerId = String(req.user?.discord_id || "").trim();
      const access = getGroupAccess(key, viewerId);
      if (!access.ok) {
        return res.status(access.statusCode || 404).json({
          ok: false,
          error: access.error || "unknown_group",
        });
      }

      const messages = getGroupBoardMessages(key);
      const latestCreatedAt = messages.length
        ? Number(messages[0].created_at || 0)
        : 0;

      return res.json({
        ok: true,
        groupKey: key,
        canPost: !!access.canPost,
        latest_created_at: latestCreatedAt,
        messages,
      });
    },
  );

  app.post(
    "/api/group/:key/board",
    requireDiscord,
    requireNotBanned,
    (req, res) => {
      const key = String(req.params.key || "").trim();
      const viewerId = String(req.user?.discord_id || "").trim();
      const access = getGroupAccess(key, viewerId);
      if (!access.ok) {
        return res.status(access.statusCode || 404).json({
          ok: false,
          error: access.error || "unknown_group",
        });
      }
      if (!access.canPost) {
        return res.status(403).json({
          ok: false,
          error: "not_group_member",
          message: "Join this group before posting in chat.",
        });
      }

      let body = String(req.body?.body || "").replace(/\s+/g, " ").trim();
      if (!body) {
        return res.status(400).json({
          ok: false,
          message: "Message required.",
        });
      }
      if (body.length > GROUP_BOARD_MESSAGE_MAX_LEN) {
        body = body.slice(0, GROUP_BOARD_MESSAGE_MAX_LEN);
      }

      const createdAt = postGroupBoardMessageTx(key, viewerId, body);
      if (typeof deps.logEvent === "function") {
        deps.logEvent({
          type: "group_board_post",
          actorUserId: viewerId,
          req,
          payload: {
            groupKey: key,
            body,
            createdAt,
          },
        });
      }

      return res.json({
        ok: true,
        createdAt,
        messages: getGroupBoardMessages(key),
      });
    },
  );

  app.post(
    "/api/group/:key/board/:messageId/report",
    requireDiscord,
    requireNotBanned,
    (req, res) => {
      const key = String(req.params.key || "").trim();
      const messageId = Number(req.params.messageId);
      const viewerId = String(req.user?.discord_id || "").trim();
      const access = getGroupAccess(key, viewerId);
      if (!access.ok) {
        return res.status(access.statusCode || 404).json({
          ok: false,
          error: access.error || "unknown_group",
        });
      }
      if (!Number.isSafeInteger(messageId) || messageId <= 0) {
        return res.status(400).json({ ok: false, message: "Invalid message." });
      }

      const message = db
        .prepare(
          `
            SELECT
              gb.id,
              gb.group_key,
              gb.author_user_id,
              gb.body,
              gb.created_at,
              u.username,
              u.global_name,
              u.avatar,
              u.control_link_display_name
            FROM group_message_board gb
            LEFT JOIN users u ON u.discord_id=gb.author_user_id
            WHERE gb.group_key=? AND gb.id=?
          `,
        )
        .get(key, messageId);
      if (!message) {
        return res.status(404).json({ ok: false, message: "Message not found." });
      }
      if (String(message.author_user_id || "") === viewerId) {
        return res.status(400).json({
          ok: false,
          message: "You can't report your own message.",
        });
      }

      try {
        const created = createUserReport({
          subjectUserId: String(message.author_user_id || "").trim(),
          subjectUser: {
            discord_id: String(message.author_user_id || "").trim(),
            username: message.username || "",
            global_name: message.global_name || "",
            avatar: message.avatar || "",
            control_link_display_name: message.control_link_display_name || "",
          },
          reporterUser: req.user,
          reasonKey: req.body?.reason,
          reasonMap: GROUP_CHAT_REPORT_REASON_BY_KEY,
          details: req.body?.details,
          meta: {
            sourceKind: "group_chat_message",
            groupKey: key,
            groupLabel: access.group?.label || key,
            messageId,
            messageBody: String(message.body || ""),
            messageCreatedAt: Number(message.created_at || 0),
          },
          req,
        });

        return res.json({
          ok: true,
          reportId: created.report.id,
          message: "Message reported to the moderation team.",
        });
      } catch (err) {
        return res.status(400).json({
          ok: false,
          message: String(err?.message || "Could not report message."),
        });
      }
    },
  );

  app.post(
    "/api/group/:key/report",
    requireDiscord,
    requireNotBanned,
    (req, res) => {
      const key = String(req.params.key || "").trim();
      const viewerId = String(req.user?.discord_id || "").trim();
      const access = getGroupAccess(key, viewerId);
      if (!access.ok || access.group?.kind !== "community") {
        return res.status(access.statusCode || 404).json({
          ok: false,
          message: access.message || "Unknown community group.",
        });
      }
      if (access.isOwner) {
        return res.status(400).json({
          ok: false,
          message: "You can't report your own community group.",
        });
      }

      try {
        const created = createCommunityGroupReport({
          groupKey: key,
          groupName: access.group?.label || key,
          ownerUserId: access.group?.ownerUserId || "",
          reporterUser: req.user,
          reasonKey: req.body?.reason,
          reasonMap: CONTROL_LINK_REPORT_REASON_BY_KEY,
          details: req.body?.details,
          meta: {
            groupUrl: `/group/${encodeURIComponent(key)}`,
            isPublic: !!Number(access.group?.row?.is_public || 0),
          },
          req,
        });

        return res.json({
          ok: true,
          reportId: created.report.id,
          message: "Report sent. Thank you.",
        });
      } catch (err) {
        return res.status(400).json({
          ok: false,
          message: String(err?.message || "Could not send that report."),
        });
      }
    },
  );

  app.delete(
    "/api/group/:key/board/:messageId",
    requireDiscord,
    requireNotBanned,
    (req, res) => {
      const key = String(req.params.key || "").trim();
      const messageId = Number(req.params.messageId);
      const adminId = String(req.user?.discord_id || "").trim();
      if (!isAdmin(adminId)) {
        return res.status(403).json({ ok: false, message: "Admin access required." });
      }
      const access = getGroupAccess(key, adminId);
      if (!access.ok) {
        return res.status(access.statusCode || 404).json({
          ok: false,
          error: access.error || "unknown_group",
        });
      }
      if (!Number.isSafeInteger(messageId) || messageId <= 0) {
        return res.status(400).json({ ok: false, message: "Invalid message." });
      }

      const message = db
        .prepare(
          `SELECT id, author_user_id, body, created_at
           FROM group_message_board
           WHERE group_key=? AND id=?`,
        )
        .get(key, messageId);
      if (!message) {
        return res.status(404).json({ ok: false, message: "Message not found." });
      }

      db.prepare(`DELETE FROM group_message_board WHERE group_key=? AND id=?`)
        .run(key, messageId);

      if (typeof deps.logEvent === "function") {
        deps.logEvent({
          type: "group_board_message_deleted",
          actorUserId: adminId,
          targetUserId: String(message.author_user_id || "").trim() || null,
          req,
          payload: {
            groupKey: key,
            messageId,
            messageBody: String(message.body || ""),
            messageCreatedAt: Number(message.created_at || 0),
          },
        });
      }

      return res.json({
        ok: true,
        message: "Message deleted.",
        messages: getGroupBoardMessages(key),
      });
    },
  );

  api.get("/user/:pairCode", (req, res) => {
    const pairCode = String(req.params.pairCode || "").trim();
    const row = db
      .prepare(
        `
          SELECT
            u.discord_id,
            u.username,
            u.global_name,
            u.avatar,
            pc.code_plain,
            IFNULL(u.whitelist_enabled, 0) AS whitelist_enabled,
            IFNULL(u.discoverable, 0) AS discoverable
          FROM pair_codes pc
          JOIN users u ON u.discord_id = pc.user_id
          WHERE pc.code_plain = ?
            AND NOT EXISTS (
              SELECT 1
              FROM bans b
              WHERE b.discord_id = u.discord_id
            )
        `,
      )
      .get(pairCode);

    if (!row) {
      return res.status(404).json({ ok: false, code: "USER_NOT_FOUND" });
    }

    const presence = getUserPresenceState(row.discord_id);

    return res.json({
      ok: true,
      user: {
        displayName: row.global_name || row.username || row.discord_id,
        username: row.username || null,
        discordId: row.discord_id,
        pairCode: row.code_plain,
        avatarUrl: discordAvatarUrl(row, 128),
        status: presence.status,
        online: !!presence.online,
        away: !!presence.away,
        awayUntil: Number(presence.awayUntil || 0),
        discoverable: !!row.discoverable,
        whitelistEnabled: !!row.whitelist_enabled,
      },
    });
  });

  app.get("/discover", requireNotBanned, (req, res) => {
    const viewerId = String(req.viewUser?.discord_id || "").trim();
    const requestedMode = String(req.query.tab || "").trim().toLowerCase();
    res.locals.groups = listDiscoverGroupsForUser(viewerId);
    res.locals.discoverInitialMode = ["groups", "community"].includes(requestedMode)
      ? requestedMode
      : "users";
    res.locals.communityPublicMinCommands = COMMUNITY_GROUP_PUBLIC_MIN_COMMANDS;
    res.locals.communityInviteCode = normalizeCommunityInviteCode(
      viewerId ? req.query.communityInvite : "",
    );

    renderWithLayout(res, "pages/discover/dsc_main", {
      title: "Discover",
    });
  });

  api.get("/discover", (req, res) => {
    const now = Date.now();
    const statuses = [];
    if (String(req.query.online ?? "1").trim() !== "0") statuses.push("online");
    if (String(req.query.away ?? "0").trim() !== "0") statuses.push("away");

    const users = listFilteredDiscoverUsers({
      now,
      query: req.query.q,
      statuses,
    });

    res.json({
      ok: true,
      code: "OK",
      users: users.map((user) => ({
        displayName: user.displayName,
        username: user.username || null,
        discordId: user.discordId,
        pairCode: user.pairCode,
        avatarUrl: discordAvatarUrl(user, 128),
        online: !!user.online,
      })),
    });
  });

  app.get(
    "/api/community/discover",
    requireNotBanned,
    (req, res) => {
      const viewerId = String(req.viewUser?.discord_id || "").trim();
      return res.json({
        ok: true,
        ...listDiscoverCommunityGroups(viewerId, {
          query: req.query.q,
          myPage: req.query.myPage,
          publicPage: req.query.publicPage,
          perPage: req.query.perPage,
        }),
      });
    },
  );

  app.post(
    "/api/community/groups",
    requireDiscord,
    requireNotBanned,
    (req, res) => {
      const ownerUserId = String(req.user?.discord_id || "").trim();
      if (!ownerUserId) {
        return res.status(401).json({ ok: false, error: "unauthorized" });
      }

      const name = normalizeCommunityGroupName(req.body?.name);
      const description = normalizeCommunityGroupDescription(req.body?.description);
      const requestedPublic = toBoolean(req.body?.isPublic);
      if (!name) {
        return res.status(400).json({ ok: false, error: "missing_name" });
      }

      const ownerCommandsSentTotal = getViewerCommandsSentTotal(ownerUserId);
      const publicEligible =
        ownerCommandsSentTotal >= COMMUNITY_GROUP_PUBLIC_MIN_COMMANDS;
      const createdPublic = requestedPublic && publicEligible;
      const groupKey = buildCommunityGroupKey(name);
      const now = Date.now();

      const tx = db.transaction(() => {
        db.prepare(
          `
            INSERT INTO community_groups (
              group_key,
              owner_user_id,
              name,
              description,
              is_public,
              created_at,
              updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `,
        ).run(
          groupKey,
          ownerUserId,
          name,
          description || null,
          createdPublic ? 1 : 0,
          now,
          now,
        );
        db.prepare(
          `
            INSERT OR IGNORE INTO group_memberships (group_key, user_id, joined_at)
            VALUES (?, ?, ?)
          `,
        ).run(groupKey, ownerUserId, now);
        db.prepare(
          `
            INSERT OR IGNORE INTO community_group_command_prefs (
              group_key,
              updated_at
            ) VALUES (?, ?)
          `,
        ).run(groupKey, now);
      });
      tx();

      const group = hydrateCommunityGroups(
        [getCommunityGroupRecord(groupKey)],
        ownerUserId,
      )[0];

      return res.json({
        ok: true,
        group,
        requestedPublic,
        createdPublic,
        publicEligible,
        publicMinCommands: COMMUNITY_GROUP_PUBLIC_MIN_COMMANDS,
      });
    },
  );

  app.post(
    "/api/community/groups/:key/visibility",
    requireDiscord,
    requireNotBanned,
    (req, res) => {
      const userId = String(req.user?.discord_id || "").trim();
      const key = String(req.params.key || "").trim();
      const group = getCommunityGroupRecord(key);
      if (!group) {
        return res.status(404).json({ ok: false, error: "unknown_group" });
      }
      if (String(group.owner_user_id || "").trim() !== userId) {
        return res.status(403).json({ ok: false, error: "not_owner" });
      }

      const nextPublic = toBoolean(req.body?.isPublic);
      const ownerCommandsSentTotal = getViewerCommandsSentTotal(userId);
      if (
        nextPublic &&
        ownerCommandsSentTotal < COMMUNITY_GROUP_PUBLIC_MIN_COMMANDS
      ) {
        return res.status(403).json({
          ok: false,
          error: "public_threshold_not_met",
          required: COMMUNITY_GROUP_PUBLIC_MIN_COMMANDS,
          have: ownerCommandsSentTotal,
        });
      }

      db.prepare(
        `
          UPDATE community_groups
          SET is_public=?, updated_at=?
          WHERE group_key=?
        `,
      ).run(nextPublic ? 1 : 0, Date.now(), key);

      return res.json({
        ok: true,
        group: hydrateCommunityGroups([getCommunityGroupRecord(key)], userId)[0],
      });
    },
  );

  app.post(
    "/api/community/groups/:key/commands",
    requireDiscord,
    requireNotBanned,
    (req, res) => {
      const userId = String(req.user?.discord_id || "").trim();
      const key = String(req.params.key || "").trim();
      const group = getCommunityGroupRecord(key);
      if (!group) {
        return res.status(404).json({ ok: false, error: "unknown_group" });
      }
      if (String(group.owner_user_id || "").trim() !== userId) {
        return res.status(403).json({ ok: false, error: "not_owner" });
      }

      const prefs = normalizeCommunityGroupCommandPrefsInput(req.body, key);
      const now = Date.now();
      db.prepare(
        `
          INSERT INTO community_group_command_prefs (
            group_key,
            allow_popup,
            allow_open_url,
            allow_image_popup,
            allow_fullscreen_popup,
            allow_spiral_overlay,
            allow_set_wallpaper,
            allow_play_sound,
            allow_write_for_me,
            allow_subliminal_message,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(group_key) DO UPDATE SET
            allow_popup=excluded.allow_popup,
            allow_open_url=excluded.allow_open_url,
            allow_image_popup=excluded.allow_image_popup,
            allow_fullscreen_popup=excluded.allow_fullscreen_popup,
            allow_spiral_overlay=excluded.allow_spiral_overlay,
            allow_set_wallpaper=excluded.allow_set_wallpaper,
            allow_play_sound=excluded.allow_play_sound,
            allow_write_for_me=excluded.allow_write_for_me,
            allow_subliminal_message=excluded.allow_subliminal_message,
            updated_at=excluded.updated_at
        `,
      ).run(
        key,
        prefs.allow_popup,
        prefs.allow_open_url,
        prefs.allow_image_popup,
        prefs.allow_fullscreen_popup,
        prefs.allow_spiral_overlay,
        prefs.allow_set_wallpaper,
        prefs.allow_play_sound,
        prefs.allow_write_for_me,
        prefs.allow_subliminal_message,
        now,
      );

      return res.json({
        ok: true,
        prefs: serializeCommunityGroupCommandPrefs(key),
      });
    },
  );

  app.post(
    "/api/community/groups/:key/profile",
    requireDiscord,
    requireNotBanned,
    (req, res) => {
      const userId = String(req.user?.discord_id || "").trim();
      const key = String(req.params.key || "").trim();
      const group = getCommunityGroupRecord(key);
      if (!group) {
        return res.status(404).json({ ok: false, error: "unknown_group" });
      }
      if (String(group.owner_user_id || "").trim() !== userId) {
        return res.status(403).json({ ok: false, error: "not_owner" });
      }

      const name = normalizeCommunityGroupName(req.body?.name);
      if (!name) {
        return res.status(400).json({
          ok: false,
          error: "name_required",
          message: "Group name is required.",
        });
      }

      const description = normalizeCommunityGroupDescription(req.body?.description);
      const now = Date.now();
      db.prepare(
        `
          UPDATE community_groups
          SET name=?, description=?, updated_at=?
          WHERE group_key=?
        `,
      ).run(name, description, now, key);

      if (typeof deps.logEvent === "function") {
        deps.logEvent({
          type: "community_group_profile_updated",
          actorUserId: userId,
          req,
          payload: { groupKey: key, name, description },
        });
      }

      const nextGroup = getResolvedGroupForKey(key);
      return res.json({
        ok: true,
        group: {
          key,
          name,
          description,
          iconUrl: nextGroup?.icon || "",
          bannerUrl: nextGroup?.banner || "",
          hasCustomAvatar: !!nextGroup?.hasCustomAvatar,
          hasCustomBanner: !!nextGroup?.hasCustomBanner,
          avatarVersion: Number(nextGroup?.avatarVersion || 0) || 0,
          bannerVersion: Number(nextGroup?.bannerVersion || 0) || 0,
        },
      });
    },
  );

  app.delete(
    "/api/community/groups/:key",
    requireDiscord,
    requireNotBanned,
    (req, res) => {
      const userId = String(req.user?.discord_id || "").trim();
      const key = String(req.params.key || "").trim();
      const group = getCommunityGroupRecord(key);
      if (!group) {
        return res.status(404).json({ ok: false, error: "unknown_group" });
      }
      if (String(group.owner_user_id || "").trim() !== userId) {
        return res.status(403).json({ ok: false, error: "not_owner" });
      }

      const tx = db.transaction(() => {
        if (typeof clearCustomCommunityGroupAvatar === "function") {
          clearCustomCommunityGroupAvatar(key);
        }
        if (typeof clearCustomCommunityGroupBanner === "function") {
          clearCustomCommunityGroupBanner(key);
        }
        db.prepare(`DELETE FROM group_message_board WHERE group_key=?`).run(key);
        db.prepare(`DELETE FROM group_memberships WHERE group_key=?`).run(key);
        db.prepare(`DELETE FROM community_group_invites WHERE group_key=?`).run(key);
        db.prepare(`DELETE FROM community_group_command_prefs WHERE group_key=?`).run(key);
        db.prepare(`DELETE FROM community_groups WHERE group_key=?`).run(key);
      });
      tx();

      if (typeof deps.logEvent === "function") {
        deps.logEvent({
          type: "community_group_deleted",
          actorUserId: userId,
          req,
          payload: {
            groupKey: key,
            name: String(group.name || "").trim(),
          },
        });
      }

      return res.json({
        ok: true,
        redirectUrl: "/discover?tab=community",
      });
    },
  );

  function handleCommunityGroupAssetUpload(req, res, kind) {
    const userId = String(req.user?.discord_id || "").trim();
    const key = String(req.params.key || "").trim();
    const group = getCommunityGroupRecord(key);
    if (!group) {
      return res.status(404).json({ ok: false, error: "unknown_group" });
    }
    if (String(group.owner_user_id || "").trim() !== userId) {
      return res.status(403).json({ ok: false, error: "not_owner" });
    }

    const setter =
      kind === "banner"
        ? setCustomCommunityGroupBanner
        : setCustomCommunityGroupAvatar;
    if (typeof setter !== "function") {
      return res.status(500).json({
        ok: false,
        message: "Group image uploads are not configured.",
      });
    }

    const result = setter(key, {
      filename: req.body?.filename,
      mime: req.body?.mime,
      data: req.body?.data,
    });

    if (!result.ok) {
      return res.status(result.status || 400).json({
        ok: false,
        message: result.message || "Could not update image.",
      });
    }

    if (typeof deps.logEvent === "function") {
      deps.logEvent({
        type:
          kind === "banner"
            ? "community_group_banner_updated"
            : "community_group_avatar_updated",
        actorUserId: userId,
        req,
        payload: {
          groupKey: key,
          mime: result.mime,
          updatedAt: result.updatedAt,
        },
      });
    }

    return res.json({
      ok: true,
      updatedAt: result.updatedAt,
      hasCustomAvatar: kind === "avatar" ? true : !!group.custom_avatar_path,
      hasCustomBanner: kind === "banner" ? true : !!group.custom_banner_path,
      avatarUrl: groupAvatarUrl(key, 128),
      bannerUrl: kind === "banner" ? groupBannerUrl(key, 1600) : "",
    });
  }

  function handleCommunityGroupAssetDelete(req, res, kind) {
    const userId = String(req.user?.discord_id || "").trim();
    const key = String(req.params.key || "").trim();
    const group = getCommunityGroupRecord(key);
    if (!group) {
      return res.status(404).json({ ok: false, error: "unknown_group" });
    }
    if (String(group.owner_user_id || "").trim() !== userId) {
      return res.status(403).json({ ok: false, error: "not_owner" });
    }

    const clearer =
      kind === "banner"
        ? clearCustomCommunityGroupBanner
        : clearCustomCommunityGroupAvatar;
    if (typeof clearer !== "function") {
      return res.status(500).json({
        ok: false,
        message: "Group image uploads are not configured.",
      });
    }

    const result = clearer(key);
    if (!result.ok) {
      return res.status(result.status || 400).json({
        ok: false,
        message: result.message || "Could not remove image.",
      });
    }

    if (typeof deps.logEvent === "function") {
      deps.logEvent({
        type:
          kind === "banner"
            ? "community_group_banner_removed"
            : "community_group_avatar_removed",
        actorUserId: userId,
        req,
        payload: { groupKey: key, updatedAt: result.updatedAt },
      });
    }

    return res.json({
      ok: true,
      updatedAt: result.updatedAt,
      hasCustomAvatar: kind === "avatar" ? false : !!group.custom_avatar_path,
      hasCustomBanner: kind === "banner" ? false : !!group.custom_banner_path,
      avatarUrl:
        kind === "avatar" && group.owner_user_id
          ? siteAvatarUrl({ discord_id: group.owner_user_id }, 128)
          : groupAvatarUrl(key, 128),
      bannerUrl: "",
    });
  }

  app.post(
    "/api/community/groups/:key/avatar",
    requireDiscord,
    requireNotBanned,
    (req, res) => handleCommunityGroupAssetUpload(req, res, "avatar"),
  );

  app.post(
    "/api/community/groups/:key/avatar/delete",
    requireDiscord,
    requireNotBanned,
    (req, res) => handleCommunityGroupAssetDelete(req, res, "avatar"),
  );

  app.post(
    "/api/community/groups/:key/banner",
    requireDiscord,
    requireNotBanned,
    (req, res) => handleCommunityGroupAssetUpload(req, res, "banner"),
  );

  app.post(
    "/api/community/groups/:key/banner/delete",
    requireDiscord,
    requireNotBanned,
    (req, res) => handleCommunityGroupAssetDelete(req, res, "banner"),
  );

  app.post(
    "/api/community/groups/:key/invite",
    requireDiscord,
    requireNotBanned,
    (req, res) => {
      const userId = String(req.user?.discord_id || "").trim();
      const key = String(req.params.key || "").trim();
      const group = getCommunityGroupRecord(key);
      if (!group) {
        return res.status(404).json({ ok: false, error: "unknown_group" });
      }
      if (String(group.owner_user_id || "").trim() !== userId) {
        return res.status(403).json({ ok: false, error: "not_owner" });
      }

      const code = crypto.randomBytes(18).toString("base64url");
      const now = Date.now();
      const tx = db.transaction(() => {
        db.prepare(
          `
            UPDATE community_group_invites
            SET revoked_at=?
            WHERE group_key=?
              AND IFNULL(revoked_at, 0) = 0
          `,
        ).run(now, key);
        db.prepare(
          `
            INSERT INTO community_group_invites (
              code,
              group_key,
              created_by_user_id,
              created_at
            ) VALUES (?, ?, ?, ?)
          `,
        ).run(code, key, userId, now);
      });
      tx();

      return res.json({
        ok: true,
        code,
        invitePath: `/discover?communityInvite=${encodeURIComponent(code)}`,
        expiresAt: now + COMMUNITY_GROUP_INVITE_TTL_MS,
      });
    },
  );

  app.get(
    "/api/community/invites/preview",
    requireDiscord,
    requireNotBanned,
    (req, res) => {
      const userId = String(req.user?.discord_id || "").trim();
      const code = normalizeCommunityInviteCode(req.query?.code);
      if (!code) {
        return res.status(400).json({ ok: false, error: "missing_code" });
      }

      const invite = db
        .prepare(
          `
            SELECT
              i.code,
              i.group_key,
              i.created_at,
              i.revoked_at
            FROM community_group_invites i
            JOIN community_groups cg ON cg.group_key = i.group_key
            WHERE i.code=?
            LIMIT 1
          `,
        )
        .get(code);
      if (!isCommunityInviteActive(invite)) {
        return res.status(404).json({ ok: false, error: "invalid_invite" });
      }

      return res.json({
        ok: true,
        expiresAt: Number(invite.created_at || 0) + COMMUNITY_GROUP_INVITE_TTL_MS,
        group: hydrateCommunityGroups(
          [getCommunityGroupRecord(invite.group_key)],
          userId,
        )[0],
      });
    },
  );

  app.post(
    "/api/community/invites/join",
    requireDiscord,
    requireNotBanned,
    (req, res) => {
      const userId = String(req.user?.discord_id || "").trim();
      const code = normalizeCommunityInviteCode(req.body?.code);
      if (!code) {
        return res.status(400).json({ ok: false, error: "missing_code" });
      }

      const invite = db
        .prepare(
          `
            SELECT
              i.code,
              i.group_key,
              i.revoked_at,
              i.created_at,
              cg.owner_user_id
            FROM community_group_invites i
            JOIN community_groups cg ON cg.group_key = i.group_key
            WHERE i.code=?
            LIMIT 1
          `,
        )
        .get(code);
      if (!isCommunityInviteActive(invite)) {
        return res.status(404).json({ ok: false, error: "invalid_invite" });
      }

      ensureGroupMembership(invite.group_key, userId);

      return res.json({
        ok: true,
        group: hydrateCommunityGroups(
          [getCommunityGroupRecord(invite.group_key)],
          userId,
        )[0],
      });
    },
  );

  app.post(
    "/api/group/:key/join",
    requireDiscord,
    requireNotBanned,
    (req, res) => {
      const userId = String(req.user?.discord_id || "").trim();
      if (!userId) {
        return res.status(401).json({ ok: false, error: "unauthorized" });
      }

      const key = String(req.params.key || "").trim();
      const communityGroup = getCommunityGroupRecord(key);
      if (communityGroup) {
        const ownerUserId = String(communityGroup.owner_user_id || "").trim();
        if (ownerUserId === userId) {
          ensureGroupMembership(key, userId);
          return res.json({
            ok: true,
            joined: true,
            isMember: true,
            isOwner: true,
          });
        }

        if (!isCommunityGroupPubliclyVisible(communityGroup)) {
          return res.status(403).json({
            ok: false,
            error: "invite_required",
            message: "This community group is private.",
          });
        }

        ensureGroupMembership(key, userId);
        return res.json({
          ok: true,
          joined: true,
          isMember: true,
          isOwner: false,
        });
      }

      const groupsByKey = loadGroupsCatalog();
      if (!groupsByKey.has(key)) {
        return res.status(404).json({ ok: false, error: "unknown_group" });
      }

      ensureGroupMembership(key, userId);

      return res.json({ ok: true, joined: true, isMember: true, isOwner: false });
    },
  );

  app.post(
    "/api/group/:key/leave",
    requireDiscord,
    requireNotBanned,
    (req, res) => {
      const userId = String(req.user?.discord_id || "").trim();
      if (!userId) {
        return res.status(401).json({ ok: false, error: "unauthorized" });
      }

      const key = String(req.params.key || "").trim();
      const communityGroup = getCommunityGroupRecord(key);
      if (communityGroup) {
        if (String(communityGroup.owner_user_id || "").trim() === userId) {
          return res.status(409).json({
            ok: false,
            error: "owner_cannot_leave",
            message: "Owners stay in their own community groups for now.",
          });
        }
      }

      const tx = db.transaction(() => {
        db.prepare(
          `
            DELETE FROM group_memberships
            WHERE group_key = ? AND user_id = ?
          `,
        ).run(key, userId);

        if (communityGroup && !isCommunityGroupPubliclyVisible(communityGroup)) {
          db.prepare(
            `
              UPDATE community_group_invites
              SET revoked_at=?
              WHERE group_key=?
                AND IFNULL(revoked_at, 0) = 0
            `,
          ).run(Date.now(), key);
        }
      });
      tx();

      return res.json({ ok: true, joined: false, isMember: false, isOwner: false });
    },
  );

  app.get("/favorites", (req, res) => {
    if (!req.viewUser) return res.redirect("/login");

    const viewerId = String(req.viewUser.discord_id || "").trim();
    const rows = db
      .prepare(
        `
          SELECT
            f.favorite_user_id AS discord_id,
            f.created_at AS favorited_at,
            u.username,
            u.global_name,
            u.avatar,
            u.custom_banner_path,
            u.custom_banner_updated_at,
            pc.code_plain
          FROM favorites f
          JOIN users u ON u.discord_id = f.favorite_user_id
          LEFT JOIN pair_codes pc ON pc.user_id = u.discord_id
          WHERE f.user_id = ?
          ORDER BY f.created_at ASC
        `,
      )
      .all(viewerId);

    const presenceByUser = listPresenceByUserIds(
      rows.map((row) => row.discord_id),
    );
    const onlineRows = [];
    const awayRows = [];
    const offlineRows = [];

    for (const row of rows) {
      const presence = presenceByUser.get(row.discord_id) || null;
      const decorated = {
        ...row,
        status: presence?.status || "offline",
        online: !!presence?.online,
        away: !!presence?.away,
        awayUntil: Number(presence?.awayUntil || 0),
      };
      if (decorated.status === "online") {
        onlineRows.push(decorated);
      } else if (decorated.status === "away") {
        awayRows.push(decorated);
      } else {
        offlineRows.push(decorated);
      }
    }

    const sortByOldest = (left, right) => {
      const leftTime = Number(left.favorited_at || 0);
      const rightTime = Number(right.favorited_at || 0);
      if (leftTime !== rightTime) return leftTime - rightTime;

      return String(left.discord_id || "").localeCompare(
        String(right.discord_id || ""),
      );
    };

    onlineRows.sort(sortByOldest);
    awayRows.sort(sortByOldest);
    offlineRows.sort(sortByOldest);

    res.locals.favUsers = onlineRows.concat(awayRows, offlineRows);

    renderWithLayout(res, "pages/favorites/fav_main", {
      title: "Favorites",
    });
  });
}

module.exports = { registerDiscoveryRoutes };
