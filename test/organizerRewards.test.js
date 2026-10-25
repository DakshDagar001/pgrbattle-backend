/**
 * Phase 3: tournament-completion rewards.
 *
 * The three questions the brief asks are the three the tests are about: what the trusted
 * completion signal really is, who gets paid for a match whose creator and assignee may differ,
 * and whether a retry, a duplicate event or two simultaneous deliveries can pay twice.
 *
 * The fixture mirrors what the apps store: `prizesDistributed` is written by the results
 * transaction and never by the compose screens, `status` carries the lifecycle vocabulary, and
 * attribution is `createdByOrganizerUid` / `assignedOrganizerUid`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createOrganizerEconomyService,
  WALLET_COLLECTION,
  LEDGER_COLLECTION,
  CONFIG_COLLECTION,
  CONFIG_DOCUMENT,
  ENTRY_TYPES,
  CURRENCY
} = require('../services/organizerEconomy');
const {
  createOrganizerRewardService,
  rewardKeyFor,
  REWARD_ACTOR
} = require('../services/organizerRewards');
const { createAuditTrail } = require('../services/auditTrail');
const { createFakeFirestore } = require('./helpers/fakeFirestore');

const UID = 'organizer-a';
const OTHER = 'organizer-b';
const AUDIT_SECTION = 'organizer_economy';

const REWARD = 25;
const CONFIGURED = { defaultRewardPerTournament: REWARD, currency: CURRENCY };

function account(over = {}) {
  return { uid: UID, username: 'org_a', isActive: true, banned: false, regions: ['IN'], ...over };
}

/** A finished match as the results transaction leaves it. */
function completedMatch(over = {}) {
  return {
    name: 'PGR Showdown',
    status: 'results',
    isActive: true,
    dateTime: new Date(Date.parse('2026-10-20T12:00:00.000Z')),
    prizesDistributed: true,
    createdByOrganizerUid: UID,
    assignedOrganizerUid: null,
    ...over
  };
}

function walletData(over = {}) {
  return {
    availableBalance: 10,
    reservedBalance: 5,
    lifetimeEarned: 10,
    lifetimePenalized: 0,
    currency: CURRENCY,
    version: 1,
    createdAt: 'SEEDED_TS',
    ...over
  };
}

function build({ matches = { t1: completedMatch() }, accounts, wallets, config = CONFIGURED,
  serializable = false, audit = true } = {}) {
  const stores = {
    tournaments: matches,
    organizer_users: accounts === undefined
      ? { [UID]: account(), [OTHER]: account({ uid: OTHER, username: 'org_b' }) }
      : accounts,
    [WALLET_COLLECTION]: wallets === undefined ? { [UID]: walletData() } : wallets,
    [LEDGER_COLLECTION]: {}
  };
  if (config !== null) stores[CONFIG_COLLECTION] = { [CONFIG_DOCUMENT]: config };

  const db = createFakeFirestore(stores, { serializable });
  const economy = createOrganizerEconomyService({ db, serverTimestamp: () => 'SERVER_TS' });
  const auditTrail = audit
    ? createAuditTrail({ db, serverTimestamp: () => 'SERVER_TS' })
    : null;
  const rewards = createOrganizerRewardService({ db, economy, audit: auditTrail,
    now: () => Date.parse('2026-10-21T12:00:00.000Z') });
  return { db, economy, rewards };
}

const walletOf = (db, uid = UID) => db.__peek(WALLET_COLLECTION, uid);
const entryOf = (db, tournamentId) => db.__peek(LEDGER_COLLECTION, rewardKeyFor(tournamentId));
const auditRows = async (db) =>
  (await db.collection(`transcripts/${AUDIT_SECTION}/entries`).get()).docs.map(doc => doc.data());

// ==========================================================================
// The milestone
// ==========================================================================

test('nothing is paid until results are finalised and the player prizes issued', async () => {
  const { db, rewards } = build({
    matches: {
      pending: completedMatch({ prizesDistributed: false }),
      missing: completedMatch({ prizesDistributed: undefined }),
      // The dangerous case: a finished-looking status with nothing settled behind it.
      named: completedMatch({ prizesDistributed: false, status: 'results' })
    }
  });

  for (const tournamentId of ['pending', 'missing', 'named']) {
    const result = await rewards.grantForTournament({ tournamentId });
    assert.equal(result.code, 'NOT_COMPLETED');
    assert.equal(result.credited, false);
    assert.equal(entryOf(db, tournamentId), undefined);
  }
  assert.equal(walletOf(db).availableBalance, 10);
});

test('a match that is not finished is never rewarded, whatever its flag says', async () => {
  const { db, rewards, economy } = build({
    matches: {
      'up': completedMatch({ status: 'upcoming' }),
      'live': completedMatch({ status: 'ongoing' }),
      'cancelled': completedMatch({ status: 'cancelled' }),
      'removed': completedMatch({ status: 'removed' })
    }
  });

  for (const tournamentId of ['up', 'live', 'cancelled', 'removed']) {
    const result = await rewards.grantForTournament({ tournamentId });
    assert.equal(result.code, 'NOT_REWARDABLE', `${tournamentId} must not be rewarded`);
    assert.equal(entryOf(db, tournamentId), undefined);
  }
  assert.equal(walletOf(db).availableBalance, 10);
  const summary = await economy.getWalletSummary({ organizerUid: UID });
  assert.equal(summary.availableBalance, 10);
});

test('a missing, invalid or zero configured reward credits nothing and says so', async () => {
  for (const config of [null, { defaultRewardPerTournament: 0 }, { defaultRewardPerTournament: -5 }]) {
    const { db, rewards } = build({ config });
    const result = await rewards.grantForTournament({ tournamentId: 't1' });
    assert.equal(result.code, 'NO_AMOUNT_CONFIGURED');
    assert.equal(entryOf(db, 't1'), undefined);
    assert.equal(walletOf(db).availableBalance, 10);
  }
});

// ==========================================================================
// Recipient attribution
// ==========================================================================

test('the assigned organizer is paid, not the creator, when the two differ', async () => {
  const { db, rewards } = build({
    matches: { t1: completedMatch({ createdByOrganizerUid: UID, assignedOrganizerUid: OTHER }) },
    wallets: { [UID]: walletData(), [OTHER]: walletData({ availableBalance: 0 }) }
  });

  const result = await rewards.grantForTournament({ tournamentId: 't1' });
  assert.equal(result.code, 'COMPLETE');
  assert.equal(result.organizerUid, OTHER);
  assert.equal(walletOf(db, OTHER).availableBalance, REWARD);
  assert.equal(walletOf(db, UID).availableBalance, 10, 'the creator is not paid');
  assert.equal(entryOf(db, 't1').organizerUid, OTHER);
});

test('the creator is paid when nobody was assigned, and an unattributed match pays nobody', async () => {
  const { db, rewards } = build({
    matches: {
      mine: completedMatch(),
      nobody: completedMatch({ createdByOrganizerUid: null, assignedOrganizerUid: undefined })
    }
  });

  const mine = await rewards.grantForTournament({ tournamentId: 'mine' });
  assert.equal(mine.code, 'COMPLETE');
  assert.equal(walletOf(db).availableBalance, 10 + REWARD);

  const nobody = await rewards.grantForTournament({ tournamentId: 'nobody' });
  assert.equal(nobody.code, 'UNATTRIBUTED');
  assert.equal(entryOf(db, 'nobody'), undefined);
});

test('a uid that is not a registered organizer is never paid', async () => {
  const { db, rewards } = build({
    matches: { t1: completedMatch({ createdByOrganizerUid: 'not-an-organizer' }) }
  });

  const result = await rewards.grantForTournament({ tournamentId: 't1' });
  assert.equal(result.code, 'NOT_AN_ORGANIZER');
  assert.equal(db.__peek(WALLET_COLLECTION, 'not-an-organizer'), undefined);
  assert.equal(entryOf(db, 't1'), undefined);
});

// ==========================================================================
// Wallet handling and idempotency
// ==========================================================================

test('a wallet that does not exist yet is opened at zero and then credited', async () => {
  const { db, rewards } = build({ wallets: {} });

  const result = await rewards.grantForTournament({ tournamentId: 't1' });
  assert.equal(result.code, 'COMPLETE');

  const wallet = walletOf(db);
  assert.equal(wallet.availableBalance, REWARD);
  assert.equal(wallet.reservedBalance, 0);
  assert.equal(wallet.lifetimeEarned, REWARD);
  assert.equal(wallet.currency, CURRENCY);
});

test('a reward never touches coins already reserved for a withdrawal', async () => {
  const { db, rewards } = build();

  await rewards.grantForTournament({ tournamentId: 't1' });

  const wallet = walletOf(db);
  assert.equal(wallet.availableBalance, 10 + REWARD);
  assert.equal(wallet.reservedBalance, 5, 'the hold is left exactly as it was');
});

test('a duplicate delivery moves coins once and is reported as a duplicate', async () => {
  const { db, rewards } = build();

  const first = await rewards.grantForTournament({ tournamentId: 't1' });
  const second = await rewards.grantForTournament({ tournamentId: 't1' });
  const third = await rewards.grantForTournament({ tournamentId: 't1' });

  assert.equal(first.code, 'COMPLETE');
  assert.equal(second.code, 'DUPLICATE');
  assert.equal(third.code, 'DUPLICATE');
  assert.equal(walletOf(db).availableBalance, 10 + REWARD);
  assert.equal(walletOf(db).lifetimeEarned, 10 + REWARD);

  const entry = entryOf(db, 't1');
  assert.equal(entry.type, ENTRY_TYPES.REWARD_CREDIT);
  assert.equal(entry.amount, REWARD);
  assert.equal(entry.relatedId, 't1');
  assert.equal(entry.actorUid, REWARD_ACTOR);
});

test('two simultaneous deliveries cannot credit the reward twice', async () => {
  const { db, rewards } = build({ serializable: true });

  const results = await Promise.all([
    rewards.grantForTournament({ tournamentId: 't1' }),
    rewards.grantForTournament({ tournamentId: 't1' }),
    rewards.grantForTournament({ tournamentId: 't1' })
  ]);

  assert.equal(results.filter(result => result.code === 'COMPLETE').length, 1);
  assert.equal(results.filter(result => result.code === 'DUPLICATE').length, 2);
  assert.equal(walletOf(db).availableBalance, 10 + REWARD);
});

test('the ledger key names the tournament and the milestone, not the attempt', () => {
  assert.equal(rewardKeyFor('abc123'), 'reward:abc123:tournament_completed');
  assert.match(rewardKeyFor('abc123'), /^[A-Za-z0-9_:.-]{1,160}$/);
});

// ==========================================================================
// Audit trail
// ==========================================================================

test('the audit row points at the ledger entry instead of restating a balance', async () => {
  const { db, rewards } = build();

  await rewards.grantForTournament({ tournamentId: 't1' });
  await rewards.grantForTournament({ tournamentId: 't1' });

  const rows = await auditRows(db);
  const credited = rows.filter(row => row.actionType === 'reward_credited');
  const duplicate = rows.filter(row => row.actionType === 'reward_already_credited');

  assert.equal(credited.length, 1);
  assert.equal(duplicate.length, 1);
  assert.equal(credited[0].payload.ledgerRef, rewardKeyFor('t1'));
  assert.equal(credited[0].payload.tournamentId, 't1');
  assert.equal(credited[0].payload.organizerUid, UID);
  assert.equal(credited[0].payload.currency, 'coins');
  assert.equal(credited[0].performerId, REWARD_ACTOR);
});

// ==========================================================================
// Catch-up
// ==========================================================================

test('catch-up credits a completion the listener missed, and repeat passes are duplicates', async () => {
  const { db, rewards } = build({
    matches: {
      recent: completedMatch(),
      incomplete: completedMatch({ prizesDistributed: false }),
      old: completedMatch({ dateTime: new Date(Date.parse('2026-01-01T00:00:00.000Z')) })
    }
  });

  const first = await rewards.catchUp({ sinceHours: 168 });
  assert.equal(first.summary.scanned, 2, 'only the window is read');
  assert.equal(first.summary.credited, 1);
  assert.equal(first.summary.skipped, 0);
  assert.equal(walletOf(db).availableBalance, 10 + REWARD);

  const second = await rewards.catchUp({ sinceHours: 168 });
  assert.equal(second.summary.credited, 0);
  assert.equal(second.summary.duplicate, 1);
  assert.equal(walletOf(db).availableBalance, 10 + REWARD);
});
