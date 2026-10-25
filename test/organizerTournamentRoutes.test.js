/**
 * Phase 6 and 7 over HTTP: the trusted create route.
 *
 * The service is tested against an in-memory Firestore; these tests are about the route, because
 * the route is where identity, the device header and the structured refusal are decided. The real
 * router is mounted on an ephemeral server with only the token verifier and the database injected,
 * so what runs here is the code Render will run.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const express = require('express');
const {
  CONFIG_COLLECTION,
  CONFIG_DOCUMENT
} = require('../services/organizerEconomy');
const { BINDINGS_COLLECTION } = require('../services/organizerDevices');
const { createOrganizerTournamentRouter } = require('../routes/organizerTournamentRoutes');
const { createFakeFirestore } = require('./helpers/fakeFirestore');
const { makeAuthenticator, startServer, request } = require('./helpers/authHarness');

const ORGANIZER = 'organizer-a';
const PLAYER = 'player-c';
const MODE = 'mode-ss';
const REQUEST = 'req-00000001';
const DEVICE = 'abcdef1234567890';
const OTHER_DEVICE = 'ffffffff00000000';

const TOKENS = {
  'token-organizer': { uid: ORGANIZER, email: 'org@example.com' },
  'token-player': { uid: PLAYER }
};

const SCHEDULED = '2026-10-21T12:00:00.000Z';

function account(over = {}) {
  return {
    uid: ORGANIZER, username: 'org_a', isActive: true, banned: false, regions: ['IN'],
    permissions: { perm_tournaments: true }, allowedModeIds: [], ...over
  };
}

function build({ accounts = { [ORGANIZER]: account() }, matches = {}, bindings = {},
  config = { defaultDailyTournamentLimit: 0 } } = {}) {
  const stores = {
    organizer_users: accounts,
    tournaments: matches,
    tournamentModes: {
      [MODE]: { name: 'Solo', modeName: 'Solo', region: 'IN', modeCode: '01', isActive: true }
    },
    tournament_counters: {},
    [BINDINGS_COLLECTION]: bindings,
    [CONFIG_COLLECTION]: { [CONFIG_DOCUMENT]: config }
  };
  const db = createFakeFirestore(stores);
  return { db };
}

async function harness(options = {}) {
  const { db } = build(options);
  const app = express();
  app.use(express.json());
  app.use('/api/organizer/tournaments', createOrganizerTournamentRouter({
    authenticator: makeAuthenticator(TOKENS),
    database: () => db,
    serverTimestamp: () => 'SERVER_TS'
  }));

  const server = await startServer(app);
  return { db, baseUrl: server.baseUrl, close: () => server.close() };
}

const body = (over = {}) => ({
  requestId: REQUEST,
  modeId: MODE,
  name: 'Night Cup',
  dateTime: SCHEDULED,
  type: 'solo',
  maxParticipants: 48,
  entryFee: 0,
  prizePool: 500,
  ...over
});

const create = (baseUrl, payload, token = 'token-organizer', headers = {}) =>
  request(baseUrl, '/api/organizer/tournaments', { method: 'POST', token, body: payload, headers });

// ==========================================================================
// Authentication and authorization
// ==========================================================================

test('the create route refuses an anonymous caller and a non-organizer', async () => {
  const context = await harness();
  try {
    const anonymous = await create(context.baseUrl, body(), null);
    assert.equal(anonymous.status, 401);

    const player = await create(context.baseUrl, body(), 'token-player');
    assert.equal(player.status, 403);
    assert.equal(player.body.code, 'NOT_AN_ORGANIZER');

    const unpermitted = await harness({ accounts: { [ORGANIZER]: account({ permissions: {} }) } });
    try {
      const refused = await create(unpermitted.baseUrl, body());
      assert.equal(refused.status, 403);
      assert.equal(refused.body.code, 'FORBIDDEN_PERMISSION');
      assert.equal(unpermitted.db.__peek('tournaments', REQUEST), undefined);
    } finally {
      await unpermitted.close();
    }
  } finally {
    await context.close();
  }
});

test('a successful create answers with the stored match and writes an audit row', async () => {
  const context = await harness();
  try {
    const response = await create(context.baseUrl, body());
    assert.equal(response.status, 201);
    assert.equal(response.body.success, true);
    assert.equal(response.body.tournamentId, REQUEST);
    assert.equal(response.body.tournament.matchCode, '1001101');
    assert.equal(response.body.tournament.region, 'IN');
    assert.equal(response.body.auditRecorded, true);

    const stored = context.db.__peek('tournaments', REQUEST);
    assert.equal(stored.createdByOrganizerUid, ORGANIZER);

    const rows = (await context.db.collection('transcripts/tournaments/entries').get()).docs
      .map(doc => doc.data());
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actionType, 'created');
    assert.equal(rows[0].performerId, ORGANIZER);
    assert.equal(rows[0].payload.tournamentId, REQUEST);
  } finally {
    await context.close();
  }
});

test('a retried submission answers 200 with the same match instead of creating another', async () => {
  const context = await harness();
  try {
    const first = await create(context.baseUrl, body());
    const again = await create(context.baseUrl, body());

    assert.equal(first.status, 201);
    assert.equal(again.status, 200);
    assert.equal(again.body.duplicate, true);
    assert.equal(context.db.__peek('tournament_counters', MODE).lastMatchNumber, 101);
  } finally {
    await context.close();
  }
});

// ==========================================================================
// Daily allowance
// ==========================================================================

test('the daily limit is answered as a structured 429 with the day and the numbers', async () => {
  const context = await harness({
    config: { defaultDailyTournamentLimit: 1 },
    matches: {
      existing: {
        modeId: MODE, name: 'Earlier', matchNumber: 101, dateTime: new Date(SCHEDULED),
        status: 'upcoming', isActive: true, createdByOrganizerUid: ORGANIZER
      }
    }
  });
  try {
    const response = await create(context.baseUrl, body());
    assert.equal(response.status, 429);
    assert.equal(response.body.code, 'DAILY_LIMIT_REACHED');
    assert.equal(response.body.limit.effectiveLimit, 1);
    assert.equal(response.body.limit.used, 1);
    assert.equal(response.body.limit.remaining, 0);
    assert.equal(response.body.limit.day, '2026-10-21');
    assert.equal(context.db.__peek('tournaments', REQUEST), undefined);
  } finally {
    await context.close();
  }
});

// ==========================================================================
// Device enforcement
// ==========================================================================

test('an organizer with no binding still creates, which is the legacy enrollment path', async () => {
  const context = await harness();
  try {
    const withoutHeader = await create(context.baseUrl, body());
    assert.equal(withoutHeader.status, 201);
  } finally {
    await context.close();
  }
});

test('an approved device creates, and a different device is refused before anything is written', async () => {
  const context = await harness({
    bindings: {
      [ORGANIZER]: { organizerUid: ORGANIZER, deviceId: DEVICE, boundAt: 'SEEDED_TS' }
    }
  });
  try {
    const wrong = await create(context.baseUrl, body(), 'token-organizer',
      { 'X-Device-Id': OTHER_DEVICE });
    assert.equal(wrong.status, 403);
    assert.equal(wrong.body.code, 'DEVICE_NOT_APPROVED');
    assert.equal(wrong.body.approvalRequired, true);
    assert.equal(context.db.__peek('tournaments', REQUEST), undefined);

    // Omitting the identifier is the other bypass, and it is refused too.
    const missing = await create(context.baseUrl, body());
    assert.equal(missing.status, 400);
    assert.equal(missing.body.code, 'DEVICE_ID_INVALID');
    assert.equal(context.db.__peek('tournaments', REQUEST), undefined);

    const approved = await create(context.baseUrl, body(), 'token-organizer',
      { 'X-Device-Id': DEVICE });
    assert.equal(approved.status, 201);
    assert.ok(context.db.__peek('tournaments', REQUEST));
  } finally {
    await context.close();
  }
});

test('a pending replacement device is told it is waiting, not that it is approved', async () => {
  const context = await harness({
    bindings: {
      [ORGANIZER]: { organizerUid: ORGANIZER, deviceId: DEVICE, boundAt: 'SEEDED_TS' }
    }
  });
  try {
    const response = await create(context.baseUrl, body(), 'token-organizer',
      { 'X-Device-Id': OTHER_DEVICE });
    assert.equal(response.status, 403);
    assert.equal(response.body.code, 'DEVICE_NOT_APPROVED');
    assert.match(response.body.message, /approved device|waiting/i);
  } finally {
    await context.close();
  }
});

// ==========================================================================
// Validation
// ==========================================================================

test('a malformed body is refused with the field that was wrong', async () => {
  const context = await harness();
  try {
    const noName = await create(context.baseUrl, body({ name: '' }));
    assert.equal(noName.status, 400);
    assert.equal(noName.body.code, 'INVALID_NAME');
    assert.equal(noName.body.field, 'name');

    const noDate = await create(context.baseUrl, body({ dateTime: 'tomorrow' }));
    assert.equal(noDate.status, 400);
    assert.equal(noDate.body.code, 'INVALID_DATE');

    const unknownStatus = await create(context.baseUrl, body({ status: 'completed' }));
    assert.equal(unknownStatus.status, 400);
    assert.equal(unknownStatus.body.code, 'INVALID_STATUS');

    assert.equal(context.db.__peek('tournaments', REQUEST), undefined);
  } finally {
    await context.close();
  }
});
