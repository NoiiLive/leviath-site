// What the pages can ask the backend for. Live numbers are cached for 30 seconds and history for
// 5 minutes, so every visitor shares the same Roblox lookups.
import { Permissions, webMethod } from "wix-web-module";
import { buildHub, readHistory, savePitch } from "backend/leviath-core";

export const getHub = webMethod(
  Permissions.Anyone,
  async () => {
    try {
      return await buildHub();
    } catch (err) {
      console.error("Leviath getHub failed", err);
      return { error: "Roblox didn't respond. Try again shortly." };
    }
  },
  { cache: { tags: ["leviath-hub"], ttl: 30 } }
);

export const getHistory = webMethod(
  Permissions.Anyone,
  async () => {
    try {
      return await readHistory();
    } catch (err) {
      console.error("Leviath getHistory failed", err);
      return { enabled: false, error: "History isn't available yet." };
    }
  },
  { cache: { tags: ["leviath-history"], ttl: 300 } }
);

export const submitPitch = webMethod(Permissions.Anyone, async (pitch) => {
  try {
    return await savePitch(pitch);
  } catch (err) {
    console.error("Leviath submitPitch failed", err);
    return { ok: false, error: "That didn't go through. Message us on Discord instead." };
  }
});