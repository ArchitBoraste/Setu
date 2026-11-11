import { Fragment } from "react";
import { differingFields } from "../lib/payload.js";
import { describeFields, formatValue } from "../forms/formRules.js";

// Two payloads side by side, with the fields that actually differ tinted.
//
// Lifted out of CaptureScreen.jsx because the same question — "what is
// different between these two?" — is now asked in four places: a worker's
// conflict view, a worker's resolution notice, a supervisor's replacement
// preview, and a supervisor's record of what a past decision replaced. Four
// slightly different answers to one question is how four answers start to
// disagree.
//
// Labels and value formatting come from the definitions of the form versions
// the two payloads were captured under, so a record from version 1 reads with
// version 1's labels, and a yes/no reads "Yes", not "true". A key neither
// definition declares (a version this device does not have) is shown by name.
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
 * @param {object}   props.left          a payload
 * @param {object}   props.right         a payload
 * @param {Array}    [props.definitions] the definitions to label by, in order of
 *                                       preference (left's, then right's); nulls
 *                                       are allowed for a version not on this device
 * @param {Array}    [props.extraRows]   [label, leftCell, rightCell] rows, untinted
 */
export default function CompareGrid({
  leftLabel,
  rightLabel,
  left,
  right,
  definitions = [],
  extraRows = [],
}) {
  const rows = describeFields([left, right], definitions);
  const differs = differingFields(left, right);

  return (
    <div style={styles.grid}>
      <span style={styles.head} />
      <span style={styles.head}>{leftLabel}</span>
      <span style={styles.head}>{rightLabel}</span>

      {rows.map(({ key, label, field }) => {
        const tint = differs.has(key) ? styles.differs : undefined;
        return (
          <Fragment key={key}>
            <span style={styles.label}>{label}</span>
            <span style={tint}>{formatValue(field, left?.[key] ?? null)}</span>
            <span style={tint}>{formatValue(field, right?.[key] ?? null)}</span>
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
