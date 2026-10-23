/**
 * Admin phone-number update tests.
 *
 * The router is real, `verifyAuth` is real (only its token verifier is stubbed),
 * and Firestore/Authentication are doubled - so these cases assert the actual
 * ordering of the operation: validate, prove ownership, mutate the sign-in, then
 * commit profile and registry in one transaction. No live account or production
 * data is touched by anything in this file.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { createFakeFirestore } = require('./helpers/fakeFirestore');
const { makeAuthenticator, startServer, request } = require('./helpers/authHarness');
const { createAdminAccountRouter } = require('../routes/adminAccountRoutes');
const {
  createAdminPhoneUpdateService,
  ADMIN_SOURCE
} = require('../services/adminPhoneUpdate');

const TOKENS = {
  'token-admin': { uid: 'admin-1', email: 'admin@example.com' },
  'token-player': { uid: 'player-1', email: 'player@example.com' },
  // An organizer holds a verified token and an `organizer_users` record, but is
  // deliberately absent from `admin_users`.
  'token-organizer': { uid: 'organizer-1', email: 'org@example.com' }
};

const OLD = '+919999900001';
const NEW = '+919888877777';

function notFoundError(code, subject) {
  const error = new Error(`No record for ${subject}`);
  error.code = code;
  return error;
}

/**
 * Doubles the slice of the Admin Auth API this service uses.
 * `accounts` maps uid -> { phoneNumber }; `refuse` makes update attempts fail the
 * way a real `auth/...` refusal would, and `onUpdate` lets a test simulate a
 * concurrent claim landing between the ownership check and the write.
 */
function createFakeAuth({ accounts = new Map(), refuse = null, onUpdate = null } = {}) {
  const calls = { getUser: [], updateUser: [], getByPhoneNumber: [] };
  return {
    calls,
    accounts,
    async getUser(uid) {
      calls.getUser.push(uid);
      const record = accounts.get(uid);
      if (!record) throw notFoundError('auth/user-not-found', uid);
      return { uid, phoneNumber: record.phoneNumber || null };
    },
    async updateUser(uid, attrs) {
      calls.updateUser.push([uid, attrs]);
      if (onUpdate) await onUpdate();
      if (refuse) {
        const error = new Error(refuse.code);
        error.code = refuse.code;
        throw error;
      }
      const record = accounts.get(uid);
      if (!record) throw notFoundError('auth/user-not-found', uid);
      if (attrs.phoneNumber && [...accounts.entries()].some(([other, data]) =>
        other !== uid && data.phoneNumber === attrs.phoneNumber)) {
        const error = new Error('The phone number is already in use');
        error.code = 'auth/phone-number-already-exists';
        throw error;
      }
      record.phoneNumber = attrs.phoneNumber;
      return { uid, phoneNumber: attrs.phoneNumber };
    },
    async getUserByPhoneNumber(phoneNumber) {
      calls.getByPhoneNumber.push(phoneNumber);
      const match = [...accounts.entries()].find(([, data]) => data.phoneNumber === phoneNumber);
      if (!match) throw notFoundError('auth/phone-number-not-found', phoneNumber);
      return { uid: match[0], phoneNumber };
    }
  };
}

/** One player account: profile, sign-in and the number it currently owns. */
function seededState(profileOverrides = {}) {
  const firestore = createFakeFirestore({
    users: {
      'uid-1': {
        username: 'daksh',
        email: 'a@example.com',
        phone: OLD,
        phoneVerified: true,
        phoneRegion: 'IN',
        depositBalance: 120,
        joinedTournaments: {},
        ...profileOverrides
      }
    },
    phoneNumbers: { [OLD]: { uid: 'uid-1', phoneNumber: OLD, region: 'IN' } },
    admin_users: { 'admin-1': { uid: 'admin-1' } },
    organizer_users: { 'organizer-1': { uid: 'organizer-1', isActive: true } }
  });
  const auth = createFakeAuth({ accounts: new Map([['uid-1', { phoneNumber: OLD }]]) });
  return { firestore, auth };
}

async function withRoute(firestore, auth, { adminUids = ['admin-1'] } = {}) {
  const phoneUpdate = createAdminPhoneUpdateService({
    db: firestore,
    auth,
    isAdminUid: async uid => adminUids.includes(uid),
    serverTimestamp: () => 'fake-timestamp'
  });

  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use('/api/admin/account', createAdminAccountRouter({
    authenticator: makeAuthenticator(TOKENS),
    phoneUpdate
  }));

  const harness = await startServer(app);
  return {
    ...harness,
    post: (body, token) => request(harness.baseUrl, '/api/admin/account/update-phone', {
      method: 'POST', body, token
    })
  };
}

// ==========================================================================
// Authorization
// ==========================================================================

test('a phone update requires a valid Firebase ID token', async () => {
  const { firestore, auth } = seededState();
  const app = await withRoute(firestore, auth);
  try {
    assert.equal((await app.post({ uid: 'uid-1', phoneNumber: NEW })).status, 401);
    assert.equal((await app.post({ uid: 'uid-1', phoneNumber: NEW }, 'garbage')).status, 401);

    assert.equal(firestore.__peek('users', 'uid-1').phone, OLD, 'the profile must be untouched');
    assert.deepEqual(auth.calls.updateUser, [], 'no sign-in may be edited by an anonymous caller');
  } finally {
    await app.close();
  }
});

test('an ordinary player is refused', async () => {
  const { firestore, auth } = seededState();
  const app = await withRoute(firestore, auth);
  try {
    const response = await app.post({ uid: 'uid-1', phoneNumber: NEW }, 'token-player');
    assert.equal(response.status, 403);
    assert.equal(response.body.code, 'FORBIDDEN');
    assert.deepEqual(auth.calls.updateUser, []);
  } finally {
    await app.close();
  }
});

test('an organizer is refused: only admin_users grants this authority', async () => {
  const { firestore, auth } = seededState();
  const app = await withRoute(firestore, auth);
  try {
    // The organizer record exists, so any check that looked at organizer_users
    // instead of admin_users would wrongly let this through.
    assert.ok(firestore.__peek('organizer_users', 'organizer-1'));
    const response = await app.post({ uid: 'uid-1', phoneNumber: NEW }, 'token-organizer');
    assert.equal(response.status, 403);
    assert.equal(response.body.code, 'FORBIDDEN');
    assert.equal(firestore.__peek('users', 'uid-1').phone, OLD);
    assert.deepEqual(auth.calls.updateUser, []);
  } finally {
    await app.close();
  }
});

test('a caller-supplied role in the body carries no authority', async () => {
  const { firestore, auth } = seededState();
  const app = await withRoute(firestore, auth);
  try {
    const response = await app.post(
      { uid: 'uid-1', phoneNumber: NEW, isAdmin: true, role: 'admin' },
      'token-player'
    );
    assert.equal(response.status, 403);
    assert.deepEqual(auth.calls.updateUser, []);
  } finally {
    await app.close();
  }
});

// ==========================================================================
// Validation
// ==========================================================================

test('a missing or malformed target identifier is rejected before any read', async () => {
  const { firestore, auth } = seededState();
  const app = await withRoute(firestore, auth);
  try {
    for (const uid of [undefined, '', '   ', 42]) {
      const response = await app.post({ uid, phoneNumber: NEW }, 'token-admin');
      assert.equal(response.status, 400, `uid ${JSON.stringify(uid)} must be refused`);
      assert.equal(response.body.code, 'INVALID_UID');
    }
    assert.deepEqual(auth.calls.getUser, []);
    assert.equal(firestore.__peek('users', 'uid-1').phone, OLD);
  } finally {
    await app.close();
  }
});

test('numbers outside the supported shape are rejected', async () => {
  const { firestore, auth } = seededState();
  const app = await withRoute(firestore, auth);
  try {
    const rejected = [
      '',                 // blank
      '+91988887777',     // nine national digits
      '+9198888777777',   // eleven national digits
      '+910888877777',    // leading zero in the national part
      '+91988887777a',    // non-digit
      '+12345678901',     // unsupported country
      '+91',              // calling code only
      '9888877777',       // no calling code at all
      null
    ];
    for (const phoneNumber of rejected) {
      const response = await app.post({ uid: 'uid-1', phoneNumber }, 'token-admin');
      assert.equal(response.status, 400, `${JSON.stringify(phoneNumber)} must be refused`);
      assert.equal(response.body.code, 'INVALID_PHONE');
    }
    assert.deepEqual(auth.calls.updateUser, [], 'a refused shape never reaches the sign-in');
  } finally {
    await app.close();
  }
});

test('a valid number with stray spacing is accepted in its canonical form', async () => {
  const { firestore, auth } = seededState();
  const app = await withRoute(firestore, auth);
  try {
    const response = await app.post({ uid: 'uid-1', phoneNumber: `  ${NEW} ` }, 'token-admin');
    assert.equal(response.status, 200);
    assert.equal(response.body.phone, NEW);
    assert.equal(firestore.__peek('users', 'uid-1').phone, NEW);
  } finally {
    await app.close();
  }
});

test('a missing target account is reported as not found', async () => {
  const { firestore, auth } = seededState();
  const app = await withRoute(firestore, auth);
  try {
    const response = await app.post({ uid: 'ghost-uid', phoneNumber: NEW }, 'token-admin');
    assert.equal(response.status, 404);
    assert.equal(response.body.code, 'NOT_FOUND');
    assert.deepEqual(auth.calls.updateUser, []);
  } finally {
    await app.close();
  }
});

test('a profile without a sign-in account is reported as not found, not silently patched', async () => {
  const firestore = seededState().firestore;
  const auth = createFakeAuth({ accounts: new Map() });
  const app = await withRoute(firestore, auth);
  try {
    const response = await app.post({ uid: 'uid-1', phoneNumber: NEW }, 'token-admin');
    assert.equal(response.status, 404);
    assert.equal(response.body.code, 'NOT_FOUND');
    assert.equal(firestore.__peek('users', 'uid-1').phone, OLD,
      'the profile must not drift ahead of the sign-in');
  } finally {
    await app.close();
  }
});

// ==========================================================================
// Uniqueness
// ==========================================================================

test('a number reserved to another account in the registry is refused', async () => {
  const { firestore, auth } = seededState();
  firestore.__seed('phoneNumbers', NEW, { uid: 'uid-2', phoneNumber: NEW, region: 'IN' });
  const app = await withRoute(firestore, auth);
  try {
    const response = await app.post({ uid: 'uid-1', phoneNumber: NEW }, 'token-admin');
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'PHONE_ALREADY_ASSIGNED');
    assert.deepEqual(auth.calls.updateUser, []);
    assert.equal(firestore.__peek('users', 'uid-1').phone, OLD);
    assert.equal(firestore.__peek('phoneNumbers', NEW).uid, 'uid-2');
  } finally {
    await app.close();
  }
});

test('a number carried by another profile is refused', async () => {
  const { firestore, auth } = seededState();
  firestore.__seed('users', 'uid-2', { username: 'other', phone: NEW });
  const app = await withRoute(firestore, auth);
  try {
    const response = await app.post({ uid: 'uid-1', phoneNumber: NEW }, 'token-admin');
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'PHONE_ALREADY_ASSIGNED');
    assert.deepEqual(auth.calls.updateUser, []);
  } finally {
    await app.close();
  }
});

test('a number already attached to another sign-in account is refused', async () => {
  const state = seededState();
  const auth = createFakeAuth({
    accounts: new Map([
      ['uid-1', { phoneNumber: OLD }],
      ['uid-2', { phoneNumber: NEW }]
    ])
  });
  const app = await withRoute(state.firestore, auth);
  try {
    const response = await app.post({ uid: 'uid-1', phoneNumber: NEW }, 'token-admin');
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'PHONE_ALREADY_ASSIGNED');
    assert.deepEqual(auth.calls.updateUser, []);
    assert.equal(auth.accounts.get('uid-2').phoneNumber, NEW);
  } finally {
    await app.close();
  }
});

test('a number the target already owns is reconciled rather than duplicated', async () => {
  const { firestore, auth } = seededState();
  const app = await withRoute(firestore, auth);
  try {
    const response = await app.post({ uid: 'uid-1', phoneNumber: OLD }, 'token-admin');
    assert.equal(response.status, 200);
    assert.equal(response.body.code, 'RECONCILED');
    assert.equal(response.body.success, true);
    assert.deepEqual(auth.calls.updateUser, [], 'the sign-in is not rewritten when it is correct');
    assert.ok(firestore.__peek('phoneNumbers', OLD), 'the reservation survives a reconciliation');
    assert.equal(firestore.__peek('phoneNumbers', OLD).uid, 'uid-1');
  } finally {
    await app.close();
  }
});

test('a concurrent claim landing mid-change is reported, never overwritten', async () => {
  const { firestore, auth } = seededState();
  // The other account wins the reservation after the ownership check has passed
  // and after the sign-in was already moved.
  const hijacked = createFakeAuth({
    accounts: new Map([['uid-1', { phoneNumber: OLD }]]),
    onUpdate: async () => {
      firestore.__seed('phoneNumbers', NEW, { uid: 'uid-2', phoneNumber: NEW, region: 'IN' });
    }
  });
  const app = await withRoute(firestore, hijacked);
  try {
    const response = await app.post({ uid: 'uid-1', phoneNumber: NEW }, 'token-admin');
    assert.equal(response.status, 500);
    assert.equal(response.body.code, 'PARTIAL');
    assert.equal(response.body.authUpdated, true);
    assert.equal(response.body.retryable, true);
    assert.equal(firestore.__peek('users', 'uid-1').phone, OLD, 'the profile is not half-written');
    assert.equal(firestore.__peek('phoneNumbers', NEW).uid, 'uid-2', "another account's reservation wins");
  } finally {
    await app.close();
  }
});

// ==========================================================================
// The successful change
// ==========================================================================

test('an authorized update moves the sign-in, the profile and the registry', async () => {
  const { firestore, auth } = seededState();
  const app = await withRoute(firestore, auth);
  try {
    const response = await app.post({ uid: 'uid-1', phoneNumber: NEW }, 'token-admin');

    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    assert.equal(response.body.code, 'COMPLETE');
    assert.equal(response.body.phone, NEW);
    assert.equal(response.body.region, 'IN');
    assert.deepEqual(auth.calls.updateUser, [['uid-1', { phoneNumber: NEW }]]);
    assert.equal(auth.accounts.get('uid-1').phoneNumber, NEW);

    const profile = firestore.__peek('users', 'uid-1');
    assert.equal(profile.phone, NEW);
    assert.equal(profile.phoneVerified, false, 'an admin edit is not an SMS verification');

    assert.equal(firestore.__peek('phoneNumbers', OLD), undefined, 'the old reservation is freed');
    const reservation = firestore.__peek('phoneNumbers', NEW);
    assert.equal(reservation.uid, 'uid-1');
    assert.equal(reservation.region, 'IN');
    assert.equal(reservation.source, ADMIN_SOURCE);
    assert.equal(reservation.assignedBy, 'admin-1');
  } finally {
    await app.close();
  }
});

test('only phone fields are written: balance, region and unrelated fields survive', async () => {
  const { firestore, auth } = seededState({ nepaliNote: 'keep me' });
  const app = await withRoute(firestore, auth);
  try {
    await app.post({ uid: 'uid-1', phoneNumber: NEW }, 'token-admin');
    const profile = firestore.__peek('users', 'uid-1');
    assert.equal(profile.depositBalance, 120);
    assert.equal(profile.username, 'daksh');
    assert.equal(profile.nepaliNote, 'keep me');
    assert.equal(profile.phoneRegion, 'IN', 'saving a phone never rewrites the server');
  } finally {
    await app.close();
  }
});

test('a phone change keeps a stored server even when it does not match the country', async () => {
  // The mismatch warning belongs to the server-edit flow; a phone save must not
  // silently "fix" phoneRegion.
  const { firestore, auth } = seededState({ phoneRegion: 'NP' });
  const app = await withRoute(firestore, auth);
  try {
    const response = await app.post({ uid: 'uid-1', phoneNumber: '+9779841234567' }, 'token-admin');
    assert.equal(response.status, 200);
    assert.equal(firestore.__peek('users', 'uid-1').phoneRegion, 'NP');
    assert.equal(firestore.__peek('phoneNumbers', '+9779841234567').region, 'NP');
  } finally {
    await app.close();
  }
});

test('an old registry mapping owned by someone else is never deleted', async () => {
  const firestore = seededState().firestore;
  // The profile claims OLD, but the reservation belongs to another account - so the
  // cleanup must leave that document alone.
  firestore.__seed('phoneNumbers', OLD, { uid: 'uid-2', phoneNumber: OLD, region: 'IN' });
  const auth = createFakeAuth({ accounts: new Map([['uid-1', { phoneNumber: OLD }]]) });
  const app = await withRoute(firestore, auth);
  try {
    const response = await app.post({ uid: 'uid-1', phoneNumber: NEW }, 'token-admin');
    assert.equal(response.status, 200);
    assert.equal(firestore.__peek('phoneNumbers', OLD).uid, 'uid-2');
    assert.equal(firestore.__peek('phoneNumbers', NEW).uid, 'uid-1');
  } finally {
    await app.close();
  }
});

test('a response never leaks internal error details to the client', async () => {
  const { firestore } = seededState();
  const auth = createFakeAuth({
    accounts: new Map([['uid-1', { phoneNumber: OLD }]]),
    refuse: { code: 'auth/invalid-phone-number' }
  });
  const app = await withRoute(firestore, auth);
  try {
    const response = await app.post({ uid: 'uid-1', phoneNumber: NEW }, 'token-admin');
    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'REJECTED');
    assert.equal(response.body.authUpdated, false);
    assert.ok(!response.text.includes('serviceAccount'), 'no credentials in the body');
    assert.deepEqual(response.body.steps, ['auth'], 'step names are sent, step details are not');
    assert.ok(!Object.keys(response.body).some(key => /detail|stack/i.test(key)));
    assert.equal(firestore.__peek('users', 'uid-1').phone, OLD);
    assert.equal(firestore.__peek('phoneNumbers', OLD).uid, 'uid-1', 'nothing was torn down');
  } finally {
    await app.close();
  }
});

// ==========================================================================
// Partial failure and reconciliation
// ==========================================================================

test('a Firestore failure after the sign-in change is a partial result, not success', async () => {
  const { firestore, auth } = seededState();
  firestore.__fail('users', 'uid-1', 'set');
  const app = await withRoute(firestore, auth);
  try {
    const response = await app.post({ uid: 'uid-1', phoneNumber: NEW }, 'token-admin');
    assert.equal(response.status, 500);
    assert.equal(response.body.success, false);
    assert.equal(response.body.code, 'PARTIAL');
    assert.equal(response.body.authUpdated, true);
    assert.equal(response.body.retryable, true);
    assert.equal(response.body.message.includes('sign-in'), true, 'the message says what happened');

    // Authentication holds the new number while the profile still shows the old one.
    assert.equal(auth.accounts.get('uid-1').phoneNumber, NEW);
    assert.equal(firestore.__peek('users', 'uid-1').phone, OLD);
    assert.equal(firestore.__peek('phoneNumbers', NEW), undefined);
  } finally {
    await app.close();
  }
});

test('retrying a partial change finishes it without rewriting the sign-in', async () => {
  const { firestore, auth } = seededState();
  firestore.__fail('users', 'uid-1', 'set');
  const app = await withRoute(firestore, auth);
  try {
    const first = await app.post({ uid: 'uid-1', phoneNumber: NEW }, 'token-admin');
    assert.equal(first.status, 500);
    assert.equal(first.body.code, 'PARTIAL');

    firestore.__heal('users', 'uid-1', 'set');
    const retry = await app.post({ uid: 'uid-1', phoneNumber: NEW }, 'token-admin');
    assert.equal(retry.status, 200);
    assert.equal(retry.body.success, true);
    assert.equal(retry.body.phone, NEW);

    assert.deepEqual(auth.calls.updateUser, [['uid-1', { phoneNumber: NEW }]],
      'the sign-in is written exactly once across both attempts');
    assert.equal(firestore.__peek('users', 'uid-1').phone, NEW);
    assert.equal(firestore.__peek('phoneNumbers', NEW).uid, 'uid-1');
    assert.equal(firestore.__peek('phoneNumbers', OLD), undefined);
  } finally {
    await app.close();
  }
});

test('a retry after a lost registry write re-reserves the number', async () => {
  const { firestore, auth } = seededState();
  firestore.__fail('phoneNumbers', NEW, 'set');
  const app = await withRoute(firestore, auth);
  try {
    const first = await app.post({ uid: 'uid-1', phoneNumber: NEW }, 'token-admin');
    assert.equal(first.status, 500);
    assert.equal(first.body.code, 'PARTIAL');
    assert.equal(firestore.__peek('users', 'uid-1').phone, OLD,
      'profile and registry commit together or not at all');

    firestore.__heal('phoneNumbers', NEW, 'set');
    const retry = await app.post({ uid: 'uid-1', phoneNumber: NEW }, 'token-admin');
    assert.equal(retry.status, 200);
    assert.equal(firestore.__peek('phoneNumbers', NEW).uid, 'uid-1');
    assert.equal(firestore.__peek('users', 'uid-1').phone, NEW);
  } finally {
    await app.close();
  }
});

test('an unreadable profile stops the operation before any mutation', async () => {
  const { firestore, auth } = seededState();
  firestore.__fail('users', 'uid-1', 'get');
  const app = await withRoute(firestore, auth);
  try {
    const response = await app.post({ uid: 'uid-1', phoneNumber: NEW }, 'token-admin');
    assert.equal(response.status, 500);
    assert.equal(response.body.code, 'PARTIAL');
    assert.equal(response.body.authUpdated, false);
    assert.equal(response.body.retryable, true);
    assert.deepEqual(auth.calls.updateUser, []);
  } finally {
    await app.close();
  }
});

test('a registry read failure is reported as unknown ownership, never as free', async () => {
  const { firestore, auth } = seededState();
  firestore.__fail('phoneNumbers', NEW, 'get');
  const app = await withRoute(firestore, auth);
  try {
    const response = await app.post({ uid: 'uid-1', phoneNumber: NEW }, 'token-admin');
    assert.equal(response.status, 500);
    assert.equal(response.body.code, 'PARTIAL');
    assert.deepEqual(auth.calls.updateUser, [], 'ownership must be proven before the sign-in moves');
    assert.equal(firestore.__peek('users', 'uid-1').phone, OLD);
  } finally {
    await app.close();
  }
});

// ==========================================================================
// Malformed legacy data
// ==========================================================================

test('a malformed legacy number on the profile does not block a clean correction', async () => {
  const { firestore, auth } = seededState({ phone: '098888 77777', phoneVerified: false });
  const app = await withRoute(firestore, auth);
  try {
    const response = await app.post({ uid: 'uid-1', phoneNumber: NEW }, 'token-admin');
    assert.equal(response.status, 200);
    assert.equal(response.body.code, 'COMPLETE');
    assert.equal(firestore.__peek('users', 'uid-1').phone, NEW);
    // The junk value was never a registry key, so nothing else is removed.
    assert.equal(firestore.__peek('phoneNumbers', OLD).uid, 'uid-1');
  } finally {
    await app.close();
  }
});

test('a profile with no phone at all can be given one', async () => {
  const { firestore, auth } = seededState();
  firestore.__seed('users', 'uid-3', { username: 'fresh', phone: '' });
  firestore.__seed('admin_users', 'admin-1', { uid: 'admin-1' });
  auth.accounts.set('uid-3', { phoneNumber: null });
  const app = await withRoute(firestore, auth);
  try {
    const response = await app.post({ uid: 'uid-3', phoneNumber: '+923001234567' }, 'token-admin');
    assert.equal(response.status, 200);
    assert.equal(firestore.__peek('users', 'uid-3').phone, '+923001234567');
    assert.equal(firestore.__peek('users', 'uid-3').phoneVerified, false);
    assert.equal(firestore.__peek('phoneNumbers', '+923001234567').region, 'PK');
  } finally {
    await app.close();
  }
});

test('the service refuses to be built without its authoritative dependencies', () => {
  assert.throws(() => createAdminPhoneUpdateService({ db: {}, auth: {} }), /requires/);
});
