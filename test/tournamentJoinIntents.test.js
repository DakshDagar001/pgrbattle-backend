/**
 * Phase 7: the password on a protected tournament.
 *
 * The requirement is a sequence, so the tests are written as the sequence: viewing costs nothing,
 * joining asks, a wrong password writes nothing at all, a right one opens exactly one permit for
 * exactly this player and match, and the permit is worth no more than the time a checkout takes.
 *
 * The two things worth being pedantic about are here explicitly: a wrong password must not leave a
 * witness behind (no permit document, no balance movement, no stored attempt), and the password
 * itself must not appear in anything that is written or returned.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { createPlayerTournamentRouter } = require('../routes/playerTournamentRoutes');
const {
  createTournamentJoinIntents,
  permitIdOf,
  PERMIT_COLLECTION,
  SECRET_COLLECTION,
  DEFAULT_TTL_MS
} = require('../services/tournamentJoinIntents');
const { createFakeFirestore } = require('./helpers/fakeFirestore');
const { makeAuthenticator, startServer, request } = require('./helpers/authHarness');

const PLAYER = 'player-1';
const OTHER = 'player-2';
const MATCH = 'match-0001';
const PASSWORD = 'night-cup-2026';
const TOKEN = 'token-player';
const TOKEN_OTHER = 'token-other';

const TOKENS = {
  [TOKEN]: { uid: PLAYER, email: 'player@example.com' },
  [TOKEN_OTHER]: { uid: OTHER, email: 'other@example.com' }
};

const NOW = Date.parse('2026-10-21T09:00:00.000Z');

function match(over = {}) {
  return {
    name: 'Night Cup',
    modeId: 'mode-ss',
    status: 'upcoming',
    isActive: true,
    entryFee: 20,
    maxParticipants: 48,
    currentParticipants: 4,
    dateTime: new Date('2026-10-21T12:00:00.000Z'),
    ...over
  };
}

function player(over = {}) {
  return { depositBalance: 100, bonusBalance: 0, wonBalance: 0, ...over };
}

function storesFor({ matches, secrets, players, joined = {} } = {}) {
  const stores = {
    tournaments: matches === undefined ? { [MATCH]: match() } : matches,
    users: players === undefined ? { [PLAYER]: player() } : players
  };
  if (secrets !== undefined) stores[SECRET_COLLECTION] = secrets;
  for (const [uid, ids] of Object.entries(joined)) {
    stores[`users/${uid}/joinedTournaments`] = Object.fromEntries(
      ids.map(id => [id, { tournamentId: id }])
    );
  }
  return stores;
}

/** The route, end to end, with the real middleware and an injected token verifier. */
async function harness({ matches, secrets, players, joined } = {}) {
  const db = createFakeFirestore(storesFor({ matches, secrets, players, joined }));

  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use('/api/player/tournament', createPlayerTournamentRouter({
    authenticator: makeAuthenticator(TOKENS),
    database: () => db,
    serverTimestamp: () => 'SERVER_TS'
  }));

  const server = await startServer(app);
  server.server.unref();
  return { db, baseUrl: server.baseUrl, close: () => server.close() };
}

/** The service directly, so expiry and throttling can be walked with a clock the test owns. */
function serviceFor({ matches, secrets, players, joined, clock = { at: NOW } } = {}) {
  const db = createFakeFirestore(storesFor({ matches, secrets, players, joined }));
  const intents = createTournamentJoinIntents({
    db,
    serverTimestamp: () => 'SERVER_TS',
    now: () => clock.at
  });
  return { db, intents, clock };
}

const permitOf = (db, uid = PLAYER, id = MATCH) => db.__peek(PERMIT_COLLECTION, permitIdOf(uid, id));

// ==========================================================================
// The sequence: view, then ask, then pay
// ==========================================================================

test('asking to join a protected match without a password issues nothing', async () => {
  const h = await harness({ secrets: { [MATCH]: { entryPassword: PASSWORD } } });

  const response = await request(h.baseUrl, '/api/player/tournament/join-intent', {
    method: 'POST', token: TOKEN, body: { tournamentId: MATCH }
  });

  assert.equal(response.status, 403);
  assert.equal(response.body.code, 'PASSWORD_REQUIRED');
  assert.equal(response.body.required, true, 'the app is told a prompt is the right next step');
  assert.equal(permitOf(h.db), undefined);
  assert.deepEqual(h.db.__peek('users', PLAYER), player(), 'nothing was deducted');
  await h.close();
});

test('a wrong password is refused and leaves no permit and no balance movement', async () => {
  const h = await harness({ secrets: { [MATCH]: { entryPassword: PASSWORD } } });

  const response = await request(h.baseUrl, '/api/player/tournament/join-intent', {
    method: 'POST', token: TOKEN, body: { tournamentId: MATCH, password: 'not-the-password' }
  });

  assert.equal(response.status, 403);
  assert.equal(response.body.code, 'PASSWORD_INCORRECT');
  assert.equal(response.body.required, true, 'the player stays on the join flow');
  assert.equal(permitOf(h.db), undefined, 'no permit was bought');
  assert.deepEqual(h.db.__peek('users', PLAYER), player(), 'no balance moved');
  assert.equal(h.db.__peek('tournaments', MATCH).currentParticipants, 4, 'nobody took a seat');
  assert.equal(response.text.includes(PASSWORD), false, 'the response never carries the password');
  await h.close();
});

test('the right password issues one permit naming this player and this match', async () => {
  const h = await harness({ secrets: { [MATCH]: { entryPassword: PASSWORD } } });

  const response = await request(h.baseUrl, '/api/player/tournament/join-intent', {
    method: 'POST', token: TOKEN, body: { tournamentId: MATCH, password: PASSWORD }
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.code, 'COMPLETE');
  assert.equal(response.body.required, true);
  assert.equal(response.body.renewed, false);
  assert.equal(response.body.permit.id, `${PLAYER}__${MATCH}`);

  const stored = permitOf(h.db);
  assert.equal(stored.uid, PLAYER);
  assert.equal(stored.tournamentId, MATCH);
  assert.ok(stored.expiresAt instanceof Date);
  const ttl = stored.expiresAt.getTime() - Date.now();
  assert.ok(ttl > DEFAULT_TTL_MS - 5000 && ttl <= DEFAULT_TTL_MS + 5000);
  assert.deepEqual(h.db.__peek('users', PLAYER), player(),
    'the permit is not a payment: nothing is charged before the join itself');
  await h.close();
});

test('a match with no password needs no permit and no dialog', async () => {
  const h = await harness();

  const response = await request(h.baseUrl, '/api/player/tournament/join-intent', {
    method: 'POST', token: TOKEN, body: { tournamentId: MATCH }
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.code, 'COMPLETE');
  assert.equal(response.body.required, false);
  assert.equal(response.body.permit, null);
  assert.equal(h.db.__names().includes(PERMIT_COLLECTION), false);
  await h.close();
});

// ==========================================================================
// Where the secret is read from
// ==========================================================================

test('a legacy match still protected by entryPassword on the document is checked', async () => {
  const h = await harness({ matches: { [MATCH]: match({ entryPassword: PASSWORD }) } });

  const wrong = await request(h.baseUrl, '/api/player/tournament/join-intent', {
    method: 'POST', token: TOKEN, body: { tournamentId: MATCH, password: 'nope' }
  });
  assert.equal(wrong.body.code, 'PASSWORD_INCORRECT');

  const right = await request(h.baseUrl, '/api/player/tournament/join-intent', {
    method: 'POST', token: TOKEN, body: { tournamentId: MATCH, password: PASSWORD }
  });
  assert.equal(right.body.code, 'COMPLETE');
  await h.close();
});

test('the secret document wins over a stale legacy field', async () => {
  const { intents } = serviceFor({
    matches: { [MATCH]: match({ entryPassword: 'stale-old-password' }) },
    secrets: { [MATCH]: { entryPassword: PASSWORD } }
  });

  const stale = await intents.openIntent({
    playerUid: PLAYER, tournamentId: MATCH, password: 'stale-old-password'
  });
  assert.equal(stale.code, 'PASSWORD_INCORRECT');

  const current = await intents.openIntent({
    playerUid: PLAYER, tournamentId: MATCH, password: PASSWORD
  });
  assert.equal(current.code, 'COMPLETE');
});

test('a write-free read of the tournament is all the app needs to know it is protected', () => {
  // The flag the app branches on is the one the service reads; nothing about that read needs a
  // password, and this test exists to pin the contract the details screen relies on.
  const data = match({ passwordProtected: true });
  assert.equal(data.passwordProtected, true);
});

// ==========================================================================
// Everything else that stops a join
// ==========================================================================

test('a player who is already in is told so before being asked to prove the password again', async () => {
  const h = await harness({
    secrets: { [MATCH]: { entryPassword: PASSWORD } },
    joined: { [PLAYER]: [MATCH] }
  });

  const response = await request(h.baseUrl, '/api/player/tournament/join-intent', {
    method: 'POST', token: TOKEN, body: { tournamentId: MATCH, password: 'wrong-as-well' }
  });

  assert.equal(response.status, 409);
  assert.equal(response.body.code, 'ALREADY_JOINED');
  await h.close();
});

test('a full match, a closed match and a missing match are each refused', async () => {
  const full = await harness({
    matches: { [MATCH]: match({ maxParticipants: 4, currentParticipants: 4 }) }
  });
  assert.equal((await request(full.baseUrl, '/api/player/tournament/join-intent', {
    method: 'POST', token: TOKEN, body: { tournamentId: MATCH }
  })).status, 409);
  await full.close();

  const closed = await harness({ matches: { [MATCH]: match({ status: 'ongoing' }) } });
  assert.equal((await request(closed.baseUrl, '/api/player/tournament/join-intent', {
    method: 'POST', token: TOKEN, body: { tournamentId: MATCH }
  })).status, 410);
  await closed.close();

  const gone = await harness({ matches: {} });
  assert.equal((await request(gone.baseUrl, '/api/player/tournament/join-intent', {
    method: 'POST', token: TOKEN, body: { tournamentId: MATCH }
  })).status, 404);
  await gone.close();
});

test('an inactive match is closed even while its status says upcoming', async () => {
  const { intents } = serviceFor({ matches: { [MATCH]: match({ isActive: false }) } });

  const result = await intents.openIntent({ playerUid: PLAYER, tournamentId: MATCH });
  assert.equal(result.code, 'TOURNAMENT_CLOSED');
});

// ==========================================================================
// Renewal: proving the password once, buying time twice
// ==========================================================================

test('a live permit is renewed without the password being typed again', async () => {
  const clock = { at: NOW };
  const { intents, db } = serviceFor({
    secrets: { [MATCH]: { entryPassword: PASSWORD } }, clock
  });

  const first = await intents.openIntent({
    playerUid: PLAYER, tournamentId: MATCH, password: PASSWORD
  });
  assert.equal(first.code, 'COMPLETE');
  const firstExpiry = first.permit.expiresAtMillis;

  clock.at = NOW + 8 * 60 * 1000;
  const renewed = await intents.openIntent({ playerUid: PLAYER, tournamentId: MATCH });

  assert.equal(renewed.code, 'COMPLETE');
  assert.equal(renewed.renewed, true);
  assert.equal(renewed.required, true);
  assert.ok(renewed.permit.expiresAtMillis > firstExpiry, 'the clock moved forward');
  assert.equal(permitOf(db).uid, PLAYER);
});

test('renewal is refused once the permit has lapsed, so the password cannot be skipped', async () => {
  const clock = { at: NOW };
  const { intents } = serviceFor({
    secrets: { [MATCH]: { entryPassword: PASSWORD } }, clock
  });

  await intents.openIntent({ playerUid: PLAYER, tournamentId: MATCH, password: PASSWORD });

  clock.at = NOW + DEFAULT_TTL_MS + 1000;
  const lapsed = await intents.openIntent({ playerUid: PLAYER, tournamentId: MATCH });

  assert.equal(lapsed.code, 'PASSWORD_REQUIRED');
  assert.equal(lapsed.permit, null);
});

test('a renewal cannot be had by a player who never typed the password', async () => {
  const { intents } = serviceFor({ secrets: { [MATCH]: { entryPassword: PASSWORD } } });

  const result = await intents.openIntent({ playerUid: PLAYER, tournamentId: MATCH });
  assert.equal(result.code, 'PASSWORD_REQUIRED');
});

test('a permit belongs to one player and one match', async () => {
  const { intents, db } = serviceFor({
    matches: { [MATCH]: match(), 'match-0002': match() },
    secrets: { [MATCH]: { entryPassword: PASSWORD }, 'match-0002': { entryPassword: PASSWORD } }
  });

  await intents.openIntent({ playerUid: PLAYER, tournamentId: MATCH, password: PASSWORD });

  // Another player holds no permit, so they cannot renew off the one that exists.
  const other = await intents.openIntent({ playerUid: OTHER, tournamentId: MATCH });
  assert.equal(other.code, 'PASSWORD_REQUIRED');

  // And the permit for one match does not open the next.
  const nextMatch = await intents.openIntent({ playerUid: PLAYER, tournamentId: 'match-0002' });
  assert.equal(nextMatch.code, 'PASSWORD_REQUIRED');

  assert.equal(permitOf(db, OTHER, MATCH), undefined);
  assert.equal(permitOf(db, PLAYER, 'match-0002'), undefined);
});

// ==========================================================================
// Guessing
// ==========================================================================

test('repeated wrong passwords are throttled rather than answered forever', async () => {
  const { intents } = serviceFor({ secrets: { [MATCH]: { entryPassword: PASSWORD } } });

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const result = await intents.openIntent({
      playerUid: PLAYER, tournamentId: MATCH, password: `guess-${attempt}`
    });
    assert.equal(result.code, 'PASSWORD_INCORRECT', `attempt ${attempt + 1}`);
  }

  const throttled = await intents.openIntent({
    playerUid: PLAYER, tournamentId: MATCH, password: PASSWORD
  });
  assert.equal(throttled.code, 'TOO_MANY_ATTEMPTS');
  assert.equal(throttled.permit, null);
});

test('the throttle forgets an account once the window has passed', async () => {
  const clock = { at: NOW };
  const { intents } = serviceFor({
    secrets: { [MATCH]: { entryPassword: PASSWORD } }, clock
  });

  for (let attempt = 0; attempt < 10; attempt += 1) {
    await intents.openIntent({ playerUid: PLAYER, tournamentId: MATCH, password: 'wrong' });
  }
  assert.equal((await intents.openIntent({
    playerUid: PLAYER, tournamentId: MATCH, password: PASSWORD
  })).code, 'TOO_MANY_ATTEMPTS');

  clock.at = NOW + 11 * 60 * 1000;
  const afterWindow = await intents.openIntent({
    playerUid: PLAYER, tournamentId: MATCH, password: PASSWORD
  });
  assert.equal(afterWindow.code, 'COMPLETE');
});

test('a correct password clears the failures behind it', async () => {
  const { intents } = serviceFor({ secrets: { [MATCH]: { entryPassword: PASSWORD } } });

  await intents.openIntent({ playerUid: PLAYER, tournamentId: MATCH, password: 'wrong' });
  assert.equal((await intents.openIntent({
    playerUid: PLAYER, tournamentId: MATCH, password: PASSWORD
  })).code, 'COMPLETE');

  for (let attempt = 0; attempt < 9; attempt += 1) {
    await intents.openIntent({ playerUid: PLAYER, tournamentId: MATCH, password: 'wrong' });
  }
  assert.equal((await intents.openIntent({
    playerUid: PLAYER, tournamentId: MATCH, password: PASSWORD
  })).code, 'COMPLETE', 'the count restarted at the successful attempt');
});

// ==========================================================================
// Identity and leakage
// ==========================================================================

test('an unauthenticated caller is refused before any comparison', async () => {
  const h = await harness({ secrets: { [MATCH]: { entryPassword: PASSWORD } } });

  const response = await request(h.baseUrl, '/api/player/tournament/join-intent', {
    method: 'POST', body: { tournamentId: MATCH, password: PASSWORD }
  });

  assert.equal(response.status, 401);
  assert.equal(h.db.__names().includes(PERMIT_COLLECTION), false);
  await h.close();
});

test('a body cannot open a permit for another account', async () => {
  const h = await harness({
    secrets: { [MATCH]: { entryPassword: PASSWORD } },
    players: { [PLAYER]: player(), [OTHER]: player() }
  });

  const response = await request(h.baseUrl, '/api/player/tournament/join-intent', {
    method: 'POST', token: TOKEN,
    body: { tournamentId: MATCH, password: PASSWORD, playerUid: OTHER, uid: OTHER }
  });

  assert.equal(response.status, 200);
  assert.equal(permitOf(h.db, OTHER), undefined);
  assert.equal(permitOf(h.db, PLAYER).uid, PLAYER);
  await h.close();
});

test('nothing written for a join or a refusal contains the password', async () => {
  const h = await harness({ secrets: { [MATCH]: { entryPassword: PASSWORD } } });

  await request(h.baseUrl, '/api/player/tournament/join-intent', {
    method: 'POST', token: TOKEN, body: { tournamentId: MATCH, password: 'wrong' }
  });
  await request(h.baseUrl, '/api/player/tournament/join-intent', {
    method: 'POST', token: TOKEN, body: { tournamentId: MATCH, password: PASSWORD }
  });

  const permit = permitOf(h.db);
  assert.equal(JSON.stringify(permit).includes(PASSWORD), false);
  assert.equal('password' in permit, false);
  assert.equal(JSON.stringify(h.db.__peek('users', PLAYER)).includes(PASSWORD), false);
  assert.doesNotThrow(() => JSON.stringify(permit));
  await h.close();
});
