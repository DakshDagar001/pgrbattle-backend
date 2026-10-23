/**
 * Admin-initiated phone-number change.
 *
 * A phone number lives in three places, and only one of them can be written by a
 * client:
 *
 *   1. the Firebase Authentication account (`phoneNumber`), which decides what the
 *      verified ID token carries and which number a later SMS sign-in resolves to;
 *   2. `users/{uid}.phone`, the profile copy every screen and payment record reads;
 *   3. `phoneNumbers/{e164}`, the ownership reservation the auth flow writes inside
 *      a transaction and refuses to hand out twice.
 *
 * Firebase Authentication and Firestore share no transaction, so this service does
 * not pretend otherwise. It validates and checks ownership first, then applies the
 * Authentication change, then commits the profile and registry writes in one
 * Firestore transaction. If the second half fails, the response says so explicitly:
 * the number on the profile is reconciled by retrying, which is safe because a retry
 * recognises an already-correct Authentication number and only finishes the writes.
 * Nothing is ever rolled back to the old number, because that could overwrite a
 * concurrent change nobody had seen.
 *
 * An administrative change is not an SMS verification. The account's `phoneVerified`
 * flag goes to false and the registry entry records where it came from, so no screen
 * can claim the target user proved ownership of the new number.
 *
 * Authorization mirrors account deletion: a verified ID token plus that uid existing
 * in `admin_users`. Organizers are not admins, and the target uid in the request is a
 * selector only - it never carries authority.
 */

const { canonicalPhoneNumber } = require('./authPolicy');

/** Registry provenance marker: this mapping came from a staff edit, not from an OTP. */
const ADMIN_SOURCE = 'admin_phone_update';

function describe(error) {
  return (error && (error.code || error.errorInfo?.code || error.message)) || 'unknown error';
}

function isUserNotFound(error) {
  const code = error && (error.code || error.errorInfo?.code);
  return code === 'auth/user-not-found'
    || code === 'auth/uid-not-found'
    || code === 'auth/phone-number-not-found'
    || error?.httpErrorCode?.code === 404;
}

function isPhoneNumberTaken(error) {
  const code = error && (error.code || error.errorInfo?.code);
  return code === 'auth/phone-number-already-exists'
    || code === 'auth/credential-already-in-use';
}

function step(name, detail) {
  return { step: name, detail: detail || '' };
}

function trim(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * @param {object} deps
 * @param {object} deps.db            Firestore handle (admin SDK)
 * @param {object} deps.auth          Firebase Auth handle (admin SDK)
 * @param {Function} deps.isAdminUid  authoritative `admin_users` membership check
 * @param {Function} deps.serverTimestamp
 */
function createAdminPhoneUpdateService({ db, auth, isAdminUid, serverTimestamp }) {
  if (!db || !auth || !isAdminUid || !serverTimestamp) {
    throw new Error('createAdminPhoneUpdateService requires db, auth, isAdminUid and serverTimestamp');
  }

  const users = () => db.collection('users');
  const registry = () => db.collection('phoneNumbers');

  /**
   * A number may only be attached to the target account. Anything owned by another
   * uid - in the registry, on a profile or on a live sign-in account - is refused
   * before a single mutation happens.
   */
  async function findHolder(candidate, targetUid) {
    const entry = await registry().doc(candidate).get();
    const owner = entry.exists ? (entry.data() || {}).uid : '';
    if (owner && owner !== targetUid) return { holder: 'phoneNumbers', otherUid: owner };

    const claim = await users().where('phone', '==', candidate).limit(2).get();
    const rival = (claim.docs || []).find(doc => doc.id !== targetUid);
    if (rival) return { holder: 'profile', otherUid: rival.id };

    try {
      const existing = await auth.getUserByPhoneNumber(candidate);
      if (existing && existing.uid && existing.uid !== targetUid) {
        return { holder: 'authentication', otherUid: existing.uid };
      }
    } catch (error) {
      if (!isUserNotFound(error)) throw error;
    }
    return null;
  }

  /**
   * Profile and registry move together or not at all. The old registry mapping is
   * only removed when it demonstrably belonged to this account.
   */
  async function commitWrites({ targetUid, candidate, previous, region, actorUid }) {
    await db.runTransaction(async transaction => {
      const entry = await transaction.get(registry().doc(candidate));
      const owner = entry.exists ? (entry.data() || {}).uid : '';
      if (owner && owner !== targetUid) {
        const error = new Error('PHONE_TAKEN');
        error.code = 'PHONE_TAKEN';
        throw error;
      }

      // The profile keeps every other field exactly as it is: a merge write of the
      // three phone fields, never a document rewrite.
      transaction.set(users().doc(targetUid), {
        phone: candidate,
        phoneVerified: false
      }, { merge: true });

      if (previous && previous !== candidate) {
        const oldEntry = await transaction.get(registry().doc(previous));
        if (oldEntry.exists && (oldEntry.data() || {}).uid === targetUid) {
          transaction.delete(registry().doc(previous));
        }
      }

      transaction.set(registry().doc(candidate), {
        uid: targetUid,
        phoneNumber: candidate,
        region,
        source: ADMIN_SOURCE,
        assignedBy: actorUid,
        assignedAt: serverTimestamp(),
        createdAt: entry.exists ? (entry.data() || {}).createdAt || serverTimestamp() : serverTimestamp()
      }, { merge: true });
    });
  }

  /**
   * @param {object} request
   * @param {string} request.uid        target account, chosen by the admin
   * @param {string} request.phoneNumber candidate number, any spelling
   * @param {string} request.actorUid   authenticated caller; never taken from the body
   */
  async function updatePhoneNumber({ uid, phoneNumber, actorUid } = {}) {
    const targetUid = trim(uid);
    if (!targetUid || targetUid.length > 128) {
      return { code: 'INVALID_UID', message: 'A valid account identifier is required.', steps: [] };
    }

    const canonical = canonicalPhoneNumber(phoneNumber);
    if (!canonical) {
      return {
        code: 'INVALID_PHONE',
        message: 'Enter a supported +91, +92, +977 or +880 number with 10 national digits.',
        steps: []
      };
    }
    const candidate = canonical.phoneNumber;

    let authorized = false;
    try {
      authorized = await isAdminUid(actorUid);
    } catch (error) {
      return {
        code: 'PARTIAL',
        message: 'Administrator check failed. Nothing was changed.',
        steps: [step('adminCheck', describe(error))],
        authUpdated: false,
        retryable: true
      };
    }
    if (!authorized) {
      return {
        code: 'FORBIDDEN',
        message: 'Administrator privileges are required to change a phone number.',
        steps: []
      };
    }

    const steps = [];
    let profileSnapshot;
    try {
      profileSnapshot = await users().doc(targetUid).get();
    } catch (error) {
      return {
        code: 'PARTIAL',
        message: 'The account could not be read, so nothing was changed.',
        steps: [step('profile', describe(error))],
        authUpdated: false,
        retryable: true
      };
    }
    if (!profileSnapshot.exists) {
      return {
        code: 'NOT_FOUND',
        message: 'No account exists for that identifier.',
        steps: [step('profile', 'MISSING')]
      };
    }
    const profile = profileSnapshot.data() || {};
    const previous = trim(profile.phone);

    let account;
    try {
      account = await auth.getUser(targetUid);
    } catch (error) {
      if (isUserNotFound(error)) {
        return {
          code: 'NOT_FOUND',
          message: 'No sign-in account exists for that profile.',
          steps: [step('auth', 'MISSING')]
        };
      }
      // An unreadable sign-in state must not be edited on top of.
      return {
        code: 'PARTIAL',
        message: 'The sign-in account could not be read, so nothing was changed.',
        steps: [step('auth', describe(error))],
        authUpdated: false,
        retryable: true
      };
    }

    try {
      const taken = await findHolder(candidate, targetUid);
      if (taken) {
        return {
          code: 'PHONE_ALREADY_ASSIGNED',
          message: 'That number already belongs to another account.',
          steps: [step('ownership', taken.holder)],
          authUpdated: false,
          retryable: false
        };
      }
    } catch (error) {
      return {
        code: 'PARTIAL',
        message: 'Number ownership could not be confirmed, so nothing was changed.',
        steps: [step('ownership', describe(error))],
        authUpdated: false,
        retryable: true
      };
    }

    // Retry path: the sign-in already carries the wanted number, so only the
    // Firestore half is finished. This is what makes a partial completion safe.
    if (trim(account.phoneNumber) === candidate) {
      steps.push(step('auth', 'ALREADY_CURRENT'));
    } else {
      try {
        await auth.updateUser(targetUid, { phoneNumber: candidate });
        steps.push(step('auth'));
      } catch (error) {
        if (isPhoneNumberTaken(error)) {
          return {
            code: 'PHONE_ALREADY_ASSIGNED',
            message: 'That number already belongs to another account.',
            steps: [...steps, step('auth', 'ALREADY_LINKED')],
            authUpdated: false,
            retryable: false
          };
        }
        // The profile was never touched, so the account is exactly as it was.
        return {
          code: 'REJECTED',
          message: 'The sign-in account refused this number. No data was changed.',
          steps: [...steps, step('auth', describe(error))],
          authUpdated: false,
          retryable: false
        };
      }
    }

    try {
      await commitWrites({
        targetUid,
        candidate,
        previous,
        region: canonical.region,
        actorUid: trim(actorUid)
      });
      steps.push(step('profile'));
      steps.push(step('registry'));
    } catch (error) {
      if (error && error.code === 'PHONE_TAKEN') {
        // Ownership moved between the check and the write. The sign-in now holds the
        // number while the profile still shows the old one, so say so plainly.
        return {
          code: 'PARTIAL',
          message: 'The number was claimed by another account mid-change. The sign-in was ' +
            'updated but the profile was not. Retry once the conflict is resolved.',
          steps: [...steps, step('profile', 'PHONE_TAKEN')],
          authUpdated: true,
          phone: candidate,
          retryable: true
        };
      }
      return {
        code: 'PARTIAL',
        message: 'The sign-in account now holds the new number, but the profile could not be ' +
          'updated. Retry to finish the same change.',
        steps: [...steps, step('profile', describe(error))],
        authUpdated: true,
        phone: candidate,
        retryable: true
      };
    }

    return {
      code: previous === candidate ? 'RECONCILED' : 'COMPLETE',
      message: previous === candidate
        ? 'The account already held this number; the records are now consistent.'
        : 'Phone number updated.',
      steps,
      uid: targetUid,
      phone: candidate,
      region: canonical.region,
      previousPhone: previous,
      // Truthful status: an admin change is not an SMS verification.
      phoneVerified: false,
      authUpdated: steps.some(entry => entry.step === 'auth' && entry.detail !== 'ALREADY_CURRENT'),
      retryable: false
    };
  }

  return { updatePhoneNumber };
}

module.exports = { createAdminPhoneUpdateService, ADMIN_SOURCE };
