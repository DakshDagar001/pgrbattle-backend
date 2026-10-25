/**
 * Handing a match to an organizer, through the backend.
 *
 * ## What this replaces
 *
 * The Admin app used to write `assignedOrganizerUid` straight onto the match document. That is one
 * field and one write, but it is also the moment a match becomes somebody's responsibility - and
 * responsibility is what the daily allowance is counted from, what a deadline penalty is charged
 * to, and who is paid the completion reward. A write with no counting behind it meant an admin
 * could hand a fifth match to an organizer whose limit was four, and the limit would only be
 * noticed the next time that organizer tried to *create* one.
 *
 * So the assignment is a trusted operation now, and it answers three questions the Admin app could
 * not answer correctly on its own:
 *
 *   - is the target an organizer who may actually hold this match (module flag, active, not banned,
 *     their server, their mode allowlist)?
 *   - after this assignment, are they still inside the day's allowance, counted the way the create
 *     route counts it?
 *   - if the admin deliberately overrides that allowance, is the override recorded as a decision
 *     rather than as a silent success?
 *
 * ## Counting, and why it is the same count as creation
 *
 * Both this service and `organizerTournamentIntake` build the day from `dayWindow` at the same
 * offset, count with the same `countsToward`, read the same override, and touch the same
 * `organizer_daily_locks/{uid}_{day}` document inside their transaction. That last part is what
 * makes a create and an assignment for the same organizer and day conflict instead of both
 * believing the day has room. Cancelling a match frees a place for exactly the same reason: the
 * count is derived from the matches, not from a stored number.
 *
 * Clearing an assignment is not limited. Somebody has to be able to take work *off* an organizer
 * whose day is full - that is the recovery path, and it never adds anything.
 */

const {
  dayWindow,
  dayLabel,
  effectiveLimitOf,
  countsToward,
  parseOffsetMinutes,
  DEFAULT_UTC_OFFSET_MINUTES,
  NOT_PLAYED_STATUSES,
  MAX_DAY_SCAN
} = require('./organizerDailyLimits');

const DEFAULT_REGION = 'IN';
const SAFE_ID = /^[A-Za-z0-9_:.-]{1,200}$/;

function trim(value) {
  return typeof value === 'string' ? value.trim() : '';
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

function refused(code, message, extra = {}) {
  return { code, message, applied: false, ...extra };
}

function createOrganizerAssignments({
  db,
  economy,
  audit = null,
  serverTimestamp,
  now = () => Date.now(),
  offsetMinutes,
  maxAttempts = 3,
  collection = 'tournaments',
  organizerCollection = 'organizer_users',
  lockCollection = 'organizer_daily_locks'
} = {}) {
  if (!db || !economy || !serverTimestamp) {
    throw new Error('createOrganizerAssignments requires db, economy and serverTimestamp');
  }

  const parsedOffset = parseOffsetMinutes(offsetMinutes);
  const offset = parsedOffset === null ? DEFAULT_UTC_OFFSET_MINUTES : parsedOffset;

  const tournamentRefOf = id => db.collection(collection).doc(id);
  const organizerRefOf = uid => db.collection(organizerCollection).doc(uid);
  const lockRefOf = (uid, day) => db.collection(lockCollection).doc(`${uid}_${day}`);

  function isAborted(error) {
    const code = error && error.code;
    return code === 10 || code === 'aborted' ||
      /aborted|concurrent transaction/i.test(String((error && error.message) || ''));
  }

  /**
   * Assign the match to `organizerUid`, or clear the assignment when it is blank.
   *
   * `override` is a deliberate, recorded admin decision: the limit is still reported in the answer,
   * so the screen can say what was overridden, and the audit row says who decided it.
   */
  async function assign({
    tournamentId,
    organizerUid = '',
    adminUid = '',
    adminEmail = '',
    override = false,
    reason = ''
  } = {}) {
    const matchId = trim(tournamentId);
    if (!matchId || !SAFE_ID.test(matchId)) {
      return refused('TOURNAMENT_ID_INVALID', 'A valid match is required.');
    }
    const target = trim(organizerUid);
    if (target && !SAFE_ID.test(target)) {
      return refused('ORGANIZER_UID_INVALID', 'That is not an organizer id.');
    }

    const config = await economy.readConfig();

    let attempts = 0;
    for (;;) {
      try {
        const outcome = await db.runTransaction(transaction => runOnce({
          transaction, matchId, target, config, override: override === true, adminUid
        }));
        if (outcome.code !== 'COMPLETE') return outcome;

        const logged = await record(outcome, { adminUid, adminEmail, reason });
        return { ...outcome, auditRecorded: logged.recorded === true };
      } catch (error) {
        if (!isAborted(error) || ++attempts >= maxAttempts) {
          console.error('[OrganizerAssignments] Assign failed for', matchId, '|', error.message);
          return refused('TRANSIENT_FAILURE', 'The assignment could not be saved. Try again.',
            { retryable: true });
        }
      }
    }
  }

  /** One attempt. Every read happens before the first write, as Firestore requires. */
  async function runOnce({ transaction, matchId, target, config, override, adminUid }) {
    const matchSnap = await transaction.get(tournamentRefOf(matchId));
    if (!matchSnap.exists) {
      return refused('TOURNAMENT_NOT_FOUND', 'That match no longer exists.');
    }
    const match = matchSnap.data() || {};

    const previousAssignee = trim(match.assignedOrganizerUid);
    const previousCreator = trim(match.createdByOrganizerUid);

    // ---- clearing -------------------------------------------------------
    if (!target) {
      if (previousAssignee === '') {
        return { code: 'COMPLETE', applied: false, unchanged: true, tournamentId: matchId,
          organizerUid: null, limit: null };
      }
      transaction.set(tournamentRefOf(matchId), {
        assignedOrganizerUid: null,
        assignmentClearedAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      }, { merge: true });
      return {
        code: 'COMPLETE', applied: true, tournamentId: matchId, organizerUid: null,
        previousAssignee: previousAssignee || null, limit: null
      };
    }

    // ---- the target still has to be an organizer for this match ----------
    const accountSnap = await transaction.get(organizerRefOf(target));
    if (!accountSnap.exists) {
      return refused('NOT_AN_ORGANIZER', 'Only a registered organizer can be given a match.');
    }
    const account = accountSnap.data() || {};
    if (account.banned === true) return refused('ORGANIZER_BANNED', 'This organizer is banned.');
    if (account.isActive === false) {
      return refused('ORGANIZER_INACTIVE', 'This organizer account is deactivated.');
    }
    if (!(account.permissions && account.permissions.perm_tournaments === true)) {
      return refused('FORBIDDEN_PERMISSION',
        'This organizer does not hold the tournaments module.');
    }

    const region = trim(match.region) || DEFAULT_REGION;
    const regions = Array.isArray(account.regions) ? account.regions : [DEFAULT_REGION];
    if (!regions.includes(region)) {
      return refused('ORGANIZER_SERVER_FORBIDDEN', 'This organizer does not have this server.');
    }

    const modeId = trim(match.modeId);
    const allowedModes = Array.isArray(account.allowedModeIds) ? account.allowedModeIds : [];
    if (allowedModes.length > 0 && !allowedModes.includes(modeId)) {
      return refused('ORGANIZER_MODE_FORBIDDEN', 'This organizer is not assigned to this mode.');
    }

    if (previousAssignee === target) {
      return { code: 'COMPLETE', applied: false, unchanged: true, tournamentId: matchId,
        organizerUid: target, limit: null };
    }

    // ---- the day's allowance --------------------------------------------
    const scheduledAt = toMillis(match.dateTime);
    if (scheduledAt === null) {
      return refused('SCHEDULE_MISSING',
        'This match has no start time, so the day it belongs to cannot be decided.');
    }

    const window = dayWindow(scheduledAt, offset);
    const day = dayLabel(window, scheduledAt);
    const effectiveLimit = effectiveLimitOf(
      config.defaultDailyTournamentLimit, account.dailyTournamentLimitOverride
    );

    const status = trim(match.status).toLowerCase();
    const playedOrPlanned = !NOT_PLAYED_STATUSES.includes(status) && match.isActive !== false;

    let used = 0;
    let limit = null;

    // A match that is cancelled or removed occupies no place, so moving it to somebody costs
    // nothing and must not be blocked by a full day.
    if (effectiveLimit > 0 && playedOrPlanned) {
      // The same mutex document the create route writes, read here so a create and an assignment
      // for the same organizer and day conflict instead of both seeing room.
      await transaction.get(lockRefOf(target, day));

      const counted = await transaction.get(db.collection(collection)
        .where('dateTime', '>=', new Date(window.start))
        .where('dateTime', '<', new Date(window.end))
        .limit(MAX_DAY_SCAN));

      used = (counted.docs || [])
        .filter(document => document.id !== matchId)
        .filter(document => countsToward({
          data: (document.data && document.data()) || {}, organizerUid: target, window
        }))
        .length;

      limit = {
        day,
        effectiveLimit,
        used,
        remaining: Math.max(0, effectiveLimit - used),
        offsetMinutes: window.offsetMinutes,
        startsAt: window.start,
        endsAt: window.end
      };

      if (used >= effectiveLimit && !override) {
        return refused('DAILY_LIMIT_REACHED',
          `This organizer already has ${used} of ${effectiveLimit} tournaments scheduled on ${day}.`,
          { limit: { ...limit, remaining: 0 }, overrideAvailable: true });
      }
    } else if (effectiveLimit > 0) {
      limit = { day, effectiveLimit, used: null, remaining: null, offsetMinutes: window.offsetMinutes,
        startsAt: window.start, endsAt: window.end, notCounted: 'this match is cancelled or removed' };
    } else {
      limit = { day, effectiveLimit: 0, used: null, remaining: null, unlimited: true,
        offsetMinutes: window.offsetMinutes };
    }

    transaction.set(tournamentRefOf(matchId), {
      assignedOrganizerUid: target,
      assignedByUid: trim(adminUid) || null,
      assignedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    }, { merge: true });

    if (effectiveLimit > 0 && playedOrPlanned) {
      transaction.set(lockRefOf(target, day), {
        organizerUid: target,
        day,
        count: used + 1,
        updatedAt: serverTimestamp()
      }, { merge: true });
    }

    return {
      code: 'COMPLETE',
      applied: true,
      tournamentId: matchId,
      organizerUid: target,
      previousAssignee: previousAssignee || null,
      previousCreator: previousCreator || null,
      overridden: override === true && used >= effectiveLimit,
      limit
    };
  }

  async function record(outcome, { adminUid, adminEmail, reason }) {
    if (!audit) return { recorded: false, error: 'no audit trail wired' };
    return audit.record({
      section: 'tournaments',
      actionType: outcome.organizerUid
        ? (outcome.overridden ? 'organizer_assignment_override' : 'organizer_assigned')
        : 'organizer_unassigned',
      title: outcome.organizerUid ? 'Tournament Assigned' : 'Tournament Unassigned',
      payload: {
        tournamentId: outcome.tournamentId,
        organizerUid: outcome.organizerUid,
        previousAssignee: outcome.previousAssignee || null,
        dailyLimitDay: outcome.limit ? outcome.limit.day : null,
        dailyLimitEffective: outcome.limit ? outcome.limit.effectiveLimit : null,
        dailyLimitUsed: outcome.limit ? outcome.limit.used : null,
        overridden: outcome.overridden === true,
        reason: trim(reason) || null,
        unchanged: outcome.unchanged === true
      },
      performedBy: 'admin',
      performerId: trim(adminUid),
      performerEmail: trim(adminEmail)
    });
  }

  return { assign };
}

module.exports = { createOrganizerAssignments };
