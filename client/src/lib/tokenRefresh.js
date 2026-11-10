// Whether this tab should call /refresh at all, decided from what authCache
// holds once the tab has the device-wide refresh lock.
//
// Why it matters: the server treats a refresh token presented a second time as
// stolen and revokes the whole session. Every tab of this app on a device
// shares one authCache, so two tabs whose requests expire together would each
// send the same refresh token. The first would rotate it, the second would be
// taken for a thief, and the user would be signed out everywhere. api.js
// queues tabs behind one Web Lock; this is what a tab does when its turn comes.
//
// Pure, with no Dexie and no navigator, so it can be tested with plain objects.

// Shared by every tab of this origin, and by every BUILD: during an update an
// old tab and a new tab are open side by side, and if the name changed they
// would hold different locks and race again. Never rename it.
export const REFRESH_LOCK_NAME = "setu-token-refresh";

export const REFRESH_DECISION = {
  // authCache still holds the token this tab's request was sent with: nobody
  // has rotated it, so this tab does.
  REFRESH: "refresh",
  // Another tab rotated while this one waited. Its tokens are in authCache, and
  // the token this tab holds is already spent on the server: sending it would
  // count as reuse. Use the stored access token instead.
  ADOPT: "adopt",
  // No server session to continue for this user: signed out, signed in offline
  // only, or a different person signed in since. Needs a person, not a request.
  SIGNED_OUT: "signed_out",
};

/**
 * @param {object} startedWith  the authCache row the rejected request was sent
 *                              with: { userId, refreshToken }
 * @param {object|undefined} stored  authCache re-read under the lock, or
 *                              undefined if the row is gone
 */
export function decideTokenRefresh(startedWith, stored) {
  if (!stored?.sessionActive || !stored.refreshToken) return REFRESH_DECISION.SIGNED_OUT;

  // A shared phone: someone else signed in while this tab's request was out.
  // Their tokens must never carry this tab's request. A sync is pushing rows
  // queued under the first person's name, and adopting the second person's
  // token would send them under the wrong identity.
  if (stored.userId !== startedWith.userId) return REFRESH_DECISION.SIGNED_OUT;

  if (stored.refreshToken === startedWith.refreshToken) return REFRESH_DECISION.REFRESH;

  // Rotated by someone else. Every write to authCache sets both tokens
  // together, so a missing access token beside a fresh refresh token is a
  // state nothing produces. Refuse rather than guess: /refresh is off limits
  // here, and the only fallback is a fresh sign-in.
  if (!stored.accessToken) return REFRESH_DECISION.SIGNED_OUT;

  return REFRESH_DECISION.ADOPT;
}
