const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeFirestore } = require('./helpers/fakeFirestore');
const { createTestApp, startServer, request, makeAuthenticator } = require('./helpers/authHarness');

const TOKENS = {
  'token-no-phone': { uid: 'uid-1', email: 'a@example.com' },
  'token-in': { uid: 'uid-1', email: 'a@example.com', phone_number: '+919876543210' },
  'token-np': { uid: 'uid-2', email: 'b@example.com', phone_number: '+9779812345678' },
  'token-other': { uid: 'uid-9', email: 'c@example.com', phone_number: '+919876543210' }
};

async function withApp(firestore, limiter) {
  const harness = await startServer(createTestApp({
    firestore,
    limiter,
    authenticator: makeAuthenticator(TOKENS)
  }));
  return {
    ...harness,
    get: path => request(harness.baseUrl, path),
    post: (path, body, token) => request(harness.baseUrl, path, { method: 'POST', body, token })
  };
}

// ==========================================================================
// Username availability
// ==========================================================================

test('availability reports a free username without leaking other data', async () => {
  const firestore = createFakeFirestore({ usernames: {}, users: {} });
  const app = await withApp(firestore);
  try {
    const response = await app.get('/api/auth/username-availability?username=Daksh_2028');
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { success: true, available: true, username: 'daksh_2028' });
  } finally {
    await app.close();
  }
});

test('availability reports taken for a reserved registry name', async () => {
  const firestore = createFakeFirestore({
    usernames: { daksh: { uid: 'uid-1', username: 'daksh' } },
    users: {}
  });
  const app = await withApp(firestore);
  try {
    const response = await app.get('/api/auth/username-availability?username=DAKSH');
    assert.equal(response.status, 200);
    assert.equal(response.body.available, false);
  } finally {
    await app.close();
  }
});

test('availability reports taken for a legacy profile with no registry document', async () => {
  const firestore = createFakeFirestore({
    usernames: {},
    users: { 'uid-5': { username: 'oldplayer' } }
  });
  const app = await withApp(firestore);
  try {
    const response = await app.get('/api/auth/username-availability?username=oldplayer');
    assert.equal(response.status, 200);
    assert.equal(response.body.available, false);
  } finally {
    await app.close();
  }
});

test('availability rejects malformed and missing usernames with 400', async () => {
  const firestore = createFakeFirestore({ usernames: {}, users: {} });
  const app = await withApp(firestore);
  try {
    assert.equal((await app.get('/api/auth/username-availability?username=ab')).status, 400);
    assert.equal((await app.get('/api/auth/username-availability?username=has%20space')).status, 400);
    assert.equal((await app.get('/api/auth/username-availability')).status, 400);
  } finally {
    await app.close();
  }
});

test('availability returns 500 on lookup failure and never claims availability', async () => {
  const firestore = createFakeFirestore({ usernames: {}, users: {} });
  firestore.collection = () => {
    throw new Error('UNAVAILABLE');
  };
  const app = await withApp(firestore);
  try {
    const response = await app.get('/api/auth/username-availability?username=daksh');
    assert.equal(response.status, 500);
    assert.equal(response.body.success, false);
    assert.equal('available' in response.body, false, 'error responses must not carry an availability flag');
  } finally {
    await app.close();
  }
});

test('availability is rate limited', async () => {
  const firestore = createFakeFirestore({ usernames: {}, users: {} });
  const app = await withApp(firestore, { allowed: () => false });
  try {
    const response = await app.get('/api/auth/username-availability?username=daksh');
    assert.equal(response.status, 429);
    assert.equal(response.body.success, false);
  } finally {
    await app.close();
  }
});

// ==========================================================================
// Username claim / release
// ==========================================================================

test('claim requires a valid Firebase ID token', async () => {
  const firestore = createFakeFirestore({ usernames: {}, users: {} });
  const app = await withApp(firestore);
  try {
    assert.equal((await app.post('/api/auth/claim-username', { username: 'daksh' })).status, 401);
    assert.equal((await app.post('/api/auth/claim-username', { username: 'daksh' }, 'nope')).status, 401);
    assert.equal(firestore.__peek('usernames', 'daksh'), undefined, 'unauthenticated claim must not write');
  } finally {
    await app.close();
  }
});

test('claim reserves a username for the authenticated uid', async () => {
  const firestore = createFakeFirestore({ usernames: {}, users: {} });
  const app = await withApp(firestore);
  try {
    const response = await app.post('/api/auth/claim-username', { username: 'Daksh_2028' }, 'token-no-phone');
    assert.equal(response.status, 201);
    assert.deepEqual(response.body, { success: true, username: 'daksh_2028' });
    assert.equal(firestore.__peek('usernames', 'daksh_2028').uid, 'uid-1');
  } finally {
    await app.close();
  }
});

test('claim returns 409 for a username owned by another account', async () => {
  const firestore = createFakeFirestore({
    usernames: { daksh: { uid: 'uid-1', username: 'daksh' } },
    users: {}
  });
  const app = await withApp(firestore);
  try {
    const response = await app.post('/api/auth/claim-username', { username: 'daksh' }, 'token-other');
    assert.equal(response.status, 409);
    assert.equal(response.body.success, false);
    assert.equal(firestore.__peek('usernames', 'daksh').uid, 'uid-1');
  } finally {
    await app.close();
  }
});

test('claim is idempotent when the same account retries', async () => {
  const firestore = createFakeFirestore({
    usernames: { daksh: { uid: 'uid-1', username: 'daksh' } },
    users: {}
  });
  const app = await withApp(firestore);
  try {
    const response = await app.post('/api/auth/claim-username', { username: 'daksh' }, 'token-no-phone');
    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
  } finally {
    await app.close();
  }
});

test('claim validates format before writing', async () => {
  const firestore = createFakeFirestore({ usernames: {}, users: {} });
  const app = await withApp(firestore);
  try {
    const response = await app.post('/api/auth/claim-username', { username: 'a b' }, 'token-no-phone');
    assert.equal(response.status, 400);
    assert.equal(response.body.success, false);
    assert.equal(firestore.__peek('usernames', 'a b'), undefined);
  } finally {
    await app.close();
  }
});

test('release lets a failed signup roll back its own reservation only', async () => {
  const firestore = createFakeFirestore({
    usernames: { daksh: { uid: 'uid-1', username: 'daksh' } },
    users: {}
  });
  const app = await withApp(firestore);
  try {
    assert.equal((await app.post('/api/auth/release-username', { username: 'daksh' }, 'token-other')).status, 403);
    assert.ok(firestore.__peek('usernames', 'daksh'));

    const released = await app.post('/api/auth/release-username', { username: 'daksh' }, 'token-no-phone');
    assert.equal(released.status, 200);
    assert.deepEqual(released.body, { success: true, released: true });
    assert.equal(firestore.__peek('usernames', 'daksh'), undefined);
  } finally {
    await app.close();
  }
});

test('release refuses to free a username that already has a profile', async () => {
  const firestore = createFakeFirestore({
    usernames: { daksh: { uid: 'uid-1', username: 'daksh' } },
    users: { 'uid-1': { username: 'daksh' } }
  });
  const app = await withApp(firestore);
  try {
    const response = await app.post('/api/auth/release-username', { username: 'daksh' }, 'token-no-phone');
    assert.equal(response.status, 409);
    assert.ok(firestore.__peek('usernames', 'daksh'));
  } finally {
    await app.close();
  }
});

// ==========================================================================
// Region assignment (server-authoritative)
// ==========================================================================

test('region assignment requires authentication', async () => {
  const firestore = createFakeFirestore({ users: {}, phoneNumbers: {} });
  const app = await withApp(firestore);
  try {
    assert.equal((await app.post('/api/auth/assign-region', {}, undefined)).status, 401);
    assert.equal((await app.post('/api/auth/assign-region', {}, 'nope')).status, 401);
  } finally {
    await app.close();
  }
});

test('region assignment needs a supported phone number on the token', async () => {
  const firestore = createFakeFirestore({ users: { 'uid-1': { username: 'daksh' } }, phoneNumbers: {} });
  const app = await withApp(firestore);
  try {
    const response = await app.post('/api/auth/assign-region', {}, 'token-no-phone');
    assert.equal(response.status, 400);
    assert.equal(response.body.success, false);
    assert.equal(firestore.__peek('users', 'uid-1').phoneRegion, undefined);
  } finally {
    await app.close();
  }
});

test('region assignment ignores any client-supplied region', async () => {
  const firestore = createFakeFirestore({ users: {}, phoneNumbers: {} });
  const app = await withApp(firestore);
  try {
    const response = await app.post(
      '/api/auth/assign-region',
      { region: 'US', phoneRegion: 'US', phoneNumber: '+14155552671' },
      'token-in'
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.region, 'IN');
    assert.equal(firestore.__peek('users', 'uid-1').phoneRegion, 'IN');
    assert.equal(firestore.__peek('phoneNumbers', '+919876543210').uid, 'uid-1');
  } finally {
    await app.close();
  }
});

test('region assignment resolves every supported calling code', async () => {
  const cases = [
    ['token-in', 'IN'],
    ['token-np', 'NP']
  ];
  for (const [token, expected] of cases) {
    const firestore = createFakeFirestore({ users: {}, phoneNumbers: {} });
    const app = await withApp(firestore);
    try {
      const response = await app.post('/api/auth/assign-region', {}, token);
      assert.equal(response.body.region, expected);
    } finally {
      await app.close();
    }
  }
});

test('an established account region cannot be moved by another request', async () => {
  const firestore = createFakeFirestore({
    users: { 'uid-1': { username: 'daksh', phoneRegion: 'PK', phone: '+923012345678', phoneVerified: true } },
    phoneNumbers: {}
  });
  const app = await withApp(firestore);
  try {
    const response = await app.post('/api/auth/assign-region', {}, 'token-in');
    assert.equal(response.status, 409);
    assert.equal(response.body.success, false);
    assert.equal(firestore.__peek('users', 'uid-1').phoneRegion, 'PK');
  } finally {
    await app.close();
  }
});

test('re-assigning the same region is an idempotent success', async () => {
  const firestore = createFakeFirestore({
    users: { 'uid-1': { username: 'daksh', phoneRegion: 'IN', phone: '+919876543210', phoneVerified: true } },
    phoneNumbers: { '+919876543210': { uid: 'uid-1', region: 'IN', createdAt: 'ts' } }
  });
  const app = await withApp(firestore);
  try {
    const response = await app.post('/api/auth/assign-region', {}, 'token-in');
    assert.equal(response.status, 200);
    assert.equal(response.body.region, 'IN');
    assert.equal(firestore.__peek('phoneNumbers', '+919876543210').createdAt, 'ts');
  } finally {
    await app.close();
  }
});

test('a phone number already claimed by another account is rejected', async () => {
  const firestore = createFakeFirestore({
    users: {},
    phoneNumbers: { '+919876543210': { uid: 'uid-other', region: 'IN', createdAt: 'ts' } }
  });
  const app = await withApp(firestore);
  try {
    const response = await app.post('/api/auth/assign-region', {}, 'token-in');
    assert.equal(response.status, 409);
    assert.equal(firestore.__peek('users', 'uid-1'), undefined);
  } finally {
    await app.close();
  }
});

// ==========================================================================
// Phone/password login must not exist until a trusted factor exists
// ==========================================================================

test('no phone/password login endpoint is exposed', async () => {
  const firestore = createFakeFirestore({ users: {}, phoneNumbers: {} });
  const app = await withApp(firestore);
  try {
    for (const path of [
      '/api/auth/phone-login',
      '/api/auth/phone-password-login',
      '/api/auth/login-with-phone',
      '/api/auth/sign-in-with-phone'
    ]) {
      const response = await app.post(path, { phone: '+919876543210', password: 'secret' }, 'token-no-phone');
      assert.equal(response.status, 404, `${path} must not be routable`);
    }
  } finally {
    await app.close();
  }
});
