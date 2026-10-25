/**
 * Phase 10: reading an organizer's money back.
 *
 * `organizer_ledger` is written by `services/organizerEconomy.js` inside the transaction that moved
 * the balance, and every wallet feature in this project - rewards, penalties, withdrawal holds and
 * their closings - already lands there. This suite is about the half that was missing: a screen
 * being able to ask for that history a page at a time, and being told the truth about what it got.
 *
 * Four properties are asserted over and over because they are the ways a history screen quietly
 * lies: a page that skips or repeats an entry, an unreadable request that silently restarts from
 * the beginning, an absent field rendered as zero, and a failed query that looks like "this
 * organizer never moved a coin". The route tests at the end are about identity: an organizer reads
 * their own ledger and only their own, and an admin reads the one they selected.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const express = require('express');
const {
  createOrganizerLedgerService,
  LEDGER_COLLECTION,
  ENTRY_TYPES,
  ENTRY_STATUSES,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  RELATED_KIND
} = require('../services/organizerLedger');
const { LEDGER_COLLECTION: ECONOMY_LEDGER } = require('../services/organizerEconomy');
const { createOrganizerWalletRouter } = require('../routes/organizerWalletRoutes');
const { createAdminOrganizerRouter } = require('../routes/organizerAdminRoutes');
const { createFakeFirestore } = require('./helpers/fakeFirestore');
const { makeAuthenticator, startServer, request } = require('./helpers/authHarness');

const ORGANIZER = 'organizer-a';
const RIVAL = 'organizer-b';
const ADMIN = 'admin-1';

const TOKENS = {
  'token-organizer': { uid: ORGANIZER },
  'token-rival': { uid: RIVAL },
  'token-admin': { uid: ADMIN }
};

const NOW = Date.parse('2026-10-21T12:00:00.000Z');
const minutes = count => count * 60000;

/** One ledger row, shaped the way the economy service writes it. */
function entry(organizerUid, over = {}) {
  return {
    organizerUid,
    type: 'reward_credit',
    direction: 'credit',
    amount: 100,
    currency: 'coins',
    balanceBefore: 0,
    balanceAfter: 100,
    idempotencyKey: `reward:${Math.random().toString(16).slice(2)}`,
    relatedId: 'tournament-1',
    reason: null,
    actorUid: null,
    status: 'settled',
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
    ...over
  };
}

/**
 * Newest first, ties broken by document id descending - the order the service asks Firestore for,
 * written here independently so a test cannot pass by recomputing the service's own answer.
 */
function expectedOrder(entries) {
  return [...entries].sort((left, right) => {
    const at = left.data.createdAt.getTime();
    const bt = right.data.createdAt.getTime();
    if (at !== bt) return bt - at;
    return left.id < right.id ? 1 : left.id > right.id ? -1 : 0;
  }).map(row => row.id);
}

function serviceOver(seed = {}) {
  const db = createFakeFirestore({ [LEDGER_COLLECTION]: seed });
  return { db, ledger: createOrganizerLedgerService({ db }) };
}

// ==========================================================================
// Ordering and completeness
// ==========================================================================

test('a page is newest first', async () => {
  const { ledger } = serviceOver({
    old: entry(ORGANIZER, { createdAt: new Date(NOW - minutes(30)) }),
    middle: entry(ORGANIZER, { createdAt: new Date(NOW - minutes(20)) }),
    newest: entry(ORGANIZER, { createdAt: new Date(NOW - minutes(10)) })
  });

  const page = await ledger.listEntries({ organizerUid: ORGANIZER });
  assert.equal(page.code, 'COMPLETE');
  assert.deepEqual(page.entries.map(row => row.entryId), ['newest', 'middle', 'old']);
  assert.equal(page.hasMore, false);
  assert.equal(page.nextCursor, null);
});

test('walking the history page by page visits every entry exactly once', async () => {
  const seed = {};
  for (let index = 0; index < 7; index += 1) {
    seed[`entry-${index}`] = entry(ORGANIZER, { createdAt: new Date(NOW - minutes(index)) });
  }
  const { ledger } = serviceOver(seed);
  const expected = expectedOrder(Object.entries(seed).map(([id, data]) => ({ id, data })));

  const seen = [];
  let cursor = '';
  let pages = 0;
  do {
    const page = await ledger.listEntries({ organizerUid: ORGANIZER, limit: 3, cursor });
    assert.equal(page.code, 'COMPLETE');
    assert.ok(page.count <= 3, 'a page never exceeds what it was asked for');
    seen.push(...page.entries.map(row => row.entryId));
    cursor = page.nextCursor || '';
    pages += 1;
    // `hasMore` and a cursor are the same fact, so they never disagree.
    assert.equal(page.hasMore, cursor !== '');
  } while (cursor && pages < 10);

  assert.equal(pages, 3);
  assert.deepEqual(seen, expected, 'no entry skipped and none shown twice');
  assert.equal(new Set(seen).size, 7);
});

test('entries written in the same millisecond are neither skipped nor repeated', async () => {
  const at = new Date(NOW);
  const seed = {
    'same-d': entry(ORGANIZER, { createdAt: at }),
    'same-b': entry(ORGANIZER, { createdAt: at }),
    'same-a': entry(ORGANIZER, { createdAt: at }),
    'same-c': entry(ORGANIZER, { createdAt: at }),
    newer: entry(ORGANIZER, { createdAt: new Date(NOW + minutes(5)) })
  };
  const { ledger } = serviceOver(seed);

  const seen = [];
  let cursor = '';
  do {
    const page = await ledger.listEntries({ organizerUid: ORGANIZER, limit: 2, cursor });
    seen.push(...page.entries.map(row => row.entryId));
    cursor = page.nextCursor || '';
  } while (cursor);

  assert.deepEqual(seen, expectedOrder(Object.entries(seed).map(([id, data]) => ({ id, data }))));
  assert.equal(new Set(seen).size, 5);
});

test('an unreadable cursor is refused instead of restarting the history', async () => {
  const { ledger } = serviceOver({ one: entry(ORGANIZER), two: entry(ORGANIZER) });

  for (const cursor of ['zzzz', 'not a cursor', 'a|b', '!!!']) {
    const page = await ledger.listEntries({ organizerUid: ORGANIZER, cursor });
    assert.equal(page.code, 'CURSOR_INVALID', `refused ${JSON.stringify(cursor)}`);
    assert.deepEqual(page.entries, []);
    assert.equal(page.nextCursor, null);
  }
});

test('a page size is bounded rather than trusted', async () => {
  const seed = {};
  for (let index = 0; index < 4; index += 1) seed[`e${index}`] = entry(ORGANIZER);

  const { ledger } = serviceOver(seed);
  assert.equal((await ledger.listEntries({ organizerUid: ORGANIZER })).pageSize, DEFAULT_LIMIT);
  assert.equal((await ledger.listEntries({ organizerUid: ORGANIZER, limit: 10000 })).pageSize, MAX_LIMIT);
  assert.equal((await ledger.listEntries({ organizerUid: ORGANIZER, limit: 0 })).pageSize, DEFAULT_LIMIT);
  assert.equal((await ledger.listEntries({ organizerUid: ORGANIZER, limit: -5 })).pageSize, 1);
});

// ==========================================================================
// Filters, and what a filter may not do
// ==========================================================================

test('filters select rows from one organizer and change nothing else', async () => {
  const seed = {
    reward: entry(ORGANIZER, { type: 'reward_credit', status: 'settled' }),
    penalty: entry(ORGANIZER, {
      type: 'penalty_deduction', direction: 'debit', status: 'settled',
      createdAt: new Date(NOW - minutes(60))
    }),
    hold: entry(ORGANIZER, {
      type: 'withdrawal_reservation', direction: 'hold', status: 'reserved',
      createdAt: new Date(NOW - minutes(120))
    }),
    rival: entry(RIVAL, { type: 'reward_credit', status: 'settled' })
  };
  const { ledger } = serviceOver(seed);

  const rewards = await ledger.listEntries({ organizerUid: ORGANIZER, type: 'reward_credit' });
  assert.deepEqual(rewards.entries.map(row => row.entryId), ['reward']);

  const holds = await ledger.listEntries({ organizerUid: ORGANIZER, status: 'reserved' });
  assert.deepEqual(holds.entries.map(row => row.entryId), ['hold']);

  const both = await ledger.listEntries({
    organizerUid: ORGANIZER, type: 'withdrawal_reservation', status: 'reserved'
  });
  assert.deepEqual(both.entries.map(row => row.entryId), ['hold']);

  const windowed = await ledger.listEntries({
    organizerUid: ORGANIZER,
    fromMillis: Date.parse('2026-10-21T11:00:00.000Z'),
    toMillis: Date.parse('2026-10-21T11:30:00.000Z')
  });
  assert.deepEqual(windowed.entries.map(row => row.entryId), ['penalty'],
    'the range is inclusive at both ends and excludes everything outside it');
});

test('a filter this project does not record is refused, not ignored', async () => {
  const { ledger } = serviceOver({ one: entry(ORGANIZER) });

  assert.equal((await ledger.listEntries({ organizerUid: ORGANIZER, type: 'payout' })).code,
    'TYPE_UNSUPPORTED');
  assert.equal((await ledger.listEntries({ organizerUid: ORGANIZER, status: 'pending' })).code,
    'STATUS_UNSUPPORTED');
  assert.equal((await ledger.listEntries({ organizerUid: ORGANIZER, fromMillis: 'yesterday' })).code,
    'DATE_INVALID');
  assert.equal((await ledger.listEntries({
    organizerUid: ORGANIZER, fromMillis: NOW, toMillis: NOW - 1
  })).code, 'DATE_INVALID');
  assert.equal((await ledger.listEntries({ organizerUid: '' })).code, 'ORGANIZER_UID_INVALID');
  assert.equal((await ledger.listEntries({ organizerUid: '../users' })).code, 'ORGANIZER_UID_INVALID',
    'a uid that could become a path is not a uid');
});

test('the types this service accepts are the ones the economy service writes', async () => {
  assert.deepEqual([...ENTRY_TYPES].sort(), [
    'admin_adjustment',
    'penalty_deduction',
    'reward_credit',
    'withdrawal_finalization',
    'withdrawal_release',
    'withdrawal_reservation'
  ]);
  assert.deepEqual([...ENTRY_STATUSES].sort(), ['finalized', 'released', 'reserved', 'settled']);
  assert.equal(LEDGER_COLLECTION, ECONOMY_LEDGER);

  // Every type a screen renders has to say what its `relatedId` points at, or the screen shows an
  // opaque id where it could show a tournament.
  for (const type of ENTRY_TYPES) {
    assert.ok(RELATED_KIND[type], `${type} names a related collection`);
  }
  assert.equal(RELATED_KIND.penalty_deduction, 'penalty_case');
  assert.equal(RELATED_KIND.withdrawal_reservation, 'withdrawal_request');
});

// ==========================================================================
// What an entry says about itself
// ==========================================================================

test('a field an entry never recorded is unavailable, never zero', async () => {
  const { ledger } = serviceOver({
    // A row from before the balance pair existed, which is what "legacy" actually looks like.
    legacy: {
      organizerUid: ORGANIZER,
      type: 'reward_credit',
      amount: 250,
      createdAt: new Date(NOW)
    }
  });

  const page = await ledger.listEntries({ organizerUid: ORGANIZER });
  const row = page.entries[0];
  assert.equal(row.amount, 250);
  assert.equal(row.balanceBefore, null, 'an unrecorded balance is not a balance of zero');
  assert.equal(row.balanceAfter, null);
  assert.equal(row.currency, null);
  assert.equal(row.status, null);
  assert.equal(row.direction, null);
  assert.equal(row.reason, null);
  assert.equal(row.actorUid, null);
  assert.equal(row.idempotencyKey, null);
  assert.equal(row.relatedId, null);
  assert.equal(row.relatedKind, null);
  assert.equal(row.reservationKey, null);
  assert.equal(row.closedByKey, null);
  // A time is not optional: an entry with no `createdAt` cannot be ordered or paged, so it is not
  // reported with an invented one.
  assert.equal(typeof row.createdAtMillis, 'number');
  assert.equal(row.createdAt, new Date(NOW).toISOString());
});

test('a full entry reports its balance, its direction and where it came from', async () => {
  const { ledger } = serviceOver({
    hold: entry(ORGANIZER, {
      type: 'withdrawal_reservation', direction: 'hold', status: 'reserved',
      amount: 400, balanceBefore: 1000, balanceAfter: 600, relatedId: 'wd_123',
      reservationKey: 'reserve:wd_123', reason: 'Withdrawal request', actorUid: ORGANIZER
    })
  });

  const row = (await ledger.listEntries({ organizerUid: ORGANIZER })).entries[0];
  assert.equal(row.direction, 'hold');
  assert.equal(row.status, 'reserved');
  assert.equal(row.balanceBefore, 1000);
  assert.equal(row.balanceAfter, 600);
  assert.equal(row.relatedId, 'wd_123');
  assert.equal(row.relatedKind, 'withdrawal_request');
  assert.equal(row.reservationKey, 'reserve:wd_123');
  assert.equal(row.idempotencyKey.length > 0, true);
});

// ==========================================================================
// Isolation and failure
// ==========================================================================

test('one organizer cannot read another organizer through the service', async () => {
  const { ledger } = serviceOver({
    mine: entry(ORGANIZER),
    theirs: entry(RIVAL)
  });

  const page = await ledger.listEntries({ organizerUid: ORGANIZER });
  assert.deepEqual(page.entries.map(row => row.entryId), ['mine']);

  const reversed = await ledger.listEntries({ organizerUid: RIVAL });
  assert.deepEqual(reversed.entries.map(row => row.entryId), ['theirs']);
});

test('a missing index is reported as retryable instead of as an empty history', async () => {
  const failing = {
    collection: () => ({
      where() { return this; },
      orderBy() { return this; },
      limit() { return this; },
      async get() {
        throw new Error('FAILED_PRECONDITION: The query requires an index.');
      }
    })
  };
  const ledger = createOrganizerLedgerService({ db: failing });

  const page = await ledger.listEntries({ organizerUid: ORGANIZER });
  assert.equal(page.code, 'INDEX_NOT_READY');
  assert.equal(page.retryable, true);
  assert.deepEqual(page.entries, []);
  assert.notEqual(page.code, 'COMPLETE');
});

// ==========================================================================
// The routes
// ==========================================================================

async function harness(seed = {}) {
  const db = createFakeFirestore({ [LEDGER_COLLECTION]: seed });
  const authenticator = makeAuthenticator(TOKENS);

  const app = express();
  app.use(express.json());
  app.use('/api/organizer/wallet', createOrganizerWalletRouter({
    authenticator,
    database: () => db,
    serverTimestamp: () => 'SERVER_TS'
  }));
  app.use('/api/admin/organizer', createAdminOrganizerRouter({
    authenticator,
    database: () => db,
    serverTimestamp: () => 'SERVER_TS',
    isAdminUid: async uid => uid === ADMIN
  }));

  const server = await startServer(app);
  return { db, server, baseUrl: server.baseUrl, close: () => server.close() };
}

const get = (baseUrl, path, token) => request(baseUrl, path, { token });

test('the organizer ledger route answers for the signed-in organizer, whatever it is asked for', async () => {
  const context = await harness({
    mine: entry(ORGANIZER),
    theirs: entry(RIVAL)
  });
  try {
    const own = await get(context.baseUrl, '/api/organizer/wallet/ledger', 'token-organizer');
    assert.equal(own.status, 200);
    assert.equal(own.body.success, true);
    assert.deepEqual(own.body.entries.map(row => row.entryId), ['mine']);

    // A uid in the query is not an identity. The route takes the caller from the token.
    const spoofed = await get(context.baseUrl,
      `/api/organizer/wallet/ledger?organizerUid=${RIVAL}`, 'token-organizer');
    assert.equal(spoofed.status, 200);
    assert.deepEqual(spoofed.body.entries.map(row => row.entryId), ['mine'],
      'asking for another organizer returns your own history, not theirs');
  } finally {
    await context.close();
  }
});

test('the organizer ledger route needs a token', async () => {
  const context = await harness({ mine: entry(ORGANIZER) });
  try {
    assert.equal((await get(context.baseUrl, '/api/organizer/wallet/ledger')).status, 401);
  } finally {
    await context.close();
  }
});

test('the organizer ledger route refuses a filter it cannot answer with a usable code', async () => {
  const context = await harness({ mine: entry(ORGANIZER) });
  try {
    const badType = await get(context.baseUrl,
      '/api/organizer/wallet/ledger?type=payout', 'token-organizer');
    assert.equal(badType.status, 400);
    assert.equal(badType.body.code, 'TYPE_UNSUPPORTED');

    const badCursor = await get(context.baseUrl,
      '/api/organizer/wallet/ledger?cursor=zzzz', 'token-organizer');
    assert.equal(badCursor.status, 400);
    assert.equal(badCursor.body.code, 'CURSOR_INVALID');
  } finally {
    await context.close();
  }
});

test('an organizer paging their own history over HTTP sees every entry once', async () => {
  const seed = {};
  for (let index = 0; index < 5; index += 1) {
    seed[`e${index}`] = entry(ORGANIZER, { createdAt: new Date(NOW - minutes(index)) });
  }
  const context = await harness(seed);
  try {
    const first = await get(context.baseUrl,
      '/api/organizer/wallet/ledger?limit=2', 'token-organizer');
    assert.equal(first.status, 200);
    assert.equal(first.body.entries.length, 2);
    assert.equal(first.body.hasMore, true);

    const second = await get(context.baseUrl,
      `/api/organizer/wallet/ledger?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`,
      'token-organizer');
    assert.equal(second.status, 200);
    assert.equal(second.body.hasMore, true);

    const third = await get(context.baseUrl,
      `/api/organizer/wallet/ledger?limit=2&cursor=${encodeURIComponent(second.body.nextCursor)}`,
      'token-organizer');
    assert.equal(third.body.hasMore, false);
    assert.equal(third.body.nextCursor, null);

    const seen = [...first.body.entries, ...second.body.entries, ...third.body.entries]
      .map(row => row.entryId);
    assert.deepEqual(seen, expectedOrder(Object.entries(seed).map(([id, data]) => ({ id, data }))));
  } finally {
    await context.close();
  }
});

test('the admin ledger route is admin-only', async () => {
  const context = await harness({ mine: entry(ORGANIZER) });
  try {
    assert.equal((await get(context.baseUrl,
      `/api/admin/organizer/ledger?organizerUid=${ORGANIZER}`)).status, 401);
    assert.equal((await get(context.baseUrl,
      `/api/admin/organizer/ledger?organizerUid=${ORGANIZER}`, 'token-organizer')).status, 403);
    assert.equal((await get(context.baseUrl,
      `/api/admin/organizer/ledger?organizerUid=${ORGANIZER}`, 'token-rival')).status, 403);
  } finally {
    await context.close();
  }
});

test('an admin reads the selected organizer, and is told when to name one', async () => {
  const context = await harness({
    mine: entry(ORGANIZER),
    theirs: entry(RIVAL)
  });
  try {
    const missing = await get(context.baseUrl, '/api/admin/organizer/ledger', 'token-admin');
    assert.equal(missing.status, 400);
    assert.equal(missing.body.code, 'ORGANIZER_UID_REQUIRED');

    const selected = await get(context.baseUrl,
      `/api/admin/organizer/ledger?organizerUid=${RIVAL}`, 'token-admin');
    assert.equal(selected.status, 200);
    assert.equal(selected.body.organizerUid, RIVAL);
    assert.deepEqual(selected.body.entries.map(row => row.entryId), ['theirs']);
  } finally {
    await context.close();
  }
});

test('the admin ledger route pages too, so a long history is not truncated to a first screen', async () => {
  const seed = {};
  for (let index = 0; index < 6; index += 1) {
    seed[`e${index}`] = entry(ORGANIZER, { createdAt: new Date(NOW - minutes(index)) });
  }
  const context = await harness(seed);
  try {
    const seen = [];
    let cursor = '';
    let guard = 0;
    do {
      const path = `/api/admin/organizer/ledger?organizerUid=${ORGANIZER}&limit=4`
        + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
      const page = await get(context.baseUrl, path, 'token-admin');
      assert.equal(page.status, 200);
      seen.push(...page.body.entries.map(row => row.entryId));
      cursor = page.body.nextCursor || '';
      guard += 1;
    } while (cursor && guard < 10);

    assert.equal(seen.length, 6);
    assert.deepEqual(seen, expectedOrder(Object.entries(seed).map(([id, data]) => ({ id, data }))));
  } finally {
    await context.close();
  }
});
