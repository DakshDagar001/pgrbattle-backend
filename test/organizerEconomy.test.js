const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createOrganizerEconomyService,
  WALLET_COLLECTION,
  LEDGER_COLLECTION,
  CONFIG_COLLECTION,
  CONFIG_DOCUMENT,
  ENTRY_TYPES,
  DIRECTIONS,
  HOLD_STATES,
  ENTRY_STATUS,
  CURRENCY,
  MAX_AMOUNT,
  MAX_GRACE_MINUTES
} = require('../services/organizerEconomy');
const { createFakeFirestore } = require('./helpers/fakeFirestore');

const UID = 'organizer-a';
const OTHER = 'organizer-b';

/** A wallet that already holds coins, so a test never has to credit first to reach a state. */
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

/**
 * `serializable` turns on the double's optimistic-concurrency mode, which is what makes the
 * racing tests below prove something: without it a lost update would be invisible, because an
 * in-memory Firestore substitute never conflicts with itself.
 */
function buildEconomy({ wallets = {}, ledger = {}, config = {}, serializable = false } = {}) {
  const db = createFakeFirestore({
    [WALLET_COLLECTION]: wallets,
    [LEDGER_COLLECTION]: ledger,
    [CONFIG_COLLECTION]: config
  }, { serializable });
  const economy = createOrganizerEconomyService({ db, serverTimestamp: () => 'SERVER_TS' });
  return { db, economy };
}

const walletOf = (db, uid = UID) => db.__peek(WALLET_COLLECTION, uid);
const entryOf = (db, key) => db.__peek(LEDGER_COLLECTION, key);

test('the service refuses to be built without a database and a server clock', () => {
  assert.throws(() => createOrganizerEconomyService({}), /requires/);
  assert.throws(() => createOrganizerEconomyService({ db: {} }), /requires/);
});

// ==========================================================================
// Wallet
//
// Nothing in this phase pays an organizer, so the wallet's job right now is to be opened at
// zero by the trusted path, and to refuse to be conjured into a balance by anything else.
// ==========================================================================

test('a wallet is opened at zero, in coins, and nothing else', async () => {
  const { db, economy } = buildEconomy();
  const result = await economy.initializeWallet({ organizerUid: UID, actorUid: 'admin-1' });

  assert.equal(result.code, 'COMPLETE');
  assert.equal(result.applied, true);
  assert.deepEqual(walletOf(db), {
    availableBalance: 0,
    reservedBalance: 0,
    lifetimeEarned: 0,
    lifetimePenalized: 0,
    currency: CURRENCY,
    version: 0,
    openedBy: 'admin-1',
    createdAt: 'SERVER_TS',
    updatedAt: 'SERVER_TS'
  });
});

test('opening a wallet twice is a retry, never a reset', async () => {
  const { db, economy } = buildEconomy({ wallets: { [UID]: walletData({ availableBalance: 250 }) } });
  const result = await economy.initializeWallet({ organizerUid: UID });

  assert.equal(result.code, 'EXISTS');
  assert.equal(result.applied, false);
  assert.equal(walletOf(db).availableBalance, 250, 'an existing balance is left alone');
  assert.equal(walletOf(db).version, 1, 'a retry does not touch the record at all');
});

test('a movement cannot invent a wallet for an organizer who has none', async () => {
  const { db, economy } = buildEconomy();
  const result = await economy.creditReward({
    organizerUid: 'ghost', amount: 50, idempotencyKey: 'reward-1', actorUid: 'admin-1'
  });

  assert.equal(result.code, 'WALLET_MISSING');
  assert.equal(result.applied, false);
  assert.equal(walletOf(db, 'ghost'), undefined, 'a refused credit must not open a balance');
  assert.equal(entryOf(db, 'reward-1'), undefined, 'and must not record one either');
});

test('a caller-supplied balance is ignored in favour of the balance that was read', async () => {
  const { db, economy } = buildEconomy({ wallets: { [UID]: walletData() } });
  const result = await economy.creditReward({
    organizerUid: UID,
    amount: 50,
    idempotencyKey: 'reward-1',
    // Exactly what a compromised or buggy client would send: a balance to be adopted.
    availableBalance: 9_999_999,
    balanceBefore: 9_999_999,
    lifetimeEarned: 9_999_999,
    currency: 'rupees'
  });

  assert.equal(result.code, 'COMPLETE');
  assert.equal(result.balanceBefore, 100, 'the entry measures the stored balance, not the claim');
  assert.equal(walletOf(db).availableBalance, 150);
  assert.equal(walletOf(db).currency, CURRENCY);
  assert.equal(entryOf(db, 'reward-1').balanceBefore, 100);
});

test('a reward credits the available balance and lifetime earned, with its entry, together', async () => {
  const { db, economy } = buildEconomy({ wallets: { [UID]: walletData() } });
  const result = await economy.creditReward({
    organizerUid: UID,
    amount: 50,
    idempotencyKey: 'reward-1',
    relatedTournamentId: 'tournament-77',
    reason: 'Deadline met',
    actorUid: 'scheduler'
  });

  assert.equal(result.availableBalance, 150);
  assert.deepEqual(entryOf(db, 'reward-1'), {
    organizerUid: UID,
    type: ENTRY_TYPES.REWARD_CREDIT,
    direction: DIRECTIONS.CREDIT,
    amount: 50,
    currency: CURRENCY,
    balanceBefore: 100,
    balanceAfter: 150,
    idempotencyKey: 'reward-1',
    relatedId: 'tournament-77',
    reason: 'Deadline met',
    actorUid: 'scheduler',
    status: ENTRY_STATUS.SETTLED,
    createdAt: 'SERVER_TS',
    updatedAt: 'SERVER_TS'
  });

  const wallet = walletOf(db);
  assert.equal(wallet.availableBalance, 150);
  assert.equal(wallet.lifetimeEarned, 150);
  assert.equal(wallet.version, 2, 'the balance carries a version so a stale write is visible');
  assert.equal(wallet.createdAt, 'SEEDED_TS', 'a movement never restamps the wallet’s own start');
  assert.equal(wallet.updatedAt, 'SERVER_TS');
});

test('a summary says a missing wallet is missing instead of reporting a zero that was earned', async () => {
  const { db, economy } = buildEconomy();
  const missing = await economy.getWalletSummary({ organizerUid: UID });

  assert.equal(missing.code, 'WALLET_MISSING');
  assert.equal(missing.exists, false);
  assert.equal(walletOf(db), undefined, 'reading a summary does not create the document');

  const read = await economy.getWalletSummary({ organizerUid: OTHER });
  assert.equal(read.exists, false);
});

// ==========================================================================
// Input validation, then the two atomicity guarantees
// ==========================================================================

test('a malformed movement is refused before any document is opened', async () => {
  const cases = [
    { args: { organizerUid: '', amount: 50, idempotencyKey: 'k' }, code: 'ORGANIZER_UID_INVALID' },
    { args: { organizerUid: UID, amount: 50, idempotencyKey: '' }, code: 'IDEMPOTENCY_KEY_REQUIRED' },
    { args: { organizerUid: UID, amount: 50, idempotencyKey: 'two words' }, code: 'IDEMPOTENCY_KEY_INVALID' },
    { args: { organizerUid: UID, amount: 50, idempotencyKey: 'a/b' }, code: 'IDEMPOTENCY_KEY_INVALID' },
    { args: { organizerUid: UID, amount: -50, idempotencyKey: 'k' }, code: 'AMOUNT_NEGATIVE' },
    { args: { organizerUid: UID, amount: 0, idempotencyKey: 'k' }, code: 'AMOUNT_ZERO' },
    { args: { organizerUid: UID, amount: 'fifty', idempotencyKey: 'k' }, code: 'AMOUNT_INVALID' },
    { args: { organizerUid: UID, amount: Number.NaN, idempotencyKey: 'k' }, code: 'AMOUNT_INVALID' },
    { args: { organizerUid: UID, amount: MAX_AMOUNT + 1, idempotencyKey: 'k' }, code: 'AMOUNT_TOO_LARGE' }
  ];

  for (const { args, code } of cases) {
    const { db, economy } = buildEconomy({ wallets: { [UID]: walletData() } });
    const result = await economy.creditReward({ ...args, actorUid: 'whoever' });
    assert.equal(result.code, code, `${JSON.stringify(args)} must be refused as ${code}`);
    assert.equal(result.applied, false);
    assert.equal(walletOf(db).version, 1, 'a refused request writes nothing');
    assert.equal((await db.collection(LEDGER_COLLECTION).get()).size, 0);
  }
});

test('an adjustment has to explain itself, and cannot push the balance below zero', async () => {
  const unexplained = buildEconomy({ wallets: { [UID]: walletData() } });
  const silent = await unexplained.economy.adjustBalance({
    organizerUid: UID, delta: -50, idempotencyKey: 'adj-1', actorUid: 'admin-1'
  });
  assert.equal(silent.code, 'REASON_REQUIRED');
  assert.equal(walletOf(unexplained.db).availableBalance, 100);

  const overdraft = buildEconomy({ wallets: { [UID]: walletData() } });
  const result = await overdraft.economy.adjustBalance({
    organizerUid: UID, delta: -500, idempotencyKey: 'adj-2', reason: 'Clerical fix', actorUid: 'admin-1'
  });
  assert.equal(result.code, 'INSUFFICIENT_BALANCE');
  assert.equal(walletOf(overdraft.db).availableBalance, 100);
  assert.equal(entryOf(overdraft.db, 'adj-2'), undefined);
});

test('a deduction the balance cannot cover is refused, and nothing is recorded', async () => {
  const { db, economy } = buildEconomy({ wallets: { [UID]: walletData() } });
  const result = await economy.deductPenalty({
    organizerUid: UID, amount: 500, idempotencyKey: 'penalty-1',
    relatedViolationId: 'violation-9', reason: 'Missed deadline', actorUid: 'scheduler'
  });

  assert.equal(result.code, 'INSUFFICIENT_BALANCE');
  assert.equal(walletOf(db).availableBalance, 100);
  assert.equal(entryOf(db, 'penalty-1'), undefined, 'a refused penalty must still not appear on the ledger');
});

test('a lost ledger write rolls the balance back with it', async () => {
  const { db, economy } = buildEconomy({ wallets: { [UID]: walletData() } });
  db.__fail(LEDGER_COLLECTION, 'reward-1', 'set');

  await assert.rejects(
    () => economy.creditReward({ organizerUid: UID, amount: 50, idempotencyKey: 'reward-1' }),
    /injected failure/
  );
  assert.equal(walletOf(db).availableBalance, 100, 'no balance moved without its entry');
  assert.equal(walletOf(db).version, 1);
});

test('a lost balance write rolls the ledger entry back with it', async () => {
  const { db, economy } = buildEconomy({ wallets: { [UID]: walletData() } });
  db.__fail(WALLET_COLLECTION, UID, 'set');

  await assert.rejects(
    () => economy.creditReward({ organizerUid: UID, amount: 50, idempotencyKey: 'reward-1' }),
    /injected failure/
  );
  assert.equal(entryOf(db, 'reward-1'), undefined, 'no entry was committed without its balance');
});

test('a replayed request is reported as already recorded and moves nothing', async () => {
  const { db, economy } = buildEconomy({ wallets: { [UID]: walletData() } });
  const first = await economy.creditReward({ organizerUid: UID, amount: 50, idempotencyKey: 'reward-1' });
  const replay = await economy.creditReward({ organizerUid: UID, amount: 50, idempotencyKey: 'reward-1' });

  assert.equal(first.code, 'COMPLETE');
  assert.equal(replay.code, 'DUPLICATE');
  assert.equal(replay.applied, false);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.amount, 50, 'the replay reports the coins that actually moved, first time');
  assert.equal(walletOf(db).availableBalance, 150, 'one request, one credit');
  assert.equal(walletOf(db).version, 2);
});

test('a compensating adjustment leaves the entry it corrects exactly as it was', async () => {
  const { db, economy } = buildEconomy({ wallets: { [UID]: walletData() } });
  await economy.creditReward({ organizerUid: UID, amount: 50, idempotencyKey: 'reward-1' });

  const result = await economy.adjustBalance({
    organizerUid: UID, delta: -50, idempotencyKey: 'adj-1',
    relatedEntryId: 'reward-1', reason: 'Reward paid to the wrong organizer', actorUid: 'admin-1'
  });

  assert.equal(result.code, 'COMPLETE');
  assert.deepEqual(entryOf(db, 'reward-1'), {
    organizerUid: UID,
    type: ENTRY_TYPES.REWARD_CREDIT,
    direction: DIRECTIONS.CREDIT,
    amount: 50,
    currency: CURRENCY,
    balanceBefore: 100,
    balanceAfter: 150,
    idempotencyKey: 'reward-1',
    relatedId: null,
    reason: null,
    actorUid: null,
    status: ENTRY_STATUS.SETTLED,
    createdAt: 'SERVER_TS',
    updatedAt: 'SERVER_TS'
  }, 'a settled entry is never edited');

  const correction = entryOf(db, 'adj-1');
  assert.equal(correction.type, ENTRY_TYPES.ADMIN_ADJUSTMENT);
  assert.equal(correction.direction, DIRECTIONS.DEBIT);
  assert.equal(correction.amount, 50, 'the ledger stores a magnitude beside a direction, not a signed amount');
  assert.equal(correction.relatedId, 'reward-1');

  const wallet = walletOf(db);
  assert.equal(wallet.availableBalance, 100);
  assert.equal(wallet.lifetimeEarned, 150, 'a correction is not a reward, so lifetime earned does not move');
});

// ==========================================================================
// Concurrency
// ==========================================================================

test('two simultaneous movements both land, each on the balance that actually won', async () => {
  const { db, economy } = buildEconomy({ wallets: { [UID]: walletData() }, serializable: true });
  const results = await Promise.all([
    economy.creditReward({ organizerUid: UID, amount: 50, idempotencyKey: 'reward-1' }),
    economy.creditReward({ organizerUid: UID, amount: 60, idempotencyKey: 'reward-2' })
  ]);

  assert.deepEqual(results.map(result => result.code).sort(), ['COMPLETE', 'COMPLETE']);
  assert.equal(walletOf(db).availableBalance, 210, 'the loser retried on the new balance instead of overwriting it');
  assert.equal(walletOf(db).version, 3);
  assert.deepEqual(
    [entryOf(db, 'reward-1').balanceBefore, entryOf(db, 'reward-2').balanceBefore].sort((a, b) => a - b),
    [100, 150],
    'every entry measures a balance that existed when it was written'
  );
});

test('two simultaneous replays of one request still record one movement', async () => {
  const { db, economy } = buildEconomy({ wallets: { [UID]: walletData() }, serializable: true });
  const results = await Promise.all([
    economy.creditReward({ organizerUid: UID, amount: 50, idempotencyKey: 'reward-1' }),
    economy.creditReward({ organizerUid: UID, amount: 50, idempotencyKey: 'reward-1' })
  ]);

  const applied = results.filter(result => result.applied);
  assert.equal(applied.length, 1, JSON.stringify(results));
  assert.equal(results.find(result => !result.applied).code, 'DUPLICATE');
  assert.equal(walletOf(db).availableBalance, 150);
  assert.equal(walletOf(db).version, 2);
});

// ==========================================================================
// Reservations
//
// A hold moves coins from available to reserved, and closing it can only ever happen once.
// That one-way status is what stops a withdrawal being both paid and refunded.
// ==========================================================================

async function withReservedHeld(economy, { amount = 40, key = 'hold-1', uid = UID } = {}) {
  return economy.reserveFunds({
    organizerUid: uid, amount, idempotencyKey: key,
    relatedWithdrawalId: 'withdrawal-1', reason: 'Withdrawal request', actorUid: uid
  });
}

test('a reservation moves coins sideways and cannot exceed what is available', async () => {
  const refused = buildEconomy({ wallets: { [UID]: walletData() } });
  const over = await refused.economy.reserveFunds({
    organizerUid: UID, amount: 150, idempotencyKey: 'hold-1'
  });
  assert.equal(over.code, 'INSUFFICIENT_BALANCE');
  assert.equal(walletOf(refused.db).availableBalance, 100);
  assert.equal(entryOf(refused.db, 'hold-1'), undefined);

  const { db, economy } = buildEconomy({ wallets: { [UID]: walletData() } });
  const held = await withReservedHeld(economy);
  assert.equal(held.code, 'COMPLETE');
  assert.equal(held.availableBalance, 60);
  assert.equal(held.reservedBalance, 40);

  const hold = entryOf(db, 'hold-1');
  assert.equal(hold.type, ENTRY_TYPES.WITHDRAWAL_RESERVATION);
  assert.equal(hold.direction, DIRECTIONS.HOLD);
  assert.equal(hold.status, HOLD_STATES.RESERVED, 'an open hold is the only state a closer accepts');
  assert.equal(hold.amount, 40);
});

test('finalizing a reservation stops it being held, and does not deduct a second time', async () => {
  const { db, economy } = buildEconomy({ wallets: { [UID]: walletData() } });
  await withReservedHeld(economy);
  const before = walletOf(db);

  const result = await economy.finalizeReservation({ organizerUid: UID, reservationKey: 'hold-1' });
  assert.equal(result.code, 'COMPLETE');
  assert.equal(result.amount, 40, 'the hold names the amount; a caller cannot close it for more');

  const wallet = walletOf(db);
  assert.equal(wallet.availableBalance, before.availableBalance, 'the coins already left available');
  assert.equal(wallet.reservedBalance, 0);
  assert.equal(entryOf(db, 'hold-1:finalize').type, ENTRY_TYPES.WITHDRAWAL_FINALIZATION);
  assert.equal(entryOf(db, 'hold-1').status, HOLD_STATES.FINALIZED);
  assert.equal(entryOf(db, 'hold-1').closedByKey, 'hold-1:finalize');
  assert.equal(entryOf(db, 'hold-1').amount, 40, 'closing a hold does not rewrite the hold');
  assert.equal(entryOf(db, 'hold-1').organizerUid, UID);
});

test('a reservation whose amount a caller tries to name is closed for the held amount', async () => {
  const { db, economy } = buildEconomy({ wallets: { [UID]: walletData() } });
  await withReservedHeld(economy, { amount: 40 });

  const result = await economy.finalizeReservation({
    organizerUid: UID, reservationKey: 'hold-1', idempotencyKey: 'close-1', amount: 90, availableBalance: 999
  });
  assert.equal(result.code, 'COMPLETE');
  assert.equal(result.amount, 40);
  assert.equal(entryOf(db, 'close-1').amount, 40);
  assert.equal(walletOf(db).reservedBalance, 0);
});

test('releasing a reservation gives the coins back exactly once', async () => {
  const { db, economy } = buildEconomy({ wallets: { [UID]: walletData() } });
  await withReservedHeld(economy);

  const released = await economy.releaseReservation({ organizerUid: UID, reservationKey: 'hold-1' });
  assert.equal(released.code, 'COMPLETE');
  assert.equal(walletOf(db).availableBalance, 100);
  assert.equal(walletOf(db).reservedBalance, 0);
  assert.equal(entryOf(db, 'hold-1').status, HOLD_STATES.RELEASED);

  const again = await economy.releaseReservation({ organizerUid: UID, reservationKey: 'hold-1' });
  assert.equal(again.code, 'DUPLICATE', 'the same closing attempt is a retry, not a second refund');
  assert.equal(again.applied, false);
  assert.equal(walletOf(db).availableBalance, 100);
  assert.equal(walletOf(db).version, 3);
});

test('a hold cannot be closed twice in different ways', async () => {
  const { db, economy } = buildEconomy({ wallets: { [UID]: walletData() } });
  await withReservedHeld(economy);
  await economy.finalizeReservation({ organizerUid: UID, reservationKey: 'hold-1' });

  const refund = await economy.releaseReservation({
    organizerUid: UID, reservationKey: 'hold-1', idempotencyKey: 'release-late'
  });
  assert.equal(refund.code, 'ALREADY_CLOSED');
  assert.equal(refund.status, HOLD_STATES.FINALIZED);
  assert.equal(walletOf(db).availableBalance, 60, 'paid coins do not come back because somebody asked');
  assert.equal(entryOf(db, 'release-late'), undefined);
});

test('a closer that cannot find the reservation, or finds somebody else’s, is refused', async () => {
  const missing = buildEconomy({ wallets: { [UID]: walletData() } });
  const absent = await missing.economy.finalizeReservation({ organizerUid: UID, reservationKey: 'no-such-hold' });
  assert.equal(absent.code, 'RESERVATION_MISSING');
  assert.equal(walletOf(missing.db).availableBalance, 100);

  const { db, economy } = buildEconomy({
    wallets: { [UID]: walletData(), [OTHER]: walletData({ availableBalance: 10 }) },
    ledger: {
      'hold-b': {
        organizerUid: OTHER,
        type: ENTRY_TYPES.WITHDRAWAL_RESERVATION,
        direction: DIRECTIONS.HOLD,
        amount: 40,
        status: HOLD_STATES.RESERVED,
        currency: CURRENCY
      }
    }
  });

  const stolen = await economy.finalizeReservation({ organizerUid: UID, reservationKey: 'hold-b' });
  assert.equal(stolen.code, 'FORBIDDEN');
  assert.equal(entryOf(db, 'hold-b').status, HOLD_STATES.RESERVED, 'another organizer’s hold stays open');
  assert.equal(entryOf(db, 'hold-b:finalize'), undefined, 'and no closing entry is written for it');
});

test('a reservation and a penalty that race cannot both spend the same coins', async () => {
  const { db, economy } = buildEconomy({ wallets: { [UID]: walletData() }, serializable: true });
  const results = await Promise.all([
    economy.reserveFunds({ organizerUid: UID, amount: 80, idempotencyKey: 'hold-1' }),
    economy.deductPenalty({ organizerUid: UID, amount: 80, idempotencyKey: 'penalty-1', reason: 'Late' })
  ]);

  const applied = results.filter(result => result.applied);
  assert.equal(applied.length, 1, JSON.stringify(results));
  assert.equal(results.find(result => !result.applied).code, 'INSUFFICIENT_BALANCE');

  const wallet = walletOf(db);
  assert.equal(wallet.availableBalance, 20, 'one of the two claims won outright, and only one');
  assert.equal((await db.collection(LEDGER_COLLECTION).get()).size, 1);
});

test('a finalize and a release that race produce exactly one valid outcome', async () => {
  const { db, economy } = buildEconomy({ wallets: { [UID]: walletData() }, serializable: true });
  await withReservedHeld(economy);

  const results = await Promise.all([
    economy.finalizeReservation({ organizerUid: UID, reservationKey: 'hold-1' }),
    economy.releaseReservation({ organizerUid: UID, reservationKey: 'hold-1' })
  ]);

  const applied = results.filter(result => result.applied);
  assert.equal(applied.length, 1, JSON.stringify(results));
  assert.equal(results.find(result => !result.applied).code, 'ALREADY_CLOSED');

  const wallet = walletOf(db);
  const hold = entryOf(db, 'hold-1');
  assert.equal(wallet.reservedBalance, 0, 'the hold is closed either way');
  assert.ok([HOLD_STATES.FINALIZED, HOLD_STATES.RELEASED].includes(hold.status));
  assert.equal(
    hold.status === HOLD_STATES.FINALIZED ? 60 : 100,
    wallet.availableBalance,
    'and the balance matches the one outcome that won'
  );
});

// ==========================================================================
// Settings
//
// The document is read here so a later phase takes its amount from the server-side copy
// rather than from a client. Reading it must never reach a player payment setting.
// ==========================================================================

test('an absent settings document reads as the inert defaults', async () => {
  const { economy } = buildEconomy();
  assert.deepEqual(await economy.readConfig(), {
    exists: false,
    defaultRewardPerTournament: 0,
    defaultDeadlinePenalty: 0,
    defaultDailyTournamentLimit: 0,
    // A document nobody has written has not enabled the deadline penalty and has named no
    // grace period. Both defaults are the narrowest possible answer.
    deadlinePenaltyEnabled: false,
    deadlineGraceMinutes: 0,
    currency: CURRENCY
  });
});

test('a partial or out-of-range settings document still reads, and falls back field by field', async () => {
  const partial = buildEconomy({ config: { [CONFIG_DOCUMENT]: { defaultRewardPerTournament: 500 } } });
  assert.deepEqual(await partial.economy.readConfig(), {
    exists: true,
    defaultRewardPerTournament: 500,
    defaultDeadlinePenalty: 0,
    defaultDailyTournamentLimit: 0,
    deadlinePenaltyEnabled: false,
    deadlineGraceMinutes: 0,
    currency: CURRENCY
  });

  const broken = buildEconomy({
    config: {
      [CONFIG_DOCUMENT]: {
        defaultRewardPerTournament: -25,
        defaultDeadlinePenalty: 1e9,
        defaultDailyTournamentLimit: 2.5,
        // A grace period that is fractional, negative or beyond a day is not a wider window
        // than an admin approved - it is no grace period at all.
        deadlineGraceMinutes: 1e9,
        deadlinePenaltyEnabled: 'yes',
        minDeposit: 100,
        upiId: 'pgr@ybl'
      }
    }
  });
  assert.deepEqual(await broken.economy.readConfig(), {
    exists: true,
    defaultRewardPerTournament: 0,
    defaultDeadlinePenalty: 0,
    defaultDailyTournamentLimit: 0,
    deadlinePenaltyEnabled: false,
    deadlineGraceMinutes: 0,
    currency: CURRENCY
  }, 'a junk setting is treated as unset, never applied, and never leaked');
});

test('the deadline penalty is on only when it is named on, with a grace period in range', async () => {
  const enabled = buildEconomy({
    config: {
      [CONFIG_DOCUMENT]: {
        defaultDeadlinePenalty: 50,
        deadlinePenaltyEnabled: true,
        deadlineGraceMinutes: 15
      }
    }
  });
  const read = await enabled.economy.readConfig();
  assert.equal(read.deadlinePenaltyEnabled, true);
  assert.equal(read.deadlineGraceMinutes, 15);
  assert.equal(read.defaultDeadlinePenalty, 50);

  // A stored amount without the switch is not permission to charge anybody.
  const armedButOff = buildEconomy({
    config: { [CONFIG_DOCUMENT]: { defaultDeadlinePenalty: 50, deadlineGraceMinutes: 30 } }
  });
  const off = await armedButOff.economy.readConfig();
  assert.equal(off.deadlinePenaltyEnabled, false, 'absent means off, never implied');
  assert.equal(off.defaultDeadlinePenalty, 50, 'and the amount is still simply a stored amount');

  // The outer bound the Admin screen and the rules share.
  const widest = buildEconomy({
    config: { [CONFIG_DOCUMENT]: { deadlinePenaltyEnabled: true, deadlineGraceMinutes: MAX_GRACE_MINUTES } }
  });
  assert.equal((await widest.economy.readConfig()).deadlineGraceMinutes, MAX_GRACE_MINUTES);
});
