/**
 * Admin-initiated account deletion.
 *
 * The admin app cannot delete a Firebase Authentication user, and a client side
 * fan-out cannot prove that a username reservation belongs to the account it is
 * freeing. Both of those need server-side authority, so this service owns the
 * whole operation:
 *
 *   1. the acting uid is re-checked against `admin_users` (a client-provided
 *      target uid is never treated as authorization),
 *   2. identity is resolved from the server's own records, not the caller's copy,
 *   3. the sign-in account is removed first, and nothing is touched if that step
 *      cannot be verified,
 *   4. profile data is removed with an ownership check on every shared document,
 *   5. the username and phone reservations are only freed once the account is
 *      provably inactive, so a name can never be released while its owner still
 *      exists, and can never strand on a half-deleted account.
 *
 * Every step is idempotent, so re-running a partially completed deletion resumes
 * instead of corrupting state. Payments, wallets, tournaments and withdrawal
 * records are deliberately not rewritten here.
 */

const { normalizeUsername } = require('./authPolicy');

/** Realtime Database locations that hold per-account data, per the existing policy. */
const RTDB_USER_PATHS = ['userPresence', 'fcmTokens', 'userBans', 'notifications'];

const REFERRAL_OWNER_FIELD = 'uid';
const DEVICE_OWNER_FIELD = 'userId';

function isUserNotFound(error) {
  return !!error && (error.code === 'auth/user-not-found'
    || error.code === 'auth/uid-not-found'
    || error.httpErrorCode?.code === 404);
}

function describe(error) {
  return (error && (error.code || error.errorInfo?.code || error.message)) || 'unknown error';
}

function step(name, detail) {
  return { step: name, detail: detail || '' };
}

function createAccountDeletionService({ db, auth, rtdb, registry, isAdminUid }) {
  if (!db || !auth || !rtdb || !registry || !isAdminUid) {
    throw new Error('createAccountDeletionService requires db, auth, rtdb, registry and isAdminUid');
  }

  const users = () => db.collection('users');
  const usernames = () => db.collection('usernames');

  /** The account is only inactive when both the profile and the login are gone. */
  async function readInactivity(targetUid) {
    const checks = await Promise.all([
      users().doc(targetUid).get().catch(() => null),
      auth.getUser(targetUid).then(() => 'exists', error => (isUserNotFound(error) ? 'gone' : 'unknown'))
    ]);
    const [profileSnapshot, authState] = checks;
    if (!profileSnapshot) return { active: true, reason: 'PROFILE_UNVERIFIED' };
    if (profileSnapshot.exists) return { active: true, reason: 'PROFILE_PRESENT' };
    if (authState !== 'gone') {
      return { active: true, reason: authState === 'unknown' ? 'AUTH_UNVERIFIED' : 'AUTH_PRESENT' };
    }
    return { active: false, reason: '' };
  }

  /**
   * Deletes one shared document only when it demonstrably belongs to the target.
   * `ownerField` is required for collections other accounts also write to.
   */
  async function removeOwnedDocument(report, name, ref, ownerField, targetUid) {
    const snapshot = await ref.get();
    if (!snapshot.exists) {
      report.alreadyGone.push(step(name));
      return;
    }
    if (ownerField) {
      const owner = (snapshot.data() || {})[ownerField];
      if (owner && owner !== targetUid) {
        // Another account owns it: leaving it alone is the correct outcome.
        report.skipped.push(step(name, 'NOT_OWNER'));
        return;
      }
    }
    await ref.delete();
    report.removed.push(step(name));
  }

  /**
   * Frees the username reservation, but only after the account has been proven
   * inactive. The registry's own release() guard is the primary path; a legacy
   * document id that the registry refuses to normalize is handled by an
   * ownership-checked delete so old accounts cannot strand their name forever.
   */
  async function releaseUsername(report, { targetUid, rawName }) {
    const normalized = normalizeUsername(rawName);
    if (!normalized) {
      report.skipped.push(step('username', 'NOT_RESOLVED'));
      return;
    }

    const state = await readInactivity(targetUid);
    if (state.active) {
      report.failed.push(step('username', state.reason));
      return;
    }

    const outcome = await registry.release(targetUid, normalized);
    if (outcome.ok) {
      (outcome.released ? report.removed : report.alreadyGone).push(step('username'));
      return;
    }
    if (outcome.reason === 'NOT_OWNER') {
      report.skipped.push(step('username', 'NOT_OWNER'));
      return;
    }
    if (outcome.reason !== 'INVALID') {
      // ACCOUNT_EXISTS and anything unexpected must never free the reservation.
      report.failed.push(step('username', outcome.reason || 'RELEASE_REFUSED'));
      return;
    }

    const ref = usernames().doc(normalized);
    const snapshot = await ref.get();
    if (!snapshot.exists) {
      report.alreadyGone.push(step('username'));
      return;
    }
    if ((snapshot.data() || {}).uid !== targetUid) {
      report.skipped.push(step('username', 'NOT_OWNER'));
      return;
    }
    await ref.delete();
    report.removed.push(step('username', 'LEGACY_KEY'));
  }

  /**
   * A verified phone number is a reservation too: leaving it behind would block
   * that number from every future account. Same inactive-account guard applies.
   */
  async function releasePhoneNumber(report, { targetUid, phone }) {
    if (!phone) {
      report.skipped.push(step('phoneNumber', 'NOT_RESOLVED'));
      return;
    }

    const state = await readInactivity(targetUid);
    if (state.active) {
      report.failed.push(step('phoneNumber', state.reason));
      return;
    }

    const ref = db.collection('phoneNumbers').doc(phone);
    const snapshot = await ref.get();
    if (!snapshot.exists) {
      report.alreadyGone.push(step('phoneNumber'));
      return;
    }
    if ((snapshot.data() || {}).uid !== targetUid) {
      report.skipped.push(step('phoneNumber', 'NOT_OWNER'));
      return;
    }
    await ref.delete();
    report.removed.push(step('phoneNumber'));
  }

  /**
   * @param {object} request
   * @param {string} request.uid         account to remove, chosen by the admin
   * @param {string} request.actorUid    authenticated admin whose authorization is verified
   * @param {string} [request.usernameHint] locator only; never trusted for authority
   */
  async function deleteAccount({ uid, actorUid, usernameHint } = {}) {
    const targetUid = typeof uid === 'string' ? uid.trim() : '';
    if (!targetUid || targetUid.length > 128) {
      return { code: 'INVALID_UID', message: 'A valid account identifier is required.', report: null };
    }

    // Authorization comes from the verified token plus the admin record, never
    // from the uid the caller asked us to delete.
    let authorized = false;
    try {
      authorized = await isAdminUid(actorUid);
    } catch (error) {
      return { code: 'PARTIAL', message: 'Administrator check failed, nothing was deleted.',
        report: null, failed: [step('adminCheck', describe(error))], retryable: true };
    }
    if (!authorized) {
      return { code: 'FORBIDDEN', message: 'Administrator privileges are required.', report: null };
    }

    const report = { removed: [], alreadyGone: [], skipped: [], failed: [] };
    const profileRef = users().doc(targetUid);
    const profileSnapshot = await profileRef.get();
    const profile = profileSnapshot.exists ? (profileSnapshot.data() || {}) : null;
    // The server's own record wins over the caller's copy, so a stale admin list
    // can never point a release at someone else's reservation.
    const username = (profile && profile.username) || (typeof usernameHint === 'string' ? usernameHint.trim() : '');
    const hwid = (profile && profile.hwid) || '';

    // A sign-in account that no longer exists is an already-deleted account.
    let existingAuthUser = null;
    try {
      existingAuthUser = await auth.getUser(targetUid);
    } catch (error) {
      if (!isUserNotFound(error)) {
        report.failed.push(step('auth', describe(error)));
        return finalize(report, {
          message: 'The sign-in account could not be verified, so no data was touched.',
          halted: true
        });
      }
    }

    if (!profile && !existingAuthUser) {
      const hinted = normalizeUsername(usernameHint);
      const stranded = hinted ? await usernames().doc(hinted).get().catch(() => null) : null;
      const ownsReservation = !!(stranded && stranded.exists
        && (stranded.data() || {}).uid === targetUid);
      if (!ownsReservation) {
        return { code: 'NOT_FOUND', message: 'No account exists for that identifier.', report };
      }
    }

    // 1. Authentication. Deleting the login first removes the ability to act as
    //    this account; if it fails nothing else is touched, so a retry starts
    //    from a consistent account rather than a half-deleted one.
    if (existingAuthUser) {
      try {
        await auth.deleteUser(targetUid);
        report.removed.push(step('auth'));
      } catch (error) {
        if (isUserNotFound(error)) {
          report.alreadyGone.push(step('auth'));
        } else {
          report.failed.push(step('auth', describe(error)));
          return finalize(report, {
            message: 'The sign-in account could not be deleted, so no data was touched.',
            halted: true
          });
        }
      }
    } else {
      report.alreadyGone.push(step('auth'));
    }

    const verifiedPhone = existingAuthUser && existingAuthUser.phoneNumber
      ? existingAuthUser.phoneNumber : '';

    // 2. Joined-tournament records under this account, removed before the parent.
    try {
      const matches = profileRef.collection('joinedTournaments');
      const snapshot = await matches.get();
      if (snapshot.empty) {
        report.alreadyGone.push(step('joinedTournaments'));
      } else {
        for (const document of snapshot.docs) {
          await matches.doc(document.id).delete();
        }
        report.removed.push(step('joinedTournaments', `${snapshot.size} record(s)`));
      }
    } catch (error) {
      report.failed.push(step('joinedTournaments', describe(error)));
    }

    // 3. Profile, organizer record, own referral code and device binding.
    if (profile) {
      try {
        await profileRef.delete();
        report.removed.push(step('profile'));
      } catch (error) {
        report.failed.push(step('profile', describe(error)));
      }
    } else {
      report.alreadyGone.push(step('profile'));
    }

    try {
      await removeOwnedDocument(report, 'organizer', db.collection('organizer_users').doc(targetUid),
        'uid', targetUid);
    } catch (error) {
      report.failed.push(step('organizer', describe(error)));
    }

    try {
      if (username) {
        await removeOwnedDocument(report, 'referralCode',
          db.collection('referralCodes').doc(username.toUpperCase()),
          REFERRAL_OWNER_FIELD, targetUid);
      } else {
        report.skipped.push(step('referralCode', 'NOT_RESOLVED'));
      }
    } catch (error) {
      report.failed.push(step('referralCode', describe(error)));
    }

    try {
      if (hwid) {
        await removeOwnedDocument(report, 'device', db.collection('devices').doc(hwid),
          DEVICE_OWNER_FIELD, targetUid);
      } else {
        report.skipped.push(step('device', 'NOT_RESOLVED'));
      }
    } catch (error) {
      report.failed.push(step('device', describe(error)));
    }

    // 4. Realtime Database presence, tokens, bans and notifications.
    try {
      for (const path of RTDB_USER_PATHS) {
        await rtdb.ref(`${path}/${targetUid}`).remove();
      }
      report.removed.push(step('realtimeDatabase', RTDB_USER_PATHS.join(', ')));
    } catch (error) {
      report.failed.push(step('realtimeDatabase', describe(error)));
    }

    // 5. Reservations. Both of these refuse to free anything while the account
    //    is still active, which is what keeps a username from being re-issued
    //    over a live profile.
    try {
      await releaseUsername(report, { targetUid, rawName: username });
    } catch (error) {
      report.failed.push(step('username', describe(error)));
    }

    try {
      await releasePhoneNumber(report, { targetUid, phone: verifiedPhone });
    } catch (error) {
      report.failed.push(step('phoneNumber', describe(error)));
    }

    return finalize(report, {});
  }

  function finalize(report, extra) {
    const incomplete = report.failed.length > 0;
    const result = {
      code: incomplete ? 'PARTIAL' : 'COMPLETE',
      message: incomplete
        ? (extra.message || 'Deletion is incomplete. The account can be deleted again once the failure clears.')
        : 'Account deleted completely.',
      report,
      retryable: incomplete
    };
    if (extra.halted) result.halted = true;
    return result;
  }

  return { deleteAccount, RTDB_USER_PATHS };
}

module.exports = { createAccountDeletionService, isUserNotFound, RTDB_USER_PATHS };
