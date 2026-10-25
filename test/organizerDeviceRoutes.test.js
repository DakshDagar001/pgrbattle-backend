/**
 * Phase 7 over HTTP: the device routes, and the one protected operation the backend really owns.
 *
 * `organizerDevices.test.js` proves the service answers correctly. This file proves the routes do
 * the things only a route can do: take the organizer from the verified token and nowhere else, take
 * the device from a header and nowhere else, refuse an unapproved device *before* a coin is
 * reserved, keep the approved identifier out of an answer given to a device that is not approved,
 * and let an admin decide through an endpoint that records who decided.
 *
 * The withdrawal route is the protected operation used here because it is the one financial write
 * this project already performs in a trusted backend. Tournament creation, result entry and room
 * credentials are still direct client writes to Firestore, and no route in this file pretends
 * otherwise - the completion report lists exactly which paths are gated and which are not.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const express = require('express');

const {
  createOrganizerDeviceService,
  BINDINGS_COLLECTION,
  REQUESTS_COLLECTION: DEVICE_REQUESTS,
  REQUEST_STATUS,
  requestIdFor
} = require('../services/organizerDevices');
const { createAuditTrail, SECTIONS } = require('../services/auditTrail');
const {
  createOrganizerEconomyService,
  WALLET_COLLECTION,
  LEDGER_COLLECTION,
  CONFIG_COLLECTION,
  CONFIG_DOCUMENT
} = require('../services/organizerEconomy');
const {
  createOrganizerWithdrawalService,
  REQUESTS_COLLECTION: WITHDRAWALS
} = require('../services/organizerWithdrawals');
const { createOrganizerDailyLimitService } = require('../services/organizerDailyLimits');
const { createOrganizerDeviceRouter } = require('../routes/organizerDeviceRoutes');
const { createOrganizerWalletRouter } = require('../routes/organizerWalletRoutes');
const { createAdminOrganizerRouter } = require('../routes/organizerAdminRoutes');
const { createFakeFirestore } = require('./helpers/fakeFirestore');
const { makeAuthenticator, startServer, request } = require('./helpers/authHarness');

const ORGANIZER = 'organizer-a';
const RIVAL = 'organizer-b';
const PLAYER = 'player-c';
const ADMIN = 'admin-1';

const DEV_ONE = 'device-one-0001';
const DEV_TWO = 'device-two-0002';

const TOKENS = {
  'token-organizer': { uid: ORGANIZER },
  'token-rival': { uid: RIVAL },
  'token-player': { uid: PLAYER },
  'token-admin': { uid: ADMIN }
};

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

const device = deviceId => ({ 'X-Device-Id': deviceId });

async function harness({
  bindings = {},
  deviceRequests = {},
  accounts = { [ORGANIZER]: account(ORGANIZER), [RIVAL]: account(RIVAL) },
  wallets = { [ORGANIZER]: walletData(), [RIVAL]: walletData() },
  admins = [ADMIN]
} = {}) {
  const stores = {
    organizer_users: accounts,
    [BINDINGS_COLLECTION]: bindings,
    [DEVICE_REQUESTS]: deviceRequests,
    [WALLET_COLLECTION]: wallets,
    [LEDGER_COLLECTION]: {},
    [WITHDRAWALS]: {},
    [CONFIG_COLLECTION]: {
      [CONFIG_DOCUMENT]: {
        deadlinePenaltyEnabled: true, defaultDeadlinePenalty: 50, deadlineGraceMinutes: 30
      }
    }
  };
  const db = createFakeFirestore(stores);

  const economy = createOrganizerEconomyService({ db, serverTimestamp: () => 'SERVER_TS' });
  const withdrawals = createOrganizerWithdrawalService({
    db, economy, serverTimestamp: () => 'SERVER_TS'
  });
  const limits = createOrganizerDailyLimitService({ db, economy, now: () => Date.now() });
  const audit = createAuditTrail({ db, serverTimestamp: () => 'SERVER_TS' });
  const devices = createOrganizerDeviceService({ db, serverTimestamp: () => 'SERVER_TS', audit });
  const authenticator = makeAuthenticator(TOKENS);

  const app = express();
  app.use(express.json());
  app.use('/api/organizer/devices', createOrganizerDeviceRouter({ authenticator, devices, audit }));
  app.use('/api/organizer/wallet', createOrganizerWalletRouter({
    authenticator, withdrawals, economy, limits, devices, audit,
    database: () => db,
    serverTimestamp: () => 'SERVER_TS'
  }));
  app.use('/api/admin/organizer', createAdminOrganizerRouter({
    authenticator, withdrawals, database: () => db, devices, audit,
    serverTimestamp: () => 'SERVER_TS',
    isAdminUid: async uid => admins.includes(uid)
  }));

  const server = await startServer(app);
  return {
    db, devices, audit, baseUrl: server.baseUrl, close: () => server.close()
  };
}

const get = (baseUrl, path, token, headers) => request(baseUrl, path, { token, headers });
const post = (baseUrl, path, body, token, headers) =>
  request(baseUrl, path, { method: 'POST', token, body, headers });

const peek = (db, name, id) => db.__peek(name, id);

async function transcriptRows(db, section) {
  const snapshot = await db.collection(`transcripts/${section}/entries`).get();
  return snapshot.docs.map(doc => doc.data());
}

/** A bound organizer, with the approved device already recorded the way the service writes it. */
async function boundHarness() {
  return harness({
    bindings: {
      [ORGANIZER]: {
        organizerUid: ORGANIZER, deviceId: DEV_ONE, deviceLabel: 'Pixel 7',
        basis: 'first_enrollment', boundBy: ORGANIZER
      }
    }
  });
}

// ==========================================================================
// Authentication, and where an identity is allowed to come from
// ==========================================================================

test('a device route with no valid token is refused before it reads anything', async () => {
  const context = await harness();
  try {
    assert.equal((await get(context.baseUrl, '/api/organizer/devices/status', undefined,
      device(DEV_ONE))).status, 401);
    assert.equal((await post(context.baseUrl, '/api/organizer/devices/enroll', {}, undefined,
      device(DEV_ONE))).status, 401);
    assert.equal((await post(context.baseUrl, '/api/organizer/devices/request', {}, undefined,
      device(DEV_TWO))).status, 401);
    assert.equal((await get(context.baseUrl, '/api/organizer/devices/history')).status, 401);

    assert.equal((await context.db.collection(BINDINGS_COLLECTION).get()).size, 0);
    assert.equal((await context.db.collection(DEVICE_REQUESTS).get()).size, 0);
  } finally {
    await context.close();
  }
});

test('an organizer is the token, never a field in the body', async () => {
  const context = await harness();
  try {
    // A body that names the rival organizer is ignored: the route reads `req.user.uid` and passes
    // nothing else, so the only binding this call can create is the caller's own.
    const enrolled = await post(context.baseUrl, '/api/organizer/devices/enroll',
      { organizerUid: RIVAL, uid: RIVAL }, 'token-organizer', device(DEV_ONE));
    assert.equal(enrolled.status, 200);

    assert.equal(peek(context.db, BINDINGS_COLLECTION, ORGANIZER).deviceId, DEV_ONE);
    assert.equal(peek(context.db, BINDINGS_COLLECTION, RIVAL), undefined,
      'and the organizer named in the body got no device from somebody else\'s call');

    // A body cannot name the account for a request either.
    const raised = await post(context.baseUrl, '/api/organizer/devices/request',
      { organizerUid: RIVAL }, 'token-organizer', device(DEV_TWO));
    assert.equal(raised.status, 200);
    assert.equal(peek(context.db, DEVICE_REQUESTS, raised.body.requestId).organizerUid, ORGANIZER,
      'the request belongs to whoever signed in');
  } finally {
    await context.close();
  }
});

test('a device is the header, never a field in the body', async () => {
  const context = await harness();
  try {
    const forged = await post(context.baseUrl, '/api/organizer/devices/enroll',
      { deviceId: DEV_ONE }, 'token-organizer');
    assert.equal(forged.status, 400);
    assert.equal(forged.body.code, 'DEVICE_ID_INVALID',
      'a body field is not how a device is declared, so there is nothing to check');
    assert.equal(peek(context.db, BINDINGS_COLLECTION, ORGANIZER), undefined);

    // And a body claim cannot override the header either.
    const real = await post(context.baseUrl, '/api/organizer/devices/enroll',
      { deviceId: DEV_ONE }, 'token-organizer', device(DEV_TWO));
    assert.equal(real.status, 200);
    assert.equal(peek(context.db, BINDINGS_COLLECTION, ORGANIZER).deviceId, DEV_TWO);
  } finally {
    await context.close();
  }
});

// ==========================================================================
// Status, enrollment and the pending state a screen has to show
// ==========================================================================

test('the status tells an unbound account to enroll, and never a bound one what their phone is', async () => {
  const fresh = await harness();
  try {
    const before = await get(fresh.baseUrl, '/api/organizer/devices/status', 'token-organizer',
      device(DEV_ONE));
    assert.equal(before.status, 200);
    assert.equal(before.body.bound, false);
    assert.equal(before.body.enrollmentAvailable, true,
      'a legacy organizer is pointed at an action, not told they are locked out');
  } finally {
    await fresh.close();
  }

  const bound = await boundHarness();
  try {
    const onIt = await get(bound.baseUrl, '/api/organizer/devices/status', 'token-organizer',
      device(DEV_ONE));
    assert.equal(onIt.body.matching, true);
    assert.equal(onIt.body.device.deviceLabel, 'Pixel 7');

    const other = await get(bound.baseUrl, '/api/organizer/devices/status', 'token-organizer',
      device(DEV_TWO));
    assert.equal(other.status, 200);
    assert.equal(other.body.bound, true);
    assert.equal(other.body.approvalRequired, true);
    assert.equal(other.body.enrollmentAvailable, false);
    assert.equal(other.body.device, null);
    assert.ok(!other.text.includes(DEV_ONE),
      `the approved identifier leaked into a status for another device: ${other.text}`);
  } finally {
    await bound.close();
  }
});

test('the first device enrolls once, and the same device asking again only refreshes its label', async () => {
  const context = await harness();
  try {
    const enrolled = await post(context.baseUrl, '/api/organizer/devices/enroll',
      { deviceLabel: 'Pixel 7' }, 'token-organizer', device(DEV_ONE));
    assert.equal(enrolled.status, 200);
    assert.equal(enrolled.body.applied, true);
    assert.equal(enrolled.body.auditRecorded, true);
    assert.equal(peek(context.db, BINDINGS_COLLECTION, ORGANIZER).basis, 'first_enrollment');

    const again = await post(context.baseUrl, '/api/organizer/devices/enroll',
      { deviceLabel: 'Work Pixel' }, 'token-organizer', device(DEV_ONE));
    assert.equal(again.status, 200);
    assert.equal(again.body.applied, false);
    assert.equal(peek(context.db, BINDINGS_COLLECTION, ORGANIZER).deviceLabel, 'Work Pixel');
    assert.equal(peek(context.db, BINDINGS_COLLECTION, ORGANIZER).deviceId, DEV_ONE);

    const rows = await transcriptRows(context.db, SECTIONS.ORGANIZER_DEVICES);
    assert.equal(rows.filter(row => row.actionType === 'enrolled').length, 1,
      'one enrollment is one audit row, however many times the screen retried');
  } finally {
    await context.close();
  }
});

test('a player cannot enroll a device at all', async () => {
  const context = await harness();
  try {
    const refused = await post(context.baseUrl, '/api/organizer/devices/enroll', {},
      'token-player', device(DEV_ONE));
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, 'NOT_AN_ORGANIZER');
    assert.equal(peek(context.db, BINDINGS_COLLECTION, PLAYER), undefined);
  } finally {
    await context.close();
  }
});

test('a second phone cannot enroll itself, and asking for it does not silently raise a request', async () => {
  const context = await boundHarness();
  try {
    const attempt = await post(context.baseUrl, '/api/organizer/devices/enroll', {},
      'token-organizer', device(DEV_TWO));
    assert.equal(attempt.status, 409);
    assert.equal(attempt.body.code, 'REPLACEMENT_REQUIRES_APPROVAL');
    assert.equal(peek(context.db, BINDINGS_COLLECTION, ORGANIZER).deviceId, DEV_ONE);
    assert.equal((await context.db.collection(DEVICE_REQUESTS).get()).size, 0);
  } finally {
    await context.close();
  }
});

test('a replacement becomes one pending request, and the history shows it without naming the old phone', async () => {
  const context = await boundHarness();
  try {
    const raised = await post(context.baseUrl, '/api/organizer/devices/request',
      { deviceLabel: 'Pixel 8' }, 'token-organizer', device(DEV_TWO));
    assert.equal(raised.status, 200);
    assert.equal(raised.body.pending, true);
    assert.equal(raised.body.status, REQUEST_STATUS.PENDING);

    const repeat = await post(context.baseUrl, '/api/organizer/devices/request',
      { deviceLabel: 'Pixel 8' }, 'token-organizer', device(DEV_TWO));
    assert.equal(repeat.body.duplicate, true);

    const page = await context.db.collection(DEVICE_REQUESTS).get();
    assert.equal(page.size, 1, 'two presses of the same button are still one request for an admin');

    const history = await get(context.baseUrl, '/api/organizer/devices/history',
      'token-organizer', device(DEV_TWO));
    assert.equal(history.status, 200);
    assert.equal(history.body.count, 1);
    assert.equal(history.body.requests[0].deviceId, DEV_TWO,
      'their own request names their own device');
    assert.ok(!history.text.includes(DEV_ONE),
      `the organizer's history leaked the approved identifier: ${history.text}`);
    assert.equal('approvedDeviceAtRequest' in history.body.requests[0], false);

    // And a rival's history is not this organizer's, whatever the query string claims.
    const rivalRows = await get(context.baseUrl, '/api/organizer/devices/history?organizerUid=' +
      RIVAL, 'token-rival', device(DEV_TWO));
    assert.equal(rivalRows.body.count, 0, 'a filter cannot be pointed at another account');
  } finally {
    await context.close();
  }
});

// ==========================================================================
// The gate on the protected operation
// ==========================================================================

test('a withdrawal on the approved device goes through, and is written down', async () => {
  const context = await boundHarness();
  try {
    const response = await post(context.baseUrl, '/api/organizer/wallet/withdrawal', {
      amount: 400, upiId: UPI, idempotencyToken: 'aaaa1111-bbbb2222'
    }, 'token-organizer', device(DEV_ONE));
    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    assert.equal(response.body.auditRecorded, true);

    const page = await context.db.collection(WITHDRAWALS).get();
    assert.equal(page.size, 1);
    assert.equal((await context.db.collection(LEDGER_COLLECTION).get()).size, 1,
      'and the reservation was made by the economy service, as always');

    const rows = await transcriptRows(context.db, SECTIONS.ORGANIZER_ECONOMY);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].performedBy, 'organizer');
    assert.equal(rows[0].performerId, ORGANIZER);
    assert.equal(rows[0].payload.ledgerRef.startsWith('reserve:'), true,
      'the row points at the ledger instead of restating a balance');
    assert.ok(!JSON.stringify(rows[0]).includes(UPI),
      'and a UPI id is never copied into an audit trail every admin can read');
  } finally {
    await context.close();
  }
});

test('a withdrawal from an unapproved device is refused before anything is reserved', async () => {
  const context = await boundHarness();
  try {
    const blocked = await post(context.baseUrl, '/api/organizer/wallet/withdrawal', {
      amount: 400, upiId: UPI, idempotencyToken: 'cccc3333-dddd4444'
    }, 'token-organizer', device(DEV_TWO));
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.code, 'DEVICE_NOT_APPROVED');
    assert.equal(blocked.body.approvalRequired, true);
    assert.equal(blocked.body.pendingRequestId, null, 'nothing had been asked for yet');

    assert.equal((await context.db.collection(WITHDRAWALS).get()).size, 0,
      'no request row');
    assert.equal((await context.db.collection(LEDGER_COLLECTION).get()).size, 0,
      'no ledger entry');
    assert.equal(peek(context.db, WALLET_COLLECTION, ORGANIZER).availableBalance, 1000,
      'and not one coin moved');
  } finally {
    await context.close();
  }
});

test('omitting the header is not a way around a binding', async () => {
  const context = await boundHarness();
  try {
    const silent = await post(context.baseUrl, '/api/organizer/wallet/withdrawal', {
      amount: 400, upiId: UPI, idempotencyToken: 'eeee5555-ffff6666'
    }, 'token-organizer');
    assert.equal(silent.status, 400);
    assert.equal(silent.body.code, 'DEVICE_ID_INVALID',
      'a bound account that declares no device is refused rather than waved through');
    assert.equal(silent.body.success, false);
    assert.equal((await context.db.collection(WITHDRAWALS).get()).size, 0,
      'and the refusal wrote nothing, which is the only property that matters here');

    // A declaration that is not an identifier at all is the same case, and an over-long header is
    // truncated before it is validated rather than passed to Firestore as a document field.
    const junk = await post(context.baseUrl, '/api/organizer/wallet/withdrawal', {
      amount: 400, upiId: UPI, idempotencyToken: 'uuuu1111-vvvv2222'
    }, 'token-organizer', device('x'.repeat(400)));
    assert.equal(junk.status, 400);
    assert.equal((await context.db.collection(WITHDRAWALS).get()).size, 0);

    // The same call carrying a nonsense header while nothing is bound is still allowed: see the
    // legacy test below, which is why this refusal is a validation answer and not a lockout.
  } finally {
    await context.close();
  }
});

test('an organizer with no binding at all is never locked out of their own money', async () => {
  // The backward-compatibility promise, as an HTTP assertion: every organizer working today has no
  // device record, and the first withdrawal after this phase ships has to behave exactly as it did
  // before it.
  const context = await harness();
  try {
    const legacy = await post(context.baseUrl, '/api/organizer/wallet/withdrawal', {
      amount: 400, upiId: UPI, idempotencyToken: 'gggg7777-hhhh8888'
    }, 'token-organizer');
    assert.equal(legacy.status, 200);
    assert.equal(legacy.body.success, true);

    // The same call carrying a nonsense device header is still allowed while nothing is bound.
    const junk = await post(context.baseUrl, '/api/organizer/wallet/withdrawal', {
      amount: 100, upiId: UPI, idempotencyToken: 'iiii9999-jjjj0000'
    }, 'token-rival', device('not a device id!'));
    assert.equal(junk.status, 200);
  } finally {
    await context.close();
  }
});

test('a device check that cannot be completed refuses rather than guessing', async () => {
  const context = await boundHarness();
  try {
    context.db.__fail(BINDINGS_COLLECTION, ORGANIZER, 'get');
    const failed = await post(context.baseUrl, '/api/organizer/wallet/withdrawal', {
      amount: 400, upiId: UPI, idempotencyToken: 'kkkk1111-llll2222'
    }, 'token-organizer', device(DEV_ONE));
    assert.equal(failed.status, 503);
    assert.equal(failed.body.retryable, true);
    assert.equal((await context.db.collection(WITHDRAWALS).get()).size, 0,
      'and nothing was reserved on the strength of an unreadable binding');

    // The listing stays readable, because an organizer waiting on an approval still has to be
    // able to see the requests they are locked out of making.
    context.db.__heal(BINDINGS_COLLECTION, ORGANIZER, 'get');
    const history = await get(context.baseUrl, '/api/organizer/wallet/withdrawals',
      'token-organizer', device(DEV_TWO));
    assert.equal(history.status, 200);
  } finally {
    await context.close();
  }
});

test('a blocked device cannot even ask for a replacement it is not allowed to have', async () => {
  const context = await harness({
    bindings: {
      [ORGANIZER]: { organizerUid: ORGANIZER, deviceId: DEV_ONE, basis: 'first_enrollment' }
    },
    accounts: { [ORGANIZER]: account(ORGANIZER, { banned: true }) }
  });
  try {
    const refused = await post(context.baseUrl, '/api/organizer/devices/request', {},
      'token-organizer', device(DEV_TWO));
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, 'ORGANIZER_BANNED');
    assert.equal((await context.db.collection(DEVICE_REQUESTS).get()).size, 0,
      'a banned account raises nothing');

    const withdrawn = await post(context.baseUrl, '/api/organizer/wallet/withdrawal', {
      amount: 400, upiId: UPI, idempotencyToken: 'mmmm3333-nnnn4444'
    }, 'token-organizer', device(DEV_ONE));
    assert.equal(withdrawn.status, 403,
      'and being on the approved phone does not buy a banned account a payout');
  } finally {
    await context.close();
  }
});

// ==========================================================================
// Admin decisions over HTTP
// ==========================================================================

test('an admin approves a pending device, and the decision belongs to the token', async () => {
  const context = await boundHarness();
  try {
    const raised = await post(context.baseUrl, '/api/organizer/devices/request',
      { deviceLabel: 'Pixel 8' }, 'token-organizer', device(DEV_TWO));
    const requestId = raised.body.requestId;

    for (const token of ['token-organizer', 'token-rival', 'token-player']) {
      const notAdmin = await post(context.baseUrl, '/api/admin/organizer/device/approve',
        { requestId }, token);
      assert.equal(notAdmin.status, 403, `${token} cannot approve a device`);
    }
    assert.equal(peek(context.db, BINDINGS_COLLECTION, ORGANIZER).deviceId, DEV_ONE,
      'and none of those refusals moved the binding');

    // A body that names a different reviewer or organizer changes nothing: both come from the row
    // and from the token.
    const approved = await post(context.baseUrl, '/api/admin/organizer/device/approve', {
      requestId, adminUid: RIVAL, organizerUid: RIVAL, deviceId: DEV_TWO
    }, 'token-admin');
    assert.equal(approved.status, 200);
    assert.equal(approved.body.auditRecorded, true);

    const binding = peek(context.db, BINDINGS_COLLECTION, ORGANIZER);
    assert.equal(binding.deviceId, DEV_TWO);
    assert.equal(binding.boundBy, ADMIN, 'the reviewer is the authenticated admin');
    assert.equal(binding.previousDeviceId, DEV_ONE);

    const second = await post(context.baseUrl, '/api/admin/organizer/device/approve',
      { requestId }, 'token-admin');
    assert.equal(second.status, 409);
    assert.equal(second.body.code, 'ALREADY_PROCESSED');

    const rows = await transcriptRows(context.db, SECTIONS.ORGANIZER_DEVICES);
    const decision = rows.find(row => row.actionType === 'approved');
    assert.equal(decision.performerId, ADMIN);
    assert.equal(decision.payload.organizerUid, ORGANIZER);

    // And the newly approved phone is now a working one.
    const usable = await post(context.baseUrl, '/api/organizer/wallet/withdrawal', {
      amount: 400, upiId: UPI, idempotencyToken: 'oooo5555-pppp6666'
    }, 'token-organizer', device(DEV_TWO));
    assert.equal(usable.status, 200);
  } finally {
    await context.close();
  }
});

test('the device queue is bounded, named, and empty of anything an admin did not ask for', async () => {
  const context = await harness({
    bindings: { [ORGANIZER]: { organizerUid: ORGANIZER, deviceId: DEV_ONE } },
    deviceRequests: {
      [requestIdFor({ organizerUid: ORGANIZER, deviceId: DEV_TWO })]: {
        organizerUid: ORGANIZER, deviceId: DEV_TWO, deviceLabel: 'Pixel 8',
        approvedDeviceAtRequest: DEV_ONE, status: REQUEST_STATUS.PENDING,
        requestedAt: new Date(Date.parse('2026-10-20T10:00:00.000Z'))
      },
      [requestIdFor({ organizerUid: RIVAL, deviceId: DEV_ONE })]: {
        organizerUid: RIVAL, deviceId: DEV_ONE, deviceLabel: 'Pixel 6a',
        status: REQUEST_STATUS.REJECTED, decidedBy: ADMIN,
        requestedAt: new Date(Date.parse('2026-10-01T10:00:00.000Z'))
      }
    }
  });
  try {
    const queue = await get(context.baseUrl, '/api/admin/organizer/devices?status=pending',
      'token-admin');
    assert.equal(queue.status, 200);
    assert.equal(queue.body.count, 1);
    assert.equal(queue.body.requests[0].username, 'org_a',
      'the organizer is named from their account, not from the request');
    assert.equal(queue.body.requests[0].approvedDeviceAtRequest, DEV_ONE,
      'an admin deciding an old request has to see which device it asked to replace');

    const everything = await get(context.baseUrl, '/api/admin/organizer/devices', 'token-admin');
    assert.equal(everything.body.count, 2);

    const forRival = await get(context.baseUrl,
      `/api/admin/organizer/devices?organizerUid=${RIVAL}`, 'token-admin');
    assert.equal(forRival.body.count, 1);
    assert.equal(forRival.body.requests[0].organizerUid, RIVAL);

    assert.equal((await get(context.baseUrl, '/api/admin/organizer/devices', 'token-player')).status,
      403);
  } finally {
    await context.close();
  }
});

test('a rejection needs a reason and keeps the approved device; a recovery clears it', async () => {
  const context = await harness({
    bindings: { [ORGANIZER]: { organizerUid: ORGANIZER, deviceId: DEV_ONE } },
    deviceRequests: {
      [requestIdFor({ organizerUid: ORGANIZER, deviceId: DEV_TWO })]: {
        organizerUid: ORGANIZER, deviceId: DEV_TWO, status: REQUEST_STATUS.PENDING,
        requestedAt: new Date()
      }
    }
  });
  const requestId = requestIdFor({ organizerUid: ORGANIZER, deviceId: DEV_TWO });
  try {
    const reasonless = await post(context.baseUrl, '/api/admin/organizer/device/reject',
      { requestId, reason: '  ' }, 'token-admin');
    assert.equal(reasonless.status, 400);
    assert.equal(reasonless.body.code, 'REASON_REQUIRED');

    const rejected = await post(context.baseUrl, '/api/admin/organizer/device/reject', {
      requestId, reason: 'Could not confirm the phone belongs to them'
    }, 'token-admin');
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.code, 'REJECTED');
    assert.equal(peek(context.db, BINDINGS_COLLECTION, ORGANIZER).deviceId, DEV_ONE,
      'a rejection answers one request and un-binds nobody');
    assert.equal(peek(context.db, DEVICE_REQUESTS, requestId).status, REQUEST_STATUS.REJECTED);

    const unnamed = await post(context.baseUrl, '/api/admin/organizer/device/reject', {},
      'token-admin');
    assert.equal(unnamed.status, 400);
    assert.equal(unnamed.body.code, 'REQUEST_ID_REQUIRED');

    // Recovery for a phone that is gone. Also the one device operation that removes something, so
    // it is the one that insists on a reason.
    const careless = await post(context.baseUrl, '/api/admin/organizer/device/reset',
      { organizerUid: ORGANIZER }, 'token-admin');
    assert.equal(careless.status, 400);

    const reset = await post(context.baseUrl, '/api/admin/organizer/device/reset', {
      organizerUid: ORGANIZER, reason: 'Reported stolen; owner will enroll a new phone'
    }, 'token-admin');
    assert.equal(reset.status, 200);
    assert.equal(reset.body.enrollmentAvailable, true);
    assert.equal(peek(context.db, BINDINGS_COLLECTION, ORGANIZER), undefined);

    // The pending state an organizer would see next: no binding, so a fresh enrollment is allowed.
    const reenrolled = await post(context.baseUrl, '/api/organizer/devices/enroll',
      { deviceLabel: 'Replacement Pixel' }, 'token-organizer', device(DEV_TWO));
    assert.equal(reenrolled.status, 200);
    assert.equal(reenrolled.body.applied, true);

    const empty = await post(context.baseUrl, '/api/admin/organizer/device/reset', {
      organizerUid: RIVAL, reason: 'nothing to clear here'
    }, 'token-admin');
    assert.equal(empty.status, 409);
    assert.equal(empty.body.code, 'NO_BINDING');
  } finally {
    await context.close();
  }
});

test('an admin reads one organizer\'s approved device, and a client reads none', async () => {
  const context = await boundHarness();
  try {
    const binding = await get(context.baseUrl,
      `/api/admin/organizer/device/binding?organizerUid=${ORGANIZER}`, 'token-admin');
    assert.equal(binding.status, 200);
    assert.equal(binding.body.bound, true);
    assert.equal(binding.body.binding.deviceId, DEV_ONE);

    const missing = await get(context.baseUrl,
      `/api/admin/organizer/device/binding?organizerUid=${RIVAL}`, 'token-admin');
    assert.equal(missing.body.code, 'NO_BINDING');
    assert.equal(missing.body.bound, false);

    // A binding read that never happened is a failed call, not a statement about the organizer's
    // device: an admin screen that read a successful-looking answer with no device in it would be
    // one cleared-binding keystroke away from a recovery nobody needed.
    const unnamed = await get(context.baseUrl, '/api/admin/organizer/device/binding', 'token-admin');
    assert.equal(unnamed.status, 400);
    assert.equal(unnamed.body.success, false);
    assert.equal(unnamed.body.code, 'ORGANIZER_UID_INVALID');

    assert.equal((await get(context.baseUrl, '/api/admin/organizer/device/binding',
      'token-player')).status, 403);
  } finally {
    await context.close();
  }
});

// ==========================================================================
// Phase 9: the activity history an admin reads back
// ==========================================================================

test('the audit endpoint reads a bounded page of a real section and refuses an invented one', async () => {
  const context = await boundHarness();
  try {
    // Produce rows in two sections through the operations that own them.
    const raised = await post(context.baseUrl, '/api/organizer/devices/request', {},
      'token-organizer', device(DEV_TWO));
    await post(context.baseUrl, '/api/admin/organizer/device/approve',
      { requestId: raised.body.requestId }, 'token-admin');
    await post(context.baseUrl, '/api/organizer/wallet/withdrawal', {
      amount: 400, upiId: UPI, idempotencyToken: 'qqqq7777-rrrr8888'
    }, 'token-organizer', device(DEV_TWO));

    const devicesPage = await get(context.baseUrl, '/api/admin/organizer/audit?section=organizer_devices',
      'token-admin');
    assert.equal(devicesPage.status, 200);
    assert.ok(devicesPage.body.entries.length >= 2, 'requested and approved are both there');
    const types = devicesPage.body.entries.map(row => row.actionType);
    assert.ok(types.includes('requested') && types.includes('approved'), types.join(','));

    const economyPage = await get(context.baseUrl, '/api/admin/organizer/audit?section=organizer_economy',
      'token-admin');
    assert.equal(economyPage.body.entries[0].actionType, 'withdrawal_requested');
    assert.ok(!JSON.stringify(economyPage.body).includes(UPI),
      'no payout identifier appears in a page of financial history');

    const unknown = await get(context.baseUrl, '/api/admin/organizer/audit?section=secrets',
      'token-admin');
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.code, 'SECTION_UNKNOWN');

    assert.equal((await get(context.baseUrl, '/api/admin/organizer/audit', 'token-organizer')).status,
      403);
  } finally {
    await context.close();
  }
});

test('one organizer\'s history is one merged page and never another organizer\'s rows', async () => {
  const context = await boundHarness();
  try {
    // Three rows of the organizer's, across the two sections a harness can produce: a device
    // request, the approval of it, and a withdrawal against the approved phone.
    const raised = await post(context.baseUrl, '/api/organizer/devices/request', {},
      'token-organizer', device(DEV_TWO));
    await post(context.baseUrl, '/api/admin/organizer/device/approve',
      { requestId: raised.body.requestId }, 'token-admin');
    await post(context.baseUrl, '/api/organizer/wallet/withdrawal', {
      amount: 400, upiId: UPI, idempotencyToken: 'uuuu1111-vvvv2222'
    }, 'token-organizer', device(DEV_TWO));

    // The rival acts too, so a filter that was not applied would be visible in the page. They
    // enroll rather than request a replacement, because an unbound organizer's first device is the
    // enrollment path and a distinct phone is what makes their row their own.
    const rivalRaised = await post(context.baseUrl, '/api/organizer/devices/enroll',
      { deviceLabel: 'Rival phone' }, 'token-rival', device('device-rival-0003'));
    assert.equal(rivalRaised.status, 200);

    const page = await get(context.baseUrl,
      `/api/admin/organizer/audit?organizerUid=${ORGANIZER}&limit=20`, 'token-admin');
    assert.equal(page.status, 200);
    assert.deepEqual(page.body.sections, ['organizers', 'organizer_devices', 'organizer_economy']);

    const owners = page.body.entries.map(entry => entry.payload.organizerUid);
    assert.ok(owners.length >= 3, `expected the organizer's own rows, got ${owners.length}`);
    assert.ok(owners.every(uid => uid === ORGANIZER), owners.join(','));

    const sections = new Set(page.body.entries.map(entry => entry.section));
    assert.ok(sections.has('organizer_devices') && sections.has('organizer_economy'),
      'one page carries both the phone and the coins, not just the newest section');

    assert.ok(!JSON.stringify(page.body).includes('device-rival-0003'),
      'the other organizer\'s phone is not in this organizer\'s history');
    assert.equal(page.body.truncated, false, 'three rows fit well inside one bounded page');

    // An organizer with no recorded activity is answered with a genuine zero, not a failed read.
    const nobody = await get(context.baseUrl,
      '/api/admin/organizer/audit?organizerUid=nobody-at-all', 'token-admin');
    assert.equal(nobody.status, 200);
    assert.equal(nobody.body.code, 'COMPLETE');
    assert.equal(nobody.body.total, 0);
    assert.equal(nobody.body.truncated, false);
  } finally {
    await context.close();
  }
});

test('a withdrawal a device check refused is not written into the audit trail as a success', async () => {
  const context = await boundHarness();
  try {
    await post(context.baseUrl, '/api/organizer/wallet/withdrawal', {
      amount: 400, upiId: UPI, idempotencyToken: 'ssss9999-tttt0000'
    }, 'token-organizer', device(DEV_TWO));

    assert.equal((await transcriptRows(context.db, SECTIONS.ORGANIZER_ECONOMY)).length, 0,
      'an operation that never happened left no record of happening');
  } finally {
    await context.close();
  }
});
