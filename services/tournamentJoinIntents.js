/**
 * Joining a password-protected tournament.
 *
 * ## The problem this replaces
 *
 * The Player app used to compare what a player typed against `entryPassword` on the tournament
 * document - a field the same app had already downloaded in order to show the tournament. Two
 * things were wrong with that. The tournament asked for its password as soon as a player *opened*
 * it, which is not what a password on a match means, and the comparison happened on the phone that
 * already held the answer, so it protected nothing: any client could read the field and skip the
 * dialog.
 *
 * ## What a join intent is
 *
 * The password now buys a *join permit*: a short-lived document at
 * `join_permits/{uid}__{tournamentId}` that `firestore.rules` requires before it will accept the
 * participant row and participation counter a join writes. So:
 *
 *   - viewing a tournament reads the document and nothing else - no permit is asked for, no
 *     password is typed, no money moves;
 *   - the password is compared on the server, against the stored secret, with a comparison that
 *     does not leak its length or its prefix through timing;
 *   - a wrong password writes nothing at all - no permit, no participant, no deduction;
 *   - a correct password issues a permit that names this player and this match, so it cannot be
 *     handed to another match or another account;
 *   - a client that skips this call cannot join a protected match, because the rules refuse the
 *     write without the permit. A client that fabricates a boolean is in exactly that position.
 *
 * The permit is not a payment. Payment is a separate step the app performs after this returns, and
 * it is the existing one - the same balance priority, the same ZapUPI path, the same rewarded-ad
 * case for a free match. This service never touches a balance.
 *
 * ## Where the password lives
 *
 * New matches keep their password in `tournament_secrets/{tournamentId}`, which the player and
 * organizer apps may not read and which the Admin app writes from the screen the password is typed
 * on, and carry only a `passwordProtected` flag on the match itself - which is all the app needs in
 * order to know whether to ask. Matches written before that existed still carry
 * `entryPassword` on the document, so this service reads the secret when there is one and falls
 * back to the document for legacy rows. That fallback is why the join still has to go through a
 * permit for *both* cases: the rules treat either source as protected.
 */

const crypto = require('crypto');

const TOURNAMENT_COLLECTION = 'tournaments';
const SECRET_COLLECTION = 'tournament_secrets';
const PERMIT_COLLECTION = 'join_permits';

/** A permit is worth one join attempt's worth of time, not a session. */
const DEFAULT_TTL_MS = 10 * 60 * 1000;

/** The statuses a player can still join. A match that started is closed. */
const JOINABLE_STATUSES = ['upcoming'];

/** Attempts per account and match inside the window before the caller is throttled. */
const MAX_ATTEMPTS = 10;
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;

// Both the player uid and the match id are embedded in the join permit's document id, which the
// rules rebuild character for character to read the permit back. Firestore rejects a document id
// containing a '.', so a dotted value is refused here rather than minting a permit nobody can use.
const SAFE_ID = /^[A-Za-z0-9_:-]{1,200}$/;

function trim(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function refused(code, message, extra = {}) {
  return { code, message, required: false, permit: null, ...extra };
}

/** The permit document id for this player and match. */
function permitIdOf(uid, tournamentId) {
  return `${uid}__${tournamentId}`;
}

/** Constant-time comparison that does not leak the stored value's length. */
function sameSecret(given, stored) {
  const left = crypto.createHash('sha256').update(String(given), 'utf8').digest();
  const right = crypto.createHash('sha256').update(String(stored), 'utf8').digest();
  return crypto.timingSafeEqual(left, right);
}

function toMillis(value) {
  if (!value) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  if (typeof value.seconds === 'number') {
    return value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1e6);
  }
  return null;
}

function createTournamentJoinIntents({
  db,
  serverTimestamp,
  now = () => Date.now(),
  ttlMs = DEFAULT_TTL_MS,
  maxAttempts = MAX_ATTEMPTS,
  attemptWindowMs = ATTEMPT_WINDOW_MS
} = {}) {
  if (!db || !serverTimestamp) {
    throw new Error('createTournamentJoinIntents requires db and serverTimestamp');
  }

  const tournamentRefOf = id => db.collection(TOURNAMENT_COLLECTION).doc(id);
  const secretRefOf = id => db.collection(SECRET_COLLECTION).doc(id);
  const permitRefOf = (uid, id) => db.collection(PERMIT_COLLECTION).doc(permitIdOf(uid, id));

  /*
   * Wrong-password throttling.
   *
   * A password that can be guessed a thousand times a second is not a password. The counter is
   * per account and match, in this process, and pruned on use - deliberately not a stored
   * document, because a wrong guess must leave nothing behind at all.
   */
  const attempts = new Map();

  function attemptKey(uid, id) {
    return `${uid}__${id}`;
  }

  function throttled(uid, id) {
    const key = attemptKey(uid, id);
    const record = attempts.get(key);
    if (!record) return false;
    if (now() - record.first > attemptWindowMs) {
      attempts.delete(key);
      return false;
    }
    return record.count >= maxAttempts;
  }

  function recordFailure(uid, id) {
    const key = attemptKey(uid, id);
    const at = now();
    const record = attempts.get(key);
    if (!record || at - record.first > attemptWindowMs) {
      attempts.set(key, { first: at, count: 1 });
    } else {
      record.count += 1;
    }
    // A bounded map: anything older than the window is dropped when the map grows.
    if (attempts.size > 5000) {
      for (const [entry, value] of attempts) {
        if (at - value.first > attemptWindowMs) attempts.delete(entry);
      }
    }
  }

  /** The password this match is protected by, from the secret or from the legacy field. */
  async function passwordOf(tournamentId, tournamentData) {
    const secretSnap = await secretRefOf(tournamentId).get();
    if (secretSnap.exists) {
      const secret = secretSnap.data() || {};
      const stored = trim(secret.entryPassword);
      if (stored) return { protected: true, password: stored, source: 'secret' };
    }
    const legacy = trim(tournamentData.entryPassword);
    if (legacy) return { protected: true, password: legacy, source: 'legacy' };
    return { protected: false, password: '', source: 'none' };
  }

  /** Whether this player already holds a live permit for this match. */
  async function permitIsLive(uid, tournamentId) {
    const snap = await permitRefOf(uid, tournamentId).get();
    if (!snap.exists) return false;
    const data = snap.data() || {};
    if (trim(data.uid) !== uid || trim(data.tournamentId) !== tournamentId) return false;
    const expires = toMillis(data.expiresAt);
    return expires !== null && expires > now();
  }

  async function issuePermit(uid, tournamentId) {
    const issuedAt = now();
    const expiresAt = new Date(issuedAt + ttlMs);
    await permitRefOf(uid, tournamentId).set({
      uid,
      tournamentId,
      issuedAt: new Date(issuedAt),
      // The rules compare this field against `request.time`, so it has to be a timestamp.
      expiresAt,
      createdAt: serverTimestamp()
    });
    return {
      id: permitIdOf(uid, tournamentId),
      expiresAtMillis: expiresAt.getTime(),
      expiresAt: expiresAt.toISOString()
    };
  }

  /**
   * Ask to join, and be answered with either nothing (wrong password, full match, already in) or a
   * permit the join write needs.
   *
   * `password` is never logged, never stored on the permit and never echoed back.
   *
   * ## Renewing without the password again
   *
   * A permit is good for ten minutes, and a player may spend longer than that picking slots and
   * typing in-game names. The app therefore renews the permit immediately before it commits the
   * join - and it does so without asking for the password a second time, because a *live* permit
   * is itself the proof that the password was already checked for this account and this match.
   * Renewal is refused when no live permit exists, so skipping the password is still impossible;
   * it only extends an answer that was already given.
   */
  async function openIntent({ playerUid, tournamentId, password = '' } = {}) {
    const uid = trim(playerUid);
    if (!uid || !SAFE_ID.test(uid)) {
      return refused('PLAYER_UID_INVALID', 'A signed-in player is required.');
    }
    const matchId = trim(tournamentId);
    if (!matchId || !SAFE_ID.test(matchId)) {
      return refused('TOURNAMENT_ID_INVALID', 'A valid match is required.');
    }

    const matchSnap = await tournamentRefOf(matchId).get();
    if (!matchSnap.exists) {
      return refused('TOURNAMENT_NOT_FOUND', 'That match no longer exists.');
    }
    const match = matchSnap.data() || {};

    if (match.isActive === false || !JOINABLE_STATUSES.includes(trim(match.status).toLowerCase())) {
      return refused('TOURNAMENT_CLOSED', 'This match is no longer open for joining.');
    }

    const capacity = Number(match.maxParticipants);
    const joined = Number(match.currentParticipants) || 0;
    if (Number.isFinite(capacity) && capacity > 0 && joined >= capacity) {
      return refused('TOURNAMENT_FULL', 'This match is full.');
    }

    // Already in, by either record the join writes. Answered before the password is looked at, so
    // a player who is already in is never asked to prove it again.
    const seatSnap = await db.collection('users').doc(uid)
      .collection('joinedTournaments').doc(matchId).get();
    if (seatSnap.exists) {
      return refused('ALREADY_JOINED', 'You are already in this match.');
    }

    const protection = await passwordOf(matchId, match);
    if (!protection.protected) {
      return { code: 'COMPLETE', required: false, permit: null, tournamentId: matchId,
        message: 'This match does not need a password.' };
    }

    const given = typeof password === 'string' ? password : '';

    // Renewal, before the password is asked for: a live permit already carries the answer.
    if (!given && await permitIsLive(uid, matchId)) {
      return {
        code: 'COMPLETE', required: true, renewed: true, tournamentId: matchId,
        permit: await issuePermit(uid, matchId)
      };
    }

    if (throttled(uid, matchId)) {
      return refused('TOO_MANY_ATTEMPTS',
        'Too many incorrect passwords. Try again in a few minutes.', { retryable: true });
    }

    if (!given) {
      return refused('PASSWORD_REQUIRED', 'This match is password protected.', { required: true });
    }
    if (!sameSecret(given, protection.password)) {
      // Nothing is written on a wrong password: no permit, no seat, no balance change.
      recordFailure(uid, matchId);
      console.error('[JoinIntent] Incorrect password for', matchId, 'by', uid);
      return refused('PASSWORD_INCORRECT', 'That password is not correct.', { required: true });
    }

    attempts.delete(attemptKey(uid, matchId));

    return {
      code: 'COMPLETE',
      required: true,
      renewed: false,
      tournamentId: matchId,
      permit: await issuePermit(uid, matchId)
    };
  }

  return { openIntent, passwordOf, permitIdOf, permitIsLive };
}

module.exports = {
  createTournamentJoinIntents,
  permitIdOf,
  sameSecret,
  TOURNAMENT_COLLECTION,
  SECRET_COLLECTION,
  PERMIT_COLLECTION,
  DEFAULT_TTL_MS,
  JOINABLE_STATUSES
};
