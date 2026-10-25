/**
 * Phase 6 + Phase 7: trusted tournament creation.
 *
 * These tests are about the two requirements a client-side write could never satisfy - the daily
 * allowance actually being refused, and the write being attributable to a verified organizer - and
 * about the fields the server derives rather than accepts (server, match number, match code,
 * creator). The day boundary is checked because "today" is the only policy that can silently
 * differ between two deployments.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createOrganizerEconomyService,
  CONFIG_COLLECTION,
  CONFIG_DOCUMENT
} = require('../services/organizerEconomy');
const {
  createOrganizerTournamentIntakeService,
  matchCodeFor,
  TALLY_COLLECTION
} = require('../services/organizerTournamentIntake');
const { createFakeFirestore } = require('./helpers/fakeFirestore');

const UID = 'organizer-a';
const OTHER = 'organizer-b';
const MODE = 'mode-ss';
const REQUEST = 'req-00000001';
const REQUEST_2 = 'req-00000002';

/** 12:00Z is 17:30 in the day boundary this project documents. */
const NOW = Date.parse('2026-10-21T09:00:00.000Z');
const SCHEDULED = '2026-10-21T12:00:00.000Z';

function account(over = {}) {
  return {
    uid: UID,
    username: 'org_a',
    isActive: true,
    banned: false,
    regions: ['IN'],
    permissions: { perm_tournaments: true },
    allowedModeIds: [],
    ...over
  };
}

function mode(over = {}) {
  return { name: 'Solo Showdown', modeName: 'Solo Showdown', region: 'IN', modeCode: '01',
    isActive: true, ...over };
}

/** A match as the organizer app would already have stored it. */
function existingMatch(id, over = {}) {
  return {
    id,
    modeId: MODE,
    name: 'Existing',
    matchNumber: 101,
    dateTime: new Date(SCHEDULED),
    status: 'upcoming',
    isActive: true,
    createdByOrganizerUid: UID,
    ...over
  };
}

function request(over = {}) {
  return {
    modeId: MODE,
    name: 'Night Cup',
    dateTime: SCHEDULED,
    type: 'solo',
    maxParticipants: 48,
    entryFee: 0,
    prizePool: 500,
    perKill: 5,
    ...over
  };
}

function build({ matches = {}, accounts, modes = { [MODE]: mode() }, config = {},
  serializable = false } = {}) {
  const stores = {
    tournaments: matches,
    organizer_users: accounts === undefined
      ? { [UID]: account(), [OTHER]: account({ uid: OTHER, username: 'org_b' }) }
      : accounts,
    tournamentModes: modes,
    tournament_counters: {}
  };
  if (config !== null) {
    stores[CONFIG_COLLECTION] = { [CONFIG_DOCUMENT]: { defaultDailyTournamentLimit: 0, ...config } };
  }

  const db = createFakeFirestore(stores, { serializable });
  const economy = createOrganizerEconomyService({ db, serverTimestamp: () => 'SERVER_TS' });
  const intake = createOrganizerTournamentIntakeService({
    db, economy, serverTimestamp: () => 'SERVER_TS', now: () => NOW
  });
  return { db, economy, intake };
}

const created = (db, id = REQUEST) => db.__peek('tournaments', id);
const counterOf = (db, modeId = MODE) => db.__peek('tournament_counters', modeId);

// ==========================================================================
// What the server derives
// ==========================================================================

test('a create stores the match with a server-allocated number, code and creator', async () => {
  const { db, intake } = build();

  const result = await intake.createTournament({
    organizerUid: UID, requestId: REQUEST, input: request()
  });

  assert.equal(result.code, 'COMPLETE');
  assert.equal(result.tournamentId, REQUEST);

  const stored = created(db);
  assert.equal(stored.matchNumber, 101);
  assert.equal(stored.matchCode, '1001101');
  assert.equal(stored.region, 'IN');
  assert.equal(stored.modeId, MODE);
  assert.equal(stored.modeName, 'Solo Showdown');
  assert.equal(stored.createdByOrganizerUid, UID);
  assert.equal(stored.assignedOrganizerUid, undefined, 'a create never pre-assigns');
  assert.equal(stored.currentParticipants, 0);
  assert.equal(counterOf(db).lastMatchNumber, 101);
});

test('a body cannot choose the server, the code or another organizer', async () => {
  const { db, intake } = build();

  const result = await intake.createTournament({
    organizerUid: UID,
    requestId: REQUEST,
    input: request({
      region: 'PK', matchCode: '2099999', matchNumber: 1, createdByOrganizerUid: OTHER,
      assignedOrganizerUid: OTHER
    })
  });

  assert.equal(result.code, 'COMPLETE');
  const stored = created(db);
  assert.equal(stored.region, 'IN', 'the mode decides the server');
  assert.equal(stored.matchCode, '1001101', 'the allocator decides the code');
  assert.equal(stored.matchNumber, 101);
  assert.equal(stored.createdByOrganizerUid, UID);
  assert.equal(stored.assignedOrganizerUid, undefined);
});

test('the second create on a mode continues the sequence', async () => {
  const { db, intake } = build();

  await intake.createTournament({ organizerUid: UID, requestId: REQUEST, input: request() });
  const second = await intake.createTournament({
    organizerUid: UID, requestId: REQUEST_2, input: request({ name: 'Second' })
  });

  assert.equal(second.code, 'COMPLETE');
  assert.equal(created(db, REQUEST_2).matchNumber, 102);
  assert.equal(created(db, REQUEST_2).matchCode, '1001102');
  assert.equal(counterOf(db).lastMatchNumber, 102);
});

test('match codes keep the prefix of the mode\'s own server', () => {
  assert.equal(matchCodeFor('IN', '01', 101), '1001101');
  assert.equal(matchCodeFor('PK', '07', 1001), '20071001');
  assert.equal(matchCodeFor('NP', '12', 5), '3012005');
  assert.equal(matchCodeFor('BD', '03', 999), '4003999');
});

// ==========================================================================
// Authorization
// ==========================================================================

test('only an active organizer with the tournaments module may create', async () => {
  const cases = [
    ['no account', {}, 'NOT_AN_ORGANIZER'],
    ['banned', { [UID]: account({ banned: true }) }, 'ORGANIZER_BANNED'],
    ['inactive', { [UID]: account({ isActive: false }) }, 'ORGANIZER_INACTIVE'],
    ['no permission', { [UID]: account({ permissions: {} }) }, 'FORBIDDEN_PERMISSION'],
    ['modes only', { [UID]: account({ permissions: { perm_modes: true } }) }, 'FORBIDDEN_PERMISSION']
  ];

  for (const [label, accounts, code] of cases) {
    const { db, intake } = build({ accounts });
    const result = await intake.createTournament({
      organizerUid: UID, requestId: REQUEST, input: request()
    });
    assert.equal(result.code, code, label);
    assert.equal(created(db), undefined, `${label} writes nothing`);
  }
});

test('a server the organizer was not granted and a mode outside the allowlist are refused', async () => {
  const outside = build({ accounts: { [UID]: account({ regions: ['PK'] }) } });
  const serverResult = await outside.intake.createTournament({
    organizerUid: UID, requestId: REQUEST, input: request()
  });
  assert.equal(serverResult.code, 'ORGANIZER_SERVER_FORBIDDEN');
  assert.equal(created(outside.db), undefined);

  const allowlisted = build({
    accounts: { [UID]: account({ allowedModeIds: ['mode-other'] }) }
  });
  const modeResult = await allowlisted.intake.createTournament({
    organizerUid: UID, requestId: REQUEST, input: request()
  });
  assert.equal(modeResult.code, 'ORGANIZER_MODE_FORBIDDEN');
  assert.equal(created(allowlisted.db), undefined);
});

test('a mode that is missing or has no code yet cannot host a match', async () => {
  const missing = build({ modes: {} });
  assert.equal((await missing.intake.createTournament({
    organizerUid: UID, requestId: REQUEST, input: request()
  })).code, 'MODE_NOT_FOUND');

  const uncoded = build({ modes: { [MODE]: mode({ modeCode: '' }) } });
  assert.equal((await uncoded.intake.createTournament({
    organizerUid: UID, requestId: REQUEST, input: request()
  })).code, 'MODE_CODE_MISSING');

  assert.equal(created(missing.db), undefined);
  assert.equal(created(uncoded.db), undefined);
});

// ==========================================================================
// Daily allowance
// ==========================================================================

test('the configured daily limit refuses a match past it and writes nothing', async () => {
  const { db, intake } = build({
    config: { defaultDailyTournamentLimit: 2 },
    matches: {
      a: existingMatch('a'),
      b: existingMatch('b', { matchNumber: 102, dateTime: new Date('2026-10-21T14:00:00.000Z') })
    }
  });

  const result = await intake.createTournament({
    organizerUid: UID, requestId: REQUEST, input: request()
  });

  assert.equal(result.code, 'DAILY_LIMIT_REACHED');
  assert.equal(result.limit.used, 2);
  assert.equal(result.limit.effectiveLimit, 2);
  assert.equal(result.limit.remaining, 0);
  assert.equal(result.limit.day, '2026-10-21');
  assert.equal(created(db), undefined, 'the refused create leaves no document');
  assert.equal(counterOf(db), undefined, 'and does not consume a match number');
});

test('a zero default means no limit was chosen, never zero matches allowed', async () => {
  const { db, intake } = build({
    config: { defaultDailyTournamentLimit: 0 },
    matches: { a: existingMatch('a'), b: existingMatch('b'), c: existingMatch('c') }
  });

  const result = await intake.createTournament({
    organizerUid: UID, requestId: REQUEST, input: request()
  });

  assert.equal(result.code, 'COMPLETE');
  assert.equal(result.limit.unlimited, true);
  assert.ok(created(db));
});

test('a per-organizer override wins over the default, in both directions', async () => {
  const raised = build({
    config: { defaultDailyTournamentLimit: 1 },
    accounts: { [UID]: account({ dailyTournamentLimitOverride: 3 }) },
    matches: { a: existingMatch('a') }
  });
  assert.equal((await raised.intake.createTournament({
    organizerUid: UID, requestId: REQUEST, input: request()
  })).code, 'COMPLETE');

  const lowered = build({
    config: { defaultDailyTournamentLimit: 10 },
    accounts: { [UID]: account({ dailyTournamentLimitOverride: 3 }) },
    matches: {
      a: existingMatch('a'), b: existingMatch('b'), c: existingMatch('c')
    }
  });
  const refused = await lowered.intake.createTournament({
    organizerUid: UID, requestId: REQUEST, input: request()
  });
  assert.equal(refused.code, 'DAILY_LIMIT_REACHED');
  assert.equal(refused.limit.effectiveLimit, 3);
});

test('cancelled, removed and inactive matches do not take a place in the day', async () => {
  const { intake } = build({
    config: { defaultDailyTournamentLimit: 2 },
    matches: {
      cancelled: existingMatch('cancelled', { status: 'cancelled', isActive: false }),
      removed: existingMatch('removed', { status: 'removed' }),
      inactive: existingMatch('inactive', { isActive: false }),
      mine: existingMatch('mine')
    }
  });

  const result = await intake.createTournament({
    organizerUid: UID, requestId: REQUEST, input: request()
  });
  assert.equal(result.code, 'COMPLETE');
  assert.equal(result.limit.used, 2, 'one real match plus the new one');
});

test('another organizer\'s match does not count, and the assignee counts for the assignee', async () => {
  const { intake } = build({
    config: { defaultDailyTournamentLimit: 1 },
    matches: {
      theirs: existingMatch('theirs', { createdByOrganizerUid: OTHER }),
      assigned: existingMatch('assigned', { createdByOrganizerUid: OTHER,
        assignedOrganizerUid: UID })
    }
  });

  const result = await intake.createTournament({
    organizerUid: UID, requestId: REQUEST, input: request()
  });
  assert.equal(result.code, 'DAILY_LIMIT_REACHED');
  assert.equal(result.limit.used, 1, 'only the match assigned to this organizer counts');
});

test('the day is the local day of the match at UTC+05:30, not the server\'s day', async () => {
  // 18:20Z is 23:50 IST on the 21st; 18:40Z is 00:10 IST on the 22nd. With a limit of one,
  // the second create is only allowed because it belongs to the next local day.
  const { db, intake } = build({ config: { defaultDailyTournamentLimit: 1 } });

  const late = await intake.createTournament({
    organizerUid: UID, requestId: REQUEST,
    input: request({ dateTime: '2026-10-21T18:20:00.000Z' })
  });
  assert.equal(late.code, 'COMPLETE');
  assert.equal(late.limit.day, '2026-10-21');

  const afterMidnight = await intake.createTournament({
    organizerUid: UID, requestId: REQUEST_2,
    input: request({ dateTime: '2026-10-21T18:40:00.000Z' })
  });
  assert.equal(afterMidnight.code, 'COMPLETE');
  assert.equal(afterMidnight.limit.day, '2026-10-22');

  assert.ok(created(db, REQUEST));
  assert.ok(created(db, REQUEST_2));
});

test('two simultaneous creates cannot both take the last place of the day', async () => {
  const { db, intake } = build({
    config: { defaultDailyTournamentLimit: 1 },
    serializable: true
  });

  const results = await Promise.all([
    intake.createTournament({ organizerUid: UID, requestId: REQUEST, input: request() }),
    intake.createTournament({ organizerUid: UID, requestId: REQUEST_2, input: request() })
  ]);

  const codes = results.map(result => result.code).sort();
  assert.deepEqual(codes, ['COMPLETE', 'DAILY_LIMIT_REACHED']);
  const stored = [db.__peek('tournaments', REQUEST), db.__peek('tournaments', REQUEST_2)]
    .filter(Boolean);
  assert.equal(stored.length, 1, 'exactly one match was written');
  assert.equal(counterOf(db).lastMatchNumber, 101, 'and only one number was spent');
});

// ==========================================================================
// Retries
// ==========================================================================

test('a retried submission returns the match that already exists instead of a second one', async () => {
  const { db, intake } = build();

  const first = await intake.createTournament({
    organizerUid: UID, requestId: REQUEST, input: request()
  });
  const again = await intake.createTournament({
    organizerUid: UID, requestId: REQUEST, input: request()
  });

  assert.equal(first.code, 'COMPLETE');
  assert.equal(first.duplicate, false);
  assert.equal(again.code, 'COMPLETE');
  assert.equal(again.duplicate, true);
  assert.equal(again.tournament.matchCode, '1001101');
  assert.equal(counterOf(db).lastMatchNumber, 101, 'a retry spends no second number');
});

test('a request id already used by another organizer is refused', async () => {
  const { intake } = build({
    matches: { [REQUEST]: existingMatch(REQUEST, { createdByOrganizerUid: OTHER }) }
  });

  const result = await intake.createTournament({
    organizerUid: UID, requestId: REQUEST, input: request()
  });
  assert.equal(result.code, 'REQUEST_ID_TAKEN');
});

test('a malformed request id and an unusable date are refused before anything is read', async () => {
  const { intake } = build();

  for (const requestId of ['', 'short', 'has spaces here', 'x'.repeat(80)]) {
    const result = await intake.createTournament({
      organizerUid: UID, requestId, input: request()
    });
    assert.equal(result.code, 'REQUEST_ID_INVALID', requestId);
  }

  for (const dateTime of [undefined, '', 'not a date', {}, null]) {
    const result = await intake.createTournament({
      organizerUid: UID, requestId: REQUEST, input: request({ dateTime })
    });
    assert.equal(result.code, 'INVALID_DATE', String(dateTime));
  }
});

test('a lock document records the pass, and a later create recounts from the matches', async () => {
  const { db, intake } = build({ config: { defaultDailyTournamentLimit: 3 } });

  await intake.createTournament({ organizerUid: UID, requestId: REQUEST, input: request() });
  await intake.createTournament({ organizerUid: UID, requestId: REQUEST_2, input: request() });

  const lock = db.__peek(TALLY_COLLECTION, `${UID}_2026-10-21`);
  assert.equal(lock.count, 2);
  assert.equal(lock.organizerUid, UID);
  assert.equal(lock.day, '2026-10-21');
});
