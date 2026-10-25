/**
 * Operation permits: the trusted decision behind a protected Organizer write.
 *
 * ## Why a permit rather than a route that performs the write
 *
 * Some of what an organizer does is a single-document edit - a room password, a status - and some
 * is a multi-document transaction that moves *player* money: issuing prizes credits dozens of
 * `users` documents, reverses statistics and stamps `prizesDistributed`. Re-implementing that on
 * the server would be a second payout implementation, and the one thing the platform must never
 * have is two ways to pay the same participants. So the financial work stays where it already is,
 * inside the one transaction that has always done it, and what moves to the backend is the
 * *decision*: may this account, on this phone, right now, perform this operation on this match?
 *
 * That decision becomes a document - `organizer_op_permits/{uid}__{scope}__{tournamentId}` - which
 * `firestore.rules` reads back before it will accept the corresponding write. The consequences are
 * exactly what a migrated route would give:
 *
 *   - the operation cannot happen without the backend's answer, because the rules refuse the write
 *     without the permit;
 *   - an unapproved phone cannot obtain one, because the route runs the same device gate the
 *     withdrawal and create routes run;
 *   - a client cannot fabricate one, because no client may write `organizer_op_permits`;
 *   - a permit names one account, one operation and one match, and expires, so it cannot be
 *     replayed onto another match or used hours later;
 *   - authorization is decided from stored records - the organizer account, the match's server,
 *     the mode allowlist and the match's attribution - never from the request body.
 *
 * Admin writes are unaffected: every rule branch that requires a permit also admits an admin, and
 * an admin's authority is the `admin_users` check the Admin app already goes through.
 *
 * ## Scopes
 *
 *   tournament_update   - editing, cancelling, removing, room credentials, status changes
 *   tournament_delete   - deleting a match and its rows
 *   tournament_results  - issuing results, editing slots, distributing and resetting prizes
 *   mode_write          - creating or editing a tournament mode
 *
 * The scopes are the four write branches the rules actually distinguish. The finer intent - "this
 * was a cancellation, not an edit" - belongs to the audit row the action writes, not to the permit.
 *
 * Scopes carry an underscore rather than a dot on purpose, and nothing here may grow one: a scope
 * is embedded in the permit document's id, and the rules rebuild that same id to read the document
 * back. Firestore refuses a document id containing '.' outright, so a dotted scope would not make
 * the write merely slower - `exists()`/`get()` would fail to evaluate, and every organizer in the
 * app would be locked out of the operation the permit was supposed to unlock.
 */

const PERMIT_COLLECTION = 'organizer_op_permits';

/** How long a permit is worth. Long enough to finish a transaction, short enough not to linger. */
const DEFAULT_TTL_MS = 2 * 60 * 1000;

/** The operations a permit can be issued for, and the module flag each one needs. */
const SCOPES = {
  tournament_update: { permission: 'perm_tournaments', tournament: true },
  tournament_delete: { permission: 'perm_tournaments', tournament: true },
  tournament_results: { permission: 'perm_results', tournament: true },
  mode_write: { permission: 'perm_modes', tournament: false }
};

const DEFAULT_REGION = 'IN';

// The characters an id embedded in a permit document path may contain. A dot is excluded because
// Firestore rejects a document id containing one, and the uid and match id below are both parts of
// such a path - so a dotted value would be a permit the rules can never read back.
const SAFE_ID = /^[A-Za-z0-9_:-]{1,200}$/;

function trim(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function refused(code, message, extra = {}) {
  return { code, message, permit: null, ...extra };
}

/** The document id a permit for this account, operation and match lives at. */
function permitIdOf(uid, scope, tournamentId = '') {
  return `${uid}__${scope}__${tournamentId}`;
}

function regionOf(data) {
  const value = trim(data && data.region);
  return value || DEFAULT_REGION;
}

/**
 * @param {object} deps
 * @param {object} deps.db                  Firestore handle (Admin SDK)
 * @param {Function} deps.serverTimestamp   the clock behind the permit document
 * @param {Function} [deps.now]             injectable clock, so expiry is testable
 */
function createOrganizerOperationPermits({
  db,
  serverTimestamp,
  now = () => Date.now(),
  ttlMs = DEFAULT_TTL_MS,
  collection = PERMIT_COLLECTION
} = {}) {
  if (!db || !serverTimestamp) {
    throw new Error('createOrganizerOperationPermits requires db and serverTimestamp');
  }

  /**
   * Decide whether this organizer may perform this operation on this match.
   *
   * Returns `{ code: 'COMPLETE', permit }` on success and a refusal naming a code otherwise. The
   * caller has already established who the organizer is from the verified token and has already
   * run the device gate; nothing here reads an identity from a request body.
   */
  async function authorize({ organizerUid, scope, tournamentId = '' } = {}) {
    const uid = trim(organizerUid);
    if (!uid || !SAFE_ID.test(uid)) {
      return refused('ORGANIZER_UID_INVALID', 'A valid organizer account is required.');
    }

    const wanted = trim(scope);
    const rule = SCOPES[wanted];
    if (!rule) {
      return refused('SCOPE_UNKNOWN', 'That is not an organizer operation this platform records.',
        { scopes: Object.keys(SCOPES) });
    }

    const matchId = trim(tournamentId);
    if (rule.tournament && (!matchId || !SAFE_ID.test(matchId))) {
      return refused('TOURNAMENT_ID_INVALID', 'This operation names a match, and that id is not one.');
    }
    if (!rule.tournament && matchId) {
      return refused('TOURNAMENT_ID_UNEXPECTED', 'This operation is not about a single match.');
    }

    const accountSnap = await db.collection('organizer_users').doc(uid).get();
    if (!accountSnap.exists) {
      return refused('NOT_AN_ORGANIZER', 'Only a registered organizer can perform this operation.');
    }
    const account = accountSnap.data() || {};
    if (account.banned === true) {
      return refused('ORGANIZER_BANNED', 'This organizer account is banned.');
    }
    if (account.isActive === false) {
      return refused('ORGANIZER_INACTIVE', 'This organizer account is deactivated.');
    }

    const permissions = account.permissions && typeof account.permissions === 'object'
      ? account.permissions
      : {};
    if (permissions[rule.permission] !== true) {
      return refused('FORBIDDEN_PERMISSION',
        'This account does not hold the module this operation belongs to.',
        { permission: rule.permission });
    }

    let matchData = null;
    if (rule.tournament) {
      const matchSnap = await db.collection('tournaments').doc(matchId).get();
      if (!matchSnap.exists) {
        return refused('TOURNAMENT_NOT_FOUND', 'That match no longer exists.');
      }
      matchData = matchSnap.data() || {};

      // Server: the match's own server has to be one this account holds.
      const regions = Array.isArray(account.regions) ? account.regions : [DEFAULT_REGION];
      if (!regions.includes(regionOf(matchData))) {
        return refused('ORGANIZER_SERVER_FORBIDDEN', 'You do not have this server.');
      }

      // Mode: an empty allowlist means every mode on the servers held, exactly as the rules mean it.
      const allowedModes = Array.isArray(account.allowedModeIds) ? account.allowedModeIds : [];
      const modeId = trim(matchData.modeId);
      if (allowedModes.length > 0 && !allowedModes.includes(modeId)) {
        return refused('ORGANIZER_MODE_FORBIDDEN', 'You are not assigned to this mode.');
      }

      // Attribution: an unattributed match is the compatibility case and belongs to any organizer
      // who otherwise reaches it; a match that names somebody belongs to them.
      const creator = trim(matchData.createdByOrganizerUid);
      const assignee = trim(matchData.assignedOrganizerUid);
      const unattributed = creator === '' && assignee === '';
      if (!unattributed && creator !== uid && assignee !== uid) {
        return refused('TOURNAMENT_NOT_YOURS', 'This match belongs to another organizer.');
      }
    }

    const issuedAt = now();
    const expiresAt = new Date(issuedAt + ttlMs);
    const permit = {
      uid,
      scope: wanted,
      tournamentId: rule.tournament ? matchId : '',
      permission: rule.permission,
      issuedAt: new Date(issuedAt),
      // A real timestamp field rather than a number: the rules compare this against
      // `request.time`, which is only meaningful as a timestamp.
      expiresAt,
      createdAt: serverTimestamp()
    };

    await db.collection(collection).doc(permitIdOf(uid, wanted, permit.tournamentId)).set(permit);

    return {
      code: 'COMPLETE',
      permit: {
        id: permitIdOf(uid, wanted, permit.tournamentId),
        scope: wanted,
        tournamentId: permit.tournamentId,
        expiresAtMillis: expiresAt.getTime(),
        expiresAt: expiresAt.toISOString(),
        permission: rule.permission,
        matchCode: rule.tournament ? (trim(matchData.matchCode) || null) : null
      }
    };
  }

  return { authorize, permitIdOf };
}

module.exports = {
  createOrganizerOperationPermits,
  permitIdOf,
  SCOPES,
  PERMIT_COLLECTION,
  DEFAULT_TTL_MS
};
