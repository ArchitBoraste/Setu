import express from "express";
import { pool } from "../db/index.js";
import { loadArea, requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { SERVER_TIME_FORMAT } from "../sync/serverTime.js";

// The forms a device captures with: every PUBLISHED definition of the caller's
// organisation, sent whole.
//
// Whole, not as a delta, because the set is small (a form is a few KB, and an
// organisation has a handful of versions) and published rows never change, so
// there is nothing a cursor would save. A device calls this at sign-in and at
// the start of every sync, and keeps the answer in IndexedDB so capture works
// offline with the last forms it saw.
//
// Any signed-in user, field workers included: every role captures. loadArea
// refuses a deactivated account on this request, the same as sync does.
// Drafts never leave the server through here.

const router = express.Router();

router.get(
  "/",
  requireAuth,
  loadArea,
  asyncHandler(async (req, res) => {
    // organization_id is not sent: the device belongs to exactly one, and
    // tags what it stores with the organisation of whoever asked.
    const [rows] = await pool.query(
      `SELECT id,
              form_type AS formType,
              version,
              title,
              fields,
              DATE_FORMAT(published_at, '${SERVER_TIME_FORMAT}') AS publishedAt
         FROM form_definitions
        WHERE organization_id = ? AND status = 'published'
        ORDER BY form_type ASC, version ASC`,
      [req.user.organizationId]
    );
    res.json({ forms: rows });
  })
);

export default router;
