import { Fragment, useCallback, useEffect, useState } from "react";
import {
  SYNC_STATE,
  countPendingRecords,
  countUnsyncedOnDevice,
  createRecord,
  dismissResolutionNotice,
  listRecords,
  softDeleteRecord,
  updateRecord,
} from "./recordService.js";
import {
  SYNC_EVENT,
  getLastSyncAt,
  runSync,
  startSyncOnReconnect,
} from "../sync/syncEngine.js";
import { differingFields, unionFields } from "../lib/payload.js";
import { shortTime } from "../lib/time.js";
import { FIELD_LABELS, showValue } from "./formFields.js";

// Temporary capture screen. The form is hardcoded so there is real data to sync
// in the next step; the dynamic form builder replaces it later.

export const FORM_TYPE = "household_survey";

// Bump when a field is added, removed or changes meaning, so rows captured by
// an older revision stay interpretable.
export const FORM_VERSION = 1;

const NUMBER_FIELDS = ["memberCount", "childrenUnderFive"];

// See the payload value rule in recordService.js. Inputs hand back strings for
// everything, so the coercion lives here, where the form knows which field is a
// count and which is free text. An unanswered field is null, never "" or 0.
function toPayload(form) {
  const payload = {};

  for (const [field, raw] of Object.entries(form)) {
    const value = typeof raw === "string" ? raw.trim() : raw;

    if (value === "" || value === null || value === undefined) {
      payload[field] = null;
    } else if (NUMBER_FIELDS.includes(field)) {
      const asNumber = Number(value);
      payload[field] = Number.isFinite(asNumber) ? asNumber : null;
    } else {
      // Dates already arrive as ISO 8601 ("2026-09-22") from <input type="date">.
      payload[field] = value;
    }
  }

  return payload;
}

// React warns about a null value on a controlled input, so nulls become "" on
// the way back into the form.
function toFormState(payload) {
  const form = { ...EMPTY_FORM };
  for (const [field, value] of Object.entries(payload ?? {})) {
    form[field] = value === null || value === undefined ? "" : String(value);
  }
  return form;
}

const WATER_SOURCES = ["Piped", "Handpump", "Well", "Tanker", "Other"];

const EMPTY_FORM = {
  householdName: "",
  memberCount: "",
  visitDate: "",
  waterSource: "",
  childrenUnderFive: "",
  notes: "",
};

// FIELD_LABELS and showValue now live in ./formFields.js, shared with the
// supervisor's conflict screen.

const BADGE_COLOURS = {
  [SYNC_STATE.SYNCED]: "seagreen",
  [SYNC_STATE.CONFLICT]: "crimson",
  [SYNC_STATE.REJECTED]: "#7f1d1d",
  [SYNC_STATE.PENDING]: "#b45309",
};

const styles = {
  section: { marginTop: "2rem", borderTop: "1px solid #ddd", paddingTop: "1rem" },
  label: { display: "block", marginBottom: "0.75rem" },
  field: { display: "block", width: "100%", padding: "0.4rem", marginTop: 2 },
  row: { borderBottom: "1px solid #eee", padding: "0.5rem 0" },
  badge: (state) => ({
    display: "inline-block",
    padding: "0.1rem 0.5rem",
    borderRadius: 999,
    fontSize: 12,
    color: "#fff",
    background: BADGE_COLOURS[state] ?? "#666",
  }),
  error: { color: "crimson" },
  muted: { color: "#666", fontSize: 14 },
  syncBar: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    flexWrap: "wrap",
    margin: "0.5rem 0",
  },
  notice: (tone) => ({
    padding: "0.5rem 0.75rem",
    borderRadius: 4,
    fontSize: 14,
    border: `1px solid ${tone === "warn" ? "#b45309" : "#ccc"}`,
    background: tone === "warn" ? "#fffbeb" : "#f6f6f6",
  }),
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
  compareHead: { fontWeight: 600 },
  differs: { background: "#fff1f2" },
  resolved: {
    padding: "0.5rem 0.75rem",
    borderRadius: 4,
    fontSize: 14,
    border: "1px solid #0369a1",
    background: "#f0f9ff",
    marginTop: "0.5rem",
  },
};

// Reads only; the caller decides what to do with the result. Keeping state out
// of here is what lets the mount effect use it without setting state mid-render.
async function loadRecords() {
  const [rows, pendingCount, lastSyncAt, deviceCounts] = await Promise.all([
    listRecords(),
    countPendingRecords(),
    getLastSyncAt(),
    countUnsyncedOnDevice(),
  ]);
  return { rows, pendingCount, lastSyncAt, deviceCounts };
}

function summarise(record) {
  const { householdName, visitDate, memberCount } = record.payload;
  // "?" not 0: an unanswered count is not a count of zero.
  return [householdName || "(no name)", visitDate, `${memberCount ?? "?"} members`]
    .filter(Boolean)
    .join(" · ");
}

function SurveyForm({ value, onChange, onSubmit, onCancel, busy, editing }) {
  const set = (field) => (event) =>
    onChange({ ...value, [field]: event.target.value });

  return (
    <form onSubmit={onSubmit}>
      <label style={styles.label}>
        Household name
        <input style={styles.field} value={value.householdName} onChange={set("householdName")} />
      </label>
      <label style={styles.label}>
        Members in household
        <input
          style={styles.field}
          type="number"
          min="0"
          value={value.memberCount}
          onChange={set("memberCount")}
        />
      </label>
      <label style={styles.label}>
        Children under five
        <input
          style={styles.field}
          type="number"
          min="0"
          value={value.childrenUnderFive}
          onChange={set("childrenUnderFive")}
        />
      </label>
      <label style={styles.label}>
        Visit date
        <input style={styles.field} type="date" value={value.visitDate} onChange={set("visitDate")} />
      </label>
      <label style={styles.label}>
        Main water source
        <select style={styles.field} value={value.waterSource} onChange={set("waterSource")}>
          <option value="">Select…</option>
          {WATER_SOURCES.map((source) => (
            <option key={source} value={source}>
              {source}
            </option>
          ))}
        </select>
      </label>
      <label style={styles.label}>
        Notes
        <textarea style={styles.field} rows={3} value={value.notes} onChange={set("notes")} />
      </label>

      <button type="submit" disabled={busy}>
        {editing ? "Save changes" : "Save record"}
      </button>{" "}
      {editing && (
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      )}
    </form>
  );
}

/**
 * Two payloads side by side, with the fields that actually differ tinted.
 *
 * Shared by the conflict view and the resolution notice, because they ask the
 * same question of a worker — "what is different between these two?" — and
 * answering it two slightly different ways is how two answers start to disagree.
 * The tinting is not decoration: nobody diffs twenty identical fields by eye,
 * and a worker who cannot find the disagreement will assume their visit was
 * lost.
 */
function CompareGrid({ leftLabel, rightLabel, left, right, extraRows = [] }) {
  const fields = unionFields(left, right);
  const differs = differingFields(left, right);

  return (
    <div style={styles.compare}>
      <span style={styles.compareHead} />
      <span style={styles.compareHead}>{leftLabel}</span>
      <span style={styles.compareHead}>{rightLabel}</span>

      {fields.map((field) => {
        const tint = differs.has(field) ? styles.differs : undefined;
        return (
          <Fragment key={field}>
            <span style={styles.muted}>{FIELD_LABELS[field] ?? field}</span>
            <span style={tint}>{showValue(left?.[field] ?? null)}</span>
            <span style={tint}>{showValue(right?.[field] ?? null)}</span>
          </Fragment>
        );
      })}

      {extraRows.map(([label, a, b]) => (
        <Fragment key={label}>
          <span style={styles.muted}>{label}</span>
          <span>{a}</span>
          <span>{b}</span>
        </Fragment>
      ))}
    </div>
  );
}

/**
 * Both copies of a conflicted record, side by side and read-only.
 *
 * Read-only is now literal: while this is on screen the row cannot be edited at
 * all (see assertEditable in recordService.js). What a worker must never have is
 * a red badge with nothing behind it — "conflict" means nothing to somebody who
 * cannot see what the two sides actually disagree about.
 */
function ConflictCompare({ record }) {
  const server = record.serverConflict;
  if (!server) return null;

  return (
    <CompareGrid
      leftLabel={`On this device (v${record.version})`}
      rightLabel={`On the server (v${server.version})`}
      left={record.payload}
      right={server.payload}
      extraRows={[
        ["Deleted", record.deletedAt ? "yes" : "no", server.deletedAt ? "yes" : "no"],
        ["Server saved", "—", shortTime(server.updatedAt) ?? "—"],
      ]}
    />
  );
}

// What each decision actually did to THIS worker's record, in the second person.
// "kept_client" is not a phrase anybody has to decode: the point of the sentence
// is that a person looked at both versions and chose, and which one they chose.
//
// Split by whether this worker is the one whose copy was under judgement,
// because the same decision is opposite news for the two of them. A resolution
// also reaches the worker who CAPTURED the record without having pushed the
// losing copy — "a supervisor kept your version" would simply be untrue to them,
// and a notice that tells somebody something they know to be wrong is a notice
// they stop reading.
function resolutionHeadline({ resolution, submittedByMe }) {
  if (resolution === "merged") {
    return "A supervisor combined both versions of this record, field by field.";
  }
  if (resolution === "kept_client") {
    return submittedByMe
      ? "A supervisor kept your version of this record."
      : "A supervisor replaced this record with another worker's version.";
  }
  if (resolution === "kept_server") {
    return submittedByMe
      ? "A supervisor kept the version that was already on the server, not yours."
      : "A supervisor kept this record as it was.";
  }
  return "A supervisor resolved a disagreement about this record.";
}

/**
 * What happened to a record while it was in dispute.
 *
 * A worker whose copy lost has to be able to see three things, and this is the
 * only place any of them appear: that a supervisor changed the record, what the
 * current version now says, and — when their own answers were the ones dropped —
 * what those answers were.
 *
 * The last one is why this is not a toast. A record silently becoming something
 * else on the phone of the person who walked to that household is exactly the
 * harm this project exists to prevent, and a notice that disappears on its own
 * is barely different from no notice at all. It stays until the worker dismisses
 * it, and dismissing says what is being given up.
 */
function ResolutionNotice({ record, onDismiss, busy }) {
  const notice = record.resolvedNotice;
  if (!notice) return null;

  const discarded = notice.discardedPayload;

  return (
    <div style={styles.resolved}>
      <strong>{resolutionHeadline(notice)}</strong>{" "}
      <span style={styles.muted}>
        {notice.resolvedByName ? `${notice.resolvedByName}, ` : ""}
        {shortTime(notice.resolvedAt) ?? "recently"} (server time)
      </span>

      <p style={{ margin: "0.5rem 0 0" }}>
        This record now reads as version {record.version}
        {record.deletedAt ? ", and has been deleted" : ""}. It is back in sync and
        you can edit it again.
      </p>

      {discarded ? (
        <>
          <p style={{ margin: "0.5rem 0 0" }}>
            {/* Named explicitly. "Your copy was replaced" is the fact a worker
                needs; burying it under a neutral "the record was updated" is how
                somebody finds out a week later that their visit is gone. */}
            Your copy of these answers (v{notice.discardedVersion}) was{" "}
            <strong>replaced</strong>. It is shown below, and the copy you sent is
            also kept on the server with the record of this decision.
          </p>
          <CompareGrid
            leftLabel={`Your copy (v${notice.discardedVersion})`}
            rightLabel={`Now (v${record.version})`}
            left={discarded}
            right={record.payload}
          />
        </>
      ) : (
        <p style={{ margin: "0.5rem 0 0" }}>
          {/* Carefully narrower than "nothing changed", which would be false:
              the record itself may well read differently now, and the line above
              says so. What is true in every no-discard case is that this phone
              was not holding anything unsent that the decision threw away. */}
          Nothing you had captured but not yet sent was discarded by this
          decision.
        </p>
      )}

      <p style={{ margin: "0.5rem 0 0" }}>
        <button onClick={() => onDismiss(record)} disabled={busy}>
          {discarded ? "Dismiss (removes the copy above from this phone)" : "Dismiss"}
        </button>
      </p>
    </div>
  );
}

function RecordRow({ record, onEdit, onDelete, onDismiss, busy, expanded, onToggle }) {
  const isConflict = record.syncState === SYNC_STATE.CONFLICT;
  const isRejected = record.syncState === SYNC_STATE.REJECTED;
  // The server's copy is a tombstone while this device still holds the row.
  const serverDeleted = isConflict && record.serverConflict?.deletedAt != null;

  return (
    <li style={styles.row}>
      <span style={styles.badge(record.syncState)}>{record.syncState}</span>{" "}
      {summarise(record)}{" "}
      <span style={styles.muted}>v{record.version}</span>
      {record.deletedAt && <span style={styles.muted}> · deleted</span>}
      <br />

      {isConflict && (
        <p style={styles.muted}>
          {/* A deletion and an edit are not the same news. Telling a worker
              "someone changed this" when the record was actually deleted leaves
              them to discover it in the comparison grid, and the thing they most
              need to know — that their own copy is the only one left — is the
              thing the sentence omits. */}
          {serverDeleted ? (
            <>
              This record was <strong>deleted on the server</strong> while your
              changes were still on this phone. Your copy has been kept and will
              not be sent back until someone decides which is right.
            </>
          ) : (
            <>
              Someone else changed this record on the server before your copy
              arrived. Both versions are kept — a supervisor decides which one
              stands.
            </>
          )}{" "}
          <button onClick={() => onToggle(record.id)}>
            {expanded ? "Hide both versions" : "Compare both versions"}
          </button>
        </p>
      )}

      {isConflict && expanded && <ConflictCompare record={record} />}

      <ResolutionNotice record={record} onDismiss={onDismiss} busy={busy} />

      {isRejected && (
        <p style={styles.muted}>
          {/* Server messages are fragments, not sentences, so the full stop is
              added here rather than in every reason string. */}
          The server refused this record: {record.syncError?.message ?? "no reason given"}.{" "}
          It is still saved on this device. Editing it will send it again.
        </p>
      )}

      {/* Disabled, not hidden, and with the reason beside them. A conflicted
          row is read-only until somebody resolves it — recordService refuses the
          write regardless of what this renders — and a button that silently
          stops working teaches a worker that the app is broken. Saying why also
          says that the record is not lost and that somebody is expected to act.
          The rule itself is in assertEditable(): editing here would put the row
          back to PENDING, push it against the same stale base, and conflict
          again, forever. */}
      <button onClick={() => onEdit(record)} disabled={busy || isConflict}>
        Edit
      </button>{" "}
      <button onClick={() => onDelete(record)} disabled={busy || isConflict}>
        Delete
      </button>
      {isConflict && (
        <span style={styles.muted}>
          {" "}
          · locked until this is resolved
        </span>
      )}
    </li>
  );
}

/**
 * The server's own timestamp, shown as the server wrote it — sliced by
 * shortTime(), never passed through new Date(). See lib/time.js for why
 * reparsing it would make a phone display a confident, wrong time for something
 * that happened on another machine.
 */
function lastSyncedLabel(serverSyncedAt) {
  if (!serverSyncedAt) return "Never synced";
  return `Last synced ${shortTime(serverSyncedAt)} (server time)`;
}

/**
 * Another worker's unsent records, reported separately from the current user's.
 *
 * Kept apart from the "waiting to sync" count rather than folded into it,
 * because they are not the same fact and do not have the same remedy. The
 * signed-in worker cannot send these — the sync engine will not push another
 * user's rows under this user's token, which is correct — so a single combined
 * number would tell them to press a button that will never clear it.
 *
 * Without this line the phone reads "0 waiting to sync" over a database holding
 * somebody else's week of visits, which is the exact state in which a device
 * gets wiped or handed on.
 */
function OtherWorkerNotice({ deviceCounts }) {
  if (!deviceCounts || deviceCounts.others === 0) return null;

  const { others, otherWorkers } = deviceCounts;
  const one = others === 1;
  // Object and subject forms are tracked separately: "sync them" but "they have
  // synced", and the two are not interchangeable.
  const them = one ? "it" : "them";
  const theyHave = one ? "it has" : "they have";

  return (
    <p style={styles.notice("warn")}>
      <strong>
        {others} {one ? "record" : "records"} captured by{" "}
        {otherWorkers === 1 ? "another worker" : `${otherWorkers} other workers`}{" "}
        {one ? "is" : "are"} also on this phone, still unsent.
      </strong>{" "}
      Only the worker who collected {them} can sync {them}, after signing in
      here. Do not wipe or hand on this phone until {theyHave} synced.
    </p>
  );
}

function SyncNotice({ summary }) {
  if (!summary) return null;

  if (summary.needsOnlineSignIn) {
    return (
      <p style={styles.notice("warn")}>
        <strong>Sign in to sync.</strong> You signed in on this device without a
        connection, so it has no session with the server yet. Your records are
        safe and still waiting — sign out and sign in again with your password
        while you have signal, then sync.
      </p>
    );
  }

  if (summary.transportError) {
    return (
      <p style={styles.notice("warn")}>
        Could not reach the server: {summary.transportError}. Nothing was lost —
        every record is still waiting on this device.
      </p>
    );
  }

  const parts = [];
  if (summary.attempted > 0) parts.push(`${summary.accepted} sent`);
  if (summary.conflicts) parts.push(`${summary.conflicts} in conflict`);
  if (summary.rejected) parts.push(`${summary.rejected} refused`);
  if (summary.failed) parts.push(`${summary.failed} to retry`);

  // The pull side. `received` counts rows new to this device rather than
  // everything the window returned, because "12 received" when eleven were
  // already here reads as a problem.
  if (summary.received) parts.push(`${summary.received} received`);
  if (summary.applied > summary.received) {
    parts.push(`${summary.applied - summary.received} updated`);
  }
  if (summary.pullConflicts) parts.push(`${summary.pullConflicts} needs review`);
  if (summary.heldBack) parts.push(`${summary.heldBack} kept local`);

  // Counted apart from "received" and "updated". A record leaving conflict
  // because a person decided about it is not the same event as a record
  // arriving, and a worker who has been unable to edit a row for days is owed a
  // line that says so rather than one more number in a row of them.
  if (summary.resolutionsApplied) {
    parts.push(`${summary.resolutionsApplied} conflict resolved`);
  }
  if (summary.resolutionsNoticed) {
    parts.push(`${summary.resolutionsNoticed} changed by a supervisor`);
  }

  if (parts.length === 0) {
    // A sync that pushed nothing and received nothing still reached the server,
    // which is worth saying plainly — the worker pressed a button and deserves
    // an answer other than silence.
    return <p style={styles.notice()}>Up to date. Nothing to send or receive.</p>;
  }

  return <p style={styles.notice()}>{parts.join(" · ")}</p>;
}

export default function CaptureScreen() {
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState(null);
  const [records, setRecords] = useState([]);
  const [pending, setPending] = useState(0);
  const [lastSyncAt, setLastSyncAt] = useState(null);
  const [deviceCounts, setDeviceCounts] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncSummary, setSyncSummary] = useState(null);
  const [expandedId, setExpandedId] = useState(null);

  const refresh = useCallback(async () => {
    const { rows, pendingCount, lastSyncAt: at, deviceCounts: counts } =
      await loadRecords();
    setRecords(rows);
    setPending(pendingCount);
    setLastSyncAt(at);
    setDeviceCounts(counts);
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadRecords()
      .then(({ rows, pendingCount, lastSyncAt: at, deviceCounts: counts }) => {
        if (cancelled) return;
        setRecords(rows);
        setPending(pendingCount);
        setLastSyncAt(at);
        setDeviceCounts(counts);
      })
      .catch((err) => {
        if (!cancelled) setError(`Could not read local records: ${err.message}`);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // A sync can also start without anyone pressing anything — the "online" event
  // fires wherever the worker happens to be in the app — so the list listens for
  // the result rather than only updating after its own button.
  useEffect(() => {
    const stopReconnectSync = startSyncOnReconnect();

    const onSynced = (event) => {
      setSyncSummary(event.detail);
      void refresh().catch(() => {});
    };
    window.addEventListener(SYNC_EVENT, onSynced);

    return () => {
      stopReconnectSync();
      window.removeEventListener(SYNC_EVENT, onSynced);
    };
  }, [refresh]);

  // Every mutation follows the same shape: write to Dexie, then re-read. The
  // write itself never touches the network, so this stays instant offline.
  async function run(action) {
    setBusy(true);
    setError(null);
    // The sync notice describes a run that has now been overtaken — capturing or
    // editing a record makes "nothing waiting to sync" a lie the moment it is
    // written. Left on screen it contradicts the counter beside it, and a worker
    // reading "nothing waiting" over a queue of three has no reason to press
    // Sync again.
    setSyncSummary(null);
    try {
      await action();
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  // Not routed through run(): a sync must not disable the form. A worker on a
  // slow connection should be able to keep capturing while the push is in the
  // air, which is the whole reason capture and sync are separate layers.
  const handleSync = async () => {
    setSyncing(true);
    setSyncSummary(null);
    try {
      // The SYNC_EVENT listener above applies the summary and refreshes, so
      // there is nothing to do with the returned value here.
      await runSync();
    } catch (err) {
      // runSync folds every expected failure into its summary, so reaching here
      // means something underneath broke — an unreadable database, most likely.
      // Without this the rejection escapes the click handler entirely and the
      // button just stops working with nothing on screen to say why.
      setError(`Sync could not run: ${err.message}`);
    } finally {
      setSyncing(false);
    }
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    return run(async () => {
      const payload = toPayload(form);

      if (editingId) {
        await updateRecord(editingId, payload);
        setEditingId(null);
      } else {
        await createRecord({
          formType: FORM_TYPE,
          formVersion: FORM_VERSION,
          payload,
        });
      }
      setForm(EMPTY_FORM);
    });
  };

  const handleEdit = (record) => {
    setEditingId(record.id);
    setForm(toFormState(record.payload));
  };

  const handleDelete = (record) =>
    run(async () => {
      await softDeleteRecord(record.id);
      if (editingId === record.id) {
        setEditingId(null);
        setForm(EMPTY_FORM);
      }
    });

  const handleCancel = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
  };

  // Confirmed, because on a kept_server resolution this is the last copy of the
  // worker's own answers ON THIS PHONE. It is not the last copy anywhere — the
  // pushed payload stays in record_conflicts on the server, which resolution
  // never deletes — and the wording says exactly that rather than implying a
  // destruction that is not happening, or a safety that is not there.
  const handleDismissNotice = (record) => {
    const discarded = record.resolvedNotice?.discardedPayload;
    if (
      discarded &&
      !window.confirm(
        "This removes your replaced copy of these answers from this phone. " +
          "It stays on the server with the record of the supervisor's decision. Dismiss?"
      )
    ) {
      return;
    }
    return run(() => dismissResolutionNotice(record.id));
  };

  const toggleExpanded = (id) => setExpandedId((current) => (current === id ? null : id));

  return (
    <div style={styles.section}>
      <h2>Household survey</h2>

      <div style={styles.syncBar}>
        <button onClick={handleSync} disabled={syncing}>
          {syncing ? "Syncing…" : "Sync now"}
        </button>
        <span style={styles.muted}>
          <strong>{pending}</strong> waiting to sync · {lastSyncedLabel(lastSyncAt)}
        </span>
      </div>

      <SyncNotice summary={syncSummary} />
      <OtherWorkerNotice deviceCounts={deviceCounts} />

      {error && <p style={styles.error}>{error}</p>}

      <SurveyForm
        value={form}
        onChange={setForm}
        onSubmit={handleSubmit}
        onCancel={handleCancel}
        busy={busy}
        editing={Boolean(editingId)}
      />

      <h3>Records ({records.length})</h3>
      {records.length === 0 ? (
        <p style={styles.muted}>Nothing captured yet.</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0 }}>
          {records.map((record) => (
            <RecordRow
              key={record.id}
              record={record}
              onEdit={handleEdit}
              onDelete={handleDelete}
              onDismiss={handleDismissNotice}
              busy={busy}
              expanded={expandedId === record.id}
              onToggle={toggleExpanded}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
