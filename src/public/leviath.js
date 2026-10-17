// Shared page code for the Leviath site. Each page's code only needs:
//   import { startLeviath } from "public/leviath";
//   $w.onReady(() => startLeviath($w));
// It draws the whole page into the embed box named "leviathPage", keeps the numbers live,
// and handles the box's links and pitch form.
import wixLocation from "wix-location";
import { getHub, getHistory, submitPitch } from "backend/leviath.web";
import { LEVIATH_UI } from "public/leviath-ui";

/* ───────────────────────── Settings ───────────────────────── */

// Contact details and links shown on the site. (Your games are in backend/leviath-core.js.)
export const SETTINGS = {
  name: "Leviath",
  groupUrl: "https://www.roblox.com/communities/11280027/Leviath",
  ownerName: "Noii",
  ownerUsername: "noiixn",
  ownerProfileUrl: "https://www.roblox.com/users/342662401/profile",
  email: "noiibusinessemail@gmail.com",
  discordUsername: "noiilive",
  discordInvite: "https://discord.gg/nK8Eej4nXq",
  showOpenSlot: true, // the "Your game here" card at the end of the Games page
  // Numbers only you can see in Roblox's Creator Dashboard. Add any and they show as highlight tiles
  // on the Home and Stats pages, e.g. { value: "2,000+", label: "Peak players at once", note: "JoJo's Bizarre Incremental, April 2026" }
  highlights: [],
};

const REFRESH_MS = 30 * 1000;
const HISTORY_MS = 5 * 60 * 1000;
const DAY = 86400000;
const PAGES = ["games", "stats", "services", "contact"];

/* ───────────────────────── Formatting ───────────────────────── */

export function compact(n) {
  n = Math.max(0, Math.floor(Number(n) || 0));
  if (n < 1000) return String(n);
  const units = [[1e9, "B"], [1e6, "M"], [1e3, "K"]];
  for (const [size, unit] of units) {
    if (n >= size) {
      const v = n / size;
      const d = v < 100 ? 1 : 0;
      const p = 10 ** d;
      return (Math.floor(v * p) / p).toFixed(d).replace(/\.0$/, "") + unit + "+";
    }
  }
  return String(n);
}

export function exact(n) {
  return new Intl.NumberFormat("en-US").format(Math.max(0, Math.round(Number(n) || 0)));
}

export function percent(r) {
  return typeof r === "number" ? Math.round(r * 100) + "%" : "—";
}

export function avgDaily(game, nowMs) {
  const start = Date.parse(game.created);
  if (Number.isNaN(start)) return 0;
  return game.visits / Math.max(1, (nowMs - start) / DAY);
}

export function sortGames(games, key) {
  const list = games.slice();
  if (key === "playing") list.sort((a, b) => b.playing - a.playing || b.visits - a.visits);
  else if (key === "created") list.sort((a, b) => (Date.parse(b.created) || 0) - (Date.parse(a.created) || 0));
  else list.sort((a, b) => b.visits - a.visits);
  return list;
}

// Which design to draw: the first part of the page's URL (leviath.co/games → "games"), Home otherwise.
export function pageFor(path) {
  const first = String((Array.isArray(path) ? path.filter(Boolean)[0] : "") || "").toLowerCase();
  return PAGES.includes(first) ? first : "home";
}

// Links the page box may open: pages on this site, https links and email.
export function safeTarget(to) {
  if (typeof to !== "string" || to.length > 500) return null;
  if (/^\/(?!\/)[A-Za-z0-9\-._~/?#=&%]*$/.test(to)) return to;
  if (/^https:\/\/[^\s"'<>]+$/i.test(to)) return to;
  if (/^mailto:[^\s"'<>]+$/i.test(to)) return to;
  return null;
}

/* ───────────────────────── Optional: your own Wix elements ───────────────────────── */
// You can also put live numbers into Wix elements you design yourself (see the guide's "Optional" section):
// text IDs live{Playing|Visits|Members|Rating|Favorites|Likes|Games|AvgDaily|Status} (add 2, 3 or 4 for repeats),
// repeaters featuredRepeater / gamesRepeater, and chart boxes using extras/leviath-chart.html.
const LIVE_TEXT = ["Playing", "Visits", "Members", "Rating", "Favorites", "Likes", "Games", "AvgDaily", "Status"];
const CHARTS = {
  chartPlayers: "players",
  chartVisits: "visits",
  chartNewVisits: "newVisits",
  chartPeak: "peak",
  chartMembers: "members",
  chartShare: "share",
  chartNow: "now",
  chartAvgDaily: "avgDaily",
  chartRating: "rating",
  chartTimeline: "timeline",
  chartTable: "table",
  homeChart: "home",
};

// $w returns an empty selector for IDs that aren't on the page; treat those as missing.
function find(scope, id) {
  try {
    const node = scope("#" + id);
    return node && node.id ? node : null;
  } catch (err) {
    return null;
  }
}

function setText(scope, id, value) {
  const node = find(scope, id);
  if (node) node.text = value;
}

function liveValues(hub, failing) {
  const t = hub.totals;
  const nowMs = Date.parse(hub.updatedAt) || Date.now();
  const daily = hub.games.reduce((sum, g) => sum + avgDaily(g, nowMs), 0);
  let time = "";
  try {
    time = new Date(hub.updatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch (err) {}
  return {
    Playing: exact(t.playing),
    Visits: compact(t.visits),
    Members: hub.group ? compact(hub.group.members) : "—",
    Rating: percent(t.rating),
    Favorites: compact(t.favorites),
    Likes: compact(t.upVotes),
    Games: exact(hub.games.length),
    AvgDaily: compact(daily),
    Status: failing
      ? `Showing numbers from ${time} while we reconnect to Roblox.`
      : `Live from Roblox · updated ${time}`,
  };
}

function fillCard($item, g) {
  setText($item, "gameName", g.name);
  setText($item, "gameBy", g.creator && g.creator.name ? `By ${g.creator.name}${g.creator.verified ? " ✓" : ""}` : "");
  setText($item, "gameRole", g.role || "");
  setText($item, "gamePlaying", `${exact(g.playing)} playing`);
  setText($item, "gameVisits", compact(g.visits));
  setText($item, "gameRating", percent(g.rating));
  setText($item, "gameFavorites", compact(g.favorites));
  const tag = find($item, "gameTag");
  if (tag) {
    tag.text = g.tag || " ";
    if (g.tag) tag.show();
    else tag.hide();
  }
  const thumb = find($item, "gameThumb");
  if (thumb && g.thumbnail) {
    thumb.src = g.thumbnail;
    thumb.alt = `${g.name} thumbnail`;
  }
  const icon = find($item, "gameIcon");
  if (icon && g.icon) {
    icon.src = g.icon;
    icon.alt = `${g.name} icon`;
  }
  const play = find($item, "gamePlay");
  if (play) {
    play.link = `https://www.roblox.com/games/${g.placeId}`;
    play.target = "_blank";
  }
}

/* ───────────────────────── Start ───────────────────────── */

export function startLeviath($w) {
  let hub = null;
  let history = null;
  let failing = false;
  let sortKey = "visits";
  const page = pageFor(wixLocation.path);

  // The page box: an Embed HTML element with embeds/leviath-page-box.html pasted in, ID "leviathPage".
  const box = find($w, "leviathPage");
  let uiSentAt = 0;
  let uiReady = false;
  const heights = new Set();
  if (box) {
    box.onMessage((event) => {
      const msg = event && event.data;
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "leviath-shell") {
        if (Date.now() - uiSentAt > 3000) {
          uiSentAt = Date.now();
          box.postMessage({ type: "leviath-ui", html: LEVIATH_UI });
        }
      } else if (msg.type === "leviath-ui-ready") {
        uiReady = true;
        box.postMessage({ type: "leviath-page", page, settings: { ...SETTINGS, refreshSeconds: REFRESH_MS / 1000 } });
        sendBox();
      } else if (msg.type === "leviath-nav") {
        const to = safeTarget(msg.to);
        if (to) wixLocation.to(to);
      } else if (msg.type === "leviath-pitch") {
        handlePitch(msg);
      } else if (msg.type === "leviath-height") {
        const key = `${msg.width}:${msg.height}`;
        if (!heights.has(key) && Number.isFinite(msg.height)) {
          heights.add(key);
          console.log(`Leviath: on ${msg.width}px-wide screens, the ${page} page box needs to be ${msg.height}px tall.`);
        }
      }
    });
  }

  function sendBox() {
    if (box && uiReady) box.postMessage({ type: "leviath-data", hub, history, failing });
  }

  async function handlePitch(msg) {
    let res;
    try {
      res = await submitPitch(msg.pitch);
    } catch (err) {
      res = { ok: false, error: "That didn't go through. Message us on Discord instead." };
    }
    box.postMessage({ type: "leviath-pitch-result", id: msg.id, ok: !!(res && res.ok), error: res && res.error ? String(res.error) : "" });
  }

  // Optional elements (see above).
  const charts = [];
  Object.keys(CHARTS).forEach((id) => {
    const node = find($w, id);
    if (!node) return;
    const entry = { node, chart: CHARTS[id] };
    node.onMessage((event) => {
      const msg = event && event.data;
      if (msg && msg.type === "leviath-ready") sendChart(entry);
    });
    charts.push(entry);
  });

  const repeaters = [];
  [
    ["featuredRepeater", (games) => sortGames(games, "visits").slice(0, 3)],
    ["gamesRepeater", (games) => sortGames(games, sortKey)],
  ].forEach(([id, pick]) => {
    const rep = find($w, id);
    if (!rep) return;
    rep.onItemReady(($item, item) => fillCard($item, item));
    repeaters.push({ rep, pick });
  });

  [
    ["sortVisits", "visits"],
    ["sortPlayers", "playing"],
    ["sortNewest", "created"],
  ].forEach(([id, key]) => {
    const button = find($w, id);
    if (button) {
      button.onClick(() => {
        sortKey = key;
        renderRepeaters();
      });
    }
  });

  function sendChart(entry) {
    if (hub) entry.node.postMessage({ type: "leviath-data", chart: entry.chart, hub, history });
  }

  function renderRepeaters() {
    if (!hub) return;
    repeaters.forEach(({ rep, pick }) => {
      rep.data = pick(hub.games).map((g) => ({ ...g, _id: `g${g.placeId}` }));
      rep.forEachItem(($item, item) => fillCard($item, item));
    });
  }

  function renderText() {
    const values = liveValues(hub, failing);
    LIVE_TEXT.forEach((key) => {
      ["", "2", "3", "4"].forEach((suffix) => setText($w, `live${key}${suffix}`, values[key]));
    });
  }

  async function loadHub() {
    try {
      const data = await getHub();
      if (data && data.totals && Array.isArray(data.games)) {
        hub = data;
        failing = false;
      } else {
        failing = true;
      }
    } catch (err) {
      failing = true;
    }
    sendBox();
    if (!hub) {
      setText($w, "liveStatus", failing ? "Couldn't reach Roblox. Trying again shortly." : "Connecting to Roblox…");
      return;
    }
    renderText();
    renderRepeaters();
    charts.forEach(sendChart);
  }

  async function loadHistory() {
    if (!box && !charts.length) return;
    try {
      history = await getHistory();
    } catch (err) {
      history = null;
    }
    sendBox();
    charts.forEach(sendChart);
  }

  loadHub();
  loadHistory();
  const hubTimer = setInterval(loadHub, REFRESH_MS);
  const historyTimer = setInterval(loadHistory, HISTORY_MS);
  return {
    page,
    stop() {
      clearInterval(hubTimer);
      clearInterval(historyTimer);
    },
  };
}