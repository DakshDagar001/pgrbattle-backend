/**
 * Organizer withdrawal requests.
 *
 * Organizer coins are not rupees. Nothing in this file converts them, quotes a cash value,
 * talks to a payment gateway or moves a rupee balance, and nothing here reads or writes a
 * player's `depositBalance`, `bonusBalance` or `wonBalance`. A request is an organizer asking
 * the platform to pay them out of the coins they hold, and the only thing this backend does
 * with that ask is reserve the coins so they cannot be spent twice, then record whether an
 * admin agreed that the payout should happen. Whether money actually leaves the company is a
 * human decision made outside this code, so an approval is recorded as an accounting
 * decision and never as a completed bank transfer.
 *
 * ## The shape of the money
 *
 * `organizerEconomy.js` owns the balance. This service owns the request document, and it
 * only ever moves coins through those primitives:
 *
 *   - creating a request reserves the amount (`reserveFunds`), which takes the coins out of
 *     `availableBalance` and puts them in `reservedBalance`. An organizer cannot withdraw,
 *     and cannot be penalized out of, the same coins twice.
 *   - approving finalizes that exact hold (`finalizeReservation`). Nothing is deducted a
 *     second time, because the coins already left the available side when the hold opened.
 *   - rejecting releases it (`releaseReservation`), restoring the amount to available
 *     balance exactly once.
 *
 * Each of those is idempotent on a deterministic key derived from the request id, so a
 * double tap, a retry after a dropped connection and two admins working on the same request
 * all land on the same ledger document.
 *
 * ## Why there is no single transaction
 *
 * A request document and a ledger entry are two Firestore writes, and the economy service
 * will not let anything else run inside its transaction. So the request carries its own
 * stage instead: `awaiting_reservation` is written first, the reservation is attempted, and
 * only a successful (or already-recorded) reservation moves the document to `pending`. Any
 * operation that finds a request still `awaiting_reservation` resumes the reservation with
 * the same deterministic key rather than guessing. The states a request can reach from a
 * half-finished create are therefore all reachable forward, and none of them leaves coins
 * held with no request explaining why.
 *
 * ## What is never trusted
 *
 * The organizer uid comes from the verified ID token, the reviewer uid comes from the
 * verified ID token, and the amount a request pays is the amount stored on the request when
 * it was created - never a value read back off a later request body. Balances, reservation
 * states and reviewer identities supplied by a client are ignored.
 */

const crypto = require('crypto');

const REQUESTS_COLLECTION = 'organizer_withdrawal_requests';

/** The states a request passes through. Only `pending` can be reviewed. */
const REQUEST_STATUS = {
  AWAITING_RESERVATION: 'awaiting_reservation',
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  RESERVATION_FAILED: 'reservation_failed'
};

/** The two decisions an admin can make, and the only two this service accepts. */
const DECISIONS = { APPROVE: 'approve', REJECT: 'reject' };

/**
 * A payout that no gateway performed. Kept on the record rather than left to a comment,
 * because an approved row that reads like a paid row is how money gets double-paid.
 */
const PAYOUT_MANUAL = 'manual_admin_review';

/**
 * A retry has to find the same request, so the client names it once and keeps the name.
 * The pattern is a uuid with dashes, a uuid, or any similar opaque string: long enough not
 * to be guessed, short enough to sit inside a document id.
 */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * The payout handle. A UPI id is `name@psp`; nothing else is accepted, because this field is
 * the only thing an admin has to work with when they pay somebody. A PIN, a password or any
 * other credential is not a payout handle and is refused rather than stored.
 */
const UPI_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,63}@[a-zA-Z]{2,64}$/;

const SAFE_ID = /^[A-Za-z0-9_:.-]{1,150}$/;

/** The same coin ceiling the economy service, the Admin screen and the rules enforce. */
const MAX_AMOUNT = 100000;

/** How many requests one listing returns, so a review screen cannot ask for the collection. */
const MAX_PAGE_SIZE = 100;

/**
 * When something happened, as milliseconds since the epoch, or null when it is not yet known.
 *
 * A document written moments ago still holds the server-timestamp sentinel on the read that
 * happens inside the same request, and a sentinel is not a time. Reporting it as null keeps a
 * review screen from showing "1 Jan 1970" for a withdrawal that was just made.
 */
function timeOr(value) {
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

function trim(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function refused(code, message, extra = {}) {
  return { code, message, applied: false, ...extra };
}

/**
 * The request's own document id.
 *
 * The token is what makes a retry land on the same row, so the id has to be a function of
 * the token and of the organizer the token was issued for - a second organizer who happens
 * to reuse a token must not read the first one's request. The uid is folded to a short
 * digest so a long uid cannot push the id past Firestore's limits, and so a payout document
 * id does not spell out an account identifier.
 */
function requestIdFor({ organizerUid, token }) {
  const digest = crypto.createHash('sha256').update(trim(organizerUid)).digest('hex').slice(0, 12);
  return `wd_${digest}_${token}`;
}

const reservationKeyFor = requestId => `reserve:${requestId}`;

/** Coins the economy can actually hold: a real, positive, two-decimal amount. */
function amountError(amount) {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    return 'An amount of coins is required.';
  }
  if (amount <= 0) return 'A withdrawal has to be for more than zero coins.';
  if (amount > MAX_AMOUNT) return 'That amount is above the supported range.';
  const scaled = amount * 100;
  if (Math.abs(scaled - Math.round(scaled)) > 1e-9) {
    return 'Coins are paid out in amounts of at most two decimal places.';
  }
  return null;
}

/**
 * @param {object} deps
 * @param {object} deps.db                 Firestore handle (Admin SDK)
 * @param {object} deps.economy            `createOrganizerEconomyService()` instance
 * @param {Function} deps.serverTimestamp  the server clock behind every written event
 */
function createOrganizerWithdrawalService({ db, economy, serverTimestamp } = {}) {
  if (!db || !economy || !serverTimestamp) {
    throw new Error('createOrganizerWithdrawalService requires db, economy and serverTimestamp');
  }

  const requestRefOf = id => db.collection(REQUESTS_COLLECTION).doc(id);

  /** The stored request, with the id carried alongside the fields the client is shown. */
  function view(id, data) {
    return {
      requestId: id,
      organizerUid: trim(data.organizerUid),
      amount: Number(data.amount) || 0,
      currency: trim(data.currency) || 'coins',
      upiId: trim(data.upiId),
      status: trim(data.status) || REQUEST_STATUS.AWAITING_RESERVATION,
      reservationKey: trim(data.reservationKey) || null,
      rejectionReason: trim(data.rejectionReason) || null,
      reviewedBy: trim(data.reviewedBy) || null,
      payout: trim(data.payout) || null,
      note: trim(data.note) || null,
      // The review queue has to say when the organizer asked, so the two server-written event
      // times travel with the request. Neither is ever taken from a body.
      createdAt: timeOr(data.createdAt),
      updatedAt: timeOr(data.updatedAt)
    };
  }

  /**
   * An active, registered organizer and nothing else. A deactivated or banned account keeps
   * its wallet - Phase 2 made sure it can still read it - but cannot start a payout.
   */
  async function activeOrganizerError(uid) {
    const snapshot = await db.collection('organizer_users').doc(uid).get();
    if (!snapshot.exists) {
      return refused('NOT_AN_ORGANIZER', 'Only a registered organizer can request a withdrawal.');
    }
    const data = (snapshot.data && snapshot.data()) || {};
    if (data.banned === true) return refused('ORGANIZER_BANNED', 'This organizer account is banned.');
    if (data.isActive === false) {
      return refused('ORGANIZER_INACTIVE', 'This organizer account is deactivated.');
    }
    return null;
  }

  /**
   * The one place a hold is opened, and the one place a half-created request is finished.
   *
   * `reserveFunds` is keyed on the request id, so calling this twice - on create, then again
   * when an admin reviews a request that was left `awaiting_reservation` by a dropped
   * connection - cannot hold the coins twice. A `DUPLICATE` here means the hold is already on
   * the ledger for this request, which is a success for the state machine, not a failure.
   */
  async function ensureReserved(requestId, record) {
    const reservationKey = reservationKeyFor(requestId);
    const result = await economy.reserveFunds({
      organizerUid: record.organizerUid,
      amount: Number(record.amount) || 0,
      idempotencyKey: reservationKey,
      relatedWithdrawalId: requestId,
      reason: `Organizer withdrawal ${requestId}`,
      // The organizer asked for this. The scheduler and the admin never name the amount.
      actorUid: record.organizerUid
    });

    if (result.code === 'COMPLETE' || result.code === 'DUPLICATE') {
      await requestRefOf(requestId).set({
        status: REQUEST_STATUS.PENDING,
        reservationKey,
        currency: 'coins',
        updatedAt: serverTimestamp()
      }, { merge: true });
      return { ok: true, result, reservationKey };
    }

    // The coins were never held, so the request is closed rather than left pending: an admin
    // who opens a list of pending requests must never see one with no money behind it.
    const note = result.code === 'INSUFFICIENT_BALANCE'
      ? `Only ${result.availableBalance} coins were available for ${record.amount} requested.`
      : result.message;
    await requestRefOf(requestId).set({
      status: REQUEST_STATUS.RESERVATION_FAILED,
      note,
      currency: 'coins',
      updatedAt: serverTimestamp()
    }, { merge: true });
    return { ok: false, result, note };
  }

  /**
   * Create a withdrawal request and reserve the coins against it.
   *
   * @param {string} organizerUid     the verified caller, never a body field
   * @param {number} amount           coins
   * @param {string} upiId            the payout handle an admin pays into
   * @param {string} idempotencyToken the caller's stable per-request token
   */
  async function createRequest({ organizerUid, amount, upiId, idempotencyToken } = {}) {
    const uid = trim(organizerUid);
    if (!uid || uid.length > 128) return refused('ORGANIZER_UID_INVALID', 'A valid organizer account is required.');

    const token = trim(idempotencyToken);
    if (!TOKEN_PATTERN.test(token)) {
      return refused('IDEMPOTENCY_TOKEN_INVALID',
        'A withdrawal needs the stable request token the app generated for it.');
    }

    const problem = amountError(amount);
    if (problem) return refused('AMOUNT_INVALID', problem);

    const payoutHandle = trim(upiId);
    if (!SAFE_ID.test(uid)) return refused('ORGANIZER_UID_INVALID', 'A valid organizer account is required.');
    if (!UPI_PATTERN.test(payoutHandle)) {
      return refused('UPI_ID_INVALID', 'Enter the UPI ID the payout should go to, in the form name@bank.');
    }

    const requestId = requestIdFor({ organizerUid: uid, token });
    if (!SAFE_ID.test(requestId)) return refused('REQUEST_ID_INVALID', 'That request cannot be recorded.');

    const notOrganizer = await activeOrganizerError(uid);
    if (notOrganizer) return notOrganizer;

    // Read first: a retry of a request that already exists is answered with the request that
    // already exists, and the money is not touched a second time.
    const existing = await requestRefOf(requestId).get();
    if (existing.exists) {
      const record = existing.data() || {};
      // A token is only ever the caller's own. Somebody else guessing the same token cannot
      // read or resume this request.
      if (trim(record.organizerUid) !== uid) {
        return refused('FORBIDDEN', 'That withdrawal request belongs to another organizer.');
      }
      if (record.status !== REQUEST_STATUS.AWAITING_RESERVATION) {
        return { code: 'COMPLETE', applied: false, duplicate: true,
          requestId, request: view(requestId, record),
          message: 'This withdrawal request already exists, so nothing was reserved again.' };
      }
      // A previous attempt wrote the request and then failed before the hold. Finish it.
      const resumed = await ensureReserved(requestId, record);
      const after = await requestRefOf(requestId).get();
      if (!resumed.ok) {
        return { code: resumed.result.code || 'RESERVATION_FAILED', applied: false,
          requestId, request: view(requestId, after.data() || {}),
          message: resumed.note };
      }
      return { code: 'COMPLETE', applied: true, resumed: true, requestId,
        request: view(requestId, after.data() || {}), message: 'The coins are reserved.' };
    }

    const stageOne = {
      organizerUid: uid,
      amount,
      currency: 'coins',
      upiId: payoutHandle,
      idempotencyToken: token,
      status: REQUEST_STATUS.AWAITING_RESERVATION,
      reservationKey: reservationKeyFor(requestId),
      // A payout is an accounting decision until a gateway exists. Saying so on the record
      // keeps a later integration from reading `approved` as `paid`.
      payout: PAYOUT_MANUAL,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    };

    // `create()` rather than `set()`: two simultaneous retries of the same token cannot both
    // establish a request, which is the one place a duplicate reservation could come from.
    try {
      await requestRefOf(requestId).create(stageOne);
    } catch (error) {
      if (error.code === 6 || error.code === 'already-exists') {
        const raced = await requestRefOf(requestId).get();
        const record = (raced.exists && raced.data()) || {};
        if (trim(record.organizerUid) !== uid) {
          return refused('FORBIDDEN', 'That withdrawal request belongs to another organizer.');
        }
        return { code: 'COMPLETE', applied: false, duplicate: true, requestId,
          request: view(requestId, record),
          message: 'This withdrawal request already exists, so nothing was reserved again.' };
      }
      console.error('[OrganizerWithdrawals] Request creation failed:', error.message);
      return refused('TRANSIENT_FAILURE',
        'The withdrawal request could not be recorded. Retry with the same request token.',
        { retryable: true, requestId });
    }

    const reserved = await ensureReserved(requestId, stageOne);
    const stored = await requestRefOf(requestId).get();
    const record = view(requestId, (stored.exists && stored.data()) || {});

    if (!reserved.ok) {
      return { code: reserved.result.code || 'RESERVATION_FAILED', applied: false,
        requestId, request: record, message: reserved.note };
    }

    return { code: 'COMPLETE', applied: true, duplicate: false, requestId, request: record,
      message: 'The request is recorded and the coins are reserved pending admin review.' };
  }

  /**
   * Approve or reject one request. The reviewer is the authenticated admin, the amount and
   * the organizer are whatever the stored request already said, and neither comes from the
   * body that named the request.
   */
  async function reviewRequest({ requestId, reviewerUid, decision, reason } = {}) {
    const id = trim(requestId);
    if (!SAFE_ID.test(id)) return refused('REQUEST_ID_INVALID', 'That request cannot be found.');

    const reviewer = trim(reviewerUid);
    if (!reviewer) return refused('REVIEWER_REQUIRED', 'A review needs a signed-in admin.');

    const action = trim(decision).toLowerCase();
    if (action !== DECISIONS.APPROVE && action !== DECISIONS.REJECT) {
      return refused('DECISION_INVALID', 'A withdrawal is either approved or rejected.');
    }
    const note = trim(reason);
    if (action === DECISIONS.REJECT && !note) {
      return refused('REASON_REQUIRED', 'A rejection has to say why.');
    }
    if (note.length > 500) return refused('REASON_TOO_LONG', 'Keep the reason under 500 characters.');

    const snapshot = await requestRefOf(id).get();
    if (!snapshot.exists) return refused('NOT_FOUND', 'That withdrawal request does not exist.');
    const record = snapshot.data() || {};
    const organizerUid = trim(record.organizerUid);
    if (!organizerUid) return refused('REQUEST_INCOMPLETE', 'This request does not name an organizer.');

    const status = trim(record.status);
    if (status === REQUEST_STATUS.APPROVED || status === REQUEST_STATUS.REJECTED) {
      return refused('ALREADY_PROCESSED', `This request is already ${status}.`,
        { request: view(id, record) });
    }
    if (status === REQUEST_STATUS.RESERVATION_FAILED) {
      return refused('NOT_RESERVED', 'No coins are held for this request, so there is nothing to review.',
        { request: view(id, record) });
    }

    // A request left `awaiting_reservation` by an interrupted create is finished here, with
    // the same deterministic hold key, before it can be reviewed.
    let reservationKey = trim(record.reservationKey) || reservationKeyFor(id);
    if (status === REQUEST_STATUS.AWAITING_RESERVATION) {
      const resumed = await ensureReserved(id, record);
      if (!resumed.ok) {
        const after = await requestRefOf(id).get();
        return { code: resumed.result.code || 'RESERVATION_FAILED', applied: false,
          requestId: id, request: view(id, (after.exists && after.data()) || {}),
          message: resumed.note };
      }
      reservationKey = resumed.reservationKey;
    }

    const closing = {
      organizerUid,
      reservationKey,
      // No key is passed, so the economy service derives the one closing key this request and
      // this decision can have. Two admins approving the same request therefore collide on
      // exactly one ledger document.
      reason: action === DECISIONS.APPROVE
        ? `Withdrawal ${id} approved by ${reviewer}`
        : `Withdrawal ${id} rejected by ${reviewer}: ${note}`,
      actorUid: reviewer
    };

    const movement = action === DECISIONS.APPROVE
      ? await economy.finalizeReservation(closing)
      : await economy.releaseReservation(closing);

    if (movement.code === 'COMPLETE' || movement.code === 'DUPLICATE') {
      const write = {
        status: action === DECISIONS.APPROVE ? REQUEST_STATUS.APPROVED : REQUEST_STATUS.REJECTED,
        reviewedBy: reviewer,
        reviewedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        payout: PAYOUT_MANUAL
      };
      if (action === DECISIONS.REJECT) write.rejectionReason = note;
      await requestRefOf(id).set(write, { merge: true });

      const after = await requestRefOf(id).get();
      return {
        code: action === DECISIONS.APPROVE ? 'COMPLETE' : 'REJECTED',
        applied: movement.code === 'COMPLETE',
        // The decision is recorded now; the coins already moved on an earlier attempt.
        reconciled: movement.code === 'DUPLICATE',
        requestId: id,
        request: view(id, (after.exists && after.data()) || {}),
        message: action === DECISIONS.APPROVE
          ? 'Approved. The reservation was finalized once, and no coins were deducted again. ' +
            'No payout gateway is integrated, so this records an admin decision only.'
          : 'Rejected. The reservation was released once and the coins are available again.'
      };
    }

    // The hold is already closed the other way, or was never there. The request document is
    // left exactly as it was, because an out-of-order review must not rewrite history.
    if (movement.code === 'ALREADY_CLOSED') {
      return refused('ALREADY_PROCESSED',
        `That reservation is already ${movement.status || 'closed'}, so this request cannot be ${
          action === DECISIONS.APPROVE ? 'approved' : 'rejected'} now.`,
        { request: view(id, record) });
    }

    console.error('[OrganizerWithdrawals] Review', action, 'refused for', id,
      '|', movement.code, movement.message);
    return refused(movement.code || 'REVIEW_FAILED', movement.message ||
      'The withdrawal could not be reviewed.', { request: view(id, record) });
  }

  /**
   * The list a review screen reads. Requests are read from their own documents rather than
   * joined to anything, and no listing is unbounded.
   */
  async function listRequests({ organizerUid = '', status = '', limit = 50 } = {}) {
    const uid = trim(organizerUid);
    const wanted = trim(status).toLowerCase();
    const size = Math.min(Math.max(1, Number(limit) || 50), MAX_PAGE_SIZE);

    let query = db.collection(REQUESTS_COLLECTION);
    if (uid) query = query.where('organizerUid', '==', uid);
    if (wanted) query = query.where('status', '==', wanted);

    const snapshot = await query.limit(size).get();
    const requests = snapshot.docs.map(document => view(String(document.id), document.data() || {}));
    return { code: 'COMPLETE', requests, count: requests.length };
  }

  return {
    createRequest,
    reviewRequest,
    listRequests,
    requestIdFor,
    reservationKeyFor
  };
}

module.exports = {
  createOrganizerWithdrawalService,
  REQUESTS_COLLECTION,
  REQUEST_STATUS,
  DECISIONS,
  PAYOUT_MANUAL,
  MAX_AMOUNT,
  MAX_PAGE_SIZE,
  requestIdFor,
  reservationKeyFor,
  amountError
};
