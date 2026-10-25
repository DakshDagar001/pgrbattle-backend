/**
 * The daily tournament allowance, evaluated on the trusted backend.
 *
 * ## What this is, and what it is not
 *
 * Phase 6 asks for a limit to be enforced "on the trusted backend at the point where a new
 * tournament is created or an existing tournament is reassigned". That point does not exist
 * yet: match creation in this project is a client-side Firestore transaction in both the
 * Organizer and the Admin compose screens, so there is no backend call to refuse. Building a
 * counter the client would have to maintain itself is exactly the non-atomic shortcut the
 * phase forbids, and it can be bypassed by any client that simply does not read it.
 *
 * So this service answers the question that does not depend on that migration - "how much of
 * today's allowance has this organizer used, and what is left" - from stored data, with the
 * rules a future trusted create or reassign path would reuse unchanged. It is read-only by
 * design. Nothing here claims to stop a match being created, and no screen may say that it
 * does; the Organizer app states plainly that the allowance is not yet enforced at creation.
 *
 * ## The counting policy, and where each part comes from
 *
 * - **Which day.** The local day of the match's *scheduled start*, `dateTime`. That is the
 *   field the compose screens actually write and the same field the deadline sweep judges, so
 *   the allowance and the penalty agree about when a match is meant to happen. A day is
 *   midnight to midnight at UTC+05:30, which is the offset the notification scheduler already
 *   documents for this project (`NOTIFICATION_UTC_OFFSET`, `NOTIFICATION_TIMEZONE`) rather than
 *   a timezone invented here; it is overridable the same way.
 * - **Whose match.** `assignedOrganizerUid` first, then `createdByOrganizerUid` - the identical
 *   order `organizerPenalties.js` uses to decide who answers for a missed deadline, so the two
 *   features never disagree about who a match belongs to. A match is counted for exactly one
 *   organizer, never for both.
 * - **Reassignment.** Because the count is derived from the attribution fields as they are now,
 *   reassigning a match moves it from the previous organizer's day into the new one's. Reuse
 *   is not a loophole: an organizer cannot dodge a limit by handing work over, because the
 *   match leaves their count and the receiving organizer gains it.
 * - **What does not count.** A match whose status is `cancelled` or `removed`, and one marked
 *   `isActive: false` - the same two signals the lifecycle uses for "this will not be played".
 *   Those need no organizer to run them, so charging an allowance for them would refuse an
 *   organizer work they no longer have.
 * - **A limit of zero means no limit has been chosen**, which is what the settings document
 *   already means by it. It is never read as "this organizer may run no matches"; barring an
 *   organizer is the job of the server and mode grants on the same record.
 */

// Reused rather than re-decided: this is the exact attribution rule the deadline penalty uses,
// so the allowance and the penalty can never disagree about who a match belongs to.
const { resolveResponsible } = require('./organizerPenalties');

/** The states in which a match no longer needs anybody to run it. */
const NOT_PLAYED_STATUSES = ['cancelled', 'removed'];

/**
 * The day boundary as a UTC offset in minutes. 330 is +05:30, the value the notification
 * routes document for this project, so "today" means the same local day on both features.
 */
const DEFAULT_UTC_OFFSET_MINUTES = 330;
// The widest offsets any populated zone can hold, so a malformed environment value cannot move
// a day by more than reality allows.
const MAX_OFFSET_MINUTES = 840;

/** A per-organizer override outside the range the Admin screen can offer is not an override. */
const MIN_LIMIT = 0;
const MAX_LIMIT = 1000;

/**
 * A limit is a whole count, or it is not a limit.
 *
 * Firestore returns an `int` as a JavaScript number, so anything else - a decimal, a string,
 * a boolean, a number outside the range the Admin economy rules allow - is not the shape a
 * stored limit can legally have. It is read as "no limit configured here" rather than coerced
 * into one, which is the same refusal `firestore.rules` applies to the field on a write.
 */
function wholeLimit(value) {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= MIN_LIMIT &&
    value <= MAX_LIMIT
    ? value
    : 0;
}

/** How far a day's matches are scanned, so one read cannot be made unbounded by history. */
const MAX_DAY_SCAN = 500;

// The two coercions every service in this directory keeps to itself.
function trim(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** A Firestore Timestamp, a Date, a number of milliseconds, or nothing at all. */
function toMillis(value) {
  if (!value) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value.toDate === 'function') {
    try {
      const ms = value.toDate().getTime();
      return Number.isFinite(ms) ? ms : null;
    } catch (error) {
      return null;
    }
  }
  if (typeof value.seconds === 'number') {
    return value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1e6);
  }
  return null;
}

/**
 * `"+05:30"` and `"-0800"` and `"330"` all mean an offset. Anything else is ignored rather
 * than guessed at, because a wrong offset silently moves matches into the wrong day.
 */
function parseOffsetMinutes(raw) {
  const value = trim(String(raw === undefined || raw === null ? '' : raw));
  if (!value) return null;

  const colonless = value.replace(':', '');
  const signed = /^([+-])(\d{2})(\d{2})$/.exec(colonless);
  if (signed) {
    const hours = Number(signed[2]);
    const minutes = Number(signed[3]);
    if (hours > 14 || minutes > 59) return null;
    const total = hours * 60 + minutes;
    return signed[1] === '-' ? -total : total;
  }

  const bare = /^(-?\d{1,4})$/.exec(value);
  if (bare) {
    const total = Number(bare[1]);
    return Math.abs(total) <= MAX_OFFSET_MINUTES ? total : null;
  }
  return null;
}

/**
 * The local day containing `atMillis`, as an exact `[start, end)` pair in UTC milliseconds.
 *
 * The arithmetic is done on a shifted clock rather than with a calendar API so the result does
 * not depend on the server's own timezone - Render runs UTC, and a "today" that changed with
 * the host's clock would be a bug an organizer could never predict.
 */
function dayWindow(atMillis, offsetMinutes = DEFAULT_UTC_OFFSET_MINUTES) {
  const offset = Number.isFinite(offsetMinutes) ? offsetMinutes : DEFAULT_UTC_OFFSET_MINUTES;
  const shifted = atMillis + offset * 60000;
  const shiftedStart = Math.floor(shifted / 86400000) * 86400000;
  const start = shiftedStart - offset * 60000;
  return { start, end: start + 86400000, offsetMinutes: offset };
}

/** The day label an organizer reads, in the same shifted clock the window used. */
function dayLabel(window, atMillis) {
  const shifted = new Date(atMillis + window.offsetMinutes * 60000);
  return [
    String(shifted.getUTCFullYear()),
    String(shifted.getUTCMonth() + 1).padStart(2, '0'),
    String(shifted.getUTCDate()).padStart(2, '0')
  ].join('-');
}

/** The limit that applies to one organizer: their own override, or the configured default. */
function effectiveLimitOf(defaultLimit, override) {
  const own = wholeLimit(override);
  return own > 0 ? own : wholeLimit(defaultLimit);
}

/**
 * Whether one stored match takes a place in somebody's day.
 *
 * The scheduled start has to be inside the window, the match still has to be going to be
 * played, and it has to name the organizer whose day is being counted. A match with no
 * scheduled time is not counted anywhere rather than guessed into today.
 */
function countsToward({ data, organizerUid, window }) {
  if (!data || typeof data !== 'object') return false;

  const scheduledAt = toMillis(data.dateTime);
  if (scheduledAt === null) return false;
  if (scheduledAt < window.start || scheduledAt >= window.end) return false;

  const status = trim(data.status).toLowerCase();
  if (NOT_PLAYED_STATUSES.includes(status)) return false;
  if (data.isActive === false) return false;

  // The same one-name answer the penalty service gives, applied to counting: a match belongs
  // to the organizer the platform last told to run it, and to nobody else.
  const responsible = resolveResponsible(data);
  if (!responsible.organizerUid) return false;
  return responsible.organizerUid === organizerUid;
}

/**
 * The allowance, the usage and what is left - from a set of already-read matches.
 *
 * Exported separately from the service because this is the part that has to be right, and it
 * is pure: the same stored documents always produce the same answer, whatever clock or index
 * the caller used to fetch them.
 */
function summarizeLimit({ defaultLimit, override, matches, organizerUid, atMillis, offsetMinutes }) {
  const offset = Number.isFinite(offsetMinutes) ? offsetMinutes : DEFAULT_UTC_OFFSET_MINUTES;
  const window = dayWindow(atMillis, offset);
  const configuredDefaultLimit = wholeLimit(defaultLimit);
  const overrideLimit = wholeLimit(override);
  const effectiveLimit = effectiveLimitOf(defaultLimit, override);

  const counted = (Array.isArray(matches) ? matches : [])
    .filter(match => countsToward({ data: match && match.data, organizerUid, window }))
    .map(match => ({
      tournamentId: trim(match.id),
      scheduledAt: toMillis(match.data.dateTime),
      status: trim(match.data.status).toLowerCase() || 'upcoming',
      basis: resolveResponsible(match.data).basis
    }))
    .sort((a, b) => a.scheduledAt - b.scheduledAt);

  // No limit chosen is not a limit of zero: the allowance is unlimited, and a screen saying
  // "0 matches remaining" would tell an organizer they are blocked when nobody blocked them.
  const unlimited = effectiveLimit <= 0;

  return {
    organizerUid,
    day: dayLabel(window, atMillis),
    window: { start: window.start, end: window.end, offsetMinutes: window.offsetMinutes },
    configuredDefaultLimit,
    overrideLimit,
    effectiveLimit,
    unlimited,
    used: counted.length,
    remaining: unlimited ? null : Math.max(0, effectiveLimit - counted.length),
    reached: unlimited ? false : counted.length >= effectiveLimit,
    matches: counted
  };
}

/**
 * @param {object} deps
 * @param {object} deps.db                Firestore handle (Admin SDK)
 * @param {object} deps.economy           `createOrganizerEconomyService()` instance
 * @param {Function} [deps.now]           injectable clock, so "today" is testable
 * @param {number} [deps.offsetMinutes]   the day boundary, defaulting to the documented +05:30
 * @param {string} [deps.collection]      tournaments collection override (tests)
 */
function createOrganizerDailyLimitService({
  db,
  economy,
  now = () => Date.now(),
  offsetMinutes,
  maxDayScan = MAX_DAY_SCAN,
  collection = 'tournaments'
} = {}) {
  if (!db || !economy) {
    throw new Error('createOrganizerDailyLimitService requires db and economy');
  }

  const parsedOffset = parseOffsetMinutes(offsetMinutes);
  const offset = parsedOffset === null ? DEFAULT_UTC_OFFSET_MINUTES : parsedOffset;
  const scanLimit = Math.max(1, Number(maxDayScan) || MAX_DAY_SCAN);

  /**
   * The organizer's own allowance for the day containing `atMillis`.
   *
   * The uid is always the verified caller: this takes no organizer identity from a request
   * body, because one that did would let any signed-in account read somebody else's schedule.
   */
  async function summarize({ organizerUid, atMillis } = {}) {
    const uid = trim(organizerUid);
    if (!uid) {
      return { code: 'ORGANIZER_UID_INVALID', message: 'A valid organizer account is required.' };
    }

    const clock = Number(atMillis);
    const nowMs = Number.isFinite(clock) ? clock : now();

    const organizerDoc = await db.collection('organizer_users').doc(uid).get();

    // Only an account this platform registers as an organizer has an allowance to ask about.
    // A signed-in player who reaches this endpoint is refused rather than shown a configured
    // default that means nothing to them, which is how the withdrawal route already treats the
    // same caller. A deactivated organizer is still an organizer and still gets an answer.
    if (!organizerDoc.exists) {
      return {
        code: 'NOT_AN_ORGANIZER',
        message: 'A daily tournament allowance belongs to an organizer account.'
      };
    }

    const config = await economy.readConfig();
    const organizerData = organizerDoc.data() || {};
    const override = organizerData.dailyTournamentLimitOverride;

    const window = dayWindow(nowMs, offset);

    // The only query is the range a day is bounded by, so no composite index is required for
    // a read that has to work the same on every deployment. Attribution is filtered in memory,
    // which keeps this correct against matches written before the attribution fields existed.
    const snapshot = await db.collection(collection)
      .where('dateTime', '>=', new Date(window.start))
      .where('dateTime', '<', new Date(window.end))
      .limit(scanLimit)
      .get();

    const matches = (snapshot.docs || []).map(document => ({
      id: document.id,
      data: document.data() || {}
    }));

    return {
      code: 'COMPLETE',
      ...summarizeLimit({
        defaultLimit: config.defaultDailyTournamentLimit,
        override,
        matches,
        organizerUid: uid,
        atMillis: nowMs,
        offsetMinutes: offset
      })
    };
  }

  return { summarize, summarizeLimit, dayWindow, effectiveLimitOf, countsToward };
}

module.exports = {
  createOrganizerDailyLimitService,
  summarizeLimit,
  dayWindow,
  dayLabel,
  effectiveLimitOf,
  countsToward,
  parseOffsetMinutes,
  wholeLimit,
  DEFAULT_UTC_OFFSET_MINUTES,
  NOT_PLAYED_STATUSES,
  MAX_LIMIT,
  MAX_DAY_SCAN
};
