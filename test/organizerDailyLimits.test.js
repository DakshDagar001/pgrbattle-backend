/**
 * Phase 6: what a organizer's daily tournament allowance actually means.
 *
 * The brief forbids inventing a timezone or a counting policy, so every test below is traced
 * back to something this project already stores or already documents: `dateTime` is the field
 * the compose screens write and the deadline sweep judges, +05:30 is the offset the
 * notification routes publish, and `assignedOrganizerUid` before `createdByOrganizerUid` is the
 * one-name responsibility order `organizerPenalties.js` already charges on. The tests are split
 * accordingly - the day boundary, whose match it is, which matches count, the arithmetic, and
 * then the read that assembles all of it from stored documents.
 *
 * None of it is enforcement. There is no test here that a match was refused, because there is
 * nothing to refuse: creation is still a client-side Firestore write. The reported blocker.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createOrganizerEconomyService,
  WALLET_COLLECTION,
  LEDGER_COLLECTION,
  CONFIG_COLLECTION,
  CONFIG_DOCUMENT,
  CURRENCY
} = require('../services/organizerEconomy');
const {
  createOrganizerDailyLimitService,
  summarizeLimit,
  dayWindow,
  dayLabel,
  effectiveLimitOf,
  countsToward,
  parseOffsetMinutes,
  wholeLimit,
  DEFAULT_UTC_OFFSET_MINUTES,
  MAX_DAY_SCAN
} = require('../services/organizerDailyLimits');
const { createFakeFirestore } = require('./helpers/fakeFirestore');

const UID = 'organizer-a';
const OTHER = 'organizer-b';

/** Wednesday 2026-10-21 at 12:00 UTC, which is 17:30 at +05:30 - mid-afternoon, mid-day. */
const NOW = Date.parse('2026-10-21T12:00:00.000Z');
const minutes = count => count * 60000;
const hours = count => count * 3600000;

/**
 * A match stored the way the organizer app stores one. The uid fields are both set because the
 * creator writes itself as the first assignee; tests that need them to differ say so.
 */
function match(over = {}) {
  return {
    tournamentName: 'PGR Showdown',
    status: 'upcoming',
    isActive: true,
    dateTime: new Date(NOW),
    roomId: '',
    roomPassword: '',
    server: 'IN',
    mode: 'ss',
    createdByOrganizerUid: UID,
    assignedOrganizerUid: UID,
    ...over
  };
}

/**
 * The day this project means: local midnight to local midnight at +05:30, so 2026-10-20
 * 18:30Z to 2026-10-21 18:30Z. Stated as literals rather than derived, because a helper that
 * computes the expectation the same way the code does proves nothing.
 */
const DAY_START = Date.parse('2026-10-20T18:30:00.000Z');
const DAY_END = Date.parse('2026-10-21T18:30:00.000Z');

const windowOf = (at = NOW, offset = DEFAULT_UTC_OFFSET_MINUTES) => ({
  start: dayWindow(at, offset).start,
  end: dayWindow(at, offset).end
});

/** The allowance answer for a set of matches, without a database in the way. */
function summaryOf(matches, { defaultLimit = 5, override = 0, uid = UID, at = NOW, offsetMinutes } = {}) {
  return summarizeLimit({
    defaultLimit,
    override,
    matches: matches.map((data, index) => ({ id: `m${index}`, data })),
    organizerUid: uid,
    atMillis: at,
    ...(offsetMinutes === undefined ? {} : { offsetMinutes })
  });
}

function build({
  matches = {},
  accounts = { [UID]: { uid: UID, username: 'org_a', isActive: true } },
  config = null,
  now = NOW,
  offsetMinutes,
  maxDayScan
} = {}) {
  const stores = {
    tournaments: matches,
    organizer_users: accounts,
    [WALLET_COLLECTION]: { [UID]: { availableBalance: 100, reservedBalance: 0, currency: CURRENCY } },
    [LEDGER_COLLECTION]: {}
  };
  if (config) stores[CONFIG_COLLECTION] = { [CONFIG_DOCUMENT]: config };

  const db = createFakeFirestore(stores);
  const economy = createOrganizerEconomyService({ db, serverTimestamp: () => 'SERVER_TS' });
  const limits = createOrganizerDailyLimitService({
    db,
    economy,
    now: () => now,
    ...(offsetMinutes === undefined ? {} : { offsetMinutes }),
    ...(maxDayScan === undefined ? {} : { maxDayScan })
  });
  return { db, economy, limits };
}

// ==========================================================================
// The day, and the timezone it is measured in (C2)
//
// "Daily" is the part of this feature an organizer can argue with, so the boundary is pinned to
// the exact UTC instants it must fall on and to the offset this project already documents, not
// to whatever clock the server happens to run on.
// ==========================================================================

test('a day is local midnight to local midnight at the documented +05:30', () => {
  const window = dayWindow(NOW);
  assert.equal(window.start, DAY_START);
  assert.equal(window.end, DAY_END);
  assert.equal(window.end - window.start, 86400000, 'a day is exactly one day long');
  assert.equal(window.offsetMinutes, 330);
  assert.equal(DEFAULT_UTC_OFFSET_MINUTES, 330, '+05:30 is the notification scheduler\'s offset');
});

test('the day does not move with the server\'s own timezone', () => {
  // Render runs UTC and a developer machine does not. Both must see the same window for the
  // same instant, or "you have used your allowance" becomes a question about the host.
  const previous = process.env.TZ;
  for (const zone of ['UTC', 'Asia/Kolkata', 'America/Los_Angeles']) {
    process.env.TZ = zone;
    const window = dayWindow(NOW);
    assert.equal(window.start, DAY_START, zone);
    assert.equal(window.end, DAY_END, zone);
  }
  if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;
});

test('a match a millisecond before the boundary belongs to yesterday', () => {
  const justBefore = new Date(DAY_START - 1);
  const justAfter = new Date(DAY_START);
  assert.equal(summaryOf([match({ dateTime: justBefore })]).used, 0,
    'yesterday\'s match does not take today\'s place');
  assert.equal(summaryOf([match({ dateTime: justAfter })]).used, 1,
    'the boundary itself is inside the day');

  const endExclusive = new Date(DAY_END);
  assert.equal(summaryOf([match({ dateTime: new Date(DAY_END - 1) })]).used, 1);
  assert.equal(summaryOf([match({ dateTime: endExclusive })]).used, 0,
    'the end of the window is the start of the next day');
});

test('the day an organizer reads is the local day, not the UTC one', () => {
  // 2026-10-21T20:00Z is already 2026-10-22 01:30 at +05:30. Labelling it from UTC would tell
  // an organizer they are a day into an allowance they have not started using.
  const late = Date.parse('2026-10-21T20:00:00.000Z');
  assert.equal(dayLabel(dayWindow(late), late), '2026-10-22');
  assert.equal(dayLabel(dayWindow(NOW), NOW), '2026-10-21');
});

test('the offset can be widened but not made meaningless', () => {
  assert.equal(parseOffsetMinutes('+05:30'), 330);
  assert.equal(parseOffsetMinutes('+0530'), 330);
  assert.equal(parseOffsetMinutes('-0800'), -480);
  assert.equal(parseOffsetMinutes('+00:00'), 0);
  assert.equal(parseOffsetMinutes('330'), 330);
  assert.equal(parseOffsetMinutes('-14:00'), -840);

  // Anything else is refused rather than guessed at. A name is not an offset, and an offset
  // nobody lives at would move matches into a day that does not exist.
  for (const junk of [undefined, null, '', '   ', 'Asia/Kolkata', 'IST', '+25:00', '14:99',
    '9999', 12345, {}, [], true]) {
    assert.equal(parseOffsetMinutes(junk), null, `${String(junk)} is not an offset`);
  }
});

test('a different offset is a different day for the same instant', () => {
  const late = Date.parse('2026-10-21T20:00:00.000Z');
  assert.equal(dayLabel(dayWindow(late, 0), late), '2026-10-21', 'on a UTC clock it is still the 21st');
  // The same instant is already tomorrow where the offset runs ahead of it, and still the same
  // day where it runs behind. A day that is not agreed on is a limit nobody can predict.
  assert.equal(dayLabel(dayWindow(late, -480), late), '2026-10-21');
  assert.equal(dayLabel(dayWindow(late, 540), late), '2026-10-22');
  assert.notEqual(dayWindow(late, 540).start, dayWindow(late, 0).start);
});

test('an offset the environment cannot state falls back to the documented one', async () => {
  // A junk value is neither a crash nor a silently-UTC day: the read answers with the same
  // boundary every correctly-configured deployment gives.
  const { limits } = build({
    offsetMinutes: 'Mars/Olympus',
    config: { defaultDailyTournamentLimit: 5 },
    matches: { 't-1': match() }
  });
  const result = await limits.summarize({ organizerUid: UID, atMillis: NOW });
  assert.equal(result.window.offsetMinutes, 330);
  assert.equal(result.window.start, DAY_START);
  assert.equal(result.window.end, DAY_END);
  assert.equal(result.used, 1, 'the match is still inside the day it belongs to');
});

// ==========================================================================
// Whose match it is (C2, and A3's rule reused rather than re-decided)
// ==========================================================================

test('a reassigned match counts for the assignee and not for the creator', () => {
  const reassigned = match({ createdByOrganizerUid: UID, assignedOrganizerUid: OTHER });
  assert.equal(summaryOf([reassigned]).used, 0, 'the creator is not charged for work they gave up');
  assert.equal(summaryOf([reassigned], { uid: OTHER }).used, 1);

  // Exactly one organizer gains a place for each match, so a reassignment cannot be used to
  // spread one match across two allowances.
  const both = summaryOf([reassigned], { uid: OTHER });
  assert.equal(both.matches[0].basis, 'assigned_organizer');
});

test('a match nobody was assigned to counts for the organizer who made it', () => {
  for (const absent of [undefined, null, '', '   ']) {
    const own = match({ assignedOrganizerUid: absent });
    assert.equal(summaryOf([own]).used, 1, `${String(absent)} names no assignee`);
    assert.equal(summaryOf([own], { uid: OTHER }).used, 0);
  }
  const listed = summaryOf([match({ assignedOrganizerUid: undefined })], { uid: UID });
  assert.equal(listed.matches[0].basis, 'creator');
});

test('a match that names no organizer is not counted for anybody', () => {
  const legacy = match({ createdByOrganizerUid: '', assignedOrganizerUid: '' });
  assert.equal(summaryOf([legacy]).used, 0);
  assert.equal(summaryOf([legacy], { uid: OTHER }).used, 0);
  // A uid that is not the one on the match gains nothing from a lookup, so one organizer can
  // never read another one's schedule through this answer.
  assert.equal(summaryOf([match()], { uid: 'organizer-c' }).used, 0);
});

test('reassigning a match moves it between days of the allowance', () => {
  // The count is derived from stored attribution as it stands, so the same match leaves one
  // organizer's day and enters the other's. This is the behaviour the brief asks to be reported
  // for reassignment, and it is not a loophole: the handing-over organizer frees a slot, the
  // receiving organizer spends one.
  const before = summaryOf([match()]);
  assert.equal(before.used, 1);
  const after = summaryOf([match({ assignedOrganizerUid: OTHER })]);
  assert.equal(after.used, 0);
  assert.equal(summaryOf([match({ assignedOrganizerUid: OTHER })], { uid: OTHER }).used, 1);
});

// ==========================================================================
// Which matches take a place (C2)
// ==========================================================================

test('a match that will not be played takes no place in a day', () => {
  for (const status of ['cancelled', 'removed']) {
    assert.equal(summaryOf([match({ status })]).used, 0, `${status} needs nobody to run it`);
  }
  // Both apps write `isActive: false` alongside the status, so either signal is enough on its
  // own - and an inactive match still marked upcoming has been taken off the schedule.
  assert.equal(summaryOf([match({ isActive: false })]).used, 0);
  assert.equal(summaryOf([match({ status: 'cancelled', isActive: false })]).used, 0);
  // `isActive: null` and an absent flag are not cancellations. Only the explicit false means it.
  assert.equal(summaryOf([match({ isActive: null })]).used, 1);
  const { isActive, ...withoutFlag } = match();
  assert.equal(summaryOf([withoutFlag]).used, 1);
});

test('a match already started today has still used today\'s place', () => {
  // The allowance is about how much an organizer runs, not about how far each match got, so
  // `ongoing` and `results` count while `cancelled` and `removed` do not.
  for (const status of ['ongoing', 'results']) {
    assert.equal(summaryOf([match({ status })]).used, 1, `${status} was played`);
  }
  // Case and whitespace are the app's own vocabulary, and a status stored with either is still
  // the status it names.
  assert.equal(summaryOf([match({ status: ' Cancelled ' })]).used, 0);
});

test('a match with no usable scheduled time is counted in no day', () => {
  for (const dateTime of [undefined, null, '', 'later', 0, {}, [], new Date('not a date')]) {
    assert.equal(summaryOf([match({ dateTime })]).used, 0, `${String(dateTime)} is not a schedule`);
  }
  // A Firestore Timestamp shape and a millisecond number both mean an instant, the same way
  // the penalty service reads them.
  const seconds = Math.floor(DAY_START / 1000);
  assert.equal(summaryOf([match({ dateTime: { seconds, nanoseconds: 0 } })]).used, 1);
  assert.equal(summaryOf([match({ dateTime: DAY_START })]).used, 1);
});

test('the match list is ordered by when it was scheduled to start', () => {
  const list = summaryOf([
    match({ dateTime: new Date(DAY_START + hours(9)), tournamentName: 'later' }),
    match({ dateTime: new Date(DAY_START + hours(1)), tournamentName: 'earlier' })
  ]);
  assert.equal(list.used, 2);
  assert.ok(list.matches[0].scheduledAt < list.matches[1].scheduledAt);
  assert.deepEqual(list.matches.map(entry => entry.status), ['upcoming', 'upcoming']);
});

test('countsToward is the same rule with the window made explicit', () => {
  const window = windowOf();
  assert.equal(countsToward({ data: match(), organizerUid: UID, window }), true);
  assert.equal(countsToward({ data: null, organizerUid: UID, window }), false);
  assert.equal(countsToward({ data: 'not a document', organizerUid: UID, window }), false);
  assert.equal(countsToward({ data: match(), organizerUid: '', window }), false);
  assert.equal(countsToward({ data: match(), organizerUid: UID, window: { start: 0, end: 0 } }), false);
});

// ==========================================================================
// The arithmetic, and what zero means (C1)
// ==========================================================================

test('a limit of zero is no limit chosen, not a limit of zero matches', () => {
  // The settings document already means "not set" by 0, and the Admin screen cannot tell a
  // cleared field from a prohibition. Barring an organizer is the server and mode grants' job.
  const unlimited = summaryOf([match(), match()], { defaultLimit: 0 });
  assert.equal(unlimited.effectiveLimit, 0);
  assert.equal(unlimited.unlimited, true);
  assert.equal(unlimited.remaining, null, 'there is no remainder to show');
  assert.equal(unlimited.reached, false, 'nobody is blocked by a limit nobody set');
  assert.equal(unlimited.used, 2, 'the usage is still the truth even when nothing limits it');

  // An out-of-range default is not a smaller default: 5000 is rejected the same way 0 is.
  assert.equal(summaryOf([], { defaultLimit: 5000 }).unlimited, true);
  assert.equal(summaryOf([], { defaultLimit: -3 }).unlimited, true);
});

test('an organizer\'s own override replaces the default, and clearing it restores the default', () => {
  assert.equal(effectiveLimitOf(5, 2), 2);
  assert.equal(effectiveLimitOf(5, 0), 5, 'a cleared override falls back');
  assert.equal(effectiveLimitOf(0, 3), 3, 'an override without a default still applies');
  assert.equal(effectiveLimitOf(5, undefined), 5);
  assert.equal(effectiveLimitOf(5, null), 5);

  const overruled = summaryOf([match(), match(), match()], { defaultLimit: 5, override: 2 });
  assert.equal(overruled.effectiveLimit, 2);
  assert.equal(overruled.overrideLimit, 2);
  assert.equal(overruled.configuredDefaultLimit, 5, 'the default stays visible beside the override');
  assert.equal(overruled.used, 3);
  assert.equal(overruled.remaining, 0);
  assert.equal(overruled.reached, true);
});

test('a stored limit that is not a whole count is not a limit', () => {
  // `firestore.rules` holds both the default and the override to an int in 0..1000. A value
  // that predates or bypasses that rule is read as absent rather than coerced, so a corrupt
  // field can neither bar an organizer nor grant them a fractional allowance.
  for (const junk of ['3', 2.5, -1, 1001, true, {}, [], NaN, Infinity]) {
    assert.equal(wholeLimit(junk), 0, `${String(junk)} is not a limit`);
  }
  assert.equal(wholeLimit(0), 0);
  assert.equal(wholeLimit(7), 7);
  assert.equal(wholeLimit(1000), 1000);

  assert.equal(effectiveLimitOf(5, '3'), 5, 'a string override falls back to the default');
  assert.equal(summaryOf([], { defaultLimit: 5, override: 2.5 }).effectiveLimit, 5);
});

test('remaining never goes negative when history is already over the limit', () => {
  // An admin can lower a limit under an organizer who has already run more matches than the new
  // figure allows. Nothing about that is anybody's debt, so the answer is "none left" and not a
  // number an interface would have to render as negative.
  const over = summaryOf([match(), match(), match()], { defaultLimit: 2 });
  assert.equal(over.used, 3);
  assert.equal(over.remaining, 0);
  assert.equal(over.reached, true);

  const justUnder = summaryOf([match(), match()], { defaultLimit: 3 });
  assert.equal(justUnder.remaining, 1);
  assert.equal(justUnder.reached, false);
});

test('the window and the day are reported so a screen never computes its own', () => {
  const summary = summaryOf([match()], { defaultLimit: 4 });
  assert.deepEqual(summary.window, { start: DAY_START, end: DAY_END, offsetMinutes: 330 });
  assert.equal(summary.day, '2026-10-21');
  assert.equal(summary.organizerUid, UID);
});

// ==========================================================================
// The read that assembles it (C2, from stored documents only)
// ==========================================================================

test('the read sees only the organizer\'s own matches from the current day', async () => {
  const { limits } = build({
    config: { defaultDailyTournamentLimit: 3 },
    matches: {
      't-today-a': match({ dateTime: new Date(DAY_START + hours(2)) }),
      't-today-b': match({ dateTime: new Date(DAY_START + hours(6)) }),
      't-yesterday': match({ dateTime: new Date(DAY_START - hours(1)) }),
      't-tomorrow': match({ dateTime: new Date(DAY_END + hours(1)) }),
      't-other-organizer': match({ assignedOrganizerUid: OTHER, dateTime: new Date(DAY_START) }),
      't-cancelled': match({ status: 'cancelled', dateTime: new Date(DAY_START) }),
      't-no-attribution': match({ createdByOrganizerUid: '', assignedOrganizerUid: '' })
    }
  });

  const result = await limits.summarize({ organizerUid: UID, atMillis: NOW });
  assert.equal(result.code, 'COMPLETE');
  assert.equal(result.effectiveLimit, 3);
  assert.equal(result.used, 2, 'four other days\' matches, another organizer\'s and a cancelled one are none of them');
  assert.equal(result.remaining, 1);
  assert.equal(result.reached, false);
  assert.deepEqual(result.matches.map(entry => entry.tournamentId), ['t-today-a', 't-today-b']);
});

test('the default comes from settings and the override from the organizer\'s own record', async () => {
  const seeded = {
    config: { defaultDailyTournamentLimit: 6 },
    accounts: { [UID]: { uid: UID, isActive: true, dailyTournamentLimitOverride: 2 } }
  };
  const { limits } = build({ ...seeded, matches: { 't-1': match() } });
  const overridden = await limits.summarize({ organizerUid: UID, atMillis: NOW });
  assert.equal(overridden.configuredDefaultLimit, 6);
  assert.equal(overridden.overrideLimit, 2);
  assert.equal(overridden.effectiveLimit, 2);
  assert.equal(overridden.remaining, 1);

  // A cleared override is stored as 0 by the Admin screen, which means "use the default" here.
  const { limits: cleared } = build({
    config: { defaultDailyTournamentLimit: 6 },
    accounts: { [UID]: { uid: UID, isActive: true, dailyTournamentLimitOverride: 0 } },
    matches: { 't-1': match() }
  });
  const fallback = await cleared.summarize({ organizerUid: UID, atMillis: NOW });
  assert.equal(fallback.effectiveLimit, 6);
  assert.equal(fallback.overrideLimit, 0);

  // No settings document at all is the same answer as a limit of zero: nothing configured.
  const { limits: bare } = build({ matches: { 't-1': match() } });
  const nothing = await bare.summarize({ organizerUid: UID, atMillis: NOW });
  assert.equal(nothing.effectiveLimit, 0);
  assert.equal(nothing.unlimited, true);
  assert.equal(nothing.used, 1, 'the usage is still reported when nothing limits it');
});

test('an account that is not a registered organizer is refused rather than measured', async () => {
  // A player who reaches this read has no allowance to speak of, and answering with the
  // platform default would tell them a number that means nothing and leaks what an admin
  // configured. This mirrors how the withdrawal service already treats the same caller.
  const { limits } = build({
    config: { defaultDailyTournamentLimit: 4 },
    accounts: {},
    matches: { 't-1': match() }
  });
  const refused = await limits.summarize({ organizerUid: 'nobody-here', atMillis: NOW });
  assert.equal(refused.code, 'NOT_AN_ORGANIZER');
  assert.equal(refused.effectiveLimit, undefined);
  assert.equal(refused.used, undefined);

  // A deactivated organizer is still an organizer: their coins and their record are their own,
  // and the question "how many matches did I have today" still has an answer for them.
  const { limits: inactive } = build({
    config: { defaultDailyTournamentLimit: 4 },
    accounts: { [UID]: { uid: UID, isActive: false, dailyTournamentLimitOverride: 1 } },
    matches: { 't-1': match() }
  });
  const answered = await inactive.summarize({ organizerUid: UID, atMillis: NOW });
  assert.equal(answered.code, 'COMPLETE');
  assert.equal(answered.effectiveLimit, 1);
});

test('the read refuses to answer about an unnamed organizer', async () => {
  const { limits } = build({ config: { defaultDailyTournamentLimit: 3 } });
  for (const uid of [undefined, null, '', '   ', 42, {}]) {
    const result = await limits.summarize({ organizerUid: uid });
    assert.equal(result.code, 'ORGANIZER_UID_INVALID', `${String(uid)} is not an account`);
  }
  // A refusal carries no allowance fields, so a screen cannot render a partial answer as if it
  // had read somebody's day.
  const refused = await limits.summarize({});
  assert.equal(refused.effectiveLimit, undefined);
  assert.equal(refused.used, undefined);
});

test('a day is read with one bounded range query, so history cannot make it unbounded', async () => {
  // `maxDayScan` is an operational bound, not a product rule: it exists so a read cannot be
  // dragged out by how many matches happen to exist, and a truncated scan reports the matches
  // it did see rather than inventing the ones it did not.
  const many = {};
  for (let index = 0; index < 6; index++) {
    many[`t-${index}`] = match({ dateTime: new Date(DAY_START + minutes(index)) });
  }
  const { limits } = build({ config: { defaultDailyTournamentLimit: 10 }, matches: many, maxDayScan: 4 });
  const result = await limits.summarize({ organizerUid: UID, atMillis: NOW });
  assert.equal(result.matches.length, 4, 'the scan stopped where it was told to');
  assert.equal(result.used, 4);

  // The bound defaults to the constant the service publishes.
  assert.equal(MAX_DAY_SCAN, 500);
});

test('the clock, not a caller, decides which day is today', async () => {
  const { limits } = build({
    now: NOW,
    config: { defaultDailyTournamentLimit: 2 },
    matches: {
      't-today': match({ dateTime: new Date(DAY_START + hours(2)) }),
      't-tomorrow': match({ dateTime: Date.parse('2026-10-22T12:00:00.000Z') })
    }
  });
  // Asking about a future day is allowed - the same read answers "what will my allowance be
  // tomorrow" - but it cannot be talked into counting that future day as today.
  const today = await limits.summarize({ organizerUid: UID });
  assert.equal(today.day, '2026-10-21');
  assert.equal(today.used, 1);
  assert.deepEqual(today.matches.map(entry => entry.tournamentId), ['t-today']);

  const ahead = await limits.summarize({
    organizerUid: UID,
    atMillis: Date.parse('2026-10-22T12:00:00.000Z')
  });
  assert.equal(ahead.day, '2026-10-22');
  assert.equal(ahead.used, 1);
  assert.deepEqual(ahead.matches.map(entry => entry.tournamentId), ['t-tomorrow']);
});

test('reading an allowance writes nothing anywhere', async () => {
  // This is a read-only service by decision, and the promise is worth a test: a limit question
  // must not be able to move coins, create a case, or leave a document behind.
  const { db, limits } = build({
    config: { defaultDailyTournamentLimit: 1 },
    accounts: { [UID]: { uid: UID, isActive: true, dailyTournamentLimitOverride: 9 } },
    matches: { 't-1': match() }
  });
  const collectionsBefore = db.__names();
  await limits.summarize({ organizerUid: UID, atMillis: NOW });

  assert.deepEqual(db.__names(), collectionsBefore, 'no new collection appeared');
  assert.equal(db.__peek(WALLET_COLLECTION, UID).availableBalance, 100, 'the balance did not move');
  assert.equal(db.__peek(LEDGER_COLLECTION, 'reserve:t-1'), undefined);
  assert.equal(db.__peek('tournaments', 't-1').status, 'upcoming', 'the match was not rewritten');
});

test('the service refuses to be built without the handles it needs', () => {
  assert.throws(() => createOrganizerDailyLimitService({}), /requires db and economy/);
  assert.throws(() => createOrganizerDailyLimitService({ db: {} }), /requires db and economy/);
  const { db, economy } = build({});
  assert.throws(() => createOrganizerDailyLimitService({ economy }), /requires db and economy/);
  assert.doesNotThrow(() => createOrganizerDailyLimitService({ db, economy }));
});
