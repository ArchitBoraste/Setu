# Setu

**Offline-First Field Data Collection Platform for Community Health and NGO Field Work**

Community health workers and NGO staff collect data in villages and remote areas where there is often no mobile network. Most apps stop working the moment the internet goes away, so workers go back to paper forms. Setu solves this by letting the worker do everything offline. The data is saved on the phone itself, and it gets uploaded to the server automatically once the phone gets a network again.

---

## The main idea

The React app **never talks to the network directly**.

It only reads and writes to a local database inside the browser (IndexedDB). A separate layer takes care of sending that data to the server later.

This is what makes the app "offline-first" and not just "works sometimes when offline". There is no code anywhere that assumes internet exists, so there is nothing to break when the signal drops.

```
React screens  ->  IndexedDB (on the phone)  ->  Service worker  ->  Express API  ->  MySQL
                   \_________ works with zero internet _________/     \___ needs internet ___/
```

---

## Project structure

This is a **monorepo** using npm workspaces. One repository, two folders, one `npm install` for both.

```
Setu/
├── client/            # React frontend (Vite) - runs in the browser
│   ├── src/
│   ├── vite.config.js # has the proxy that forwards /api to the server
│   └── package.json
├── server/            # Node.js + Express backend - runs on one machine
│   ├── db/
│   │   ├── index.js   # MySQL connection pool
│   │   └── schema.sql # database tables
│   ├── index.js       # express app + routes
│   ├── .env           # secrets (NOT pushed to git)
│   └── package.json
└── package.json       # declares the two workspaces
```

**Important:** `client` and `server` are **not** two different apps for two different people. They are just frontend and backend.

Field workers, supervisors and admins all open the **same** React app. They see different screens because their login token says what their role is. There is only one backend and everyone talks to it.

---

## Tech stack

| Part | What we used | Why |
|---|---|---|
| Frontend | React + Vite | Fast dev server with hot reload |
| Offline storage | IndexedDB (Dexie.js) | Real database inside the browser |
| Offline app shell | Service worker (Workbox) | Lets the app open with no internet |
| Backend | Node.js + Express | Plain JavaScript, ES modules |
| Database | MySQL 9.3 | Central store at headquarters |
| DB driver | mysql2 | Lets Node send SQL queries to MySQL |
| Config | dotenv | Loads secrets from `.env` |
| Auth | JWT + bcrypt | Token based login, hashed passwords |

We are writing **raw SQL**, not using an ORM. More work, but we understand and can explain every query.

---

## Work completed so far

### 1. Monorepo setup
- Created root `package.json` with `workspaces: ["client", "server"]`
- Vite React app in `client/`
- Express app in `server/` with `"type": "module"` so we can use `import` instead of `require`
- Added `.gitignore` for `node_modules` and `.env`

### 2. Connected the frontend to the backend

Vite runs the frontend on port **5173** and Express runs on port **5000**.

Even though both are on localhost, the browser treats them as **different origins**, because an origin means all three of these must match:

- protocol (http / https)
- domain (localhost, example.com)
- port (5173, 5000)

Since the ports are different, the browser blocks the request. This is CORS.

We solved it in two ways:

- **Vite proxy (main solution)** - the browser only ever talks to port 5173. Vite quietly forwards anything starting with `/api` to port 5000 in the background. Since the browser thinks everything is coming from one place, CORS never happens.
- **cors package (backup)** - for things that do not go through the Vite proxy, like Postman or testing from a phone on the same wifi.

Because of the proxy, all our fetch calls use **relative paths**:

```js
fetch("/api/health")            // correct - works in dev and after deployment
fetch("http://localhost:5000")  // wrong - would break the day we deploy
```

Tested it with a `/api/health` endpoint and the JSON showed up on the React page.

### 3. Database schema

Created `server/db/schema.sql` with three tables: `organizations`, `users`, `refresh_tokens`.

Three decisions here that are different from a normal CRUD project:

**a) IDs are UUIDs, not AUTO_INCREMENT**

A worker registers a household with no internet. Who gives it an ID? The server cannot, it has not even heard from the phone. If the phone just picks "the next number", then two workers offline in two different villages will both pick the same number and the data will clash on sync.

So the **phone generates a UUID** and that ID is final. Stored as `CHAR(36)`.

**b) Every table that syncs has `version`, `updated_at`, `deleted_at`**

- `version` - a number that goes up on every edit. This is how the server catches a conflict (phone edited version 3, but server already has version 5).
- `updated_at` - the last time **that row** changed on the server. This is what the sync uses to find new changes.
- `deleted_at` - soft delete. If we actually DELETE a row, an offline phone will never find out it is gone. So instead we stamp the delete time and the row becomes a **tombstone**. The phone downloads the tombstone and removes it from its own screen.

**c) `DATETIME(3)` instead of `DATETIME`**

`DATETIME(3)` keeps milliseconds. Normal `DATETIME` cuts off to whole seconds, and if two edits happen in the same second, our sync query will either miss one or send it twice.

**d) `users` table does not sync**

Accounts are created online only by an admin. The phone only caches the one row of the person logged into it. Never anyone else's.

### 4. MySQL connection

- Made `server/.env` with `PORT`, `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`
- Made `server/db/index.js` with a mysql2 connection pool
- Added a ping check at server startup, so if the database is unreachable we find out immediately at boot instead of on the first request
- **Tested and working** - server prints `MySQL connected` on start

---

## How the sync will work

This part is designed but not built yet.

**The phone always starts the conversation. The server never contacts the phone.**

A phone in a village has no address you can call and is switched off half the time, so the server has no way to reach it. Every device talks only to the central server, never to each other.

One sync = **push first, then pull**:

1. **Push** - send everything the worker created or edited while offline
2. **Pull** - ask the server for only what changed since last time, using `GET /api/sync/pull?since=<timestamp>`
3. Save the new timestamp for next time

Push has to happen **before** pull. If we pulled first, the worker's offline edits would still be sitting on the phone and the server would send back old versions of rows that are about to be overwritten anyway.

**Example:**

- Monday 5 PM - Rahul syncs at the office. Phone saves a bookmark: "I have everything up to Monday 5 PM"
- Tuesday - Rahul is in a village with no network. Other workers keep editing data at the office.
- Wednesday 9 AM - Rahul comes back and syncs. Instead of downloading all 10,000 records again, the phone says "send me only rows changed after Monday 5 PM". Server sends the 50 rows that changed. Bandwidth saved.

**Important detail:** that bookmark timestamp must come from the **server**, not from the phone's own clock. Cheap phones drift and users change their time zone. If the phone's clock is 4 minutes fast and it saves its own time, every row the server saved in those 4 minutes gets skipped **forever**, because the bookmark only moves forward. No error is shown anywhere. So the server sends back its own time in the pull response and the phone just stores it.

---

## How offline login will work

A worker cannot log in the first time without internet.

1. **First login (online)** - server checks the password against the `users` table with bcrypt. If correct, it creates a separate "offline hash" of the password and sends it to the phone along with the user's profile.
2. **Phone saves one row only** - name, role, and the offline hash. Not anyone else's data.
3. **Later, with no internet** - worker types the password, the phone checks it against the saved hash using `bcrypt.compare()`, and lets them in.

Note: bcrypt uses a **random salt** every time, so hashing the same password twice gives two different results. That is why we use `bcrypt.compare()` and not a normal string match. `compare()` reads the salt out of the stored hash first.

If somebody steals the phone, they only find a hash, not the password. A hash is one way, you cannot reverse it.

### What if someone edits their role in local storage?

Say a thief opens devtools and changes `role: "field_worker"` to `role: "admin"`.

The admin screens **will** appear. That part is real, because React decides what to draw based on local state.

But every button will fail. The JWT token was signed by our server and says `field_worker` inside it. Changing even one character breaks the signature, and you would need our `JWT_SECRET` to sign a new one. So the server checks the role from the **token**, not from whatever the client claims, and returns **403 Forbidden**.

Short version: **the client decides what to show, the server decides what is allowed.**

Because of this, admin work will be **online only**. This also keeps things simple, since admin actions like deactivating a user or editing a form should never need conflict resolution.

---

## Running the project locally

**You need:** Node.js 18+, MySQL 9.x

**1. Install everything (from the root folder):**

```bash
npm install
```

**2. Create the database:**

```sql
CREATE DATABASE setu CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
```

`utf8mb4` is needed because beneficiary names will be in Devanagari.

**3. Load the tables:**

```bash
mysql -u root -p setu < server/db/schema.sql
```

**4. Make your `server/.env` file** by copying `server/.env.example` and filling in your own MySQL password.

**5. Start both (two terminals):**

```bash
npm run dev -w server    # http://localhost:5000
npm run dev -w client    # http://localhost:5173
```

Open `http://localhost:5173`. If the setup is right, the page shows the JSON coming from the server and the server terminal prints `MySQL connected`.

---

## What is next

- [ ] Auth routes - register, login, refresh token
- [ ] JWT middleware and role checking
- [ ] Dexie setup on the client (local database)
- [ ] Service worker and PWA config
- [ ] Dynamic form builder
- [ ] Sync engine (push and pull endpoints)
- [ ] Conflict detection and supervisor review
- [ ] Docker and deployment

---

## Team

| Name | Role |
|---|---|
| Archit Boraste | Team Lead, Backend and Systems |
| Ajinkya Ghule | Frontend and UI |
| Atharva Dhamdhere | Research and Documentation |
| Abhinavparth Kumar | Testing and Results Analysis |

**College Guide:** Dr. Vijaykumar Bidve, Department of Computer Engineering, Vishwakarma Institute of Technology, Pune

**Sponsored by:** VS Software Lab
*(Sponsorship is limited to the problem statement and technical mentorship. It does not mean employment or funding.)*