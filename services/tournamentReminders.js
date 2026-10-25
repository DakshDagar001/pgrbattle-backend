/**
 * Tournament start reminders.
 *
 * ## What was wrong
 *
 * This job used to live in `server.js` and query
 *
 *     where("startTime", ">=", now).where("startTime", "<=", future)
 *
 * `startTime` is a field no client in this project has ever written. The Organizer compose screen
 * writes `dateTime`, the Player model deserialises `dateTime`, and the deadline sweep already
 * judges `dateTime`. A query for a field that does not exist matches nothing, so this cron has
 * never sent a reminder - a code-level bug, not a missing provider or a policy question, and it is
 * fixed here rather than reported.
 *
 * ## What it does now
 *
 * One bounded query over matches whose `dateTime` falls inside the widest reminder window, then a
 * decision per match:
 *
 *   - only `status == "upcoming"` matches are considered. That is the status the Organizer app
 *     writes for "scheduled and not started", and it is the same vocabulary the deadline sweep
 *     charges on, so a cancelled, removed, ongoing or finished match is never reminded.
 *   - `isActive === false` is a second refusal, because cancelling and removing both write it and
 *     a legacy match left inactive is one the organizer has finished with.
 *   - from the milestones this project publishes (60, 30 and 5 minutes) the *tightest one that has
 *     already come* is chosen. A match four minutes away therefore produces one "starts in 5
 *     minutes" notification, not three at once - the behaviour a reader expects from a reminder,
 *     and the behaviour the old per-offset loop would have produced the moment it started working.
 *
 * ## Why a match cannot be reminded twice
 *
 * The scheduler runs on a timer and may run on more than one instance, so "check then send" is a
 * race. Each milestone is therefore *claimed* before the notification is sent, by creating a
 * document at `tournaments/{id}/reminder_claims/{minutes}`. A create is atomic: of two passes that
 * both decide to remind the same match, exactly one gets the document and the other is told it
 * already exists. The claim is taken after re-reading the match, so a match cancelled between the
 * window query and the claim is not reminded at all. If the send itself fails the claim is deleted,
 * so a transient provider error is retried on the next pass rather than silently eating the
 * reminder - and the milestone is never marked as sent when nobody received it.
 *
 * The document is the record, rather than an array field on the match, precisely because appending
 * to an array needs a read-modify-write that two passes can interleave. A create cannot.
 *
 * The time a reminder is *about* is formatted at the notification offset this project already
 * publishes (`NOTIFICATION_UTC_OFFSET`, +05:30 by default). The same offset is what decides which
 * calendar day a tournament belongs to elsewhere, so the time in a reminder and the time on a
 * screen cannot disagree.
 */

const { parseOffsetMinutes, DEFAULT_UTC_OFFSET_MINUTES } = require('./organizerDailyLimits');

/** The collection this job reads and stamps. */
const TOURNAMENT_COLLECTION = 'tournaments';

/** Where a sent milestone is recorded, one document per match and milestone. */
const CLAIM_COLLECTION = 'reminder_claims';

/** The only status that means "scheduled and not started". */
const SCHEDULED_STATUS = 'upcoming';

/** The milestones this project has always published, in minutes before the start. */
const REMINDER_OFFSETS = [60, 30, 5];

/** How many matches one pass will consider. A pass is a schedule tick, not a migration. */
const MAX_SCAN = 200;

/** The event and copy the notification engine already uses for this reminder. */
const EVENT = 'tournament_reminder';
const ENTITY = 'tournament';
const TEMPLATE = { title: 'Tournament Reminder', body: '{{TOURNAMENT_NAME}} starts in {{MINUTES}} minutes' };

function trim(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** The millisecond value of a Firestore timestamp, a Date, or a number. */
function millisOf(value) {
  if (!value) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value.toMillis === 'function') {
    const ms = value.toMillis();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value.toDate === 'function') {
    const ms = value.toDate().getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value.seconds === 'number') {
    return value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1e6);
  }
  return null;
}

/**
 * The milestone a match is due, or null when it is not inside the window yet.
 *
 * `offsets` may arrive in any order; the answer is the same, because the smallest milestone that
 * is at least `minutesUntil` is the tightest one that has come.
 */
function dueOffset(minutesUntil, offsets = REMINDER_OFFSETS) {
  if (!Number.isFinite(minutesUntil) || minutesUntil < 0) return null;
  const sorted = [...offsets].filter(Number.isFinite).sort((left, right) => left - right);
  for (const offset of sorted) {
    if (minutesUntil <= offset) return offset;
  }
  return null;
}

/** What the reminder says the match's start time is, on the project's own clock. */
function localStart(value, offsetMinutes) {
  const ms = millisOf(value);
  if (ms === null) return { date: '', time: '' };
  const offset = Number.isFinite(offsetMinutes) ? offsetMinutes : DEFAULT_UTC_OFFSET_MINUTES;
  // Shifting the instant and reading it back in UTC gives the wall clock at that offset without
  // depending on the server's locale or on ICU timezone data being present.
  const shifted = new Date(ms + offset * 60000);
  const pad = number => String(number).padStart(2, '0');
  return {
    date: `${pad(shifted.getUTCDate())}/${pad(shifted.getUTCMonth() + 1)}/${shifted.getUTCFullYear()}`,
    time: `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`
  };
}

/** An ALREADY_EXISTS from `create`, whichever SDK shape raised it. */
function isAlreadyExists(error) {
  if (!error) return false;
  if (error.code === 6 || error.code === 'already-exists') return true;
  return /ALREADY_EXISTS|already exists/i.test(String(error.message || ''));
}

/**
 * @param {object} deps
 * @param {object} deps.db            Firestore handle (Admin SDK)
 * @param {Function} deps.notify      the notification engine's `notifyByEvent`
 * @param {Function} [deps.now]       clock, injectable so "the window" is testable
 * @param {string|number} [deps.offsetMinutes] the project's notification offset
 */
function createTournamentReminders({
  db,
  notify,
  now = () => new Date(),
  offsetMinutes = process.env.NOTIFICATION_UTC_OFFSET
} = {}) {
  if (!db) throw new Error('createTournamentReminders requires db');
  if (typeof notify !== 'function') throw new Error('createTournamentReminders requires notify');

  const parsedOffset = parseOffsetMinutes(offsetMinutes);
  const offset = parsedOffset === null ? DEFAULT_UTC_OFFSET_MINUTES : parsedOffset;
  const widest = Math.max(...REMINDER_OFFSETS);

  const refOf = id => db.collection(TOURNAMENT_COLLECTION).doc(id);
  const claimRefOf = (id, milestone) => refOf(id)
    .collection(CLAIM_COLLECTION).doc(String(milestone));

  /**
   * Take the milestone for this match, or report that somebody else already has it.
   *
   * The match is re-read first, because the window query may be a few seconds old and cancelling a
   * match is exactly the thing that must not be followed by "your match starts in 5 minutes".
   * Then `create` decides the race: it is a single atomic operation, not a read followed by a write.
   */
  async function claim(id, milestone) {
    const snapshot = await refOf(id).get();
    if (!snapshot.exists) return false;

    const data = snapshot.data() || {};
    // The match may have been cancelled or removed between the query and this claim.
    if (trim(data.status) !== SCHEDULED_STATUS || data.isActive === false) return false;

    try {
      await claimRefOf(id, milestone).create({
        tournamentId: id,
        offsetMinutes: milestone,
        claimedAt: now()
      });
      return true;
    } catch (error) {
      if (isAlreadyExists(error)) return false;
      throw error;
    }
  }

  /** Give a claim back after a failed send, so the next pass can try again. */
  async function release(id, milestone) {
    try {
      await claimRefOf(id, milestone).delete();
    } catch (error) {
      // A claim that cannot be released costs one missed reminder; it cannot cause a duplicate,
      // because the claim is still there.
      console.error('[TournamentReminders] Release failed for', id, milestone, '|', error.message);
    }
  }

  /**
   * One pass. Safe to call from a timer, from more than one instance, or twice by accident.
   *
   * Returns a summary rather than throwing, so the scheduler can log "nothing due" every five
   * minutes without a stack trace and a real failure is still visible in the counts.
   */
  async function runOnce() {
    const at = now();
    const nowMs = at.getTime();
    const summary = { scanned: 0, sent: 0, skipped: 0, alreadySent: 0, failed: 0 };

    let snapshot;
    try {
      snapshot = await db.collection(TOURNAMENT_COLLECTION)
        .where('status', '==', SCHEDULED_STATUS)
        // `dateTime` is the field the compose screens write and the Player app reads. This is the
        // whole fix: the old query asked for `startTime`, which no client writes.
        .where('dateTime', '>=', new Date(nowMs))
        .where('dateTime', '<=', new Date(nowMs + widest * 60000))
        .limit(MAX_SCAN)
        .get();
    } catch (error) {
      console.error('[TournamentReminders] Query failed:', error.message);
      return { code: 'QUERY_FAILED', summary };
    }

    const documents = snapshot.docs || [];
    for (const document of documents) {
      summary.scanned += 1;
      const data = document.data() || {};

      const startMillis = millisOf(data.dateTime);
      if (startMillis === null) {
        // A match with no usable start time cannot be "starting in N minutes".
        summary.skipped += 1;
        continue;
      }
      if (data.isActive === false) {
        summary.skipped += 1;
        continue;
      }

      const minutesUntil = (startMillis - nowMs) / 60000;
      const milestone = dueOffset(minutesUntil, REMINDER_OFFSETS);
      if (milestone === null) {
        summary.skipped += 1;
        continue;
      }

      // The claim is the authority: a milestone another pass already sent is refused here.
      let claimed = false;
      try {
        claimed = await claim(document.id, milestone);
      } catch (error) {
        console.error('[TournamentReminders] Claim failed for', document.id, '|', error.message);
        summary.failed += 1;
        continue;
      }
      if (!claimed) {
        summary.alreadySent += 1;
        continue;
      }

      const start = localStart(data.dateTime, offset);
      try {
        await notify(
          EVENT,
          ENTITY,
          document.id,
          {
            TOURNAMENT_NAME: trim(data.name) || 'Tournament',
            MINUTES: milestone,
            DATE: start.date,
            TIME: start.time,
            deepLink: `pgr://tournament/${document.id}`
          },
          TEMPLATE
        );
        summary.sent += 1;
      } catch (error) {
        console.error('[TournamentReminders] Notify failed for', document.id, '|', error.message);
        summary.failed += 1;
        await release(document.id, milestone);
      }
    }

    return { code: 'COMPLETE', summary };
  }

  return {
    runOnce,
    claim,
    release,
    offsetMinutes: offset,
    collection: TOURNAMENT_COLLECTION,
    offsets: [...REMINDER_OFFSETS]
  };
}

module.exports = {
  createTournamentReminders,
  tournamentReminderOffset: () => {
    const parsed = parseOffsetMinutes(process.env.NOTIFICATION_UTC_OFFSET);
    return parsed === null ? DEFAULT_UTC_OFFSET_MINUTES : parsed;
  },
  dueOffset,
  localStart,
  millisOf,
  TOURNAMENT_COLLECTION,
  CLAIM_COLLECTION,
  SCHEDULED_STATUS,
  REMINDER_OFFSETS,
  MAX_SCAN,
  EVENT,
  ENTITY,
  TEMPLATE
};
