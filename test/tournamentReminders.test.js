/**
 * Phase 10: the tournament reminder job.
 *
 * The bug this suite locks down is small and total: the job queried `tournaments.startTime`, and
 * nothing in this project has ever written that field. The first test below is the regression - a
 * match stored exactly the way the Organizer compose screen stores one is reminded, and a match
 * carrying only the old field name is not, because that field is not the schedule.
 *
 * The rest is about the two ways a timer-driven job misbehaves once it does match rows: it must not
 * remind a match that has been cancelled or removed, and it must not remind the same match twice
 * because the scheduler ran twice or restarted.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createTournamentReminders,
  dueOffset,
  localStart,
  REMINDER_OFFSETS,
  SCHEDULED_STATUS,
  TOURNAMENT_COLLECTION,
  CLAIM_COLLECTION
} = require('../services/tournamentReminders');
const { createFakeFirestore } = require('./helpers/fakeFirestore');

const NOW = Date.parse('2026-10-21T12:00:00.000Z');
const minutes = count => count * 60000;

/** Where a match's milestone record lives. Subcollections are keyed by their full path. */
const claimsOf = id => `${TOURNAMENT_COLLECTION}/${id}/${CLAIM_COLLECTION}`;

/** A match as the Organizer compose screen writes one: `dateTime`, status `upcoming`. */
function match(over = {}) {
  return {
    name: 'PGR Showdown',
    status: SCHEDULED_STATUS,
    isActive: true,
    dateTime: new Date(NOW + minutes(20)),
    ...over
  };
}

function harness(seed = {}, { failFirstSend = false } = {}) {
  const db = createFakeFirestore({ [TOURNAMENT_COLLECTION]: seed });
  const calls = [];
  let sends = 0;
  const notify = async (event, entity, id, variables, template) => {
    sends += 1;
    if (failFirstSend && sends === 1) throw new Error('provider unavailable');
    calls.push({ event, entity, id, variables, template });
  };
  const reminders = createTournamentReminders({
    db,
    notify,
    now: () => new Date(NOW),
    offsetMinutes: '+05:30'
  });
  return { db, calls, reminders };
}

// ==========================================================================
// The field the schedule is actually stored in
// ==========================================================================

test('a match scheduled with dateTime is reminded', async () => {
  const { calls, reminders } = harness({ 'match-1': match() });

  const result = await reminders.runOnce();
  assert.equal(result.code, 'COMPLETE');
  assert.equal(result.summary.sent, 1);
  assert.equal(calls.length, 1);

  const [call] = calls;
  assert.equal(call.event, 'tournament_reminder');
  assert.equal(call.entity, 'tournament');
  assert.equal(call.id, 'match-1');
  assert.equal(call.variables.MINUTES, 30, 'twenty minutes out falls in the thirty-minute milestone');
  assert.equal(call.variables.TOURNAMENT_NAME, 'PGR Showdown');
  assert.equal(call.variables.deepLink, 'pgr://tournament/match-1');
  assert.equal(call.template.body, '{{TOURNAMENT_NAME}} starts in {{MINUTES}} minutes');
});

test('a match that only carries the old startTime field is not a scheduled match', async () => {
  const { calls, reminders } = harness({
    legacy: {
      name: 'Old Match',
      status: SCHEDULED_STATUS,
      isActive: true,
      // What the cron used to ask for. A document with only this is invisible to the fixed job,
      // which is the point: the schedule lives in `dateTime`.
      startTime: new Date(NOW + minutes(20))
    }
  });

  const result = await reminders.runOnce();
  assert.equal(result.summary.scanned, 0, 'the query no longer looks at startTime');
  assert.equal(calls.length, 0);
});

test('the reminder states the start time on the project clock', async () => {
  // 09:00 UTC is 14:30 in the deployment's +05:30 day.
  const { calls, reminders } = harness({
    'match-1': match({ dateTime: new Date(Date.parse('2026-10-21T09:00:00.000Z')) })
  });
  // 09:00 is earlier than "now", so this pass sees nothing; formatting is asserted directly.
  await reminders.runOnce();
  assert.equal(calls.length, 0);

  const formatted = localStart(new Date('2026-10-21T09:00:00.000Z'), 330);
  assert.deepEqual(formatted, { date: '21/10/2026', time: '14:30' });

  const utc = localStart(new Date('2026-10-21T23:45:00.000Z'), 0);
  assert.deepEqual(utc, { date: '21/10/2026', time: '23:45' });

  // A date that is still yesterday in UTC but already today at +05:30 is today's date.
  const crossing = localStart(new Date('2026-10-21T19:00:00.000Z'), 330);
  assert.deepEqual(crossing, { date: '22/10/2026', time: '00:30' });
});

// ==========================================================================
// Which matches are eligible
// ==========================================================================

test('cancelled, removed and inactive matches are never reminded', async () => {
  const { calls, reminders } = harness({
    cancelled: match({ status: 'cancelled', isActive: false }),
    removed: match({ status: 'removed', isActive: false }),
    inactive: match({ isActive: false }),
    ongoing: match({ status: 'ongoing' }),
    finished: match({ status: 'results' }),
    live: match()
  });

  const result = await reminders.runOnce();
  assert.equal(result.summary.sent, 1);
  assert.deepEqual(calls.map(call => call.id), ['live']);
});

test('a match whose start time has already passed is not reminded', async () => {
  const { calls, reminders } = harness({
    past: match({ dateTime: new Date(NOW - minutes(1)) }),
    exact: match({ dateTime: new Date(NOW) })
  });

  const result = await reminders.runOnce();
  // The window starts at "now", so a match starting exactly now is still inside it and gets the
  // five-minute milestone; a match that started a minute ago is outside it.
  assert.deepEqual(calls.map(call => call.id), ['exact']);
  assert.equal(result.summary.sent, 1);
});

test('a match more than an hour away is outside this pass', async () => {
  const { calls, reminders } = harness({ far: match({ dateTime: new Date(NOW + minutes(61)) }) });

  await reminders.runOnce();
  assert.equal(calls.length, 0);
});

test('each match gets the tightest milestone that has come, not every milestone at once', async () => {
  assert.equal(dueOffset(60), 60);
  assert.equal(dueOffset(45), 60);
  assert.equal(dueOffset(30), 30);
  assert.equal(dueOffset(20), 30);
  assert.equal(dueOffset(5), 5);
  assert.equal(dueOffset(0.5), 5);
  assert.equal(dueOffset(61), null);
  assert.equal(dueOffset(-1), null);
  assert.equal(dueOffset(NaN), null);

  const { calls, reminders } = harness({
    soon: match({ dateTime: new Date(NOW + minutes(4)) }),
    middle: match({ dateTime: new Date(NOW + minutes(20)) }),
    later: match({ dateTime: new Date(NOW + minutes(45)) })
  });

  await reminders.runOnce();
  const byId = Object.fromEntries(calls.map(call => [call.id, call.variables.MINUTES]));
  assert.deepEqual(byId, { soon: 5, middle: 30, later: 60 });
  assert.deepEqual([...REMINDER_OFFSETS].sort((a, b) => a - b), [5, 30, 60]);
});

test('a milestone already claimed for the match is not sent again', async () => {
  const { db, calls, reminders } = harness({ 'match-1': match() });
  db.__seed(claimsOf('match-1'), '30', { offsetMinutes: 30 });

  const result = await reminders.runOnce();
  assert.equal(result.summary.alreadySent, 1);
  assert.equal(calls.length, 0);
});

// ==========================================================================
// Duplicate execution
// ==========================================================================

test('running the pass twice sends one notification', async () => {
  const { db, calls, reminders } = harness({ 'match-1': match() });

  const first = await reminders.runOnce();
  const second = await reminders.runOnce();

  assert.equal(first.summary.sent, 1);
  assert.equal(second.summary.sent, 0);
  assert.equal(calls.length, 1, 'the second pass found the milestone already claimed');
  assert.ok(db.__peek(claimsOf('match-1'), '30'), 'the milestone is recorded on the match');
});

test('two passes running at the same time send one notification', async () => {
  const { calls, reminders } = harness({ 'match-1': match() });

  const [left, right] = await Promise.all([reminders.runOnce(), reminders.runOnce()]);
  assert.equal(calls.length, 1);
  assert.equal(left.summary.sent + right.summary.sent, 1);
});

test('a claim is refused for a match that was cancelled between the query and the claim', async () => {
  const { db, calls, reminders } = harness({ 'match-1': match() });

  // The document is cancelled once the pass has read the window, before it is claimed.
  const realCollection = db.collection.bind(db);
  let cancelled = false;
  db.collection = name => {
    const bucket = realCollection(name);
    if (name !== TOURNAMENT_COLLECTION) return bucket;
    return {
      ...bucket,
      doc: id => {
        const reference = bucket.doc(id);
        return {
          ...reference,
          async get() {
            if (!cancelled) {
              cancelled = true;
              db.__seed(TOURNAMENT_COLLECTION, 'match-1',
                match({ status: 'cancelled', isActive: false }));
            }
            return reference.get();
          }
        };
      }
    };
  };

  const result = await reminders.runOnce();
  assert.equal(result.summary.sent, 0);
  assert.equal(calls.length, 0);
  assert.equal(db.__peek(claimsOf('match-1'), '30'), undefined, 'no claim was taken');
});

test('a failed send releases its claim so the next pass retries it', async () => {
  const { db, calls, reminders } = harness({ 'match-1': match() }, { failFirstSend: true });

  const first = await reminders.runOnce();
  assert.equal(first.summary.failed, 1);
  assert.equal(first.summary.sent, 0);
  assert.equal(db.__peek(claimsOf('match-1'), '30'), undefined,
    'a reminder that never reached anyone is not recorded as sent');

  const second = await reminders.runOnce();
  assert.equal(second.summary.sent, 1);
  assert.equal(calls.length, 1);
  assert.ok(db.__peek(claimsOf('match-1'), '30'));
});

test('a failed query is reported as a failed pass, not as "nothing due"', async () => {
  const failing = {
    collection: () => ({
      where() { return this; },
      limit() { return this; },
      async get() { throw new Error('backend unavailable'); }
    })
  };
  const reminders = createTournamentReminders({
    db: failing,
    notify: async () => undefined,
    now: () => new Date(NOW)
  });

  const result = await reminders.runOnce();
  assert.equal(result.code, 'QUERY_FAILED');
  assert.equal(result.summary.sent, 0);
});
