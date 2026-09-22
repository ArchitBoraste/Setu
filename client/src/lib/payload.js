// Comparing two versions of the same answers, field by field.
//
// A shallow comparison is EXACT here, not an approximation, and that is worth
// stating because it looks like a shortcut. Payload values are null, a finite
// number, or a string — nothing else. That rule is applied at capture (see
// createRecord in records/recordService.js) and enforced again on the server
// (validatePayload in sync/pushRules.js), which rejects a boolean, an object or
// an array outright. So there is nothing nested to recurse into, and `!==` over
// the union of both key sets answers the question completely.
//
// If that rule ever changes, this file is one of the places that has to change
// with it — which is exactly why the constraint is written down here rather than
// assumed.

/** Every field named by either version, in a stable order. */
export function unionFields(...payloads) {
  const seen = new Set();
  for (const payload of payloads) {
    for (const key of Object.keys(payload ?? {})) seen.add(key);
  }
  return [...seen];
}

/**
 * A missing key and an explicit null are the same fact: nobody answered. Folding
 * them together stops "this field is absent in the older form revision" from
 * being reported as a disagreement a supervisor has to adjudicate.
 */
function valueOf(payload, field) {
  return payload?.[field] ?? null;
}

/** The fields the two versions actually disagree about. */
export function differingFields(a, b) {
  return new Set(
    unionFields(a, b).filter((field) => valueOf(a, field) !== valueOf(b, field))
  );
}

export function samePayload(a, b) {
  return differingFields(a, b).size === 0;
}
