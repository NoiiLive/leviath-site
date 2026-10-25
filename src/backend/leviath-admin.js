// Leviath admin page: leviath.co/#/admin
//
// It only opens on devices you've linked, recognised by their internet address. Anyone else who goes there just
// sees the home page. Linked addresses are kept in CMS → LeviathSettings → the "adminDevices" item (comma-separated),
// never in this file, so they stay out of the code repository.
//
// To link a device:
//   • From a device that's already linked, press "Link another device" on the admin page and open the link it
//     gives you on the new device within 30 minutes.
//   • If you're locked out (say your home internet address changed): in the CMS, open LeviathSettings and set
//     the Value of the "adminClaim" item (add it if it's missing) to a code of at least 12 characters. Then open
//     leviath.co/_functions/admin?claim=<that code> once on your device. A code only ever links one device.
// leviath.co/_functions/admin also takes a linked device straight to the admin page.
// To unlink a device, delete its address from "adminDevices".
import wixData from "wix-data";
import { randomBytes } from "crypto";
import { COLLECTIONS, discordWebhook } from "backend/leviath-core";

const OPTS = { suppressAuth: true };
const DAY = 86400000;
const SETTINGS = COLLECTIONS.settings;
const MIN_CODE = 12;
const LINK_MINUTES = 30;
const HOURLY_JOB_LATE_AFTER = 2.5 * 3600000;

/* ───────────────────────── Devices ───────────────────────── */

export function addressOf(request) {
  let ip = String((request && request.ip) || "").trim().toLowerCase();
  if (ip.startsWith("::ffff:") && ip.includes(".")) ip = ip.slice(7);
  return ip;
}

// "2a02:c7f::1" → ["2a02","c7f","0","0","0","0","0","1"], or null if it isn't an IPv6 address.
function ipv6Groups(ip) {
  if (!ip.includes(":")) return null;
  const halves = ip.split("%")[0].split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const gap = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : gap < 1) return null;
  const groups = [...head, ...new Array(halves.length === 2 ? gap : 0).fill("0"), ...tail];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => g.replace(/^0+(?=.)/, ""));
}

// Same device: the exact IPv4 address. For IPv6, the same home connection (the first half of the address),
// because devices on IPv6 quietly change the second half every day or so.
export function sameDevice(a, b) {
  if (!a || !b) return false;
  const x = ipv6Groups(a);
  const y = ipv6Groups(b);
  if (x && y) return x.slice(0, 4).join(":") === y.slice(0, 4).join(":");
  return a === b;
}

async function setting(id) {
  try {
    return await wixData.get(SETTINGS, id, OPTS);
  } catch (err) {
    return null;
  }
}

async function linkedDevices() {
  const item = await setting("adminDevices");
  return String((item && item.value) || "")
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export async function isAdmin(request) {
  const me = addressOf(request);
  if (!me) return false;
  return (await linkedDevices()).some((d) => sameDevice(d, me));
}

function sameText(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Links the device making this request if the code matches the "adminClaim" item. The code is used up first.
export async function claimDevice(request, code) {
  const me = addressOf(request);
  const given = String(code || "").trim();
  if (!me || given.length < MIN_CODE || given.length > 200) return false;
  const item = await setting("adminClaim");
  const wanted = item && typeof item.value === "string" ? item.value.trim() : "";
  if (wanted.length < MIN_CODE || !sameText(given, wanted)) return false;
  const expires = /^expires (\S+)/.exec(String(item.note || ""));
  if (expires && !(Date.parse(expires[1]) > Date.now())) return false;

  await wixData.remove(SETTINGS, "adminClaim", OPTS);
  const devices = await linkedDevices();
  if (!devices.some((d) => sameDevice(d, me))) devices.push(me);
  await wixData.save(
    SETTINGS,
    { _id: "adminDevices", value: devices.join(", "), note: "Internet addresses that can open the admin page. Delete one to lock that device out." },
    OPTS
  );
  return true;
}

// A one-time code for linking another device, good for 30 minutes. Replaces any unused code.
export async function newLinkCode() {
  const code = randomBytes(16).toString("hex");
  const expires = new Date(Date.now() + LINK_MINUTES * 60000).toISOString();
  await wixData.save(SETTINGS, { _id: "adminClaim", value: code, note: `expires ${expires} (made on the admin page)` }, OPTS);
  return { code, expires };
}

/* ───────────────────────── What the admin page shows ───────────────────────── */

async function safe(promise, fallback) {
  try {
    return await promise;
  } catch (err) {
    console.error("Leviath admin: a lookup failed", err);
    return fallback;
  }
}

const iso = (v) => {
  const t = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

function shiftDay(day, n) {
  return new Date(Date.parse(day + "T00:00:00Z") - n * DAY).toISOString().slice(0, 10);
}

// How much a daily figure grew over the last n days, using the newest reading on or before n days earlier.
function gained(daysNewestFirst, field, n) {
  const latest = daysNewestFirst.find((d) => num(d[field]));
  if (!latest) return null;
  const target = shiftDay(latest.day, n);
  const before = daysNewestFirst.find((d) => d.day <= target && num(d[field]));
  return before ? num(latest[field]) - num(before[field]) : null;
}

export async function adminData(request, hub) {
  const now = Date.now();
  const me = addressOf(request);
  const { pitches, snapshots, daily } = COLLECTIONS;

  const [latestPitches, pitchCount, pitchWeek, lastSnap, snapCount, days, week, devices, hook, lastPost, claim] = await Promise.all([
    safe(wixData.query(pitches).descending("submitted").limit(50).find(OPTS), { items: [] }),
    safe(wixData.query(pitches).count(OPTS), null),
    safe(wixData.query(pitches).ge("submitted", new Date(now - 7 * DAY)).count(OPTS), null),
    safe(wixData.query(snapshots).descending("t").limit(1).find(OPTS), { items: [] }),
    safe(wixData.query(snapshots).count(OPTS), null),
    safe(wixData.query(daily).descending("day").limit(1000).find(OPTS), { items: [] }),
    safe(wixData.query(snapshots).ge("t", new Date(now - 7 * DAY)).ascending("t").limit(1000).find(OPTS), { items: [] }),
    safe(linkedDevices(), []),
    safe(discordWebhook(), null),
    setting("discordLastPost"),
    setting("adminClaim"),
  ]);

  const dayRows = days.items.filter((d) => d && /^\d{4}-\d{2}-\d{2}$/.test(d.day));
  const lastAt = lastSnap.items[0] ? iso(lastSnap.items[0].t) : null;
  const peakRow = dayRows.reduce((best, d) => (num(d.peakPlaying) > num(best && best.peakPlaying) ? d : best), null);
  const claimExpires = claim && /^expires (\S+)/.exec(String(claim.note || ""));
  const claimLive = claim && String(claim.value || "").trim().length >= MIN_CODE && (!claimExpires || Date.parse(claimExpires[1]) > now);

  return {
    now: new Date(now).toISOString(),
    you: me,
    devices: devices.map((address) => ({ address, current: sameDevice(address, me) })),
    linkPending: claimLive ? { expires: claimExpires ? iso(claimExpires[1]) : null } : null,
    live: hub
      ? {
          updatedAt: hub.updatedAt,
          stale: !!hub.stale,
          totals: hub.totals,
          members: hub.group ? hub.group.members : null,
          games: hub.games.map((g) => ({
            placeId: g.placeId,
            name: g.name,
            tag: g.tag,
            icon: g.icon,
            playing: g.playing,
            visits: g.visits,
            favorites: g.favorites,
            rating: g.rating,
            updated: g.updated,
          })),
        }
      : null,
    pitches: {
      total: pitchCount,
      week: pitchWeek,
      latest: latestPitches.items.map((p) => ({
        game: String(p.game || ""),
        discord: String(p.discord || ""),
        message: String(p.message || ""),
        submitted: iso(p.submitted || p._createdDate),
      })),
    },
    growth: {
      visits: { day: gained(dayRows, "totalVisits", 1), week: gained(dayRows, "totalVisits", 7), month: gained(dayRows, "totalVisits", 30) },
      members: { day: gained(dayRows, "members", 1), week: gained(dayRows, "members", 7), month: gained(dayRows, "members", 30) },
      peakWeek: dayRows.slice(0, 7).reduce((m, d) => Math.max(m, num(d.peakPlaying) || 0), 0) || null,
      peakEver: peakRow ? { players: num(peakRow.peakPlaying), day: peakRow.day } : null,
    },
    history: {
      lastSnapshot: lastAt,
      onTime: !!lastAt && now - Date.parse(lastAt) < HOURLY_JOB_LATE_AFTER,
      snapshots: snapCount,
      days: dayRows.length,
      firstDay: dayRows.length ? dayRows[dayRows.length - 1].day : null,
      week: week.items.map((s) => [Math.floor(Date.parse(iso(s.t)) / 1000), num(s.totalPlaying) || 0]).filter((p) => Number.isFinite(p[0])),
      daily: dayRows
        .slice(0, 31)
        .reverse()
        .map((d) => ({ day: d.day, visits: num(d.totalVisits), members: num(d.members), peak: num(d.peakPlaying) })),
    },
    discord: {
      webhook: !!hook,
      lastPost: lastPost && lastPost.value ? { result: String(lastPost.value), at: iso(lastPost.note) } : null,
    },
  };
}
