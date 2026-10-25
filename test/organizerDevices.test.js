/**
 * Phase 7: an organizer's device, who may bind it, and who may decide a change.
 *
 * These tests are the phase's promises written as assertions. Every one of them is about a case the
 * brief names: the first device of an account that never had one, a second phone that cannot bind
 * itself, a request that does not multiply when a screen is reopened, an approval that survives two
 * admins, a rejection that leaves the approved device untouched, a recovery for a lost phone, and a
 * protected operation that refuses a device nobody approved.
 *
 * What is deliberately not asserted here is that a device identifier is proof of hardware. There is
 * no attestation in this project, so the identifier is what the app declares and the backend decides
 * what to do about it; the limitation is in the service header and in the completion report.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createOrganizerDeviceService,
  BINDINGS_COLLECTION,
  REQUESTS_COLLECTION,
  REQUEST_STATUS,
  ENROLLMENT_BASIS,
  requestIdFor
} = require('../services/organizerDevices');
const { createAuditTrail } = require('../services/auditTrail');
const { createFakeFirestore } = require('./helpers/fakeFirestore');

const ORGANIZER = 'organizer-a';
const RIVAL = 'organizer-b';
const GHOST = 'organizer-gone';
const BANNED = 'organizer-banned';
const INACTIVE = 'organizer-inactive';
const ADMIN = 'admin-1';
const OTHER_ADMIN = 'admin-2';

const DEV_ONE = 'device-one-0001';
const DEV_TWO = 'device-two-0002';

const UPI = 'org_a@ybl';

function account(uid, over = {}) {
  return { uid, username: 'org_a', isActive: true, banned: false, ...over };
}

function accounts(over = {}) {
  return {
    [ORGANIZER]: account(ORGANIZER),
    [RIVAL]: account(RIVAL, { username: 'org_b' }),
    [BANNED]: account(BANNED, { banned: true }),
    [INACTIVE]: account(INACTIVE, { isActive: false }),
    ...over
  };
}

const stamp = () => 'SERVER_TS';

/**
 * @param {object} [options] `serializable: true` makes the double behave like Firestore's
 * optimistic concurrency, which is the only way to test two admins deciding the same request at
 * the same moment instead of one after the other.
 */
function harness({
  bindings = {},
  requests = {},
  extraAccounts = {},
  serializable = false,
  withAudit = true
} = {}) {
  const stores = {
    organizer_users: accounts(extraAccounts),
    [BINDINGS_COLLECTION]: bindings,
    [REQUESTS_COLLECTION]: requests
  };
  const db = createFakeFirestore(stores, { serializable });
  const audit = withAudit
    ? createAuditTrail({ db, serverTimestamp: stamp })
    : null;
  const devices = createOrganizerDeviceService({ db, serverTimestamp: stamp, audit });

  return { db, audit, devices };
}

/** Every transcript row in one section, oldest write order first. */
async function rows(db, section) {
  const snapshot = await db.collection(`transcripts/${section}/entries`).get();
  return snapshot.docs.map(doc => doc.data());
}

const peek = (db, name, id) => db.__peek(name, id);

// ==========================================================================
// First enrollment
// ==========================================================================

test('the first device an organizer uses becomes their binding, once', async () => {
  const { db, devices, audit } = harness();

  const first = await devices.enrollFirstDevice({
    organizerUid: ORGANIZER, deviceId: DEV_ONE, deviceLabel: 'Pixel 7'
  });
  assert.equal(first.code, 'COMPLETE');
  assert.equal(first.applied, true);
  assert.equal(first.binding.deviceId, DEV_ONE);
  assert.equal(first.binding.basis, ENROLLMENT_BASIS.FIRST_ENROLLMENT,
    'the record says how it came to exist, so a screen can say it plainly');
  assert.equal(first.auditRecorded, true);

  // Keyed by the organizer, so one account has exactly one answer to "which device".
  assert.equal(peek(db, BINDINGS_COLLECTION, ORGANIZER).deviceId, DEV_ONE);
  assert.equal((await db.collection(BINDINGS_COLLECTION).get()).size, 1);

  // And asking again is not a second enrollment.
  const again = await devices.enrollFirstDevice({
    organizerUid: ORGANIZER, deviceId: DEV_ONE, deviceLabel: 'Pixel 7 (renamed)'
  });
  assert.equal(again.applied, false);
  assert.equal(again.matching, true, 'a metadata change is not a new device');

  const stored = peek(db, BINDINGS_COLLECTION, ORGANIZER);
  assert.equal(stored.deviceLabel, 'Pixel 7 (renamed)', 'the label does refresh');
  assert.equal(stored.deviceId, DEV_ONE, 'and the identifier is untouched');

  const logged = await rows(db, 'organizer_devices');
  assert.equal(logged.filter(row => row.actionType === 'enrolled').length, 1,
    'one enrollment, one row');
});

test('a second device cannot enroll itself over the first', async () => {
  const { db, devices } = harness({
    bindings: { [ORGANIZER]: { organizerUid: ORGANIZER, deviceId: DEV_ONE, basis: 'first_enrollment' } }
  });

  const attempt = await devices.enrollFirstDevice({
    organizerUid: ORGANIZER, deviceId: DEV_TWO, deviceLabel: 'Pixel 8'
  });
  assert.equal(attempt.code, 'REPLACEMENT_REQUIRES_APPROVAL');
  assert.equal(attempt.approvalRequired, true);
  assert.equal(attempt.applied, false, 'a refusal always says it applied nothing');

  assert.equal(peek(db, BINDINGS_COLLECTION, ORGANIZER).deviceId, DEV_ONE,
    'the approved device is exactly the one that was already there');
  assert.equal((await db.collection(REQUESTS_COLLECTION).get()).size, 0,
    'and a refused enrollment does not silently raise a request on someone\'s behalf');
});

// ==========================================================================
// Replacement requests
// ==========================================================================

test('a replacement request is pending, and asking again does not make a second one', async () => {
  const { db, devices } = harness({
    bindings: { [ORGANIZER]: { organizerUid: ORGANIZER, deviceId: DEV_ONE } }
  });

  const raised = await devices.requestReplacement({
    organizerUid: ORGANIZER, deviceId: DEV_TWO, deviceLabel: 'Pixel 8'
  });
  assert.equal(raised.code, 'COMPLETE');
  assert.equal(raised.pending, true);
  assert.equal(raised.status, REQUEST_STATUS.PENDING);
  assert.equal(raised.requestId, requestIdFor({ organizerUid: ORGANIZER, deviceId: DEV_TWO }),
    'the id is derived from the organizer and the device, not random');

  const stored = peek(db, REQUESTS_COLLECTION, raised.requestId);
  assert.equal(stored.status, REQUEST_STATUS.PENDING);
  assert.equal(stored.organizerUid, ORGANIZER);
  assert.equal(stored.approvedDeviceAtRequest, DEV_ONE,
    'the request remembers which device it is asking to replace');

  const repeat = await devices.requestReplacement({
    organizerUid: ORGANIZER, deviceId: DEV_TWO, deviceLabel: 'Pixel 8'
  });
  assert.equal(repeat.duplicate, true);
  assert.equal(repeat.applied, false);
  assert.equal(repeat.requestId, raised.requestId);

  const page = await devices.listRequests({ status: REQUEST_STATUS.PENDING });
  assert.equal(page.requests.length, 1,
    'five opens of the same screen are still one request in the queue');

  const logged = await rows(db, 'organizer_devices');
  assert.equal(logged.filter(row => row.actionType === 'requested').length, 1);
  assert.equal(logged.filter(row => row.actionType === 'requested_again').length, 0,
    'a repeat of a still-pending request is not a new event');
});

test('the approved device asking for a change is not a change at all', async () => {
  const { db, devices } = harness({
    bindings: { [ORGANIZER]: { organizerUid: ORGANIZER, deviceId: DEV_ONE, deviceLabel: 'old' } }
  });

  const result = await devices.requestReplacement({
    organizerUid: ORGANIZER, deviceId: DEV_ONE, deviceLabel: 'Pixel 7'
  });
  assert.equal(result.code, 'COMPLETE');
  assert.equal(result.matching, true);
  assert.equal(result.applied, false);

  assert.equal((await db.collection(REQUESTS_COLLECTION).get()).size, 0,
    'nothing was raised, so an admin is not asked to decide a device that is already approved');
  assert.equal(peek(db, BINDINGS_COLLECTION, ORGANIZER).deviceLabel, 'Pixel 7');
});

test('an unbound organizer raises a request instead of enrolling behind their own back', async () => {
  const { devices } = harness();

  const result = await devices.requestReplacement({
    organizerUid: ORGANIZER, deviceId: DEV_TWO
  });
  assert.equal(result.code, 'ENROLLMENT_AVAILABLE');
  assert.equal(result.enrollmentAvailable, true,
    'and they are pointed at the path that carries their own consent');
});

test('a rejected device can ask again, on the same row', async () => {
  const id = requestIdFor({ organizerUid: ORGANIZER, deviceId: DEV_TWO });
  const { db, devices } = harness({
    bindings: { [ORGANIZER]: { organizerUid: ORGANIZER, deviceId: DEV_ONE } },
    requests: {
      [id]: {
        organizerUid: ORGANIZER, deviceId: DEV_TWO, status: REQUEST_STATUS.REJECTED,
        decidedBy: ADMIN, decidedAt: 'OLD', reason: 'Could not verify the phone'
      }
    }
  });

  const reopened = await devices.requestReplacement({
    organizerUid: ORGANIZER, deviceId: DEV_TWO, deviceLabel: 'Pixel 8'
  });
  assert.equal(reopened.reopened, true);
  assert.equal(reopened.status, REQUEST_STATUS.PENDING);
  assert.equal(reopened.requestId, id, 'the same row, not a second one');

  const stored = peek(db, REQUESTS_COLLECTION, id);
  assert.equal(stored.status, REQUEST_STATUS.PENDING);
  assert.equal(stored.decidedBy, null, 'the old decision is cleared rather than left half-applied');
  assert.equal(stored.reason, null);

  const logged = await rows(db, 'organizer_devices');
  assert.equal(logged.filter(row => row.actionType === 'requested_again').length, 1,
    'and the reopening is itself written down');
});

// ==========================================================================
// Admin decisions
// ==========================================================================

test('an approval binds the requested device and remembers the one it replaced', async () => {
  const { db, devices } = harness({
    bindings: { [ORGANIZER]: { organizerUid: ORGANIZER, deviceId: DEV_ONE, basis: 'first_enrollment' } }
  });
  const raised = await devices.requestReplacement({
    organizerUid: ORGANIZER, deviceId: DEV_TWO, deviceLabel: 'Pixel 8'
  });

  const approved = await devices.approveRequest({
    requestId: raised.requestId, adminUid: ADMIN, adminEmail: 'admin@example.test'
  });
  assert.equal(approved.code, 'COMPLETE');
  assert.equal(approved.request.status, REQUEST_STATUS.APPROVED);
  assert.equal(approved.request.decidedBy, ADMIN);
  assert.equal(approved.previousDeviceId, DEV_ONE);
  assert.equal(approved.auditRecorded, true);

  const binding = peek(db, BINDINGS_COLLECTION, ORGANIZER);
  assert.equal(binding.deviceId, DEV_TWO, 'the organizer is now on the approved phone');
  assert.equal(binding.basis, ENROLLMENT_BASIS.APPROVED_REQUEST);
  assert.equal(binding.boundBy, ADMIN, 'and the record says which admin decided');
  assert.equal(binding.viaRequestId, raised.requestId);
  assert.equal(binding.previousDeviceId, DEV_ONE,
    'the device it replaced is kept, so a change history exists');

  const logged = await rows(db, 'organizer_devices');
  const row = logged.find(entry => entry.actionType === 'approved');
  assert.ok(row, 'the decision is in the audit trail');
  assert.equal(row.performerId, ADMIN);
  assert.equal(row.payload.organizerUid, ORGANIZER);
});

test('a decision can be made once, whoever asks second', async () => {
  const { db, devices } = harness({
    bindings: { [ORGANIZER]: { organizerUid: ORGANIZER, deviceId: DEV_ONE } }
  });
  const raised = await devices.requestReplacement({
    organizerUid: ORGANIZER, deviceId: DEV_TWO
  });

  const first = await devices.approveRequest({ requestId: raised.requestId, adminUid: ADMIN });
  assert.equal(first.code, 'COMPLETE');

  // A second admin, on the same row, after the first one committed.
  const second = await devices.approveRequest({
    requestId: raised.requestId, adminUid: OTHER_ADMIN
  });
  assert.equal(second.code, 'ALREADY_PROCESSED');
  assert.equal(second.applied, false);

  const binding = peek(db, BINDINGS_COLLECTION, ORGANIZER);
  assert.equal(binding.deviceId, DEV_TWO);
  assert.equal(binding.boundBy, ADMIN, 'the first decision is the one that stands');
  assert.equal(peek(db, REQUESTS_COLLECTION, raised.requestId).decidedBy, ADMIN);

  const rejected = await devices.rejectRequest({
    requestId: raised.requestId, adminUid: OTHER_ADMIN, reason: 'too late'
  });
  assert.equal(rejected.code, 'ALREADY_PROCESSED',
    'and an approval cannot be reversed by rejecting it afterwards');
  assert.equal(peek(db, BINDINGS_COLLECTION, ORGANIZER).deviceId, DEV_TWO,
    'the binding is untouched by the refused reversal');

  const logged = await rows(db, 'organizer_devices');
  assert.equal(logged.filter(row => row.actionType === 'approved').length, 1,
    'one approval, one row, no matter how many screens pressed the button');
});

test('two admins deciding the same request at the same moment produce one decision', async () => {
  // The double is switched to Firestore's optimistic concurrency, so a transaction that read a
  // document another one has since committed over is aborted rather than quietly overwriting it.
  const { db, devices } = harness({
    bindings: { [ORGANIZER]: { organizerUid: ORGANIZER, deviceId: DEV_ONE } },
    serializable: true
  });
  const raised = await devices.requestReplacement({
    organizerUid: ORGANIZER, deviceId: DEV_TWO
  });

  const both = await Promise.all([
    devices.approveRequest({ requestId: raised.requestId, adminUid: ADMIN }),
    devices.approveRequest({ requestId: raised.requestId, adminUid: OTHER_ADMIN })
  ]);

  const applied = both.filter(result => result.code === 'COMPLETE' && result.applied === true);
  assert.equal(applied.length, 1,
    `exactly one approval, got ${JSON.stringify(both.map(result => result.code))}`);

  const loser = both.find(result => result !== applied[0]);
  assert.ok(['ALREADY_PROCESSED', 'TRANSIENT_FAILURE'].includes(loser.code),
    `the loser is told it did not happen, not that it did: ${loser.code}`);

  assert.equal(peek(db, BINDINGS_COLLECTION, ORGANIZER).deviceId, DEV_TWO,
    'and however the race resolved, there is one binding and it is the requested device');
  assert.equal(peek(db, REQUESTS_COLLECTION, raised.requestId).status, REQUEST_STATUS.APPROVED);
});

test('a rejection preserves the approved device and needs a reason', async () => {
  const { db, devices } = harness({
    bindings: { [ORGANIZER]: { organizerUid: ORGANIZER, deviceId: DEV_ONE } }
  });
  const raised = await devices.requestReplacement({
    organizerUid: ORGANIZER, deviceId: DEV_TWO
  });

  const reasonless = await devices.rejectRequest({
    requestId: raised.requestId, adminUid: ADMIN, reason: '   '
  });
  assert.equal(reasonless.code, 'REASON_REQUIRED');
  assert.equal(peek(db, REQUESTS_COLLECTION, raised.requestId).status, REQUEST_STATUS.PENDING,
    'a refusal to decide changes nothing');

  const rejected = await devices.rejectRequest({
    requestId: raised.requestId, adminUid: ADMIN, reason: 'Cannot confirm this is their phone'
  });
  assert.equal(rejected.code, 'REJECTED');
  assert.equal(rejected.applied, true);
  assert.equal(peek(db, REQUESTS_COLLECTION, raised.requestId).status, REQUEST_STATUS.REJECTED);
  assert.equal(peek(db, REQUESTS_COLLECTION, raised.requestId).reason,
    'Cannot confirm this is their phone');

  assert.equal(peek(db, BINDINGS_COLLECTION, ORGANIZER).deviceId, DEV_ONE,
    'a rejection answers one request and un-binds nobody from anything');

  const gate = await devices.requireApprovedDevice({ organizerUid: ORGANIZER, deviceId: DEV_TWO });
  assert.equal(gate.code, 'DEVICE_NOT_APPROVED', 'and the rejected device is still refused');
});

test('an approval refuses an organizer account that cannot hold a device', async () => {
  for (const uid of [BANNED, INACTIVE, GHOST]) {
    const { db, devices } = harness();
    const id = requestIdFor({ organizerUid: uid, deviceId: DEV_TWO });
    db.__seed(REQUESTS_COLLECTION, id, {
      organizerUid: uid, deviceId: DEV_TWO, status: REQUEST_STATUS.PENDING
    });

    const result = await devices.approveRequest({ requestId: id, adminUid: ADMIN });
    assert.equal(result.applied, false, `${uid} was not approved`);
    assert.ok(['NOT_AN_ORGANIZER', 'ORGANIZER_BANNED', 'ORGANIZER_INACTIVE'].includes(result.code),
      `a decision about ${uid} says why: ${result.code}`);
    assert.equal(peek(db, BINDINGS_COLLECTION, uid), undefined,
      'and no binding was written for an account that cannot hold one');
  }
});

test('a request that does not exist, or cannot be named, is refused by id', async () => {
  const { devices } = harness();

  assert.equal((await devices.approveRequest({
    requestId: 'dev_nope', adminUid: ADMIN
  })).code, 'NOT_FOUND');
  assert.equal((await devices.rejectRequest({
    requestId: 'dev_nope', adminUid: ADMIN, reason: 'gone'
  })).code, 'NOT_FOUND');

  for (const requestId of ['', '   ', 'dev../../other', 'x'.repeat(200)]) {
    assert.equal((await devices.approveRequest({ requestId, adminUid: ADMIN })).code,
      'REQUEST_ID_INVALID', `${requestId} is not a request anybody can decide`);
  }
  assert.equal((await devices.approveRequest({ requestId: requestIdFor({
    organizerUid: ORGANIZER, deviceId: DEV_TWO
  }) })).code, 'ADMIN_UID_REQUIRED', 'a decision without an admin is not a decision');
});

// ==========================================================================
// The gate a protected operation asks
// ==========================================================================

test('the device gate answers four different situations differently', async () => {
  const unbound = harness();
  const first = await unbound.devices.requireApprovedDevice({
    organizerUid: ORGANIZER, deviceId: DEV_ONE
  });
  assert.equal(first.code, 'ENROLLMENT_REQUIRED');
  assert.equal(first.enrollmentAvailable, true);

  const { devices } = harness({
    bindings: { [ORGANIZER]: { organizerUid: ORGANIZER, deviceId: DEV_ONE } }
  });

  const onIt = await devices.requireApprovedDevice({ organizerUid: ORGANIZER, deviceId: DEV_ONE });
  assert.equal(onIt.ok, true);
  assert.equal(onIt.code, 'COMPLETE');

  const offIt = await devices.requireApprovedDevice({ organizerUid: ORGANIZER, deviceId: DEV_TWO });
  assert.equal(offIt.code, 'DEVICE_NOT_APPROVED');
  assert.equal(offIt.approvalRequired, true);
  assert.equal(offIt.pendingRequestId, null, 'nothing has been asked for yet');

  const raised = await devices.requestReplacement({ organizerUid: ORGANIZER, deviceId: DEV_TWO });
  const waiting = await devices.requireApprovedDevice({ organizerUid: ORGANIZER, deviceId: DEV_TWO });
  assert.equal(waiting.code, 'DEVICE_NOT_APPROVED');
  assert.equal(waiting.pendingRequestId, raised.requestId,
    'and the answer names the request, so the app can show its state');
  assert.match(waiting.message, /waiting for an administrator/i);
});

test('an identifier is validated before anything is read about it', async () => {
  const { devices } = harness({
    bindings: { [ORGANIZER]: { organizerUid: ORGANIZER, deviceId: DEV_ONE } }
  });

  for (const deviceId of ['', '   ', 'abc', 'dev/one', 'dev one', 'dev?one', 'x'.repeat(65)]) {
    const result = await devices.requireApprovedDevice({ organizerUid: ORGANIZER, deviceId });
    assert.equal(result.code, 'DEVICE_ID_INVALID', `${JSON.stringify(deviceId)} is not an id`);
  }

  for (const organizerUid of ['', '   ', 'organizer/../x', 'x'.repeat(200)]) {
    const result = await devices.requireApprovedDevice({ organizerUid, deviceId: DEV_ONE });
    assert.equal(result.code, 'ORGANIZER_UID_INVALID');
  }
});

test('a banned, deactivated or absent organizer gets no device at all', async () => {
  const { db, devices } = harness();

  const cases = [
    [BANNED, 'ORGANIZER_BANNED'],
    [INACTIVE, 'ORGANIZER_INACTIVE'],
    [GHOST, 'NOT_AN_ORGANIZER']
  ];

  for (const [uid, code] of cases) {
    assert.equal((await devices.enrollFirstDevice({ organizerUid: uid, deviceId: DEV_ONE })).code,
      code, `${uid} cannot enroll`);
    assert.equal((await devices.requestReplacement({ organizerUid: uid, deviceId: DEV_TWO })).code,
      code, `${uid} cannot raise a request either`);
  }

  assert.equal((await db.collection(BINDINGS_COLLECTION).get()).size, 0);
  assert.equal((await db.collection(REQUESTS_COLLECTION).get()).size, 0,
    'and nothing was written on the way to being refused');
});

// ==========================================================================
// Recovery, and what a status may say
// ==========================================================================

test('admin recovery clears a lost device and leaves the history alone', async () => {
  const pendingId = requestIdFor({ organizerUid: ORGANIZER, deviceId: DEV_TWO });
  const { db, devices } = harness({
    bindings: { [ORGANIZER]: { organizerUid: ORGANIZER, deviceId: DEV_ONE, basis: 'first_enrollment' } },
    requests: {
      [pendingId]: { organizerUid: ORGANIZER, deviceId: DEV_TWO, status: REQUEST_STATUS.PENDING }
    }
  });

  const reasonless = await devices.resetBinding({ organizerUid: ORGANIZER, adminUid: ADMIN });
  assert.equal(reasonless.code, 'REASON_REQUIRED', 'removing something needs a reason');

  const nobody = await devices.resetBinding({
    organizerUid: ORGANIZER, reason: 'Lost in a train'
  });
  assert.equal(nobody.code, 'ADMIN_UID_REQUIRED');

  const reset = await devices.resetBinding({
    organizerUid: ORGANIZER, adminUid: ADMIN, reason: 'Reported the phone stolen'
  });
  assert.equal(reset.code, 'COMPLETE');
  assert.equal(reset.enrollmentAvailable, true,
    'the organizer can now enroll the phone they actually have');
  assert.equal(peek(db, BINDINGS_COLLECTION, ORGANIZER), undefined);

  assert.equal(peek(db, REQUESTS_COLLECTION, pendingId).status, REQUEST_STATUS.PENDING,
    'a pending request is left for an admin to judge: no automatic expiry was invented here');

  const logged = await rows(db, 'organizer_devices');
  const row = logged.find(entry => entry.actionType === 'binding_reset');
  assert.equal(row.payload.reason, 'Reported the phone stolen');
  assert.equal(row.performerId, ADMIN);

  const nothing = await devices.resetBinding({
    organizerUid: RIVAL, adminUid: ADMIN, reason: 'no binding to clear'
  });
  assert.equal(nothing.code, 'NO_BINDING');
});

test('a status never describes the approved device to a caller standing somewhere else', async () => {
  const { devices } = harness({
    bindings: { [ORGANIZER]: { organizerUid: ORGANIZER, deviceId: DEV_ONE, deviceLabel: 'Work Pixel' } }
  });

  const own = await devices.status({ organizerUid: ORGANIZER, deviceId: DEV_ONE });
  assert.equal(own.bound, true);
  assert.equal(own.matching, true);
  assert.equal(own.approvalRequired, false);
  assert.equal(own.device.deviceLabel, 'Work Pixel',
    'their own phone is not a secret from them');

  const stranger = await devices.status({ organizerUid: ORGANIZER, deviceId: DEV_TWO });
  assert.equal(stranger.bound, true);
  assert.equal(stranger.matching, false);
  assert.equal(stranger.approvalRequired, true);
  assert.equal(stranger.enrollmentAvailable, false,
    'a bound account cannot self-enroll, whatever a caller claims');
  assert.equal(stranger.device, null);
  assert.ok(!JSON.stringify(stranger).includes(DEV_ONE),
    'and the approved identifier is not in the answer at all');

  const unbound = await devices.status({ organizerUid: RIVAL, deviceId: DEV_TWO });
  assert.equal(unbound.enrollmentAvailable, true);
  assert.equal(unbound.bound, false);
});

test('a listing is bounded, newest first, and one organizer\'s rows only', async () => {
  const older = requestIdFor({ organizerUid: ORGANIZER, deviceId: DEV_ONE });
  const newer = requestIdFor({ organizerUid: RIVAL, deviceId: DEV_TWO });
  const { db, devices } = harness({
    requests: {
      [older]: { organizerUid: ORGANIZER, deviceId: DEV_ONE, status: REQUEST_STATUS.PENDING,
        requestedAt: new Date(Date.parse('2026-10-01T10:00:00.000Z')) },
      [newer]: { organizerUid: RIVAL, deviceId: DEV_TWO, status: REQUEST_STATUS.REJECTED,
        requestedAt: new Date(Date.parse('2026-10-20T10:00:00.000Z')) }
    }
  });

  const page = await devices.listRequests({});
  assert.deepEqual(page.requests.map(row => row.organizerUid), [RIVAL, ORGANIZER],
    'newest first');

  const onlyPending = await devices.listRequests({ status: REQUEST_STATUS.PENDING });
  assert.equal(onlyPending.requests.length, 1);
  assert.equal(onlyPending.requests[0].organizerUid, ORGANIZER);

  const forRival = await devices.listRequests({ organizerUid: RIVAL });
  assert.equal(forRival.requests.length, 1);
  assert.equal(forRival.requests[0].requestId, newer);

  const capped = await devices.listRequests({ limit: 1 });
  assert.equal(capped.requests.length, 1, 'a limit smaller than the collection is honoured');

  const absurd = await devices.listRequests({ limit: 5000 });
  assert.ok(absurd.code === 'COMPLETE', 'and an absurd page size is capped, not obeyed');
  assert.ok(absurd.requests.length <= 2, 'capped means capped: the whole collection is not read');
});

test('a row written by an earlier version still answers without an error', async () => {
  // A binding with no label, no basis and no previous device is what a partially-migrated record
  // looks like. It has to read as itself rather than throw in front of a screen.
  const { devices } = harness({
    bindings: { [ORGANIZER]: { organizerUid: ORGANIZER, deviceId: DEV_ONE } }
  });

  const gate = await devices.requireApprovedDevice({ organizerUid: ORGANIZER, deviceId: DEV_ONE });
  assert.equal(gate.ok, true);

  const binding = await devices.bindingOf({ organizerUid: ORGANIZER });
  assert.equal(binding.bound, true);
  assert.equal(binding.binding.deviceLabel, '');
  assert.equal(binding.binding.previousDeviceId, null);

  const rival = await devices.bindingOf({ organizerUid: RIVAL });
  assert.equal(rival.code, 'NO_BINDING');
  assert.equal(rival.bound, false);
});

test('with no audit trail wired, an operation still happens and says it was not recorded', async () => {
  const { devices } = harness({ withAudit: false });

  const enrolled = await devices.enrollFirstDevice({ organizerUid: ORGANIZER, deviceId: DEV_ONE });
  assert.equal(enrolled.code, 'COMPLETE');
  assert.equal(enrolled.auditRecorded, false,
    'a missing log is reported, never silently skipped');

  const raised = await devices.requestReplacement({
    organizerUid: ORGANIZER, deviceId: DEV_TWO
  });
  assert.equal(raised.code, 'COMPLETE');
  assert.equal(raised.auditRecorded, false);
});

test('the request id is the same function of the same pair, and not of anything else', () => {
  const id = requestIdFor({ organizerUid: ORGANIZER, deviceId: DEV_ONE });
  assert.equal(id, requestIdFor({ organizerUid: ORGANIZER, deviceId: DEV_ONE }),
    'a retry finds its own row');
  assert.notEqual(id, requestIdFor({ organizerUid: RIVAL, deviceId: DEV_ONE }),
    'two organizers on one phone are two requests');
  assert.notEqual(id, requestIdFor({ organizerUid: ORGANIZER, deviceId: DEV_TWO }),
    'one organizer on two phones is two requests');
  assert.doesNotMatch(id, /organizer-a|device-one/,
    'and neither identity appears inside a document id');
});
