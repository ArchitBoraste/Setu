// The live account check for privileged online routes: is the caller still an
// active account, in this organisation, with one of these roles — according to
// the database right now, not to a token signed up to fifteen minutes ago.
//
// No imports, like refreshTokenRules.js: the decision and the middleware shape
// are tested without .env or a pool. middleware/auth.js supplies the query.
//
// Used by /api/admin and /api/conflicts. Both are online-only surfaces where a
// person decides something about other people's access or data, so a
// deactivated or demoted user must lose them on their next request, not when
// their access token runs out. Sync keeps reading role from the token (see the
// known gap in CLAUDE.md); it already re-reads is_active through loadArea.

/**
 * What to answer for this account, or null to let the request through.
 *
 * `account` is the caller's row, or null when no row matched: deleted, or
 * moved to another organisation since the token was signed. Shape:
 *   { role, isActive, deleted }
 * with isActive and deleted as MySQL's 1/0 or booleans.
 *
 * 401 when the account can no longer act at all. The client takes that as an
 * expired token and refreshes; the refresh fails for an inactive or removed
 * account and the device asks for a fresh sign-in, and a moved account comes
 * back with a token for its new organisation. The same answer loadArea gives.
 *
 * 403 when the account is fine but no longer holds one of these roles. A
 * refresh would only produce a token with the new role, refused the same way.
 *
 * Fails closed: only isActive exactly 1/true and deleted exactly 0/false pass,
 * so a column dropped from the SELECT by a refactor refuses everyone rather
 * than letting everyone in.
 */
export function liveRoleRefusal(account, allowedRoles) {
  const active = account?.isActive === 1 || account?.isActive === true;
  const present = account?.deleted === 0 || account?.deleted === false;
  if (!account || !active || !present) {
    return { status: 401, error: "Account not found" };
  }
  if (!allowedRoles.includes(account.role)) {
    return { status: 403, error: "Forbidden" };
  }
  return null;
}

/**
 * Builds requireLiveRole(...roles) around a function that reads the caller's
 * account: readAccount({ id, organizationId }) -> { role, isActive, deleted }
 * or null.
 *
 * Runs after requireAuth (which sets req.user from the verified token) and
 * after requireRole, which refuses a token that never claimed the role without
 * spending a query on it.
 *
 * Returns its promise so a test can await it. Express 4 ignores the return
 * value, so a failed read is handed to next() here rather than left to escape.
 */
export function createRequireLiveRole(readAccount) {
  return (...allowedRoles) =>
    async function requireLiveRole(req, res, next) {
      let account;
      try {
        account = await readAccount({
          id: req.user.id,
          organizationId: req.user.organizationId,
        });
      } catch (error) {
        return next(error);
      }

      const refusal = liveRoleRefusal(account ?? null, allowedRoles);
      if (refusal) return res.status(refusal.status).json({ error: refusal.error });
      next();
    };
}
