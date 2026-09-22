import { db } from "../db/index.js";

export const DEVICE_ID_META_KEY = "deviceId";

/**
 * crypto.randomUUID() only exists in a secure context (https or localhost).
 * Served over plain http on a LAN address it is undefined, and without a
 * fallback a field worker could not save anything at all. getRandomValues has
 * the same availability caveat but far wider support, and a v4 UUID built from
 * it is just as collision-safe.
 */
export function newUuid() {
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();

  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * One identity per install, generated once and reused forever. Every record
 * carries it, so a row can always be traced back to the phone that captured it,
 * which is what makes an audit trail and later conflict attribution possible.
 *
 * Read and write happen in one transaction: two callers racing on first launch
 * would otherwise each see an empty table and mint a different id, and the
 * loser's records would be attributed to a device that never existed.
 */
export function getDeviceId() {
  return db.transaction("rw", db.meta, async () => {
    const existing = await db.meta.get(DEVICE_ID_META_KEY);
    if (existing?.value) return existing.value;

    const deviceId = newUuid();
    await db.meta.put({ key: DEVICE_ID_META_KEY, value: deviceId });
    return deviceId;
  });
}
