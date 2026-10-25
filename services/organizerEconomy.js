/**
 * Organizer economy primitives.
 *
 * The organizer economy is measured in coins and lives entirely apart from a player's
 * wallet: `organizer_wallets/{organizerUid}` is its only balance and
 * `organizer_ledger/{entryId}` is its only record of movement. No player field -
 * `depositBalance`, `bonusBalance`, `wonBalance`, `walletBalance` - is read or written
 * anywhere in this file, and nothing here touches the Realtime Database, so there is no
 * second copy of a balance to fall out of step with the first.
 *
 * These are primitives, not an API. Nothing in this module is mounted on a route, and the
 * phase that pays a reward, takes a penalty or lets an organizer withdraw coins has to be
 * approved separately before any of it is reachable from a client. What lives here is the
 * part every one of those phases needs and no phase should rewrite: a balance that only
 * this service moves, an entry that says why it moved, and the rule that the two land
 * together or not at all.
 *
 * Four invariants hold the design up:
 *
 *   1. A balance is never taken from the caller. Every movement recomputes from the wallet
 *      read inside the transaction, so a request that names a balance is ignored rather
 *      than trusted, and two requests that race cannot both write the same figure.
 *   2. A movement is applied once. The ledger document is keyed by the caller's idempotency
 *      key and read inside the same transaction as the balance, so a retry finds the entry,
 *      moves nothing and reports that it was already recorded.
 *   3. An open hold closes exactly once. `reserved` becomes `finalized` or `released` and
 *      never goes back, which is what stops withdrawn coins from being both paid and
 *      refunded. The amount a hold closes for is read off the hold, never supplied.
 *   4. A settled entry is never edited or deleted. A mistake is answered with a
 *      compensating `admin_adjustment` that leaves the original in place, because a
 *      financial record that can be rewritten proves nothing.
 *
 * Firestore's transaction is atomic within one database and across nothing else. A later
 * operation that also sends an SMS, calls a gateway or writes to the Realtime Database
 * needs its own durable state machine, not this file's transaction.
 */

/** The two collections this service owns. */
const WALLET_COLLECTION = 'organizer_wallets';
const LEDGER_COLLECTION = 'organizer_ledger';

/** The settings document, and the copy of its defaults this service reads. */
const CONFIG_COLLECTION = 'appConfig';
const CONFIG_DOCUMENT = 'organizerEconomy';

/** The movements the economy will need. Each is one immutable ledger entry. */
const ENTRY_TYPES = {
  REWARD_CREDIT: 'reward_credit',
  PENALTY_DEDUCTION: 'penalty_deduction',
  WITHDRAWAL_RESERVATION: 'withdrawal_reservation',
  WITHDRAWAL_FINALIZATION: 'withdrawal_finalization',
  WITHDRAWAL_RELEASE: 'withdrawal_release',
  ADMIN_ADJUSTMENT: 'admin_adjustment'
};

/** How an amount reads. A hold moves coins sideways, not away. */
const DIRECTIONS = { CREDIT: 'credit', DEBIT: 'debit', HOLD: 'hold' };

/** The states a hold passes through, in one direction only. */
const HOLD_STATES = { RESERVED: 'reserved', FINALIZED: 'finalized', RELEASED: 'released' };

/** Everything that is not an open hold is settled, and settled never changes. */
const ENTRY_STATUS = { SETTLED: 'settled', ...HOLD_STATES };

/** The only currency this economy knows: coins, never a player's rupee balance. */
const CURRENCY = 'coins';

/** The same ceilings the Admin settings screen and the Firestore rules enforce. */
const MAX_AMOUNT = 100000;
const MAX_DAILY_LIMIT = 1000;

/**
 * How long after the scheduled start an organizer is still given the benefit of the doubt.
 * The Admin screen owns the number; this is only the outer bound of what it may name, and
 * the matching ceiling in `firestore.rules` is the same one day in minutes.
 */
const MAX_GRACE_MINUTES = 1440;

/** A document id that cannot become a path, cannot be empty and cannot be `..`. */
const SAFE_KEY = /^[A-Za-z0-9_:.-]{1,160}$/;

const ENTRY_TYPE_VALUES = Object.keys(ENTRY_TYPES).map(key => ENTRY_TYPES[key]);

function trim(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function refused(code, message, extra = {}) {
  return { code, message, applied: false, duplicate: false, ...extra };
}

/** Any number a stored document holds, or zero for a field nobody has written yet. */
function numberOf(value) {
  const read = Number(value);
  return Number.isFinite(read) ? read : 0;
}

/** gRPC 10 / 'aborted': this transaction read something another one then committed. */
function isAborted(error) {
  const code = error && error.code;
  return code === 10 || code === 'aborted' ||
    /aborted|concurrent transaction/i.test(String((error && error.message) || ''));
}

/**
 * @param {object} deps
 * @param {object} deps.db                 Firestore handle (Admin SDK)
 * @param {Function} deps.serverTimestamp  the server clock behind every financial event
 * @param {number} [deps.maxAttempts]      how often a conflicting transaction is retried
 */
function createOrganizerEconomyService({ db, serverTimestamp, maxAttempts = 3 } = {}) {
  if (!db || !serverTimestamp) {
    throw new Error('createOrganizerEconomyService requires db and serverTimestamp');
  }

  const walletRefOf = uid => db.collection(WALLET_COLLECTION).doc(uid);
  const entryRefOf = key => db.collection(LEDGER_COLLECTION).doc(key);

  /**
   * A conflict means somebody else committed first, so the answer is to read again and
   * apply the movement to the state that actually won. Firestore retries on its own; doing
   * the same here costs nothing, because an aborted transaction committed nothing, and it
   * is what keeps two simultaneous movements from losing one of the two.
   */
  async function runTransaction(work) {
    let attempts = 0;
    for (;;) {
      try {
        return await db.runTransaction(work);
      } catch (error) {
        if (!isAborted(error) || ++attempts >= maxAttempts) throw error;
        console.warn(`[OrganizerEconomy] Transaction conflict, retrying (${attempts} of ${maxAttempts - 1})`);
      }
    }
  }

  /** The stored balance as numbers, with no opinion about whether the document exists. */
  function walletFrom(snapshot) {
    const data = (snapshot.exists && snapshot.data()) || {};
    return {
      exists: !!snapshot.exists,
      availableBalance: numberOf(data.availableBalance),
      reservedBalance: numberOf(data.reservedBalance),
      lifetimeEarned: numberOf(data.lifetimeEarned),
      lifetimePenalized: numberOf(data.lifetimePenalized),
      version: numberOf(data.version),
      createdAt: data.createdAt
    };
  }

  /**
   * The one place a balance is arithmetic. Each movement's effect is written out here, so a
   * credit can never also reserve, a finalization can never deduct twice and a release can
   * never pay out of the available side.
   *
   * `forfeit` is a movement that cannot be completed because the coins are not there; an
   * available balance never goes below zero and a reserved balance never goes below what
   * is actually held.
   */
  function recompute(type, current, amount, signedDelta) {
    const same = { availableBalance: current.availableBalance, reservedBalance: current.reservedBalance };
    const insufficient = message => ({
      failure: { code: 'INSUFFICIENT_BALANCE', message },
      wallet: same
    });

    switch (type) {
      case ENTRY_TYPES.REWARD_CREDIT:
        return {
          wallet: {
            availableBalance: current.availableBalance + amount,
            reservedBalance: current.reservedBalance,
            lifetimeEarned: current.lifetimeEarned + amount
          },
          measuredBefore: current.availableBalance,
          measuredAfter: current.availableBalance + amount
        };

      case ENTRY_TYPES.PENALTY_DEDUCTION:
        if (amount > current.availableBalance) {
          return insufficient('This penalty is larger than the coins available.');
        }
        return {
          wallet: {
            availableBalance: current.availableBalance - amount,
            reservedBalance: current.reservedBalance,
            lifetimePenalized: current.lifetimePenalized + amount
          },
          measuredBefore: current.availableBalance,
          measuredAfter: current.availableBalance - amount
        };

      case ENTRY_TYPES.WITHDRAWAL_RESERVATION:
        if (amount > current.availableBalance) {
          return insufficient('This reservation is larger than the coins available.');
        }
        return {
          wallet: {
            availableBalance: current.availableBalance - amount,
            reservedBalance: current.reservedBalance + amount
          },
          measuredBefore: current.availableBalance,
          measuredAfter: current.availableBalance - amount,
          status: HOLD_STATES.RESERVED
        };

      case ENTRY_TYPES.WITHDRAWAL_FINALIZATION:
        // The coins left availableBalance when the hold opened. Finalizing only stops them
        // being held, which is why it cannot deduct a second time.
        if (amount > current.reservedBalance) {
          return insufficient('This reservation is larger than the coins held for it.');
        }
        return {
          wallet: {
            availableBalance: current.availableBalance,
            reservedBalance: current.reservedBalance - amount
          },
          measuredBefore: current.reservedBalance,
          measuredAfter: current.reservedBalance - amount,
          closeHoldAs: HOLD_STATES.FINALIZED
        };

      case ENTRY_TYPES.WITHDRAWAL_RELEASE:
        if (amount > current.reservedBalance) {
          return insufficient('This reservation is larger than the coins held for it.');
        }
        return {
          wallet: {
            availableBalance: current.availableBalance + amount,
            reservedBalance: current.reservedBalance - amount
          },
          measuredBefore: current.reservedBalance,
          measuredAfter: current.reservedBalance - amount,
          closeHoldAs: HOLD_STATES.RELEASED
        };

      case ENTRY_TYPES.ADMIN_ADJUSTMENT: {
        // An adjustment is the one movement that arrives signed, because it corrects
        // whatever was done before it. The ledger still stores a magnitude and a direction.
        const next = current.availableBalance + (signedDelta || 0);
        if (next < 0) {
          return insufficient('This adjustment would take the available balance below zero.');
        }
        return {
          wallet: {
            availableBalance: next,
            reservedBalance: current.reservedBalance
          },
          measuredBefore: current.availableBalance,
          measuredAfter: next
        };
      }

      default:
        return { failure: { code: 'TYPE_UNSUPPORTED', message: 'Unknown ledger type.' }, wallet: same };
    }
  }

  /**
   * One movement, one transaction: read the wallet and the claim, decide, then write the
   * entry and the new balance together. Every read happens before the first queued write,
   * which is what Firestore requires of a transaction.
   */
  async function applyMovement({ organizerUid, idempotencyKey, type, direction,
    amount, signedDelta, holdKey, relatedId, reason, actorUid }) {

    const uid = trim(organizerUid);
    const key = trim(idempotencyKey);
    const hold = trim(holdKey);

    return runTransaction(async transaction => {
      // Reads first, all of them, so a decision is never taken from a stale snapshot.
      const reads = [await transaction.get(walletRefOf(uid)), await transaction.get(entryRefOf(key))];
      const holdSnap = hold ? await transaction.get(entryRefOf(hold)) : null;
      const walletSnap = reads[0];
      const claimSnap = reads[1];

      if (claimSnap.exists) {
        const recorded = (claimSnap.data && claimSnap.data()) || {};
        return { code: 'DUPLICATE', applied: false, duplicate: true, entryId: key,
          organizerUid: uid, type: trim(recorded.type),
          amount: numberOf(recorded.amount),
          message: 'That operation is already on the ledger, so nothing moved.' };
      }

      // A wallet is opened by the trusted initialization path and at zero. Crediting into a
      // document that does not exist would invent a balance, so it is refused instead.
      if (!walletSnap.exists) {
        return { code: 'WALLET_MISSING', applied: false, duplicate: false, organizerUid: uid,
          message: 'This organizer has no wallet yet, so no coins could be moved.' };
      }

      let settledAmount = amount;
      if (hold) {
        const holdData = (holdSnap.exists && holdSnap.data()) || {};
        if (!holdSnap.exists) {
          return { code: 'RESERVATION_MISSING', applied: false, duplicate: false,
            message: 'That reservation is not on the ledger, so it cannot be closed.' };
        }
        if (trim(holdData.organizerUid) !== uid) {
          return { code: 'FORBIDDEN', applied: false, duplicate: false,
            message: 'That reservation belongs to another organizer.' };
        }
        if (trim(holdData.status) !== HOLD_STATES.RESERVED) {
          return { code: 'ALREADY_CLOSED', applied: false, duplicate: false,
            status: trim(holdData.status),
            message: `That reservation is already ${trim(holdData.status) || 'closed'}, so nothing moved.` };
        }
        // The hold names the amount. A caller cannot close a small hold for a large payout.
        settledAmount = numberOf(holdData.amount);
      }

      const current = walletFrom(walletSnap);
      const outcome = recompute(type, current, settledAmount, signedDelta);
      if (outcome.failure) {
        return { ...refused(outcome.failure.code, outcome.failure.message),
          availableBalance: current.availableBalance, reservedBalance: current.reservedBalance };
      }

      const entry = {
        organizerUid: uid,
        type,
        direction,
        amount: settledAmount,
        currency: CURRENCY,
        balanceBefore: outcome.measuredBefore,
        balanceAfter: outcome.measuredAfter,
        idempotencyKey: key,
        relatedId: trim(relatedId) || null,
        reason: trim(reason) || null,
        actorUid: trim(actorUid) || null,
        status: outcome.status || ENTRY_STATUS.SETTLED,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      };
      if (hold) entry.reservationKey = hold;

      const walletWrite = {
        ...outcome.wallet,
        currency: CURRENCY,
        version: current.version + 1,
        updatedAt: serverTimestamp()
      };
      // `createdAt` is the wallet's own first moment, so a merge never restamps it.
      if (!current.createdAt) walletWrite.createdAt = serverTimestamp();

      transaction.set(entryRefOf(key), entry);
      transaction.set(walletRefOf(uid), walletWrite, { merge: true });
      if (hold && outcome.closeHoldAs) {
        // Only the state that says this hold can no longer be closed moves. Every other
        // field of the original reservation stays as it was written.
        transaction.set(entryRefOf(hold),
          { status: outcome.closeHoldAs, closedByKey: key, updatedAt: serverTimestamp() },
          { merge: true });
      }

      return { code: 'COMPLETE', applied: true, duplicate: false, entryId: key,
        organizerUid: uid, type, direction, amount: settledAmount,
        balanceBefore: outcome.measuredBefore, balanceAfter: outcome.measuredAfter,
        availableBalance: outcome.wallet.availableBalance,
        reservedBalance: outcome.wallet.reservedBalance };
    });
  }

  // ==========================================================================
  // Input validation, in one place, before any document is opened
  // ==========================================================================

  function badUid(organizerUid) {
    const uid = trim(organizerUid);
    if (!uid || uid.length > 128) {
      return refused('ORGANIZER_UID_INVALID', 'A valid organizer account identifier is required.');
    }
    return null;
  }

  function badKey(idempotencyKey) {
    const key = trim(idempotencyKey);
    if (!key) {
      return refused('IDEMPOTENCY_KEY_REQUIRED', 'Every money movement needs a stable idempotency key.');
    }
    if (!SAFE_KEY.test(key)) {
      return refused('IDEMPOTENCY_KEY_INVALID', 'That idempotency key cannot be used as a record identifier.');
    }
    return null;
  }

  /**
   * A magnitude the economy can hold. Amounts are stored positive and signed by the entry's
   * `direction`, because a negative magnitude alongside a debit direction would be two ways
   * to say one thing and a ready way to say the opposite by accident.
   */
  function badAmount(amount) {
    if (typeof amount !== 'number' || !Number.isFinite(amount)) {
      return refused('AMOUNT_INVALID', 'An amount must be a real number of coins.');
    }
    if (amount < 0) return refused('AMOUNT_NEGATIVE', 'An amount cannot be negative; use the direction instead.');
    if (amount === 0) return refused('AMOUNT_ZERO', 'A movement of zero coins is not recorded.');
    if (amount > MAX_AMOUNT) return refused('AMOUNT_TOO_LARGE', 'That amount is above the supported range.');
    return null;
  }

  function badType(type) {
    if (!ENTRY_TYPE_VALUES.includes(type)) {
      return refused('TYPE_UNSUPPORTED', 'Unknown ledger type.');
    }
    return null;
  }

  function movementError({ organizerUid, type, amount, idempotencyKey }) {
    return badUid(organizerUid) || badType(type) || badKey(idempotencyKey) || badAmount(amount);
  }

  // ==========================================================================
  // Wallet
  // ==========================================================================

  /**
   * Opens a wallet at zero. Idempotent and never a reset: an organizer who already has a
   * balance keeps every coin in it, because a second call is a retry rather than a request
   * to start over.
   */
  async function initializeWallet({ organizerUid, actorUid } = {}) {
    const invalid = badUid(organizerUid);
    if (invalid) return invalid;
    const uid = trim(organizerUid);

    return runTransaction(async transaction => {
      const existing = await transaction.get(walletRefOf(uid));
      if (existing.exists) {
        const current = walletFrom(existing);
        return { code: 'EXISTS', applied: false, duplicate: true, organizerUid: uid,
          message: 'This organizer already has a wallet, and it was left exactly as it was.',
          availableBalance: current.availableBalance, reservedBalance: current.reservedBalance };
      }

      transaction.set(walletRefOf(uid), {
        availableBalance: 0,
        reservedBalance: 0,
        lifetimeEarned: 0,
        lifetimePenalized: 0,
        currency: CURRENCY,
        version: 0,
        openedBy: trim(actorUid) || null,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
      return { code: 'COMPLETE', applied: true, duplicate: false, organizerUid: uid,
        message: 'Wallet opened at zero coins.', availableBalance: 0, reservedBalance: 0 };
    });
  }

  /** The summary an authorized reader is given. A missing wallet is said, never invented. */
  async function getWalletSummary({ organizerUid } = {}) {
    const invalid = badUid(organizerUid);
    if (invalid) return invalid;
    const uid = trim(organizerUid);

    const snapshot = await walletRefOf(uid).get();
    if (!snapshot.exists) {
      return { code: 'WALLET_MISSING', applied: false, duplicate: false, exists: false,
        organizerUid: uid, message: 'This organizer has no wallet yet.' };
    }

    const current = walletFrom(snapshot);
    return { code: 'COMPLETE', applied: true, duplicate: false, exists: true,
      organizerUid: uid, currency: CURRENCY, version: current.version,
      availableBalance: current.availableBalance, reservedBalance: current.reservedBalance,
      lifetimeEarned: current.lifetimeEarned, lifetimePenalized: current.lifetimePenalized };
  }

  // ==========================================================================
  // Movements
  // ==========================================================================

  /** An explicitly authorized reward. Nothing in this phase calls it. */
  async function creditReward({ organizerUid, amount, idempotencyKey,
    relatedTournamentId, reason, actorUid } = {}) {
    const invalid = movementError({ organizerUid, type: ENTRY_TYPES.REWARD_CREDIT, amount, idempotencyKey });
    if (invalid) return invalid;
    return applyMovement({ organizerUid, idempotencyKey,
      type: ENTRY_TYPES.REWARD_CREDIT, direction: DIRECTIONS.CREDIT, amount,
      relatedId: relatedTournamentId, reason, actorUid });
  }

  /** An explicitly authorized deadline penalty. Nothing in this phase calls it. */
  async function deductPenalty({ organizerUid, amount, idempotencyKey,
    relatedViolationId, reason, actorUid } = {}) {
    const invalid = movementError({ organizerUid, type: ENTRY_TYPES.PENALTY_DEDUCTION, amount, idempotencyKey });
    if (invalid) return invalid;
    return applyMovement({ organizerUid, idempotencyKey,
      type: ENTRY_TYPES.PENALTY_DEDUCTION, direction: DIRECTIONS.DEBIT, amount,
      relatedId: relatedViolationId, reason, actorUid });
  }

  /** Moves coins from available to held, for a withdrawal that has not been paid yet. */
  async function reserveFunds({ organizerUid, amount, idempotencyKey,
    relatedWithdrawalId, reason, actorUid } = {}) {
    const invalid = movementError({ organizerUid, type: ENTRY_TYPES.WITHDRAWAL_RESERVATION,
      amount, idempotencyKey });
    if (invalid) return invalid;
    return applyMovement({ organizerUid, idempotencyKey,
      type: ENTRY_TYPES.WITHDRAWAL_RESERVATION, direction: DIRECTIONS.HOLD, amount,
      relatedId: relatedWithdrawalId, reason, actorUid });
  }

  /** The money goes out. The hold it came from closes and cannot be used again. */
  async function finalizeReservation({ organizerUid, reservationKey, idempotencyKey,
    reason, actorUid } = {}) {
    return closeHold({ organizerUid, reservationKey, idempotencyKey, reason, actorUid,
      type: ENTRY_TYPES.WITHDRAWAL_FINALIZATION, direction: DIRECTIONS.DEBIT });
  }

  /** The money comes back. The hold it came from closes and cannot be used again. */
  async function releaseReservation({ organizerUid, reservationKey, idempotencyKey,
    reason, actorUid } = {}) {
    return closeHold({ organizerUid, reservationKey, idempotencyKey, reason, actorUid,
      type: ENTRY_TYPES.WITHDRAWAL_RELEASE, direction: DIRECTIONS.CREDIT });
  }

  async function closeHold({ organizerUid, reservationKey, idempotencyKey,
    reason, actorUid, type, direction }) {
    const invalid = badUid(organizerUid) || badType(type);
    if (invalid) return invalid;

    const hold = trim(reservationKey);
    if (!SAFE_KEY.test(hold)) {
      return refused('RESERVATION_KEY_INVALID', 'A reservation is named by the key it was opened with.');
    }
    // One closing key per hold and per kind of closing, so a double tap on "approve" is
    // found as a duplicate rather than paid twice.
    const closing = trim(idempotencyKey) ||
      `${hold}:${type === ENTRY_TYPES.WITHDRAWAL_FINALIZATION ? 'finalize' : 'release'}`;
    const keyProblem = badKey(closing);
    if (keyProblem) return keyProblem;

    return applyMovement({ organizerUid, idempotencyKey: closing, type, direction,
      amount: 0, holdKey: hold, reason, actorUid });
  }

  /**
   * A compensating entry for a mistake, in either direction. The entry being corrected is
   * left untouched and named in `relatedEntryId`, so the pair reads as what happened rather
   * than as a balance somebody quietly edited. A reason is mandatory: an unexplained move of
   * coins is the thing this ledger exists to make impossible.
   */
  async function adjustBalance({ organizerUid, delta, idempotencyKey,
    relatedEntryId, reason, actorUid } = {}) {
    const invalid = badUid(organizerUid) || badKey(idempotencyKey);
    if (invalid) return invalid;
    if (typeof delta !== 'number' || !Number.isFinite(delta) || delta === 0) {
      return refused('AMOUNT_INVALID', 'An adjustment has to move a real, non-zero number of coins.');
    }
    if (Math.abs(delta) > MAX_AMOUNT) {
      return refused('AMOUNT_TOO_LARGE', 'That adjustment is above the supported range.');
    }
    if (!trim(reason)) {
      return refused('REASON_REQUIRED', 'An adjustment has to say why it was made.');
    }

    return applyMovement({ organizerUid, idempotencyKey,
      type: ENTRY_TYPES.ADMIN_ADJUSTMENT,
      direction: delta > 0 ? DIRECTIONS.CREDIT : DIRECTIONS.DEBIT,
      // The ledger stores a magnitude and the direction it moved in; only the arithmetic
      // below needs the sign, so the sign travels beside the magnitude rather than inside
      // it.
      amount: Math.abs(delta), signedDelta: delta,
      relatedId: relatedEntryId, reason, actorUid });
  }

  // ==========================================================================
  // Settings
  // ==========================================================================

  /**
   * The economy amounts, with the defaults this service owns. A later phase takes its
   * amount from here rather than from anything a client sends, and a document that is
   * absent or only partly filled reads back as the same inert defaults the Admin screen
   * shows.
   */
  async function readConfig() {
    const snapshot = await db.collection(CONFIG_COLLECTION).doc(CONFIG_DOCUMENT).get();
    const data = (snapshot.exists && snapshot.data()) || {};
    const coins = (value, fallback) => {
      const read = Number(value);
      return Number.isFinite(read) && read >= 0 && read <= MAX_AMOUNT ? read : fallback;
    };
    const limit = Number(data.defaultDailyTournamentLimit);
    const grace = Number(data.deadlineGraceMinutes);
    return { exists: !!snapshot.exists,
      defaultRewardPerTournament: coins(data.defaultRewardPerTournament, 0),
      defaultDeadlinePenalty: coins(data.defaultDeadlinePenalty, 0),
      defaultDailyTournamentLimit:
        Number.isInteger(limit) && limit >= 0 && limit <= MAX_DAILY_LIMIT ? limit : 0,
      // The deadline penalty is the one economy decision that is switched on by name rather
      // than by having a number ready: a stored amount that nobody enabled charges nobody,
      // and a document from before the switch reads as off. A grace period that is absent,
      // fractional or out of range reads as no grace at all rather than as a wider window
      // than an admin ever approved.
      deadlinePenaltyEnabled: data.deadlinePenaltyEnabled === true,
      deadlineGraceMinutes:
        Number.isInteger(grace) && grace >= 0 && grace <= MAX_GRACE_MINUTES ? grace : 0,
      currency: CURRENCY };
  }

  return {
    initializeWallet,
    getWalletSummary,
    creditReward,
    deductPenalty,
    reserveFunds,
    finalizeReservation,
    releaseReservation,
    adjustBalance,
    readConfig
  };
}

module.exports = {
  createOrganizerEconomyService,
  WALLET_COLLECTION,
  LEDGER_COLLECTION,
  CONFIG_COLLECTION,
  CONFIG_DOCUMENT,
  ENTRY_TYPES,
  DIRECTIONS,
  HOLD_STATES,
  ENTRY_STATUS,
  CURRENCY,
  MAX_AMOUNT,
  MAX_DAILY_LIMIT,
  MAX_GRACE_MINUTES
};
