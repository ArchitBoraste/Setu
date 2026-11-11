// The form builder's working copy of a draft, and the conversions between it
// and what the server stores. Pure, so the shapes are tested without React.
//
// The working copy differs from a definition in three ways:
//
//   uid       every field has one, minted here, so a card keeps its identity
//             (and its error messages) while it is moved, renamed or retyped.
//   strings   numbers and options are held as typed — "", "0", "Piped\nWell" —
//             and converted only when sent, so a half-typed "-" is not lost.
//   fixed     a key some published version already uses. Its key cannot be
//             edited and its type cannot change (the server's key-stability
//             rule); the builder says so instead of letting the admin find out
//             at publish.
//
// The server is the judge of every rule. Nothing here validates beyond what is
// needed to draw the card.

// Card ids only need to be unique on this page, for as long as it is open.
// A counter, not a UUID: nothing stores them, and the module stays free of
// browser APIs so it can be tested in Node.
let lastUid = 0;
const mintUid = () => `field-${(lastUid += 1)}`;

export const FIELD_TYPE_LABELS = {
  text: "Text",
  number: "Number",
  date: "Date",
  select: "Choice (one of a list)",
  yesno: "Yes / no",
};

/**
 * Every key the published versions of a form use, with its type and the
 * latest version that used it. A removed key is still here: it may only come
 * back with the type it had.
 */
export function publishedKeyTypes(definitions, formType) {
  const keys = new Map();
  const published = definitions
    .filter((def) => def.formType === formType && def.status === "published")
    .sort((a, b) => a.version - b.version);
  for (const def of published) {
    for (const field of def.fields) keys.set(field.key, { type: field.type, version: def.version });
  }
  return keys;
}

const asText = (value) => (value === null || value === undefined ? "" : String(value));

export function toEditorField(field, keyTypes, uid = mintUid()) {
  return {
    uid,
    key: field.key ?? "",
    // A key that came with the field was chosen on purpose; only a new field's
    // key follows its label.
    keyTouched: Boolean(field.key),
    fixed: keyTypes.has(field.key),
    label: field.label ?? "",
    type: field.type ?? "text",
    required: field.required === true,
    min: asText(field.min),
    max: asText(field.max),
    integer: field.integer === true,
    options: (field.options ?? []).join("\n"),
    maxLength: asText(field.maxLength),
    multiline: field.multiline === true,
  };
}

export function newEditorField(uid = mintUid()) {
  return toEditorField({ type: "text", required: false }, new Map(), uid);
}

/** A draft as the builder edits it. */
export function toEditor(draft, keyTypes) {
  return {
    id: draft.id,
    formType: draft.formType,
    version: draft.version,
    title: draft.title,
    fields: draft.fields.map((field) => toEditorField(field, keyTypes)),
  };
}

/**
 * A key from a label: "Follow-up needed" -> "followUpNeeded". Only a starting
 * point for a new field; the admin can change it until the version is
 * published, after which it is permanent.
 */
export function suggestKey(label) {
  const words = String(label)
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  if (words.length === 0) return "";
  const key = words
    .map((word, i) =>
      i === 0 ? word.toLowerCase() : word[0].toUpperCase() + word.slice(1).toLowerCase()
    )
    .join("");
  // A key must start with a letter; "5 year plan" becomes "f5YearPlan".
  return (/^[a-z]/.test(key) ? key : `f${key}`).slice(0, 64);
}

// "" is "not set". Anything else is sent as a number when it is one, and as
// the text typed when it is not, so the server can say what is wrong with it.
function numberOrRaw(text) {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const number = Number(trimmed);
  return Number.isFinite(number) ? number : trimmed;
}

/** One card as a definition field: only the properties its type has. */
export function toDefinitionField(field) {
  const out = { key: field.key.trim(), label: field.label, type: field.type, required: field.required };
  if (field.type === "number") {
    out.min = numberOrRaw(field.min);
    out.max = numberOrRaw(field.max);
    out.integer = field.integer;
  }
  if (field.type === "select") {
    out.options = field.options
      .split("\n")
      .map((option) => option.trim())
      .filter((option) => option !== "");
  }
  if (field.type === "text") {
    out.maxLength = numberOrRaw(field.maxLength);
    out.multiline = field.multiline;
  }
  return out;
}

/** What PUT /api/admin/forms/drafts/:id is sent. */
export function toDefinitionBody(editor) {
  return { title: editor.title, fields: editor.fields.map(toDefinitionField) };
}

/**
 * The draft as the live preview draws it. Keyed by uid, not by key, so two
 * cards that momentarily share a key (or have none) are still two inputs.
 */
export function toPreviewDefinition(editor) {
  return {
    fields: editor.fields.map((field) => {
      const def = toDefinitionField(field);
      return {
        ...def,
        key: field.uid,
        label: def.label.trim() || "(no label yet)",
        min: typeof def.min === "number" ? def.min : undefined,
        max: typeof def.max === "number" ? def.max : undefined,
        maxLength: typeof def.maxLength === "number" ? def.maxLength : undefined,
        options: def.options ?? [],
      };
    }),
  };
}

/**
 * The server's errors, filed where the builder draws them. Each error names
 * the position of the field in the list that was SENT; `sentUids` is that
 * list's uids, so an error stays on its card even if the admin has since
 * moved it.
 *
 * @returns {{ form: string[], byUid: Record<string, string[]> }}
 */
export function fileServerErrors(errors, sentUids) {
  const filed = { form: [], byUid: {} };
  for (const error of errors ?? []) {
    const uid = Number.isInteger(error.index) ? sentUids[error.index] : null;
    if (uid) (filed.byUid[uid] ??= []).push(error.message);
    else filed.form.push(error.message);
  }
  return filed;
}

/** The list with one field moved up (-1) or down (+1); unchanged at an end. */
export function moveField(fields, index, delta) {
  const target = index + delta;
  if (target < 0 || target >= fields.length) return fields;
  const next = [...fields];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}
