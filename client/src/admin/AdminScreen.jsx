import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, NetworkError, NotAuthenticatedError } from "../lib/api.js";
import { normalisePhoneInput } from "../lib/phone.js";
import { shortTime } from "../lib/time.js";
import {
  createArea,
  createUser,
  listAreas,
  listUsers,
  renameArea,
  resetPassword,
  updateUser,
} from "./adminService.js";

// Temporary admin screen, matching the rest of the app: minimal inline styling,
// enough to manage users and areas without seed scripts. A teammate builds the
// real UI later.
//
// Drawn only for admins — a choice about what to RENDER. What keeps anyone else
// out is the server: every /api/admin route checks the role in the verified
// token and then asks the database whether the caller is still an active admin.

const styles = {
  section: { marginTop: "2rem", borderTop: "1px solid #ddd", paddingTop: "1rem" },
  muted: { color: "#666", fontSize: 14 },
  tabs: { display: "flex", gap: "0.5rem", margin: "0.5rem 0" },
  card: {
    border: "1px solid #ddd",
    borderRadius: 4,
    padding: "0.75rem",
    marginBottom: "0.75rem",
  },
  inactive: { opacity: 0.6 },
  form: {
    border: "1px solid #ddd",
    borderRadius: 4,
    padding: "0.75rem",
    margin: "0.5rem 0 1rem",
  },
  label: { display: "block", marginBottom: "0.5rem", fontSize: 14 },
  field: { display: "block", width: "100%", padding: "0.4rem", marginTop: 2, boxSizing: "border-box" },
  row: { display: "flex", gap: "0.5rem", flexWrap: "wrap", marginTop: "0.5rem" },
  notice: (tone) => ({
    padding: "0.5rem 0.75rem",
    borderRadius: 4,
    fontSize: 14,
    border: `1px solid ${tone === "warn" ? "#b45309" : "#15803d"}`,
    background: tone === "warn" ? "#fffbeb" : "#f0fdf4",
    color: "#111",
  }),
  confirm: {
    marginTop: "0.5rem",
    padding: "0.5rem 0.75rem",
    border: "1px solid #b91c1c",
    borderRadius: 4,
    background: "#fef2f2",
    color: "#111",
    fontSize: 14,
  },
};

const ROLE_LABELS = {
  field_worker: "Field worker",
  supervisor: "Supervisor",
  admin: "Admin",
};

const ROLES = Object.keys(ROLE_LABELS);

const OFFLINE_MESSAGE = "Admin needs an internet connection.";

// What the admin is told when a request fails. The server's own sentence when
// it gave one — those are written for this screen (server/admin/adminRules.js).
function describe(error) {
  if (error instanceof NetworkError) {
    // Not "nothing was changed": a request that timed out may have landed. The
    // honest answer is to look again once there is a connection.
    return `${OFFLINE_MESSAGE} Could not reach the server — reload once you are connected to see whether the change was saved.`;
  }
  if (error instanceof NotAuthenticatedError) {
    return "This device has no session with the server. Sign out and sign in again while you have a connection.";
  }
  if (error instanceof ApiError && error.status === 403) {
    return "Only an admin can do this. If your role was changed, sign out and sign in again.";
  }
  return error.message;
}

// Which form or card an action came from, so its outcome is drawn there.
const NEW_USER = "user:new";
const NEW_AREA = "area:new";
const userSource = (id) => `user:${id}`;
const areaSource = (id) => `area:${id}`;

/**
 * The outcome of a change, drawn beside the form or card that made it.
 *
 * It used to sit once at the top of the section. For a card further down the
 * list that was a screen or more above the button, so an admin pressed Save and
 * saw nothing happen — success or refusal alike.
 *
 * An error is role="alert", announced at once; a success is role="status",
 * announced politely. Scrolled to "nearest", which does nothing when the
 * message is already in view and otherwise brings it just inside the edge,
 * for the case where the card shrank (a form closing) as the message arrived.
 */
function Notice({ notice, source }) {
  const ref = useRef(null);
  const shown = notice?.source === source ? notice : null;

  useEffect(() => {
    if (shown) ref.current?.scrollIntoView({ block: "nearest" });
  }, [shown]);

  if (!shown) return null;
  return (
    <p
      ref={ref}
      role={shown.tone === "warn" ? "alert" : "status"}
      style={styles.notice(shown.tone)}
    >
      {shown.text}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

function AreaSelect({ areas, value, onChange, disabled }) {
  return (
    <select style={styles.field} value={value} onChange={onChange} disabled={disabled}>
      <option value="">Choose an area…</option>
      {areas.map((area) => (
        <option key={area.id} value={area.id}>
          {area.name}
        </option>
      ))}
    </select>
  );
}

const EMPTY_USER = { fullName: "", phone: "", role: "field_worker", areaId: "", password: "" };

function CreateUserForm({ areas, busy, notice, onCreate }) {
  const [form, setForm] = useState(EMPTY_USER);
  const set = (field) => (event) => setForm((f) => ({ ...f, [field]: event.target.value }));
  const isWorker = form.role === "field_worker";

  async function handleSubmit(event) {
    event.preventDefault();
    const created = await onCreate({
      fullName: form.fullName,
      // The same conversion the sign-in screen applies, so an admin typing on
      // a Marathi keyboard creates the account the worker will sign in to.
      phone: normalisePhoneInput(form.phone),
      role: form.role,
      // Only a field worker has an area; the server refuses one on anybody else.
      areaId: isWorker ? form.areaId || null : null,
      password: form.password,
    });
    if (created) setForm(EMPTY_USER);
  }

  return (
    <form style={styles.form} onSubmit={handleSubmit}>
      <strong>Add a user</strong>
      <label style={styles.label}>
        Full name
        <input style={styles.field} value={form.fullName} onChange={set("fullName")} required />
      </label>
      <label style={styles.label}>
        Phone (their sign-in)
        <input
          style={styles.field}
          type="tel"
          inputMode="numeric"
          value={form.phone}
          onChange={set("phone")}
          required
        />
      </label>
      <label style={styles.label}>
        Role
        <select style={styles.field} value={form.role} onChange={set("role")}>
          {ROLES.map((role) => (
            <option key={role} value={role}>
              {ROLE_LABELS[role]}
            </option>
          ))}
        </select>
      </label>
      {isWorker && (
        <label style={styles.label}>
          Area
          <AreaSelect areas={areas} value={form.areaId} onChange={set("areaId")} />
        </label>
      )}
      <label style={styles.label}>
        Initial password (at least 8 characters)
        <input
          style={styles.field}
          type="password"
          autoComplete="new-password"
          value={form.password}
          onChange={set("password")}
          required
        />
      </label>
      <button type="submit" disabled={busy}>
        {busy ? "Saving…" : "Add user"}
      </button>
      <Notice notice={notice} source={NEW_USER} />
    </form>
  );
}

/**
 * The fields that differ from what is stored — and only those.
 *
 * A role is always sent with its area, because the two are judged together
 * (a field worker needs one, nobody else may have one). A rename alone sends
 * neither, so a worker from before areas can still be renamed.
 */
function changedFields(user, form) {
  const changes = {};
  if (form.fullName !== user.fullName) changes.fullName = form.fullName;
  const areaId = form.role === "field_worker" ? form.areaId || null : null;
  if (form.role !== user.role) {
    changes.role = form.role;
    changes.areaId = areaId;
  } else if (areaId !== user.areaId) {
    changes.areaId = areaId;
  }
  return changes;
}

function EditUserForm({ user, areas, isSelf, busy, onSave, onCancel }) {
  const [form, setForm] = useState({
    fullName: user.fullName,
    role: user.role,
    areaId: user.areaId ?? "",
  });
  const set = (field) => (event) => setForm((f) => ({ ...f, [field]: event.target.value }));
  const isWorker = form.role === "field_worker";
  const movingArea = user.role === "field_worker" && isWorker && (form.areaId || null) !== user.areaId;

  return (
    <form
      style={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        onSave(changedFields(user, form));
      }}
    >
      <label style={styles.label}>
        Full name
        <input style={styles.field} value={form.fullName} onChange={set("fullName")} required />
      </label>
      <label style={styles.label}>
        Role
        {/* The server refuses an admin demoting themselves; disabling it here
            only saves them the round trip. */}
        <select style={styles.field} value={form.role} onChange={set("role")} disabled={isSelf}>
          {ROLES.map((role) => (
            <option key={role} value={role}>
              {ROLE_LABELS[role]}
            </option>
          ))}
        </select>
      </label>
      {isWorker && (
        <label style={styles.label}>
          Area
          <AreaSelect areas={areas} value={form.areaId} onChange={set("areaId")} />
        </label>
      )}
      {movingArea && user.areaId && (
        <p style={styles.notice("warn")}>
          {/* The procedure, not just the consequence, because nothing on the
              phone cleans up after a reassignment yet. See "Reassigning a worker
              to another area" in docs/design/household-move.md. */}
          Before saving, ask the worker to sync. After saving, they must use
          &apos;Remove account from device&apos; and sign in again online, otherwise
          old-area households stay on their phone and unsent edits to them get stuck.
        </p>
      )}
      <div style={styles.row}>
        <button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function ResetPasswordForm({ busy, onReset, onCancel }) {
  const [password, setPassword] = useState("");
  return (
    <form
      style={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        onReset(password);
      }}
    >
      <label style={styles.label}>
        New password (at least 8 characters)
        <input
          style={styles.field}
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </label>
      <p style={styles.muted}>
        Every session they have is signed out. A phone they already signed in on still opens
        offline with the old password until they next sign in online.
      </p>
      <div style={styles.row}>
        <button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Set password"}
        </button>
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function UserCard({ user, areas, isSelf, busy, notice, onUpdate, onResetPassword }) {
  // One panel open at a time: "edit", "password", "deactivate", or null.
  const [panel, setPanel] = useState(null);
  const close = () => setPanel(null);

  async function save(changes) {
    if (Object.keys(changes).length === 0) return close();
    if (await onUpdate(user, changes)) close();
  }

  return (
    <li style={{ ...styles.card, ...(user.isActive ? {} : styles.inactive) }}>
      <strong>{user.fullName}</strong>
      {isSelf && " (you)"}{" "}
      <span style={styles.muted}>
        {ROLE_LABELS[user.role] ?? user.role}
        {user.role === "field_worker" && ` · ${user.areaName ?? "no area"}`} · {user.phone}
      </span>
      <br />
      <span style={styles.muted}>
        {user.isActive ? "Active" : "Inactive"} · last sign-in{" "}
        {user.lastLoginAt ? shortTime(user.lastLoginAt) : "never"}
      </span>

      {panel === null && (
        <div style={styles.row}>
          <button onClick={() => setPanel("edit")} disabled={busy}>
            Edit
          </button>
          <button onClick={() => setPanel("password")} disabled={busy}>
            Reset password
          </button>
          {/* No deactivate on your own row: the server refuses it, and an admin
              who could press it would be one tap from locking themselves out. */}
          {!isSelf &&
            (user.isActive ? (
              <button onClick={() => setPanel("deactivate")} disabled={busy}>
                Deactivate
              </button>
            ) : (
              <button onClick={() => onUpdate(user, { isActive: true })} disabled={busy}>
                Activate
              </button>
            ))}
        </div>
      )}

      {panel === "edit" && (
        <EditUserForm
          user={user}
          areas={areas}
          isSelf={isSelf}
          busy={busy}
          onSave={save}
          onCancel={close}
        />
      )}

      {panel === "password" && (
        <ResetPasswordForm
          busy={busy}
          onCancel={close}
          onReset={async (password) => {
            if (await onResetPassword(user, password)) close();
          }}
        />
      )}

      {panel === "deactivate" && (
        // Inline rather than window.confirm(), for RemoveAccountPanel's reasons:
        // a browser dialog cannot say what will happen, and is dismissed by reflex.
        <div style={styles.confirm}>
          <p style={{ margin: 0 }}>
            Deactivate <strong>{user.fullName}</strong>? They are signed out of the server
            and cannot sign in online or sync. A phone they already use still opens offline
            for up to 7 days, but nothing captured on it will reach the server. Their records
            stay.
          </p>
          <div style={styles.row}>
            <button
              onClick={async () => {
                if (await onUpdate(user, { isActive: false })) close();
              }}
              disabled={busy}
            >
              {busy ? "Saving…" : "Deactivate"}
            </button>
            <button onClick={close} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <Notice notice={notice} source={userSource(user.id)} />
    </li>
  );
}

function UsersPanel({ users, areas, currentUserId, busy, notice, act }) {
  const onCreate = (user) =>
    act(
      NEW_USER,
      () => createUser(user),
      (created) => `Added ${created.fullName}. They can sign in now.`
    );

  const onUpdate = (user, changes) =>
    act(
      userSource(user.id),
      () => updateUser(user.id, changes),
      (result) => {
        if (changes.isActive === false) {
          return `${user.fullName} is deactivated. ${sessions(result.sessionsRevoked)} signed out.`;
        }
        if (changes.isActive === true) {
          return `${user.fullName} is active again. They sign in with their existing password.`;
        }
        return result.changed.length === 0
          ? "Nothing changed."
          : `Saved ${result.user.fullName}.`;
      }
    );

  const onResetPassword = (user, password) =>
    act(
      userSource(user.id),
      () => resetPassword(user.id, password),
      (result) =>
        result.self
          ? "Your password is changed and every session was signed out, this one included. Sign in again with the new password when asked."
          : `Password changed for ${user.fullName}. ${sessions(result.sessionsRevoked)} signed out.`
    );

  return (
    <>
      <CreateUserForm areas={areas} busy={busy} notice={notice} onCreate={onCreate} />
      {users.length === 0 ? (
        <p style={styles.muted}>No users yet.</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0 }}>
          {users.map((user) => (
            <UserCard
              key={user.id}
              user={user}
              areas={areas}
              isSelf={user.id === currentUserId}
              busy={busy}
              notice={notice}
              onUpdate={onUpdate}
              onResetPassword={onResetPassword}
            />
          ))}
        </ul>
      )}
    </>
  );
}

function sessions(count) {
  return count === 1 ? "1 session" : `${count} sessions`;
}

// ---------------------------------------------------------------------------
// Areas
// ---------------------------------------------------------------------------

function AreaCard({ area, busy, notice, onRename }) {
  const [name, setName] = useState(null); // null: not renaming

  return (
    <li style={styles.card}>
      {name === null ? (
        <>
          <strong>{area.name}</strong>{" "}
          <span style={styles.muted}>
            {area.userCount} active {area.userCount === 1 ? "user" : "users"} ·{" "}
            {area.recordCount} {area.recordCount === 1 ? "household" : "households"}
          </span>
          <div style={styles.row}>
            <button onClick={() => setName(area.name)} disabled={busy}>
              Rename
            </button>
          </div>
        </>
      ) : (
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            if (await onRename(area, name)) setName(null);
          }}
        >
          <label style={styles.label}>
            New name
            <input
              style={styles.field}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </label>
          <div style={styles.row}>
            <button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </button>
            <button type="button" onClick={() => setName(null)} disabled={busy}>
              Cancel
            </button>
          </div>
        </form>
      )}

      <Notice notice={notice} source={areaSource(area.id)} />
    </li>
  );
}

function AreasPanel({ areas, busy, notice, act }) {
  const [name, setName] = useState("");

  async function handleCreate(event) {
    event.preventDefault();
    const created = await act(
      NEW_AREA,
      () => createArea(name),
      (area) => `Added area ${area.name}.`
    );
    if (created) setName("");
  }

  const onRename = (area, newName) =>
    act(
      areaSource(area.id),
      () => renameArea(area.id, newName),
      (renamed) =>
        // Devices learn the new name from the scope their next sync reports.
        `Renamed to ${renamed.name}. Workers see the new name after their next sync.`
    );

  return (
    <>
      <form style={styles.form} onSubmit={handleCreate}>
        <label style={styles.label}>
          New area (village or ward)
          <input
            style={styles.field}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </label>
        <button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Add area"}
        </button>
        <Notice notice={notice} source={NEW_AREA} />
      </form>
      <p style={styles.muted}>
        Areas cannot be deleted: users and households stay filed under the area they were in.
      </p>
      {areas.length === 0 ? (
        <p style={styles.muted}>No areas yet.</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0 }}>
          {areas.map((area) => (
            <AreaCard
              key={area.id}
              area={area}
              busy={busy}
              notice={notice}
              onRename={onRename}
            />
          ))}
        </ul>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

/**
 * Mounted only while the browser reports a connection, so going offline throws
 * every list away with it and coming back starts from a fresh read. Nothing
 * stale is ever drawn under a form that would act on it.
 */
function AdminPanels({ currentUserId }) {
  const [tab, setTab] = useState("users");
  const [data, setData] = useState(null); // { users, areas } | null
  const [loadError, setLoadError] = useState(null);
  const [busy, setBusy] = useState(false);
  // The last change's outcome and where to draw it: { source, tone, text }.
  const [notice, setNotice] = useState(null);
  // Bumped by Refresh and after every change, so the lists always show what the
  // server holds rather than a local guess at the result.
  const [reloadToken, setReloadToken] = useState(0);
  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  // State is set only from the promise callbacks, never in the effect body.
  useEffect(() => {
    let cancelled = false;
    Promise.all([listUsers(), listAreas()])
      .then(([usersPage, areasPage]) => {
        if (cancelled) return;
        setData({ users: usersPage.users, areas: areasPage.areas });
        setLoadError(null);
      })
      .catch((error) => {
        if (cancelled) return;
        // Cleared, not kept: lists the server could not confirm are not
        // something to act on.
        setData(null);
        setLoadError(error);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  /**
   * Runs one change and reports it beside `source`, the form or card it came
   * from (see Notice). Resolves to true on success so a form can clear itself,
   * false on failure so it keeps what the admin typed.
   */
  async function act(source, request, successText) {
    setBusy(true);
    setNotice(null);
    try {
      const result = await request();
      setNotice({ source, tone: "ok", text: successText(result) });
      reload();
      return true;
    } catch (error) {
      setNotice({ source, tone: "warn", text: describe(error) });
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (loadError) {
    return (
      <>
        <p style={styles.notice("warn")}>
          {loadError instanceof NetworkError ? OFFLINE_MESSAGE : describe(loadError)}
        </p>
        <button onClick={reload}>Try again</button>
      </>
    );
  }

  if (!data) return <p style={styles.muted}>Loading…</p>;

  // A message belongs to the tab it was made on. Kept across a switch, it would
  // reappear beside a card the admin is no longer looking at.
  function switchTab(next) {
    setNotice(null);
    setTab(next);
  }

  return (
    <>
      <div style={styles.tabs}>
        <button onClick={() => switchTab("users")} disabled={tab === "users"}>
          Users ({data.users.length})
        </button>
        <button onClick={() => switchTab("areas")} disabled={tab === "areas"}>
          Areas ({data.areas.length})
        </button>
        <button onClick={reload} disabled={busy}>
          Refresh
        </button>
      </div>

      {tab === "users" ? (
        <UsersPanel
          users={data.users}
          areas={data.areas}
          currentUserId={currentUserId}
          busy={busy}
          notice={notice}
          act={act}
        />
      ) : (
        <AreasPanel areas={data.areas} busy={busy} notice={notice} act={act} />
      )}
    </>
  );
}

export default function AdminScreen({ currentUserId, online }) {
  return (
    <div style={styles.section}>
      <h2>Admin</h2>
      <p style={styles.muted}>
        {/* Said up front, as the conflict screen does: this is one of the two
            places in the app that do not work offline. */}
        Users and areas. Changes are made on the server straight away, so this needs a
        connection.
      </p>
      {/* navigator.onLine is trusted only in this direction. "Offline" means no
          network interface at all, so there is no point drawing forms. "Online"
          proves nothing, which is why AdminPanels also shows the offline message
          when a request cannot reach the server. */}
      {online ? (
        <AdminPanels currentUserId={currentUserId} />
      ) : (
        <p style={styles.notice("warn")}>{OFFLINE_MESSAGE}</p>
      )}
    </div>
  );
}
