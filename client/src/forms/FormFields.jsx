// The inputs for one form definition, drawn from its fields.
//
// Used by the capture screen and by the admin's live preview, so what an admin
// sees while building a version is exactly what a worker will be shown. Values
// are the strings forms/formRules.js keeps (see toFormValues); turning them into
// a payload, and checking it, is the caller's job.

const styles = {
  label: { display: "block", marginBottom: "0.75rem" },
  field: { display: "block", width: "100%", padding: "0.4rem", marginTop: 2, boxSizing: "border-box" },
  required: { color: "crimson" },
  problem: { display: "block", color: "crimson", fontSize: 13, marginTop: 2 },
};

function Control({ field, value, onChange, disabled, invalid }) {
  const common = {
    style: styles.field,
    value,
    disabled,
    onChange: (event) => onChange(event.target.value),
    "aria-invalid": invalid || undefined,
  };

  switch (field.type) {
    case "text":
      return field.multiline ? (
        <textarea {...common} rows={3} maxLength={field.maxLength} />
      ) : (
        <input {...common} maxLength={field.maxLength} />
      );
    case "number":
      // The attributes are hints for the keypad and the spinner. The rules
      // themselves are checked by checkAnswers, so a worker gets the same
      // message whatever the browser does with them.
      return (
        <input
          {...common}
          type="number"
          inputMode={field.integer ? "numeric" : "decimal"}
          min={field.min}
          max={field.max}
          step={field.integer ? 1 : "any"}
        />
      );
    case "date":
      return <input {...common} type="date" />;
    case "select":
      return (
        <select {...common}>
          <option value="">Select…</option>
          {field.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      );
    case "yesno":
      // A select rather than two radio buttons: it can say "not answered", and
      // an optional yes/no must be able to go back to that.
      return (
        <select {...common}>
          <option value="">Select…</option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </select>
      );
    default:
      return <input {...common} disabled />;
  }
}

/**
 * @param {object}   props
 * @param {object}   props.definition  { fields }
 * @param {object}   props.values      key -> string
 * @param {Function} props.onChange    (nextValues) => void
 * @param {object}   [props.problems]  key -> message, shown under the field
 * @param {boolean}  [props.disabled]
 */
export default function FormFields({ definition, values, onChange, problems = {}, disabled = false }) {
  return definition.fields.map((field) => {
    const problem = problems[field.key];
    return (
      <label key={field.key} style={styles.label}>
        {field.label}
        {field.required && (
          <span style={styles.required} aria-label="required">
            {" "}
            *
          </span>
        )}
        <Control
          field={field}
          value={values?.[field.key] ?? ""}
          onChange={(next) => onChange({ ...values, [field.key]: next })}
          disabled={disabled}
          invalid={Boolean(problem)}
        />
        {problem && (
          <span role="alert" style={styles.problem}>
            {problem}
          </span>
        )}
      </label>
    );
  });
}
