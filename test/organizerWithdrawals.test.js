/**
 * Phase 5: organizer withdrawal requests, and the reservation state machine behind them.
 *
 * The money itself belongs to `organizerEconomy.js`; these tests are about the parts this
 * service owns: who may ask, what a request may claim about itself, whether a retry or a race
 * can produce a second hold, and whether an approval finalizes the hold it found instead of
 * taking the coins out a second time. Organizer coins are never rupees anywhere in here, and
 * no test has to check for a gateway because none is claimed: an approved row is an admin
 * decision, recorded as `manual_admin_review`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createOrganizerEconomyService,
  WALLET_COLLECTION,
  LEDGER_COLLECTION,
  ENTRY_TYPES,
  HOLD_STATES,
  CURRENCY,
  MAX_AMOUNT
} = require('../services/organizerEconomy');
const {
  createOrganizerWithdrawalService,
  REQUESTS_COLLECTION,
  REQUEST_STATUS,
  PAYOUT_MANUAL,
  requestIdFor,
  reservationKeyFor
} = require('../services/organizerWithdrawals');
const { createFakeFirestore } = require('./helpers/fakeFirestore');

const UID = 'organizer-a';
const OTHER = 'organizer-b';
const ADMIN = 'admin-1';
const TOKEN = 'aaaa1111-bbbb2222';
const UPI = 'org_a@ybl';

function account(uid, over = {}) {
  return { uid, username: 'org_a', isActive: true, banned: false, regions: ['IN'], ...over };
}

function walletData(over = {}) {
  return {
    availableBalance: 1000,
    reservedBalance: 0,
    lifetimeEarned: 1000,
    lifetimePenalized: 0,
    currency: CURRENCY,
    version: 1,
    createdAt: 'SEEDED_TS',
    ...over
  };
}

function build({
  accounts = { [UID]: account(UID), [OTHER]: account(OTHER, { username: 'org_b' }) },
  wallets = { [UID]: walletData(), [OTHER]: walletData() },
  requests = {},
  ledger = {},
  serializable = false
} = {}) {
  const db = createFakeFirestore({
    organizer_users: accounts,
    [WALLET_COLLECTION]: wallets,
    [LEDGER_COLLECTION]: ledger,
    [REQUESTS_COLLECTION]: requests
  }, { serializable });
  const economy = createOrganizerEconomyService({ db, serverTimestamp: () => 'SERVER_TS' });
  const withdrawals = createOrganizerWithdrawalService({
    db, economy, serverTimestamp: () => 'SERVER_TS'
  });
  return { db, economy, withdrawals };
}

const requestOf = (db, id) => db.__peek(REQUESTS_COLLECTION, id);
const entryOf = (db, key) => db.__peek(LEDGER_COLLECTION, key);
const walletOf = (db, uid = UID) => db.__peek(WALLET_COLLECTION, uid);

/** Creates one pending request and returns its id, so a review test starts from a real hold. */
async function pendingWithdrawal(amount = 400, over = {}) {
  const context = build(over.context || {});
  const created = await context.withdrawals.createRequest({
    organizerUid: UID, amount, upiId: UPI, idempotencyToken: TOKEN, ...over.create
  });
  return { ...context, created, requestId: created.requestId };
}

// ==========================================================================
// B3 - validation, before any document is opened
// ==========================================================================

test('the service refuses to be built without a database, an economy and a clock', () => {
  assert.throws(() => createOrganizerWithdrawalService({}), /requires/);
  assert.throws(() => createOrganizerWithdrawalService({ db: {} }), /requires/);
  assert.throws(() => createOrganizerWithdrawalService({ db: {}, economy: {} }), /requires/);
});

test('a request that is malformed in any way is refused and writes nothing', async () => {
  const cases = [
    [{ organizerUid: '', amount: 100, upiId: UPI, idempotencyToken: TOKEN }, 'ORGANIZER_UID_INVALID'],
    [{ organizerUid: 'a'.repeat(200), amount: 100, upiId: UPI, idempotencyToken: TOKEN }, 'ORGANIZER_UID_INVALID'],
    [{ organizerUid: UID, amount: 100, upiId: UPI, idempotencyToken: '' }, 'IDEMPOTENCY_TOKEN_INVALID'],
    [{ organizerUid: UID, amount: 100, upiId: UPI, idempotencyToken: 'short' }, 'IDEMPOTENCY_TOKEN_INVALID'],
    [{ organizerUid: UID, amount: 100, upiId: UPI, idempotencyToken: 'has spaces here' }, 'IDEMPOTENCY_TOKEN_INVALID'],
    [{ organizerUid: UID, amount: 100, upiId: UPI, idempotencyToken: 'sl/ash' }, 'IDEMPOTENCY_TOKEN_INVALID'],
    [{ organizerUid: UID, amount: 0, upiId: UPI, idempotencyToken: TOKEN }, 'AMOUNT_INVALID'],
    [{ organizerUid: UID, amount: -50, upiId: UPI, idempotencyToken: TOKEN }, 'AMOUNT_INVALID'],
    [{ organizerUid: UID, amount: 'four hundred', upiId: UPI, idempotencyToken: TOKEN }, 'AMOUNT_INVALID'],
    [{ organizerUid: UID, amount: NaN, upiId: UPI, idempotencyToken: TOKEN }, 'AMOUNT_INVALID'],
    [{ organizerUid: UID, amount: MAX_AMOUNT + 1, upiId: UPI, idempotencyToken: TOKEN }, 'AMOUNT_INVALID'],
    // The coin model is two decimals at most, which is what the economy can hold exactly.
    [{ organizerUid: UID, amount: 100.005, upiId: UPI, idempotencyToken: TOKEN }, 'AMOUNT_INVALID'],
    [{ organizerUid: UID, amount: 100, upiId: '', idempotencyToken: TOKEN }, 'UPI_ID_INVALID'],
    [{ organizerUid: UID, amount: 100, upiId: 'no-at-sign', idempotencyToken: TOKEN }, 'UPI_ID_INVALID'],
    [{ organizerUid: UID, amount: 100, upiId: '@ybl', idempotencyToken: TOKEN }, 'UPI_ID_INVALID'],
    [{ organizerUid: UID, amount: 100, upiId: 'name@', idempotencyToken: TOKEN }, 'UPI_ID_INVALID'],
    [{ organizerUid: UID, amount: 100, upiId: 'name@12345', idempotencyToken: TOKEN }, 'UPI_ID_INVALID'],
    // A PIN or a password is not a payout handle, and is refused rather than stored.
    [{ organizerUid: UID, amount: 100, upiId: '1234', idempotencyToken: TOKEN }, 'UPI_ID_INVALID'],
    [{ organizerUid: UID, amount: 100, upiId: 'name@bank@second', idempotencyToken: TOKEN }, 'UPI_ID_INVALID']
  ];

  for (const [args, code] of cases) {
    const { db, withdrawals } = build();
    const result = await withdrawals.createRequest(args);
    assert.equal(result.code, code, `${JSON.stringify(args)} must be refused as ${code}`);
    assert.equal(result.applied, false);
    assert.ok(!result.requestId, 'a refused request does not claim an id');
    assert.equal((await db.collection(REQUESTS_COLLECTION).get()).size, 0);
    assert.equal(walletOf(db).version, 1, 'and it does not touch the wallet');
    assert.equal((await db.collection(LEDGER_COLLECTION).get()).size, 0);
  }
});

test('only a registered, active, unbanned organizer can ask to be paid out', async () => {
  const stranger = build({ accounts: {}, wallets: { 'ghost-uid': walletData() } });
  assert.equal((await stranger.withdrawals.createRequest({
    organizerUid: 'ghost-uid', amount: 100, upiId: UPI, idempotencyToken: TOKEN
  })).code, 'NOT_AN_ORGANIZER');
  assert.equal((await stranger.db.collection(REQUESTS_COLLECTION).get()).size, 0);

  const banned = build({ accounts: { [UID]: account(UID, { banned: true }) } });
  assert.equal((await banned.withdrawals.createRequest({
    organizerUid: UID, amount: 100, upiId: UPI, idempotencyToken: TOKEN
  })).code, 'ORGANIZER_BANNED');

  const inactive = build({ accounts: { [UID]: account(UID, { isActive: false }) } });
  assert.equal((await inactive.withdrawals.createRequest({
    organizerUid: UID, amount: 100, upiId: UPI, idempotencyToken: TOKEN
  })).code, 'ORGANIZER_INACTIVE');

  assert.equal(walletOf(banned.db).availableBalance, 1000, 'a refused account keeps its coins idle');
  assert.equal((await banned.db.collection(LEDGER_COLLECTION).get()).size, 0);
});

// ==========================================================================
// B1 - what a request actually stores
// ==========================================================================

test('a created request holds its coins and says who asked, for how many, where to pay', async () => {
  const { db, withdrawals } = build();
  const result = await withdrawals.createRequest({
    organizerUid: UID, amount: 400, upiId: UPI, idempotencyToken: TOKEN
  });

  assert.equal(result.code, 'COMPLETE');
  assert.equal(result.applied, true);
  const stored = requestOf(db, result.requestId);
  assert.deepEqual(stored, {
    organizerUid: UID,
    amount: 400,
    currency: CURRENCY,
    upiId: UPI,
    idempotencyToken: TOKEN,
    status: REQUEST_STATUS.PENDING,
    reservationKey: reservationKeyFor(result.requestId),
    payout: PAYOUT_MANUAL,
    createdAt: 'SERVER_TS',
    updatedAt: 'SERVER_TS'
  });

  const wallet = walletOf(db);
  assert.equal(wallet.availableBalance, 600, 'the requested coins left the available side');
  assert.equal(wallet.reservedBalance, 400, 'and are now held for this request and nothing else');
  assert.equal(wallet.currency, CURRENCY, 'in coins, never in rupees');

  const hold = entryOf(db, reservationKeyFor(result.requestId));
  assert.equal(hold.type, ENTRY_TYPES.WITHDRAWAL_RESERVATION);
  assert.equal(hold.status, HOLD_STATES.RESERVED);
  assert.equal(hold.amount, 400);
  assert.equal(hold.relatedId, result.requestId);
});

test('the request id is the caller\'s token and nobody else\'s, deterministically', async () => {
  const { db, withdrawals } = build();
  const first = await withdrawals.createRequest({
    organizerUid: UID, amount: 100, upiId: UPI, idempotencyToken: TOKEN
  });
  const second = await withdrawals.createRequest({
    organizerUid: OTHER, amount: 100, upiId: 'org_b@ybl', idempotencyToken: TOKEN
  });

  // The same token from a different organizer is a different request, not a read of the first.
  assert.notEqual(first.requestId, second.requestId);
  assert.equal(requestIdFor({ organizerUid: UID, token: TOKEN }), first.requestId);
  assert.equal(requestOf(db, second.requestId).organizerUid, OTHER);
  assert.ok(first.requestId.length <= 150, 'and the id stays inside a document id');
});

test('a request cannot be pointed at another organizer, even by its owner', async () => {
  const { db, withdrawals } = build();
  const created = await withdrawals.createRequest({
    organizerUid: UID, amount: 100, upiId: UPI, idempotencyToken: TOKEN
  });

  // Exactly what a forged body would carry: a claimed status and a claimed reviewer, beside a
  // token the caller already used. Neither field is read back out of a create request.
  const forged = await withdrawals.createRequest({
    organizerUid: UID, amount: 100, upiId: UPI, idempotencyToken: TOKEN,
    status: REQUEST_STATUS.APPROVED, reviewedBy: ADMIN
  });
  assert.equal(forged.duplicate, true, 'a known token is the caller\'s own request, nothing new');
  assert.equal(forged.request.organizerUid, UID);
  assert.equal(requestOf(db, created.requestId).status, REQUEST_STATUS.PENDING);
  assert.equal(requestOf(db, created.requestId).organizerUid, UID);
  assert.equal(requestOf(db, created.requestId).reviewedBy, undefined);
});

test('a token reused by a different organizer is its own request, never somebody else\'s', async () => {
  const uidRequest = requestIdFor({ organizerUid: UID, token: TOKEN });
  const { db, withdrawals } = build({
    requests: { [uidRequest]: { organizerUid: UID, amount: 100,
      status: REQUEST_STATUS.AWAITING_RESERVATION } }
  });
  const other = await withdrawals.createRequest({
    organizerUid: OTHER, amount: 100, upiId: 'org_b@ybl', idempotencyToken: TOKEN
  });

  assert.equal(other.code, 'COMPLETE');
  assert.notEqual(other.requestId, uidRequest,
    'the id is a function of the caller as well as the token, so the two cannot meet');
  assert.equal(requestOf(db, uidRequest).status, REQUEST_STATUS.AWAITING_RESERVATION,
    'and the request the other organizer left half-finished stays exactly as it was');
  assert.equal(walletOf(db, UID).reservedBalance, 0, 'with no coins reserved on it by a stranger');
});

test('a request whose document names another organizer cannot be resumed by its id', async () => {
  // The FORBIDDEN branch is the guard against a row that does not agree with its own id: a
  // document written for THIS caller's uid digest, but naming a different organizer inside it.
  const callerId = requestIdFor({ organizerUid: OTHER, token: TOKEN });
  const { db, withdrawals } = build({
    requests: { [callerId]: { organizerUid: UID, amount: 100,
      status: REQUEST_STATUS.AWAITING_RESERVATION } }
  });
  const result = await withdrawals.createRequest({
    organizerUid: OTHER, amount: 100, upiId: 'org_b@ybl', idempotencyToken: TOKEN
  });

  assert.equal(result.code, 'FORBIDDEN');
  assert.equal(result.applied, false);
  assert.equal(entryOf(db, reservationKeyFor(callerId)), undefined,
    'a mismatched owner is refused before anything is held');
  assert.equal(requestOf(db, callerId).status, REQUEST_STATUS.AWAITING_RESERVATION);
});

// ==========================================================================
// B3 - retries, races and partial failures
// ==========================================================================

test('retrying the same request reserves nothing a second time', async () => {
  const { db, withdrawals } = build();
  const first = await withdrawals.createRequest({
    organizerUid: UID, amount: 400, upiId: UPI, idempotencyToken: TOKEN
  });
  const retry = await withdrawals.createRequest({
    organizerUid: UID, amount: 400, upiId: UPI, idempotencyToken: TOKEN
  });

  assert.equal(retry.code, 'COMPLETE');
  assert.equal(retry.duplicate, true);
  assert.equal(retry.applied, false);
  assert.equal(retry.requestId, first.requestId);
  assert.equal(walletOf(db).reservedBalance, 400, 'one hold, not two');
  assert.equal(walletOf(db).availableBalance, 600);
  assert.equal((await db.collection(REQUESTS_COLLECTION).get()).size, 1);
  assert.equal((await db.collection(LEDGER_COLLECTION).get()).size, 1);
});

test('two simultaneous creates of one token still produce one request and one hold', async () => {
  const { db, withdrawals } = build({ serializable: true });
  const results = await Promise.all([
    withdrawals.createRequest({ organizerUid: UID, amount: 400, upiId: UPI, idempotencyToken: TOKEN }),
    withdrawals.createRequest({ organizerUid: UID, amount: 400, upiId: UPI, idempotencyToken: TOKEN })
  ]);

  const applied = results.filter(result => result.applied === true).length;
  assert.ok(applied <= 1, `at most one create may claim to have reserved: ${applied}`);
  assert.equal(walletOf(db).reservedBalance, 400, 'the coins are held exactly once');
  assert.equal((await db.collection(REQUESTS_COLLECTION).get()).size, 1);
  assert.equal((await db.collection(LEDGER_COLLECTION).get()).size, 1);
  for (const result of results) assert.match(result.requestId, /^wd_/);
});

test('a fresh token is a fresh request, and both holds are respected', async () => {
  const { db, withdrawals } = build();
  await withdrawals.createRequest({ organizerUid: UID, amount: 400, upiId: UPI, idempotencyToken: TOKEN });
  const second = await withdrawals.createRequest({
    organizerUid: UID, amount: 300, upiId: UPI, idempotencyToken: 'cccc3333-dddd4444'
  });

  assert.equal(second.code, 'COMPLETE');
  assert.equal(walletOf(db).availableBalance, 300);
  assert.equal(walletOf(db).reservedBalance, 700);
});

test('a wallet that cannot cover the request is not reserved, and the request says so', async () => {
  const { db, withdrawals } = build();
  const result = await withdrawals.createRequest({
    organizerUid: UID, amount: 5000, upiId: UPI, idempotencyToken: TOKEN
  });

  assert.equal(result.code, 'INSUFFICIENT_BALANCE');
  assert.equal(result.applied, false);
  assert.equal(requestOf(db, result.requestId).status, REQUEST_STATUS.RESERVATION_FAILED);
  assert.match(requestOf(db, result.requestId).note, /Only 1000 coins were available/);
  assert.equal(walletOf(db).availableBalance, 1000);
  assert.equal(walletOf(db).reservedBalance, 0);
  assert.equal((await db.collection(LEDGER_COLLECTION).get()).size, 0,
    'a request that never held coins never books a hold');
});

test('a dropped reservation leaves an explainable request that a retry finishes', async () => {
  const { db, withdrawals } = build();
  // The connection fails on the way to the wallet: the request document exists, the hold does
  // not. This is the half-finished state the state machine exists for.
  const requestId = requestIdFor({ organizerUid: UID, token: TOKEN });
  const reservationKey = reservationKeyFor(requestId);
  db.__fail(WALLET_COLLECTION, UID, 'set');
  await assert.rejects(() => withdrawals.createRequest({
    organizerUid: UID, amount: 400, upiId: UPI, idempotencyToken: TOKEN
  }));

  assert.equal(requestOf(db, requestId).status, REQUEST_STATUS.AWAITING_RESERVATION);
  assert.equal(walletOf(db).reservedBalance, 0, 'nothing is held with no request explaining it');
  assert.equal(entryOf(db, reservationKey), undefined);

  // The organizer retries with the same token once the connection is back.
  db.__heal(WALLET_COLLECTION, UID, 'set');
  const resumed = await withdrawals.createRequest({
    organizerUid: UID, amount: 400, upiId: UPI, idempotencyToken: TOKEN
  });
  assert.equal(resumed.code, 'COMPLETE');
  assert.equal(resumed.resumed, true);
  assert.equal(requestOf(db, requestId).status, REQUEST_STATUS.PENDING);
  assert.equal(walletOf(db).reservedBalance, 400, 'and exactly one hold exists');
  assert.equal((await db.collection(REQUESTS_COLLECTION).get()).size, 1);
  assert.equal((await db.collection(LEDGER_COLLECTION).get()).size, 1);
});

// ==========================================================================
// B4 - approval finalizes; rejection releases; neither happens twice
// ==========================================================================

test('approving finalizes the hold without deducting the coins a second time', async () => {
  const { db, requestId, withdrawals } = await pendingWithdrawal();
  assert.equal(walletOf(db).availableBalance, 600);
  assert.equal(walletOf(db).reservedBalance, 400);

  const result = await withdrawals.reviewRequest({
    requestId, reviewerUid: ADMIN, decision: 'approve'
  });
  assert.equal(result.code, 'COMPLETE');
  assert.equal(result.applied, true);

  assert.equal(walletOf(db).availableBalance, 600, 'the available side already paid when held');
  assert.equal(walletOf(db).reservedBalance, 0, 'and the hold is now closed');
  assert.equal(walletOf(db).lifetimePenalized, 0, 'an approved payout is not a penalty');

  const stored = requestOf(db, requestId);
  assert.equal(stored.status, REQUEST_STATUS.APPROVED);
  assert.equal(stored.reviewedBy, ADMIN);
  assert.equal(stored.payout, PAYOUT_MANUAL, 'and it still says no gateway paid anybody');
  assert.equal(stored.amount, 400, 'the approved amount is the requested amount');

  const hold = entryOf(db, reservationKeyFor(requestId));
  assert.equal(hold.status, HOLD_STATES.FINALIZED);
  assert.equal(hold.closedByKey, `${reservationKeyFor(requestId)}:finalize`);
});

test('a double approval, from two admins at once, moves the coins once', async () => {
  const { db, requestId, withdrawals } = await pendingWithdrawal(400, { context: {
    accounts: { [UID]: account(UID) },
    wallets: { [UID]: walletData() },
    serializable: true
  } });

  const results = await Promise.all([
    withdrawals.reviewRequest({ requestId, reviewerUid: ADMIN, decision: 'approve' }),
    withdrawals.reviewRequest({ requestId, reviewerUid: 'admin-2', decision: 'approve' })
  ]);

  const applied = results.filter(result => result.applied === true).length;
  assert.equal(applied, 1, `only one review may finalize: ${JSON.stringify(results.map(r => r.code))}`);
  assert.equal(walletOf(db).reservedBalance, 0);
  assert.equal(walletOf(db).availableBalance, 600);
  const finalizations = (await db.collection(LEDGER_COLLECTION).get()).docs
    .filter(doc => doc.data().type === ENTRY_TYPES.WITHDRAWAL_FINALIZATION);
  assert.equal(finalizations.length, 1, 'one finalization entry on the ledger');
});

test('an approval that arrives after an approval is refused, and rewrites nothing', async () => {
  const { db, requestId, withdrawals } = await pendingWithdrawal();
  await withdrawals.reviewRequest({ requestId, reviewerUid: ADMIN, decision: 'approve' });
  const again = await withdrawals.reviewRequest({ requestId, reviewerUid: 'admin-2', decision: 'approve' });

  assert.equal(again.code, 'ALREADY_PROCESSED');
  assert.equal(again.applied, false);
  assert.equal(requestOf(db, requestId).reviewedBy, ADMIN, 'the first reviewer stays on the record');
  assert.equal(walletOf(db).reservedBalance, 0);
});

test('rejecting restores the coins exactly once, with the reason an admin gave', async () => {
  const { db, requestId, withdrawals } = await pendingWithdrawal();
  const result = await withdrawals.reviewRequest({
    requestId, reviewerUid: ADMIN, decision: 'reject', reason: 'Payout handle could not be verified'
  });

  assert.equal(result.code, 'REJECTED');
  assert.equal(walletOf(db).availableBalance, 1000, 'the held coins are available again');
  assert.equal(walletOf(db).reservedBalance, 0);
  assert.equal(walletOf(db).lifetimePenalized, 0, 'a release is not an earning either');

  const stored = requestOf(db, requestId);
  assert.equal(stored.status, REQUEST_STATUS.REJECTED);
  assert.equal(stored.rejectionReason, 'Payout handle could not be verified');
  assert.equal(stored.reviewedBy, ADMIN);
  assert.equal(entryOf(db, reservationKeyFor(requestId)).status, HOLD_STATES.RELEASED);
});

test('a rejection cannot be reversed by an approval, or repeated', async () => {
  const { db, requestId, withdrawals } = await pendingWithdrawal();
  await withdrawals.reviewRequest({ requestId, reviewerUid: ADMIN, decision: 'reject', reason: 'duplicate payout' });
  assert.equal(walletOf(db).availableBalance, 1000);

  const flip = await withdrawals.reviewRequest({ requestId, reviewerUid: 'admin-2', decision: 'approve' });
  assert.equal(flip.code, 'ALREADY_PROCESSED', 'a reviewed request is a closed book');
  assert.equal(walletOf(db).availableBalance, 1000, 'and the coins are not moved by the attempt');
  assert.equal(walletOf(db).reservedBalance, 0);

  const again = await withdrawals.reviewRequest({
    requestId, reviewerUid: ADMIN, decision: 'reject', reason: 'again'
  });
  assert.equal(again.code, 'ALREADY_PROCESSED');
});

test('an approval and a rejection that race produce exactly one outcome', async () => {
  const { db, requestId, withdrawals } = await pendingWithdrawal(400, { context: {
    accounts: { [UID]: account(UID) },
    wallets: { [UID]: walletData() },
    serializable: true
  } });

  const [approved, rejected] = await Promise.all([
    withdrawals.reviewRequest({ requestId, reviewerUid: ADMIN, decision: 'approve' }),
    withdrawals.reviewRequest({ requestId, reviewerUid: 'admin-2', decision: 'reject', reason: 'not verified' })
  ]);

  const applied = [approved, rejected].filter(result => result.applied === true);
  assert.equal(applied.length, 1, 'one decision wins and the other is refused outright');

  const wallet = walletOf(db);
  const consistent = (wallet.availableBalance === 600 && wallet.reservedBalance === 0) ||
    (wallet.availableBalance === 1000 && wallet.reservedBalance === 0);
  assert.ok(consistent, `the balance is one of the two valid endings: ${JSON.stringify(wallet)}`);
  assert.ok([REQUEST_STATUS.APPROVED, REQUEST_STATUS.REJECTED]
    .includes(requestOf(db, requestId).status));
});

test('a review of a request that never held coins says so instead of paying from the wallet', async () => {
  const { db, withdrawals } = build();
  const failed = await withdrawals.createRequest({
    organizerUid: UID, amount: 5000, upiId: UPI, idempotencyToken: TOKEN
  });
  const result = await withdrawals.reviewRequest({
    requestId: failed.requestId, reviewerUid: ADMIN, decision: 'approve'
  });

  assert.equal(result.code, 'NOT_RESERVED');
  assert.equal(requestOf(db, failed.requestId).status, REQUEST_STATUS.RESERVATION_FAILED);
  assert.equal(walletOf(db).reservedBalance, 0);
});

test('a review resumes a create that was interrupted, then decides it once', async () => {
  const requestId = requestIdFor({ organizerUid: UID, token: TOKEN });
  const { db, withdrawals } = build({
    requests: { [requestId]: {
      organizerUid: UID, amount: 400, currency: CURRENCY, upiId: UPI,
      status: REQUEST_STATUS.AWAITING_RESERVATION, reservationKey: reservationKeyFor(requestId),
      createdAt: 'SEEDED_TS'
    } }
  });

  const result = await withdrawals.reviewRequest({
    requestId, reviewerUid: ADMIN, decision: 'approve'
  });
  assert.equal(result.code, 'COMPLETE');
  assert.equal(walletOf(db).availableBalance, 600);
  assert.equal(walletOf(db).reservedBalance, 0);
  assert.equal(requestOf(db, requestId).status, REQUEST_STATUS.APPROVED);

  // The hold this review had to open is on the ledger, and it is the one that closed.
  const hold = entryOf(db, reservationKeyFor(requestId));
  assert.equal(hold.amount, 400);
  assert.equal(hold.status, HOLD_STATES.FINALIZED);
});

test('a review cannot name an amount, a wallet or a reviewer of its own', async () => {
  const { db, requestId, withdrawals } = await pendingWithdrawal();
  const result = await withdrawals.reviewRequest({
    requestId,
    reviewerUid: ADMIN,
    decision: 'approve',
    // Every one of these is ignored: the amount comes off the hold, the organizer off the
    // request, and the reviewer off the signed-in admin the route was given.
    amount: 999999,
    organizerUid: OTHER,
    availableBalance: 999999
  });

  assert.equal(result.code, 'COMPLETE');
  assert.equal(requestOf(db, requestId).amount, 400);
  assert.equal(requestOf(db, requestId).organizerUid, UID);
  assert.equal(walletOf(db, OTHER).availableBalance, 1000, 'a rival wallet is untouched');
  assert.equal(entryOf(db, `${reservationKeyFor(requestId)}:finalize`).amount, 400);
});

test('a rejection without a reason is not a rejection, and a review needs a reviewer', async () => {
  const { requestId, withdrawals } = await pendingWithdrawal();

  assert.equal((await withdrawals.reviewRequest({
    requestId, reviewerUid: ADMIN, decision: 'reject'
  })).code, 'REASON_REQUIRED');
  assert.equal((await withdrawals.reviewRequest({
    requestId, reviewerUid: '', decision: 'approve'
  })).code, 'REVIEWER_REQUIRED');
  assert.equal((await withdrawals.reviewRequest({
    requestId, reviewerUid: ADMIN, decision: 'hold'
  })).code, 'DECISION_INVALID');
  assert.equal((await withdrawals.reviewRequest({
    requestId, reviewerUid: ADMIN, decision: 'approve', reason: 'x'.repeat(600)
  })).code, 'REASON_TOO_LONG');
  assert.equal((await withdrawals.reviewRequest({
    requestId: 'wd_nobody', reviewerUid: ADMIN, decision: 'approve'
  })).code, 'NOT_FOUND');

  const after = await withdrawals.reviewRequest({
    requestId, reviewerUid: ADMIN, decision: 'approve'
  });
  assert.equal(after.code, 'COMPLETE', 'a refused review never blocks a later legitimate one');
});

test('a request that names no organizer cannot be reviewed at all', async () => {
  const { withdrawals } = build({
    requests: { wd_broken: { amount: 100, status: REQUEST_STATUS.PENDING } }
  });
  assert.equal((await withdrawals.reviewRequest({
    requestId: 'wd_broken', reviewerUid: ADMIN, decision: 'approve'
  })).code, 'REQUEST_INCOMPLETE');
});

// ==========================================================================
// Listing
// ==========================================================================

test('a listing is bounded, filtered and reads only the fields a screen needs', async () => {
  const { withdrawals } = build();
  await withdrawals.createRequest({ organizerUid: UID, amount: 100, upiId: UPI, idempotencyToken: TOKEN });
  await withdrawals.createRequest({
    organizerUid: UID, amount: 200, upiId: UPI, idempotencyToken: 'eeee5555-ffff6666'
  });
  await withdrawals.createRequest({
    organizerUid: OTHER, amount: 300, upiId: 'org_b@ybl', idempotencyToken: 'gggg7777-hhhh8888'
  });

  const mine = await withdrawals.listRequests({ organizerUid: UID });
  assert.equal(mine.count, 2);
  assert.ok(mine.requests.every(request => request.organizerUid === UID));

  const pending = await withdrawals.listRequests({ status: REQUEST_STATUS.PENDING });
  assert.equal(pending.count, 3);
  assert.equal((await withdrawals.listRequests({ status: 'approved' })).count, 0);

  // A listing is never the whole collection, however much a caller asks for.
  const greedy = await withdrawals.listRequests({ limit: 100000 });
  assert.ok(greedy.count <= 100);
});

test('a listed request keeps its reservation key visible so a screen can correlate it', async () => {
  const { requestId, withdrawals } = await pendingWithdrawal();
  const { requests } = await withdrawals.listRequests({ organizerUid: UID });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].requestId, requestId);
  assert.equal(requests[0].reservationKey, reservationKeyFor(requestId));
  assert.equal(requests[0].status, REQUEST_STATUS.PENDING);
  assert.equal(requests[0].currency, CURRENCY);
  assert.equal(requests[0].payout, PAYOUT_MANUAL);
});
