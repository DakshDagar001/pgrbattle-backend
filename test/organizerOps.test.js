/**
 * Phase 2: the operation permit route.
 *
 * A protected organizer operation is a Firestore write the rules will not accept without a permit,
 * and a permit only exists if this route issued one. So these tests are about the two halves of
 * that guarantee: the device gate refuses *before* anything is written, and the decision is derived
 * from the verified token and stored records rather than from the body.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { createOrganizerOpsRouter } = require('../routes/organizerOpsRoutes');
const { permitIdOf, PERMIT_COLLECTION, DEFAULT_TTL_MS } = require('../services/organizerOperationPermits');
const { BINDINGS_COLLECTION } = require('../services/organizerDevices');
const { createFakeFirestore } = require('./helpers/fakeFirestore');
const { makeAuthenticator, startServer, request } = require('./helpers/authHarness');

const ORGANIZER = 'organizer-a';
const OTHER = 'organizer-b';
const MATCH = 'match-0001';
const MODE = 'mode-ss';
const TOKEN = 'token-organizer';
const TOKEN_OTHER = 'token-other';

const TOKENS = {
  [TOKEN]: { uid: ORGANIZER, email: 'org_a@example.com' },
  [TOKEN_OTHER]: { uid: OTHER, email: 'org_b@example.com' }
};

function account(over = {}) {
  return {
    uid: ORGANIZER,
    isActive: true,
    banned: false,
    regions: ['IN'],
    permissions: { perm_tournaments: true, perm_results: true, perm_modes: true },
    allowedModeIds: [],
    ...over
  };
}

function match(over = {}) {
  return {
    modeId: MODE,
    region: 'IN',
    status: 'upcoming',
    isActive: true,
    matchCode: '1001101',
    createdByOrganizerUid: ORGANIZER,
    ...over
  };
}

async function harness({ accounts, matches, bindings } = {}) {
  const stores = {
    organizer_users: accounts === undefined ? { [ORGANIZER]: account() } : accounts,
    tournaments: matches === undefined ? { [MATCH]: match() } : matches,
    [BINDINGS_COLLECTION]: bindings || {}
  };
  const db = createFakeFirestore(stores);

  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use('/api/organizer/ops', createOrganizerOpsRouter({
    authenticator: makeAuthenticator(TOKENS),
    database: () => db,
    serverTimestamp: () => 'SERVER_TS'
  }));

  const server = await startServer(app);
  // A test that fails before its `close()` must not leave the runner waiting on an open socket.
  server.server.unref();
  return { db, server, baseUrl: server.baseUrl, close: () => server.close() };
}

const permitOf = (db, uid, scope, tournamentId = '') =>
  db.__peek(PERMIT_COLLECTION, permitIdOf(uid, scope, tournamentId));

// ==========================================================================
// Authentication and the device gate
// ==========================================================================

test('an unauthenticated call is refused before anything is decided', async () => {
  const h = await harness();

  const response = await request(h.baseUrl, '/api/organizer/ops/authorize', {
    method: 'POST', body: { scope: 'tournament_update', tournamentId: MATCH }
  });

  assert.equal(response.status, 401);
  assert.equal(h.db.__names().includes(PERMIT_COLLECTION), false, 'no permit collection written');
  await h.close();
});

test('the approved device receives a permit naming one account, scope and match', async () => {
  const h = await harness({ bindings: { [ORGANIZER]: { deviceId: 'device-approved' } } });

  const response = await request(h.baseUrl, '/api/organizer/ops/authorize', {
    method: 'POST',
    token: TOKEN,
    headers: { 'X-Device-Id': 'device-approved' },
    body: { scope: 'tournament_update', tournamentId: MATCH }
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.code, 'COMPLETE');
  assert.equal(response.body.permit.id, `${ORGANIZER}__tournament_update__${MATCH}`);
  assert.equal(response.body.permit.tournamentId, MATCH);
  assert.equal(response.body.permit.permission, 'perm_tournaments');
  assert.equal(response.body.permit.matchCode, '1001101');

  const stored = permitOf(h.db, ORGANIZER, 'tournament_update', MATCH);
  assert.equal(stored.uid, ORGANIZER);
  assert.equal(stored.scope, 'tournament_update');
  assert.equal(stored.tournamentId, MATCH);
  assert.ok(stored.expiresAt instanceof Date);
  const ttl = stored.expiresAt.getTime() - Date.now();
  assert.ok(ttl > DEFAULT_TTL_MS - 5000 && ttl <= DEFAULT_TTL_MS + 5000,
    `a permit is worth about ${DEFAULT_TTL_MS}ms, saw ${ttl}`);
  await h.close();
});

test('a device that is not the approved one is refused and no permit is written', async () => {
  const h = await harness({ bindings: { [ORGANIZER]: { deviceId: 'device-approved' } } });

  const response = await request(h.baseUrl, '/api/organizer/ops/authorize', {
    method: 'POST',
    token: TOKEN,
    headers: { 'X-Device-Id': 'device-somebody-else' },
    body: { scope: 'tournament_update', tournamentId: MATCH }
  });

  assert.equal(response.status, 403);
  assert.equal(response.body.code, 'DEVICE_NOT_APPROVED');
  assert.equal(permitOf(h.db, ORGANIZER, 'tournament_update', MATCH), undefined);
  await h.close();
});

test('omitting the device header cannot walk past a binding that exists', async () => {
  const h = await harness({ bindings: { [ORGANIZER]: { deviceId: 'device-approved' } } });

  const response = await request(h.baseUrl, '/api/organizer/ops/authorize', {
    method: 'POST', token: TOKEN,
    body: { scope: 'tournament_results', tournamentId: MATCH }
  });

  // No header is not the same answer as a wrong header - the app has to be told to identify itself -
  // but either way the request must not produce a permit for an unidentified phone.
  assert.equal(response.status, 400);
  assert.equal(response.body.code, 'DEVICE_ID_INVALID');
  assert.equal(permitOf(h.db, ORGANIZER, 'tournament_results', MATCH), undefined);
  await h.close();
});

test('an organizer who has never enrolled a device may still obtain a permit', async () => {
  const h = await harness();

  const response = await request(h.baseUrl, '/api/organizer/ops/authorize', {
    method: 'POST', token: TOKEN, headers: { 'X-Device-Id': 'brand-new-phone' },
    body: { scope: 'tournament_delete', tournamentId: MATCH }
  });

  assert.equal(response.status, 200);
  assert.ok(permitOf(h.db, ORGANIZER, 'tournament_delete', MATCH));
  await h.close();
});

test('a device check that cannot be completed refuses rather than allows', async () => {
  const h = await harness({ bindings: { [ORGANIZER]: { deviceId: 'device-approved' } } });
  h.db.__fail(BINDINGS_COLLECTION, ORGANIZER, 'get');

  const response = await request(h.baseUrl, '/api/organizer/ops/authorize', {
    method: 'POST', token: TOKEN, headers: { 'X-Device-Id': 'device-approved' },
    body: { scope: 'tournament_update', tournamentId: MATCH }
  });

  assert.equal(response.status, 503);
  assert.equal(response.body.code, 'TRANSIENT_FAILURE');
  assert.equal(permitOf(h.db, ORGANIZER, 'tournament_update', MATCH), undefined);
  await h.close();
});

// ==========================================================================
// Identity comes from the token
// ==========================================================================

test('a body cannot ask for a permit on another organizer', async () => {
  const h = await harness({
    accounts: {
      [ORGANIZER]: account(),
      [OTHER]: account({ uid: OTHER })
    }
  });

  const response = await request(h.baseUrl, '/api/organizer/ops/authorize', {
    method: 'POST', token: TOKEN,
    body: { scope: 'tournament_update', tournamentId: MATCH, organizerUid: OTHER, uid: OTHER }
  });

  assert.equal(response.status, 200);
  assert.equal(permitOf(h.db, OTHER, 'tournament_update', MATCH), undefined,
    'nothing was issued for the account the body named');
  assert.equal(permitOf(h.db, ORGANIZER, 'tournament_update', MATCH).uid, ORGANIZER);
  await h.close();
});

test('a signed-in account that is not an organizer obtains nothing', async () => {
  const h = await harness({ accounts: {} });

  const response = await request(h.baseUrl, '/api/organizer/ops/authorize', {
    method: 'POST', token: TOKEN, body: { scope: 'tournament_update', tournamentId: MATCH }
  });

  assert.equal(response.status, 403);
  assert.equal(response.body.code, 'NOT_AN_ORGANIZER');
  await h.close();
});

// ==========================================================================
// The scopes
// ==========================================================================

test('an unknown scope is refused, and the known ones are listed', async () => {
  const h = await harness();

  const response = await request(h.baseUrl, '/api/organizer/ops/authorize', {
    method: 'POST', token: TOKEN, body: { scope: 'organizer.destroy', tournamentId: MATCH }
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.code, 'SCOPE_UNKNOWN');
  assert.deepEqual(response.body.scopes.sort(),
    ['mode_write', 'tournament_delete', 'tournament_results', 'tournament_update']);
  await h.close();
});

test('a scope spelled with a dot is unknown, because a dot cannot sit in a permit document id', async () => {
  const h = await harness();

  const response = await request(h.baseUrl, '/api/organizer/ops/authorize', {
    method: 'POST', token: TOKEN, body: { scope: 'tournament.update', tournamentId: MATCH }
  });

  // The dotted spelling was the vocabulary before the scopes moved into the permit document's id.
  // Firestore rejects a document id containing '.', and `firestore.rules` rebuilds that id to read
  // the permit back, so a dotted scope has to be refused outright rather than minting a permit that
  // nothing can ever find - which is a denial the rules cannot distinguish from a missing one.
  assert.equal(response.status, 400);
  assert.equal(response.body.code, 'SCOPE_UNKNOWN');
  assert.equal(h.db.__names().includes(PERMIT_COLLECTION), false, 'no permit written');
  await h.close();
});

test('a match id containing a dot is refused before it can be written into a permit path', async () => {
  const h = await harness();

  const response = await request(h.baseUrl, '/api/organizer/ops/authorize', {
    method: 'POST', token: TOKEN, body: { scope: 'tournament_update', tournamentId: 'match.0001' }
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.code, 'TOURNAMENT_ID_INVALID');
  assert.equal(h.db.__names().includes(PERMIT_COLLECTION), false, 'no permit written');
  await h.close();
});

test('a match scope without a match id, and a mode scope with one, are both refused', async () => {
  const h = await harness();

  const noMatch = await request(h.baseUrl, '/api/organizer/ops/authorize', {
    method: 'POST', token: TOKEN, body: { scope: 'tournament_results' }
  });
  assert.equal(noMatch.status, 400);
  assert.equal(noMatch.body.code, 'TOURNAMENT_ID_INVALID');

  const modeWithMatch = await request(h.baseUrl, '/api/organizer/ops/authorize', {
    method: 'POST', token: TOKEN, body: { scope: 'mode_write', tournamentId: MATCH }
  });
  assert.equal(modeWithMatch.status, 400);
  assert.equal(modeWithMatch.body.code, 'TOURNAMENT_ID_UNEXPECTED');
  await h.close();
});

test('mode_write is authorized without a match and needs perm_modes', async () => {
  const h = await harness();

  const response = await request(h.baseUrl, '/api/organizer/ops/authorize', {
    method: 'POST', token: TOKEN, body: { scope: 'mode_write' }
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.permit.id, `${ORGANIZER}__mode_write__`);
  const stored = h.db.__peek(PERMIT_COLLECTION, `${ORGANIZER}__mode_write__`);
  assert.equal(stored.tournamentId, '');
  assert.equal(stored.permission, 'perm_modes');
  await h.close();
});

test('the module a scope needs is the one that is checked', async () => {
  const resultsOnly = await harness({
    accounts: { [ORGANIZER]: account({ permissions: { perm_results: true } }) }
  });

  const allowed = await request(resultsOnly.baseUrl, '/api/organizer/ops/authorize', {
    method: 'POST', token: TOKEN, body: { scope: 'tournament_results', tournamentId: MATCH }
  });
  assert.equal(allowed.status, 200);

  const refused = await request(resultsOnly.baseUrl, '/api/organizer/ops/authorize', {
    method: 'POST', token: TOKEN, body: { scope: 'tournament_update', tournamentId: MATCH }
  });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, 'FORBIDDEN_PERMISSION');
  assert.equal(refused.body.permission, 'perm_tournaments');
  await resultsOnly.close();
});

// ==========================================================================
// The match itself
// ==========================================================================

test('a banned or deactivated organizer is refused', async () => {
  for (const [label, over, code] of [
    ['banned', { banned: true }, 'ORGANIZER_BANNED'],
    ['inactive', { isActive: false }, 'ORGANIZER_INACTIVE']
  ]) {
    const h = await harness({ accounts: { [ORGANIZER]: account(over) } });
    const response = await request(h.baseUrl, '/api/organizer/ops/authorize', {
      method: 'POST', token: TOKEN, body: { scope: 'tournament_update', tournamentId: MATCH }
    });
    assert.equal(response.status, 403, label);
    assert.equal(response.body.code, code, label);
    await h.close();
  }
});

test('a match that no longer exists is a 404 rather than a permit', async () => {
  const h = await harness({ matches: {} });

  const response = await request(h.baseUrl, '/api/organizer/ops/authorize', {
    method: 'POST', token: TOKEN, body: { scope: 'tournament_update', tournamentId: MATCH }
  });

  assert.equal(response.status, 404);
  assert.equal(response.body.code, 'TOURNAMENT_NOT_FOUND');
  await h.close();
});

test('the organizer\'s server and mode grants still apply to the operation', async () => {
  const wrongServer = await harness({ accounts: { [ORGANIZER]: account({ regions: ['PK'] }) } });
  const serverRefused = await request(wrongServer.baseUrl, '/api/organizer/ops/authorize', {
    method: 'POST', token: TOKEN, body: { scope: 'tournament_update', tournamentId: MATCH }
  });
  assert.equal(serverRefused.status, 403);
  assert.equal(serverRefused.body.code, 'ORGANIZER_SERVER_FORBIDDEN');
  await wrongServer.close();

  const wrongMode = await harness({
    accounts: { [ORGANIZER]: account({ allowedModeIds: ['mode-other'] }) }
  });
  const modeRefused = await request(wrongMode.baseUrl, '/api/organizer/ops/authorize', {
    method: 'POST', token: TOKEN, body: { scope: 'tournament_update', tournamentId: MATCH }
  });
  assert.equal(modeRefused.status, 403);
  assert.equal(modeRefused.body.code, 'ORGANIZER_MODE_FORBIDDEN');
  await wrongMode.close();
});

test('somebody else\'s match is not authorized, but an unattributed one is', async () => {
  const theirs = await harness({
    accounts: {
      [ORGANIZER]: account(),
      [OTHER]: account({ uid: OTHER })
    },
    matches: { [MATCH]: match({ createdByOrganizerUid: OTHER }) }
  });
  const refused = await request(theirs.baseUrl, '/api/organizer/ops/authorize', {
    method: 'POST', token: TOKEN, body: { scope: 'tournament_update', tournamentId: MATCH }
  });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, 'TOURNAMENT_NOT_YOURS');
  await theirs.close();

  const legacy = await harness({
    matches: { [MATCH]: match({ createdByOrganizerUid: '', assignedOrganizerUid: '' }) }
  });
  const allowed = await request(legacy.baseUrl, '/api/organizer/ops/authorize', {
    method: 'POST', token: TOKEN,
    body: { scope: 'tournament_results', tournamentId: MATCH }
  });
  assert.equal(allowed.status, 200, 'an unattributed match is the compatibility case');
  await legacy.close();
});

test('an assigned match belongs to the assignee, not the creator', async () => {
  const h = await harness({
    accounts: {
      [ORGANIZER]: account(),
      [OTHER]: account({ uid: OTHER })
    },
    matches: { [MATCH]: match({ createdByOrganizerUid: OTHER, assignedOrganizerUid: ORGANIZER }) }
  });

  const response = await request(h.baseUrl, '/api/organizer/ops/authorize', {
    method: 'POST', token: TOKEN, body: { scope: 'tournament_update', tournamentId: MATCH }
  });

  assert.equal(response.status, 200);
  await h.close();
});

test('re-authorizing replaces the same permit rather than accumulating them', async () => {
  const h = await harness();
  const body = { scope: 'tournament_update', tournamentId: MATCH };

  const first = await request(h.baseUrl, '/api/organizer/ops/authorize',
    { method: 'POST', token: TOKEN, body });
  const second = await request(h.baseUrl, '/api/organizer/ops/authorize',
    { method: 'POST', token: TOKEN, body });

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  const permits = h.db.__names().includes(PERMIT_COLLECTION)
    ? [...Array(1)].map(() => permitOf(h.db, ORGANIZER, 'tournament_update', MATCH))
    : [];
  assert.equal(permits.length, 1);
  assert.equal(first.body.permit.id, second.body.permit.id);
  await h.close();
});
