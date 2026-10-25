// Leviath scout: finds young Roblox games that are starting to grow, for the Scout tab of the admin page.
//
// Every hour (jobs.config) it:
//   1. searches Roblox for each genre's search words below, a few searches per run, and starts watching any game
//      that's at most 5 weeks old and under 300 players;
//   2. checks every watched game's players, visits, favorites and likes, and keeps 48 hours of hourly readings and
//      40 days of daily ones;
//   3. drops games that have aged out, gone quiet, or that you passed on.
// The Scout tab scores the watched games and filters them (by default: 2-4 weeks old, under 100 players, rising).
//
// Everything is stored in the CMS collection LeviathScout, packed into a few dozen items so it stays well inside
// your plan's item limit.
import wixData from "wix-data";
import { randomBytes } from "crypto";
import { robloxJson, splitTitle } from "backend/leviath-core";

/* ───────────────────────── Settings ───────────────────────── */

export const SCOUT = {
  trackMaxAgeDays: 35, // start watching games up to this old, so there's history by the time they're 2 weeks old
  keepMarkedDays: 120, // shortlisted, contacted and hand-added games are watched until this old
  trackMaxPlayers: 300, // only start watching games under this many players
  minPlayers: 2, // ...that have at least this many players
  minVisits: 500, // ...or at least this many visits
  maxGames: 1200, // most games watched at once; the weakest unmarked ones go first
  searchesPerRun: 24, // Roblox searches per hourly run
  pagesPerSearch: 5, // 40 games a page
};

// Roblox's own genres, and the search words used to find new games in each. Add words to widen the net.
export const GENRES = [
  { genre: "Simulation", searches: ["simulator", "incremental", "tycoon", "idle", "clicker"] },
  { genre: "RPG", searches: ["rpg", "dungeon", "quest"] },
  { genre: "Action", searches: ["battlegrounds", "fighting", "anime", "sword"] },
  { genre: "Adventure", searches: ["adventure", "story"] },
  { genre: "Obby & Platformer", searches: ["obby", "parkour"] },
  { genre: "Survival", searches: ["survival", "horror", "zombie"] },
  { genre: "Shooter", searches: ["shooter", "fps"] },
  { genre: "Strategy", searches: ["tower defense", "strategy"] },
  { genre: "Roleplay & Avatar Sim", searches: ["roleplay", "life sim"] },
  { genre: "Party & Casual", searches: ["minigames", "party game"] },
  { genre: "Sports & Racing", searches: ["racing", "soccer"] },
  { genre: "Puzzle", searches: ["puzzle", "escape room"] },
  { genre: "", searches: ["new game", "release", "beta", "early access", "rng"] },
];

/* ───────────────────────── Storage ───────────────────────── */

const OPTS = { suppressAuth: true };
const COLLECTION = "LeviathScout";
const PER_ITEM = 60;
const DAY = 86400000;
const HOUR = 3600000;
const KEEP_HOURS = 48;
const KEEP_DAYS = 40;
const STATUSES = ["shortlist", "contacted", "pass"];

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const parse = (text, fallback) => {
  try {
    const v = JSON.parse(text || "");
    return v && typeof v === "object" ? v : fallback;
  } catch (err) {
    return fallback;
  }
};

async function readItem(id, fallback) {
  const item = await wixData.get(COLLECTION, id, OPTS);
  return item ? parse(item.data, fallback) : fallback;
}

function writeItem(id, kind, data, note) {
  return wixData.save(COLLECTION, { _id: id, kind, data: JSON.stringify(data), note: note || "" }, OPTS);
}

async function readGames() {
  const games = [];
  for (let skip = 0; skip < 1000; skip += 5) {
    const res = await wixData.query(COLLECTION).eq("kind", "games").ascending("_id").skip(skip).limit(5).find(OPTS);
    res.items.forEach((item) => games.push(...parse(item.data, [])));
    if (res.items.length < 5) break;
  }
  return games;
}

async function writeGames(games) {
  const items = [];
  for (let i = 0; i < games.length; i += PER_ITEM) {
    const id = "games-" + String(items.length).padStart(3, "0");
    items.push({ _id: id, kind: "games", data: JSON.stringify(games.slice(i, i + PER_ITEM)), note: "Games the scout is watching" });
  }
  for (let i = 0; i < items.length; i += 4) await wixData.bulkSave(COLLECTION, items.slice(i, i + 4), OPTS);
  const old = await wixData.query(COLLECTION).eq("kind", "games").limit(1000).find(OPTS);
  const extra = old.items.map((item) => item._id).filter((id) => !items.some((it) => it._id === id));
  if (extra.length) await wixData.bulkRemove(COLLECTION, extra, OPTS);
}

export async function readMarks() {
  return readItem("marks", {});
}

/* ───────────────────────── Roblox ───────────────────────── */

async function inBatches(ids, size, makePath, sub) {
  const rows = [];
  const chunks = [];
  for (let i = 0; i < ids.length; i += size) chunks.push(ids.slice(i, i + size));
  for (let i = 0; i < chunks.length; i += 3) {
    const results = await Promise.allSettled(chunks.slice(i, i + 3).map((chunk) => robloxJson(sub, makePath(chunk.join(",")))));
    results.forEach((r) => {
      if (r.status === "fulfilled" && r.value && Array.isArray(r.value.data)) rows.push(...r.value.data);
    });
  }
  return rows;
}

const byId = (rows, key) => new Map(rows.map((r) => [Number(r[key]), r]));
const details = (ids) => inBatches(ids, 50, (l) => `/v1/games?universeIds=${l}`, "games").then((r) => byId(r, "id"));
const votes = (ids) => inBatches(ids, 50, (l) => `/v1/games/votes?universeIds=${l}`, "games").then((r) => byId(r, "id"));
const icons = (ids) =>
  inBatches(ids, 50, (l) => `/v1/games/icons?universeIds=${l}&returnPolicy=PlaceHolder&size=150x150&format=Png&isCircular=false`, "thumbnails").then(
    (r) => byId(r, "targetId")
  );

const safeImage = (url) => (typeof url === "string" && /^https:\/\/[a-z0-9-]+\.rbxcdn\.com\//i.test(url) ? url : "");

function sessionId() {
  const h = randomBytes(16).toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function searchPlan() {
  const plan = [];
  GENRES.forEach((g) => g.searches.forEach((q) => plan.push({ genre: g.genre, q })));
  return plan;
}

/* ───────────────────────── Watching a game ───────────────────────── */

// A watched game, kept small: h = hourly [minute, playing, visits, favorites] for 48 hours,
// d = daily [day, sum of players, peak, visits at last reading, favorites at last reading, readings] for 40 days.
function newGame(row, now, via) {
  return {
    id: Number(row.id),
    p: num(row.rootPlaceId),
    cr: Date.parse(row.created) || now,
    fs: now,
    via: via || "",
    h: [],
    d: [],
  };
}

function applyDetails(g, row) {
  const title = splitTitle(row.name);
  g.p = num(row.rootPlaceId) || g.p;
  g.n = title.name.slice(0, 80);
  g.tag = title.tag ? title.tag.slice(0, 30) : "";
  g.c = row.creator ? { n: String(row.creator.name || "").slice(0, 40), i: num(row.creator.id), t: row.creator.type === "Group" ? "Group" : "User" } : g.c;
  g.g1 = row.genre_l1 ? String(row.genre_l1) : g.g1 || "";
  g.g2 = row.genre_l2 ? String(row.genre_l2) : g.g2 || "";
  g.cr = Date.parse(row.created) || g.cr;
  g.up = Date.parse(row.updated) || g.up || 0;
}

function addReading(g, playing, visits, favorites, now) {
  const minute = Math.floor(now / 60000);
  g.h.push([minute, playing, visits, favorites]);
  g.h = g.h.filter((p) => p[0] > minute - KEEP_HOURS * 60 - 30);
  const day = Math.floor(now / DAY);
  let d = g.d[g.d.length - 1];
  if (!d || d[0] !== day) {
    d = [day, 0, 0, visits, favorites, 0];
    g.d.push(d);
  }
  d[1] += playing;
  d[2] = Math.max(d[2], playing);
  d[3] = visits;
  d[4] = favorites;
  d[5] += 1;
  g.d = g.d.filter((x) => x[0] > day - KEEP_DAYS);
  g.cur = [playing, visits, favorites];
  g.lc = now;
}

async function refresh(games, now, report) {
  if (!games.length) return;
  const ids = games.map((g) => g.id);
  const [rows, likes] = await Promise.all([details(ids), votes(ids)]);
  const needIcons = games.filter((g) => !g.ic || now - (g.icAt || 0) > 3 * DAY).map((g) => g.id);
  const pics = needIcons.length ? await icons(needIcons) : new Map();
  games.forEach((g) => {
    const row = rows.get(g.id);
    if (!row) {
      g.miss = (g.miss || 0) + 1;
      return;
    }
    g.miss = 0;
    applyDetails(g, row);
    const v = likes.get(g.id);
    if (v) g.v = [num(v.upVotes), num(v.downVotes)];
    const pic = pics.get(g.id);
    if (pic && pic.state === "Completed" && safeImage(pic.imageUrl)) {
      g.ic = safeImage(pic.imageUrl);
      g.icAt = now;
    }
    addReading(g, num(row.playing), num(row.visits), num(row.favoritedCount), now);
    report.checked++;
  });
}

/* ───────────────────────── Finding new games ───────────────────────── */

function searchGames(json) {
  const out = [];
  const groups = json && Array.isArray(json.searchResults) ? json.searchResults : [];
  groups.forEach((group) => {
    (Array.isArray(group && group.contents) ? group.contents : []).forEach((c) => {
      if (c && Number(c.universeId) > 0 && (!c.contentType || c.contentType === "Game")) out.push(c);
    });
  });
  return out;
}

async function discover(games, marks, state, now, deadline, maxSearches, report) {
  const plan = searchPlan();
  const known = new Set(games.map((g) => g.id));
  const today = Math.floor(now / DAY);
  const found = new Map();
  const session = sessionId();
  let cursor = state.cursor && Number.isInteger(state.cursor.i) ? state.cursor : { i: 0, page: 0, token: "" };
  for (let n = 0; n < maxSearches && Date.now() < deadline; n++) {
    const entry = plan[cursor.i % plan.length];
    let json = null;
    try {
      json = await robloxJson(
        "apis",
        `/search-api/omni-search?searchQuery=${encodeURIComponent(entry.q)}&sessionId=${session}&pageType=all` +
          (cursor.token ? `&pageToken=${encodeURIComponent(cursor.token)}` : "")
      );
    } catch (err) {
      report.errors.push(`Search "${entry.q}" failed: ${String((err && err.message) || err).slice(0, 120)}`);
    }
    report.searches.push(entry.q);
    const results = searchGames(json);
    results.forEach((c) => {
      const id = Number(c.universeId);
      if (known.has(id) || found.has(id) || id <= num(state.oldBelow)) return;
      if ((state.skip && state.skip[id] >= today) || (marks[id] && marks[id].s === "pass")) return;
      if (num(c.playerCount) > SCOUT.trackMaxPlayers) return;
      found.set(id, entry.q);
    });
    const token = json && typeof json.nextPageToken === "string" ? json.nextPageToken : "";
    if (!results.length || !token || cursor.page + 1 >= SCOUT.pagesPerSearch) cursor = { i: (cursor.i + 1) % plan.length, page: 0, token: "" };
    else cursor = { i: cursor.i, page: cursor.page + 1, token };
  }
  state.cursor = cursor;
  state.next = plan[cursor.i % plan.length].q;
  if (!found.size) return [];

  const ids = [...found.keys()];
  const rows = await details(ids);
  state.skip = state.skip || {};
  const added = [];
  ids.forEach((id) => {
    const row = rows.get(id);
    if (!row) return;
    const ageDays = (now - Date.parse(row.created)) / DAY;
    // Universe IDs only go up, so anything below a game that's already too old is too old as well.
    if (!(ageDays <= SCOUT.trackMaxAgeDays)) {
      if (Number.isFinite(ageDays)) state.oldBelow = Math.max(num(state.oldBelow), id);
      return;
    }
    if (num(row.playing) > SCOUT.trackMaxPlayers) return;
    if (num(row.playing) < SCOUT.minPlayers && num(row.visits) < SCOUT.minVisits) {
      state.skip[id] = today + 3; // quiet for now; look again in a few days
      return;
    }
    const g = newGame(row, now, found.get(id));
    applyDetails(g, row);
    added.push({ g, row });
  });
  if (added.length) {
    const addedIds = added.map((a) => a.g.id);
    const [likes, pics] = await Promise.all([votes(addedIds), icons(addedIds)]);
    added.forEach(({ g, row }) => {
      const v = likes.get(g.id);
      if (v) g.v = [num(v.upVotes), num(v.downVotes)];
      const pic = pics.get(g.id);
      if (pic && pic.state === "Completed" && safeImage(pic.imageUrl)) {
        g.ic = safeImage(pic.imageUrl);
        g.icAt = now;
      }
      addReading(g, num(row.playing), num(row.visits), num(row.favoritedCount), now);
    });
  }
  report.added += added.length;
  return added.map((a) => a.g);
}

/* ───────────────────────── Scoring ───────────────────────── */

const pct = (x) => `${x > 0 ? "+" : ""}${Math.round(x * 100)}%`;

// Reading closest to `minutesAgo`, if there's one within 90 minutes of it.
function readingAt(h, nowMin, minutesAgo) {
  let best = null;
  h.forEach((p) => {
    const off = Math.abs(nowMin - minutesAgo - p[0]);
    if (off <= 90 && (!best || off < best.off)) best = { off, p };
  });
  return best ? best.p : null;
}

export function scoutMetrics(g, now) {
  const nowMin = now / 60000;
  const h = g.h || [];
  const cur = g.cur || [0, 0, 0];
  const ageDays = (now - g.cr) / DAY;
  const watchedHours = (now - g.fs) / HOUR;
  const avg = (pts) => (pts.length ? pts.reduce((s, p) => s + p[1], 0) / pts.length : null);
  const last24 = h.filter((p) => p[0] > nowMin - 24 * 60);
  const prev24 = h.filter((p) => p[0] <= nowMin - 24 * 60 && p[0] > nowMin - 48 * 60);
  const avgNow = avg(last24);
  const avgPrev = prev24.length >= 6 ? avg(prev24) : null;

  // Visits per day: over the last 24 hours, the 24 before that, and on average since launch.
  const lifeVpd = ageDays > 0.5 ? cur[1] / ageDays : null;
  const day1 = readingAt(h, nowMin, 24 * 60);
  const day2 = readingAt(h, nowMin, 48 * 60);
  let vpd = null;
  if (day1) vpd = cur[1] - day1[2];
  else if (h.length >= 2 && nowMin - h[0][0] >= 6 * 60) vpd = ((cur[1] - h[0][2]) / (nowMin - h[0][0])) * 24 * 60;
  const vpdPrev = day1 && day2 ? day1[2] - day2[2] : null;

  // Daily average players over the days watched (days with at least 6 readings).
  const days = (g.d || []).filter((d) => d[5] >= 6).map((d) => ({ day: d[0], avg: d[1] / d[5], peak: d[2], visits: d[3] }));
  let weekChange = null;
  if (days.length >= 4) {
    const recent = days.slice(-7);
    const head = recent.slice(0, 2);
    const tail = recent.slice(-2);
    const a = head.reduce((s, d) => s + d.avg, 0) / head.length;
    const b = tail.reduce((s, d) => s + d.avg, 0) / tail.length;
    weekChange = (b + 2) / (a + 2) - 1;
  }

  const playersChange = avgNow !== null && avgPrev !== null ? (avgNow + 2) / (avgPrev + 2) - 1 : null;
  const visitsChange = vpd !== null && vpdPrev !== null ? (vpd + 30) / (vpdPrev + 30) - 1 : null;
  const vsLaunch = vpd !== null && lifeVpd ? (vpd + 30) / (lifeVpd + 30) - 1 : null;

  const signals = [];
  if (weekChange !== null) signals.push([weekChange, 2]);
  if (playersChange !== null) signals.push([playersChange, 1.5]);
  if (visitsChange !== null) signals.push([visitsChange, 1]);
  if (vsLaunch !== null) signals.push([vsLaunch, signals.length ? 0.5 : 1]);
  const weight = signals.reduce((s, x) => s + x[1], 0);
  const growth = weight ? signals.reduce((s, x) => s + Math.max(-1, Math.min(3, x[0])) * x[1], 0) / weight : null;

  const tiny = (avgNow === null ? cur[0] : avgNow) < 2 && (vpd === null || vpd < 50);
  let trend = "early";
  if (watchedHours >= 6 && growth !== null) {
    if (tiny) trend = "stagnant";
    else if (growth >= 0.15) trend = "rising";
    else if (growth <= -0.15) trend = "falling";
    else trend = "stagnant";
  }

  const up = g.v ? g.v[0] : 0;
  const down = g.v ? g.v[1] : 0;
  const likes = up + down >= 10 ? up / (up + down) : null;
  const favRate = cur[1] > 0 ? (cur[2] / cur[1]) * 1000 : null;
  const updatedDays = g.up ? (now - g.up) / DAY : null;
  const traction = vpd !== null ? vpd : lifeVpd;

  let score = 0;
  if (growth !== null) score += Math.max(0, Math.min(1, growth / 1.0)) * 40;
  if (traction) score += Math.max(0, Math.min(1, Math.log10(traction + 1) / 4)) * 20;
  if (likes !== null) score += Math.max(0, Math.min(1, (likes - 0.6) / 0.35)) * 15;
  if (favRate !== null) score += Math.max(0, Math.min(1, favRate / 40)) * 10;
  if (updatedDays !== null) score += updatedDays <= 3 ? 15 : updatedDays <= 7 ? 10 : updatedDays <= 14 ? 5 : 0;
  if (trend === "stagnant") score *= 0.6;
  if (trend === "falling") score *= 0.4;
  if (tiny) score *= 0.5;

  const reasons = [];
  if (weekChange !== null && Math.abs(weekChange) >= 0.1) reasons.push(`Players ${pct(weekChange)} over ${Math.min(days.length, 7)} days`);
  if (playersChange !== null && Math.abs(playersChange) >= 0.1) reasons.push(`Players ${pct(playersChange)} on the day before`);
  if (visitsChange !== null && Math.abs(visitsChange) >= 0.15) reasons.push(`Visits a day ${pct(visitsChange)}`);
  else if (vsLaunch !== null && vsLaunch >= 0.25) reasons.push(`Visits a day ${pct(vsLaunch)} on its launch average`);
  if (likes !== null && likes >= 0.85) reasons.push(`${Math.round(likes * 100)}% likes`);
  if (favRate !== null && favRate >= 25) reasons.push(`${Math.round(favRate)} favorites per 1,000 visits`);
  if (updatedDays !== null && updatedDays <= 3) reasons.push(updatedDays < 1 ? "Updated today" : `Updated ${Math.floor(updatedDays)} days ago`);
  if (trend === "early") reasons.push("Just found. Its trend shows after a few hours of watching");

  return {
    ageDays,
    watchedHours,
    playing: cur[0],
    visits: cur[1],
    favorites: cur[2],
    avgNow,
    avgPrev,
    playersChange,
    weekChange,
    vpd,
    vpdPrev,
    visitsChange,
    lifeVpd,
    likes,
    votes: up + down,
    favRate,
    updatedDays,
    growth,
    trend,
    score: Math.round(score),
    reasons,
  };
}

/* ───────────────────────── The hourly run ───────────────────────── */

function prune(games, marks, now, report) {
  const today = Math.floor(now / DAY);
  const skip = {};
  const kept = games.filter((g) => {
    const mark = marks[g.id] && marks[g.id].s;
    const keep = g.manual || mark === "shortlist" || mark === "contacted";
    const age = (now - g.cr) / DAY;
    if (mark === "pass") return false;
    if ((g.miss || 0) >= 3) return false; // made private or deleted
    if (age > (keep ? SCOUT.keepMarkedDays : SCOUT.trackMaxAgeDays + 5)) return false;
    if (!keep && age >= 10 && (now - g.fs) / HOUR >= 48) {
      const peak = Math.max(0, ...(g.h || []).map((p) => p[1]));
      const m = scoutMetrics(g, now);
      if (peak <= 1 && (m.vpd === null || m.vpd < 30)) {
        skip[g.id] = today + 5; // gone quiet; it can come back if it picks up
        return false;
      }
    }
    return true;
  });
  if (kept.length > SCOUT.maxGames) {
    const ranked = kept
      .filter((g) => !(g.manual || (marks[g.id] && marks[g.id].s)))
      .map((g) => ({ g, s: scoutMetrics(g, now).score }))
      .sort((a, b) => a.s - b.s);
    const drop = new Set(ranked.slice(0, kept.length - SCOUT.maxGames).map((x) => x.g.id));
    report.removed += games.length - kept.length + drop.size;
    return { games: kept.filter((g) => !drop.has(g.id)), skip };
  }
  report.removed += games.length - kept.length;
  return { games: kept, skip };
}

// Called every hour by jobs.config. The Scan now button and adding a game by hand use a shorter run:
// { budgetMs, searches, refresh: false } skips re-checking every watched game.
export async function runScout(options) {
  const opts = options || {};
  const started = Date.now();
  const budget = opts.budgetMs || 150000;
  const deadline = started + budget;
  const state = await readItem("state", {});
  if (num(state.lock) > started) return { ok: false, busy: true };
  state.lock = started + budget + 60000;
  await writeItem("state", "state", state, "Where the scout is up to");

  const report = { at: new Date(started).toISOString(), checked: 0, searches: [], added: 0, removed: 0, errors: [] };
  try {
    const [loaded, marks, queue] = await Promise.all([readGames(), readMarks(), readItem("queue", [])]);
    let games = loaded;
    const now = Date.now();

    // Games added by hand on the Scout tab.
    const handAdded = [];
    if (Array.isArray(queue) && queue.length) {
      const ids = [];
      for (const q of queue.slice(0, 20)) {
        try {
          const json = await robloxJson("apis", `/universes/v1/places/${num(q.placeId)}/universe`);
          if (json && json.universeId) ids.push(Number(json.universeId));
        } catch (err) {
          report.errors.push(`Couldn't look up place ${num(q.placeId)}`);
        }
      }
      const fresh = ids.filter((id) => !games.some((g) => g.id === id));
      const rows = fresh.length ? await details(fresh) : new Map();
      fresh.forEach((id) => {
        const row = rows.get(id);
        if (!row) return;
        const g = newGame(row, now, "added by hand");
        g.manual = true;
        applyDetails(g, row);
        games.push(g);
        handAdded.push(g);
        report.added++;
      });
      ids.forEach((id) => {
        const g = games.find((x) => x.id === id);
        if (g) g.manual = true;
      });
      await writeItem("queue", "queue", [], "Games added on the Scout tab, waiting for the next scan");
    }

    await refresh(opts.refresh === false ? handAdded : games, now, report);
    if (opts.searches !== 0) {
      const added = await discover(games, marks, state, now, deadline, opts.searches || SCOUT.searchesPerRun, report);
      games = games.concat(added);
    }
    const pruned = prune(games, marks, now, report);
    games = pruned.games;
    const today = Math.floor(now / DAY);
    const skip = { ...(state.skip || {}), ...pruned.skip };
    Object.keys(skip).forEach((id) => {
      if (skip[id] < today) delete skip[id];
    });
    state.skip = skip;
    await writeGames(games);
    report.watching = games.length;
    report.ms = Date.now() - started;
    state.lastRun = report;
    state.lock = 0;
    await writeItem("state", "state", state, "Where the scout is up to");
    return { ok: true, report };
  } catch (err) {
    console.error("Leviath scout run failed", err);
    state.lock = 0;
    state.lastRun = { ...report, failed: String((err && err.message) || err).slice(0, 300) };
    try {
      await writeItem("state", "state", state, "Where the scout is up to");
    } catch (e) {
      console.error("Leviath scout couldn't save its state", e);
    }
    throw err;
  }
}

/* ───────────────────────── The Scout tab ───────────────────────── */

const round3 = (x) => (x === null || x === undefined ? null : Math.round(x * 1000) / 1000);

export async function scoutData() {
  const now = Date.now();
  const [games, marks, state, queue] = await Promise.all([readGames(), readMarks(), readItem("state", {}), readItem("queue", [])]);
  const nowMin = now / 60000;
  return {
    now: new Date(now).toISOString(),
    settings: { trackMaxAgeDays: SCOUT.trackMaxAgeDays, trackMaxPlayers: SCOUT.trackMaxPlayers },
    lastRun: state.lastRun || null,
    next: state.next || searchPlan()[0].q,
    queued: Array.isArray(queue) ? queue.length : 0,
    marks,
    games: games.map((g) => {
      const m = scoutMetrics(g, now);
      return {
        id: g.id,
        placeId: g.p,
        name: g.n || "Untitled game",
        tag: g.tag || "",
        creator: g.c || null,
        genre: g.g1 || "",
        subgenre: g.g2 || "",
        icon: g.ic || "",
        created: new Date(g.cr).toISOString(),
        updated: g.up ? new Date(g.up).toISOString() : null,
        found: new Date(g.fs).toISOString(),
        via: g.via || "",
        manual: !!g.manual,
        m: {
          ...m,
          ageDays: Math.round(m.ageDays * 10) / 10,
          watchedHours: Math.round(m.watchedHours),
          avgNow: m.avgNow === null ? null : Math.round(m.avgNow * 10) / 10,
          avgPrev: m.avgPrev === null ? null : Math.round(m.avgPrev * 10) / 10,
          vpd: m.vpd === null ? null : Math.round(m.vpd),
          vpdPrev: m.vpdPrev === null ? null : Math.round(m.vpdPrev),
          lifeVpd: m.lifeVpd === null ? null : Math.round(m.lifeVpd),
          favRate: m.favRate === null ? null : Math.round(m.favRate * 10) / 10,
          playersChange: round3(m.playersChange),
          weekChange: round3(m.weekChange),
          visitsChange: round3(m.visitsChange),
          likes: round3(m.likes),
          growth: round3(m.growth),
          updatedDays: m.updatedDays === null ? null : Math.round(m.updatedDays * 10) / 10,
        },
        spark: (g.h || []).filter((p) => p[0] > nowMin - 48 * 60).map((p) => [Math.round(nowMin - p[0]), p[1]]),
        daily: (g.d || []).filter((d) => d[5] > 0).slice(-14).map((d) => [d[0], Math.round((d[1] / d[5]) * 10) / 10, d[2]]),
      };
    }),
  };
}

export async function markGame(input) {
  const body = input && typeof input === "object" ? input : {};
  const id = Math.floor(num(body.id));
  if (!(id > 0)) return { ok: false, error: "No game given." };
  const status = STATUSES.includes(body.status) ? body.status : "";
  const note = String(body.note || "").trim().slice(0, 1000);
  const marks = await readMarks();
  if (!status && !note) delete marks[id];
  else marks[id] = { s: status, n: note, t: Date.now() };
  await writeItem("marks", "marks", marks, "Your Shortlist, Contacted and Pass choices, with notes");
  return { ok: true, mark: marks[id] || null };
}

export async function queueGame(link) {
  const m = /roblox\.com\/(?:[a-z]{2}\/)?games\/(\d+)/i.exec(String(link || "")) || /^\s*(\d{4,20})\s*$/.exec(String(link || ""));
  if (!m) return { ok: false, error: "Paste the game's Roblox link, like https://www.roblox.com/games/123456789." };
  const queue = await readItem("queue", []);
  const list = Array.isArray(queue) ? queue : [];
  if (!list.some((q) => String(q.placeId) === m[1])) list.push({ placeId: m[1], at: Date.now() });
  await writeItem("queue", "queue", list.slice(-50), "Games added on the Scout tab, waiting for the next scan");
  return { ok: true, placeId: m[1] };
}

// Links the developer put on the game's page (Discord, X, YouTube...), fetched when you ask for them.
export async function gameLinks(universeId) {
  const id = Math.floor(num(universeId));
  if (!(id > 0)) return { ok: false, links: [] };
  const json = await robloxJson("games", `/v1/games/${id}/social-links/list`);
  const links = (json && Array.isArray(json.data) ? json.data : [])
    .filter((l) => l && typeof l.url === "string" && /^https:\/\//i.test(l.url))
    .slice(0, 12)
    .map((l) => ({ type: String(l.type || "Link").slice(0, 30), title: String(l.title || "").slice(0, 80), url: l.url.slice(0, 300) }));
  return { ok: true, links };
}
