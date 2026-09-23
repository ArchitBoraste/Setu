// Who may see which records: the rule behind the pull, the resolutions feed and
// push authorisation, kept in one place so the three cannot drift apart.
//
// Pure functions over plain objects, like pushRules.js and pullRules.js. The SQL
// in routes/sync.js states the same rule as a WHERE clause; this is the
// statement of it that can be tested without a database.
//
// THE RULE
//
//   supervisor, admin   the whole organisation
//   field worker        records in their own area, plus any record with NO area
//                       that they captured themselves
//
// A record with no area is visible only to its creator and to supervisors. Those
// are records captured before areas existed, or by a worker who had none — and
// nobody decided to widen who can read them, so nobody does.
//
// `actor` is always built from the verified JWT (id, role, organization) and a
// fresh read of users.area_id on this request. Nothing the request carries is
// read to decide scope, so a device cannot widen its own reach by asking.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Roles whose work spans the whole organisation rather than one area.
export const ORGANISATION_ROLES = new Set(["supervisor", "admin"]);

export const SCOPE_KIND = {
  ORGANISATION: "org",
  AREA: "area",
  // A field worker with no area: only their own records with no area.
  OWN: "own",
};

/**
 * Which records this actor may see, as a kind plus a key.
 *
 * The key names the SET OF ROWS, not the person, and is what a device's sync
 * cursor is stamped with (see sinceForScope in pullRules.js). It carries the
 * organisation or area id rather than just the kind, because "the organisation"
 * for someone moved between organisations, or "my area" for someone moved
 * between villages, is a different set of rows under the same word.
 *
 * @param {object} actor  { id, role, organizationId, areaId }
 */
export function scopeFor(actor) {
  if (ORGANISATION_ROLES.has(actor.role)) {
    return {
      kind: SCOPE_KIND.ORGANISATION,
      key: `${SCOPE_KIND.ORGANISATION}:${actor.organizationId}`,
    };
  }
  if (actor.areaId) {
    return { kind: SCOPE_KIND.AREA, key: `${SCOPE_KIND.AREA}:${actor.areaId}` };
  }
  return { kind: SCOPE_KIND.OWN, key: `${SCOPE_KIND.OWN}:${actor.organizationId}` };
}

/** A scope key as a device may send it back. Anything else was not minted here. */
export function isScopeKey(value) {
  if (typeof value !== "string") return false;
  const separator = value.indexOf(":");
  if (separator < 0) return false;
  const kind = value.slice(0, separator);
  return (
    Object.values(SCOPE_KIND).includes(kind) && UUID_RE.test(value.slice(separator + 1))
  );
}

/**
 * May this actor see this record? The WHERE clause of every field worker's pull,
 * as a predicate.
 *
 * @param {object} actor   { id, role, organizationId, areaId }
 * @param {object} record  { organizationId, areaId, createdBy }
 */
export function canSeeRecord(actor, record) {
  if (record.organizationId !== actor.organizationId) return false;
  if (ORGANISATION_ROLES.has(actor.role)) return true;
  if (record.areaId != null) return record.areaId === actor.areaId;
  return record.createdBy === actor.id;
}
