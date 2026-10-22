/**
 * Admin account deletion tests.
 *
 * The router is real, `verifyAuth` is real (only its token verifier is stubbed),
 * and the Firestore/Auth/Realtime Database access is doubled, so every case
 * below exercises the actual ordering and safety guards of the deletion flow.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { createFakeFirestore } = require('./helpers/fakeFirestore');
const { makeAuthenticator, startServer, request } = require('./helpers/authHarness');
const { createAdminAccountRouter } = require('../routes/adminAccountRoutes');
const { createUsernameRegistry } = require('../services/usernameRegistry');
const { createAccountDeletionService } = require('../services/accountDeletion');

const TOKENS = {
  'token-admin': { uid: 'admin-1', email: 'admin@example.com' },
  'token-player': { uid: 'player-1', email: 'player@example.com' }
};

function authNotFoundError(uid) {
  const error = new Error(`There is no user record corresponding to uid: ${uid}.`);
  error.code = 'auth/user-not-found';
  return error;
}

function createFakeAuth(seed = []) {
  const accounts = new Map(seed.map(uid => [uid, {}]));
  const calls = { getUser: [], deleteUser: [] };
  return {
    calls,
    async getUser(uid) {
      calls.getUser.push(uid);
      if (!accounts.has(uid)) throw authNotFoundError(uid);
      return { uid, phoneNumber: '+919876543210' };
    },
    async deleteUser(uid) {
      calls.deleteUser.push(uid);
      if (!accounts.has(uid)) throw authNotFoundError(uid);
      accounts.delete(uid);
      return { uid };
    },
    __has(uid) {
      return accounts.has(uid);
    }
  };
}

function createFakeRtdb({ failPaths = [] } = {}) {
  const removed = [];
  return {
    removed,
    ref(path) {
      return {
        async remove() {
          if (failPaths.includes(path)) {
            const error = new Error('PERMISSION_DENIED');
            error.code = 'PERMISSION_DENIED';
            throw error;
          }
          removed.push(path);
        }
      };
    }
  };
}

async function withService(firestore, { auth, rtdb, adminUids = ['admin-1'] } = {}) {
  const deletion = createAccountDeletionService({
    db: firestore,
    auth,
    rtdb,
    registry: createUsernameRegistry({
      db: { collection: name => firestore.collection(name) },
      serverTimestamp: () => 'fake-timestamp'
    }),
    isAdminUid: async uid => adminUids.includes(uid)
  });

  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use('/api/admin/account', createAdminAccountRouter({
    authenticator: makeAuthenticator(TOKENS),
    deletion
  }));

  const harness = await startServer(app);
  return {
    ...harness,
    post: (body, token) => request(harness.baseUrl, '/api/admin/account/delete', { method: 'POST', body, token })
  };
}

/** The full set of documents one player account can own. */
function seededAccount(overrides = {}) {
  return createFakeFirestore({
    users: { 'uid-1': { username: 'daksh', email: 'a@example.com', hwid: 'hw-1', depositBalance: 40 } },
    usernames: { daksh: { uid: 'uid-1', username: 'daksh' } },
    organizer_users: { 'uid-1': { uid: 'uid-1', isActive: true } },
    referralCodes: { DAKSH: { uid: 'uid-1', username: 'daksh', referralCode: 'DAKSH', usageCount: 1 } },
    devices: { 'hw-1': { userId: 'uid-1', username: 'daksh' } },
    phoneNumbers: { '+919876543210': { uid: 'uid-1', region: 'IN' } },
    'users/uid-1/joinedTournaments': { m1: { tournamentId: 't-1' }, m2: { tournamentId: 't-2' } },
    ...overrides
  });
}

function stepsIn(list) {
  return list.map(entry => entry.step);
}

// ==========================================================================
// Successful deletion
// ==========================================================================

test('deleting an account removes the login, profile, records and reservations', async () => {
  const firestore = seededAccount();
  const auth = createFakeAuth(['uid-1']);
  const rtdb = createFakeRtdb();
  const app = await withService(firestore, { auth, rtdb });
  try {
    const response = await app.post({ uid: 'uid-1', username: 'daksh' }, 'token-admin');

    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    assert.equal(response.body.code, 'COMPLETE');
    assert.deepEqual(auth.calls.deleteUser, ['uid-1']);

    assert.equal(firestore.__peek('users', 'uid-1'), undefined);
    assert.equal(firestore.__peek('organizer_users', 'uid-1'), undefined);
    assert.equal(firestore.__peek('referralCodes', 'DAKSH'), undefined);
    assert.equal(firestore.__peek('devices', 'hw-1'), undefined);
    assert.equal(firestore.__peek('usernames', 'daksh'), undefined, 'the registry reservation must be freed');
    assert.equal(firestore.__peek('phoneNumbers', '+919876543210'), undefined);
    assert.equal(firestore.__peek('users/uid-1/joinedTournaments', 'm1'), undefined);
    assert.equal(firestore.__peek('users/uid-1/joinedTournaments', 'm2'), undefined);

    assert.deepEqual(rtdb.removed, [
      'userPresence/uid-1', 'fcmTokens/uid-1', 'userBans/uid-1', 'notifications/uid-1'
    ]);
    assert.ok(stepsIn(response.body.removed).includes('username'));
  } finally {
    await app.close();
  }
});

test('deletion reports the account region and balances as untouched collections', async () => {
  // Guards the "do not rewrite payments/tournaments" rule: only the account's own
  // documents are removed, nothing else in the seeded database is touched.
  const firestore = seededAccount({
    tournaments: { 't-1': { name: 'Solo', prize: 500 } },
    withdrawalRequests: { 'w-1': { userId: 'uid-1', amount: 20 } }
  });
  const auth = createFakeAuth(['uid-1']);
  const app = await withService(firestore, { auth, rtdb: createFakeRtdb() });
  try {
    const response = await app.post({ uid: 'uid-1', username: 'daksh' }, 'token-admin');
    assert.equal(response.status, 200);
    assert.ok(firestore.__peek('tournaments', 't-1'));
    assert.ok(firestore.__peek('withdrawalRequests', 'w-1'));
  } finally {
    await app.close();
  }
});

// ==========================================================================
// Authorization
// ==========================================================================

test('deletion requires a valid Firebase ID token', async () => {
  const firestore = seededAccount();
  const auth = createFakeAuth(['uid-1']);
  const app = await withService(firestore, { auth, rtdb: createFakeRtdb() });
  try {
    assert.equal((await app.post({ uid: 'uid-1', username: 'daksh' })).status, 401);
    assert.equal((await app.post({ uid: 'uid-1', username: 'daksh' }, 'garbage')).status, 401);
    assert.ok(firestore.__peek('users', 'uid-1'), 'an unauthenticated request must not delete anything');
    assert.deepEqual(auth.calls.deleteUser, []);
  } finally {
    await app.close();
  }
});

test('an authenticated non-admin is refused without touching the target', async () => {
  const firestore = seededAccount();
  const auth = createFakeAuth(['uid-1']);
  const app = await withService(firestore, { auth, rtdb: createFakeRtdb() });
  try {
    const response = await app.post({ uid: 'uid-1', username: 'daksh' }, 'token-player');
    assert.equal(response.status, 403);
    assert.equal(response.body.code, 'FORBIDDEN');
    assert.ok(firestore.__peek('users', 'uid-1'));
    assert.ok(firestore.__peek('usernames', 'daksh'));
    assert.deepEqual(auth.calls.deleteUser, [], 'the login must survive a refused request');
  } finally {
    await app.close();
  }
});

test('the caller-supplied uid in the body never authorizes the request', async () => {
  // A player claiming to be the admin in the body still fails: the actor is taken
  // from the verified token only.
  const firestore = seededAccount();
  const app = await withService(firestore, { auth: createFakeAuth(['uid-1']), rtdb: createFakeRtdb() });
  try {
    const response = await app.post(
      { uid: 'uid-1', actorUid: 'admin-1', admin: true, username: 'daksh' },
      'token-player'
    );
    assert.equal(response.status, 403);
    assert.ok(firestore.__peek('users', 'uid-1'));
  } finally {
    await app.close();
  }
});

test('a missing account identifier is rejected before any lookup', async () => {
  const firestore = seededAccount();
  const app = await withService(firestore, { auth: createFakeAuth(['uid-1']), rtdb: createFakeRtdb() });
  try {
    assert.equal((await app.post({ uid: '', username: 'daksh' }, 'token-admin')).status, 400);
    assert.equal((await app.post({}, 'token-admin')).status, 400);
    assert.ok(firestore.__peek('users', 'uid-1'));
  } finally {
    await app.close();
  }
});

// ==========================================================================
// Missing accounts and repeated attempts
// ==========================================================================

test('an unknown uid is reported as not found and nothing is deleted', async () => {
  const firestore = seededAccount();
  const auth = createFakeAuth(['uid-1']);
  const rtdb = createFakeRtdb();
  const app = await withService(firestore, { auth, rtdb });
  try {
    const response = await app.post({ uid: 'ghost-uid', username: 'nobody' }, 'token-admin');
    assert.equal(response.status, 404);
    assert.equal(response.body.code, 'NOT_FOUND');
    assert.equal(response.body.success, false);
    assert.deepEqual(auth.calls.deleteUser, [], 'a phantom uid must not trigger an auth delete');
    assert.deepEqual(rtdb.removed, []);
    assert.ok(firestore.__peek('users', 'uid-1'), 'the real account is untouched');
  } finally {
    await app.close();
  }
});

test('repeating a completed deletion is a safe no-op', async () => {
  const firestore = seededAccount();
  const auth = createFakeAuth(['uid-1']);
  const rtdb = createFakeRtdb();
  const app = await withService(firestore, { auth, rtdb });
  try {
    const first = await app.post({ uid: 'uid-1', username: 'daksh' }, 'token-admin');
    assert.equal(first.status, 200);

    const second = await app.post({ uid: 'uid-1', username: 'daksh' }, 'token-admin');
    assert.equal(second.status, 404);
    assert.equal(second.body.code, 'NOT_FOUND');
    assert.equal(auth.calls.deleteUser.length, 1, 'the login is deleted exactly once');
    assert.equal(rtdb.removed.length, 4);
  } finally {
    await app.close();
  }
});

test('a retry after a partial failure finishes the cleanup without stranding the name', async () => {
  const firestore = seededAccount();
  const auth = createFakeAuth(['uid-1']);
  const app = await withService(firestore, { auth, rtdb: createFakeRtdb() });
  try {
    // First attempt: the profile document cannot be deleted.
    firestore.__fail('users', 'uid-1', 'delete');

    const failed = await app.post({ uid: 'uid-1', username: 'daksh' }, 'token-admin');
    assert.equal(failed.status, 500);
    assert.equal(failed.body.success, false);
    assert.equal(failed.body.code, 'PARTIAL');
    assert.equal(failed.body.retryable, true);
    assert.deepEqual(stepsIn(failed.body.failed).sort(), ['phoneNumber', 'profile', 'username']);

    // Nothing was stranded and, crucially, the username was not freed while the
    // profile still existed.
    assert.ok(firestore.__peek('users', 'uid-1'));
    assert.ok(firestore.__peek('usernames', 'daksh'), 'an active account keeps its name');
    assert.equal(firestore.__peek('usernames', 'daksh').uid, 'uid-1');
    assert.equal(auth.__has('uid-1'), false, 'the login was already removed');

    // Second attempt: the fault is gone, so the same request completes.
    firestore.__heal('users', 'uid-1', 'delete');
    const retry = await app.post({ uid: 'uid-1', username: 'daksh' }, 'token-admin');
    assert.equal(retry.status, 200);
    assert.equal(retry.body.code, 'COMPLETE');
    assert.equal(firestore.__peek('users', 'uid-1'), undefined);
    assert.equal(firestore.__peek('usernames', 'daksh'), undefined);
  } finally {
    await app.close();
  }
});

// ==========================================================================
// Partial failures
// ==========================================================================

test('a failed login deletion halts the operation before any data is touched', async () => {
  const firestore = seededAccount();
  const auth = createFakeAuth(['uid-1']);
  auth.deleteUser = async () => {
    const error = new Error('INTERNAL');
    error.code = 'internal';
    throw error;
  };
  const rtdb = createFakeRtdb();
  const app = await withService(firestore, { auth, rtdb });
  try {
    const response = await app.post({ uid: 'uid-1', username: 'daksh' }, 'token-admin');
    assert.equal(response.status, 500);
    assert.equal(response.body.code, 'PARTIAL');
    assert.equal(response.body.halted, true);
    assert.equal(response.body.retryable, true);

    // A deletable-but-undeleted account keeps all of its documents.
    assert.ok(firestore.__peek('users', 'uid-1'));
    assert.ok(firestore.__peek('usernames', 'daksh'));
    assert.ok(firestore.__peek('referralCodes', 'DAKSH'));
    assert.deepEqual(rtdb.removed, [], 'no side cleanup runs when the login is still live');
  } finally {
    await app.close();
  }
});

test('a realtime database failure is reported as incomplete, not as success', async () => {
  const firestore = seededAccount();
  const auth = createFakeAuth(['uid-1']);
  const rtdb = createFakeRtdb({ failPaths: ['fcmTokens/uid-1'] });
  const app = await withService(firestore, { auth, rtdb });
  try {
    const response = await app.post({ uid: 'uid-1', username: 'daksh' }, 'token-admin');
    assert.equal(response.status, 500);
    assert.equal(response.body.code, 'PARTIAL');
    assert.deepEqual(stepsIn(response.body.failed), ['realtimeDatabase']);
    assert.equal(response.body.success, false, 'partial cleanup must never look like success');

    // The account itself is gone and its name was freed, so nothing is stranded.
    assert.equal(firestore.__peek('users', 'uid-1'), undefined);
    assert.equal(firestore.__peek('usernames', 'daksh'), undefined);
  } finally {
    await app.close();
  }
});

test('a username release failure leaves the reservation intact and recoverable', async () => {
  const firestore = seededAccount();
  const auth = createFakeAuth(['uid-1']);
  const app = await withService(firestore, { auth, rtdb: createFakeRtdb() });
  try {
    firestore.__fail('usernames', 'daksh', 'get');

    const response = await app.post({ uid: 'uid-1', username: 'daksh' }, 'token-admin');
    assert.equal(response.status, 500);
    assert.equal(response.body.code, 'PARTIAL');
    assert.deepEqual(stepsIn(response.body.failed), ['username']);
    assert.ok(firestore.__peek('usernames', 'daksh'), 'a failed release must not free the name');
    assert.equal(firestore.__peek('users', 'uid-1'), undefined, 'the account itself was deleted');

    firestore.__heal('usernames', 'daksh', 'get');
    const retry = await app.post({ uid: 'uid-1', username: 'daksh' }, 'token-admin');
    assert.equal(retry.status, 200);
    assert.ok(stepsIn(retry.body.removed).includes('username'), 'the retry finishes the release');
    assert.deepEqual(stepsIn(retry.body.removed).filter(step => step === 'profile'), [],
      'the retry does not redo completed steps');
    assert.equal(firestore.__peek('usernames', 'daksh'), undefined);
  } finally {
    await app.close();
  }
});

// ==========================================================================
// Ownership of shared documents
// ==========================================================================

test('another account\'s reservation, referral code and device are never freed', async () => {
  const firestore = seededAccount({
    usernames: { daksh: { uid: 'uid-9', username: 'daksh' } },
    referralCodes: { DAKSH: { uid: 'uid-9', username: 'daksh' } },
    devices: { 'hw-1': { userId: 'uid-9', username: 'other' } }
  });
  const app = await withService(firestore, {
    auth: createFakeAuth(['uid-1']),
    rtdb: createFakeRtdb()
  });
  try {
    const response = await app.post({ uid: 'uid-1', username: 'daksh' }, 'token-admin');
    assert.equal(response.status, 200);
    assert.deepEqual(stepsIn(response.body.skipped).sort(), ['device', 'referralCode', 'username']);

    assert.equal(firestore.__peek('usernames', 'daksh').uid, 'uid-9');
    assert.equal(firestore.__peek('referralCodes', 'DAKSH').uid, 'uid-9');
    assert.equal(firestore.__peek('devices', 'hw-1').userId, 'uid-9');
    assert.equal(firestore.__peek('users', 'uid-1'), undefined, 'the targeted account is still deleted');
  } finally {
    await app.close();
  }
});

test('a legacy registry key the normalizer rejects is still freed when owned', async () => {
  // Old admin-created accounts can hold a document id that the current username
  // policy refuses to validate; that must not make the name unrecoverable.
  const firestore = createFakeFirestore({
    users: { 'uid-1': { username: 'Legacy.One', hwid: '' } },
    usernames: { 'legacy.one': { uid: 'uid-1', username: 'Legacy.One' } },
    referralCodes: { 'LEGACY.ONE': { uid: 'uid-1', username: 'Legacy.One' } }
  });
  const app = await withService(firestore, {
    auth: createFakeAuth(['uid-1']),
    rtdb: createFakeRtdb()
  });
  try {
    const response = await app.post({ uid: 'uid-1', username: 'Legacy.One' }, 'token-admin');
    assert.equal(response.status, 200);
    assert.equal(firestore.__peek('usernames', 'legacy.one'), undefined);
    assert.equal(firestore.__peek('referralCodes', 'LEGACY.ONE'), undefined);
  } finally {
    await app.close();
  }
});

test('deletion finishes when only the reservation outlived a previous attempt', async () => {
  // Profile and login are already gone but the username is still reserved for the
  // uid: an earlier crash would otherwise strand the name permanently.
  const firestore = createFakeFirestore({
    users: {},
    usernames: { daksh: { uid: 'uid-1', username: 'daksh' } }
  });
  const auth = createFakeAuth([]);
  const app = await withService(firestore, { auth, rtdb: createFakeRtdb() });
  try {
    const response = await app.post({ uid: 'uid-1', username: 'daksh' }, 'token-admin');
    assert.equal(response.status, 200);
    assert.equal(response.body.code, 'COMPLETE');
    assert.ok(stepsIn(response.body.removed).includes('username'));
    assert.deepEqual(stepsIn(response.body.removed).filter(step => step === 'profile'), [],
      'the already deleted profile is not reported as freshly removed');
    assert.equal(firestore.__peek('usernames', 'daksh'), undefined);
  } finally {
    await app.close();
  }
});
