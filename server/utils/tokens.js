import jwt from "jsonwebtoken";
import crypto from "crypto";
import { pool } from "../db/index.js";
import { config } from "../config/env.js";
import {
  REFRESH_TOKEN_STATE,
  classifyRefreshToken,
  familyIdFor,
  hashRefreshToken,
  refreshExpiresAt,
} from "./refreshTokenRules.js";

// Access token: short-lived, never stored in the DB. The signature IS the proof.
export function signAccessToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      role: user.role,
      org: user.organizationId,
    },
    config.jwt.secret,
    { expiresIn: config.jwt.accessTtl }
  );
}

/**
 * Refresh token: long-lived, stored hashed so a DB leak is useless to an
 * attacker.
 *
 * Without a familyId this is a sign-in, and starts a new family. A rotation
 * passes the family of the token it replaces. Pass `conn` to insert inside the
 * caller's transaction, so a rotation's new token and the old token's
 * revocation commit or vanish together.
 *
 * Returns the raw token, which is never stored and cannot be recovered, and
 * the new row's id, which a rotation records as the old row's replaced_by.
 */
export async function issueRefreshToken(userId, { familyId, conn = pool } = {}) {
  const id = crypto.randomUUID();
  const token = crypto.randomBytes(48).toString("hex");

  await conn.query(
    `INSERT INTO refresh_tokens (id, user_id, family_id, token_hash, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
    [
      id,
      userId,
      familyIdFor(familyId, id),
      hashRefreshToken(token),
      refreshExpiresAt(new Date(), config.jwt.refreshDays),
    ]
  );

  return { id, token };
}

/**
 * Presents a refresh token, in one transaction that locks its row, classifies
 * it (classifyRefreshToken) and acts on that:
 *
 *   valid    mint a successor in the same family and revoke this token,
 *            pointing at the successor. Returns { token, user }: the new raw
 *            token, and the user to sign an access token for.
 *   reused   this token was rotated once already, so two parties are holding
 *            one session's chain and the server cannot tell which one is the
 *            thief. Revoke every token in the family and commit, so neither
 *            party can continue. Returns null.
 *   others   change nothing. Returns null.
 *
 * Reuse has an innocent cause too: a phone that never received the response
 * to its last refresh still holds the token that refresh rotated. That phone
 * would get a 401 either way. Reuse detection only adds revoking a successor
 * nobody received, and a warning in the log, so a warning is not proof of
 * theft on its own.
 */
export async function rotateRefreshToken(token) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    try {
      // Every row with this hash, live or dead. A dead token presented again
      // is exactly what reuse detection looks for, so filtering out revoked
      // rows here would blind it.
      //
      // FOR UPDATE: a second refresh with the same token waits here until this
      // one commits, then reads the row as this one left it: rotated, so
      // REUSED. OF rt: only the token row can change. The user row is read but
      // not locked, so a refresh never holds up an edit to the user.
      //
      // NOW(3) is read in the same statement, so expiry is judged by the
      // database clock, as `expires_at > NOW(3)` judged it before.
      const [[current]] = await conn.query(
        `SELECT rt.id, rt.family_id AS familyId, rt.user_id AS userId,
                rt.expires_at AS expiresAt, rt.revoked_at AS revokedAt,
                rt.replaced_by AS replacedBy,
                (u.is_active = 1 AND u.deleted_at IS NULL) AS userActive,
                u.role, u.organization_id AS organizationId,
                NOW(3) AS serverNow
           FROM refresh_tokens rt
           JOIN users u ON u.id = rt.user_id
          WHERE rt.token_hash = ?
            FOR UPDATE OF rt`,
        [hashRefreshToken(token)]
      );

      const state = classifyRefreshToken(current ?? null, current?.serverNow);

      if (state === REFRESH_TOKEN_STATE.REUSED) {
        // Committed, not rolled back: refusing this request is not enough.
        // Whoever holds the live end of the chain has to lose it too.
        const revokedCount = await revokeFamily(conn, current.familyId);
        await conn.commit();
        // Logged after the commit, so the log never reports a revocation that
        // rolled back. Ids only. The token is a credential, and its hash would
        // match a row for anyone who can read the database.
        console.warn(
          `[auth] refresh token reuse: user=${current.userId} ` +
            `family=${current.familyId} revoked=${revokedCount}`
        );
        return null;
      }

      if (state !== REFRESH_TOKEN_STATE.VALID) {
        await conn.rollback();
        return null;
      }

      const next = await issueRefreshToken(current.userId, {
        familyId: current.familyId,
        conn,
      });

      // The lock already makes this the only rotation of the row. The guard is
      // what would still stop a second live token if the lock were ever lost
      // in a refactor: the loser's UPDATE matches nothing, and rolling back
      // takes its freshly inserted token with it. It requires both columns
      // classifyRefreshToken requires for a live token.
      const [revoked] = await conn.query(
        `UPDATE refresh_tokens
            SET revoked_at = NOW(3), replaced_by = ?
          WHERE id = ? AND revoked_at IS NULL AND replaced_by IS NULL`,
        [next.id, current.id]
      );
      if (revoked.affectedRows !== 1) {
        await conn.rollback();
        return null;
      }

      await conn.commit();
      return {
        token: next.token,
        user: {
          id: current.userId,
          role: current.role,
          organizationId: current.organizationId,
        },
      };
    } catch (error) {
      await conn.rollback();
      throw error;
    }
  } finally {
    conn.release();
  }
}

/**
 * Ends a session: revokes every live token in the presented token's family.
 *
 * Any token of the family will do, live, rotated or expired. Holding one is
 * all the proof sign-out needs, and the phone may well be holding one that a
 * refresh still in flight has just rotated: refusing it would leave that
 * refresh's new token alive after the user signed out. Returns how many tokens
 * were revoked.
 */
export async function revokeRefreshFamily(token) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    try {
      // Lock the presented row before touching its family. A rotation of the
      // same token locks this row first too, so a sign-out racing a refresh
      // of that token queues behind it, then revokes the token it minted.
      //
      // A rotation of a DIFFERENT token in the family is not ordered this way.
      // Only a second holder of the family can send one: a thief, or a phone
      // that lost a refresh response. That rotation's insert can meet the
      // gap locks the family UPDATE below takes on idx_refresh_family, and
      // the two deadlock. InnoDB rolls one back. Either no successor is
      // minted, or this sign-out fails with a 500 and the family survives
      // until the next revocation. No token ever outlives a revocation that
      // committed.
      const [[presented]] = await conn.query(
        `SELECT family_id AS familyId
           FROM refresh_tokens
          WHERE token_hash = ?
            FOR UPDATE`,
        [hashRefreshToken(token)]
      );
      const count = presented ? await revokeFamily(conn, presented.familyId) : 0;

      await conn.commit();
      return count;
    } catch (error) {
      await conn.rollback();
      throw error;
    }
  } finally {
    conn.release();
  }
}

// On the caller's connection, so whoever revokes a family can do it inside a
// transaction that has already locked what it decided on.
async function revokeFamily(conn, familyId) {
  const [result] = await conn.query(
    `UPDATE refresh_tokens
        SET revoked_at = NOW(3)
      WHERE family_id = ? AND revoked_at IS NULL`,
    [familyId]
  );
  return result.affectedRows;
}
