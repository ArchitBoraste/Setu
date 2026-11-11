import { useCallback, useEffect, useState } from "react";
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
import { getCachedUser } from "../auth/authService.js";
import { shortTime } from "../lib/time.js";
import CompareGrid from "../components/CompareGrid.jsx";
import FormFields from "../forms/FormFields.jsx";
import { FORMS_UPDATED_EVENT, loadCatalog } from "../forms/formStore.js";
import {
  checkAnswers,
  chooseDefinition,
  emptyValues,
  findDefinition,
  isPristine,
  summarise,
  toFormValues,
  toPayload,
} from "../forms/formRules.js";
import { EDIT_BLOCK, editBlockReason, seesWholeOrganisation } from "./scope.js";

// Temporary capture screen, drawn from the published form definitions this
// device holds (see forms/formRules.js for which one is used when):
//
//   a NEW record    uses the latest version of the form;
//   an EDIT         uses the record's own version, so an old record keeps the
//                   fields it was captured with and stays valid.
//
// Everything here reads IndexedDB. Forms arrive with sign-in and sync; with
// none downloaded yet, the built-in version 1 is used, so a first start
// offline can still capture.

/**
 * The form on screen: which definition it is drawn from, what has been typed,
 * and which record it edits (null for a new one). One object, so a single
 * state update decides all three together — see adoptLatestForm.
 */
function freshForm(catalog) {
  const choice = chooseDefinition({ catalog });
  const definition = choice.definition ?? null;
  return {
    definition,
    values: definition ? emptyValues(definition) : {},
    editingId: null,
    builtin: Boolean(choice.builtin),
  };
}

/**
 * The form to show after the catalog changed. A newly downloaded version
 * replaces the one on screen only while nothing has been typed into it and no
 * record is being edited: swapping fields under a worker mid-capture would
 * move or drop what they entered.
 */
function adoptLatestForm(current, catalog) {
  if (current.definition && (current.editingId || !isPristine(current.values))) return current;
  return freshForm(catalog);
}

// The side-by-side diff lives in ../components/CompareGrid.jsx, shared with
// the supervisor's screen; labels come from each record's own definition.

const BADGE_COLOURS = {
  [SYNC_STATE.SYNCED]: "seagreen",
  [SYNC_STATE.CONFLICT]: "crimson",
  [SYNC_STATE.REJECTED]: "#7f1d1d",
  [SYNC_STATE.PENDING]: "#b45309",
};

const styles = {
  section: { marginTop: "2rem", borderTop: "1px solid #ddd", paddingTop: "1rem" },
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
//
// The user is re-read with everything else rather than taken from a prop, so
// the rules the rows are drawn by are the ones listRecords() just applied.
async function loadRecords() {
  const [rows, pendingCount, lastSyncAt, deviceCounts, user] = await Promise.all([
    listRecords(),
    countPendingRecords(),
    getLastSyncAt(),
    countUnsyncedOnDevice(),
    getCachedUser(),
  ]);
  // Read with everything else, so the rows are always drawn with the forms
  // that were on the device when they were read.
  const catalog = await loadCatalog(user?.organizationId);
  return { rows, pendingCount, lastSyncAt, deviceCounts, user, catalog };
}

/**
 * The form itself. noValidate, because checkAnswers is the check: it applies
 * the server's rules and puts the message under the field, in the same words
 * whichever browser the worker has.
 */
function SurveyForm({ form, problems, onChange, onSubmit, onCancel, busy }) {
  const { definition, editingId } = form;
  return (
    <form onSubmit={onSubmit} noValidate>
      <FormFields
        definition={definition}
        values={form.values}
        problems={problems}
        onChange={onChange}
        disabled={busy}
      />

      <button type="submit" disabled={busy}>
        {editingId ? "Save changes" : "Save record"}
      </button>{" "}
      {editingId && (
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      )}
    </form>
  );
}

/** The record's own form version, or null when this device does not have it. */
function definitionOf(record, catalog) {
  return findDefinition(catalog, record.formType, record.formVersion);
}

/**
 * Both copies of a conflicted record, side by side and read-only.
 *
 * Read-only is now literal: while this is on screen the row cannot be edited at
 * all (see assertEditable in recordService.js). What a worker must never have is
 * a red badge with nothing behind it — "conflict" means nothing to somebody who
 * cannot see what the two sides actually disagree about.
 */
function ConflictCompare({ record, catalog }) {
  const server = record.serverConflict;
  if (!server) return null;

  // Who made the server's version, when the server has said. With workers
  // sharing an area it is usually a colleague, and knowing which one is often
  // enough to explain the disagreement.
  const serverBy = server.updatedByName ? `, ${server.updatedByName}` : "";

  return (
    <CompareGrid
      leftLabel={`On this device (v${record.version})`}
      rightLabel={`On the server (v${server.version}${serverBy})`}
      left={record.payload}
      right={server.payload}
      definitions={[
        definitionOf(record, catalog),
        findDefinition(catalog, server.formType, server.formVersion),
      ]}
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
function resolutionHeadline({ resolution, submittedByMe, submittedDeleted, restored }, record) {
  if (resolution === "merged") {
    return "A supervisor combined both versions of this record, field by field.";
  }
  if (resolution === "kept_client") {
    // Restoring is the biggest thing that can happen to a household record short
    // of deleting it, and the worker who walked there needs it named, not folded
    // into "kept your version" — which would read the same whether the household
    // came back or not.
    if (restored) {
      return submittedByMe
        ? "A supervisor kept your version and restored this household, which had been deleted on the server."
        : "A supervisor restored this household, which had been deleted, with another worker's version.";
    }
    if (!submittedByMe) {
      return "A supervisor replaced this record with another worker's version.";
    }
    // Keep-worker leaves a deleted record deleted when nobody recorded whether
    // the worker's copy was a deletion (see the closing note in
    // server/sync/conflictRules.js). "Kept your version" on its own would tell
    // the worker their household is back in the register when it is not — so
    // the answers and the deletion are named separately.
    return record.deletedAt && !submittedDeleted
      ? "A supervisor kept your answers, but the record stays deleted."
      : "A supervisor kept your version of this record.";
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
function ResolutionNotice({ record, catalog, onDismiss, busy }) {
  const notice = record.resolvedNotice;
  if (!notice) return null;

  // Each kept copy is labelled by the form version it was captured under, when
  // the notice recorded it; older notices fall back to the record's own.
  const current = definitionOf(record, catalog);
  const versionOf = (formVersion) =>
    formVersion == null ? current : findDefinition(catalog, record.formType, formVersion);

  const discarded = notice.discardedPayload;
  // Absent on notices written before this field existed, which is why it is
  // read with ?? rather than assumed.
  const superseded = notice.supersededPayload ?? null;
  const keepsSomething = Boolean(discarded || superseded);

  return (
    <div style={styles.resolved}>
      <strong>{resolutionHeadline(notice, record)}</strong>{" "}
      <span style={styles.muted}>
        {notice.resolvedByName ? `${notice.resolvedByName}, ` : ""}
        {shortTime(notice.resolvedAt) ?? "recently"} (server time)
      </span>

      <p style={{ margin: "0.5rem 0 0" }}>
        {record.deletedAt ? (
          // Said outright, not folded into a version number. A record that a
          // decision DELETED is the case where "it now reads as v4" is the least
          // useful sentence available.
          <>
            This record has been <strong>deleted</strong> (version {record.version}).
            It stays on this list until you dismiss this notice.
          </>
        ) : (
          <>
            {notice.restored && (
              <>
                It is <strong>back in the register</strong>.{" "}
              </>
            )}
            This record now reads as version {record.version}. It is back in sync
            and you can edit it again.
          </>
        )}
      </p>

      {superseded && (
        <>
          <p style={{ margin: "0.5rem 0 0" }}>
            {/* This is the case that used to end in silence: the worker who
                captured the record, holding no unsent work, watches it become
                something else. Their earlier answers were already overwritten on
                this phone by the ordinary pull — this copy came back from the
                server, which now keeps it with the decision. */}
            Before this decision the record read as below (v{notice.supersededVersion}).
            That version was <strong>replaced</strong>. It is kept on the server
            with the record of this decision.
          </p>
          <CompareGrid
            leftLabel={`Before (v${notice.supersededVersion})`}
            rightLabel={`Now (v${record.version})`}
            left={superseded}
            right={record.payload}
            definitions={[versionOf(notice.supersededFormVersion), current]}
          />
        </>
      )}

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
            definitions={[versionOf(notice.discardedFormVersion), current]}
          />
        </>
      ) : (
        <p style={{ margin: "0.5rem 0 0" }}>
          {/* Carefully narrower than "nothing changed", which would be false:
              the record itself may well read differently now, and the lines
              above say so. What is true in every no-discard case is that this
              phone was not holding anything unsent that the decision threw
              away. */}
          Nothing you had captured but not yet sent was discarded by this
          decision.
        </p>
      )}

      <p style={{ margin: "0.5rem 0 0" }}>
        <button onClick={() => onDismiss(record)} disabled={busy}>
          {keepsSomething
            ? "Dismiss (removes the earlier version above from this phone)"
            : "Dismiss"}
        </button>
      </p>
    </div>
  );
}

/**
 * Whose record this is and whose change it carries.
 *
 * Two names, because once supervisors see everyone's rows "who captured this
 * household" and "who changed it last" are different people often enough to
 * matter. A name the server never recorded is said to be unrecorded rather
 * than left blank or guessed at.
 */
function Attribution({ record }) {
  const unsent =
    record.syncState === SYNC_STATE.PENDING || record.syncState === SYNC_STATE.REJECTED;
  return (
    <span style={styles.muted}>
      Created by {record.createdByName ?? "—"} · last change by{" "}
      {record.updatedByName ?? "not recorded"}
      {unsent && " (not yet on the server)"}
    </span>
  );
}

function RecordRow({
  record,
  user,
  catalog,
  onEdit,
  onDelete,
  onDismiss,
  busy,
  expanded,
  onToggle,
}) {
  const isConflict = record.syncState === SYNC_STATE.CONFLICT;
  const isRejected = record.syncState === SYNC_STATE.REJECTED;
  const isPending = record.syncState === SYNC_STATE.PENDING;
  // The server's copy is a tombstone while this device still holds the row.
  const serverDeleted = record.serverConflict?.deletedAt != null;
  // Held by the old pull-side lock, not yet released. See the v6 upgrade.
  const awaitingRelease = isConflict && record.legacyDeletionLock === true;
  // A colleague on this phone changed the row and has not synced it. See
  // editBlockReason in scope.js; recordService refuses the write regardless.
  const heldForOtherEditor =
    user != null && editBlockReason(record, user) === EDIT_BLOCK.OTHER_EDITOR;
  const locked = isConflict || heldForOtherEditor;
  const definition = definitionOf(record, catalog);

  return (
    <li style={styles.row}>
      <span style={styles.badge(record.syncState)}>{record.syncState}</span>{" "}
      {summarise(record.payload, definition)}{" "}
      <span style={styles.muted}>
        v{record.version} · form v{record.formVersion}
        {/* Said, not hidden: the row can still be read by its keys, but it
            cannot be edited until the version arrives (see handleEdit). */}
        {!definition && " (not on this phone yet — sync to download it)"}
      </span>
      {record.deletedAt && <span style={styles.muted}> · deleted</span>}
      <br />
      <Attribution record={record} />
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
              changes were still on this phone. Your copy is kept.{" "}
              {awaitingRelease
                ? "On your next sync it goes to a supervisor, who decides whether the record stays deleted."
                : "It has gone to a supervisor, who decides whether the record stays deleted."}
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

      {isConflict && expanded && <ConflictCompare record={record} catalog={catalog} />}

      {(isPending || isRejected) && serverDeleted && (
        <p style={styles.muted}>
          {/* The one moment this used to go silent and then lock for good. The
              row is still unsent work — editable, queued — and the worker needs
              to know two things: that the record was deleted, and that their
              copy is not being thrown away but sent to someone who decides. */}
          This record was <strong>deleted on the server</strong> while your
          changes were still on this phone. Your copy is kept.{" "}
          {isPending
            ? "On your next sync it goes to a supervisor, who decides whether the record stays deleted."
            : "Once you fix it, it goes to a supervisor, who decides whether the record stays deleted."}
        </p>
      )}

      <ResolutionNotice record={record} catalog={catalog} onDismiss={onDismiss} busy={busy} />

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
      <button onClick={() => onEdit(record)} disabled={busy || locked}>
        Edit
      </button>{" "}
      <button onClick={() => onDelete(record)} disabled={busy || locked}>
        Delete
      </button>
      {isConflict && (
        <span style={styles.muted}>
          {" "}
          · locked until this is resolved
        </span>
      )}
      {heldForOtherEditor && (
        <span style={styles.muted}>
          {" "}
          · locked: {record.updatedByName ?? "someone else"} changed this on this
          phone and has not synced yet
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
 * Another person's unsent changes, reported separately from the current user's.
 *
 * Kept apart from the "waiting to sync" count rather than folded into it,
 * because they are not the same fact and do not have the same remedy. The
 * signed-in worker cannot send these — the sync engine pushes a change only
 * under the token of whoever made it, which is correct — so a single combined
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
        {others} {one ? "record" : "records"} changed by{" "}
        {otherWorkers === 1 ? "another worker" : `${otherWorkers} other workers`}{" "}
        {one ? "is" : "are"} also on this phone, still unsent.
      </strong>{" "}
      Only the person who made those changes can sync {them}, after signing in
      here. Do not wipe or hand on this phone until {theyHave} synced.
    </p>
  );
}

// Says whose records the list holds, because it is no longer always "yours".
function listHeading(user, count) {
  if (seesWholeOrganisation(user)) return `Records in your organisation (${count})`;
  if (user?.areaName) return `Records in ${user.areaName} (${count})`;
  // A worker with no area sees only what they captured themselves.
  return `Your records (${count})`;
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

  if (summary.scopeChanged) {
    return (
      <p style={styles.notice("warn")}>
        Your area or role was changed while this sync was running. Nothing was
        lost — press <strong>Sync now</strong> again to load your new records.
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
  if (summary.deletedOnServer) {
    parts.push(`${summary.deletedOnServer} deleted on the server, your copy goes for review next sync`);
  }
  if (summary.legacyLocksReleased) {
    parts.push(`${summary.legacyLocksReleased} unlocked, goes for review next sync`);
  }

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

/** What the form heading says about the version on screen. */
function formCaption(form) {
  const { definition, editingId, builtin } = form;
  if (editingId) {
    // The record's own version, which may be older than the one new records
    // use. Said, so a worker missing a newer question knows why.
    return `Editing a record captured on form version ${definition.version}, with that version's questions.`;
  }
  return builtin
    ? `Form version ${definition.version}, built into the app. Sync while online to get the latest version.`
    : `Form version ${definition.version}.`;
}

export default function CaptureScreen() {
  const [catalog, setCatalog] = useState([]);
  // { definition, values, editingId, builtin } — see freshForm. definition is
  // null only until the first read of the catalog.
  const [form, setForm] = useState({ definition: null, values: {}, editingId: null, builtin: false });
  // Per-field problems from the last save attempt, by key.
  const [problems, setProblems] = useState({});
  // Why an edit could not be opened, said where the form is.
  const [formNotice, setFormNotice] = useState(null);
  const [records, setRecords] = useState([]);
  const [pending, setPending] = useState(0);
  const [lastSyncAt, setLastSyncAt] = useState(null);
  const [deviceCounts, setDeviceCounts] = useState(null);
  const [user, setUser] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncSummary, setSyncSummary] = useState(null);
  const [expandedId, setExpandedId] = useState(null);

  const apply = useCallback((loaded) => {
    setRecords(loaded.rows);
    setPending(loaded.pendingCount);
    setLastSyncAt(loaded.lastSyncAt);
    setDeviceCounts(loaded.deviceCounts);
    setUser(loaded.user);
    setCatalog(loaded.catalog);
    setForm((current) => adoptLatestForm(current, loaded.catalog));
  }, []);

  const refresh = useCallback(async () => apply(await loadRecords()), [apply]);

  useEffect(() => {
    let cancelled = false;
    loadRecords()
      .then((loaded) => {
        if (!cancelled) apply(loaded);
      })
      .catch((err) => {
        if (!cancelled) setError(`Could not read local records: ${err.message}`);
      });
    return () => {
      cancelled = true;
    };
  }, [apply]);

  // A sync can also start without anyone pressing anything — the "online" event
  // fires wherever the worker happens to be in the app — so the list listens for
  // the result rather than only updating after its own button. Forms arrive the
  // same way, at sign-in and at the start of each sync.
  useEffect(() => {
    const stopReconnectSync = startSyncOnReconnect();

    const onSynced = (event) => {
      setSyncSummary(event.detail);
      void refresh().catch(() => {});
    };
    const onForms = () => void refresh().catch(() => {});
    window.addEventListener(SYNC_EVENT, onSynced);
    window.addEventListener(FORMS_UPDATED_EVENT, onForms);

    return () => {
      stopReconnectSync();
      window.removeEventListener(SYNC_EVENT, onSynced);
      window.removeEventListener(FORMS_UPDATED_EVENT, onForms);
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

  const resetForm = () => {
    setForm(freshForm(catalog));
    setProblems({});
  };

  const handleChange = (values) => {
    // A field the worker has just changed no longer shows the problem it had;
    // the rest stay until the next save attempt re-checks them.
    setProblems((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([key]) => values[key] === form.values[key])
      )
    );
    setForm((current) => ({ ...current, values }));
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    const { definition, editingId, values } = form;
    if (!definition) return;

    // Checked here, on the phone, so a mistake is fixed at the household rather
    // than refused by the server at the next sync. The server checks again.
    const payload = toPayload(definition, values);
    const found = checkAnswers(definition, payload);
    setProblems(found);
    if (Object.keys(found).length > 0) return;

    return run(async () => {
      if (editingId) {
        // The record keeps its form version: updateRecord changes the payload
        // only, and the payload was built from that same version's fields.
        await updateRecord(editingId, payload);
      } else {
        await createRecord({
          formType: definition.formType,
          formVersion: definition.version,
          payload,
        });
      }
      resetForm();
    });
  };

  const handleEdit = (record) => {
    const choice = chooseDefinition({ catalog, record });
    if (choice.missing) {
      // Said rather than guessed at: opening a version-3 record with another
      // version's fields would drop or mislabel what the worker recorded.
      setFormNotice(
        `This record was captured with form version ${choice.missing.version}, which is not ` +
          "on this phone yet. Sync while online to download it, then edit the record."
      );
      return;
    }
    setFormNotice(null);
    setProblems({});
    setForm({
      definition: choice.definition,
      values: toFormValues(choice.definition, record.payload),
      editingId: record.id,
      builtin: choice.builtin,
    });
  };

  const handleDelete = (record) =>
    run(async () => {
      await softDeleteRecord(record.id);
      if (form.editingId === record.id) resetForm();
    });

  const handleCancel = () => {
    setFormNotice(null);
    resetForm();
  };

  // Confirmed, because on a kept_server resolution this is the last copy of the
  // worker's own answers ON THIS PHONE. It is not the last copy anywhere — the
  // pushed payload stays in record_conflicts on the server, which resolution
  // never deletes — and the wording says exactly that rather than implying a
  // destruction that is not happening, or a safety that is not there.
  const handleDismissNotice = (record) => {
    const notice = record.resolvedNotice;
    const keepsSomething = Boolean(notice?.discardedPayload || notice?.supersededPayload);
    if (
      keepsSomething &&
      !window.confirm(
        "This removes the earlier version of these answers from this phone. " +
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
      <h2>{form.definition?.title ?? "Household survey"}</h2>

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
      {formNotice && <p style={styles.notice("warn")}>{formNotice}</p>}

      {form.definition ? (
        <>
          <p style={styles.muted}>{formCaption(form)}</p>
          <SurveyForm
            form={form}
            problems={problems}
            onChange={handleChange}
            onSubmit={handleSubmit}
            onCancel={handleCancel}
            busy={busy}
          />
        </>
      ) : (
        <p style={styles.muted}>Loading the form…</p>
      )}

      <h3>{listHeading(user, records.length)}</h3>
      {records.length === 0 ? (
        <p style={styles.muted}>Nothing captured yet.</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0 }}>
          {records.map((record) => (
            <RecordRow
              key={record.id}
              record={record}
              user={user}
              catalog={catalog}
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
