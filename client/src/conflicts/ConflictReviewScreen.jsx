import { Fragment, useCallback, useEffect, useState } from "react";
import { NetworkError, NotAuthenticatedError } from "../lib/api.js";
import { differingFields, unionFields } from "../lib/payload.js";
import { shortTime } from "../lib/time.js";
import { FIELD_LABELS, showValue } from "../records/formFields.js";
import CompareGrid from "../components/CompareGrid.jsx";
import { listConflicts, resolveConflict } from "./conflictService.js";

// Temporary review screen, matching the rest of the app: hardcoded form,
// minimal inline styling, enough to prove the decision path works end to end. A
// teammate builds the real UI later.
//
// Rendered only for supervisors and admins — but that is a choice about what to
// DRAW. What keeps a field worker out is requireRole on every route this calls,
// read from the verified JWT. A bundle is not a permission.

const styles = {
  section: { marginTop: "2rem", borderTop: "1px solid #ddd", paddingTop: "1rem" },
  muted: { color: "#666", fontSize: 14 },
  error: { color: "crimson" },
  tabs: { display: "flex", gap: "0.5rem", margin: "0.5rem 0" },
  card: {
    border: "1px solid #ddd",
    borderRadius: 4,
    padding: "0.75rem",
    marginBottom: "0.75rem",
  },
  compare: {
    display: "grid",
    gridTemplateColumns: "10rem 1fr 1fr",
    gap: "0.25rem 0.75rem",
    fontSize: 13,
    marginTop: "0.5rem",
    padding: "0.5rem",
    background: "#fafafa",
    border: "1px solid #eee",
  },
  mergeGrid: {
    display: "grid",
    gridTemplateColumns: "10rem 1fr 1fr",
    gap: "0.35rem 0.75rem",
    fontSize: 13,
    marginTop: "0.5rem",
    padding: "0.5rem",
    background: "#fffbeb",
    border: "1px solid #b45309",
  },
  head: { fontWeight: 600 },
  differs: { background: "#fff1f2" },
  notice: (tone) => ({
    padding: "0.5rem 0.75rem",
    borderRadius: 4,
    fontSize: 14,
    border: `1px solid ${tone === "warn" ? "#b45309" : "#ccc"}`,
    background: tone === "warn" ? "#fffbeb" : "#f6f6f6",
  }),
  chosen: { outline: "2px solid #b45309" },
  // Explicit colours, not the browser's button defaults. Under a dark colour
  // scheme the default button text is light, and on the light tint marking a
  // differing field the value became invisible — a supervisor choosing between
  // two answers could not read either of them.
  pick: { background: "#fff", color: "#111", border: "1px solid #ccc" },
  confirm: {
    marginTop: "0.75rem",
    padding: "0.75rem 1rem",
    border: "1px solid #b91c1c",
    borderRadius: 4,
    background: "#fef2f2",
    fontSize: 14,
  },
  danger: { color: "#7f1d1d" },
};

// UUIDs are unreadable at full length and a supervisor only ever needs to tell
// two of them apart, never to retype one.
const short = (id) => (typeof id === "string" ? id.slice(0, 8) : "—");

function deviceLabel(side) {
  // A version written by a conflict resolution carries the reserved nil device
  // id. Printing it at a supervisor as though a phone called itself that would
  // be worse than useless — it is the audit trail of their own earlier decision.
  if (side.writtenByResolution) return "resolved on the server";
  return `device ${short(side.deviceId)}`;
}

/**
 * The two versions, side by side, with the fields that actually differ tinted.
 *
 * The tinting is the whole point of the screen. A household survey is twenty
 * fields and two devices usually disagree about one or two of them; without the
 * marking a supervisor is diffing twenty identical rows by eye, which is how a
 * wrong version gets kept.
 */
function VersionCompare({ conflict }) {
  const { current, submitted } = conflict;
  const fields = unionFields(current.payload, submitted.payload);
  const differs = differingFields(current.payload, submitted.payload);

  return (
    <div style={styles.compare}>
      <span style={styles.head} />
      <span style={styles.head}>On the server (v{current.version})</span>
      <span style={styles.head}>The worker&apos;s copy</span>

      <span style={styles.muted}>Captured by</span>
      <span>
        {current.capturedByName} · {deviceLabel(current)}
      </span>
      <span>
        {submitted.byName} · {deviceLabel(submitted)}
      </span>

      <span style={styles.muted}>When</span>
      <span>{shortTime(current.updatedAt) ?? "—"}</span>
      {/* "Received", not "captured": record_conflicts stores when the push was
          refused, not when the worker sat with the family. Labelling it as a
          capture time would be a claim this screen cannot support. */}
      <span>{shortTime(submitted.receivedAt) ?? "—"} (received)</span>

      <span style={styles.muted}>Version</span>
      <span>v{current.version}</span>
      <span>
        edited from v{submitted.baseVersion}, collided with v
        {submitted.collidedWithVersion}
      </span>

      {fields.map((field) => {
        const tint = differs.has(field) ? styles.differs : undefined;
        return (
          <Fragment key={field}>
            <span style={styles.muted}>{FIELD_LABELS[field] ?? field}</span>
            <span style={tint}>{showValue(current.payload?.[field] ?? null)}</span>
            <span style={tint}>{showValue(submitted.payload?.[field] ?? null)}</span>
          </Fragment>
        );
      })}

      {(current.deletedAt || submitted.deleted) && (
        <Fragment>
          {/* Either side being a deletion is a different decision from a
              disagreement about answers, and it is the one a supervisor can
              least afford to miss in a column of field values. */}
          <span style={styles.muted}>Deleted</span>
          <span style={styles.differs}>
            {current.deletedAt ? `yes, ${shortTime(current.deletedAt)}` : "no"}
          </span>
          <span style={styles.differs}>
            {submitted.deleted ? "yes — this copy deletes the record" : "no"}
          </span>
        </Fragment>
      )}
    </div>
  );
}

/**
 * What a kept_client or merged resolution will overwrite — shown BEFORE it does.
 *
 * Both overwrite the record's current answers, and until migration 002 those
 * answers were then gone from everywhere. They are kept now, but "recoverable
 * from an audit table" is not the same as "the supervisor saw it coming", and a
 * mis-click between two adjacent buttons should cost a second look, not a trip
 * to the database. So the supervisor is shown exactly what is about to be
 * replaced: how many fields, which, and the values that will leave the record.
 *
 * kept_server needs none of this. It writes nothing, so it replaces nothing.
 *
 * Inline rather than window.confirm(), for the reasons RemoveAccountPanel gives:
 * a browser dialog cannot show a table of values, and is dismissed by reflex.
 */
function ReplacementPreview({ conflict, resolution, result, busy, onConfirm, onBack }) {
  const { current, submitted } = conflict;
  const replaced = [...differingFields(current.payload, result)];
  const only = (payload) =>
    Object.fromEntries(replaced.map((field) => [field, payload?.[field] ?? null]));

  // Mirrors conflictRules.js exactly. kept_client deletes only on a recorded
  // deletion; nothing un-deletes; merges never change existence.
  const deletes = resolution === "kept_client" && submitted.deleted && !current.deletedAt;
  const staysDeleted = Boolean(current.deletedAt);

  const count = replaced.length;
  const fieldsPhrase = `${count} ${count === 1 ? "field" : "fields"}`;

  return (
    <div style={styles.confirm}>
      <p style={{ margin: 0 }}>
        <strong>
          {resolution === "kept_client"
            ? "Keep the worker's version?"
            : "Save this merged version?"}
        </strong>
      </p>

      {count === 0 ? (
        <p>No answer on the record changes.</p>
      ) : (
        <>
          <p>
            <strong>{fieldsPhrase}</strong> will be replaced. The values in the
            left column will be removed from the record:
          </p>
          <CompareGrid
            leftLabel={`Removed (now in v${current.version})`}
            rightLabel="Replaced with"
            left={only(current.payload)}
            right={only(result)}
          />
        </>
      )}

      {deletes && (
        <p style={styles.danger}>
          This also <strong>deletes the record</strong>: the worker&apos;s copy was a
          deletion, and keeping it removes the household from the register.
        </p>
      )}

      {staysDeleted && (
        <p style={styles.muted}>
          This record is already deleted on the server and stays deleted —
          resolving a conflict never restores a record. Restore it separately if
          that is what you mean.
        </p>
      )}

      <p style={styles.muted}>
        The replaced version is kept with this conflict and stays readable in the
        Resolved tab.
      </p>

      <p style={{ marginBottom: 0 }}>
        <button onClick={onConfirm} disabled={busy}>
          {deletes
            ? "Keep the worker's version and delete the record"
            : count === 0
              ? "Confirm"
              : `Replace ${fieldsPhrase}`}
        </button>{" "}
        <button onClick={onBack} disabled={busy}>
          Go back
        </button>
      </p>
    </div>
  );
}

/**
 * On a resolved conflict: what the decision replaced.
 *
 * Without this the Resolved tab shows the losing copy beside the record as it
 * stands NOW — which, after a kept_client, are the same thing, and the version
 * that was actually overwritten is nowhere on screen. An audit view that hides
 * the one thing a decision destroyed is worse than none.
 */
function ReplacedByDecision({ conflict }) {
  if (conflict.resolution === "kept_server") return null;

  if (!conflict.superseded) {
    // Resolved before migration 002. Said plainly rather than rendered as an
    // empty comparison, which would read as "nothing was replaced".
    return (
      <p style={styles.muted}>
        The version this decision replaced was not kept — it was resolved before
        replaced versions were recorded, and that content cannot be recovered.
      </p>
    );
  }

  return (
    <>
      <p style={styles.muted}>This decision replaced version v{conflict.superseded.version}:</p>
      <CompareGrid
        leftLabel={`Replaced (v${conflict.superseded.version})`}
        rightLabel={`Now (v${conflict.current.version})`}
        left={conflict.superseded.payload}
        right={conflict.current.payload}
      />
    </>
  );
}

/**
 * Field by field: pick a side for each, and the result becomes the new version.
 *
 * Every field starts on the server's value, so a supervisor who only wants one
 * answer from the worker's copy changes one thing. Undeclared fields the worker
 * sent — from a build newer than this form revision — are offered like any
 * other, because they are real answers from a real household and the server
 * stores them.
 */
function MergeEditor({ conflict, onCancel, onSubmit, busy, locked }) {
  // `locked` while the replacement preview is open. The preview describes the
  // picks as they were when Save was pressed; letting them change underneath it
  // would have the supervisor confirm one merge and send another.
  const frozen = busy || locked;
  const { current, submitted } = conflict;
  const fields = unionFields(current.payload, submitted.payload);
  const differs = differingFields(current.payload, submitted.payload);

  const [picks, setPicks] = useState(() =>
    Object.fromEntries(fields.map((field) => [field, "server"]))
  );

  const build = () =>
    Object.fromEntries(
      fields.map((field) => [
        field,
        (picks[field] === "worker" ? submitted.payload?.[field] : current.payload?.[field]) ??
          null,
      ])
    );

  return (
    <div>
      <p style={styles.muted}>
        Choose a side for each field. Fields the two versions disagree about are
        tinted; the rest are identical either way.
      </p>

      <div style={styles.mergeGrid}>
        <span style={styles.head} />
        <span style={styles.head}>Server (v{current.version})</span>
        <span style={styles.head}>Worker</span>

        {fields.map((field) => {
          const tint = differs.has(field) ? styles.differs : undefined;
          const pick = picks[field];
          return (
            <Fragment key={field}>
              <span style={styles.muted}>{FIELD_LABELS[field] ?? field}</span>
              <button
                type="button"
                style={{ ...styles.pick, ...tint, ...(pick === "server" ? styles.chosen : {}) }}
                onClick={() => setPicks((p) => ({ ...p, [field]: "server" }))}
                disabled={frozen}
              >
                {showValue(current.payload?.[field] ?? null)}
              </button>
              <button
                type="button"
                style={{ ...styles.pick, ...tint, ...(pick === "worker" ? styles.chosen : {}) }}
                onClick={() => setPicks((p) => ({ ...p, [field]: "worker" }))}
                disabled={frozen}
              >
                {showValue(submitted.payload?.[field] ?? null)}
              </button>
            </Fragment>
          );
        })}
      </div>

      {!locked && (
        <p>
          <button onClick={() => onSubmit(build())} disabled={busy}>
            Save merged version
          </button>{" "}
          <button onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </p>
      )}
    </div>
  );
}

function ConflictCard({ conflict, onResolve, busy, merging, onMerge, onCancelMerge }) {
  const open = conflict.status === "open";
  // A resolution that overwrites the record, waiting on the supervisor to see
  // what it replaces: { resolution, payload }. kept_server never lands here.
  const [pending, setPending] = useState(null);

  const confirmPending = () =>
    onResolve(conflict, pending.resolution, pending.payload);

  return (
    <li style={styles.card}>
      <strong>{conflict.current.payload?.householdName || "(no name)"}</strong>{" "}
      <span style={styles.muted}>
        record {short(conflict.recordId)} · {conflict.submitted.formType} · raised{" "}
        {shortTime(conflict.createdAt)}
      </span>

      {!open && (
        <p style={styles.muted}>
          {/* Resolved conflicts stay listed rather than disappearing. The losing
              payload is the audit trail for a decision taken about someone's
              data, and a decision nobody can look at afterwards is not much of a
              record. */}
          Resolved as <strong>{conflict.resolution}</strong> by{" "}
          {conflict.resolvedBy?.name ?? "a supervisor"} at{" "}
          {shortTime(conflict.resolvedAt)} (server time). Both versions are kept
          below.
        </p>
      )}

      <VersionCompare conflict={conflict} />

      {!open && <ReplacedByDecision conflict={conflict} />}

      {open && !merging && !pending && (
        <p>
          {/* Straight through: kept_server writes nothing, so there is nothing
              to preview and nothing it could replace. */}
          <button onClick={() => onResolve(conflict, "kept_server")} disabled={busy}>
            Keep the server&apos;s version
          </button>{" "}
          <button
            onClick={() => setPending({ resolution: "kept_client", payload: undefined })}
            disabled={busy}
          >
            Keep the worker&apos;s version
          </button>{" "}
          <button onClick={() => onMerge(conflict)} disabled={busy}>
            Merge field by field
          </button>
        </p>
      )}

      {open && merging && (
        <MergeEditor
          conflict={conflict}
          busy={busy}
          locked={pending !== null}
          onCancel={onCancelMerge}
          onSubmit={(payload) => setPending({ resolution: "merged", payload })}
        />
      )}

      {open && pending && (
        <ReplacementPreview
          conflict={conflict}
          resolution={pending.resolution}
          // What the record's answers will be afterwards: the worker's copy
          // whole, or the supervisor's assembled merge.
          result={pending.payload ?? conflict.submitted.payload}
          busy={busy}
          onConfirm={confirmPending}
          onBack={() => setPending(null)}
        />
      )}
    </li>
  );
}

export default function ConflictReviewScreen() {
  const [status, setStatus] = useState("open");
  const [conflicts, setConflicts] = useState([]);
  const [page, setPage] = useState({ hasMore: false, nextCursor: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [mergingId, setMergingId] = useState(null);
  const [result, setResult] = useState(null);
  // Bumped by anything that wants the queue re-read: the Refresh button, and
  // every resolution, because resolving moves a row from one tab to the other.
  const [reloadToken, setReloadToken] = useState(0);

  const applyPage = useCallback((data, append) => {
    setConflicts((rows) => (append ? [...rows, ...data.conflicts] : data.conflicts));
    setPage({ hasMore: data.hasMore, nextCursor: data.nextCursor });
    setError(null);
    setLoading(false);
  }, []);

  const applyError = useCallback((err, append) => {
    // Nothing stale is left on screen behind the message. A supervisor acting on
    // a cached queue would be deciding against a version of the world that has
    // moved, and this is the one screen where a stale read turns into a write
    // about somebody's data.
    if (!append) setConflicts([]);
    setError(describe(err));
    setLoading(false);
  }, []);

  // No setState in the effect body — state is set from the promise callbacks, so
  // a tab switch does not cascade renders. The `loading` flag is raised by the
  // handler that triggers the read, which is an event and may set state freely.
  useEffect(() => {
    let cancelled = false;
    listConflicts({ status })
      .then((data) => {
        if (!cancelled) applyPage(data, false);
      })
      .catch((err) => {
        if (!cancelled) applyError(err, false);
      });
    return () => {
      cancelled = true;
    };
  }, [status, reloadToken, applyPage, applyError]);

  function reload(nextStatus = status) {
    setLoading(true);
    setResult(null);
    setMergingId(null);
    if (nextStatus !== status) setStatus(nextStatus);
    else setReloadToken((token) => token + 1);
  }

  async function loadMore() {
    setLoading(true);
    try {
      applyPage(await listConflicts({ status, after: page.nextCursor }), true);
    } catch (err) {
      applyError(err, true);
    }
  }

  async function handleResolve(conflict, resolution, payload) {
    setBusyId(conflict.id);
    setError(null);
    setResult(null);
    try {
      const answer = await resolveConflict(conflict.id, resolution, payload);
      setMergingId(null);
      setResult(
        answer.recordDeleted
          ? `Saved. The record is deleted (version ${answer.version}), and the version it replaced is kept with the conflict.`
          : answer.recordChanged
            ? `Saved. The record is now version ${answer.version} and will reach every device on their next sync. The version it replaced is kept with the conflict.`
            : "Saved. The record was already right, so nothing was rewritten."
      );
      setReloadToken((token) => token + 1);
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div style={styles.section}>
      <h2>Conflicts</h2>
      <p style={styles.muted}>
        {/* Said plainly and up front, because it is the one place in the app
            where this is true, and a supervisor who discovers it by pressing a
            button in a village with no signal has been misled by the rest. */}
        Two devices changed the same record. Both versions are kept until someone
        decides. This screen needs a connection — deciding is a server-side write
        and cannot be queued offline.
      </p>

      <div style={styles.tabs}>
        <button onClick={() => reload("open")} disabled={status === "open"}>
          Open
        </button>
        <button onClick={() => reload("resolved")} disabled={status === "resolved"}>
          Resolved
        </button>
        <button onClick={() => reload()} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {error && <p style={styles.notice("warn")}>{error}</p>}
      {result && <p style={styles.notice()}>{result}</p>}

      {loading && conflicts.length === 0 ? (
        <p style={styles.muted}>Loading…</p>
      ) : conflicts.length === 0 ? (
        <p style={styles.muted}>
          {status === "open" ? "Nothing waiting to be decided." : "Nothing resolved yet."}
        </p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0 }}>
          {conflicts.map((conflict) => (
            <ConflictCard
              key={conflict.id}
              conflict={conflict}
              busy={busyId === conflict.id}
              merging={mergingId === conflict.id}
              onMerge={(c) => setMergingId(c.id)}
              onCancelMerge={() => setMergingId(null)}
              onResolve={handleResolve}
            />
          ))}
        </ul>
      )}

      {page.hasMore && (
        <button onClick={loadMore} disabled={loading}>
          Load more
        </button>
      )}
    </div>
  );
}

function describe(error) {
  if (error instanceof NotAuthenticatedError) {
    return "This device has no session with the server. Sign in again while you have a connection.";
  }
  if (error instanceof NetworkError) {
    return "Could not reach the server. Conflicts can only be resolved online — nothing has been lost, and both versions are still kept.";
  }
  // Covers the 409 a second resolution gets: the conflict is already decided,
  // and the refresh below will show it in the resolved tab.
  return error.message;
}
