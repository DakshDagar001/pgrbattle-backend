/**
 * Phase 4: automatic organizer deadline penalties.
 *
 * The interesting questions are the ones the brief names, and every test below is about one
 * of them: what counts as a violation, who is answerable for it, whether the same violation
 * can be charged twice, and what happens when the balance cannot cover the charge. The
 * answers are read from the lifecycle the apps actually write - `status`, `isActive`,
 * `dateTime`, `roomId`/`roomPassword`, `assignedOrganizerUid`/`createdByOrganizerUid` - not
 * from a field this project has never seen (`startTime`), which is what the tournament
 * reminder cron already queries in vain.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createOrganizerEconomyService,
  WALLET_COLLECTION,
  LEDGER_COLLECTION,
  CONFIG_COLLECTION,
  CONFIG_DOCUMENT,
  ENTRY_TYPES,
  HOLD_STATES,
  CURRENCY
} = require('../services/organizerEconomy');
const {
  createPenaltyEnforcementService,
  classifyViolation,
  resolveResponsible,
  CASES_COLLECTION,
  VIOLATION_TYPES,
  CASE_OUTCOMES,
  NOT_STARTED_STATUS,
  SCHEDULER_ACTOR
} = require('../services/organizerPenalties');
const { createFakeFirestore } = require('./helpers/fakeFirestore');

const UID = 'organizer-a';
const OTHER = 'organizer-b';

/** A fixed clock, because a deadline check whose "now" moves is a test that passes twice. */
const NOW = Date.parse('2026-10-21T12:00:00.000Z');
const minutes = count => count * 60000;

const ENABLED = {
  deadlinePenaltyEnabled: true,
  defaultDeadlinePenalty: 50,
  deadlineGraceMinutes: 30,
  currency: CURRENCY
};

/**
 * A scheduled match as the organizer app really stores it: `dateTime` is the start the app
 * picked on its own clock, the room fields default to empty strings rather than being absent,
 * and `status` starts as `upcoming`.
 */
function match(over = {}) {
  return {
    tournamentName: 'PGR Showdown',
    status: NOT_STARTED_STATUS,
    isActive: true,
    dateTime: new Date(NOW - minutes(90)),
    roomId: '8123 4567',
    roomPassword: 'pgr123',
    server: 'IN',
    mode: 'ss',
    createdByOrganizerUid: UID,
    assignedOrganizerUid: UID,
    ...over
  };
}

function account(over = {}) {
  return { uid: UID, username: 'org_a', isActive: true, banned: false, regions: ['IN'], ...over };
}

function walletData(over = {}) {
  return {
    availableBalance: 100,
    reservedBalance: 0,
    lifetimeEarned: 100,
    lifetimePenalized: 0,
    currency: CURRENCY,
    version: 1,
    createdAt: 'SEEDED_TS',
    ...over
  };
}

/** `config: null` is the absent settings document, which reads as every switch being off. */
function build({
  matches = {},
  accounts = { [UID]: account() },
  wallets = { [UID]: walletData() },
  config = ENABLED,
  now = NOW,
  serializable = false,
  lookbackHours,
  maxCasesPerSweep
} = {}) {
  const stores = {
    tournaments: matches,
    organizer_users: accounts,
    [WALLET_COLLECTION]: wallets,
    [LEDGER_COLLECTION]: {}
  };
  if (config !== null) stores[CONFIG_COLLECTION] = { [CONFIG_DOCUMENT]: config };

  const db = createFakeFirestore(stores, { serializable });
  const economy = createOrganizerEconomyService({ db, serverTimestamp: () => 'SERVER_TS' });
  const penalties = createPenaltyEnforcementService({
    db,
    economy,
    serverTimestamp: () => 'SERVER_TS',
    now: () => now,
    ...(lookbackHours === undefined ? {} : { lookbackHours }),
    ...(maxCasesPerSweep === undefined ? {} : { maxCasesPerSweep })
  });
  return { db, economy, penalties };
}

const walletOf = (db, uid = UID) => db.__peek(WALLET_COLLECTION, uid);
const entryOf = (db, key) => db.__peek(LEDGER_COLLECTION, key);
const caseOf = (db, tournamentId) => db.__peek(CASES_COLLECTION, `penalty_case:${tournamentId}`);
const chargeKey = tournamentId => `penalty:${tournamentId}:deadline_missed`;

const violationOf = (over, { nowMs = NOW, graceMinutes = 30 } = {}) =>
  classifyViolation(match(over), { nowMs, graceMinutes });

// ==========================================================================
// A2 - what actually counts as a violation
//
// Every condition is a separate refusal. The dangerous direction is charging a match that
// simply has not started yet, so the tests below push on it from every side: a status that
// has moved on, a cancelled match, a missing or junk scheduled time, and the grace window.
// ==========================================================================

test('a match that is not upcoming is not a violation, whatever its fields look like', () => {
  for (const status of ['ongoing', 'results', 'cancelled', 'removed']) {
    assert.equal(violationOf({ status }), null, `${status} is never a missed deadline`);
  }
  // A missing status is not read as the model's default. The organizer app would show this
  // row as upcoming; charging on that inference would be charging on a guess.
  const { status, ...withoutStatus } = match();
  assert.equal(classifyViolation(withoutStatus, { nowMs: NOW, graceMinutes: 30 }), null);
  assert.equal(classifyViolation({ status: null }, { nowMs: NOW, graceMinutes: 30 }), null);
});

test('a cancelled or removed match stays cancelled even if its fields are still upcoming', () => {
  // Both apps write `status` together with `isActive: false`, so either signal alone has to
  // be enough not to charge.
  assert.equal(violationOf({ isActive: false }), null);
  assert.equal(violationOf({ status: 'cancelled', isActive: false }), null);
});

test('a match with no usable scheduled start is nobody\'s missed deadline', () => {
  for (const dateTime of [undefined, null, '', 'later', 0, {}, []]) {
    assert.equal(violationOf({ dateTime }), null, `${JSON.stringify(dateTime)} is not a deadline`);
  }
});

test('nothing is charged inside the grace period, and the boundary is the deadline', () => {
  const scheduled = NOW - minutes(90);
  // Ninety minutes past the start with a thirty minute grace is a violation; twenty-nine is
  // not, and the check is not allowed to round the difference away.
  assert.equal(violationOf({}, { nowMs: scheduled + minutes(29) }), null);
  assert.equal(violationOf({}, { nowMs: scheduled + minutes(29.999) }), null);
  const justInTime = violationOf({}, { nowMs: scheduled + minutes(30) });
  assert.equal(justInTime.type, VIOLATION_TYPES.FAILED_TO_START);
  assert.equal(justInTime.scheduledAt, scheduled);
  assert.equal(justInTime.deadlineAt, scheduled + minutes(30));
});

test('a grace period of zero still waits for the scheduled start itself', () => {
  // A match scheduled exactly at the clock's now: with no grace the deadline is the start,
  // so a minute early is not a violation and the start itself is.
  const atStart = { dateTime: new Date(NOW) };
  assert.equal(violationOf(atStart, { nowMs: NOW - minutes(1), graceMinutes: 0 }), null);
  assert.equal(violationOf(atStart, { nowMs: NOW, graceMinutes: 0 }).type,
    VIOLATION_TYPES.FAILED_TO_START);
});

test('the two classifications are the two things the stored data can actually prove', () => {
  // The app's own defaults are empty strings, so an empty room field is exactly the state a
  // match is in before an organizer publishes the room - the real signal, not a missing one.
  assert.equal(violationOf({ roomId: '', roomPassword: '' }).type,
    VIOLATION_TYPES.ROOM_DETAILS_MISSING);
  assert.equal(violationOf({ roomId: undefined, roomPassword: undefined }).type,
    VIOLATION_TYPES.ROOM_DETAILS_MISSING);
  // Whitespace is what a text field looks like when somebody typed a space and saved.
  assert.equal(violationOf({ roomId: '   ', roomPassword: 'pgr123' }).type,
    VIOLATION_TYPES.ROOM_DETAILS_MISSING);
  assert.equal(violationOf({ roomId: '8123 4567', roomPassword: ' ' }).type,
    VIOLATION_TYPES.ROOM_DETAILS_MISSING);
  // Both credentials present and still not started is the other violation, and it is recorded
  // as itself so an admin can tell the two apart later.
  const started = violationOf({});
  assert.equal(started.type, VIOLATION_TYPES.FAILED_TO_START);
});

// ==========================================================================
// A3 - who is answerable
// ==========================================================================

test('an assigned organizer is answerable, and the creator is not charged beside them', () => {
  const both = resolveResponsible({ createdByOrganizerUid: OTHER, assignedOrganizerUid: UID });
  assert.deepEqual(both, { organizerUid: UID, basis: 'assigned_organizer' });

  // An empty assignee - the state every legacy match is in - falls back to the creator.
  assert.deepEqual(resolveResponsible({ createdByOrganizerUid: OTHER, assignedOrganizerUid: '' }),
    { organizerUid: OTHER, basis: 'creator' });
  assert.deepEqual(resolveResponsible({}), { organizerUid: '', basis: 'unattributed' });
  assert.deepEqual(resolveResponsible({ assignedOrganizerUid: '   ', createdByOrganizerUid: '' }),
    { organizerUid: '', basis: 'unattributed' });
});

test('a match that names no organizer is recorded and nobody is charged', async () => {
  const { db, penalties } = build({
    matches: { 'match-1': match({ createdByOrganizerUid: '', assignedOrganizerUid: '' }) }
  });
  const report = await penalties.sweepOnce();

  assert.equal(report.summary.unattributed, 1);
  assert.equal(walletOf(db).availableBalance, 100, 'a stranger cannot be billed for a match');
  assert.equal(entryOf(db, chargeKey('match-1')), undefined);
  assert.equal(caseOf(db, 'match-1').outcome, CASE_OUTCOMES.UNATTRIBUTED);
  assert.equal(caseOf(db, 'match-1').organizerUid, null, 'the record does not invent an owner');
});

test('a uid on a match is not a role, so an account that is not an organizer is not charged', async () => {
  const { db, penalties } = build({
    matches: { 'match-1': match({ assignedOrganizerUid: 'player-9' }) },
    accounts: {},
    wallets: { 'player-9': walletData() }
  });
  const report = await penalties.sweepOnce();

  assert.equal(report.summary.not_organizer, 1);
  assert.equal(walletOf(db, 'player-9').availableBalance, 100);
  assert.equal(caseOf(db, 'match-1').outcome, CASE_OUTCOMES.NOT_AN_ORGANIZER);
});

// ==========================================================================
// A4 - the switch, the sweep, and one charge per violation
// ==========================================================================

test('the penalty is off until an admin enables it by name', async () => {
  // A configured amount that nobody switched on is the state every existing installation is
  // in today, and it must charge nobody.
  const withAmountOnly = build({
    matches: { 'match-1': match() },
    config: { defaultDeadlinePenalty: 50, currency: CURRENCY }
  });
  assert.equal((await withAmountOnly.penalties.sweepOnce()).code, 'DISABLED');
  assert.equal(walletOf(withAmountOnly.db).availableBalance, 100);

  // A truthy string is not the switch. readConfig() only accepts `=== true`.
  const mistaken = build({ matches: { 'match-1': match() },
    config: { deadlinePenaltyEnabled: 'yes', defaultDeadlinePenalty: 50 } });
  assert.equal((await mistaken.penalties.sweepOnce()).code, 'DISABLED');

  // No settings document at all is the same inert default.
  const absent = build({ matches: { 'match-1': match() }, config: null });
  assert.equal((await absent.penalties.sweepOnce()).code, 'DISABLED');

  // Enabled with nothing to charge is reported rather than attempted, because a zero movement
  // is refused by the economy and would only produce noise every ten minutes.
  const zero = build({ matches: { 'match-1': match() },
    config: { deadlinePenaltyEnabled: true, defaultDeadlinePenalty: 0 } });
  assert.equal((await zero.penalties.sweepOnce()).code, 'NO_AMOUNT_CONFIGURED');
});

test('a missed deadline deducts once, in coins, and leaves the audit behind', async () => {
  const { db, penalties } = build({ matches: { 'match-1': match({ roomId: '', roomPassword: '' }) } });
  const report = await penalties.sweepOnce();

  assert.equal(report.code, 'COMPLETE');
  assert.equal(report.summary.charged, 1);
  assert.equal(walletOf(db).availableBalance, 50);
  assert.equal(walletOf(db).lifetimePenalized, 50);
  assert.equal(walletOf(db).reservedBalance, 0, 'a penalty is sideways out of available only');
  assert.equal(walletOf(db).currency, CURRENCY);

  const entry = entryOf(db, chargeKey('match-1'));
  assert.equal(entry.type, ENTRY_TYPES.PENALTY_DEDUCTION);
  assert.equal(entry.amount, 50);
  assert.equal(entry.currency, CURRENCY);
  assert.equal(entry.balanceBefore, 100);
  assert.equal(entry.balanceAfter, 50);
  assert.equal(entry.actorUid, SCHEDULER_ACTOR, 'the scheduler is on the record, not a client');
  assert.equal(entry.relatedId, 'penalty_case:match-1');

  const recorded = caseOf(db, 'match-1');
  assert.equal(recorded.outcome, CASE_OUTCOMES.CHARGED);
  assert.equal(recorded.violationType, VIOLATION_TYPES.ROOM_DETAILS_MISSING);
  assert.equal(recorded.organizerUid, UID);
  assert.equal(recorded.responsibilityBasis, 'assigned_organizer');
  assert.equal(recorded.configuredAmount, 50);
  assert.equal(recorded.ledgerEntryId, chargeKey('match-1'));
  assert.equal(recorded.currency, CURRENCY);
});

test('a sweep that runs again charges nobody a second time', async () => {
  const { db, penalties } = build({ matches: { 'match-1': match() } });
  await penalties.sweepOnce();
  const second = await penalties.sweepOnce();
  const third = await penalties.sweepOnce();

  assert.equal(second.summary.already_closed, 1);
  assert.equal(third.summary.already_closed, 1);
  assert.equal(second.summary.charged, undefined);
  assert.equal(walletOf(db).availableBalance, 50, 'one deadline, one deduction');
  assert.equal((await db.collection(LEDGER_COLLECTION).get()).size, 1);
});

test('two sweeps that race still deduct once', async () => {
  // `serializable` is what makes this a concurrency test rather than two sequential ones: the
  // loser of the race is aborted and retries, and on the retry it finds the ledger key that
  // already won. Nothing else in the service has to know about the race.
  const { db, penalties } = build({ matches: { 'match-1': match() }, serializable: true });
  const [first, second] = await Promise.all([penalties.sweepOnce(), penalties.sweepOnce()]);

  const outcomes = [first.summary.charged || 0, second.summary.charged || 0]
    .reduce((total, count) => total + count, 0);
  assert.equal(outcomes, 1, 'exactly one sweep may report a deduction');
  assert.equal(walletOf(db).availableBalance, 50, 'and the balance may move by exactly one penalty');
  assert.equal((await db.collection(LEDGER_COLLECTION).get()).size, 1);
});

test('a replayed deduction is recorded as already charged rather than rewritten away', async () => {
  const { db, economy, penalties } = build({ matches: { 'match-1': match() } });
  // The money moved on an earlier pass that never got as far as writing its case - the crash
  // the case document cannot prevent and therefore has to describe honestly.
  await economy.deductPenalty({
    organizerUid: UID, amount: 50, idempotencyKey: chargeKey('match-1'),
    relatedViolationId: 'penalty_case:match-1', reason: 'earlier pass', actorUid: SCHEDULER_ACTOR
  });
  const report = await penalties.sweepOnce();

  assert.equal(report.summary.duplicate, 1);
  assert.equal(walletOf(db).availableBalance, 50, 'a replay moves nothing');
  assert.equal(caseOf(db, 'match-1').outcome, CASE_OUTCOMES.DUPLICATE);
});

test('the violation type does not change the charge, so a match cannot be billed twice', async () => {
  const { db, penalties } = build({ matches: { 'match-1': match({ roomId: '', roomPassword: '' }) } });
  await penalties.sweepOnce();

  // The organizer publishes a room late. The deadline was still missed once, and the second
  // pass sees a different classification of the same missed deadline.
  await db.collection('tournaments').doc('match-1').set({ roomId: '111', roomPassword: '222' },
    { merge: true });
  const second = await penalties.sweepOnce();

  assert.equal(second.summary.already_closed, 1);
  assert.equal(walletOf(db).availableBalance, 50);
  assert.equal(caseOf(db, 'match-1').violationType, VIOLATION_TYPES.ROOM_DETAILS_MISSING,
    'the first classification is the one that stands in the audit');
});

// ==========================================================================
// Insufficient balance, missing wallet, and the room a reservation already holds
// ==========================================================================

test('a penalty an organizer cannot cover is recorded and does not create a debt', async () => {
  const { db, penalties } = build({
    matches: { 'match-1': match() },
    wallets: { [UID]: walletData({ availableBalance: 20 }) }
  });
  const report = await penalties.sweepOnce();

  assert.equal(report.summary.insufficient, 1);
  assert.equal(walletOf(db).availableBalance, 20, 'no negative balance is invented');
  assert.equal(walletOf(db).lifetimePenalized, 0);
  assert.equal(entryOf(db, chargeKey('match-1')), undefined, 'and nothing is booked');
  const recorded = caseOf(db, 'match-1');
  assert.equal(recorded.outcome, CASE_OUTCOMES.INSUFFICIENT_BALANCE);
  assert.equal(recorded.configuredAmount, 50);
  assert.match(recorded.detail, /available balance was 20/);
});

test('a penalty cannot spend coins a withdrawal is already holding', async () => {
  const { db, economy, penalties } = build({
    matches: { 'match-1': match() },
    wallets: { [UID]: walletData({ availableBalance: 100 }) }
  });
  const held = await economy.reserveFunds({
    organizerUid: UID, amount: 90, idempotencyKey: 'reserve:wd-1',
    relatedWithdrawalId: 'wd-1', reason: 'withdrawal', actorUid: UID
  });
  assert.equal(held.code, 'COMPLETE');
  assert.equal(walletOf(db).availableBalance, 10);
  assert.equal(walletOf(db).reservedBalance, 90);

  const report = await penalties.sweepOnce();
  assert.equal(report.summary.insufficient, 1, 'the reserved 90 are not spendable on a penalty');
  assert.equal(walletOf(db).availableBalance, 10);
  assert.equal(walletOf(db).reservedBalance, 90, 'and a penalty may not reach into a hold');
});

test('an organizer with no wallet is not given one by being charged', async () => {
  const { db, penalties } = build({ matches: { 'match-1': match() }, wallets: {} });
  const report = await penalties.sweepOnce();

  assert.equal(report.summary.wallet_missing, 1);
  assert.equal(walletOf(db), undefined, 'the trusted path opens wallets, a penalty does not');
  assert.equal((await db.collection(LEDGER_COLLECTION).get()).size, 0);
  assert.equal(caseOf(db, 'match-1').outcome, CASE_OUTCOMES.WALLET_MISSING);
});

// ==========================================================================
// The window, the limit, and what a sweep does when something fails
// ==========================================================================

test('only matches whose deadline is inside the window are looked at', async () => {
  const recent = new Date(NOW - minutes(90));
  const ancient = new Date(NOW - minutes(60 * 24 * 30));
  const future = new Date(NOW + minutes(90));
  const { db, penalties } = build({
    matches: {
      'match-overdue': match({ dateTime: recent }),
      'match-ancient': match({ dateTime: ancient }),
      'match-future': match({ dateTime: future })
    },
    lookbackHours: 48
  });
  const report = await penalties.sweepOnce();

  assert.equal(report.summary.scanned, 1, 'a month-old match is outside the window, and so is a future one');
  assert.equal(report.summary.charged, 1);
  assert.equal(walletOf(db).availableBalance, 50);
  assert.equal(caseOf(db, 'match-ancient'), undefined);
  assert.equal(caseOf(db, 'match-future'), undefined);
});

test('a sweep is bounded, so a backlog cannot stall the schedule', async () => {
  const matches = {};
  for (let index = 0; index < 5; index += 1) {
    matches[`match-${index}`] = match({ assignedOrganizerUid: UID });
  }
  const { db, penalties } = build({ matches, maxCasesPerSweep: 2 });
  const report = await penalties.sweepOnce();

  assert.equal(report.summary.scanned, 2);
  assert.equal((await db.collection(CASES_COLLECTION).get()).size, 2);

  // The remaining matches are dealt with on the next pass, which is what makes the bound safe.
  const rest = await penalties.sweepOnce();
  assert.equal(rest.summary.scanned, 2);
});

test('a match that fails to process is left for the next pass instead of ending the sweep', async () => {
  const { db, penalties } = build({
    matches: {
      'match-bad': match({ assignedOrganizerUid: UID }),
      'match-good': match({ id: 'match-good', assignedOrganizerUid: OTHER })
    },
    accounts: { [UID]: account(), [OTHER]: account({ uid: OTHER, username: 'org_b' }) },
    wallets: { [UID]: walletData(), [OTHER]: walletData() }
  });
  // The audit write for the first match is the one that fails, after the money has moved.
  db.__fail(CASES_COLLECTION, 'penalty_case:match-bad', 'set');

  const report = await penalties.sweepOnce();
  assert.equal(report.summary.scanned, 2);
  assert.equal(walletOf(db, OTHER).availableBalance, 50, 'one failing row does not stop the other');
  assert.equal(walletOf(db).availableBalance, 50);

  // The connection comes back. The next pass reaches the same match, the ledger key refuses a
  // second deduction, and the audit row is finally written.
  db.__heal(CASES_COLLECTION, 'penalty_case:match-bad', 'set');
  const healed = await penalties.sweepOnce();
  assert.equal(healed.summary.duplicate, 1);
  assert.equal(walletOf(db).availableBalance, 50, 'and the balance moved exactly once');
});

test('a violation with no charge is never marked as charged on a retry', async () => {
  // The case document for an insufficient balance is a settled record: it must not be
  // rewritten into a charge, and it must not be re-attempted forever either.
  const { db, penalties } = build({
    matches: { 'match-1': match() },
    wallets: { [UID]: walletData({ availableBalance: 5 }) }
  });
  await penalties.sweepOnce();
  const again = await penalties.sweepOnce();

  assert.equal(again.summary.already_closed, 1);
  assert.equal(caseOf(db, 'match-1').outcome, CASE_OUTCOMES.INSUFFICIENT_BALANCE);
  assert.equal(walletOf(db).availableBalance, 5);
});

test('a ledger entry names the case it belongs to, and the case names the ledger', async () => {
  const { db, penalties } = build({ matches: { 'match-1': match() } });
  await penalties.sweepOnce();

  const entry = entryOf(db, chargeKey('match-1'));
  const recorded = caseOf(db, 'match-1');
  assert.equal(recorded.ledgerEntryId, entry.idempotencyKey);
  assert.equal(entry.relatedId, `penalty_case:match-1`);
  assert.equal(entry.status, 'settled');
  assert.equal(entry.balanceAfter, entry.balanceBefore - entry.amount);
});

test('the service refuses to be built without what it needs to move money', () => {
  assert.throws(() => createPenaltyEnforcementService({}), /requires/);
  assert.throws(() => createPenaltyEnforcementService({ db: {} }), /requires/);
});

test('a sweep reads the configured amount, not a number a match could carry', async () => {
  // Nothing in a tournament document is consulted for an amount. A match that claims a
  // penalty of its own is still charged the configured 50, and one that claims none is too.
  const { db, penalties } = build({
    matches: {
      'match-1': match({ deadlinePenalty: 5000, penalty: 5000 }),
      'match-2': match()
    },
    wallets: { [UID]: walletData({ availableBalance: 1000 }) }
  });
  await penalties.sweepOnce();

  assert.equal(walletOf(db).availableBalance, 900, 'two penalties of the configured size');
  assert.equal(entryOf(db, chargeKey('match-1')).amount, 50);
  assert.equal(entryOf(db, chargeKey('match-2')).amount, 50);
});

test('a hold that is still open is not disturbed by a penalty', async () => {
  const { db, economy, penalties } = build({
    matches: { 'match-1': match() },
    wallets: { [UID]: walletData({ availableBalance: 500 }) }
  });
  await economy.reserveFunds({
    organizerUid: UID, amount: 200, idempotencyKey: 'reserve:wd-9',
    relatedWithdrawalId: 'wd-9', reason: 'withdrawal', actorUid: UID
  });
  await penalties.sweepOnce();

  const wallet = walletOf(db);
  assert.equal(wallet.availableBalance, 250, 'the penalty came out of the unheld part');
  assert.equal(wallet.reservedBalance, 200);
  assert.equal(entryOf(db, 'reserve:wd-9').status, HOLD_STATES.RESERVED,
    'and the withdrawal is still waiting for its review');
});
