/**
 * Phase 6: reassigning a match to an organizer, on the trusted side.
 *
 * Assignment is the other moment a match becomes somebody's responsibility, so it is counted the
 * same way creation is counted - same day boundary, same attribution, same override, same mutex
 * document. These tests are therefore mostly about *agreement*: that an assignment cannot slip a
 * match past the allowance a create would have refused, that a create and an assignment racing for
 * the last place cannot both win, and that the recovery paths (clearing, cancelling) still work.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createOrganizerEconomyService,
  CONFIG_COLLECTION,
  CONFIG_DOCUMENT
} = require('../services/organizerEconomy');
const { createOrganizerAssignments } = require('../services/organizerAssignments');
const {
  createOrganizerTournamentIntakeService
} = require('../services/organizerTournamentIntake');
const { createFakeFirestore } = require('./helpers/fakeFirestore');

const UID = 'organizer-a';
const OTHER = 'organizer-b';
const MODE = 'mode-ss';
const MATCH = 'match-0001';
const MATCH_2 = 'match-0002';
const MATCH_3 = 'match-0003';
const ADMIN = 'admin-uid-1';

/** 12:00Z is 17:30 on 2026-10-21 at UTC+05:30. */
const NOW = Date.parse('2026-10-21T09:00:00.000Z');
const SCHEDULED = '2026-10-21T12:00:00.000Z';
const EARLIER_SAME_DAY = '2026-10-21T02:00:00.000Z';
/** Exactly the first instant of 2026-10-21 local; one minute earlier is the previous day. */
const DAY_START = '2026-10-20T18:30:00.000Z';
const JUST_BEFORE_DAY_START = '2026-10-20T18:29:00.000Z';

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

function match(over = {}) {
  return {
    modeId: MODE,
    name: 'Night Cup',
    matchNumber: 101,
    dateTime: new Date(SCHEDULED),
    status: 'upcoming',
    isActive: true,
    region: 'IN',
    createdByOrganizerUid: UID,
    ...over
  };
}

function fakeAudit() {
  const rows = [];
  return {
    rows,
    async record(entry) {
      rows.push(entry);
      return { recorded: true, id: `audit-${rows.length}` };
    }
  };
}

function build({ matches = {}, accounts, config = {}, serializable = false, audit = null } = {}) {
  const stores = { tournaments: matches };
  stores.organizer_users = accounts === undefined
    ? { [UID]: account(), [OTHER]: account({ uid: OTHER, username: 'org_b' }) }
    : accounts;
  stores[CONFIG_COLLECTION] = { [CONFIG_DOCUMENT]: { defaultDailyTournamentLimit: 0, ...config } };
  // Only the cross-service race needs a mode: the assignment path never reads one.
  stores.tournamentModes = {
    [MODE]: { name: 'Solo Showdown', modeName: 'Solo Showdown', region: 'IN', modeCode: '01' }
  };

  const db = createFakeFirestore(stores, { serializable });
  const economy = createOrganizerEconomyService({ db, serverTimestamp: () => 'SERVER_TS' });
  const assignments = createOrganizerAssignments({
    db, economy, audit, serverTimestamp: () => 'SERVER_TS', now: () => NOW
  });
  return { db, economy, assignments, audit };
}

const stored = (db, id = MATCH) => db.__peek('tournaments', id);

// ==========================================================================
// The assignment itself
// ==========================================================================

test('an assignment names the organizer and the admin who decided it', async () => {
  const audit = fakeAudit();
  const { db, assignments } = build({
    matches: { [MATCH]: match() }, config: { defaultDailyTournamentLimit: 5 }, audit
  });

  const result = await assignments.assign({
    tournamentId: MATCH, organizerUid: OTHER, adminUid: ADMIN, adminEmail: 'a@example.com'
  });

  assert.equal(result.code, 'COMPLETE');
  assert.equal(result.applied, true);
  assert.equal(result.previousAssignee, null);
  assert.equal(result.overridden, false);
  assert.equal(stored(db).assignedOrganizerUid, OTHER);
  assert.equal(stored(db).assignedByUid, ADMIN);
  assert.equal(result.auditRecorded, true);
  assert.equal(audit.rows.length, 1);
  assert.equal(audit.rows[0].actionType, 'organizer_assigned');
  assert.equal(audit.rows[0].performerId, ADMIN);
  assert.equal(audit.rows[0].payload.tournamentId, MATCH);
  assert.equal(audit.rows[0].payload.organizerUid, OTHER);
  assert.equal(audit.rows[0].payload.dailyLimitEffective, 5);
});

test('the same organizer assigned twice is a recorded no-op, not a second counting', async () => {
  const audit = fakeAudit();
  const { db, assignments } = build({
    matches: { [MATCH]: match({ assignedOrganizerUid: OTHER }) }, audit
  });

  const result = await assignments.assign({ tournamentId: MATCH, organizerUid: OTHER });

  assert.equal(result.code, 'COMPLETE');
  assert.equal(result.applied, false);
  assert.equal(result.unchanged, true);
  assert.ok(!db.__peek('organizer_daily_locks', `${OTHER}_2026-10-21`),
    'nothing new took a place');
  assert.equal(audit.rows[0].payload.unchanged, true);
});

test('a missing match and a missing schedule are refused', async () => {
  const { assignments } = build();

  const gone = await assignments.assign({ tournamentId: MATCH, organizerUid: OTHER });
  assert.equal(gone.code, 'TOURNAMENT_NOT_FOUND');

  const undated = build({ matches: { [MATCH]: match({ dateTime: undefined }) } });
  const noSchedule = await undated.assignments.assign({
    tournamentId: MATCH, organizerUid: OTHER
  });
  assert.equal(noSchedule.code, 'SCHEDULE_MISSING');
});

// ==========================================================================
// Who may be given a match
// ==========================================================================

test('the target must be an active organizer holding the tournaments module', async () => {
  const cases = [
    ['unknown account', {}, 'NOT_AN_ORGANIZER'],
    ['banned', { [OTHER]: account({ uid: OTHER, banned: true }) }, 'ORGANIZER_BANNED'],
    ['inactive', { [OTHER]: account({ uid: OTHER, isActive: false }) }, 'ORGANIZER_INACTIVE'],
    ['no module', { [OTHER]: account({ uid: OTHER, permissions: {} }) }, 'FORBIDDEN_PERMISSION']
  ];

  for (const [label, accounts, code] of cases) {
    const { db, assignments } = build({ matches: { [MATCH]: match() }, accounts });
    const result = await assignments.assign({ tournamentId: MATCH, organizerUid: OTHER });
    assert.equal(result.code, code, label);
    assert.equal(stored(db).assignedOrganizerUid, undefined, `${label} writes nothing`);
  }
});

test('the server and the mode allowlist still apply to the receiving organizer', async () => {
  const wrongServer = build({
    matches: { [MATCH]: match() },
    accounts: { [OTHER]: account({ uid: OTHER, regions: ['PK'] }) }
  });
  assert.equal(
    (await wrongServer.assignments.assign({ tournamentId: MATCH, organizerUid: OTHER })).code,
    'ORGANIZER_SERVER_FORBIDDEN'
  );

  const wrongMode = build({
    matches: { [MATCH]: match() },
    accounts: { [OTHER]: account({ uid: OTHER, allowedModeIds: ['mode-other'] }) }
  });
  assert.equal(
    (await wrongMode.assignments.assign({ tournamentId: MATCH, organizerUid: OTHER })).code,
    'ORGANIZER_MODE_FORBIDDEN'
  );
});

// ==========================================================================
// The daily allowance
// ==========================================================================

test('an assignment that would exceed the day is refused and reports the day', async () => {
  const { db, assignments } = build({
    matches: { [MATCH]: match({ createdByOrganizerUid: OTHER }), [MATCH_2]: match() },
    config: { defaultDailyTournamentLimit: 1 }
  });

  const result = await assignments.assign({ tournamentId: MATCH_2, organizerUid: OTHER });

  assert.equal(result.code, 'DAILY_LIMIT_REACHED');
  assert.equal(result.limit.used, 1);
  assert.equal(result.limit.effectiveLimit, 1);
  assert.equal(result.limit.day, '2026-10-21');
  assert.equal(result.limit.offsetMinutes, 330);
  assert.equal(result.overrideAvailable, true);
  assert.equal(stored(db, MATCH_2).assignedOrganizerUid, undefined);
});

test('a deliberate admin override is applied and recorded as an override', async () => {
  const audit = fakeAudit();
  const { db, assignments } = build({
    matches: { [MATCH]: match({ createdByOrganizerUid: OTHER }), [MATCH_2]: match() },
    config: { defaultDailyTournamentLimit: 1 },
    audit
  });

  const result = await assignments.assign({
    tournamentId: MATCH_2, organizerUid: OTHER, adminUid: ADMIN, override: true,
    reason: 'organizer was on leave yesterday'
  });

  assert.equal(result.code, 'COMPLETE');
  assert.equal(result.overridden, true);
  assert.equal(stored(db, MATCH_2).assignedOrganizerUid, OTHER);
  assert.equal(audit.rows[0].actionType, 'organizer_assignment_override');
  assert.equal(audit.rows[0].payload.overridden, true);
  assert.equal(audit.rows[0].payload.reason, 'organizer was on leave yesterday');
});

test('the per-organizer override replaces the default, and 0 still means unlimited', async () => {
  const own = build({
    matches: { [MATCH]: match({ createdByOrganizerUid: OTHER }), [MATCH_2]: match() },
    accounts: { [OTHER]: account({ uid: OTHER, dailyTournamentLimitOverride: 3 }) },
    config: { defaultDailyTournamentLimit: 1 }
  });
  assert.equal(
    (await own.assignments.assign({ tournamentId: MATCH_2, organizerUid: OTHER })).code,
    'COMPLETE'
  );

  const unlimited = build({
    matches: {
      [MATCH]: match({ createdByOrganizerUid: OTHER }),
      [MATCH_2]: match(),
      [MATCH_3]: match()
    },
    config: { defaultDailyTournamentLimit: 0 }
  });
  const result = await unlimited.assignments.assign({
    tournamentId: MATCH_3, organizerUid: OTHER
  });
  assert.equal(result.code, 'COMPLETE');
  assert.equal(result.limit.unlimited, true);
});

test('a cancelled or removed match costs nothing to hand over, even on a full day', async () => {
  const { assignments } = build({
    matches: {
      [MATCH]: match({ createdByOrganizerUid: OTHER }),
      [MATCH_2]: match({ status: 'cancelled' })
    },
    config: { defaultDailyTournamentLimit: 1 }
  });

  const result = await assignments.assign({ tournamentId: MATCH_2, organizerUid: OTHER });

  assert.equal(result.code, 'COMPLETE');
  assert.equal(result.limit.notCounted, 'this match is cancelled or removed');
});

test('cancelling a match frees a place for the next assignment', async () => {
  const { db, assignments } = build({
    matches: {
      [MATCH]: match({ createdByOrganizerUid: OTHER }),
      [MATCH_2]: match({ createdByOrganizerUid: OTHER, status: 'cancelled' }),
      [MATCH_3]: match()
    },
    config: { defaultDailyTournamentLimit: 1 }
  });

  const blocked = await assignments.assign({ tournamentId: MATCH_3, organizerUid: OTHER });
  assert.equal(blocked.code, 'DAILY_LIMIT_REACHED', 'the live match still holds the place');

  // The cancellation is the organizer's own lifecycle write; once it lands the derived count falls.
  db.__seed('tournaments', MATCH, { ...stored(db, MATCH), status: 'cancelled' });

  const freed = await assignments.assign({ tournamentId: MATCH_3, organizerUid: OTHER });
  assert.equal(freed.code, 'COMPLETE');
  assert.equal(stored(db, MATCH_3).assignedOrganizerUid, OTHER);
});

test('reassignment moves the place rather than duplicating it', async () => {
  const { db, assignments } = build({
    matches: {
      // A is UID's; B is already OTHER's and fills OTHER's single place.
      [MATCH]: match({ createdByOrganizerUid: UID }),
      [MATCH_2]: match({ createdByOrganizerUid: OTHER }),
      [MATCH_3]: match({ createdByOrganizerUid: '' })
    },
    config: { defaultDailyTournamentLimit: 1 }
  });

  const refusedMove = await assignments.assign({ tournamentId: MATCH, organizerUid: OTHER });
  assert.equal(refusedMove.code, 'DAILY_LIMIT_REACHED');

  const moved = await assignments.assign({ tournamentId: MATCH, organizerUid: UID });
  assert.equal(moved.code, 'COMPLETE');
  assert.equal(stored(db, MATCH).assignedOrganizerUid, UID);

  // UID now holds one for the day; the place left OTHER when B's assignee was never UID.
  const otherDay = await assignments.assign({ tournamentId: MATCH_3, organizerUid: UID });
  assert.equal(otherDay.code, 'DAILY_LIMIT_REACHED');
});

test('a legacy match with no attribution can be assigned and is then counted', async () => {
  const { db, assignments } = build({
    matches: {
      [MATCH]: match({ createdByOrganizerUid: '', assignedOrganizerUid: '' }),
      [MATCH_2]: match({ createdByOrganizerUid: '', assignedOrganizerUid: '' })
    },
    config: { defaultDailyTournamentLimit: 1 }
  });

  const first = await assignments.assign({ tournamentId: MATCH, organizerUid: OTHER });
  assert.equal(first.code, 'COMPLETE');

  const second = await assignments.assign({ tournamentId: MATCH_2, organizerUid: OTHER });
  assert.equal(second.code, 'DAILY_LIMIT_REACHED', 'the legacy match now occupies the day');
  assert.equal(stored(db, MATCH).createdByOrganizerUid, '', 'attribution is not rewritten');
});

test('the day is the local day of the scheduled start, not the UTC day', async () => {
  const { assignments } = build({
    matches: {
      [MATCH]: match({ dateTime: new Date(DAY_START), createdByOrganizerUid: OTHER }),
      [MATCH_2]: match({ dateTime: new Date(JUST_BEFORE_DAY_START) })
    },
    config: { defaultDailyTournamentLimit: 1 }
  });

  // MATCH_2 is on the previous local day, so the full 2026-10-21 does not block it.
  const result = await assignments.assign({ tournamentId: MATCH_2, organizerUid: OTHER });
  assert.equal(result.code, 'COMPLETE');
  assert.equal(result.limit.day, '2026-10-20');

  const sameDay = build({
    matches: {
      [MATCH]: match({ dateTime: new Date(DAY_START), createdByOrganizerUid: OTHER }),
      [MATCH_2]: match({ dateTime: new Date(EARLIER_SAME_DAY) })
    },
    config: { defaultDailyTournamentLimit: 1 }
  });
  const blocked = await sameDay.assignments.assign({
    tournamentId: MATCH_2, organizerUid: OTHER
  });
  assert.equal(blocked.code, 'DAILY_LIMIT_REACHED');
  assert.equal(blocked.limit.day, '2026-10-21');
});

// ==========================================================================
// Clearing, and races
// ==========================================================================

test('clearing an assignment is never limited and needs no override', async () => {
  const { db, assignments } = build({
    matches: { [MATCH]: match({ assignedOrganizerUid: OTHER }) },
    config: { defaultDailyTournamentLimit: 1 }
  });

  const result = await assignments.assign({ tournamentId: MATCH, organizerUid: '' });

  assert.equal(result.code, 'COMPLETE');
  assert.equal(result.applied, true);
  assert.equal(result.previousAssignee, OTHER);
  assert.equal(stored(db).assignedOrganizerUid, null);
});

test('two simultaneous assignments cannot both take the last place of a day', async () => {
  const { db, assignments } = build({
    matches: {
      [MATCH]: match({ createdByOrganizerUid: '' }),
      [MATCH_2]: match({ createdByOrganizerUid: '' })
    },
    config: { defaultDailyTournamentLimit: 1 },
    serializable: true
  });

  const results = await Promise.all([
    assignments.assign({ tournamentId: MATCH, organizerUid: OTHER }),
    assignments.assign({ tournamentId: MATCH_2, organizerUid: OTHER })
  ]);

  assert.deepEqual(results.map(result => result.code).sort(),
    ['COMPLETE', 'DAILY_LIMIT_REACHED']);
  const assigned = [stored(db, MATCH), stored(db, MATCH_2)]
    .filter(row => row && row.assignedOrganizerUid === OTHER);
  assert.equal(assigned.length, 1);
});

test('a create and an assignment racing for the last place conflict through the same lock', async () => {
  const { db, economy } = build({
    matches: { [MATCH]: match({ createdByOrganizerUid: '', assignedOrganizerUid: '' }) },
    config: { defaultDailyTournamentLimit: 1 },
    serializable: true
  });
  const assignments = createOrganizerAssignments({
    db, economy, serverTimestamp: () => 'SERVER_TS', now: () => NOW
  });
  const intake = createOrganizerTournamentIntakeService({
    db, economy, serverTimestamp: () => 'SERVER_TS', now: () => NOW
  });

  const [create, assign] = await Promise.all([
    intake.createTournament({
      organizerUid: OTHER,
      requestId: 'req-00000001',
      input: { modeId: MODE, name: 'New Cup', dateTime: SCHEDULED }
    }),
    assignments.assign({ tournamentId: MATCH, organizerUid: OTHER })
  ]);

  const codes = [create.code, assign.code].sort();
  assert.deepEqual(codes, ['COMPLETE', 'DAILY_LIMIT_REACHED']);
  assert.ok(db.__peek('organizer_daily_locks', `${OTHER}_2026-10-21`),
    'the shared mutex is the document both paths touched');
});

test('an unchanged assignee and a cleared one both leave the lock alone', async () => {
  const { db, assignments } = build({
    matches: { [MATCH]: match({ assignedOrganizerUid: OTHER }) },
    config: { defaultDailyTournamentLimit: 2 }
  });

  await assignments.assign({ tournamentId: MATCH, organizerUid: OTHER });
  assert.equal(db.__peek('organizer_daily_locks', `${OTHER}_2026-10-21`), undefined);

  await assignments.assign({ tournamentId: MATCH, organizerUid: '' });
  assert.equal(db.__peek('organizer_daily_locks', `${OTHER}_2026-10-21`), undefined);
});
