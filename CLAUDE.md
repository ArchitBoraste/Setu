# Setu

Offline-first field data collection platform for community health and NGO workers.

## Hard constraints

- **Plain JavaScript only. Never TypeScript.** Not in any workspace, not for "just this file".
- **ES modules everywhere** (`import`/`export`). Never convert anything to CommonJS.
- **Raw parameterised SQL with `?` placeholders.** No ORM, no query builder. Never build SQL by string concatenation.
- Do not add dependencies unless explicitly asked. Ask first.
- `client/` is the React frontend, `server/` is the Express backend. They are not two apps for two user groups — field workers, supervisors and admins all use the same React bundle.

## The rule everything follows

The React UI never talks to the network directly. It reads and writes IndexedDB (Dexie). A separate sync layer moves data to the server later.

No code in `client/src` may assume the internet exists. If a feature breaks when the network drops, it is wrong.

## Who sees which records: area-based sharing

- **Field workers share records within their area** (a village or ward). A field worker pulls, sees, edits and deletes every record in their own area, plus any record with **no** area that they captured themselves.
- **Supervisors and admins see the whole organisation**, and may edit or delete any record in it.
- A record with a **NULL area** is visible only to its creator and to supervisors (records from before migration 004, or captured by a worker with no area).
- The rule lives in `server/sync/scopeRules.js` (the pull and resolutions SQL state the same predicate) and `client/src/records/scope.js` (what a device renders). Push authorisation is `mayWrite` = "may see".
- A record's area is **set by the server at first insert** from the capturing user's area in the database, and **never changed by a push**. Nothing the device sends is read to set it.
- The user's area is **read from the database on every sync request** (`loadArea`), never from the token, so reassigning a worker takes effect without a new sign-in. Role comes from the verified JWT.
- `records.updated_by` is the user whose change the server last accepted — the resolver, for a resolution. NULL means not recorded.

## Conventions

- API responses are **camelCase**. SQL columns are snake_case, so alias them: `full_name AS fullName`. Never `SELECT *` in a route.
- All client fetches go through `apiFetch` in `client/src/lib/api.js`, always with relative `/api/...` paths. An absolute URL bypasses the Vite dev proxy and production Nginx.
- Conventional commits: `feat:`, `fix:`, `chore:`, `docs:`.
- Comment the **why**, not the what.
- The developer runs **Windows PowerShell**, so commands must never use `<` input redirection; use `Get-Content file | mysql ...` instead.

## Offline-first invariants — do not break these

- **Primary keys are UUIDs generated client-side**, never AUTO_INCREMENT. A device offline cannot ask the server for an ID, and two devices picking "the next number" collide.
- **Syncable tables carry `version`, `updated_at`, `deleted_at`.** Deletes are soft — a hard DELETE is invisible to an offline device, so rows become tombstones instead.
- **`DATETIME(3)`, never plain `DATETIME`.** Second precision makes the sync window miss or duplicate rows edited in the same second.
- **Sync cursors use the server's timestamp, never the device clock.** A fast phone clock silently skips records forever.
- **Sync cursors are per user, never per device.** On a shared phone, one person's sync would otherwise move the cursor past what another person never pulled.
- **A cursor is stamped with the server's scope key and honoured only in that scope.** The device stores `{ until, scope }` and sends both; the server ignores `since` if the scope is no longer the user's (moved area, role change) and reads from the beginning. Never key the cursor on the device's own idea of its area — it is stale on exactly the sync that matters.
- **The push queue is selected by `lastEditedBy` (who made the unsent change), never `createdBy`.** Otherwise one worker's edit to another's record is never pushed, or is pushed under the wrong identity on a shared phone. The unsynced counts use the same rule.
- **A row holding another user's unsent change cannot be edited on that phone** until that user syncs; editing on top would send their work under your name.
- **Sync order is push, then pull.** Pulling first returns stale versions of rows the device is about to overwrite.
- **`authCache` holds exactly one row** — the person signed in on this device. Never cache another user's hash or tokens.
- The client decides what to *render*; the server decides what is *allowed*. Always re-check roles from the verified JWT, never from anything the client sends.

## Known gaps (do not "fix" silently — raise them first)

Auth
- No rate limit on `POST /api/auth/login`.
- Login is not constant-time: a missing user skips bcrypt and returns much faster than a wrong password, which leaks which phone numbers are registered.
- On a shared phone, a second worker cannot sync the first worker's unsent changes and can wipe them via Remove account; the screen warns but cannot prevent it. Those rows are also locked against the second worker's edits until the first worker syncs.
- Role is read from the JWT, so a supervisor demoted to field worker keeps organisation scope until their access token expires (up to 15 minutes). Area, by contrast, is read from the database on every request.

Areas
- Reassigning a worker does not remove the old area's records from their phone. The list hides them, but IndexedDB keeps them, so a lost phone still exposes the old area until the account is removed.
- A worker moved to another area has pending edits to old-area records refused as `forbidden` (and hidden from their list), and never receives resolutions for conflicts they raised there; such a row stays locked, hidden, on their phone. Captures made before the move but pushed after it are filed under the NEW area.
- There is no way to move a household between areas. Changing `records.area_id` by hand does not move `updated_at`, so devices in the new area never receive the record and devices in the old one keep their copy.
- Records created before migration 004 keep `area_id` and `updated_by` NULL (visible to their creator and supervisors only; last editor shown as "not recorded"). They are deliberately not backfilled.
- A field worker's pull uses `area_id = ? OR (area_id IS NULL AND created_by = ?)`, which MySQL answers with a filesort. Fine at village size; split into a `UNION ALL` if an area reaches tens of thousands of rows.
- `npm run demo:reset` hard-deletes records, conflicts and refresh tokens in **every** organisation in the database. Its only guard is refusing to run with `NODE_ENV=production`.

Sync
- Idempotency remembers one writer: `records.device_id` holds only the last accepted device, so a retry that outlives another device's edit is filed as a false conflict instead of a replay. Area sharing makes this likelier: several phones now write the same records.
- `PULL_COMMIT_LAG_MS` (1s) is a judgement, not a proof: a push or resolve transaction held open longer can commit below a cursor already handed out, and that row is never delivered.
- Tombstones are never pruned, on the server or on any device that pulled them.
- Supervisors and admins pull the whole organisation onto one device, so one lost supervisor phone exposes every household. A field worker's phone exposes their whole area, not only their own captures.
- The resolutions feed for supervisors and admins is narrower than their pull: only conflicts they raised or records they captured. A field worker's feed covers every record their pull covers.
- A sync during which the user's area or role changes stops with the cursor unmoved (`scopeChanged`); the next sync re-reads the new scope from the beginning.
- On a shared phone, a supervisor's organisation-wide pull moves a worker's rows forward, so that worker is not told about a resolution the supervisor's pull already applied.
- `records` keeps no history: an ordinary accepted push overwrites the previous payload with no copy kept; only resolutions preserve what they replace (`superseded_*`).

Conflicts
- A conflicted row cannot be edited or deleted on the device — allowing it re-queues the row against its stale base and restarts the conflict loop.
  Mitigation: resolving the conflict makes the row editable again so the worker can delete it; a resolution itself deletes only when the losing push was a deletion (`submitted_deleted`).
- A worker who dismisses a resolution notice loses the only view they have of the earlier version; it survives in `record_conflicts`, readable by supervisors, not by them.

## Working style

- Verify the previous step's files exist before building on them. Stop and report if something is missing.
- Show the diff. Do not commit unless asked.
- Say what you think is risky or wrong about a design instead of just building it.