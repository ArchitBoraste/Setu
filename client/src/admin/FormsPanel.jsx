import { useCallback, useEffect, useState } from "react";
import { ApiError } from "../lib/api.js";
import { shortTime } from "../lib/time.js";
import FormFields from "../forms/FormFields.jsx";
import { checkAnswers, toPayload } from "../forms/formRules.js";
import {
  createFormDraft,
  deleteFormDraft,
  listFormDefinitions,
  publishFormDraft,
  saveFormDraft,
} from "./adminService.js";
import { describe, styles } from "./adminUi.js";
import {
  FIELD_TYPE_LABELS,
  fileServerErrors,
  moveField,
  newEditorField,
  publishedKeyTypes,
  suggestKey,
  toDefinitionBody,
  toEditor,
  toPreviewDefinition,
} from "./formBuilder.js";

// Admin → Forms: every form, its published versions, and the one draft being
// built. Online-only like the rest of admin, and mounted only while online, so
// a draft's unsaved changes do not survive the connection dropping — the
// screen says so beside Save.
//
// The server decides every rule (server/forms/formRules.js). This screen
// shows its answers next to the field each one concerns, and locks only what
// can never be allowed: changing the key or type of a field an earlier version
// published.

const local = {
  fieldCard: {
    border: "1px solid #ddd",
    borderRadius: 4,
    padding: "0.5rem 0.75rem",
    marginBottom: "0.5rem",
    background: "#fcfcfc",
  },
  fieldCardError: { borderColor: "#b91c1c" },
  problem: { color: "#b91c1c", fontSize: 13, margin: "0.25rem 0 0" },
  inline: { display: "flex", gap: "0.75rem", flexWrap: "wrap", alignItems: "center", fontSize: 14 },
  preview: {
    border: "1px dashed #999",
    borderRadius: 4,
    padding: "0.75rem",
    marginTop: "0.75rem",
    background: "#fff",
  },
  code: { fontFamily: "monospace", fontSize: 13 },
};

const NO_ERRORS = { form: [], byUid: {} };

/** A field's rules in a few words, for the read-only list of a version. */
function describeRules(field) {
  const parts = [FIELD_TYPE_LABELS[field.type] ?? field.type];
  if (field.required) parts.push("required");
  if (field.type === "number") {
    if (field.integer) parts.push("whole number");
    if (field.min !== undefined && field.max !== undefined) parts.push(`${field.min} to ${field.max}`);
    else if (field.min !== undefined) parts.push(`at least ${field.min}`);
    else if (field.max !== undefined) parts.push(`at most ${field.max}`);
  }
  if (field.type === "select") parts.push(field.options.join(" / "));
  if (field.type === "text") {
    if (field.maxLength !== undefined) parts.push(`at most ${field.maxLength} characters`);
    if (field.multiline) parts.push("several lines");
  }
  return parts.join(" · ");
}

function VersionFields({ definition }) {
  return (
    <ol style={{ margin: "0.5rem 0 0", paddingLeft: "1.25rem", fontSize: 14 }}>
      {definition.fields.map((field) => (
        <li key={field.key}>
          {field.label} <span style={local.code}>({field.key})</span>{" "}
          <span style={styles.muted}>— {describeRules(field)}</span>
        </li>
      ))}
    </ol>
  );
}

function FieldCard({ field, index, count, keyTypes, problems, busy, onChange, onMove, onRemove }) {
  const set = (patch) => onChange({ ...field, ...patch });
  const earlier = keyTypes.get(field.key.trim());
  // A key typed by hand that an earlier version used: it may only come back
  // with the type it had. Said here, before Save, rather than as a refusal.
  const returning = !field.fixed && earlier;

  return (
    <li style={{ ...local.fieldCard, ...(problems ? local.fieldCardError : {}) }}>
      <div style={{ ...local.inline, justifyContent: "space-between" }}>
        <strong>Question {index + 1}</strong>
        <span style={local.inline}>
          <button type="button" onClick={() => onMove(-1)} disabled={busy || index === 0}>
            Move up
          </button>
          <button type="button" onClick={() => onMove(1)} disabled={busy || index === count - 1}>
            Move down
          </button>
          <button type="button" onClick={onRemove} disabled={busy || count === 1}>
            Remove
          </button>
        </span>
      </div>

      <label style={styles.label}>
        Label (what the worker reads)
        <input
          style={styles.field}
          value={field.label}
          onChange={(event) => {
            const label = event.target.value;
            set(field.keyTouched || field.fixed ? { label } : { label, key: suggestKey(label) });
          }}
        />
      </label>

      {field.fixed ? (
        <p style={styles.muted}>
          Key <span style={local.code}>{field.key}</span> — fixed: earlier versions
          use it, so its key and type stay as they are.
        </p>
      ) : (
        <label style={styles.label}>
          Key (stored with every answer; cannot change once published)
          <input
            style={{ ...styles.field, ...local.code }}
            value={field.key}
            onChange={(event) => set({ key: event.target.value, keyTouched: true })}
          />
        </label>
      )}
      {returning && (
        <p style={styles.muted}>
          Version {earlier.version} used this key for a {FIELD_TYPE_LABELS[earlier.type]} field.
          It can only come back as one.
        </p>
      )}

      <div style={local.inline}>
        <label>
          Type{" "}
          <select
            value={field.type}
            disabled={field.fixed}
            onChange={(event) => set({ type: event.target.value })}
          >
            {Object.entries(FIELD_TYPE_LABELS).map(([type, label]) => (
              <option key={type} value={type}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={field.required}
            onChange={(event) => set({ required: event.target.checked })}
          />{" "}
          Required
        </label>
      </div>

      {field.type === "number" && (
        <div style={{ ...local.inline, marginTop: "0.5rem" }}>
          <label>
            Minimum{" "}
            <input
              size={6}
              inputMode="decimal"
              value={field.min}
              onChange={(event) => set({ min: event.target.value })}
            />
          </label>
          <label>
            Maximum{" "}
            <input
              size={6}
              inputMode="decimal"
              value={field.max}
              onChange={(event) => set({ max: event.target.value })}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={field.integer}
              onChange={(event) => set({ integer: event.target.checked })}
            />{" "}
            Whole numbers only
          </label>
        </div>
      )}

      {field.type === "select" && (
        <label style={{ ...styles.label, marginTop: "0.5rem" }}>
          Options, one per line
          <textarea
            style={styles.field}
            rows={4}
            value={field.options}
            onChange={(event) => set({ options: event.target.value })}
          />
        </label>
      )}

      {field.type === "text" && (
        <div style={{ ...local.inline, marginTop: "0.5rem" }}>
          <label>
            Maximum length{" "}
            <input
              size={6}
              inputMode="numeric"
              value={field.maxLength}
              onChange={(event) => set({ maxLength: event.target.value })}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={field.multiline}
              onChange={(event) => set({ multiline: event.target.checked })}
            />{" "}
            Several lines
          </label>
        </div>
      )}

      {problems?.map((message) => (
        <p key={message} role="alert" style={local.problem}>
          {message}
        </p>
      ))}
    </li>
  );
}

/**
 * The draft as a worker will see it, live, with a button that applies the
 * same checks a worker's Save does. Nothing typed here is stored.
 */
function Preview({ editor }) {
  const definition = toPreviewDefinition(editor);
  const [values, setValues] = useState({});
  const [problems, setProblems] = useState(null);

  return (
    <div style={local.preview}>
      <strong>Preview — {editor.title || "(no title)"}</strong>
      <p style={styles.muted}>
        What a worker sees for version {editor.version}. Try it, then check the answers.
      </p>
      <FormFields
        definition={definition}
        values={values}
        problems={problems ?? {}}
        onChange={(next) => {
          setValues(next);
          setProblems(null);
        }}
      />
      <div style={styles.row}>
        <button
          type="button"
          onClick={() => setProblems(checkAnswers(definition, toPayload(definition, values)))}
        >
          Check answers
        </button>
        <button
          type="button"
          onClick={() => {
            setValues({});
            setProblems(null);
          }}
        >
          Clear
        </button>
      </div>
      {problems && Object.keys(problems).length === 0 && (
        <p role="status" style={styles.muted}>
          These answers would be accepted.
        </p>
      )}
    </div>
  );
}

function DraftEditor({
  editor,
  keyTypes,
  errors,
  dirty,
  busy,
  onChange,
  onSave,
  onPublish,
  onDelete,
  onClose,
}) {
  // One confirmation open at a time: "publish", "delete", or null.
  const [confirming, setConfirming] = useState(null);
  const setFields = (fields) => onChange({ ...editor, fields });

  return (
    <div style={styles.form}>
      <strong>
        Draft of version {editor.version} · <span style={local.code}>{editor.formType}</span>
      </strong>

      <label style={{ ...styles.label, marginTop: "0.5rem" }}>
        Title
        <input
          style={styles.field}
          value={editor.title}
          onChange={(event) => onChange({ ...editor, title: event.target.value })}
        />
      </label>

      {errors.form.map((message) => (
        <p key={message} role="alert" style={local.problem}>
          {message}
        </p>
      ))}

      <ol style={{ listStyle: "none", padding: 0 }}>
        {editor.fields.map((field, index) => (
          <FieldCard
            key={field.uid}
            field={field}
            index={index}
            count={editor.fields.length}
            keyTypes={keyTypes}
            problems={errors.byUid[field.uid]}
            busy={busy}
            onChange={(next) => setFields(editor.fields.map((f) => (f.uid === field.uid ? next : f)))}
            onMove={(delta) => setFields(moveField(editor.fields, index, delta))}
            onRemove={() => setFields(editor.fields.filter((f) => f.uid !== field.uid))}
          />
        ))}
      </ol>
      <button type="button" onClick={() => setFields([...editor.fields, newEditorField()])} disabled={busy}>
        Add a question
      </button>

      <Preview editor={editor} />

      <div style={styles.row}>
        <button type="button" onClick={onSave} disabled={busy || !dirty}>
          {busy ? "Saving…" : dirty ? "Save draft" : "Saved"}
        </button>
        <button type="button" onClick={() => setConfirming("publish")} disabled={busy}>
          Publish…
        </button>
        <button type="button" onClick={() => setConfirming("delete")} disabled={busy}>
          Delete draft…
        </button>
        <button type="button" onClick={onClose} disabled={busy}>
          Close
        </button>
      </div>
      {dirty && (
        <p style={styles.muted}>
          Unsaved changes. They are lost if you close this or the connection drops.
        </p>
      )}

      {confirming === "publish" && (
        // Inline, not window.confirm(), for RemoveAccountPanel's reasons: the
        // consequence needs saying, and a browser dialog is dismissed by reflex.
        <div style={styles.confirm}>
          <p style={{ margin: 0 }}>
            Publish this as <strong>version {editor.version}</strong>? Every device gets it on
            its next sync, and new records use it from then on. Records already captured keep
            their own version. A published version can never be changed or deleted
            {dirty ? "; your unsaved changes are saved first." : "."}
          </p>
          <div style={styles.row}>
            <button
              type="button"
              onClick={async () => {
                if (await onPublish()) setConfirming(null);
              }}
              disabled={busy}
            >
              {busy ? "Publishing…" : `Publish version ${editor.version}`}
            </button>
            <button type="button" onClick={() => setConfirming(null)} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {confirming === "delete" && (
        <div style={styles.confirm}>
          <p style={{ margin: 0 }}>
            Delete this draft? It has never reached a device, so no records are affected.
          </p>
          <div style={styles.row}>
            <button type="button" onClick={onDelete} disabled={busy}>
              Delete draft
            </button>
            <button type="button" onClick={() => setConfirming(null)} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function FormTypeCard({ formType, versions, busy, viewing, onView, onNewVersion, onEdit }) {
  const published = versions.filter((def) => def.status === "published");
  const draft = versions.find((def) => def.status === "draft");
  const latest = published[published.length - 1];

  return (
    <li style={styles.card}>
      <strong>{latest?.title ?? draft?.title ?? formType}</strong>{" "}
      <span style={{ ...styles.muted, ...local.code }}>{formType}</span>
      <ul style={{ listStyle: "none", padding: 0, margin: "0.5rem 0 0" }}>
        {published.map((def) => (
          <li key={def.id} style={{ marginBottom: "0.25rem" }}>
            Version {def.version}
            {def === latest && " (used for new records)"}{" "}
            <span style={styles.muted}>
              · {def.fields.length} questions · published {shortTime(def.publishedAt) ?? "—"} ·{" "}
              {def.createdByName ?? "built into the app"}
            </span>{" "}
            <button type="button" onClick={() => onView(def.id)}>
              {viewing === def.id ? "Hide" : "View"}
            </button>
            {viewing === def.id && <VersionFields definition={def} />}
          </li>
        ))}
      </ul>
      <div style={styles.row}>
        {draft ? (
          <button type="button" onClick={() => onEdit(draft)} disabled={busy}>
            Edit draft of version {draft.version}
          </button>
        ) : (
          <button type="button" onClick={() => onNewVersion(formType)} disabled={busy || !latest}>
            New version (copy of version {latest?.version})
          </button>
        )}
      </div>
    </li>
  );
}

export default function FormsPanel() {
  const [definitions, setDefinitions] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [busy, setBusy] = useState(false);
  // The last outcome, for the whole panel: { tone, text }.
  const [notice, setNotice] = useState(null);
  const [viewing, setViewing] = useState(null);
  // The draft being built, or null. See formBuilder.js for its shape.
  const [editor, setEditor] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [errors, setErrors] = useState(NO_ERRORS);
  const [reloadToken, setReloadToken] = useState(0);
  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  // State is set only from the promise callbacks, never in the effect body.
  useEffect(() => {
    let cancelled = false;
    listFormDefinitions()
      .then(({ definitions: rows }) => {
        if (cancelled) return;
        setDefinitions(rows);
        setLoadError(null);
      })
      .catch((error) => {
        if (cancelled) return;
        setDefinitions(null);
        setLoadError(error);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  const keyTypes = editor ? publishedKeyTypes(definitions ?? [], editor.formType) : new Map();

  const openEditor = (draft, rows = definitions ?? []) => {
    setEditor(toEditor(draft, publishedKeyTypes(rows, draft.formType)));
    setDirty(false);
    setErrors(NO_ERRORS);
    setNotice(null);
  };

  const closeEditor = () => {
    setEditor(null);
    setDirty(false);
    setErrors(NO_ERRORS);
  };

  /**
   * Shows a failure: the server's per-field errors on their cards when it gave
   * them (`sentUids` maps its positions back to cards), its sentence otherwise.
   */
  const showFailure = (error, sentUids) => {
    const listed = error instanceof ApiError ? error.body?.errors : null;
    setErrors(Array.isArray(listed) ? fileServerErrors(listed, sentUids) : NO_ERRORS);
    setNotice({ tone: "warn", text: describe(error) });
  };

  const handleNewVersion = async (formType) => {
    setBusy(true);
    setNotice(null);
    try {
      const draft = await createFormDraft(formType);
      openEditor(draft);
      reload();
    } catch (error) {
      setNotice({ tone: "warn", text: describe(error) });
      // A 409 means someone else's draft exists; showing the fresh list lets
      // the admin open it instead.
      reload();
    } finally {
      setBusy(false);
    }
  };

  // Resolves to true when the draft on the server now matches the screen.
  const save = async () => {
    const sentUids = editor.fields.map((field) => field.uid);
    try {
      await saveFormDraft(editor.id, toDefinitionBody(editor));
      setDirty(false);
      setErrors(NO_ERRORS);
      return true;
    } catch (error) {
      showFailure(error, sentUids);
      return false;
    }
  };

  const handleSave = async () => {
    setBusy(true);
    setNotice(null);
    if (await save()) {
      setNotice({ tone: "ok", text: "Draft saved. Publish it when it is ready." });
      reload();
    }
    setBusy(false);
  };

  const handlePublish = async () => {
    setBusy(true);
    setNotice(null);
    try {
      if (dirty && !(await save())) return false;
      // The stored draft now has the screen's order, so the server's positions
      // map onto these cards.
      const sentUids = editor.fields.map((field) => field.uid);
      try {
        const published = await publishFormDraft(editor.id);
        closeEditor();
        setNotice({
          tone: "ok",
          text:
            `Published version ${published.version} of ${published.title}. Devices get it on ` +
            "their next sync, and new records use it from then on.",
        });
        reload();
        return true;
      } catch (error) {
        showFailure(error, sentUids);
        return false;
      }
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    setBusy(true);
    setNotice(null);
    try {
      await deleteFormDraft(editor.id);
      closeEditor();
      setNotice({ tone: "ok", text: "Draft deleted." });
      reload();
    } catch (error) {
      setNotice({ tone: "warn", text: describe(error) });
    } finally {
      setBusy(false);
    }
  };

  if (loadError) {
    return (
      <>
        <p style={styles.notice("warn")}>{describe(loadError)}</p>
        <button onClick={reload}>Try again</button>
      </>
    );
  }
  if (!definitions) return <p style={styles.muted}>Loading…</p>;

  const formTypes = [...new Set(definitions.map((def) => def.formType))];

  return (
    <>
      <p style={styles.muted}>
        Each change to a form is a new version. Records keep the version they were captured
        with, so old records stay readable and editable after a form changes.
      </p>

      {notice && (
        <p role={notice.tone === "warn" ? "alert" : "status"} style={styles.notice(notice.tone)}>
          {notice.text}
        </p>
      )}

      {editor ? (
        <DraftEditor
          editor={editor}
          keyTypes={keyTypes}
          errors={errors}
          dirty={dirty}
          busy={busy}
          onChange={(next) => {
            setEditor(next);
            setDirty(true);
          }}
          onSave={handleSave}
          onPublish={handlePublish}
          onDelete={handleDelete}
          onClose={closeEditor}
        />
      ) : (
        <>
          <div style={styles.row}>
            <button type="button" onClick={reload} disabled={busy}>
              Refresh
            </button>
          </div>
          {formTypes.length === 0 ? (
            <p style={styles.muted}>No forms yet.</p>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, marginTop: "0.5rem" }}>
              {formTypes.map((formType) => (
                <FormTypeCard
                  key={formType}
                  formType={formType}
                  versions={definitions.filter((def) => def.formType === formType)}
                  busy={busy}
                  viewing={viewing}
                  onView={(id) => setViewing((current) => (current === id ? null : id))}
                  onNewVersion={handleNewVersion}
                  onEdit={(draft) => openEditor(draft)}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </>
  );
}
