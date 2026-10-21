const test = require('node:test');
const assert = require('node:assert/strict');

const { createUsernameRegistry } = require('../services/usernameRegistry');
const { createFakeFirestore } = require('./helpers/fakeFirestore');

function buildRegistry(seed) {
  const db = createFakeFirestore(seed);
  const registry = createUsernameRegistry({ db, serverTimestamp: () => 'SERVER_TS' });
  return { db, registry };
}

test('availability reports a free username', async () => {
  const { registry } = buildRegistry({ usernames: {}, users: {} });
  assert.deepEqual(await registry.availability('daksh_2028'), {
    normalized: 'daksh_2028',
    available: true
  });
});

test('availability detects a reserved username in the registry', async () => {
  const { registry } = buildRegistry({
    usernames: { daksh: { uid: 'uid-1', username: 'daksh' } },
    users: {}
  });
  const result = await registry.availability('DAKSH');
  assert.equal(result.available, false);
  assert.equal(result.normalized, 'daksh');
});

test('availability detects a legacy profile without a registry document', async () => {
  const { registry } = buildRegistry({
    usernames: {},
    users: { 'uid-9': { username: 'oldplayer' } }
  });
  const result = await registry.availability('oldplayer');
  assert.equal(result.available, false, 'an account in users/ must never look available');
});

test('availability rejects malformed names instead of reporting them usable', async () => {
  const { registry } = buildRegistry({ usernames: {}, users: {} });
  await assert.rejects(() => registry.availability('ab'), /invalid/i);
  await assert.rejects(() => registry.availability('has space'), /invalid/i);
});

test('availability propagates infrastructure errors instead of returning available', async () => {
  const db = createFakeFirestore({});
  db.collection = () => {
    throw new Error('UNAVAILABLE: backend reachability');
  };
  const registry = createUsernameRegistry({ db, serverTimestamp: () => 'SERVER_TS' });
  await assert.rejects(() => registry.availability('daksh'), /backend reachability/);
});

test('claim reserves a username and stamps the owner', async () => {
  const { db, registry } = buildRegistry({ usernames: {}, users: {} });
  const claim = await registry.claim('uid-1', 'Daksh_2028');
  assert.equal(claim.ok, true);
  assert.equal(claim.normalized, 'daksh_2028');
  assert.deepEqual(db.__peek('usernames', 'daksh_2028'), {
    uid: 'uid-1',
    username: 'daksh_2028',
    claimedAt: 'SERVER_TS'
  });
});

test('claim refuses a name already owned by somebody else', async () => {
  const { registry } = buildRegistry({
    usernames: { daksh: { uid: 'uid-1', username: 'daksh' } },
    users: {}
  });
  const claim = await registry.claim('uid-2', 'daksh');
  assert.equal(claim.ok, false);
  assert.equal(claim.reason, 'TAKEN');
});

test('claim recognises an existing reservation by the same owner', async () => {
  const { registry } = buildRegistry({
    usernames: { daksh: { uid: 'uid-1', username: 'daksh' } },
    users: {}
  });
  const claim = await registry.claim('uid-1', 'daksh');
  assert.equal(claim.ok, false);
  assert.equal(claim.reason, 'OWNED');
});

test('concurrent claims of the same normalized username allow exactly one winner', async () => {
  const { db, registry } = buildRegistry({ usernames: {}, users: {} });

  const results = await Promise.all([
    registry.claim('uid-a', 'Pro_Player'),
    registry.claim('uid-b', 'pro_player'),
    registry.claim('uid-c', 'PRO_PLAYER')
  ]);

  const winners = results.filter(result => result.ok);
  assert.equal(winners.length, 1, `expected one winner, got ${JSON.stringify(results)}`);
  assert.deepEqual(
    results.filter(result => !result.ok).map(result => result.reason),
    ['TAKEN', 'TAKEN']
  );
  assert.equal(db.__peek('usernames', 'pro_player').uid, winners[0].uid);
});

test('a claim that lost the race is still rejected when the pre-check saw nothing', async () => {
  // The registry doc appears between the pre-check and create(), exactly as a
  // competing request would do. create() must still refuse the overwrite.
  const db = createFakeFirestore({ usernames: {}, users: {} });
  const realCollection = db.collection.bind(db);
  let injected = false;

  db.collection = name => {
    const collection = realCollection(name);
    if (name !== 'usernames') return collection;

    const patched = { ...collection };
    patched.doc = id => {
      const ref = { ...collection.doc(id) };
      const originalCreate = ref.create;
      ref.create = async data => {
        if (!injected) {
          injected = true;
          db.__seed('usernames', id, { uid: 'racer', username: id });
        }
        return originalCreate(data);
      };
      return ref;
    };
    return patched;
  };

  const registry = createUsernameRegistry({ db, serverTimestamp: () => 'SERVER_TS' });
  const claim = await registry.claim('uid-late', 'racer');
  assert.equal(claim.ok, false);
  assert.equal(claim.reason, 'TAKEN');
  assert.equal(db.__peek('usernames', 'racer').uid, 'racer');
});

test('release only removes an unowned reservation', async () => {
  const { db, registry } = buildRegistry({
    usernames: { daksh: { uid: 'uid-1', username: 'daksh' } },
    users: {}
  });

  assert.deepEqual(await registry.release('uid-2', 'daksh'), {
    ok: false,
    reason: 'NOT_OWNER',
    normalized: 'daksh'
  });
  assert.ok(db.__peek('usernames', 'daksh'), 'non-owner must not delete the reservation');

  const released = await registry.release('uid-1', 'daksh');
  assert.equal(released.ok, true);
  assert.equal(released.released, true);
  assert.equal(db.__peek('usernames', 'daksh'), undefined);
});

test('release refuses to free a username whose account already exists', async () => {
  const { db, registry } = buildRegistry({
    usernames: { daksh: { uid: 'uid-1', username: 'daksh' } },
    users: { 'uid-1': { username: 'daksh' } }
  });
  const result = await registry.release('uid-1', 'daksh');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'ACCOUNT_EXISTS');
  assert.ok(db.__peek('usernames', 'daksh'));
});
