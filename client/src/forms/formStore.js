import Dexie from "dexie";
import { db } from "../db/index.js";

// The published forms this device holds, per organisation. No network code:
// what is here was put here by sync/formSync.js, and every screen reads it the
// same way online or off.

// Fired after the stored forms change, so a screen showing a form can pick up
// a newly published version without waiting for its own next read.
export const FORMS_UPDATED_EVENT = "setu:forms-updated";

/** Every published definition this device holds for one organisation. */
export async function loadCatalog(organizationId) {
  if (!organizationId) return [];
  return db.forms
    .where("[organizationId+formType+version]")
    .between(
      [organizationId, Dexie.minKey, Dexie.minKey],
      [organizationId, Dexie.maxKey, Dexie.maxKey]
    )
    .toArray();
}

/**
 * Replaces one organisation's forms with what the server just sent.
 *
 * Replaced whole rather than merged: the server sends every published version
 * every time, and published versions never change, so the answer IS the
 * catalog. One transaction, so a screen never reads a half-written set.
 */
export async function replaceCatalog(organizationId, forms) {
  const rows = forms.map((form) => ({
    id: form.id,
    organizationId,
    formType: form.formType,
    version: form.version,
    title: form.title,
    fields: form.fields,
    publishedAt: form.publishedAt ?? null,
  }));

  await db.transaction("rw", db.forms, async () => {
    await db.forms
      .where("[organizationId+formType+version]")
      .between(
        [organizationId, Dexie.minKey, Dexie.minKey],
        [organizationId, Dexie.maxKey, Dexie.maxKey]
      )
      .delete();
    await db.forms.bulkPut(rows);
  });
}
