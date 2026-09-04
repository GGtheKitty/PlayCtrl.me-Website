const HOME_LEADERBOARD_LIMIT = 10;
const ADMIN_ACTIVITY_RANGE_24H = "24h";
const ADMIN_ACTIVITY_RANGE_7D = "7d";

function createAdminActivityService({ db, HOUR_MS, DAY_MS, formatCountLabel }) {
  function clampLeaderboardLimit(limit, fallback = HOME_LEADERBOARD_LIMIT) {
    const n = Number(limit || fallback);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(50, Math.floor(n));
  }

  function getUtcDayWindow(nowMs = Date.now()) {
    const now = new Date(Number(nowMs || Date.now()));
    const startMs = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
    );

    return {
      startMs,
      endMs: startMs + DAY_MS,
      isoDate: new Date(startMs).toISOString().slice(0, 10),
    };
  }

  function floorToUtcHourStart(ms = Date.now()) {
    const d = new Date(Number(ms || Date.now()));
    return Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate(),
      d.getUTCHours(),
    );
  }

  function floorToUtcDayStart(ms = Date.now()) {
    const d = new Date(Number(ms || Date.now()));
    return Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate(),
    );
  }

  function formatAdminActivityAverage(value) {
    const n = Number(value || 0);
    if (!Number.isFinite(n)) return "0";
    return Number.isInteger(n) ? String(n) : n.toFixed(1);
  }

  function formatAdminActivityHourTick(ms, index) {
    const d = new Date(ms);
    const hour = d.getUTCHours();
    const hour12 = ((hour + 11) % 12) + 1;
    const suffix = hour >= 12 ? "p" : "a";
    if (index % 3 !== 0 && index !== 23) return "";
    return `${hour12}${suffix}`;
  }

  function formatAdminActivityDayTick(ms) {
    return new Date(ms).toLocaleDateString("en-US", {
      weekday: "short",
      timeZone: "UTC",
    });
  }

  function formatAdminActivityHourLabel(ms) {
    return (
      new Date(ms).toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        hour12: true,
        timeZone: "UTC",
      }) + " UTC"
    );
  }

  function formatAdminActivityDayLabel(ms) {
    return (
      new Date(ms).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      }) + " UTC"
    );
  }

  function buildAdminActivitySeries({
    key,
    label,
    bucketLabel,
    description,
    rangeSummary,
    startMs,
    bucketMs,
    counts,
    tickLabelFn,
    pointLabelFn,
  }) {
    const safeCounts = Array.isArray(counts) ? counts : [];
    const totalCount = safeCounts.reduce(
      (sum, count) => sum + Number(count || 0),
      0,
    );
    const maxCount = safeCounts.reduce(
      (max, count) => Math.max(max, Number(count || 0)),
      0,
    );

    const points = safeCounts.map((rawCount, index) => {
      const count = Math.max(0, Number(rawCount || 0));
      const bucketStart = startMs + index * bucketMs;
      const tooltip = `${pointLabelFn(bucketStart)}: ${formatCountLabel(count, "command")}`;

      return {
        index,
        count,
        countLabel: count.toLocaleString(),
        tickLabel: tickLabelFn(bucketStart, index),
        tooltip,
        heightPct:
          maxCount > 0 && count > 0
            ? Math.max(8, Math.round((count / maxCount) * 100))
            : 0,
        isPeak: maxCount > 0 && count === maxCount,
      };
    });

    const peakPoint = points.find((point) => point.isPeak) || null;

    return {
      key,
      label,
      bucketLabel,
      description,
      rangeSummary,
      totalCount,
      totalLabel: totalCount.toLocaleString(),
      maxCount,
      maxLabel: maxCount.toLocaleString(),
      averageCount: safeCounts.length ? totalCount / safeCounts.length : 0,
      averageLabel: formatAdminActivityAverage(
        safeCounts.length ? totalCount / safeCounts.length : 0,
      ),
      peakLabel: peakPoint
        ? peakPoint.tooltip
        : `No ${bucketLabel.toLowerCase()} activity recorded.`,
      hasData: maxCount > 0,
      points,
    };
  }

  function getAdminCommandActivityDatasets(nowMs = Date.now()) {
    const safeNowMs = Number(nowMs || Date.now());
    const hourlyEndStart = floorToUtcHourStart(safeNowMs);
    const dailyEndStart = floorToUtcDayStart(safeNowMs);
    const hourlyStart = hourlyEndStart - 23 * HOUR_MS;
    const dailyStart = dailyEndStart - 6 * DAY_MS;
    const queryStart = Math.min(hourlyStart, dailyStart);
    const queryEnd = Math.max(hourlyEndStart + HOUR_MS, dailyEndStart + DAY_MS);

    const rows = db
      .prepare(
        `
          SELECT created_at
          FROM command_send_counts
          WHERE created_at >= ?
            AND created_at < ?
          ORDER BY created_at ASC
        `,
      )
      .all(queryStart, queryEnd);

    const hourlyCounts = Array.from({ length: 24 }, () => 0);
    const dailyCounts = Array.from({ length: 7 }, () => 0);

    for (const row of rows) {
      const createdAt = Number(row?.created_at || 0);
      if (!createdAt) continue;

      if (createdAt >= hourlyStart && createdAt < hourlyEndStart + HOUR_MS) {
        const hourlyIndex = Math.floor((createdAt - hourlyStart) / HOUR_MS);
        if (hourlyIndex >= 0 && hourlyIndex < hourlyCounts.length) {
          hourlyCounts[hourlyIndex] += 1;
        }
      }

      if (createdAt >= dailyStart && createdAt < dailyEndStart + DAY_MS) {
        const dailyIndex = Math.floor((createdAt - dailyStart) / DAY_MS);
        if (dailyIndex >= 0 && dailyIndex < dailyCounts.length) {
          dailyCounts[dailyIndex] += 1;
        }
      }
    }

    const hourly = buildAdminActivitySeries({
      key: ADMIN_ACTIVITY_RANGE_24H,
      label: "24 Hours",
      bucketLabel: "Hour",
      description: "Command sends per UTC hour across the last 24 hours.",
      rangeSummary:
        `${formatAdminActivityHourLabel(hourlyStart)} through ` +
        `${formatAdminActivityHourLabel(hourlyEndStart)}`,
      startMs: hourlyStart,
      bucketMs: HOUR_MS,
      counts: hourlyCounts,
      tickLabelFn: formatAdminActivityHourTick,
      pointLabelFn: formatAdminActivityHourLabel,
    });

    const daily = buildAdminActivitySeries({
      key: ADMIN_ACTIVITY_RANGE_7D,
      label: "7 Days",
      bucketLabel: "Day",
      description: "Command sends per UTC day across the last 7 days.",
      rangeSummary:
        `${formatAdminActivityDayLabel(dailyStart)} through ` +
        `${formatAdminActivityDayLabel(dailyEndStart)}`,
      startMs: dailyStart,
      bucketMs: DAY_MS,
      counts: dailyCounts,
      tickLabelFn: formatAdminActivityDayTick,
      pointLabelFn: formatAdminActivityDayLabel,
    });

    return { hourly, daily };
  }

  return {
    ADMIN_ACTIVITY_RANGE_24H,
    ADMIN_ACTIVITY_RANGE_7D,
    HOME_LEADERBOARD_LIMIT,
    clampLeaderboardLimit,
    getAdminCommandActivityDatasets,
    getUtcDayWindow,
  };
}

module.exports = {
  createAdminActivityService,
};
