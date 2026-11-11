import { useEffect, useState } from "react";
import { getCachedUser } from "../auth/authService.js";
import { FORMS_UPDATED_EVENT, loadCatalog } from "./formStore.js";

/**
 * The published forms on this device for the signed-in user's organisation,
 * re-read whenever a refresh stores new ones. Reads IndexedDB only.
 *
 * State is set from the promise callbacks, never in the effect body, like the
 * other screens' loaders.
 */
export function useFormCatalog() {
  const [catalog, setCatalog] = useState([]);

  useEffect(() => {
    let cancelled = false;
    const read = () => {
      getCachedUser()
        .then((user) => loadCatalog(user?.organizationId))
        .then((rows) => {
          if (!cancelled) setCatalog(rows);
        })
        // An unreadable store leaves labels falling back to field keys, which
        // is still a usable screen; nothing here is worth an error banner.
        .catch(() => {});
    };

    read();
    window.addEventListener(FORMS_UPDATED_EVENT, read);
    return () => {
      cancelled = true;
      window.removeEventListener(FORMS_UPDATED_EVENT, read);
    };
  }, []);

  return catalog;
}
