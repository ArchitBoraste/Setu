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

## Offline-first invariants — do not break these

- **Primary keys are UUIDs generated client-side**, never AUTO_INCREMENT. A device offline cannot ask the server for an ID, and two devices picking "the next number" collide.
- **Syncable tables carry `version`, `updated_at`, `deleted_at`.** Deletes are soft — a hard DELETE is invisible to an offline device, so rows become tombstones instead.
- **`DATETIME(3)`, never plain `DATETIME`.** Second precision makes the sync window miss or duplicate rows edited in the same second.
- **Sync cursors use the server's timestamp, never the device clock.** A fast phone clock silently skips records forever.
- **Sync order is push, then pull.** Pulling first returns stale versions of rows the device is about to overwrite.
- **`authCache` holds exactly one row** — the person signed in on this device. Never cache another user's hash or tokens.
- The client decides what to *render*; the server decides what is *allowed*. Always re-check roles from the verified JWT, never from anything the client sends.

## Known gaps (do not "fix" silently — raise them first)

- Offline login leaves tokens null, so sync will fail until the worker signs in online again. Needs an explicit reconnect prompt.
- A different user logging in on a shared device replaces `authCache` but leaves the previous worker's unsynced records.
- No rate limit on `POST /api/auth/login`.
- Login is not constant-time: a missing user skips bcrypt and returns much faster than a wrong password, which leaks which phone numbers are registered.

## Working style

- Verify the previous step's files exist before building on them. Stop and report if something is missing.
- Show the diff. Do not commit unless asked.
- Say what you think is risky or wrong about a design instead of just building it.