/**
 * Organizer transaction history.
 *
 * `organizer_ledger` is the only record of an organizer's money: every reward, penalty,
 * reservation and its closing movement is one immutable document written by
 * `services/organizerEconomy.js` inside the same transaction that moved the balance. This module
 * reads that collection and nothing else. It does not total anything, does not infer an entry that
 * was never written, and never reconstructs a balance from a running sum - the balance a screen
 * shows is the `balanceBefore`/`balanceAfter` pair the economy service recorded when the movement
 * happened.
 *
 * ## Why the read is paginated at all
 *
 * An organizer who has run a hundred matches has more than a hundred entries, and a screen that
 * asks for "everything" either gets an unbounded query or silently the first page. So every read
 * here is bounded, and the answer says whether there is more: `limit + 1` documents are asked for
 * and the extra one is dropped in favour of `hasMore`, which is the difference between "this is the
 * history" and "this is the newest page of it".
 *
 * The cursor is `(createdAt, document id)`. Ordering is `createdAt` descending with Firestore's own
 * `__name__` tiebreak, and the cursor carries both, so two entries written in the same millisecond
 * cannot be skipped or shown twice between pages. A cursor is opaque to the client: it is base64
 * over an epoch-millisecond pair, and an unreadable one is refused rather than silently treated as
 * "start from the beginning", because a screen that quietly restarts a history looks like a
 * duplicate set of transactions.
 *
 * ## What a filter may and may not do
 *
 * `type`, `status` and a date range are filters over one organizer's rows. They select documents;
 * they grant nothing. The organizer uid is never taken from the request for the organizer route -
 * that one passes the verified caller - and the admin route is behind the admin check before this
 * service is reached at all.
 */

/** The one collection this service reads. It writes nothing. */
const LEDGER_COLLECTION = 'organizer_ledger';

/** The bounds a page may ask for. A "full history" is read in pages of at most this many. */
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/** The statuses a ledger entry can be in, as `organizerEconomy` writes them. */
const ENTRY_STATUSES = ['settled', 'reserved', 'finalized', 'released'];

/**
 * Which collection a `relatedId` points at, by entry type. The economy service stores one
 * reference per movement; naming its kind is what lets a screen render "tournament abc" instead of
 * an opaque id, without the ledger growing a field per relation.
 */
const RELATED_KIND = {
  reward_credit: 'tournament',
  penalty_deduction: 'penalty_case',
  withdrawal_reservation: 'withdrawal_request',
  withdrawal_finalization: 'withdrawal_request',
  withdrawal_release: 'withdrawal_request',
  admin_adjustment: 'ledger_entry'
};

const ENTRY_TYPES = Object.keys(RELATED_KIND);

/** A document id that cannot become a path. */
const SAFE_ID = /^[A-Za-z0-9_:.-]{1,200}$/;

const CURSOR = /^[A-Za-z0-9_-]{4,200}$/;

function trim(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function numberOf(value) {
  // `Number(null)` is 0, and an entry that never recorded a balance must not be reported as a
  // balance of zero - nor may an omitted date filter become a range of exactly the epoch.
  if (value === null || value === undefined || value === '') return null;
  const read = Number(value);
  return Number.isFinite(read) ? read : null;
}

function refused(code, message) {
  return { code, message, entries: [], count: 0, hasMore: false, nextCursor: null };
}

/** The millisecond value of whatever a Firestore timestamp field holds, or null. */
function millis(value) {
  if (!value) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value.toMillis === 'function') {
    const ms = value.toMillis();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value.toDate === 'function') {
    const ms = value.toDate().getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value.seconds === 'number') {
    return value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1e6);
  }
  return null;
}

function encodeCursor(entry) {
  const at = millis(entry.createdAtMillis !== undefined ? entry.createdAtMillis : entry.createdAt);
  if (at === null) return null;
  return Buffer.from(`${at}|${entry.id}`, 'utf8').toString('base64url');
}

function decodeCursor(value) {
  const text = trim(value);
  if (!text || !CURSOR.test(text)) return null;
  let decoded = '';
  try {
    decoded = Buffer.from(text, 'base64url').toString('utf8');
  } catch (error) {
    return null;
  }
  const split = decoded.indexOf('|');
  if (split <= 0) return null;
  const at = Number(decoded.slice(0, split));
  const id = decoded.slice(split + 1);
  if (!Number.isFinite(at) || !SAFE_ID.test(id)) return null;
  return { at, id };
}

/**
 * One stored entry, as a screen reads it.
 *
 * Every optional field stays `null` when the document does not carry it. A missing `balanceBefore`
 * is reported as missing rather than as zero, because "this entry predates the field" and "this
 * entry moved the balance to zero" are different facts and only one of them is true.
 */
function viewOf(document) {
  const data = (document.data && document.data()) || {};
  const relatedId = trim(data.relatedId) || null;
  const createdAtMillis = millis(data.createdAt);
  return {
    entryId: document.id,
    organizerUid: trim(data.organizerUid) || null,
    type: trim(data.type) || null,
    direction: trim(data.direction) || null,
    amount: numberOf(data.amount),
    currency: trim(data.currency) || null,
    status: trim(data.status) || null,
    balanceBefore: numberOf(data.balanceBefore),
    balanceAfter: numberOf(data.balanceAfter),
    idempotencyKey: trim(data.idempotencyKey) || null,
    relatedId,
    relatedKind: relatedId ? (RELATED_KIND[trim(data.type)] || null) : null,
    reservationKey: trim(data.reservationKey) || null,
    closedByKey: trim(data.closedByKey) || null,
    reason: trim(data.reason) || null,
    actorUid: trim(data.actorUid) || null,
    createdAtMillis,
    createdAt: createdAtMillis === null ? null : new Date(createdAtMillis).toISOString(),
    updatedAtMillis: millis(data.updatedAt)
  };
}

/**
 * @param {object} deps
 * @param {object} deps.db  Firestore handle (Admin SDK)
 */
function createOrganizerLedgerService({ db } = {}) {
  if (!db) throw new Error('createOrganizerLedgerService requires db');

  /**
   * One page of one organizer's movements, newest first.
   *
   * The query shape is fixed by the filters asked for, because Firestore needs a composite index
   * for every combination. The four shapes are declared in `firestore.indexes.json`; an index that
   * a deployment has not built yet is reported as `INDEX_NOT_READY` with the query it needs,
   * rather than as an empty history that would read as "this organizer never moved a coin".
   */
  async function listEntries({
    organizerUid,
    limit = DEFAULT_LIMIT,
    cursor = '',
    type = '',
    status = '',
    fromMillis = null,
    toMillis = null
  } = {}) {
    const uid = trim(organizerUid);
    if (!uid || !SAFE_ID.test(uid)) {
      return refused('ORGANIZER_UID_INVALID', 'A valid organizer account is required.');
    }

    const wantedType = trim(type);
    if (wantedType && !ENTRY_TYPES.includes(wantedType)) {
      return refused('TYPE_UNSUPPORTED', 'That is not a ledger type this platform records.');
    }
    const wantedStatus = trim(status);
    if (wantedStatus && !ENTRY_STATUSES.includes(wantedStatus)) {
      return refused('STATUS_UNSUPPORTED', 'That is not a ledger status.');
    }

    const from = numberOf(fromMillis);
    const to = numberOf(toMillis);
    if ((fromMillis !== null && fromMillis !== undefined && from === null) ||
        (toMillis !== null && toMillis !== undefined && to === null)) {
      return refused('DATE_INVALID', 'A date filter has to be a moment in milliseconds.');
    }
    if (from !== null && to !== null && from > to) {
      return refused('DATE_INVALID', 'The date range starts after it ends.');
    }

    const pageSize = Math.min(
      Math.max(1, Number(limit) || DEFAULT_LIMIT),
      MAX_LIMIT
    );

    const after = trim(cursor) ? decodeCursor(cursor) : null;
    if (trim(cursor) && !after) {
      return refused('CURSOR_INVALID',
        'This page request could not be read. Reload the history from the start.');
    }

    let query = db.collection(LEDGER_COLLECTION).where('organizerUid', '==', uid);
    if (wantedType) query = query.where('type', '==', wantedType);
    if (wantedStatus) query = query.where('status', '==', wantedStatus);
    if (from !== null) query = query.where('createdAt', '>=', new Date(from));
    if (to !== null) query = query.where('createdAt', '<=', new Date(to));

    query = query.orderBy('createdAt', 'desc');
    if (after) query = query.startAfter(new Date(after.at), after.id);
    // One more than the page, so `hasMore` is a fact rather than an assumption.
    query = query.limit(pageSize + 1);

    let snapshot;
    try {
      snapshot = await query.get();
    } catch (error) {
      const message = String((error && error.message) || '');
      if (/index/i.test(message)) {
        console.error('[OrganizerLedger] Missing index for', uid, '|', message);
        return {
          ...refused('INDEX_NOT_READY',
            'The transaction history needs a Firestore index that this deployment has not built yet.'),
          retryable: true
        };
      }
      throw error;
    }

    const documents = snapshot.docs || [];
    const hasMore = documents.length > pageSize;
    const page = documents.slice(0, pageSize).map(viewOf);
    const last = page.length ? page[page.length - 1] : null;

    return {
      code: 'COMPLETE',
      organizerUid: uid,
      entries: page,
      count: page.length,
      hasMore,
      nextCursor: hasMore && last ? encodeCursor({
        id: last.entryId,
        createdAtMillis: last.createdAtMillis
      }) : null,
      pageSize,
      filters: {
        type: wantedType || null,
        status: wantedStatus || null,
        fromMillis: from,
        toMillis: to
      }
    };
  }

  return { listEntries, LEDGER_COLLECTION, ENTRY_TYPES, ENTRY_STATUSES };
}

module.exports = {
  createOrganizerLedgerService,
  LEDGER_COLLECTION,
  ENTRY_TYPES,
  ENTRY_STATUSES,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  RELATED_KIND
};
