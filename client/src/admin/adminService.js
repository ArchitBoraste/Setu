import { apiFetch } from "../lib/api.js";

// ONLINE-ONLY, ON PURPOSE — the second deliberate exception in client/src, after
// conflicts/conflictService.js, and for the same kind of reason.
//
// Creating accounts, moving a worker between villages, deactivating someone and
// resetting a password are privileged decisions about other people's access.
// Queued offline on two admins' phones they would land in an order nobody chose
// — a worker reactivated by one admin after the other deactivated them for
// cause, each believing their decision stood. There is no version ladder for
// "who may sign in", and building one to reconcile admin decisions would be
// reconciling human judgement, which does not merge.
//
// So nothing here touches IndexedDB, and nothing is queued. The screen says it
// needs a connection and draws no forms while offline; a failed request is
// reported as failed, never retried behind the admin's back. Capture is
// unaffected: no field worker's path to saving or syncing a household visit
// passes through this file.
//
// Every call goes through apiFetch on a relative /api/ path, so the Vite proxy
// and production Nginx both route it.

const ADMIN_PATH = "/api/admin";

export function listUsers() {
  return apiFetch(`${ADMIN_PATH}/users`);
}

/** @param {{ fullName, phone, role, areaId, password }} user */
export function createUser(user) {
  return apiFetch(`${ADMIN_PATH}/users`, { method: "POST", body: user });
}

/**
 * Only the fields being changed. Sending unchanged ones is not harmless: a
 * role in the body makes the server check that role's area rule, which a field
 * worker from before areas would fail on a simple rename.
 */
export function updateUser(userId, changes) {
  return apiFetch(`${ADMIN_PATH}/users/${userId}`, { method: "PATCH", body: changes });
}

export function resetPassword(userId, password) {
  return apiFetch(`${ADMIN_PATH}/users/${userId}/reset-password`, {
    method: "POST",
    body: { password },
  });
}

export function listAreas() {
  return apiFetch(`${ADMIN_PATH}/areas`);
}

export function createArea(name) {
  return apiFetch(`${ADMIN_PATH}/areas`, { method: "POST", body: { name } });
}

export function renameArea(areaId, name) {
  return apiFetch(`${ADMIN_PATH}/areas/${areaId}`, { method: "PATCH", body: { name } });
}

// Form versions. Online-only like everything above: two admins publishing from
// two offline phones would each mint the same version number.

export function listFormDefinitions() {
  return apiFetch(`${ADMIN_PATH}/forms`);
}

/** A draft of the next version, copied from the latest published one. */
export function createFormDraft(formType) {
  return apiFetch(`${ADMIN_PATH}/forms/${encodeURIComponent(formType)}/drafts`, {
    method: "POST",
  });
}

/** @param {{ title, fields }} definition */
export function saveFormDraft(draftId, definition) {
  return apiFetch(`${ADMIN_PATH}/forms/drafts/${draftId}`, { method: "PUT", body: definition });
}

export function deleteFormDraft(draftId) {
  return apiFetch(`${ADMIN_PATH}/forms/drafts/${draftId}`, { method: "DELETE" });
}

export function publishFormDraft(draftId) {
  return apiFetch(`${ADMIN_PATH}/forms/drafts/${draftId}/publish`, { method: "POST" });
}
