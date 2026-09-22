import { useCallback, useEffect, useState } from "react";
import {
  SYNC_STATE,
  countPendingRecords,
  createRecord,
  listRecords,
  softDeleteRecord,
  updateRecord,
} from "./recordService.js";

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
    background:
      state === SYNC_STATE.SYNCED
        ? "seagreen"
        : state === SYNC_STATE.CONFLICT
          ? "crimson"
          : "#b45309",
  }),
  error: { color: "crimson" },
  muted: { color: "#666", fontSize: 14 },
};

// Reads only; the caller decides what to do with the result. Keeping state out
// of here is what lets the mount effect use it without setting state mid-render.
async function loadRecords() {
  const [rows, pendingCount] = await Promise.all([
    listRecords(),
    countPendingRecords(),
  ]);
  return { rows, pendingCount };
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

function RecordRow({ record, onEdit, onDelete, busy }) {
  return (
    <li style={styles.row}>
      <span style={styles.badge(record.syncState)}>{record.syncState}</span>{" "}
      {summarise(record)}{" "}
      <span style={styles.muted}>v{record.version}</span>
      <br />
      <button onClick={() => onEdit(record)} disabled={busy}>
        Edit
      </button>{" "}
      <button onClick={() => onDelete(record)} disabled={busy}>
        Delete
      </button>
    </li>
  );
}

export default function CaptureScreen() {
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState(null);
  const [records, setRecords] = useState([]);
  const [pending, setPending] = useState(0);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const { rows, pendingCount } = await loadRecords();
    setRecords(rows);
    setPending(pendingCount);
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadRecords()
      .then(({ rows, pendingCount }) => {
        if (cancelled) return;
        setRecords(rows);
        setPending(pendingCount);
      })
      .catch((err) => {
        if (!cancelled) setError(`Could not read local records: ${err.message}`);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Every mutation follows the same shape: write to Dexie, then re-read. The
  // write itself never touches the network, so this stays instant offline.
  async function run(action) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

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

  return (
    <div style={styles.section}>
      <h2>Household survey</h2>
      <p style={styles.muted}>
        Saved on this device · <strong>{pending}</strong> waiting to sync
      </p>

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
              busy={busy}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
