import { Fragment } from "react";
import { differingFields, unionFields } from "../lib/payload.js";
import { FIELD_LABELS, showValue } from "../records/formFields.js";

// Two payloads side by side, with the fields that actually differ tinted.
//
// Lifted out of CaptureScreen.jsx because the same question — "what is
// different between these two?" — is now asked in four places: a worker's
// conflict view, a worker's resolution notice, a supervisor's replacement
// preview, and a supervisor's record of what a past decision replaced. Four
// slightly different answers to one question is how four answers start to
// disagree.
//
// The tinting is not decoration. Nobody diffs twenty identical fields by eye,
// and a worker or supervisor who cannot find the disagreement will either
// assume a visit was lost or keep the wrong version.

const styles = {
  grid: {
    display: "grid",
    gridTemplateColumns: "10rem 1fr 1fr",
    gap: "0.25rem 0.75rem",
    fontSize: 13,
    marginTop: "0.5rem",
    padding: "0.5rem",
    background: "#fafafa",
    border: "1px solid #eee",
  },
  head: { fontWeight: 600 },
  label: { color: "#666", fontSize: 14 },
  differs: { background: "#fff1f2" },
};

/**
 * @param {object}   props
 * @param {string}   props.leftLabel
 * @param {string}   props.rightLabel
 * @param {object}   props.left        a payload
 * @param {object}   props.right       a payload
 * @param {Array}    [props.extraRows] [label, leftCell, rightCell] rows, untinted
 */
export default function CompareGrid({ leftLabel, rightLabel, left, right, extraRows = [] }) {
  const fields = unionFields(left, right);
  const differs = differingFields(left, right);

  return (
    <div style={styles.grid}>
      <span style={styles.head} />
      <span style={styles.head}>{leftLabel}</span>
      <span style={styles.head}>{rightLabel}</span>

      {fields.map((field) => {
        const tint = differs.has(field) ? styles.differs : undefined;
        return (
          <Fragment key={field}>
            <span style={styles.label}>{FIELD_LABELS[field] ?? field}</span>
            <span style={tint}>{showValue(left?.[field] ?? null)}</span>
            <span style={tint}>{showValue(right?.[field] ?? null)}</span>
          </Fragment>
        );
      })}

      {extraRows.map(([label, a, b]) => (
        <Fragment key={label}>
          <span style={styles.label}>{label}</span>
          <span>{a}</span>
          <span>{b}</span>
        </Fragment>
      ))}
    </div>
  );
}
