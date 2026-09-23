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
- **Sync order is push, then pull.** Pulling first returns stale versions of rows the device is about to overwrite.
- **`authCache` holds exactly one row** — the person signed in on this device. Never cache another user's hash or tokens.
- The client decides what to *render*; the server decides what is *allowed*. Always re-check roles from the verified JWT, never from anything the client sends.

## Known gaps (do not "fix" silently — raise them first)

Auth
- No rate limit on `POST /api/auth/login`.
- Login is not constant-time: a missing user skips bcrypt and returns much faster than a wrong password, which leaks which phone numbers are registered.
- On a shared phone, a second worker cannot sync the first worker's unsent records and can wipe them via Remove account; the screen warns but cannot prevent it.

Sync
- Idempotency remembers one writer: `records.device_id` holds only the last accepted device, so a retry that outlives another device's edit is filed as a false conflict instead of a replay.
- `PULL_COMMIT_LAG_MS` (1s) is a judgement, not a proof: a push or resolve transaction held open longer can commit below a cursor already handed out, and that row is never delivered.
- Tombstones are never pruned, on the server or on any device that pulled them.
- Supervisors and admins pull the whole organisation onto one device, so one lost supervisor phone exposes every household.
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