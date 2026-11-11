import { apiFetch } from "../lib/api.js";
import { getCachedUser } from "../auth/authService.js";
import { FORMS_UPDATED_EVENT, replaceCatalog } from "../forms/formStore.js";

// Downloads the organisation's published forms into IndexedDB.
//
// Part of the sync layer, like syncEngine.js: no screen waits on it to capture.
// It runs at an online sign-in and at the start of every sync — moments when
// the device is talking to the server anyway — and capture then reads whatever
// it last stored, offline or not. A failure leaves the previous forms in
// place, which is always safe: a published version never stops being valid.

const FORMS_PATH = "/api/forms";

// The server is trusted on content, but a row the form renderer cannot draw at
// all would break the capture screen, so only well-shaped rows are kept.
function isUsable(form) {
  return (
    typeof form?.id === "string" &&
    typeof form.formType === "string" &&
    Number.isInteger(form.version) &&
    typeof form.title === "string" &&
    Array.isArray(form.fields)
  );
}

/**
 * Fetches and stores the signed-in user's forms. Throws what apiFetch throws
 * (NetworkError, NotAuthenticatedError, ApiError); callers decide which of
 * those matter to them.
 *
 * @returns {Promise<{ stored: number } | { stored: 0, skipped: string }>}
 */
export async function refreshForms() {
  const user = await getCachedUser();
  if (!user) return { stored: 0, skipped: "signed out" };

  const { forms } = await apiFetch(FORMS_PATH);

  // The answer is for whoever's token made the request. If somebody else signed
  // in on this phone while it was in flight, it is not theirs to store — even
  // filed under the first user's organisation, it would be the wrong moment to
  // tell their screens that forms changed.
  const current = await getCachedUser();
  if (current?.userId !== user.userId) return { stored: 0, skipped: "user changed" };

  const usable = Array.isArray(forms) ? forms.filter(isUsable) : [];
  await replaceCatalog(user.organizationId, usable);
  window.dispatchEvent(new Event(FORMS_UPDATED_EVENT));
  return { stored: usable.length };
}
