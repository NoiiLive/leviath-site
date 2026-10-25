// The Leviath site's web addresses, all on your own domain:
//   /_functions/site       the script that draws the site (loaded by the site-wide code in Settings → Custom Code)
//   /_functions/hub        live numbers from Roblox
//   /_functions/history    the recorded history for the growth charts
//   /_functions/pitch      the Contact page's pitch form
//   /_functions/admin      links a device with a one-time code, then opens leviath.co/#/admin (see leviath-admin.js)
//   /_functions/adminApp   the admin page itself, sent only to linked devices
import { ok, badRequest, serverError, notFound, response } from "wix-http-functions";
import { buildHub, readHistory, savePitch, SITE_INFO } from "backend/leviath-core";
import { isAdmin, claimDevice, adminData, newLinkCode } from "backend/leviath-admin";
import { LEVIATH_SITE_JS } from "backend/leviath-site";
import { ADMIN_APP_JS } from "backend/leviath-admin-app";

const HUB_SECONDS = 30;
const HISTORY_SECONDS = 120;
const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
const ADMIN_HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
};

let hubMemo = null;
let historyMemo = null;

function json(make, body) {
  return make({ headers: JSON_HEADERS, body: JSON.stringify(body) });
}

// Live numbers, fetched from Roblox at most every 30 seconds. If Roblox doesn't answer, the last numbers are
// reused and marked stale.
async function hubData() {
  if (hubMemo && Date.now() - hubMemo.at < HUB_SECONDS * 1000) return hubMemo.data;
  try {
    const data = await buildHub();
    hubMemo = { at: Date.now(), data };
    return data;
  } catch (err) {
    console.error("Leviath hub failed", err);
    if (hubMemo) return { ...hubMemo.data, stale: true };
    throw err;
  }
}

export function get_site(request) {
  const settings = JSON.stringify(SITE_INFO).replace(/</g, "\\u003c");
  return ok({
    headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "public, max-age=300" },
    body: `window.__LEVIATH_SETTINGS = ${settings};\n${LEVIATH_SITE_JS}`,
  });
}

export async function get_hub(request) {
  try {
    return json(ok, await hubData());
  } catch (err) {
    return json(serverError, { error: "Roblox didn't respond. Try again shortly." });
  }
}

export async function get_history(request) {
  if (historyMemo && Date.now() - historyMemo.at < HISTORY_SECONDS * 1000) return json(ok, historyMemo.data);
  try {
    const data = await readHistory();
    historyMemo = { at: Date.now(), data };
    return json(ok, data);
  } catch (err) {
    console.error("Leviath history failed", err);
    return json(ok, { enabled: false, error: "History isn't available yet.", live: [], week: [], daily: [] });
  }
}

export async function post_pitch(request) {
  let pitch;
  try {
    pitch = await request.body.json();
  } catch (err) {
    return json(badRequest, { ok: false, error: "The form didn't come through. Refresh the page and try again." });
  }
  try {
    const result = await savePitch(pitch);
    return json(result.ok ? ok : badRequest, result);
  } catch (err) {
    console.error("Leviath pitch failed", err);
    return json(serverError, { ok: false, error: "That didn't go through. Message us on Discord instead." });
  }
}

/* ───────────────────────── Admin ───────────────────────── */

function hidden() {
  return notFound({ headers: { ...ADMIN_HEADERS, "Content-Type": "text/plain; charset=utf-8" }, body: "Not found" });
}

function adminJson(body) {
  return ok({ headers: { ...ADMIN_HEADERS, "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify(body) });
}

// The admin page's own requests carry this header. Other sites can't add it to a request without the
// browser asking this site first, and this site never agrees, so they can't make your browser act here.
function fromAdminPage(request) {
  const headers = (request && request.headers) || {};
  return Object.keys(headers).some((k) => k.toLowerCase() === "x-leviath-admin" && String(headers[k]) === "1");
}

async function adminAllowed(request) {
  try {
    return await isAdmin(request);
  } catch (err) {
    console.error("Leviath admin check failed", err);
    return false;
  }
}

export async function get_admin(request) {
  let allowed = await adminAllowed(request);
  const code = request && request.query ? request.query.claim : null;
  if (!allowed && code) {
    try {
      allowed = await claimDevice(request, code);
    } catch (err) {
      console.error("Leviath admin link failed", err);
    }
  }
  if (!allowed) return hidden();
  return response({
    status: 302,
    headers: { ...ADMIN_HEADERS, Location: "/#/admin", "Content-Type": "text/html; charset=utf-8" },
    body: '<!doctype html><meta http-equiv="refresh" content="0;url=/#/admin"><a href="/#/admin">Open the admin page</a>',
  });
}

// The admin page is drawn on the site's own page at leviath.co/#/admin, by this script.
export async function get_adminApp(request) {
  if (!(await adminAllowed(request))) return hidden();
  return ok({ headers: { ...ADMIN_HEADERS, "Content-Type": "application/javascript; charset=utf-8" }, body: ADMIN_APP_JS });
}

export async function get_adminData(request) {
  if (!fromAdminPage(request) || !(await adminAllowed(request))) return hidden();
  let hub = null;
  try {
    hub = await hubData();
  } catch (err) {
    hub = null;
  }
  try {
    return adminJson(await adminData(request, hub));
  } catch (err) {
    console.error("Leviath admin data failed", err);
    return serverError({ headers: { ...ADMIN_HEADERS, "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify({ error: "Couldn't load the admin data." }) });
  }
}

export async function post_adminLink(request) {
  if (!fromAdminPage(request) || !(await adminAllowed(request))) return hidden();
  try {
    return adminJson(await newLinkCode());
  } catch (err) {
    console.error("Leviath admin link code failed", err);
    return serverError({ headers: { ...ADMIN_HEADERS, "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify({ error: "Couldn't make a link." }) });
  }
}
