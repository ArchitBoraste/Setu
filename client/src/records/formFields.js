// Human labels for the household survey's fields.
//
// Lifted out of CaptureScreen.jsx because the supervisor's conflict screen needs
// the same ones: a supervisor deciding between two versions of a household's
// answers should read "Children under five", not "childrenUnderFive", and two
// copies of this map would drift the moment a field is renamed in one of them.
//
// A stand-in for the form builder's registry, like FORM_FIELD_TYPES on the
// server. When that lands, both screens read labels from the form definition
// that produced the payload — which is the only way to label a record captured
// under an older form revision correctly.
export const FIELD_LABELS = {
  householdName: "Household name",
  memberCount: "Members",
  childrenUnderFive: "Children under five",
  visitDate: "Visit date",
  waterSource: "Water source",
  notes: "Notes",
};

/** A field nobody answered is "—", never an empty cell that reads as a bug. */
export function showValue(value) {
  return value === null || value === undefined || value === "" ? "—" : String(value);
}
