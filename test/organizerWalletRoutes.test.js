/**
 * Phase 4 and 5 over HTTP: who may call what, and what a caller can claim about itself.
 *
 * The services are already tested against an in-memory Firestore; these tests are about the
 * routes, because the routes are where an identity is decided. The same real routers are
 * mounted on an ephemeral server with only the token verifier and the database injected, so
 * every assertion below is about the code that will actually run on Render.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const express = require('express');
const {
  createOrganizerEconomyService,
  WALLET_COLLECTION,
  LEDGER_COLLECTION,
  CONFIG_COLLECTION,
  CONFIG_DOCUMENT
} = require('../services/organizerEconomy');
const {
  createOrganizerWithdrawalService,
  REQUESTS_COLLECTION,
  REQUEST_STATUS
} = require('../services/organizerWithdrawals');
const { createPenaltyEnforcementService, CASES_COLLECTION } = require('../services/organizerPenalties');
const { createOrganizerDailyLimitService } = require('../services/organizerDailyLimits');
const { createOrganizerWalletRouter } = require('../routes/organizerWalletRoutes');
const { createAdminOrganizerRouter } = require('../routes/organizerAdminRoutes');
const { createFakeFirestore } = require('./helpers/fakeFirestore');
const { makeAuthenticator, startServer, request } = require('./helpers/authHarness');

const ORGANIZER = 'organizer-a';
const RIVAL = 'organizer-b';
const PLAYER = 'player-c';
const ADMIN = 'admin-1';

const TOKENS = {
  'token-organizer': { uid: ORGANIZER },
  'token-rival': { uid: RIVAL },
  'token-player': { uid: PLAYER },
  'token-admin': { uid: ADMIN }
};

const NOW = Date.parse('2026-10-21T12:00:00.000Z');
const minutes = count => count * 60000;
const UPI = 'org_a@ybl';

function walletData(over = {}) {
  return {
    availableBalance: 1000, reservedBalance: 0, lifetimeEarned: 1000, lifetimePenalized: 0,
    currency: 'coins', version: 1, createdAt: 'SEEDED_TS', ...over
  };
}

function account(uid, over = {}) {
  return { uid, username: uid === RIVAL ? 'org_b' : 'org_a', isActive: true, banned: false, ...over };
}

function match(over = {}) {
  return {
    status: 'upcoming', isActive: true, dateTime: new Date(NOW - minutes(90)),
    roomId: '8123 4567', roomPassword: 'pgr123',
    createdByOrganizerUid: ORGANIZER, assignedOrganizerUid: ORGANIZER, ...over
  };
}

async function harness({
  config = { deadlinePenaltyEnabled: true, defaultDeadlinePenalty: 50, deadlineGraceMinutes: 30 },
  matches = {},
  accounts = { [ORGANIZER]: account(ORGANIZER), [RIVAL]: account(RIVAL) },
  wallets = { [ORGANIZER]: walletData(), [RIVAL]: walletData() },
  admins = [ADMIN]
} = {}) {
  const stores = {
    organizer_users: accounts,
    [WALLET_COLLECTION]: wallets,
    [LEDGER_COLLECTION]: {},
    [REQUESTS_COLLECTION]: {},
    [CASES_COLLECTION]: {},
    tournaments: matches
  };
  if (config !== null) stores[CONFIG_COLLECTION] = { [CONFIG_DOCUMENT]: config };
  const db = createFakeFirestore(stores);

  const economy = createOrganizerEconomyService({ db, serverTimestamp: () => 'SERVER_TS' });
  const withdrawals = createOrganizerWithdrawalService({
    db, economy, serverTimestamp: () => 'SERVER_TS'
  });
  const penalties = createPenaltyEnforcementService({
    db, economy, serverTimestamp: () => 'SERVER_TS', now: () => NOW
  });
  const limits = createOrganizerDailyLimitService({ db, economy, now: () => NOW });
  const authenticator = makeAuthenticator(TOKENS);

  const app = express();
  app.use(express.json());
  app.use('/api/organizer/wallet', createOrganizerWalletRouter({
    authenticator, withdrawals, economy, limits,
    // The withdrawal route now asks the device service whether this caller is on an approved
    // device, and that question has to be answered from the same double the rest of the suite
    // uses. No organizer in these tests has a binding, so every call lands on the legacy
    // first-run path and behaves exactly as it did before the gate existed.
    database: () => db,
    serverTimestamp: () => 'SERVER_TS'
  }));
  app.use('/api/admin/organizer', createAdminOrganizerRouter({
    authenticator,
    withdrawals,
    penalties,
    database: () => db,
    serverTimestamp: () => 'SERVER_TS',
    isAdminUid: async uid => admins.includes(uid)
  }));

  const server = await startServer(app);
  return { db, economy, withdrawals, limits, server, baseUrl: server.baseUrl, close: () => server.close() };
}

const post = (baseUrl, path, body, token) =>
  request(baseUrl, path, { method: 'POST', token, body });
const get = (baseUrl, path, token) => request(baseUrl, path, { token });

const peek = (db, name, id) => db.__peek(name, id);
const holdKeyOf = id => `reserve:${id}`;

// ==========================================================================
// Authentication and authorization
// ==========================================================================

test('an organizer route with no valid token is refused before it reads anything', async () => {
  const context = await harness();
  try {
    const anonymous = await post(context.baseUrl, '/api/organizer/wallet/withdrawal',
      { amount: 100, upiId: UPI, idempotencyToken: 'aaaa1111-bbbb2222' });
    assert.equal(anonymous.status, 401);

    const history = await get(context.baseUrl, '/api/organizer/wallet/withdrawals');
    assert.equal(history.status, 401);

    const queue = await get(context.baseUrl, '/api/admin/organizer/withdrawals');
    assert.equal(queue.status, 401);

    const sweep = await post(context.baseUrl, '/api/admin/organizer/penalty-sweep', {});
    assert.equal(sweep.status, 401);

    // The allowance read is a person's schedule, so it is authenticated like everything else.
    assert.equal((await get(context.baseUrl, '/api/organizer/wallet/daily-limit')).status, 401);
    assert.equal((await context.db.collection(REQUESTS_COLLECTION).get()).size, 0);
    assert.equal((await context.db.collection(LEDGER_COLLECTION).get()).size, 0);
  } finally {
    await context.close();
  }
});

test('an admin route refuses a signed-in account that is not an admin', async () => {
  const context = await harness({
    matches: { 'match-1': match() },
    wallets: { [ORGANIZER]: walletData(), [RIVAL]: walletData() }
  });
  try {
    for (const token of ['token-organizer', 'token-rival', 'token-player']) {
      assert.equal((await get(context.baseUrl, '/api/admin/organizer/withdrawals', token)).status, 403);
      assert.equal((await post(context.baseUrl, '/api/admin/organizer/withdrawal/approve',
        { requestId: 'wd_anything' }, token)).status, 403);
      assert.equal((await post(context.baseUrl, '/api/admin/organizer/withdrawal/reject',
        { requestId: 'wd_anything', reason: 'not an admin' }, token)).status, 403);
    }

    // A penalty sweep is an organizer-money operation, and a player cannot trigger it either.
    const swept = await post(context.baseUrl, '/api/admin/organizer/penalty-sweep', {}, 'token-player');
    assert.equal(swept.status, 403);
    assert.equal((await context.db.collection(LEDGER_COLLECTION).get()).size, 0,
      'and nothing was charged on the way to being refused');
  } finally {
    await context.close();
  }
});

test('an admin whose account is not in admin_users is not an admin to these routes', async () => {
  const context = await harness({ admins: [] });
  try {
    const queue = await get(context.baseUrl, '/api/admin/organizer/withdrawals', 'token-admin');
    assert.equal(queue.status, 403);
    assert.equal(queue.body.code, 'FORBIDDEN');
  } finally {
    await context.close();
  }
});

// ==========================================================================
// The caller is the token, never the body
// ==========================================================================

test('a withdrawal request is made for the signed-in organizer, whatever the body claims', async () => {
  const context = await harness();
  try {
    const response = await post(context.baseUrl, '/api/organizer/wallet/withdrawal', {
      amount: 400,
      upiId: UPI,
      idempotencyToken: 'aaaa1111-bbbb2222',
      // The three fields a client would try to use to steer the operation.
      organizerUid: RIVAL,
      availableBalance: 999999,
      status: REQUEST_STATUS.APPROVED
    }, 'token-organizer');

    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    const stored = peek(context.db, REQUESTS_COLLECTION, response.body.requestId);
    assert.equal(stored.organizerUid, ORGANIZER, 'the request belongs to the token holder');
    assert.equal(stored.status, REQUEST_STATUS.PENDING, 'and it is pending, not self-approved');
    assert.equal(stored.amount, 400, 'with the amount that was asked for');
    assert.equal(peek(context.db, WALLET_COLLECTION, RIVAL).reservedBalance, 0,
      'a rival wallet is not touched by a request that named it');
  } finally {
    await context.close();
  }
});

test('a player cannot start an organizer withdrawal, and a banned organizer cannot either', async () => {
  const context = await harness({ accounts: { [ORGANIZER]: account(ORGANIZER, { banned: true }) } });
  try {
    const player = await post(context.baseUrl, '/api/organizer/wallet/withdrawal', {
      amount: 100, upiId: UPI, idempotencyToken: 'pppp1111-qqqq2222'
    }, 'token-player');
    assert.equal(player.status, 403);
    assert.equal(player.body.code, 'NOT_AN_ORGANIZER');

    const banned = await post(context.baseUrl, '/api/organizer/wallet/withdrawal', {
      amount: 100, upiId: UPI, idempotencyToken: 'aaaa1111-bbbb2222'
    }, 'token-organizer');
    assert.equal(banned.status, 403);
    assert.equal(banned.body.code, 'ORGANIZER_BANNED');
    assert.equal((await context.db.collection(REQUESTS_COLLECTION).get()).size, 0);
    assert.equal(peek(context.db, WALLET_COLLECTION, ORGANIZER).reservedBalance, 0);
  } finally {
    await context.close();
  }
});

test('a request the balance cannot cover is a 409 that holds nothing', async () => {
  const context = await harness();
  try {
    const response = await post(context.baseUrl, '/api/organizer/wallet/withdrawal', {
      amount: 5000, upiId: UPI, idempotencyToken: 'aaaa1111-bbbb2222'
    }, 'token-organizer');

    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'INSUFFICIENT_BALANCE');
    assert.equal(peek(context.db, WALLET_COLLECTION, ORGANIZER).reservedBalance, 0);
    assert.equal(peek(context.db, REQUESTS_COLLECTION, response.body.requestId).status,
      REQUEST_STATUS.RESERVATION_FAILED);
  } finally {
    await context.close();
  }
});

test('an organizer history only ever contains the caller\'s own requests', async () => {
  const context = await harness();
  try {
    await post(context.baseUrl, '/api/organizer/wallet/withdrawal',
      { amount: 100, upiId: UPI, idempotencyToken: 'aaaa1111-bbbb2222' }, 'token-organizer');
    await post(context.baseUrl, '/api/organizer/wallet/withdrawal',
      { amount: 200, upiId: 'org_b@ybl', idempotencyToken: 'bbbb1111-cccc2222' }, 'token-rival');

    const mine = await get(context.baseUrl, '/api/organizer/wallet/withdrawals', 'token-organizer');
    assert.equal(mine.status, 200);
    assert.equal(mine.body.count, 1);
    assert.equal(mine.body.requests[0].organizerUid, ORGANIZER);

    const theirs = await get(context.baseUrl, '/api/organizer/wallet/withdrawals', 'token-rival');
    assert.equal(theirs.body.count, 1);
    assert.equal(theirs.body.requests[0].organizerUid, RIVAL);
  } finally {
    await context.close();
  }
});

test('a retried request is answered with the request that already exists', async () => {
  const context = await harness();
  try {
    const body = { amount: 400, upiId: UPI, idempotencyToken: 'aaaa1111-bbbb2222' };
    const first = await post(context.baseUrl, '/api/organizer/wallet/withdrawal', body, 'token-organizer');
    const retry = await post(context.baseUrl, '/api/organizer/wallet/withdrawal', body, 'token-organizer');

    assert.equal(retry.status, 200);
    assert.equal(retry.body.duplicate, true);
    assert.equal(retry.body.requestId, first.body.requestId);
    assert.equal(peek(context.db, WALLET_COLLECTION, ORGANIZER).reservedBalance, 400,
      'one hold across both calls');
  } finally {
    await context.close();
  }
});

test('a malformed request is a 400 that names the field, not a 500', async () => {
  const context = await harness();
  try {
    const cases = [
      [{ amount: 0, upiId: UPI, idempotencyToken: 'aaaa1111-bbbb2222' }, 'AMOUNT_INVALID'],
      [{ amount: 100, upiId: 'not-a-upi-id', idempotencyToken: 'aaaa1111-bbbb2222' }, 'UPI_ID_INVALID'],
      [{ amount: 100, upiId: UPI }, 'IDEMPOTENCY_TOKEN_INVALID'],
      [{ upiId: UPI, idempotencyToken: 'aaaa1111-bbbb2222' }, 'AMOUNT_INVALID']
    ];
    for (const [body, code] of cases) {
      const response = await post(context.baseUrl, '/api/organizer/wallet/withdrawal',
        body, 'token-organizer');
      assert.equal(response.status, 400, `${JSON.stringify(body)} is a client error`);
      assert.equal(response.body.code, code);
      assert.equal(response.body.success, false);
    }
    assert.equal((await context.db.collection(REQUESTS_COLLECTION).get()).size, 0);
  } finally {
    await context.close();
  }
});

// ==========================================================================
// Admin review over HTTP
// ==========================================================================

async function pendingRequest(context, token = 'token-organizer') {
  const created = await post(context.baseUrl, '/api/organizer/wallet/withdrawal', {
    amount: 400, upiId: UPI, idempotencyToken: 'aaaa1111-bbbb2222'
  }, token);
  return created.body.requestId;
}

test('the review queue names the organizer beside the amount they asked for', async () => {
  const context = await harness();
  try {
    const requestId = await pendingRequest(context);

    const queue = await get(context.baseUrl, '/api/admin/organizer/withdrawals?status=pending',
      'token-admin');
    assert.equal(queue.status, 200);
    assert.equal(queue.body.count, 1);
    const row = queue.body.requests[0];
    assert.equal(row.requestId, requestId);
    assert.equal(row.organizerUid, ORGANIZER);
    assert.equal(row.username, 'org_a', 'the display name is joined, not stored on the money row');
    assert.equal(row.amount, 400);
    assert.equal(row.upiId, UPI);
    assert.equal(row.status, REQUEST_STATUS.PENDING);
    assert.equal(row.payout, 'manual_admin_review');
  } finally {
    await context.close();
  }
});

test('the review queue can be narrowed to one organizer, and narrowing selects rather than grants', async () => {
  const context = await harness();
  try {
    const mine = await pendingRequest(context);
    const theirs = await pendingRequest(context, 'token-rival');
    assert.notEqual(mine, theirs);

    const all = await get(context.baseUrl, '/api/admin/organizer/withdrawals', 'token-admin');
    assert.equal(all.body.count, 2, 'no filter is still every request');

    const narrowed = await get(
      context.baseUrl, `/api/admin/organizer/withdrawals?organizerUid=${RIVAL}`, 'token-admin');
    assert.equal(narrowed.status, 200);
    assert.equal(narrowed.body.count, 1);
    assert.equal(narrowed.body.requests[0].requestId, theirs);
    assert.equal(narrowed.body.requests[0].organizerUid, RIVAL);

    // A narrowing that matches nobody is an empty answer, not a failure and not everybody's rows.
    const nobody = await get(
      context.baseUrl, '/api/admin/organizer/withdrawals?organizerUid=organizer-zzz', 'token-admin');
    assert.equal(nobody.status, 200);
    assert.equal(nobody.body.count, 0);

    // And the filter is read-only: asking about one organizer decides nothing about them.
    assert.equal(peek(context.db, REQUESTS_COLLECTION, mine).status, REQUEST_STATUS.PENDING);
    assert.equal(peek(context.db, REQUESTS_COLLECTION, theirs).status, REQUEST_STATUS.PENDING);
    assert.equal(peek(context.db, WALLET_COLLECTION, RIVAL).reservedBalance, 400);
  } finally {
    await context.close();
  }
});

test('approving over HTTP finalizes the hold once and records the reviewing admin', async () => {
  const context = await harness();
  try {
    const requestId = await pendingRequest(context);
    const approved = await post(context.baseUrl, '/api/admin/organizer/withdrawal/approve',
      { requestId }, 'token-admin');

    assert.equal(approved.status, 200);
    assert.equal(approved.body.code, 'COMPLETE');
    assert.equal(peek(context.db, REQUESTS_COLLECTION, requestId).reviewedBy, ADMIN);
    assert.equal(peek(context.db, WALLET_COLLECTION, ORGANIZER).availableBalance, 600);
    assert.equal(peek(context.db, WALLET_COLLECTION, ORGANIZER).reservedBalance, 0);

    const again = await post(context.baseUrl, '/api/admin/organizer/withdrawal/approve',
      { requestId }, 'token-admin');
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'ALREADY_PROCESSED');
    assert.equal(peek(context.db, WALLET_COLLECTION, ORGANIZER).availableBalance, 600,
      'a second approval moves nothing');
  } finally {
    await context.close();
  }
});

test('an approval can never name the amount that is paid out', async () => {
  const context = await harness();
  try {
    const requestId = await pendingRequest(context);
    const approved = await post(context.baseUrl, '/api/admin/organizer/withdrawal/approve',
      { requestId, amount: 999999, organizerUid: RIVAL }, 'token-admin');

    assert.equal(approved.status, 200);
    assert.equal(peek(context.db, WALLET_COLLECTION, ORGANIZER).availableBalance, 600,
      'the wallet paid the 400 that was requested, not the number in the body');
    assert.equal(peek(context.db, WALLET_COLLECTION, RIVAL).availableBalance, 1000);
    assert.equal(peek(context.db, WALLET_COLLECTION, RIVAL).reservedBalance, 0);
  } finally {
    await context.close();
  }
});

test('rejecting needs a reason, releases once, and cannot then be approved', async () => {
  const context = await harness();
  try {
    const requestId = await pendingRequest(context);

    const reasonless = await post(context.baseUrl, '/api/admin/organizer/withdrawal/reject',
      { requestId }, 'token-admin');
    assert.equal(reasonless.status, 400);
    assert.equal(reasonless.body.code, 'REASON_REQUIRED');
    assert.equal(peek(context.db, WALLET_COLLECTION, ORGANIZER).availableBalance, 600,
      'a refused rejection left the hold exactly as it was');

    const rejected = await post(context.baseUrl, '/api/admin/organizer/withdrawal/reject',
      { requestId, reason: 'Payout handle could not be verified' }, 'token-admin');
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.code, 'REJECTED');
    assert.equal(peek(context.db, WALLET_COLLECTION, ORGANIZER).availableBalance, 1000);
    assert.equal(peek(context.db, REQUESTS_COLLECTION, requestId).rejectionReason,
      'Payout handle could not be verified');

    const flip = await post(context.baseUrl, '/api/admin/organizer/withdrawal/approve',
      { requestId }, 'token-admin');
    assert.equal(flip.status, 409);
    assert.equal(peek(context.db, WALLET_COLLECTION, ORGANIZER).availableBalance, 1000,
      'and the restored coins are not taken out again by an out-of-order approval');
  } finally {
    await context.close();
  }
});

test('a request id that does not exist is a 404, and one that is malformed is a 400', async () => {
  const context = await harness();
  try {
    const missing = await post(context.baseUrl, '/api/admin/organizer/withdrawal/approve',
      { requestId: 'wd_doesnotexist' }, 'token-admin');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, 'NOT_FOUND');

    const unnamed = await post(context.baseUrl, '/api/admin/organizer/withdrawal/approve',
      {}, 'token-admin');
    assert.equal(unnamed.status, 400);
    assert.equal(unnamed.body.code, 'REQUEST_ID_REQUIRED');

    const slashy = await post(context.baseUrl, '/api/admin/organizer/withdrawal/approve',
      { requestId: 'wd../../other' }, 'token-admin');
    assert.equal(slashy.status, 400);
    assert.equal(slashy.body.code, 'REQUEST_ID_INVALID');
  } finally {
    await context.close();
  }
});

test('one organizer cannot review, or read, another organizer\'s request', async () => {
  const context = await harness();
  try {
    const requestId = await pendingRequest(context);

    // A signed-in organizer who is not an admin is refused by the admin gate, whatever they
    // name in the body - and the request they pointed at is still untouched afterwards.
    const meddling = await post(context.baseUrl, '/api/admin/organizer/withdrawal/approve',
      { requestId }, 'token-rival');
    assert.equal(meddling.status, 403);
    assert.equal(peek(context.db, REQUESTS_COLLECTION, requestId).status, REQUEST_STATUS.PENDING);

    // And the history route cannot be aimed at another account, because it has no way to name
    // an account at all: it reads the token.
    const history = await get(context.baseUrl, '/api/organizer/wallet/withdrawals', 'token-rival');
    assert.equal(history.body.count, 0);
  } finally {
    await context.close();
  }
});

// ==========================================================================
// The penalty sweep, triggered the way an operator would trigger it
// ==========================================================================

test('the sweep a schedule runs, and the sweep an admin triggers, are the same idempotent pass', async () => {
  const context = await harness({ matches: { 'match-1': match({ roomId: '', roomPassword: '' }) } });
  try {
    const first = await post(context.baseUrl, '/api/admin/organizer/penalty-sweep', {}, 'token-admin');
    assert.equal(first.status, 200);
    assert.equal(first.body.code, 'COMPLETE');
    assert.equal(first.body.summary.charged, 1);
    assert.equal(peek(context.db, WALLET_COLLECTION, ORGANIZER).availableBalance, 950);

    const second = await post(context.baseUrl, '/api/admin/organizer/penalty-sweep', {}, 'token-admin');
    assert.equal(second.body.summary.already_closed, 1);
    assert.equal(peek(context.db, WALLET_COLLECTION, ORGANIZER).availableBalance, 950,
      'a trigger is not a way to charge twice');
    assert.equal((await context.db.collection(LEDGER_COLLECTION).get()).size, 1);

    // The audit row is written with the money, in coins, and names the organizer it charged.
    const recorded = peek(context.db, CASES_COLLECTION, 'penalty_case:match-1');
    assert.equal(recorded.outcome, 'charged');
    assert.equal(recorded.violationType, 'room_details_missing');
    assert.equal(recorded.configuredAmount, 50);
    assert.equal(recorded.currency, 'coins');
  } finally {
    await context.close();
  }
});

test('a sweep with the switch off reports that it is disabled and charges nobody', async () => {
  const context = await harness({
    config: { defaultDeadlinePenalty: 50 },
    matches: { 'match-1': match() }
  });
  try {
    const response = await post(context.baseUrl, '/api/admin/organizer/penalty-sweep', {}, 'token-admin');
    assert.equal(response.status, 200);
    assert.equal(response.body.code, 'DISABLED');
    assert.equal(response.body.enabled, false);
    assert.equal((await context.db.collection(LEDGER_COLLECTION).get()).size, 0);
    assert.equal(peek(context.db, WALLET_COLLECTION, ORGANIZER).availableBalance, 1000);
  } finally {
    await context.close();
  }
});

test('a withdrawal and a penalty on one wallet cannot spend the same coins', async () => {
  const context = await harness({ matches: { 'match-1': match() } });
  try {
    // 700 of the 1000 available go into a withdrawal hold. The configured 50 penalty then has
    // only the remaining 300 to come out of, and it does: this is the balance arithmetic the
    // two features share, run through both of their real entry points.
    const created = await post(context.baseUrl, '/api/organizer/wallet/withdrawal', {
      amount: 700, upiId: UPI, idempotencyToken: 'aaaa1111-bbbb2222'
    }, 'token-organizer');
    assert.equal(created.status, 200);

    const swept = await post(context.baseUrl, '/api/admin/organizer/penalty-sweep', {}, 'token-admin');
    assert.equal(swept.body.summary.charged, 1);

    const wallet = peek(context.db, WALLET_COLLECTION, ORGANIZER);
    assert.equal(wallet.availableBalance, 250);
    assert.equal(wallet.reservedBalance, 700);
    assert.equal(wallet.lifetimePenalized, 50);
    assert.equal(peek(context.db, REQUESTS_COLLECTION, created.body.requestId).status,
      REQUEST_STATUS.PENDING, 'and the pending withdrawal is still holding what it held');

    const reviewed = await post(context.baseUrl, '/api/admin/organizer/withdrawal/approve',
      { requestId: created.body.requestId }, 'token-admin');
    assert.equal(reviewed.status, 200);
    assert.equal(peek(context.db, WALLET_COLLECTION, ORGANIZER).availableBalance, 250);
    assert.equal(peek(context.db, WALLET_COLLECTION, ORGANIZER).reservedBalance, 0);
    assert.equal(peek(context.db, WALLET_COLLECTION, ORGANIZER).lifetimePenalized, 50,
      'the payout settled the hold and did not re-bill the organizer');
  } finally {
    await context.close();
  }
});

// ==========================================================================
// Phase 6 over HTTP: the daily allowance is read from the trusted side
//
// The counting rules themselves belong to `organizerDailyLimits.test.js`. What these tests
// hold is the part only a route can get wrong: whose day is answered, what a caller may claim
// about itself, and that the answer never implies a gate that does not exist yet.
// ==========================================================================

const ECONOMY_WITH_LIMIT = {
  deadlinePenaltyEnabled: true,
  defaultDeadlinePenalty: 50,
  deadlineGraceMinutes: 30,
  defaultDailyTournamentLimit: 3
};

test('an organizer is told their own allowance and never another organizer\'s', async () => {
  const context = await harness({
    config: ECONOMY_WITH_LIMIT,
    matches: {
      'match-a': match(),
      'match-a2': match(),
      'match-b': match({ createdByOrganizerUid: RIVAL, assignedOrganizerUid: RIVAL })
    }
  });
  try {
    const mine = await get(context.baseUrl, '/api/organizer/wallet/daily-limit', 'token-organizer');
    assert.equal(mine.status, 200);
    assert.equal(mine.body.success, true);
    assert.equal(mine.body.configuredDefaultLimit, 3);
    assert.equal(mine.body.effectiveLimit, 3);
    assert.equal(mine.body.used, 2);
    assert.equal(mine.body.remaining, 1);
    assert.equal(mine.body.reached, false);
    assert.equal(mine.body.unlimited, false);
    assert.deepEqual(mine.body.matches.map(entry => entry.tournamentId), ['match-a', 'match-a2']);

    // The same endpoint, a different token, a different day. Nothing about the first answer
    // leaks into the second, because neither one was asked for.
    const rival = await get(context.baseUrl, '/api/organizer/wallet/daily-limit', 'token-rival');
    assert.equal(rival.status, 200);
    assert.equal(rival.body.used, 1);
    assert.deepEqual(rival.body.matches.map(entry => entry.tournamentId), ['match-b']);

    // A query string that names somebody else, or moves the clock, is not an input this route
    // reads at all: it takes the uid from the token and the time from the server.
    const spoofed = await request(
      context.baseUrl,
      `/api/organizer/wallet/daily-limit?organizerUid=${RIVAL}&atMillis=0`,
      { token: 'token-organizer' }
    );
    assert.equal(spoofed.status, 200);
    assert.equal(spoofed.body.used, 2, 'still the caller\'s own day');
    assert.equal(spoofed.body.day, '2026-10-21', 'and still today, whatever the query claimed');
  } finally {
    await context.close();
  }
});

test('an organizer\'s own override is reported beside the default it replaces', async () => {
  const context = await harness({
    config: ECONOMY_WITH_LIMIT,
    accounts: {
      [ORGANIZER]: account(ORGANIZER, { dailyTournamentLimitOverride: 2 }),
      [RIVAL]: account(RIVAL)
    },
    matches: { 'match-a': match(), 'match-a2': match(), 'match-a3': match() }
  });
  try {
    const answer = await get(context.baseUrl, '/api/organizer/wallet/daily-limit', 'token-organizer');
    assert.equal(answer.body.configuredDefaultLimit, 3, 'the platform default is still visible');
    assert.equal(answer.body.overrideLimit, 2);
    assert.equal(answer.body.effectiveLimit, 2);
    assert.equal(answer.body.used, 3);
    assert.equal(answer.body.remaining, 0);
    assert.equal(answer.body.reached, true);

    // An organizer with no override is measured against the default, not against the person
    // who happens to have one.
    const rival = await get(context.baseUrl, '/api/organizer/wallet/daily-limit', 'token-rival');
    assert.equal(rival.body.overrideLimit, 0);
    assert.equal(rival.body.effectiveLimit, 3);
    assert.equal(rival.body.used, 0);
  } finally {
    await context.close();
  }
});

test('the allowance answer names the create route as the gate, and gates nothing itself', async () => {
  const context = await harness({ config: ECONOMY_WITH_LIMIT, matches: { 'match-a': match() } });
  try {
    const answer = await get(context.baseUrl, '/api/organizer/wallet/daily-limit', 'token-organizer');
    assert.equal(answer.status, 200);
    // `enforced` is only true because creating a match now goes through POST
    // /api/organizer/tournaments, which counts this same day before it writes. A screen reading
    // this may therefore tell an organizer that the next create will be refused.
    assert.equal(answer.body.enforced, true);
    assert.equal(typeof answer.body.note, 'string');
    assert.ok(answer.body.note.includes('refused'), 'the reason is stated, not just the flag');
    // Reading the allowance is still not the enforcement: a day that is full is reported as full
    // here rather than being blocked at this route, and no match is refused by a GET.
    assert.equal(answer.body.effectiveLimit, 3);
    assert.equal(answer.body.used, 1);
  } finally {
    await context.close();
  }
});

test('a signed-in account that is not an organizer gets no allowance', async () => {
  const context = await harness({ config: ECONOMY_WITH_LIMIT, matches: { 'match-a': match() } });
  try {
    const answer = await get(context.baseUrl, '/api/organizer/wallet/daily-limit', 'token-player');
    assert.equal(answer.status, 403);
    assert.equal(answer.body.code, 'NOT_AN_ORGANIZER');
    assert.equal(answer.body.effectiveLimit, undefined, 'a refusal carries no half-answer');
    assert.equal(answer.body.used, undefined);
  } finally {
    await context.close();
  }
});

test('reading an allowance moves no coins and leaves no document behind', async () => {
  const context = await harness({ config: ECONOMY_WITH_LIMIT, matches: { 'match-a': match() } });
  try {
    await get(context.baseUrl, '/api/organizer/wallet/daily-limit', 'token-organizer');
    assert.equal(peek(context.db, WALLET_COLLECTION, ORGANIZER).availableBalance, 1000);
    assert.equal(peek(context.db, WALLET_COLLECTION, ORGANIZER).reservedBalance, 0);
    assert.equal((await context.db.collection(LEDGER_COLLECTION).get()).size, 0);
    assert.equal((await context.db.collection(CASES_COLLECTION).get()).size, 0);
    assert.equal((await context.db.collection(REQUESTS_COLLECTION).get()).size, 0);
  } finally {
    await context.close();
  }
});

test('the penalty sweep, the reservation and the allowance all agree about one match', async () => {
  // The three features in this phase read the same stored lifecycle. A match that is late and
  // still upcoming is chargeable and still occupies the day it was scheduled for; cancelling it
  // settles both questions at once, and nobody is billed twice for either.
  const context = await harness({
    config: ECONOMY_WITH_LIMIT,
    matches: {
      'match-late': match({ roomId: '', roomPassword: '' }),
      'match-cancelled': match({ status: 'cancelled', isActive: false })
    }
  });
  try {
    const before = await get(context.baseUrl, '/api/organizer/wallet/daily-limit', 'token-organizer');
    assert.equal(before.body.used, 1, 'the cancelled match takes no place in the day');
    assert.equal(before.body.remaining, 2);

    const swept = await post(context.baseUrl, '/api/admin/organizer/penalty-sweep', {}, 'token-admin');
    assert.equal(swept.body.summary.charged, 1);

    const created = await post(context.baseUrl, '/api/organizer/wallet/withdrawal', {
      amount: 900, upiId: UPI, idempotencyToken: 'aaaa1111-bbbb2222'
    }, 'token-organizer');
    assert.equal(created.status, 200);

    const wallet = peek(context.db, WALLET_COLLECTION, ORGANIZER);
    assert.equal(wallet.availableBalance, 50, '1000 - 50 penalty - 900 reserved');
    assert.equal(wallet.reservedBalance, 900);
    assert.equal(wallet.lifetimePenalized, 50);

    // The penalty spent coins but changed nothing about the schedule: the same match still
    // counts once, and the deadline is not a second violation the allowance has to notice.
    const after = await get(context.baseUrl, '/api/organizer/wallet/daily-limit', 'token-organizer');
    assert.equal(after.body.used, 1);
    assert.deepEqual(after.body.matches.map(entry => entry.tournamentId), ['match-late']);

    // Reassigning the match moves it between days, exactly as the counting policy documents.
    context.db.__seed('tournaments', 'match-late',
      match({ roomId: '', roomPassword: '', assignedOrganizerUid: RIVAL }));
    const moved = await get(context.baseUrl, '/api/organizer/wallet/daily-limit', 'token-organizer');
    assert.equal(moved.body.used, 0);
    const arrived = await get(context.baseUrl, '/api/organizer/wallet/daily-limit', 'token-rival');
    assert.equal(arrived.body.used, 1);

    // A second sweep cannot charge the same deadline again, and the reassignment above is
    // exactly the temptation it has to resist: a new name on the match is not a new violation,
    // because the case and the ledger key both belong to the deadline.
    const reswept = await post(context.baseUrl, '/api/admin/organizer/penalty-sweep', {}, 'token-admin');
    assert.equal(reswept.body.summary.charged || 0, 0, 'nobody was charged a second time');
    assert.equal(reswept.body.summary.already_closed, 1);
    assert.equal(peek(context.db, WALLET_COLLECTION, ORGANIZER).availableBalance, 50,
      'and the reserved coins were never touched by the retry');
    assert.equal(peek(context.db, WALLET_COLLECTION, RIVAL).availableBalance, 1000,
      'the organizer who inherited the late match pays for somebody else\'s deadline not at all');
  } finally {
    await context.close();
  }
});
