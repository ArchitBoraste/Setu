import { useEffect, useState } from "react";
import {
  getCachedUser,
  login,
  logout,
  removeAccountFromDevice,
} from "./auth/authService.js";
import UpdatePrompt from "./components/UpdatePrompt.jsx";
import CaptureScreen from "./records/CaptureScreen.jsx";
import { DATABASE_OUTDATED_EVENT } from "./db/index.js";

// Temporary screen that proves the auth flow works. The real UI replaces it.

const styles = {
  page: { fontFamily: "system-ui", padding: "2rem", maxWidth: 420 },
  field: { display: "block", width: "100%", padding: "0.5rem", marginTop: 4 },
  label: { display: "block", marginBottom: "0.75rem" },
  error: { color: "crimson" },
  badge: (online) => ({
    display: "inline-block",
    padding: "0.15rem 0.6rem",
    borderRadius: 999,
    fontSize: 14,
    color: "#fff",
    background: online ? "seagreen" : "gray",
  }),
};

// Reflects the browser's "online"/"offline" events. This is only a display hint:
// the browser reports online whenever a network interface is up, even with no
// internet behind it, so authService never uses this to decide anything.
function useBrowserOnline() {
  const [online, setOnline] = useState(() => navigator.onLine);

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  return online;
}

function LoginForm({ onSubmit, busy }) {
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");

  async function handleSubmit(event) {
    event.preventDefault();
    await onSubmit(phone, password);
    setPassword("");
  }

  return (
    <form onSubmit={handleSubmit}>
      <label style={styles.label}>
        Phone
        <input
          style={styles.field}
          type="tel"
          autoComplete="username"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
        />
      </label>
      <label style={styles.label}>
        Password
        <input
          style={styles.field}
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      <button type="submit" disabled={busy}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

function SignedIn({ user, mode, onSignOut, onRemove, busy }) {
  return (
    <div>
      <p>
        Signed in as <strong>{user.fullName}</strong> ({user.role})
        <br />
        Phone {user.phone} · via {mode}
      </p>
      <button onClick={onSignOut} disabled={busy}>
        Sign out
      </button>{" "}
      <button onClick={onRemove} disabled={busy}>
        Remove account from device
      </button>

      <CaptureScreen />
    </div>
  );
}

// The database was closed so another tab running newer code could upgrade the
// schema (see db/index.js). Every query fails until this tab reloads, so say so
// instead of letting the screen fill with read errors.
function DatabaseOutdatedBanner() {
  const [outdated, setOutdated] = useState(false);

  useEffect(() => {
    const onOutdated = () => setOutdated(true);
    window.addEventListener(DATABASE_OUTDATED_EVENT, onOutdated);
    return () => window.removeEventListener(DATABASE_OUTDATED_EVENT, onOutdated);
  }, []);

  if (!outdated) return null;

  return (
    <p style={{ background: "#b45309", color: "#fff", padding: "0.5rem 0.75rem" }}>
      Setu was updated in another tab.{" "}
      <button onClick={() => window.location.reload()}>Reload</button>
    </p>
  );
}

export default function App() {
  const online = useBrowserOnline();
  const [restoring, setRestoring] = useState(true);
  const [session, setSession] = useState(null); // { user, mode } | null
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;

    getCachedUser()
      .then((user) => {
        if (!cancelled && user) setSession({ user, mode: "restored session" });
      })
      .catch((err) => {
        if (!cancelled) setError(`Could not read local session: ${err.message}`);
      })
      .finally(() => {
        if (!cancelled) setRestoring(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Runs an auth action with the busy flag set and the error shown on failure.
  async function run(action) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const handleLogin = (phone, password) =>
    run(async () => setSession(await login(phone, password)));

  const handleSignOut = () =>
    run(async () => {
      await logout();
      setSession(null);
    });

  const handleRemove = () => {
    if (!window.confirm("Remove this account and all its local data from the device?")) {
      return;
    }
    return run(async () => {
      await removeAccountFromDevice();
      setSession(null);
    });
  };

  return (
    <div style={styles.page}>
      <h1>Setu</h1>
      <p>
        <span style={styles.badge(online)}>{online ? "Online" : "Offline"}</span>
      </p>

      <DatabaseOutdatedBanner />

      {error && <p style={styles.error}>{error}</p>}

      {restoring ? (
        <p>Loading…</p>
      ) : session ? (
        <SignedIn
          user={session.user}
          mode={session.mode}
          onSignOut={handleSignOut}
          onRemove={handleRemove}
          busy={busy}
        />
      ) : (
        <LoginForm onSubmit={handleLogin} busy={busy} />
      )}

      <UpdatePrompt />
    </div>
  );
}
