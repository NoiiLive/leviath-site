// Leviath backend: your games, contact details, live Roblox numbers, the growth history and the pitch form.
// Everything you'd want to change is in Settings below. Backend code runs on Wix's servers; visitors never see this file.
import { fetch } from "wix-fetch";
import wixData from "wix-data";

/* ───────────────────────── Settings ───────────────────────── */

export const SITE = { name: "Leviath", groupId: 11280027 };

// Contact details and links shown on the site.
export const SITE_INFO = {
  name: "Leviath",
  groupUrl: "https://www.roblox.com/communities/11280027/Leviath",
  ownerName: "Noii",
  ownerUsername: "noiixn",
  ownerProfileUrl: "https://www.roblox.com/users/342662401/profile",
  email: "acquisition@leviath.co",
  discordUsername: "noiilive",
  discordInvite: "https://discord.gg/nK8Eej4nXq",
  showOpenSlot: true, // the "Your game here" card at the end of the Games page
  refreshSeconds: 30, // how often live numbers refresh on the page
  // Numbers only you can see in Roblox's Creator Dashboard. Add any and they show as highlight tiles on the
  // Home and Stats pages, e.g. { value: "2,000+", label: "Peak players at once", note: "JoJo's Bizarre Incremental, April 2026" }
  highlights: [],
};

// Games on the site, in display order. Add a line to add a game, then publish.
//   placeId: the number in the game's link (roblox.com/games/<placeId>/...)
//   role:    the gold line under the title, e.g. "Developed & published", "Partner stake", "Managed by Leviath"
//   tag:     optional chip on the thumbnail. Leave it out to use a [TAG] at the start of the Roblox title.
//   name:    optional, replaces the Roblox title
export const GAMES = [
  { placeId: 106022825094913, role: "Developed & published" },
  { placeId: 127685019935711, role: "Developed & published" },
];

// Pitches are saved to the LeviathPitches collection in your CMS, and also posted to Discord through the
// webhook saved in CMS → LeviathSettings → the "discordWebhook" item. It's kept there rather than in this
// file so it never ends up in your code repository. To change it, edit that item's Value in the CMS.

// The first time this site records its stats, it copies the history your earlier Cloudflare version of the
// site recorded, so the growth charts don't start from zero. Set to "" to skip.
const IMPORT_HISTORY_FROM = "https://leviath.noiitheboii.workers.dev/api/history";

const COLLECTIONS = { snapshots: "RobloxSnapshots", daily: "RobloxDaily", pitches: "LeviathPitches", settings: "LeviathSettings" };
const KEEP_SNAPSHOT_DAYS = 45;

/* ───────────────────────── Roblox data ───────────────────────── */

const OPTS = { suppressAuth: true };
const DAY = 86400000;
const universeIds = new Map();

const toNum = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const seconds = (d) => Math.floor(new Date(d).getTime() / 1000);
const safeImage = (url) =>
  typeof url === "string" && /^https:\/\/[a-z0-9-]+\.rbxcdn\.com\//i.test(url) ? url : null;
const isoOrNull = (v) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);

async function robloxJson(sub, path) {
  let lastError = new Error("No response from Roblox");
  // roproxy.com mirrors Roblox's public APIs and is only tried if Roblox itself fails.
  for (const base of [`https://${sub}.roblox.com`, `https://${sub}.roproxy.com`]) {
    try {
      const res = await fetch(base + path, { method: "get", headers: { accept: "application/json" } });
      if (res.ok) return await res.json();
      lastError = new Error(`HTTP ${res.status} from ${base}${path}`);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

async function universeIdFor(placeId) {
  if (universeIds.has(placeId)) return universeIds.get(placeId);
  const json = await robloxJson("apis", `/universes/v1/places/${placeId}/universe`);
  const id = json && json.universeId ? Number(json.universeId) : null;
  if (id) universeIds.set(placeId, id);
  return id;
}

async function batched(sub, ids, makePath) {
  const rows = [];
  for (let i = 0; i < ids.length; i += 50) {
    const json = await robloxJson(sub, makePath(ids.slice(i, i + 50).join(",")));
    if (json && Array.isArray(json.data)) rows.push(...json.data);
  }
  return rows;
}

// "[NEW UPDATE] JoJo's Bizarre Incremental" → name "JoJo's Bizarre Incremental", tag "NEW UPDATE"
export function splitTitle(raw) {
  const original = String(raw || "").trim();
  let name = original;
  let tag = null;
  const lead = /^[\[(【]([^\])】]{1,40})[\])】]\s*/u;
  let m;
  while ((m = name.match(lead))) {
    const inner = m[1].trim();
    if (!tag && /[A-Za-z0-9]/.test(inner)) tag = inner;
    name = name.slice(m[0].length);
  }
  return { name: name.trim() || original, tag };
}

export async function buildHub() {
  const entries = await Promise.all(
    GAMES.map(async (game) => {
      try {
        return { ...game, universeId: await universeIdFor(game.placeId) };
      } catch (err) {
        return { ...game, universeId: null };
      }
    })
  );
  const ids = [...new Set(entries.map((e) => e.universeId).filter(Boolean))];
  const none = Promise.resolve([]);
  const [games, votes, thumbs, icons, group] = await Promise.allSettled([
    ids.length ? batched("games", ids, (l) => `/v1/games?universeIds=${l}`) : none,
    ids.length ? batched("games", ids, (l) => `/v1/games/votes?universeIds=${l}`) : none,
    ids.length
      ? batched("thumbnails", ids, (l) => `/v1/games/multiget/thumbnails?universeIds=${l}&countPerUniverse=1&defaults=true&size=768x432&format=Png&isCircular=false`)
      : none,
    ids.length
      ? batched("thumbnails", ids, (l) => `/v1/games/icons?universeIds=${l}&returnPolicy=PlaceHolder&size=150x150&format=Png&isCircular=false`)
      : none,
    robloxJson("groups", `/v1/groups/${SITE.groupId}`),
  ]);
  if (games.status !== "fulfilled" || (GAMES.length && !ids.length)) {
    throw games.reason || new Error("Couldn't look up any games");
  }

  const rows = (r) => (r.status === "fulfilled" && Array.isArray(r.value) ? r.value : []);
  const index = (list, key) => new Map(list.map((row) => [Number(row[key]), row]));
  const gameRows = index(rows(games), "id");
  const voteRows = index(rows(votes), "id");
  const thumbRows = index(rows(thumbs), "universeId");
  const iconRows = index(rows(icons), "targetId");
  const groupInfo = group.status === "fulfilled" && group.value ? group.value : null;

  const list = entries.map((entry, order) => {
    const g = gameRows.get(entry.universeId) || {};
    const v = voteRows.get(entry.universeId) || {};
    const t = thumbRows.get(entry.universeId);
    const shot = t && Array.isArray(t.thumbnails) ? t.thumbnails.find((x) => x && x.state === "Completed") : null;
    const icon = iconRows.get(entry.universeId);
    const title = splitTitle(g.name);
    const up = toNum(v.upVotes);
    const down = toNum(v.downVotes);
    return {
      placeId: entry.placeId,
      order,
      name: entry.name || title.name || "Untitled game",
      tag: entry.tag !== undefined ? entry.tag : title.tag,
      role: entry.role || "",
      creator: g.creator ? { name: String(g.creator.name || ""), verified: !!g.creator.hasVerifiedBadge } : null,
      playing: toNum(g.playing),
      visits: toNum(g.visits),
      favorites: toNum(g.favoritedCount),
      upVotes: up,
      downVotes: down,
      rating: up + down > 0 ? up / (up + down) : null,
      created: isoOrNull(g.created),
      updated: isoOrNull(g.updated),
      thumbnail: safeImage(shot && shot.imageUrl),
      icon: safeImage(icon && icon.state === "Completed" ? icon.imageUrl : null),
    };
  });

  const totals = list.reduce(
    (sum, g) => ({
      visits: sum.visits + g.visits,
      playing: sum.playing + g.playing,
      favorites: sum.favorites + g.favorites,
      upVotes: sum.upVotes + g.upVotes,
      downVotes: sum.downVotes + g.downVotes,
    }),
    { visits: 0, playing: 0, favorites: 0, upVotes: 0, downVotes: 0 }
  );
  const votesCast = totals.upVotes + totals.downVotes;
  totals.rating = votesCast > 0 ? totals.upVotes / votesCast : null;

  return {
    updatedAt: new Date().toISOString(),
    group: groupInfo
      ? { name: String(groupInfo.name || SITE.name), members: toNum(groupInfo.memberCount), verified: !!groupInfo.hasVerifiedBadge }
      : null,
    totals,
    games: list,
  };
}

/* ───────────────────────── Growth history ───────────────────────── */

function parseRows(json) {
  try {
    const rows = JSON.parse(json || "[]");
    return Array.isArray(rows) ? rows : [];
  } catch (err) {
    return [];
  }
}

// Called every hour by jobs.config. Saves one snapshot, updates today's summary and prunes old snapshots.
export async function recordSnapshot() {
  try {
    await importOldHistory();
  } catch (err) {
    console.error("Leviath history import skipped", err);
  }
  const hub = await buildHub();
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const rows = hub.games.map((g) => [g.placeId, g.visits, g.playing, g.favorites, g.upVotes, g.downVotes]);
  const members = hub.group ? hub.group.members : null;

  await wixData.insert(
    COLLECTIONS.snapshots,
    { t: now, totalPlaying: hub.totals.playing, totalVisits: hub.totals.visits, members, gamesJson: JSON.stringify(rows) },
    OPTS
  );

  const today = await wixData.get(COLLECTIONS.daily, day, OPTS);
  await wixData.save(
    COLLECTIONS.daily,
    {
      _id: day,
      day,
      t: now,
      members,
      totalVisits: hub.totals.visits,
      peakPlaying: Math.max(today ? toNum(today.peakPlaying) : 0, hub.totals.playing),
      gamesJson: JSON.stringify(rows),
    },
    OPTS
  );

  const old = await wixData
    .query(COLLECTIONS.snapshots)
    .lt("t", new Date(now.getTime() - KEEP_SNAPSHOT_DAYS * DAY))
    .limit(200)
    .find(OPTS);
  if (old.items.length) {
    await wixData.bulkRemove(COLLECTIONS.snapshots, old.items.map((item) => item._id), OPTS);
  }
}

// One time only, while the daily collection is still empty: copy the earlier site's recorded history.
async function importOldHistory() {
  if (!IMPORT_HISTORY_FROM) return 0;
  const existing = await wixData.query(COLLECTIONS.daily).limit(1).find(OPTS);
  if (existing.items.length) return 0;
  const res = await fetch(IMPORT_HISTORY_FROM, { method: "get", headers: { accept: "application/json" } });
  if (!res.ok) return 0;
  const old = await res.json();
  if (!old || !old.enabled) return 0;

  const cutoff = Math.floor(Date.now() / 1000) - 86400;
  const points = [
    ...(Array.isArray(old.week) ? old.week : []).filter((p) => p && p.t < cutoff),
    ...(Array.isArray(old.live) ? old.live : []).filter((p) => p && p.t >= cutoff),
  ].filter((p) => Number.isFinite(p.t) && p.t * 1000 > Date.now() - KEEP_SNAPSHOT_DAYS * DAY);
  const snapshots = points.map((p) => ({
    t: new Date(p.t * 1000),
    totalPlaying: toNum(p.total),
    totalVisits: null,
    members: null,
    gamesJson: JSON.stringify(Object.keys(p.games || {}).map((id) => [Number(id), 0, toNum(p.games[id]), 0, 0, 0])),
  }));
  const days = (Array.isArray(old.daily) ? old.daily : [])
    .filter((d) => d && /^\d{4}-\d{2}-\d{2}$/.test(d.d) && Number.isFinite(d.t))
    .map((d) => ({
      _id: d.d,
      day: d.d,
      t: new Date(d.t * 1000),
      members: d.m == null ? null : toNum(d.m),
      totalVisits: toNum(d.visits),
      peakPlaying: toNum(d.peak),
      gamesJson: JSON.stringify(Object.keys(d.games || {}).map((id) => [Number(id), toNum(d.games[id]), 0, 0, 0, 0])),
    }));
  for (let i = 0; i < snapshots.length; i += 500) {
    await wixData.bulkInsert(COLLECTIONS.snapshots, snapshots.slice(i, i + 500), OPTS);
  }
  for (let i = 0; i < days.length; i += 500) {
    await wixData.bulkInsert(COLLECTIONS.daily, days.slice(i, i + 500), OPTS);
  }
  return snapshots.length + days.length;
}

// Shapes the stored history for the charts: last 24 hours, last 7 days, and one point per day.
export async function readHistory() {
  const now = Date.now();
  const [snapResult, dailyResult] = await Promise.all([
    wixData.query(COLLECTIONS.snapshots).ge("t", new Date(now - 7 * DAY)).ascending("t").limit(1000).find(OPTS),
    wixData.query(COLLECTIONS.daily).ascending("day").limit(1000).find(OPTS),
  ]);

  const players = (item) => {
    const games = {};
    parseRows(item.gamesJson).forEach((r) => {
      games[r[0]] = toNum(r[2]);
    });
    return { t: seconds(item.t), total: toNum(item.totalPlaying), games };
  };
  const week = snapResult.items.map(players);
  const cutoff = Math.floor(now / 1000) - 86400;
  const live = week.filter((p) => p.t >= cutoff);

  const daily = dailyResult.items.map((item) => {
    const games = {};
    parseRows(item.gamesJson).forEach((r) => {
      games[r[0]] = toNum(r[1]);
    });
    return {
      d: item.day,
      t: seconds(item.t),
      m: item.members == null ? null : toNum(item.members),
      peak: toNum(item.peakPlaying),
      visits: toNum(item.totalVisits),
      games,
    };
  });

  const firstT = daily.length ? daily[0].t : week.length ? week[0].t : null;
  return {
    enabled: true,
    started: firstT ? new Date(firstT * 1000).toISOString() : null,
    live,
    week,
    daily,
  };
}

/* ───────────────────────── Pitch form ───────────────────────── */

const PITCHES_PER_HOUR = 20;
const DISCORD_WEBHOOK = /^https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;

async function discordWebhook() {
  try {
    const item = await wixData.get(COLLECTIONS.settings, "discordWebhook", OPTS);
    const url = item && typeof item.value === "string" ? item.value.trim() : "";
    return DISCORD_WEBHOOK.test(url) ? url : null;
  } catch (err) {
    return null;
  }
}

export async function savePitch(input) {
  const body = input && typeof input === "object" ? input : {};
  if (body.website) return { ok: true }; // the hidden field was filled in: a bot
  const game = String(body.game || "").trim().slice(0, 300);
  const discord = String(body.discord || "").trim().slice(0, 64);
  const message = String(body.message || "").trim().slice(0, 1000);
  if (!/^https:\/\/(?:www\.)?roblox\.com\/games\/\d+/i.test(game)) {
    return { ok: false, error: "Add your game's Roblox link, like https://www.roblox.com/games/123456789." };
  }
  if (discord.length < 2) {
    return { ok: false, error: "Add your Discord username so we can reply." };
  }
  const recent = await wixData
    .query(COLLECTIONS.pitches)
    .ge("submitted", new Date(Date.now() - 3600000))
    .count(OPTS);
  if (recent >= PITCHES_PER_HOUR) {
    return { ok: false, error: "We've had a lot of pitches in the last hour. Message us on Discord instead." };
  }
  await wixData.insert(COLLECTIONS.pitches, { game, discord, message, submitted: new Date() }, OPTS);

  const hook = await discordWebhook();
  if (hook) {
    try {
      await fetch(hook, {
        method: "post",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username: `${SITE.name} site`,
          allowed_mentions: { parse: [] },
          embeds: [
            {
              title: "New acquisition request",
              color: 0xd4b062,
              fields: [
                { name: "Game", value: game },
                { name: "Discord", value: discord },
                { name: "Message", value: message || "(none)" },
              ],
              timestamp: new Date().toISOString(),
            },
          ],
        }),
      });
    } catch (err) {
      console.error("Leviath pitch: Discord post failed", err);
    }
  }
  return { ok: true };
}
