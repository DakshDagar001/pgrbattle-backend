/**
 * The audit trail's own rules, independent of any route.
 *
 * Two of Phase 9's requirements are about the reader and the failure path rather than about a
 * particular operation, and neither is checkable over HTTP without inventing traffic:
 *
 * - A page narrowed to one organizer must not report a false zero. The newest rows of a section
 *   belong to whoever acted last, so a read that takes the newest N and then filters would tell an
 *   organizer with older history that they have none.
 * - An audit failure never rejects into a caller that has already moved coins. The answer is
 *   `{ recorded: false }` and the caller decides how to say it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createAuditTrail, SECTIONS } = require('../services/auditTrail');
const { createFakeFirestore } = require('./helpers/fakeFirestore');

const OUR_ORGANIZER = 'organizer-ours';
const OTHER_ORGANIZER = 'organizer-other';

const ENTRIES = name => `transcripts/${name}/entries`;

function row(organizerUid, createdAt, actionType = 'recorded') {
  return {
    transcriptId: `t-${createdAt}`,
    section: SECTIONS.ORGANIZER_DEVICES,
    actionType,
    title: 'A device decision',
    payload: { organizerUid },
    performedBy: 'admin',
    performerId: 'admin-1',
    performerEmail: 'admin@example.com',
    createdAt
  };
}

/** A section whose 25 newest rows are somebody else's and whose 5 oldest are the organizer's. */
function crowdedSection() {
  const rows = {};
  for (let i = 0; i < 25; i += 1) {
    rows[`other_${i}`] = row(OTHER_ORGANIZER, 2_000 + i);
  }
  for (let i = 0; i < 5; i += 1) {
    rows[`ours_${i}`] = row(OUR_ORGANIZER, 1_000 + i);
  }
  return { [ENTRIES(SECTIONS.ORGANIZER_DEVICES)]: rows };
}

test('one organizer\'s older rows are found instead of reported as no activity', async () => {
  const db = createFakeFirestore(crowdedSection());
  const audit = createAuditTrail({ db, serverTimestamp: () => 9_999 });

  const page = await audit.list({
    section: SECTIONS.ORGANIZER_DEVICES,
    limit: 10,
    filterOrganizerUid: OUR_ORGANIZER
  });

  assert.equal(page.code, 'COMPLETE');
  assert.equal(page.entries.length, 5, 'every one of the organizer\'s own rows is on the page');
  assert.equal(page.scanned, 30, 'the read looked past the newest page to find them');
  assert.equal(page.truncated, false, 'the whole section fitted inside the widened scan');
  assert.ok(page.entries.every(entry => entry.payload.organizerUid === OUR_ORGANIZER));
});

test('a narrowed read that stopped early says so rather than claiming there is nothing', async () => {
  const db = createFakeFirestore(crowdedSection());
  const audit = createAuditTrail({ db, serverTimestamp: () => 9_999 });

  // A page of 5 widens to a scan of 20, and the 20 newest rows all belong to the other organizer.
  const page = await audit.list({
    section: SECTIONS.ORGANIZER_DEVICES,
    limit: 5,
    filterOrganizerUid: OUR_ORGANIZER
  });

  assert.equal(page.entries.length, 0);
  assert.equal(page.scanned, 20);
  assert.equal(page.truncated, true,
    'the screen can say "nothing in the newest N", which is a fact, instead of "none", which is not');
});

test('an unfiltered page is the newest rows of the section, and one bounded page', async () => {
  const db = createFakeFirestore(crowdedSection());
  const audit = createAuditTrail({ db, serverTimestamp: () => 9_999 });

  const page = await audit.list({ section: SECTIONS.ORGANIZER_DEVICES, limit: 10 });

  assert.equal(page.entries.length, 10);
  assert.equal(page.scanned, 10);
  assert.equal(page.truncated, true, 'there are more rows behind this page');
  assert.ok(page.entries.every(entry => entry.payload.organizerUid === OTHER_ORGANIZER));
});

test('a read of a section nothing was written to is a page of nothing, not a failure', async () => {
  const db = createFakeFirestore({});
  const audit = createAuditTrail({ db, serverTimestamp: () => 9_999 });

  const page = await audit.list({ section: SECTIONS.ORGANIZER_ECONOMY, limit: 10 });

  assert.equal(page.code, 'COMPLETE');
  assert.deepEqual(page.entries, []);
  assert.equal(page.truncated, false);
});

test('a credential-shaped key never reaches the record', async () => {
  const db = createFakeFirestore({});
  const audit = createAuditTrail({ db, serverTimestamp: () => 9_999 });

  const written = await audit.record({
    section: SECTIONS.ORGANIZERS,
    actionType: 'created',
    title: 'Organizer created',
    payload: {
      organizerUid: OUR_ORGANIZER,
      password: 'hunter2',
      authToken: 'token-abc',
      upiPin: '1234'
    }
  });

  assert.equal(written.recorded, true);
  const stored = db.__peek(ENTRIES(SECTIONS.ORGANIZERS), written.transcriptId);
  assert.equal(stored.payload.organizerUid, OUR_ORGANIZER);
  assert.equal(stored.payload.password, undefined);
  assert.equal(stored.payload.authToken, undefined);
  assert.equal(stored.payload.upiPin, undefined);
  assert.equal(stored.payload.redactedKeys, '3 secret-shaped key(s) not stored');
  assert.ok(!JSON.stringify(stored).includes('hunter2'));
});

test('a clock that cannot be read leaves the caller with a recorded:false, not an exception', async () => {
  const db = createFakeFirestore({});
  const audit = createAuditTrail({
    db,
    // A server timestamp that cannot be resolved is infrastructure, not a financial outcome.
    serverTimestamp: () => { throw new Error('clock unavailable'); }
  });

  const written = await audit.record({
    section: SECTIONS.ORGANIZER_ECONOMY,
    actionType: 'withdrawal_approved',
    title: 'Organizer withdrawal approved',
    payload: { organizerUid: OUR_ORGANIZER, requestId: 'wd-1' },
    performedBy: 'admin',
    performerId: 'admin-1'
  });

  assert.equal(written.recorded, false);
  assert.match(written.error, /clock unavailable/);
});

test('an entry with no section or no action type is refused instead of written blind', async () => {
  const db = createFakeFirestore({});
  const audit = createAuditTrail({ db, serverTimestamp: () => 9_999 });

  assert.equal((await audit.record({ section: '', actionType: 'x' })).recorded, false);
  assert.equal((await audit.record({ section: SECTIONS.ORGANIZERS, actionType: '' })).recorded, false);
  assert.deepEqual(db.__names().filter(name => name.startsWith('transcripts')), []);
});
