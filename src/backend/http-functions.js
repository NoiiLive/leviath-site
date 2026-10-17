// The Leviath site's web addresses, all on your own domain:
//   /_functions/site     the script that draws the site (loaded by the site-wide code in Settings → Custom Code)
//   /_functions/hub      live numbers from Roblox
//   /_functions/history  the recorded history for the growth charts
//   /_functions/pitch    the Contact page's pitch form
import { ok, badRequest, serverError } from "wix-http-functions";
import { buildHub, readHistory, savePitch, SITE_INFO } from "backend/leviath-core";
import { LEVIATH_SITE_JS } from "backend/leviath-site";

const HUB_SECONDS = 30;
const HISTORY_SECONDS = 120;
const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };

let hubMemo = null;
let historyMemo = null;

function json(make, body) {
  return make({ headers: JSON_HEADERS, body: JSON.stringify(body) });
}

export function get_site(request) {
  const settings = JSON.stringify(SITE_INFO).replace(/</g, "\\u003c");
  return ok({
    headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "public, max-age=300" },
    body: `window.__LEVIATH_SETTINGS = ${settings};\n${LEVIATH_SITE_JS}`,
  });
}

export async function get_hub(request) {
  if (hubMemo && Date.now() - hubMemo.at < HUB_SECONDS * 1000) return json(ok, hubMemo.data);
  try {
    const data = await buildHub();
    hubMemo = { at: Date.now(), data };
    return json(ok, data);
  } catch (err) {
    console.error("Leviath hub failed", err);
    if (hubMemo) return json(ok, { ...hubMemo.data, stale: true });
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
