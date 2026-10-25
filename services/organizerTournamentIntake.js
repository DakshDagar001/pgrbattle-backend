/**
 * Trusted tournament creation for organizers.
 *
 * Until this service existed, creating a match was a client-side Firestore transaction, which
 * meant two of this phase's requirements had nowhere to be enforced: the daily allowance could
 * only be *reported*, and the device gate could not cover creation at all. Firestore rules can
 * describe what a document must look like, but they cannot count a day's matches atomically and
 * they cannot attest a device, so the write has to move behind the authenticated backend.
 *
 * What the service decides, in this order, and why that order:
 *
 *   1. **Who is calling.** The uid is the verified token, never a body field. The account has to
 *      exist, be active and unbanned, and hold `perm_tournaments` - the same three conditions
 *      `firestore.rules` applies, so the trusted path is no more permissive than the direct one
 *      it replaces.
 *   2. **Where the match may live.** The mode document is the authority for the server and the
 *      mode code; the organizer's `regions` grant and `allowedModeIds` allowlist decide whether
 *      they may use it. An absent `regions` means India, exactly as the rules read it.
 *   3. **How much of today's allowance is used.** Counted from stored matches, in the same
 *      transaction that creates the new one, with the policy the `organizerDailyLimits` service
 *      already documents: the local day of the match's scheduled start at UTC+05:30, the same
 *      "one organizer per match" attribution the penalty uses, and cancelled/removed matches not
 *      counted. The count is the truth rather than a separate counter, so a cancellation frees
 *      allowance and a reassignment moves it.
 *   4. **Whether two creates can race.** Firestore cannot lock a query range, so counting alone
 *      would let two simultaneous creates both see "four used" and both write a fifth. The
 *      transaction therefore also reads and rewrites one mutex document per organizer and day,
 *      which makes a concurrent create abort and retry - and on the retry the query sees the
 *      match that won. That is what makes the limit hold under concurrency instead of only
 *      under sequential use.
 *   5. **Which match code it gets.** Allocated from `tournament_counters/{modeId}` in the same
 *      transaction, exactly as the Organizer app used to do it, so codes stay globally sequential
 *      per mode and two creations can never be handed the same one.
 *
 * A limit of `0` means no limit has been chosen - the settings document's own meaning - and is
 * never read as "this organizer may run no matches".
 */

const {
  countsToward,
  dayWindow,
  dayLabel,
  effectiveLimitOf,
  parseOffsetMinutes,
  DEFAULT_UTC_OFFSET_MINUTES,
  MAX_DAY_SCAN
} = require('./organizerDailyLimits');

/** The tournament states a create may name. `completed` belongs to payout rows, not matches. */
const CREATE_STATUSES = ['upcoming', 'ongoing', 'results'];

/** The server prefixes the match code already uses, mirrored from `ServerCatalog`. */
const SERVER_PREFIX = { IN: '10', PK: '20', NP: '30', BD: '40' };
const DEFAULT_REGION = 'IN';
const MODE_CODE = /^\d{2}$/;

/** Bounds on what a create may carry. A client cannot make a document unbounded. */
const MAX_TEXT = 2000;
const MAX_NAME = 120;
const MAX_TAGS = 10;
const MAX_TAG = 30;
const MAX_PRIZE_TIERS = 10;
const MAX_COINS = 10000000;
const MAX_PARTICIPANTS = 200;

/** A document id this service will build a path, a ledger key or a lock from. */
const SAFE_KEY = /^[A-Za-z0-9_-]{8,64}$/;

/** One line of the transaction, so a retry restarts from scratch. */
const TALLY_COLLECTION = 'organizer_daily_locks';

function trim(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function refused(code, message, extra = {}) {
  return { code, message, applied: false, ...extra };
}

function toMillis(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value > 0 ? value : null;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value.toDate === 'function') {
    try { return toMillis(value.toDate()); } catch (error) { return null; }
  }
  if (typeof value.seconds === 'number') {
    return value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1e6);
  }
  return null;
}

/** A number inside its bounds, or the fallback. Anything else is not a number. */
function boundedNumber(value, { min, max, fallback }) {
  const read = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(read) || read < min || read > max) return fallback;
  return read;
}

function boundedInt(value, { min, max, fallback }) {
  const read = boundedNumber(value, { min, max, fallback });
  return Number.isInteger(read) ? read : Math.trunc(read);
}

/** The canonical server code, defaulting the way every other screen defaults it. */
function serverCode(value) {
  const raw = trim(value).toUpperCase();
  return SERVER_PREFIX[raw] ? raw : DEFAULT_REGION;
}

function matchCodeFor(region, modeCode, matchNumber) {
  return `${SERVER_PREFIX[region] || SERVER_PREFIX[DEFAULT_REGION]}${modeCode}` +
    String(matchNumber).padStart(3, '0');
}

function text(value) {
  return typeof value === 'string' ? value.trim().slice(0, MAX_TEXT) : '';
}

/**
 * The request body as stored values.
 *
 * Nothing here trusts a computed field: the server name, the match number, the match code, the
 * creator and the participant count are all derived on this side. A body that sends them is
 * answered by ignoring them, which is what makes a crafted request unable to place a match on
 * another server or book it onto another organizer.
 */
function normalize(input) {
  const scheduledAt = toMillis(input && input.dateTime);
  if (scheduledAt === null) {
    return { error: refused('INVALID_DATE', 'A valid scheduled start is required.', { field: 'dateTime' }) };
  }

  const name = trim(input.name).slice(0, MAX_NAME);
  if (!name) {
    return { error: refused('INVALID_NAME', 'A tournament needs a name.', { field: 'name' }) };
  }

  const status = trim(input.status).toLowerCase() || 'upcoming';
  if (!CREATE_STATUSES.includes(status)) {
    return { error: refused('INVALID_STATUS', 'That tournament status cannot be created.', { field: 'status' }) };
  }

  const entryFee = boundedNumber(input.entryFee, { min: 0, max: MAX_COINS, fallback: 0 });

  const tags = (Array.isArray(input.tags) ? input.tags : [])
    .map(tag => trim(tag).slice(0, MAX_TAG))
    .filter(Boolean)
    .slice(0, MAX_TAGS);

  const prizeTiers = (Array.isArray(input.prizeTiers) ? input.prizeTiers : [])
    .slice(0, MAX_PRIZE_TIERS)
    .map(tier => ({
      label: trim(tier && tier.label).slice(0, MAX_TAG),
      coins: boundedNumber(tier && tier.coins, { min: 0, max: MAX_COINS, fallback: 0 })
    }));

  return {
    values: {
      name,
      status,
      scheduledAt,
      modeId: trim(input.modeId),
      type: trim(input.type).toLowerCase().slice(0, 20) || 'solo',
      tags,
      prizeTiers,
      prizePool: boundedNumber(input.prizePool, { min: 0, max: MAX_COINS, fallback: 0 }),
      perKill: boundedNumber(input.perKill, { min: 0, max: MAX_COINS, fallback: 0 }),
      entryFee,
      // A paid entry and the "watch an ad to join" switch are mutually exclusive in the compose
      // screen, so the server applies the same rule rather than storing a contradictory pair.
      requiresAdToJoin: entryFee > 0 ? false : input.requiresAdToJoin === true,
      maxParticipants: boundedInt(input.maxParticipants, { min: 1, max: MAX_PARTICIPANTS, fallback: 48 }),
      imageUrl: text(input.imageUrl),
      spectateUrl: text(input.spectateUrl),
      roomId: text(input.roomId).slice(0, 64),
      roomPassword: text(input.roomPassword).slice(0, 64),
      mapName: text(input.mapName).slice(0, MAX_NAME),
      description: text(input.description),
      rules: text(input.rules),
      isActive: input.isActive !== false
    }
  };
}

/** Whether this organizer holds the tournaments module. Absent means no. */
function hasTournamentsPermission(account) {
  const permissions = account && account.permissions;
  return !!permissions && typeof permissions === 'object' &&
    permissions.perm_tournaments === true;
}

/**
 * @param {object} deps
 * @param {object} deps.db                 Firestore handle (Admin SDK)
 * @param {object} deps.economy            `createOrganizerEconomyService()` instance
 * @param {object} [deps.audit]            `createAuditTrail()` instance
 * @param {Function} deps.serverTimestamp  the server clock behind every written document
 * @param {Function} [deps.now]            injectable clock
 * @param {string|number} [deps.offsetMinutes] the day boundary, defaulting to UTC+05:30
 */
function createOrganizerTournamentIntakeService({
  db,
  economy,
  audit = null,
  serverTimestamp,
  now = () => Date.now(),
  offsetMinutes,
  maxAttempts = 3,
  collection = 'tournaments',
  organizerCollection = 'organizer_users',
  modeCollection = 'tournamentModes',
  counterCollection = 'tournament_counters',
  lockCollection = TALLY_COLLECTION
} = {}) {
  if (!db || !economy || !serverTimestamp) {
    throw new Error('createOrganizerTournamentIntakeService requires db, economy and serverTimestamp');
  }

  const parsedOffset = parseOffsetMinutes(offsetMinutes);
  const offset = parsedOffset === null ? DEFAULT_UTC_OFFSET_MINUTES : parsedOffset;

  const organizerRefOf = uid => db.collection(organizerCollection).doc(uid);
  const modeRefOf = id => db.collection(modeCollection).doc(id);
  const counterRefOf = id => db.collection(counterCollection).doc(id);
  const tournamentRefOf = id => db.collection(collection).doc(id);
  const lockRefOf = (uid, day) => db.collection(lockCollection).doc(`${uid}_${day}`);

  /** gRPC 10 / 'aborted': this transaction read something another one then committed. */
  function isAborted(error) {
    const code = error && error.code;
    return code === 10 || code === 'aborted' ||
      /aborted|concurrent transaction/i.test(String((error && error.message) || ''));
  }

  /** The created match as the route answers with it, and as the app reads it back. */
  function viewOf(id, data) {
    return {
      id,
      modeId: data.modeId,
      modeName: data.modeName,
      name: data.name,
      matchNumber: data.matchNumber,
      matchCode: data.matchCode,
      region: data.region,
      status: data.status,
      dateTime: toMillis(data.dateTime),
      createdAt: toMillis(data.createdAt),
      currentParticipants: data.currentParticipants || 0,
      maxParticipants: data.maxParticipants,
      entryFee: data.entryFee,
      prizePool: data.prizePool,
      isActive: data.isActive !== false
    };
  }

  /**
   * Create one match for the signed-in organizer.
   *
   * The request id is the caller's stable token: it becomes the document id, so a retried
   * submission after a dropped connection returns the match that was already created instead of
   * creating a second one and spending a second place in the day's allowance.
   */
  async function createTournament({ organizerUid, requestId, input = {}, actorEmail = '' } = {}) {
    const uid = trim(organizerUid);
    if (!uid || !SAFE_KEY.test(uid)) {
      return refused('ORGANIZER_UID_INVALID', 'A valid organizer account is required.');
    }

    const id = trim(requestId);
    if (!id || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
      return refused('REQUEST_ID_INVALID', 'A stable request id is required.', { retryable: false });
    }

    const normalized = normalize(input);
    if (normalized.error) return normalized.error;
    const values = normalized.values;

    const config = await economy.readConfig();
    const midnight = dayWindow(values.scheduledAt, offset);
    const day = dayLabel(midnight, values.scheduledAt);

    let attempts = 0;
    for (;;) {
      try {
        const outcome = await db.runTransaction(transaction => runOnce({
          transaction, uid, id, values, config, window: midnight, day
        }));
        if (outcome.code !== 'COMPLETE') return outcome;

        // The audit row is written after the match is committed. A failed audit write must not
        // turn a created match into an error the organizer would retry into a second one.
        const logged = await record(outcome, { uid, actorEmail, values });
        return {
          ...outcome,
          applied: !outcome.duplicate,
          auditRecorded: logged.recorded === true
        };
      } catch (error) {
        if (!isAborted(error) || ++attempts >= maxAttempts) {
          console.error('[OrganizerTournament] Create failed for', uid, '|', error.message);
          return refused('TRANSIENT_FAILURE',
            'The tournament could not be created. Try again.', { retryable: true });
        }
      }
    }
  }

  async function record(outcome, { uid, actorEmail, values }) {
    if (!audit) return { recorded: false, error: 'no audit trail wired' };
    return audit.record({
      section: 'tournaments',
      actionType: 'created',
      title: 'Tournament Created',
      payload: {
        tournamentId: outcome.tournamentId,
        tournamentName: values.name,
        tournamentModeId: outcome.tournament.modeId,
        tournamentModeName: outcome.tournament.modeName,
        matchNo: outcome.tournament.matchNumber,
        matchCode: outcome.tournament.matchCode,
        tournamentServer: outcome.tournament.region,
        dailyLimitDay: outcome.limit ? outcome.limit.day : null,
        dailyLimitUsed: outcome.limit ? outcome.limit.used : null,
        dailyLimitEffective: outcome.limit ? outcome.limit.effectiveLimit : null,
        duplicate: outcome.duplicate === true
      },
      performedBy: 'organizer',
      performerId: uid,
      performerEmail: trim(actorEmail)
    });
  }

  /** One attempt. Every read happens before the first write, as Firestore requires. */
  async function runOnce({ transaction, uid, id, values, config, window, day }) {
    const accountSnap = await transaction.get(organizerRefOf(uid));
    if (!accountSnap.exists) {
      return refused('NOT_AN_ORGANIZER', 'Only a registered organizer can create a tournament.');
    }
    const account = accountSnap.data() || {};
    if (account.banned === true) return refused('ORGANIZER_BANNED', 'This organizer account is banned.');
    if (account.isActive === false) {
      return refused('ORGANIZER_INACTIVE', 'This organizer account is deactivated.');
    }
    if (!hasTournamentsPermission(account)) {
      return refused('FORBIDDEN_PERMISSION',
        'This account does not have the tournaments module.');
    }

    const modeId = trim(values.modeId);
    if (!modeId) return refused('INVALID_MODE', 'A mode is required.', { field: 'modeId' });

    const modeSnap = await transaction.get(modeRefOf(modeId));
    if (!modeSnap.exists) return refused('MODE_NOT_FOUND', 'That mode no longer exists.');
    const mode = modeSnap.data() || {};

    const modeCode = trim(mode.modeCode);
    if (!MODE_CODE.test(modeCode)) {
      return refused('MODE_CODE_MISSING', 'This mode has no match code yet, so no match can use it.');
    }

    const region = serverCode(mode.region);
    const regions = Array.isArray(account.regions) ? account.regions : [DEFAULT_REGION];
    if (!regions.includes(region)) {
      return refused('ORGANIZER_SERVER_FORBIDDEN', 'You do not have this server.');
    }

    // An empty allowlist means every mode on the servers the organizer holds, exactly the
    // meaning `firestore.rules` already gives it.
    const allowedModes = Array.isArray(account.allowedModeIds) ? account.allowedModeIds : [];
    if (allowedModes.length > 0 && !allowedModes.includes(modeId)) {
      return refused('ORGANIZER_MODE_FORBIDDEN', 'You are not assigned to this mode.');
    }

    // A retried submission (same request id) answers with the match that already exists.
    const existingSnap = await transaction.get(tournamentRefOf(id));
    if (existingSnap.exists) {
      const existing = existingSnap.data() || {};
      if (trim(existing.createdByOrganizerUid) === uid) {
        return { code: 'COMPLETE', duplicate: true, tournamentId: id,
          tournament: viewOf(id, existing), limit: null,
          message: 'This tournament was already created.' };
      }
      return refused('REQUEST_ID_TAKEN', 'That request id is already in use.');
    }

    // ---- daily allowance -------------------------------------------------
    const effectiveLimit = effectiveLimitOf(
      config.defaultDailyTournamentLimit, account.dailyTournamentLimitOverride
    );

    // The lock document is read before the query and rewritten after it. It is not the count -
    // the count is derived, so a cancellation frees allowance and a reassignment moves it - it is
    // what makes two simultaneous creates conflict instead of both believing the day is empty.
    const lockSnap = effectiveLimit > 0 ? await transaction.get(lockRefOf(uid, day)) : null;

    let used = 0;
    if (effectiveLimit > 0) {
      const counted = await transaction.get(db.collection(collection)
        .where('dateTime', '>=', new Date(window.start))
        .where('dateTime', '<', new Date(window.end))
        .limit(MAX_DAY_SCAN));

      used = (counted.docs || [])
        .filter(document => countsToward({
          data: (document.data && document.data()) || {}, organizerUid: uid, window
        }))
        .length;

      if (used >= effectiveLimit) {
        return refused('DAILY_LIMIT_REACHED',
          `This organizer already has ${used} of ${effectiveLimit} tournaments scheduled on ${day}.`,
          {
            limit: {
              day,
              effectiveLimit,
              used,
              remaining: 0,
              offsetMinutes: window.offsetMinutes,
              startsAt: window.start,
              endsAt: window.end
            }
          });
      }
    }

    // ---- match number ----------------------------------------------------
    const counterSnap = await transaction.get(counterRefOf(modeId));
    const highestSnap = await transaction.get(db.collection(collection)
      .where('modeId', '==', modeId)
      .limit(MAX_DAY_SCAN));
    const highest = (highestSnap.docs || []).reduce((max, document) => {
      const data = (document.data && document.data()) || {};
      const number = Number(data.matchNumber);
      return Number.isFinite(number) && number > max ? number : max;
    }, 0);

    const counterLast = counterSnap.exists
      ? Number((counterSnap.data() || {}).lastMatchNumber)
      : NaN;
    const matchNumber = Number.isFinite(counterLast)
      ? counterLast + 1
      : (highest > 0 ? highest + 1 : 101);

    // ---- writes ----------------------------------------------------------
    const tournament = {
      id,
      modeId,
      modeName: trim(mode.modeName) || trim(mode.name),
      name: values.name,
      matchNumber,
      imageUrl: values.imageUrl,
      type: values.type,
      tags: values.tags,
      dateTime: new Date(values.scheduledAt),
      prizePool: values.prizePool,
      perKill: values.perKill,
      entryFee: values.entryFee,
      requiresAdToJoin: values.requiresAdToJoin,
      maxParticipants: values.maxParticipants,
      currentParticipants: 0,
      status: values.status,
      spectateUrl: values.spectateUrl,
      roomId: values.roomId,
      roomPassword: values.roomPassword,
      mapName: values.mapName,
      description: values.description,
      rules: values.rules,
      prizeTiers: values.prizeTiers,
      entryPassword: '',
      isActive: values.isActive,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      region,
      matchCode: matchCodeFor(region, modeCode, matchNumber),
      // Attribution is written by the server from the verified caller. An assignee is the admin
      // screen's field, so a create never pre-assigns a match to somebody else.
      createdByOrganizerUid: uid
    };

    transaction.set(tournamentRefOf(id), tournament);

    // One write covers both the first allocation on a mode and every allocation after it: a
    // merge creates the counter when it is missing and moves it when it is not.
    transaction.set(counterRefOf(modeId), {
      modeId,
      lastMatchNumber: matchNumber,
      updatedAt: serverTimestamp()
    }, { merge: true });

    if (effectiveLimit > 0) {
      transaction.set(lockRefOf(uid, day), {
        organizerUid: uid,
        day,
        // A record of the pass, not the authority: the next create recounts from matches.
        count: used + 1,
        ...(lockSnap && lockSnap.exists ? {} : { createdAt: serverTimestamp() }),
        updatedAt: serverTimestamp()
      }, { merge: true });
    }

    return {
      code: 'COMPLETE',
      duplicate: false,
      tournamentId: id,
      tournament: viewOf(id, tournament),
      limit: effectiveLimit > 0
        ? { day, effectiveLimit, used: used + 1, remaining: Math.max(0, effectiveLimit - (used + 1)),
          offsetMinutes: window.offsetMinutes }
        : { day, effectiveLimit: 0, used: null, remaining: null, unlimited: true,
          offsetMinutes: window.offsetMinutes }
    };
  }

  return { createTournament, matchCodeFor, normalize };
}

module.exports = {
  createOrganizerTournamentIntakeService,
  matchCodeFor,
  normalize,
  serverCode,
  CREATE_STATUSES,
  TALLY_COLLECTION,
  SAFE_KEY
};
