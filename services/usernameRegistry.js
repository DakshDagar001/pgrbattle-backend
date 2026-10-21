/**
 * Authoritative username registry.
 *
 * Two data sources describe a username in this project:
 *   - `usernames/{normalized}`  the uniqueness registry (doc id == lowercase name)
 *   - `users/{uid}.username`    the account record (authoritative for real accounts)
 *
 * Legacy and admin-created accounts can exist in `users` without a registry doc,
 * so availability must consult both, and reservation must be atomic.
 */

const { normalizeUsername, isValidUsername } = require('./authPolicy');

function isAlreadyExists(error) {
  const code = error && error.code;
  // gRPC ALREADY_EXISTS (6) and the Firestore SDK string form.
  return code === 6 || code === 'already-exists';
}

/**
 * @param {object} dependencies
 * @param {object} dependencies.db            Firestore instance (Admin SDK bypasses rules)
 * @param {Function} dependencies.serverTimestamp  Factory for a server timestamp sentinel
 */
function createUsernameRegistry({ db, serverTimestamp }) {
  const usernames = () => db.collection('usernames');
  const users = () => db.collection('users');

  /** Returns the current owner of a normalized username, or null when free. */
  async function findOwner(normalized) {
    const registryDoc = await usernames().doc(normalized).get();
    if (registryDoc.exists) {
      return { uid: (registryDoc.data() || {}).uid || '', source: 'registry' };
    }
    const profiles = await users().where('username', '==', normalized).limit(1).get();
    if (!profiles.empty) {
      return { uid: profiles.docs[0].id, source: 'profile' };
    }
    return null;
  }

  /**
   * Availability lookup. Throws on infrastructure failure so callers can never
   * mistake an error for "available".
   */
  async function availability(rawUsername) {
    const normalized = normalizeUsername(rawUsername);
    if (!isValidUsername(normalized)) {
      const error = new Error('Username format is invalid');
      error.code = 'invalid-username';
      throw error;
    }
    const owner = await findOwner(normalized);
    return { normalized, available: owner === null };
  }

  /**
   * Atomically reserve a username for an authenticated uid.
   *
   * `create()` is a single-document transactional write, so exactly one of any
   * number of concurrent claims can succeed; the loser receives ALREADY_EXISTS.
   * The pre-check is only an optimization and never the basis of a decision.
   */
  async function claim(uid, rawUsername) {
    const normalized = normalizeUsername(rawUsername);
    if (!isValidUsername(normalized)) {
      return { ok: false, reason: 'INVALID', normalized };
    }

    const existing = await findOwner(normalized);
    if (existing) {
      return {
        ok: false,
        reason: existing.uid === uid ? 'OWNED' : 'TAKEN',
        normalized
      };
    }

    const ref = usernames().doc(normalized);
    try {
      await ref.create({
        uid,
        username: normalized,
        claimedAt: serverTimestamp()
      });
      return { ok: true, normalized, uid };
    } catch (error) {
      if (isAlreadyExists(error)) {
        const winner = await ref.get();
        const winnerUid = (winner.data() || {}).uid;
        return {
          ok: false,
          reason: winnerUid === uid ? 'OWNED' : 'TAKEN',
          normalized
        };
      }
      throw error;
    }
  }

  /**
   * Roll back a reservation when registration could not be completed.
   * Only the claiming uid may release, and never after a profile exists.
   */
  async function release(uid, rawUsername) {
    const normalized = normalizeUsername(rawUsername);
    if (!isValidUsername(normalized)) {
      return { ok: false, reason: 'INVALID', normalized };
    }

    const ref = usernames().doc(normalized);
    const doc = await ref.get();
    if (!doc.exists) {
      return { ok: true, released: false, normalized };
    }
    if ((doc.data() || {}).uid !== uid) {
      return { ok: false, reason: 'NOT_OWNER', normalized };
    }

    const profile = await users().doc(uid).get();
    if (profile.exists) {
      return { ok: false, reason: 'ACCOUNT_EXISTS', normalized };
    }

    await ref.delete();
    return { ok: true, released: true, normalized };
  }

  return { availability, claim, release, findOwner };
}

module.exports = { createUsernameRegistry, isAlreadyExists };
