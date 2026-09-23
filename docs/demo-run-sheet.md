# Demo run sheet — offline edit, conflict, supervisor merge

The story: Worker A captures a household and syncs. Worker B, in the same
village, receives it. Both go offline and change it. A syncs first and is
accepted; B syncs and gets a conflict. The supervisor sees both versions side
by side and merges them field by field. After one more sync each, A and B hold
the same record, and B's row is unlocked.

**Cast**

| Role | Phone | Password | Area | Browser |
|---|---|---|---|---|
| Field Worker A | `8888888888` | `Worker@123` | Wadgaon | Chrome, your normal profile |
| Field Worker B | `7777777777` | `Worker@123` | Wadgaon | Chrome, a second profile |
| Supervisor | `6666666666` | `Supervisor@123` | none (sees the whole organisation) | Microsoft Edge |

---

## 0. Before the audience arrives (once)

Run these from the repo root, in PowerShell.

1. Make sure the MySQL service is running.
2. Migration 004 is **already applied** to the `setu` database on this laptop
   (it was applied on 23 Sep). Do not run it again — it would fail harmlessly
   at `CREATE TABLE areas`.
3. Reset the demo data:
   ```powershell
   npm run demo:reset -w server
   ```
   It should end with `Now reset every browser used in the demo`.
4. Build the client. The offline scenes need the production build, because
   only the build precaches the whole app:
   ```powershell
   npm run build -w client
   ```
5. Start the API **without** `--watch`, so a stray file change cannot restart
   it mid-demo (a restart makes the next request fail with 502):
   ```powershell
   npm start -w server
   ```
6. In a second terminal, start the production preview:
   ```powershell
   npm run preview -w client
   ```
   It serves **http://localhost:4173** and proxies `/api` to the server, the
   same way the dev server does.

### Three separate storages = three separate phones

Each phone is its own IndexedDB and its own device id. **Incognito windows share
one storage between them**, so do not use two incognito windows. Use:

- **Worker A:** Chrome, your normal profile.
- **Worker B:** Chrome, a second profile. Click the profile icon (top right) →
  **Add** → *Continue without an account* → name it "Worker B".
- **Supervisor:** Microsoft Edge.

In each one, open **http://localhost:4173**, wait for the words **"Ready to
work offline"** under the sign-in form (the service worker has cached the app),
then press **F5** once.

*Fallback if you are short a browser:* `http://localhost:4173` and
`http://[::1]:4173` are different origins, so they get separate storage even
in the same Chrome profile.

### How to go offline and back online

In the browser of the worker who goes offline: **F12** → **Network** tab → the
throttling drop-down that says **No throttling** → choose **Offline**. The badge
at the top of the app turns grey and says **Offline**. To come back, set it to
**No throttling** again.

> Coming back online **starts a sync by itself** (the app listens for the
> browser's "online" event). That is why A must reconnect first and finish, and
> only then B. Do not press **Sync now** while a browser is set to Offline.

---

## 1. Worker A captures a household (Chrome, profile 1)

1. Sign in: **Phone** `8888888888`, **Password** `Worker@123`, **Sign in**.
   The list heading reads **Records in Wadgaon (0)**.
2. Fill in the form:
   - **Household name:** `Patil Family`
   - **Members in household:** `5`
   - **Children under five:** `1`
   - **Visit date:** today
   - **Main water source:** `Well`
   - **Notes:** `First visit`
3. Click **Save record**. The row appears with an orange **pending** badge and
   "1 waiting to sync".
4. Click **Sync now**. Expect **"1 sent"**. The row turns green **synced**,
   **v1**, *Created by Field Worker A · last change by Field Worker A*.

## 2. Worker B receives it (Chrome, profile 2)

1. Sign in: `7777777777` / `Worker@123`. Heading: **Records in Wadgaon (0)**.
2. Click **Sync now**. Expect **"1 received"**. A's *Patil Family* row appears,
   *Created by Field Worker A*.

   Talking point: B never captured this household. B sees it because both
   workers cover Wadgaon, and the server sends a worker every record in their
   area.

## 3. Both go offline and change the same record

1. **A:** F12 → Network → **Offline**. Then **Edit** on *Patil Family* → change
   **Members in household** from `5` to `6` → **Save changes**. The row shows
   **pending**, **6 members**.
2. **B:** F12 → Network → **Offline**. Then **Edit** on *Patil Family* → change
   **Members in household** from `5` to `7` **and** **Main water source** from
   `Well` to `Handpump` → **Save changes**. The row shows *Created by Field
   Worker A · last change by Field Worker B (not yet on the server)*.

   The same field (Members) is a real clash. Water source changed on B's side
   only, so the supervisor's field-by-field merge has something to choose.

## 4. A comes back online first

1. **A:** Network → **No throttling**. The sync starts by itself.
2. **Wait** until A shows **"1 sent"** and the row is **synced**, **v2**, **6
   members**. Only then go on.

## 5. B comes back online and gets a conflict

1. **B:** Network → **No throttling**. The sync starts by itself.
2. Expect **"0 sent · 1 in conflict · 1 needs review"**. The row turns red **conflict**, with
   *"Someone else changed this record on the server before your copy
   arrived"*. **Edit** and **Delete** are greyed out: *locked until this is
   resolved*.
3. Click **Compare both versions**: *On this device* (7, Handpump) against
   *On the server (v2, Field Worker A)* (6, Well).

## 6. The supervisor resolves it (Edge)

1. Sign in: `6666666666` / `Supervisor@123`. Scroll to **Conflicts**. If the
   card is not there yet, click **Refresh**.
2. The card is titled **Patil Family**, *Wadgaon · record … · household_survey*.
   Show the side-by-side table: *On the server (v2)* and *The worker's copy*,
   with *Last change by: Field Worker A* against *Field Worker B*. Members and
   Water source are tinted as the fields that differ.
3. Click **Merge field by field**.
   - **Members:** leave the server's **6** selected (it has the outline).
   - **Water source:** click the worker's **Handpump**.
4. Click **Save merged version**. The preview says **"1 field will be
   replaced"**: Water source, Well → Handpump.
5. Click **Replace 1 field**. Expect *"Saved. The record is now version 3…"*,
   and the Open tab reads *Nothing waiting to be decided*. The **Resolved** tab
   still shows the decision, along with the version it replaced.

## 7. Both workers sync once more

Wait two or three seconds after the resolution first. A sync reads up to one
second behind the server's clock, so a sync pressed immediately can say "Up to
date". If it does, press **Sync now** again.

1. **A:** **Sync now** → **"1 updated · 1 changed by a supervisor"**. The row
   is **v3**, **6 members**, *last change by Supervisor*. A blue notice says
   *"A supervisor combined both versions of this record, field by field"*, and
   its Before (v2) / Now (v3) table shows Water source going Well → Handpump.
2. **B:** **Sync now** → **"1 conflict resolved"**. The row is back to
   **synced**, **v3**, **6 members**, Handpump. **Edit** and **Delete** work
   again. The notice shows *Your copy (v2)* — B's 7 — beside the result, so
   nothing B typed silently disappears.
3. Optional, **Supervisor:** **Sync now** → the record appears under
   **Records in your organisation**, *last change by Supervisor*.

## 8. Optional: offline refresh

In any worker's browser: Network → **Offline**, then press **F5**. The app
still loads (from the service worker), still signed in, with the records list
read from the phone's own database.

---

## Reset between rehearsals

**Server** (repo root, PowerShell):
```powershell
npm run demo:reset -w server
```
This deletes every record, conflict and refresh token, then re-runs the seed.
The seed is idempotent: users, the area and the organisation are never
duplicated.

**All three browsers** — every time you reset the server. They still hold
copies of the records that were just deleted, and sessions the server no longer
knows:

1. On http://localhost:4173, press **F12** → **Application** tab → **Storage**
   (left-hand list) → **Clear site data**.
2. In the **Network** tab, make sure throttling is back on **No throttling**.
3. Close DevTools, press **F5**, and wait for **"Ready to work offline"**.

(**Remove account from device** at the bottom of the app also wipes the local
database, but Clear site data resets the service worker too, and that matters
after a rebuild.)

## If something goes wrong

| Symptom | Cause, and the fix |
|---|---|
| Sign-in says *"You're offline…"* while online | The API is not reachable. Check the `npm start -w server` terminal. |
| A sync says *Up to date* right after the resolution | The one-second window edge. Press **Sync now** again. |
| B syncs and gets **"1 sent"**, not a conflict | B reconnected before A had synced (or A never edited). Reset and run again. |
| A row says *locked: … changed this on this phone* | Another worker's unsent change on the same browser. That worker has to sign in there and sync. |
| *"Sign in to sync"* | This browser signed in offline, or the server was reset. Sign out and sign in again while online. |
