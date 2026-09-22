import { db } from "../db/index.js";

// Row in `meta` recording the last persistence check, so the UI can surface it
// later without asking the browser again.
export const PERSISTENT_STORAGE_META_KEY = "persistentStorage";

// The result is the same for the whole session, so log it once instead of on
// every login.
let alreadyLogged = false;

function logOnce(state) {
  if (alreadyLogged) return;
  alreadyLogged = true;

  if (!state.supported) {
    console.info("Persistent storage is not supported; data may be evicted.");
  } else if (state.granted) {
    console.info("Persistent storage granted.");
  } else {
    console.warn(
      "Persistent storage denied; the browser may evict local data under storage pressure."
    );
  }
}

async function readPersistenceState() {
  // Absent on older Safari and in some embedded webviews. Missing support is a
  // normal outcome, never an error: it only means data can be evicted.
  if (!navigator.storage?.persist || !navigator.storage?.persisted) {
    return { supported: false, granted: false };
  }

  // Asking again when it is already granted just wastes a call, and in some
  // browsers re-prompts the user.
  if (await navigator.storage.persisted()) {
    return { supported: true, granted: true, alreadyGranted: true };
  }

  return { supported: true, granted: await navigator.storage.persist() };
}

/**
 * Asks the browser to make this origin's storage persistent, so IndexedDB is not
 * evicted under storage pressure. Once records are collected, an eviction is
 * silent loss of unsynced field data.
 *
 * Call this after a successful online login, not at startup: browsers grant
 * persistence on engagement signals, and a request on a cold first paint is
 * usually refused outright. A worker who has just signed in is a far stronger
 * signal, and an online login means any refusal can still be retried later.
 *
 * Never throws and never blocks login. A failure here only costs us eviction
 * protection.
 */
export async function ensurePersistentStorage() {
  let state;
  try {
    state = await readPersistenceState();
  } catch (error) {
    console.warn("Persistent storage request failed:", error);
    state = { supported: true, granted: false, error: String(error) };
  }

  logOnce(state);

  try {
    await db.meta.put({
      key: PERSISTENT_STORAGE_META_KEY,
      value: { ...state, checkedAt: Date.now() },
    });
  } catch (error) {
    console.warn("Could not record persistent storage state:", error);
  }

  return state;
}
