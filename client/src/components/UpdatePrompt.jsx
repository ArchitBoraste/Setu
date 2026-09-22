import { Component, useEffect, useState } from "react";
import { useRegisterSW } from "virtual:pwa-register/react";

// Temporary banner. The real UI replaces it.

// Checked once at module load so the value cannot change between renders and
// alter the hook order below. Old Android WebViews and private windows in some
// browsers have no service worker at all; there the app simply runs without one
// and only loses offline caching. Everything else, including offline login from
// Dexie, still works.
const SERVICE_WORKER_SUPPORTED =
  typeof navigator !== "undefined" && "serviceWorker" in navigator;

// The browser only checks for a new service worker on navigation. A field worker
// may keep the installed app open for days, so we also check on this interval
// and whenever the device comes back online.
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const OFFLINE_READY_VISIBLE_MS = 4000;

const styles = {
  banner: {
    position: "fixed",
    left: "1rem",
    right: "1rem",
    bottom: "1rem",
    maxWidth: 420,
    margin: "0 auto",
    padding: "0.75rem 1rem",
    borderRadius: 8,
    fontFamily: "system-ui",
    fontSize: 15,
    color: "#fff",
    background: "#0f766e",
    display: "flex",
    gap: "0.5rem",
    alignItems: "center",
  },
  message: { flex: 1 },
};

function useUpdateChecks(registration) {
  useEffect(() => {
    if (!registration) return;

    const checkForUpdate = () => {
      // navigator.onLine === false is reliable (no interface at all), so skip the
      // pointless request. A true value can still fail on a dead uplink; that is
      // harmless, and the next check tries again.
      if (!navigator.onLine) return;
      registration
        .update()
        .catch((error) => console.warn("Service worker update check failed:", error));
    };

    const intervalId = setInterval(checkForUpdate, UPDATE_CHECK_INTERVAL_MS);
    window.addEventListener("online", checkForUpdate);
    return () => {
      clearInterval(intervalId);
      window.removeEventListener("online", checkForUpdate);
    };
  }, [registration]);
}

function ServiceWorkerPrompt() {
  const [registration, setRegistration] = useState(null);

  const {
    offlineReady: [offlineReady, setOfflineReady],
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_swUrl, reg) {
      if (reg) setRegistration(reg);
    },
    onRegisterError(error) {
      console.error("Service worker registration failed:", error);
    },
  });

  useUpdateChecks(registration);

  useEffect(() => {
    if (!offlineReady) return;
    const timeoutId = setTimeout(() => setOfflineReady(false), OFFLINE_READY_VISIBLE_MS);
    return () => clearTimeout(timeoutId);
  }, [offlineReady, setOfflineReady]);

  if (needRefresh) {
    return (
      <div style={styles.banner} role="alert">
        <span style={styles.message}>A new version is available. Reload?</span>
        {/* Activates the waiting worker, then reloads the page. Only ever on a click. */}
        <button onClick={() => updateServiceWorker(true)}>Reload</button>
        <button onClick={() => setNeedRefresh(false)}>Later</button>
      </div>
    );
  }

  if (offlineReady) {
    return (
      <div style={styles.banner} role="status">
        <span style={styles.message}>Ready to work offline</span>
      </div>
    );
  }

  return null;
}

// The update banner is a convenience; signing in is not. useRegisterSW runs
// during render, so without this boundary a throw anywhere in the update code
// would unmount the whole app and leave a field worker looking at a blank
// screen instead of the login form. Failing to null is always the right trade.
class UpdatePromptBoundary extends Component {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    console.error("Update prompt failed, continuing without it:", error);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export default function UpdatePrompt() {
  if (!SERVICE_WORKER_SUPPORTED) return null;

  return (
    <UpdatePromptBoundary>
      <ServiceWorkerPrompt />
    </UpdatePromptBoundary>
  );
}
