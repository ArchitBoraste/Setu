import { ApiError, NetworkError, NotAuthenticatedError } from "../lib/api.js";

// What the admin panels share: their look, and how a failed request is told to
// the admin. In a plain module rather than AdminScreen.jsx so the forms panel
// can use the same words without importing one component file from another.

export const styles = {
  section: { marginTop: "2rem", borderTop: "1px solid #ddd", paddingTop: "1rem" },
  muted: { color: "#666", fontSize: 14 },
  tabs: { display: "flex", gap: "0.5rem", margin: "0.5rem 0" },
  card: {
    border: "1px solid #ddd",
    borderRadius: 4,
    padding: "0.75rem",
    marginBottom: "0.75rem",
  },
  inactive: { opacity: 0.6 },
  form: {
    border: "1px solid #ddd",
    borderRadius: 4,
    padding: "0.75rem",
    margin: "0.5rem 0 1rem",
  },
  label: { display: "block", marginBottom: "0.5rem", fontSize: 14 },
  field: { display: "block", width: "100%", padding: "0.4rem", marginTop: 2, boxSizing: "border-box" },
  row: { display: "flex", gap: "0.5rem", flexWrap: "wrap", marginTop: "0.5rem" },
  notice: (tone) => ({
    padding: "0.5rem 0.75rem",
    borderRadius: 4,
    fontSize: 14,
    border: `1px solid ${tone === "warn" ? "#b45309" : "#15803d"}`,
    background: tone === "warn" ? "#fffbeb" : "#f0fdf4",
    color: "#111",
  }),
  confirm: {
    marginTop: "0.5rem",
    padding: "0.5rem 0.75rem",
    border: "1px solid #b91c1c",
    borderRadius: 4,
    background: "#fef2f2",
    color: "#111",
    fontSize: 14,
  },
};

export const OFFLINE_MESSAGE = "Admin needs an internet connection.";

// What the admin is told when a request fails. The server's own sentence when
// it gave one — those are written for this screen (server/admin/adminRules.js,
// server/forms/formRules.js).
export function describe(error) {
  if (error instanceof NetworkError) {
    // Not "nothing was changed": a request that timed out may have landed. The
    // honest answer is to look again once there is a connection.
    return `${OFFLINE_MESSAGE} Could not reach the server — reload once you are connected to see whether the change was saved.`;
  }
  if (error instanceof NotAuthenticatedError) {
    return "This device has no session with the server. Sign out and sign in again while you have a connection.";
  }
  if (error instanceof ApiError && error.status === 403) {
    return "Only an admin can do this. If your role was changed, sign out and sign in again.";
  }
  return error.message;
}
