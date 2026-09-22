import { useState } from "react";
import { countUnsyncedOnDevice } from "./recordService.js";

// The only destructive action in the app: it clears every local table, and the
// records in them are the only copy of work the server has not accepted.
//
// It used to sit next to Sign out behind a single window.confirm(). Two things
// made that dangerous rather than merely untidy. The capture screen now shows a
// count of unsynced records directly above these buttons, and the sync engine's
// offline-login prompt tells a worker to sign in again — so the moment a worker
// is most likely to reach for a button here is exactly the moment they have the
// most unsent work. A browser confirm is one reflex click, worded by the
// browser, with no room for a number.
//
// So: moved out of that row into its own section, and gated behind a second,
// explicit acknowledgement whenever there is anything to lose. The
// acknowledgement is a checkbox rather than a second OK on purpose — a second
// dialog is dismissed with the same reflex as the first, while a checkbox has to
// be aimed at, and it carries the count in its own label.

const styles = {
  zone: {
    marginTop: "2.5rem",
    borderTop: "1px solid #ddd",
    paddingTop: "1.25rem",
  },
  heading: { fontSize: 14, fontWeight: 600, color: "#7f1d1d", margin: "0 0 0.5rem" },
  panel: {
    border: "1px solid #b91c1c",
    borderRadius: 4,
    padding: "0.75rem 1rem",
    background: "#fef2f2",
    fontSize: 14,
  },
  list: { margin: "0.5rem 0", paddingLeft: "1.25rem" },
  strongLoss: { color: "#7f1d1d", fontWeight: 600 },
  acknowledge: {
    display: "block",
    margin: "0.75rem 0",
    padding: "0.5rem",
    background: "#fff",
    border: "1px solid #fca5a5",
    borderRadius: 4,
  },
  muted: { color: "#666", fontSize: 13 },
  error: { color: "crimson" },
};

function plural(count, singular, plural_) {
  return `${count} ${count === 1 ? singular : plural_}`;
}

/**
 * What is about to be destroyed, in numbers and in plain words.
 *
 * Deliberately concrete: "12 records" and "collected again" rather than "local
 * data". A worker cannot weigh a decision described in the vocabulary of the
 * thing doing the deleting.
 */
function LossWarning({ counts }) {
  if (counts.total === 0) {
    return (
      <p>
        Everything captured on this device has reached the server. Nothing will be
        lost.
      </p>
    );
  }

  return (
    <>
      <p>
        <span style={styles.strongLoss}>
          {plural(counts.total, "record has", "records have")} not reached the
          server.
        </span>{" "}
        Removing the account deletes {counts.total === 1 ? "it" : "them"}{" "}
        permanently. {counts.total === 1 ? "It" : "They"} cannot be recovered —
        not by signing in again, and not by a supervisor. Every household visit
        in that list would have to be collected again.
      </p>

      {counts.mine > 0 && counts.others > 0 && (
        <ul style={styles.list}>
          <li>{plural(counts.mine, "record", "records")} captured by you</li>
          <li>
            {plural(counts.others, "record", "records")} captured by{" "}
            {counts.otherWorkers === 1
              ? "another worker"
              : `${counts.otherWorkers} other workers`}{" "}
            who signed in on this phone before you
          </li>
        </ul>
      )}

      {counts.mine > 0 && (
        <p style={styles.muted}>
          To keep your own records: cancel, press <strong>Sync now</strong>, and
          wait until the waiting count reaches zero.
        </p>
      )}

      {counts.others > 0 && (
        <p style={styles.muted}>
          The {plural(counts.others, "record", "records")} captured by someone
          else <strong>cannot be synced by you</strong> — only by the worker who
          collected {counts.others === 1 ? "it" : "them"}, after they sign in on
          this phone. Removing the account now destroys{" "}
          {counts.others === 1 ? "it" : "them"} without that worker ever knowing.
        </p>
      )}
    </>
  );
}

export default function RemoveAccountPanel({ onRemove, busy }) {
  const [open, setOpen] = useState(false);
  const [counts, setCounts] = useState(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState(null);

  const atRisk = counts?.total ?? 0;
  // The gate only applies when there is something to lose. Making a worker tick a
  // box to confirm that nothing will be deleted trains them to tick it.
  const blocked = atRisk > 0 && !acknowledged;

  async function openPanel() {
    setError(null);
    setAcknowledged(false);
    try {
      // Counted at the moment of asking, never reused from an earlier render. A
      // sync may have emptied the queue since this screen loaded, and a warning
      // carrying a stale number is worse than no number at all.
      setCounts(await countUnsyncedOnDevice());
      setOpen(true);
    } catch (err) {
      setError(`Could not check for unsynced records: ${err.message}`);
    }
  }

  function close() {
    setOpen(false);
    setAcknowledged(false);
  }

  if (!open) {
    return (
      <div style={styles.zone}>
        <p style={styles.heading}>Danger zone</p>
        {error && <p style={styles.error}>{error}</p>}
        <button onClick={openPanel} disabled={busy}>
          Remove account from device
        </button>
        <p style={styles.muted}>
          Deletes this account and every record stored on this phone. Signing out
          does not — your records stay until they sync.
        </p>
      </div>
    );
  }

  return (
    <div style={styles.zone}>
      <p style={styles.heading}>Danger zone</p>
      <div style={styles.panel}>
        <p>
          <strong>Remove this account and all its data from the phone?</strong>
        </p>

        <LossWarning counts={counts} />

        {atRisk > 0 && (
          <label style={styles.acknowledge}>
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />{" "}
            I understand that {plural(atRisk, "record", "records")} will be
            permanently deleted.
          </label>
        )}

        <button onClick={onRemove} disabled={busy || blocked}>
          {atRisk > 0
            ? `Delete ${plural(atRisk, "record", "records")} and remove account`
            : "Remove account"}
        </button>{" "}
        <button onClick={close} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}
