# Moving households and reassigning workers between areas

**Status: Proposed, not implemented.** Nothing in this document is built. Today
no endpoint moves a household between areas, and reassigning a worker through
the admin panel works on the server but leaves their phone uncleaned. The
interim procedure for reassignments is
[below](#interim-procedure-what-the-admin-screen-tells-the-admin-today).

Both problems have the same root. A field worker's phone holds the records of
their area (see `server/sync/scopeRules.js`), and pull only ever *adds or
updates* rows inside the current scope. When the line between "my area" and
"not my area" moves, whether because a household moved or because the worker
did, nothing tells the phone that rows it already holds are now outside it.

---

## Part 1: Moving a household to another area

### The move (server)

`POST /api/admin/records/:id/move` with body `{ toAreaId, expectedVersion }`.
Admin-only and online-only, like the rest of `/api/admin`. One transaction,
**records row locked first**, which is the lock order the push route
(`applyOne`) and the resolve route already use:

1. `SELECT … FROM records WHERE id = ? AND organization_id = ? FOR UPDATE`.
   - 404 if there's no such record in this organisation.
   - 409 if it is a tombstone. Moving one would deliver a deletion into an area
     that never held the record.
   - 409 if `version ≠ expectedVersion`: the admin decided on a copy that has
     since changed, so they should sync first.
   - 200 with no write if it is already in `toAreaId`.
2. `toAreaId` must be an area of this organisation.
3. **Refuse with 409 while the record has an open conflict.** The resolutions
   feed for field workers follows the record's *current* area, so the worker
   who raised it would never learn the outcome. This check can't race: filing a
   conflict (push) and closing one (resolve) both lock this records row first,
   so nothing can be filed or resolved while the move holds it.
4. Read `NOW(3)` once, then write:
   `UPDATE records SET area_id = ?, version = version + 1, updated_at = ?, updated_by = <admin>, device_id = RESOLVED_DEVICE_ID`.
   - `updated_at` is set explicitly, for the same reason the push route gives.
   - `device_id` is the reserved nil id because no phone wrote this version.
     Otherwise a lost-response retry from the last pusher's phone would match
     the echo rule in `classifyPush` and overwrite past the move with no
     conflict.
5. Insert one row into `record_area_moves` with the same timestamp, so a
   device sees the record arrive in the new area and leave the old one at the
   same cursor position.

### Migration 006 (mirrored in `schema.sql`)

```sql
CREATE TABLE record_area_moves (
  id              CHAR(36)    NOT NULL,
  record_id       CHAR(36)    NOT NULL,
  organization_id CHAR(36)    NOT NULL,
  from_area_id    CHAR(36)    NULL,      -- NULL: the record had no area
  to_area_id      CHAR(36)    NOT NULL,
  version         INT         NOT NULL,  -- the version the move wrote
  moved_by        CHAR(36)    NOT NULL,
  moved_at        DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_moves_org_from_moved (organization_id, from_area_id, moved_at),
  KEY idx_moves_record (record_id),
  -- plus: record_id -> records, moved_by -> users (RESTRICT), and
  -- (organization_id, from/to_area_id) -> areas (organization_id, id),
  -- composite like users.area_id and records.area_id
) ENGINE=InnoDB;
```

Rows are only ever added, never updated or deleted, and devices never write
here. So it does not need the syncable-table columns (`version`, `updated_at`,
`deleted_at`). It is also the area history `records` does not keep.

### New-area devices

They need nothing new. The move moved `updated_at`, so the record falls into
every new-area cursor window and arrives as an ordinary insert. Supervisors'
phones overwrite their copy, which updates its `areaId`.

### Old-area devices: the departures feed

`GET /api/sync/departures` takes `since`, `until`, `scope`, `afterMovedAt`,
`afterId` and `limit`. It uses the same window, the same per-user cursor and the
same scope check (`sinceForScope`) as `/api/sync/resolutions`. The resolutions
feed fixes `until`, and departures and records reuse it, so one sync still reads
one interval and stores one cursor.

- **Field worker:** moves whose `from_area_id` is their area, or is NULL for a
  record they created. This is the pull predicate applied to where the record
  *was*, not where it is now.
- **Supervisor or admin:** always empty, because an organisation-wide scope
  never loses a record to another area.
- **Each entry:** `{ id, fromAreaId, version, movedAt }` plus the move id for
  the keyset. There is no household content and no destination, because the
  old area's phones have no business knowing where a household went.

The device's order within one sync becomes: push, resolutions, **departures**,
records, then the end-of-sync sweeps. Departures come before records so that a
record that moved out and back within one window (A→B→A) is removed and then
re-added by the record page, which carries a higher version.

### Device rule: `classifyDeparture(local, departure)`

A pure function in `client/src/sync/pullRules.js`, tested like the others:

| Local row | Action |
|---|---|
| none | skip |
| `syncedVersion ≥ departure.version` | skip: the phone already holds the post-move copy |
| holds unsent work (pending, rejected, or `legacyDeletionLock`) | keep, and mark it with the departure |
| synced, or in a conflict the server filed | remove it from IndexedDB |

- **The version check** matters on shared phones. A supervisor's or a new-area
  user's pull may already have put the post-move copy on this phone, and their
  cursor is past it. Removing it would lose it for them for good. `scope.js`
  already hides it from the old-area worker.
- **Removing is safe** because the server holds every byte, including conflict
  payloads in `record_conflicts`. It removes this phone's copy; it is not a
  deletion of the record.
- **The sweep:** at the end of each sync, marked rows that no longer hold
  unsent work are removed.

### Unsent old-area edits: file a conflict instead of refusing

Today, an old-area worker's push of an edit made before the move is refused as
`forbidden`, becomes a rejected row, and is stuck on that one phone.

Proposed change to `applyOne`: when `mayWrite` fails, look for a
`record_area_moves` row for this record that

- has `version > baseVersion`, and
- has `from_area_id` equal to the actor's area, or NULL with the actor as the
  record's creator.

If one exists, file the push as a conflict (`fileConflict`) instead of refusing
it. The bump makes the base stale by construction.

- **The response omits the server copy.** Post-move content is now outside this
  worker's scope. `applyResults` and the conflict view must handle a conflict
  with no server copy.
- **A supervisor resolves it** in the normal queue. Any outcome applies to the
  record in its new area.
- **The worker's phone** then removes the row through the sweep.

### Where an admin triggers it

A "Move to area" action on the record list, shown to admins only and online
only. It sends the device's `syncedVersion` as `expectedVersion`. No new online
records listing is needed, because an admin's phone already holds the whole
organisation.

### Trade-offs to decide

- **An exception to "push authorisation is `mayWrite` = may see".** An
  out-of-scope worker may *file a conflict*, but never write, for a record that
  left their area after the version they hold. It is the only way that work
  reaches the server; the alternative is accepting that it stays stuck.
- **The version bump causes extra conflicts.** Anyone else holding an unsent
  edit made before the move, mostly supervisors, gets a conflict caused only by
  the move. Not bumping avoids that, but then old-area edits carry a current
  base and the area alone has to decide. Recommended: bump.
- **Old-area workers never see how their conflict was resolved.** Their phone
  removes the row instead, and the work survives in `record_conflicts`.
- **Rejected (invalid-payload) rows** wait until the worker edits them.
- **A phone that never syncs again keeps its copy.**
- **`record_area_moves` is never pruned**, like tombstones.
- **Idempotency gap gets likelier.** Overwriting `device_id` turns a
  lost-response retry from the last pusher into a false conflict. This is the
  existing idempotency gap in CLAUDE.md, made slightly more likely.
- **Two text changes.** The conflict screen labels a nil-device version
  "resolved on the server"; it would become "changed on the server". CLAUDE.md's
  "area set at first insert" gains "or by an admin move".

### Alternatives rejected

- **A `records.previous_area_id` column.** It remembers only the last move. If
  a record goes A→B→C before an A phone syncs, A is never told.
- **Sending the moved record itself to old-area phones**, relying on its new
  `areaId` to hide it. That puts current household content on phones outside
  its area and breaks the containment rule.

---

## Part 2: Reassigning a worker to another area

This works on the server today, through `PATCH /api/admin/users/:id` with a new
`areaId`. These findings come from reading the code, not from a device test.

### What happens on the worker's phone today

On the first sync after the change, the server reads the new area (`loadArea`)
and the cursor's scope key no longer matches, so the pull starts the new area
from the beginning (`sinceForScope`). `adoptServedArea` updates the cached area,
and the list filters by it. Nothing touches the rows the phone already holds:
pull only inserts and updates.

- **Synced old-area rows** stay in IndexedDB. `canSeeRecord` hides them from
  the list, but a lost phone still exposes them.
- **Unsent edits to old-area rows** are pushed first in that same sync, because
  sync order is push then pull. By then the server already uses the new area:
  - `mayWrite` fails and the push is refused as `forbidden` ("This record
    belongs to someone else.").
  - `applyResults` makes the row rejected. Only pending rows are ever pushed, so
    it is never retried.
  - It is hidden, so it can't be edited back into the queue either.
  - It is stuck on that one phone. The only sign is the unsynced count in the
    Remove account warning (`countUnsyncedOnDevice` counts it as "mine").
- **Conflicts raised in the old area** never receive their resolution. The
  field-worker resolutions query filters on the record's current
  `area_id = ?`, so the row stays locked and hidden for good.
- **Records captured before the move but pushed after it** are filed under the
  *new* area, because the server sets the area at first insert from the
  worker's area at that moment. This is an existing gap that the fix below does
  not change.
- **Demoting a supervisor or admin to field worker** has the same effect on a
  larger scale: the whole organisation stays on their phone, hidden. The admin
  screen's warning is shown for area changes only, not role changes.

### Interim procedure (what the admin screen tells the admin today)

When an admin changes a field worker's area, the edit form says:

> Before saving, ask the worker to sync. After saving, they must use 'Remove
> account from device' and sign in again online, otherwise old-area households
> stay on their phone and unsent edits to them get stuck.

Remove account clears **every** IndexedDB table on that phone: all users'
records, cursors and the cached sign-in. On a shared phone, everyone else who
uses it should sync first too. The panel counts their unsynced records but
cannot prevent the loss. After signing in again, the phone pulls the new area
from the beginning.

### Proposed fix (smallest correct)

**Device half.** Applies when a sync is served in a scope other than the one the
stored cursor was stamped with, i.e. `windowStart()` returns null for a non-null
cursor. After the push and the pull, look at every row `canSeeRecord` now hides:

- **Remove** synced rows and conflicts the server has filed.
- **Keep and mark** pending and rejected rows and the legacy lock. The same
  end-of-sync sweep as Part 1 removes them once they hold no unsent work.
- **In the same Dexie transaction, delete the other users' stored cursors**
  (`meta`, key `syncCursor:<userId>`). Other people on this phone may still be
  able to see those rows, and their cursors are past them; without this they
  would never get them back. Their next sync re-downloads from the beginning,
  which REPLAY SAFETY in `pullRules.js` makes harmless. The cost is one full
  pull per other user on that phone.

This also covers a supervisor demoted to field worker, because the scope key
changes.

**Server half.** It needs to know where the worker used to be:

- **A reassignment log**, e.g.
  `user_scope_changes(id, user_id, organization_id, from_role, from_area_id, to_role, to_area_id, changed_by, changed_at DATETIME(3))`.
  It is written by `PATCH /api/admin/users/:id` in the same transaction,
  whenever role or area changes.
- **The push rule.** In `applyOne`, when `mayWrite` fails but an earlier scope
  of the actor from that log could see the stored record, file a conflict (no
  server copy in the response) instead of refusing.

**Limits:**

- Without the log, any field worker could file conflicts against any record
  whose id they know. The log limits that to areas they actually worked.
- A record that moved *and* a worker who moved can still miss each other.
- The log is never pruned.

### Could the departures feed cover this?

**The feed itself does not.** It lists records that moved, and reassigning a
worker moves no records. The server could only fake it by emitting a departure
for every record of the old area. It doesn't need to, because the phone already
knows its scope changed and holds each row's `areaId`.

**Most of Part 1's code carries over.** `classifyDeparture`'s keep/remove rules
and the end-of-sync sweep apply unchanged once "the scope changed" is treated as
"every row outside the new scope has departed". The "file a conflict instead of
refusing" exception becomes one check with two sources: the record moved
(`record_area_moves`), or the worker did (`user_scope_changes`).

**Recommendation:** build both together, as one piece of work.

---

## Open questions

1. Should supervisors be able to move households, or only admins?
2. Is the "file a conflict instead of `forbidden`" exception to
   `mayWrite` = may see acceptable?
3. Should the admin screen also show the reassignment procedure when a
   supervisor or admin is demoted to field worker?

## Rough size

- **Migrations and schema:** 006 (and the reassignment log), mirrored in
  `schema.sql`.
- **Server:**
  - the move route;
  - the departures route;
  - the push exception;
  - pure rules with tests (`scopeRules.js` / `pushRules.js`).
- **Client:**
  - `classifyDeparture` and the scope-change rule with tests;
  - the departures walk and sweep in `syncEngine.js`;
  - accepting a conflict with no server copy;
  - a notice on kept rows;
  - the "Move to area" action.
