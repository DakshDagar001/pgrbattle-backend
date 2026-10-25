/**
 * Organizer device binding and Admin approval (Phase 7).
 *
 * What this reuses
 * ----------------
 * PGR Battle already binds an account to a device: `devices/{hwid}` and `emulator_requests/{hwid}`
 * carry the player-side HWID check, the backend under `/api/emulator/*` owns those writes, the Admin
 * screen at `ui/security/EmulatorApprovalsActivity` decides them, and every decision is recorded in
 * `transcripts/hwid`. The identifier is `Settings.Secure.ANDROID_ID`, read by
 * `DeviceManager.getDeviceId()`. This file follows that architecture - same identifier, same
 * trusted-write shape, same audit trail - instead of inventing a second one beside it.
 *
 * It is deliberately not the same records. The player collections are keyed by device and answer a
 * different question ("is this emulator allowed to play"), and `devices/{hwid}` is readable by
 * anyone because signup has to check a binding before a user is authenticated. An organizer's
 * approval state must not be publicly enumerable, so this works on two collections of its own, and
 * the reason it needs them is the reason the rules for them matter:
 *
 *   organizer_device_bindings/{organizerUid}  the one device an organizer is currently on
 *   organizer_device_requests/{requestId}     a device asking to become that device
 *
 * A binding is keyed by the organizer, so "which device is approved" has exactly one answer and an
 * organizer cannot hold two. A request is keyed by the organizer *and* the device, which is what
 * makes a repeated request land on the same row instead of growing an uncontrolled queue.
 *
 * What this honestly cannot do
 * ----------------------------
 * The identifier is supplied by the app. There is no Play Integrity or hardware attestation
 * anywhere in this project and adding one is not part of this phase, so a client identifier is a
 * device *identifier* and never proof of hardware authenticity. What is enforced here is real - the
 * binding is read and written only by this backend, an organizer's client has no write path to it,
 * and a protected operation is refused by the service that performs it - but a modified client that
 * can read its own organizer's binding could replay that identifier from another phone. The
 * limitation is stated here, in the message that accompanies a refusal, and in the completion
 * report, rather than being papered over with a claim of hardware proof.
 */

const crypto = require('crypto');

const BINDINGS_COLLECTION = 'organizer_device_bindings';
const REQUESTS_COLLECTION = 'organizer_device_requests';

/** The three states a device request passes through. Only `pending` can be decided. */
const REQUEST_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected'
};

/**
 * How a binding came to exist, kept on the binding so a screen can say it plainly.
 * `first_enrollment` is the backward-compatible self-enrollment, `approved_request` is an Admin
 * decision, and `admin_recovery` means an Admin cleared a lost device and the organizer then
 * enrolled again.
 */
const ENROLLMENT_BASIS = {
  FIRST_ENROLLMENT: 'first_enrollment',
  APPROVED_REQUEST: 'approved_request',
  ADMIN_RECOVERY: 'admin_recovery'
};

/**
 * The same shape the existing HWID check accepts: a non-empty alphanumeric identifier of 6 to 64
 * characters. ANDROID_ID is a 16-character hex string, so this admits every real device and refuses
 * a blank, a word somebody typed, or a payload stuffed with a longer string.
 */
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{6,64}$/;

/** A document id has to stay in the character set the rest of the phase already writes. */
const SAFE_ID = /^[A-Za-z0-9_:.-]{1,150}$/;

/** A reason an admin writes has to be readable in a list and short enough to stay one. */
const MAX_REASON = 300;
const MAX_LABEL = 80;
const MAX_PAGE_SIZE = 100;

function trim(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function refused(code, message, extra = {}) {
  return { code, message, applied: false, ...extra };
}

/**
 * One line of device metadata.
 *
 * A model name and a manufacturer are what an admin needs to tell two phones apart. A build
 * fingerprint is a stable hardware identifier of exactly the kind this project's rules avoid, and a
 * serial is not readable by an app on any modern Android anyway, so nothing here tries to collect
 * either: the label is a display string, and the identifier alone decides identity - which is also
 * what stops a harmless metadata change from becoming a new device.
 */
function labelOf(deviceLabel) {
  return trim(deviceLabel).replace(/\s+/g, ' ').slice(0, MAX_LABEL);
}

function reasonError(raw) {
  const reason = trim(raw);
  if (!reason) return 'A decision about a device has to say why.';
  if (reason.length > MAX_REASON) return 'That reason is too long to record.';
  return null;
}

/**
 * The request's document id, derived from the organizer and the device and nothing else.
 *
 * Two organizers asking for the same physical phone get different rows, and one organizer asking
 * three times from the same phone gets one row. Both halves are required by the phase: a random id
 * per submission would turn "repeated requests from one device" into a queue that grows every time
 * a screen is reopened. Both parts are digested, so a long uid and a raw device identifier never
 * appear inside a document id.
 */
function requestIdFor({ organizerUid, deviceId }) {
  const digest = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
  return `dev_${digest(trim(organizerUid))}_${digest(trim(deviceId))}`;
}

/**
 * A written event time as milliseconds, or null when the write has not resolved yet.
 *
 * A document created moments ago still carries the server-timestamp sentinel on the read that
 * happens inside the same request, and a sentinel is not a time; saying null keeps a screen from
 * printing "1 Jan 1970" for a device that was just approved.
 */
function timeOf(value) {
  if (!value) return null;
  if (typeof value.toMillis === 'function') {
    const ms = value.toMillis();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value.seconds === 'number') {
    return value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1e6);
  }
  return null;
}

/**
 * @param {object} deps
 * @param {object} deps.db                Firestore handle (Admin SDK) - the only writer
 * @param {Function} deps.serverTimestamp the server clock behind every written event
 * @param {object} [deps.audit]           `createAuditTrail()`; with none wired, nothing is recorded
 *                                        and every result says so - an operation never fails
 */
function createOrganizerDeviceService({ db, serverTimestamp, audit = null } = {}) {
  if (!db || !serverTimestamp) {
    throw new Error('createOrganizerDeviceService requires db and serverTimestamp');
  }

  const bindingRefOf = uid => db.collection(BINDINGS_COLLECTION).doc(uid);
  const requestRefOf = id => db.collection(REQUESTS_COLLECTION).doc(id);

  /** The binding as an answer, never as a stored document: only the fields a screen may see. */
  function bindingView(data) {
    return {
      organizerUid: trim(data.organizerUid),
      deviceId: trim(data.deviceId),
      deviceLabel: trim(data.deviceLabel),
      boundAt: timeOf(data.boundAt),
      boundBy: trim(data.boundBy),
      basis: trim(data.basis),
      viaRequestId: trim(data.viaRequestId) || null,
      previousDeviceId: trim(data.previousDeviceId) || null
    };
  }

  function requestView(id, data) {
    return {
      requestId: id,
      organizerUid: trim(data.organizerUid),
      deviceId: trim(data.deviceId),
      deviceLabel: trim(data.deviceLabel),
      status: trim(data.status) || REQUEST_STATUS.PENDING,
      requestedAt: timeOf(data.requestedAt),
      decidedAt: timeOf(data.decidedAt),
      decidedBy: trim(data.decidedBy) || null,
      reason: trim(data.reason) || null,
      // Which device was approved when this was asked for. An admin deciding a request months old
      // needs to know they are looking at the phone that replaced the one on the record now.
      approvedDeviceAtRequest: trim(data.approvedDeviceAtRequest) || null
    };
  }

  /**
   * A registered organizer that is allowed to be using an app at all.
   *
   * The same three answers the withdrawal service gives, on purpose: an account that is banned or
   * deactivated is refused a device operation exactly where it is refused a withdrawal, so a device
   * binding can never become a side door around the rest of the system. A removed account - no
   * document at all - is not an organizer, and no binding is created for it.
   */
  async function organizerError(uid) {
    const snapshot = await db.collection('organizer_users').doc(uid).get();
    if (!snapshot.exists) {
      return refused('NOT_AN_ORGANIZER', 'Only a registered organizer can bind a device.');
    }
    const data = (snapshot.data && snapshot.data()) || {};
    if (data.banned === true) return refused('ORGANIZER_BANNED', 'This organizer account is banned.');
    if (data.isActive === false) {
      return refused('ORGANIZER_INACTIVE', 'This organizer account is deactivated.');
    }
    return null;
  }

  function callerError(organizerUid, deviceId) {
    const uid = trim(organizerUid);
    if (!uid || uid.length > 128 || !SAFE_ID.test(uid)) {
      return refused('ORGANIZER_UID_INVALID', 'A valid organizer account is required.');
    }
    if (!DEVICE_ID_PATTERN.test(trim(deviceId))) {
      return refused('DEVICE_ID_INVALID',
        'This device could not be identified. Sign in again and retry.');
    }
    return null;
  }

  /**
   * Where this device stands - the only question an organizer's app is allowed to ask.
   *
   * Nothing about another organizer, and nothing about a device this caller does not hold, comes
   * back: an unbound caller is told enrollment is available, a mismatched caller is told a request
   * is pending or that approval is needed, and never what the approved identifier actually is. That
   * matters because this answer is served to a client that has not yet proven anything about itself.
   */
  async function status({ organizerUid, deviceId } = {}) {
    const invalid = callerError(organizerUid, deviceId);
    if (invalid) return invalid;

    const uid = trim(organizerUid);
    const device = trim(deviceId);

    try {
      const [bindingSnap, requestSnap] = await Promise.all([
        bindingRefOf(uid).get(),
        requestRefOf(requestIdFor({ organizerUid: uid, deviceId: device })).get()
      ]);

      const binding = bindingSnap.exists ? bindingSnap.data() || {} : null;
      const request = requestSnap.exists ? requestSnap.data() || {} : null;
      const requestStatus = request ? trim(request.status) || REQUEST_STATUS.PENDING : null;
      const matching = Boolean(binding) && trim(binding.deviceId) === device;

      return {
        code: 'COMPLETE',
        organizerUid: uid,
        bound: Boolean(binding),
        matching,
        // No binding at all is the legacy and the reinstall case, and it is the one case this phase
        // lets the organizer solve themselves. It is reported as an available action, never as a
        // failure, so no organizer is ever told they are locked out of a device nobody approved.
        enrollmentAvailable: !binding,
        approvalRequired: Boolean(binding) && !matching,
        pendingRequestId: !matching && requestStatus === REQUEST_STATUS.PENDING
          ? requestSnap.id : null,
        requestStatus,
        // Only the caller's own device is described back to them, and only when it is the approved
        // one: the label of the phone they are standing on is not a secret from them.
        device: matching && binding ? bindingView(binding) : null
      };
    } catch (error) {
      console.error('[OrganizerDevices] Status read failed:', error.message);
      return refused('TRANSIENT_FAILURE', 'The device approval status could not be read.',
        { retryable: true });
    }
  }

  /**
   * The first device for an account that has never had one.
   *
   * Why self-enrollment exists at all: every organizer in this project today has no binding, so a
   * rule of "an admin approves every device" would lock each of them out on their next app start -
   * the outcome the phase explicitly forbids. The cost of that choice is stated in the header and
   * carried in this response: an unbound account's first device is trusted, because there is no
   * earlier record to compare it against. Once a binding exists this call refuses, so it can never
   * be used to replace an approved device - that path goes through `requestReplacement` and an admin.
   */
  async function enrollFirstDevice({ organizerUid, deviceId, deviceLabel } = {}) {
    const invalid = callerError(organizerUid, deviceId);
    if (invalid) return invalid;

    const uid = trim(organizerUid);
    const device = trim(deviceId);
    const label = labelOf(deviceLabel);
    const notOrganizer = await organizerError(uid);
    if (notOrganizer) return notOrganizer;

    const binding = bindingRefOf(uid);
    const request = requestRefOf(requestIdFor({ organizerUid: uid, deviceId: device }));

    try {
      // Every read happens before every write, which is what a real Firestore transaction requires
      // and what makes "one binding per organizer, decided once" hold when two phones enroll at
      // the same moment.
      const outcome = await db.runTransaction(async transaction => {
        const existing = await transaction.get(binding);
        const asked = await transaction.get(request);

        if (existing.exists) {
          const data = existing.data() || {};
          if (trim(data.deviceId) === device) {
            // The approved device asking again: metadata refreshed, no new enrollment, no request.
            transaction.set(binding, { deviceLabel: label, updatedAt: serverTimestamp() },
              { merge: true });
            return { kind: 'already_bound', binding: bindingView(data) };
          }
          // A different device on an account that already has one is a replacement, and a
          // replacement is an admin's decision. Refusing here is the whole anti-takeover rule.
          return { kind: 'replacement_required' };
        }

        transaction.set(binding, {
          organizerUid: uid,
          deviceId: device,
          deviceLabel: label,
          basis: ENROLLMENT_BASIS.FIRST_ENROLLMENT,
          boundBy: uid,
          boundAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
          viaRequestId: null,
          previousDeviceId: null
        });

        // A pending request for the very device now in use is closed by the enrollment itself, so
        // an admin is never left queueing to approve a device that has already become the binding.
        if (asked.exists && trim((asked.data() || {}).status) === REQUEST_STATUS.PENDING) {
          transaction.set(request, {
            status: REQUEST_STATUS.APPROVED,
            decidedAt: serverTimestamp(),
            decidedBy: 'self_enrollment',
            reason: 'Closed by first-device enrollment',
            updatedAt: serverTimestamp()
          }, { merge: true });
        }
        return { kind: 'enrolled' };
      });

      if (outcome.kind === 'replacement_required') {
        return refused('REPLACEMENT_REQUIRES_APPROVAL',
          'This account already has an approved device. Replacing it needs an administrator.',
          { approvalRequired: true });
      }

      const fresh = await binding.get();
      const view = bindingView((fresh.exists && fresh.data()) || {});

      if (outcome.kind === 'already_bound') {
        return { code: 'COMPLETE', applied: false, matching: true, binding: outcome.binding,
          message: 'This device is already the approved one.' };
      }

      const logged = audit
        ? await audit.record({
          section: 'organizer_devices',
          actionType: 'enrolled',
          title: 'Organizer first device enrolled',
          payload: { organizerUid: uid, deviceId: device, deviceLabel: view.deviceLabel,
            outcome: 'enrolled', basis: ENROLLMENT_BASIS.FIRST_ENROLLMENT },
          performedBy: 'organizer',
          performerId: uid
        })
        : { recorded: false, error: 'no audit trail wired' };

      return { code: 'COMPLETE', applied: true, matching: true, binding: view,
        auditRecorded: logged.recorded,
        message: 'This device is now this organizer\'s approved device.' };
    } catch (error) {
      console.error('[OrganizerDevices] Enrollment failed:', error.message);
      return refused('TRANSIENT_FAILURE', 'The device could not be enrolled.',
        { retryable: true });
    }
  }

  /**
   * A device asking to replace the approved one. This never approves anything.
   *
   * The row is keyed on organizer + device, so the flow is idempotent by construction: asking again
   * while a request is pending returns the request that already exists, asking again after a
   * rejection reopens that same row - which is exactly how the existing rejected-emulator flow
   * behaves - and an organizer with five phones has five rows, not fifty.
   */
  async function requestReplacement({ organizerUid, deviceId, deviceLabel } = {}) {
    const invalid = callerError(organizerUid, deviceId);
    if (invalid) return invalid;

    const uid = trim(organizerUid);
    const device = trim(deviceId);
    const label = labelOf(deviceLabel);
    const notOrganizer = await organizerError(uid);
    if (notOrganizer) return notOrganizer;

    const id = requestIdFor({ organizerUid: uid, deviceId: device });
    if (!SAFE_ID.test(id)) return refused('REQUEST_ID_INVALID', 'That device cannot be recorded.');

    const ref = requestRefOf(id);
    const bindingSnap = await bindingRefOf(uid).get();

    // Nothing to replace means the enrollment path is the right one, and that path carries the
    // organizer's own consent in it. Falling through here would let an unbound account skip it.
    if (!bindingSnap.exists) {
      return refused('ENROLLMENT_AVAILABLE',
        'This account has no approved device yet, so this one can be enrolled.',
        { enrollmentAvailable: true });
    }

    const binding = bindingSnap.data() || {};
    if (trim(binding.deviceId) === device) {
      // The approved device, with possibly newer metadata. A metadata change is not a new device,
      // so the label is refreshed and a match is reported instead of raising a request.
      await bindingRefOf(uid).set({ deviceLabel: label, updatedAt: serverTimestamp() },
        { merge: true });
      return { code: 'COMPLETE', applied: false, matching: true, binding: bindingView(binding),
        message: 'This is already the approved device.' };
    }

    const staged = {
      organizerUid: uid,
      deviceId: device,
      deviceLabel: label,
      approvedDeviceAtRequest: trim(binding.deviceId),
      requestedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    };

    const existingSnap = await ref.get();
    if (existingSnap.exists) {
      const record = existingSnap.data() || {};
      const current = trim(record.status) || REQUEST_STATUS.PENDING;

      if (current === REQUEST_STATUS.PENDING) {
        // A repeat of a request that is still waiting: the same row and the same queue position,
        // with the metadata refreshed so an admin sees the phone as it is described today.
        await ref.set({ ...staged, status: REQUEST_STATUS.PENDING }, { merge: true });
        const after = await ref.get();
        return { code: 'COMPLETE', applied: false, duplicate: true, requestId: id,
          status: REQUEST_STATUS.PENDING, pending: true,
          request: requestView(id, after.data() || {}),
          message: 'This device is already waiting for an administrator.' };
      }

      // Decided before and asked again. Reopening the same row keeps one history per device instead
      // of an endless series of new ones; the earlier decision stays readable in the audit trail.
      await ref.set({ ...staged, status: REQUEST_STATUS.PENDING, decidedAt: null, decidedBy: null,
        reason: null }, { merge: true });
      const reopened = requestView(id, (await ref.get()).data() || {});

      const logged = audit
        ? await audit.record({
          section: 'organizer_devices',
          actionType: 'requested_again',
          title: 'Organizer device request reopened',
          payload: { organizerUid: uid, requestId: id, deviceId: device, previousStatus: current,
            outcome: REQUEST_STATUS.PENDING },
          performedBy: 'organizer',
          performerId: uid
        })
        : { recorded: false };

      return { code: 'COMPLETE', applied: true, reopened: true, requestId: id, pending: true,
        status: REQUEST_STATUS.PENDING, request: reopened, auditRecorded: logged.recorded,
        message: 'The request for this device is open again for an administrator.' };
    }

    // `create()` and not `set()`: two apps signing in on the same new device in the same moment must
    // produce one request, and the loser reads the row that won instead of writing over it.
    try {
      await ref.create({ ...staged, status: REQUEST_STATUS.PENDING, decidedAt: null,
        decidedBy: null, reason: null });
    } catch (error) {
      if (error.code !== 6 && error.code !== 'already-exists') {
        console.error('[OrganizerDevices] Request write failed:', error.message);
        return refused('TRANSIENT_FAILURE', 'The device request could not be submitted.',
          { retryable: true });
      }
      const raced = await ref.get();
      const record = (raced.exists && raced.data()) || {};
      return { code: 'COMPLETE', applied: false, duplicate: true, requestId: id,
        status: trim(record.status) || REQUEST_STATUS.PENDING, pending: true,
        request: requestView(id, record),
        message: 'This device is already waiting for an administrator.' };
    }

    const created = requestView(id, (await ref.get()).data() || {});
    const logged = audit
      ? await audit.record({
        section: 'organizer_devices',
        actionType: 'requested',
        title: 'Organizer device change requested',
        payload: { organizerUid: uid, requestId: id, deviceId: device, deviceLabel: label,
          approvedDeviceId: created.approvedDeviceAtRequest, outcome: REQUEST_STATUS.PENDING },
        performedBy: 'organizer',
        performerId: uid
      })
      : { recorded: false };

    return { code: 'COMPLETE', applied: true, requestId: id, pending: true,
      status: REQUEST_STATUS.PENDING, request: created, auditRecorded: logged.recorded,
      message: 'An administrator has to approve this device before it can be used.' };
  }

  /**
   * Approve one pending request, in one transaction, once.
   *
   * The binding and the request move together or not at all, which is the only way two admins
   * opening the same queue cannot produce two answers: the loser of the race re-reads a request
   * that has already left `pending` and is told it was already processed. Approving rebinds the
   * organizer to the requested device and records the device it replaced, so "recover a legitimate
   * account whose previous device is lost" is an approval like any other rather than a special path.
   */
  async function approveRequest({ requestId, adminUid, adminEmail } = {}) {
    const id = trim(requestId);
    if (!id || !SAFE_ID.test(id)) {
      return refused('REQUEST_ID_INVALID', 'The device request to approve has to be named.');
    }
    const reviewer = trim(adminUid);
    if (!reviewer) return refused('ADMIN_UID_REQUIRED', 'A decision needs an administrator.');

    const ref = requestRefOf(id);
    try {
      const outcome = await db.runTransaction(async transaction => {
        const asked = await transaction.get(ref);
        if (!asked.exists) return { kind: 'not_found' };

        const record = asked.data() || {};
        const uid = trim(record.organizerUid);
        const device = trim(record.deviceId);

        if (trim(record.status) !== REQUEST_STATUS.PENDING) {
          return { kind: 'already_processed', request: requestView(id, record) };
        }
        if (!uid) return { kind: 'broken', code: 'ORGANIZER_UID_INVALID',
          message: 'That request names no organizer, so nothing can be approved.' };
        if (!DEVICE_ID_PATTERN.test(device)) {
          return { kind: 'broken', code: 'DEVICE_ID_INVALID',
            message: 'That request does not carry a usable device identifier.' };
        }

        // Read after the request is known to be about somebody: the binding it will move and the
        // account it will act for are both needed before anything can be written, and a Firestore
        // transaction allows no read once its writes have started.
        const binding = await transaction.get(bindingRefOf(uid));
        const account = await transaction.get(db.collection('organizer_users').doc(uid));
        const accountData = (account.exists && account.data()) || {};

        if (!account.exists) {
          return { kind: 'broken', code: 'NOT_AN_ORGANIZER',
            message: 'That organizer account no longer exists.' };
        }
        if (accountData.banned === true) {
          return { kind: 'broken', code: 'ORGANIZER_BANNED',
            message: 'A banned organizer account cannot be given a device.' };
        }
        if (accountData.isActive === false) {
          return { kind: 'broken', code: 'ORGANIZER_INACTIVE',
            message: 'A deactivated organizer account cannot be given a device.' };
        }

        const previous = (binding.exists && binding.data()) || {};
        transaction.set(bindingRefOf(uid), {
          organizerUid: uid,
          deviceId: device,
          deviceLabel: trim(record.deviceLabel) || '',
          basis: ENROLLMENT_BASIS.APPROVED_REQUEST,
          boundBy: reviewer,
          boundAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
          viaRequestId: id,
          previousDeviceId: trim(previous.deviceId) || null
        }, { merge: true });

        transaction.set(ref, {
          status: REQUEST_STATUS.APPROVED,
          decidedAt: serverTimestamp(),
          decidedBy: reviewer,
          reason: '',
          updatedAt: serverTimestamp()
        }, { merge: true });

        return { kind: 'approved', previousDeviceId: trim(previous.deviceId) || null };
      });

      if (outcome.kind === 'not_found') {
        return refused('NOT_FOUND', 'That device request does not exist.');
      }
      if (outcome.kind === 'already_processed') {
        return refused('ALREADY_PROCESSED',
          'That device request has already been decided, so nothing was changed.',
          { request: outcome.request });
      }
      if (outcome.kind === 'broken') {
        return refused(outcome.code, outcome.message);
      }

      const after = await ref.get();
      const logged = audit
        ? await audit.record({
          section: 'organizer_devices',
          actionType: 'approved',
          title: 'Organizer device approved',
          payload: { organizerUid: trim((after.data() || {}).organizerUid), requestId: id,
            deviceId: trim((after.data() || {}).deviceId),
            previousDeviceId: outcome.previousDeviceId, outcome: REQUEST_STATUS.APPROVED },
          performedBy: 'admin',
          performerId: reviewer,
          performerEmail: trim(adminEmail)
        })
        : { recorded: false, error: 'no audit trail wired' };

      return { code: 'COMPLETE', applied: true, requestId: id,
        request: requestView(id, after.data() || {}),
        previousDeviceId: outcome.previousDeviceId, auditRecorded: logged.recorded,
        message: 'This device is now the organizer\'s approved device.' };
    } catch (error) {
      console.error('[OrganizerDevices] Approval failed:', error.message);
      return refused('TRANSIENT_FAILURE', 'The device could not be approved.',
        { retryable: true });
    }
  }

  /**
   * Reject one pending request. The approved binding is not read for a write and not touched.
   *
   * A rejection answers one request; it does not un-bind anybody from anything. Keeping the binding
   * out of the write set is what makes "rejection must preserve the previous approved binding" true
   * by construction instead of true because a test happens to pass.
   */
  async function rejectRequest({ requestId, adminUid, reason, adminEmail } = {}) {
    const id = trim(requestId);
    if (!id || !SAFE_ID.test(id)) {
      return refused('REQUEST_ID_INVALID', 'The device request to reject has to be named.');
    }
    const reviewer = trim(adminUid);
    if (!reviewer) return refused('ADMIN_UID_REQUIRED', 'A decision needs an administrator.');

    const problem = reasonError(reason);
    if (problem) return refused('REASON_REQUIRED', problem);

    const ref = requestRefOf(id);
    try {
      const outcome = await db.runTransaction(async transaction => {
        const asked = await transaction.get(ref);
        if (!asked.exists) return { kind: 'not_found' };

        const record = asked.data() || {};
        if (trim(record.status) !== REQUEST_STATUS.PENDING) {
          return { kind: 'already_processed', request: requestView(id, record) };
        }

        transaction.set(ref, {
          status: REQUEST_STATUS.REJECTED,
          decidedAt: serverTimestamp(),
          decidedBy: reviewer,
          reason: trim(reason),
          updatedAt: serverTimestamp()
        }, { merge: true });
        return { kind: 'rejected', organizerUid: trim(record.organizerUid),
          deviceId: trim(record.deviceId) };
      });

      if (outcome.kind === 'not_found') return refused('NOT_FOUND', 'That device request does not exist.');
      if (outcome.kind === 'already_processed') {
        return refused('ALREADY_PROCESSED',
          'That device request has already been decided, so nothing was changed.',
          { request: outcome.request });
      }

      const after = await ref.get();
      const logged = audit
        ? await audit.record({
          section: 'organizer_devices',
          actionType: 'rejected',
          title: 'Organizer device rejected',
          payload: { organizerUid: outcome.organizerUid, requestId: id,
            deviceId: outcome.deviceId, reason: trim(reason),
            outcome: REQUEST_STATUS.REJECTED },
          performedBy: 'admin',
          performerId: reviewer,
          performerEmail: trim(adminEmail)
        })
        : { recorded: false, error: 'no audit trail wired' };

      return { code: 'REJECTED', applied: true, requestId: id,
        request: requestView(id, after.data() || {}), auditRecorded: logged.recorded,
        message: 'The request was rejected. The approved device is unchanged.' };
    } catch (error) {
      console.error('[OrganizerDevices] Rejection failed:', error.message);
      return refused('TRANSIENT_FAILURE', 'The device request could not be rejected.',
        { retryable: true });
    }
  }

  /**
   * Admin-assisted recovery: clear a binding so the organizer can enroll the device they have.
   *
   * This is the existing HWID-reset idea, applied to organizers: a lost or damaged device, or a
   * cleared app data directory, leaves an organizer pointing at a phone that no longer exists, and
   * the only safe way back is a human decision. It removes the binding and nothing else - coins,
   * wallet, permissions, the request history and every audit row all stay exactly as they were, and
   * pending requests stay pending for an admin to judge, because inventing an automatic expiry is
   * not this phase's to decide.
   */
  async function resetBinding({ organizerUid, adminUid, reason, adminEmail } = {}) {
    const uid = trim(organizerUid);
    if (!uid || !SAFE_ID.test(uid)) {
      return refused('ORGANIZER_UID_INVALID', 'The organizer to recover has to be named.');
    }
    const reviewer = trim(adminUid);
    if (!reviewer) return refused('ADMIN_UID_REQUIRED', 'A recovery needs an administrator.');

    const problem = reasonError(reason);
    if (problem) return refused('REASON_REQUIRED', problem);

    const ref = bindingRefOf(uid);
    try {
      const outcome = await db.runTransaction(async transaction => {
        const binding = await transaction.get(ref);
        if (!binding.exists) return { kind: 'no_binding' };
        const data = binding.data() || {};
        transaction.delete(ref);
        return { kind: 'reset', deviceId: trim(data.deviceId),
          deviceLabel: trim(data.deviceLabel), basis: trim(data.basis) };
      });

      if (outcome.kind === 'no_binding') {
        return refused('NO_BINDING', 'This organizer has no approved device to clear.');
      }

      const logged = audit
        ? await audit.record({
          section: 'organizer_devices',
          actionType: 'binding_reset',
          title: 'Organizer device binding reset',
          payload: { organizerUid: uid, previousDeviceId: outcome.deviceId,
            previousLabel: outcome.deviceLabel, reason: trim(reason), outcome: 'reset' },
          performedBy: 'admin',
          performerId: reviewer,
          performerEmail: trim(adminEmail)
        })
        : { recorded: false, error: 'no audit trail wired' };

      return { code: 'COMPLETE', applied: true, organizerUid: uid, enrollmentAvailable: true,
        previousDeviceId: outcome.deviceId, auditRecorded: logged.recorded,
        message: 'The binding was cleared, so this organizer can enroll their new device.' };
    } catch (error) {
      console.error('[OrganizerDevices] Reset failed:', error.message);
      return refused('TRANSIENT_FAILURE', 'The device binding could not be cleared.',
        { retryable: true });
    }
  }

  /**
   * The gate a protected operation asks before it does any work.
   *
   * `deviceId` reaches this from a header the app sets, never from a body an organizer composes, and
   * the organizer is always the authenticated uid. Three answers are possible and only one of them
   * lets work proceed: an app that has never enrolled is told to enroll, an app on a device nobody
   * approved is refused with whatever the admin needs to know, and an app on the approved device
   * gets on with the request.
   */
  async function requireApprovedDevice({ organizerUid, deviceId } = {}) {
    const invalid = callerError(organizerUid, deviceId);
    if (invalid) return invalid;

    const uid = trim(organizerUid);
    const device = trim(deviceId);

    try {
      const bindingSnap = await bindingRefOf(uid).get();
      if (!bindingSnap.exists) {
        return refused('ENROLLMENT_REQUIRED',
          'This organizer has no approved device yet. Enroll this device first.',
          { enrollmentAvailable: true });
      }

      const binding = bindingSnap.data() || {};
      if (trim(binding.deviceId) === device) {
        return { code: 'COMPLETE', ok: true, applied: true, matching: true };
      }

      const askedSnap = await requestRefOf(requestIdFor({ organizerUid: uid, deviceId: device })).get();
      const asked = (askedSnap.exists && askedSnap.data()) || {};
      const pending = askedSnap.exists && trim(asked.status) === REQUEST_STATUS.PENDING;

      return refused('DEVICE_NOT_APPROVED',
        pending
          ? 'This device is waiting for an administrator to approve it.'
          : 'This device is not the approved device for this organizer.',
        { approvalRequired: true, pendingRequestId: pending ? askedSnap.id : null,
          requestedAt: pending ? timeOf(asked.requestedAt) : null });
    } catch (error) {
      console.error('[OrganizerDevices] Device check failed:', error.message);
      return refused('TRANSIENT_FAILURE', 'This device could not be checked.',
        { retryable: true });
    }
  }

  /** The approved binding for one organizer, or none. Readable by an admin route, never by a client. */
  async function bindingOf({ organizerUid } = {}) {
    const uid = trim(organizerUid);
    if (!uid || !SAFE_ID.test(uid)) return refused('ORGANIZER_UID_INVALID', 'An organizer is required.');
    const snapshot = await bindingRefOf(uid).get();
    if (!snapshot.exists) return { code: 'NO_BINDING', organizerUid: uid, bound: false };
    return { code: 'COMPLETE', bound: true, organizerUid: uid,
      binding: bindingView(snapshot.data() || {}) };
  }

  /**
   * A bounded page of requests, newest first.
   *
   * Firestore will not serve an equality filter combined with an ordering on a different field, or
   * two equality filters, without a composite index - and this project has none for these
   * collections. So exactly one shape is pushed down to the server and the rest is done here, in the
   * same order the withdrawal listings use:
   *
   * - one organizer: ask the server for that organizer's rows. This is the case that must not be
   *   filtered in memory, because a globally newest page would silently omit a request that is real
   *   but older than the cap - an organizer's own history screen would show nothing;
   * - one status: ask the server for that status, which is the admin queue;
   * - neither: an unfiltered newest-first read, which a single-field index already covers.
   *
   * Whatever comes back is sorted newest-first in memory and the limit is always applied by the
   * server, so no call here can turn into a collection dump.
   */
  async function listRequests({ status = '', organizerUid = '', limit = 50 } = {}) {
    const cap = Math.min(Math.max(Number(limit) || 0, 1), MAX_PAGE_SIZE);
    const wanted = trim(status);
    const filterBy = trim(organizerUid);
    const byStatus = ['pending', 'approved', 'rejected'].includes(wanted);

    let query = db.collection(REQUESTS_COLLECTION);
    if (filterBy) query = query.where('organizerUid', '==', filterBy);
    else if (byStatus) query = query.where('status', '==', wanted);
    if (!filterBy && !byStatus) query = query.orderBy('requestedAt', 'desc');

    const snapshot = await query.limit(cap).get();
    const requests = [];

    for (const doc of snapshot.docs || []) {
      const data = doc.data() || {};
      const view = requestView(doc.id, data);
      // Both guards read the view rather than the raw fields: a row whose status is missing is
      // treated as pending everywhere else, and a listing must agree with what a screen will show.
      // The organizer guard is a belt for a database that ignored the filter it was given.
      if (filterBy && view.organizerUid !== filterBy) continue;
      if (byStatus && view.status !== wanted) continue;
      requests.push(view);
    }

    requests.sort((left, right) => (right.requestedAt || 0) - (left.requestedAt || 0));
    return { code: 'COMPLETE', status: wanted || 'all', requests, count: requests.length };
  }

  return {
    BINDINGS_COLLECTION,
    REQUESTS_COLLECTION,
    REQUEST_STATUS,
    ENROLLMENT_BASIS,
    status,
    enrollFirstDevice,
    requestReplacement,
    approveRequest,
    rejectRequest,
    resetBinding,
    requireApprovedDevice,
    bindingOf,
    listRequests,
    requestIdFor
  };
}

module.exports = {
  createOrganizerDeviceService,
  BINDINGS_COLLECTION,
  REQUESTS_COLLECTION,
  REQUEST_STATUS,
  ENROLLMENT_BASIS,
  requestIdFor
};
