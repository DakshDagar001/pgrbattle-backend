/**
 * Automatic organizer deadline penalties.
 *
 * A match that was scheduled, was never started and whose room details were never filled in
 * is a violation the platform can detect from stored data alone. This service decides three
 * things about it and nothing else: whether the violation actually happened, which
 * organizer is answerable for it, and what the audit trail says about the outcome.
 *
 * What it does NOT own is the money movement. Every deduction goes through
 * `services/organizerEconomy.js`, which is the only code allowed to write
 * `organizer_wallets/{uid}` and `organizer_ledger/{key}`, and which already guarantees the
 * two properties this job depends on: a movement is applied exactly once for its
 * idempotency key, and an available balance never goes below zero. A penalty therefore
 * cannot be double-charged by a job that retries, restarts or runs on two replicas, and it
 * cannot push an organizer into debt.
 *
 * ## The lifecycle this reads (verified against the shipped apps)
 *
 *   - `dateTime` is the scheduled start. The Organizer and Admin compose screens pick a date
 *     and a time and write `dateTime = Timestamp(selectedDateTime.time)`
 *     (`organizer/.../AddEditTournamentActivity.kt`, `Tournament.kt` `toHashMap()`).
 *     `backend/server.js`'s reminder cron queries `startTime`, a field no client ever
 *     writes; this service deliberately reads `dateTime` and does not reuse that query.
 *   - `status` is the state the organizer's own list screen sets: `upcoming`, `ongoing`,
 *     `results`, `cancelled`, `removed`. `upcoming` is the model default and is the only
 *     value that means "scheduled and not started", so it is the only value this job will
 *     ever charge. `completed` is written on a payout row in `transactions/`, not on a
 *     match, and is therefore not part of the vocabulary a deadline can be judged against.
 *   - Cancelling and removing both write `isActive = false` alongside the status, so a
 *     legacy match left inactive is treated as finished with and never charged.
 *   - `roomId` and `roomPassword` are model defaults of `""`, so an absent, empty or
 *     whitespace-only value is the real "the room was never published" signal rather than a
 *     data-quality accident.
 *   - `createdByOrganizerUid` is written once by the creator and stripped from every edit
 *     map; `assignedOrganizerUid` is written only by an admin. Both are read here from the
 *     stored document, never from a client request.
 *
 * ## Why one missed deadline costs one penalty and is still classified in two ways
 *
 * `appConfig/organizerEconomy` names a single `defaultDeadlinePenalty`. Publishing a room
 * late and never starting the match are two readings of the same event - the match did not
 * start when it was supposed to - so the charge is keyed to the deadline and happens once,
 * while the case record keeps the specific `violationType` that was detected, which is what
 * makes the audit question "why was this organizer charged" answerable. The more specific
 * cause wins when both are true: an unpublished room is the usual reason a match never
 * starts. The idempotency key of the deduction is deterministic per match, so a second pass
 * over the same deadline is recorded as a duplicate and moves nothing.
 *
 * ## Who answers for it
 *
 * The organizer the platform handed the match to, or the organizer who made it when nobody
 * was reassigned: `assignedOrganizerUid` first, then `createdByOrganizerUid`. Phase 1 gives
 * both fields the same meaning for *access*, but responsibility is not access, and the
 * Admin screen is the only writer of the assignee field, so the assignee is the organizer
 * the platform last told to run this match. A match that names no organizer is recorded as
 * unresolved and nobody is charged. Reassignment carries no timestamp in the stored data,
 * so a match reassigned after its scheduled start cannot be attributed to whoever was
 * responsible at the moment the deadline passed; that limit is reported rather than guessed
 * around.
 *
 * ## Insufficient coins
 *
 * The economy service refuses a penalty larger than the available balance and writes
 * nothing. This job records that outcome on the case document for review and does not
 * retry it into a different amount, carry it forward, create debt or ban anybody: refusing
 * to invent a debt policy is the point.
 */

/** The audit trail. One document per match deadline, whether or not coins moved. */
const CASES_COLLECTION = 'organizer_penalty_cases';

/** The two conditions this phase can detect from stored data, and nothing else. */
const VIOLATION_TYPES = {
  ROOM_DETAILS_MISSING: 'room_details_missing',
  FAILED_TO_START: 'failed_to_start'
};

/**
 * The states a case passes through. `charged` and `duplicate` both mean the ledger was
 * asked to move the coins; everything after them means it deliberately did not.
 */
const CASE_OUTCOMES = {
  CHARGED: 'charged',
  DUPLICATE: 'duplicate',
  INSUFFICIENT_BALANCE: 'insufficient_balance',
  WALLET_MISSING: 'wallet_missing',
  UNATTRIBUTED: 'unattributed',
  NOT_AN_ORGANIZER: 'not_an_organizer',
  ERROR: 'error'
};

/** The status a match has to be in before a deadline can be judged against it. */
const NOT_STARTED_STATUS = 'upcoming';

/** The scheduler is the actor. It is not a person and cannot be impersonated by a client. */
const SCHEDULER_ACTOR = 'backend:organizer-deadline-scheduler';

/**
 * How far back a sweep looks for missed deadlines. Absent from the settings document on
 * purpose: this is an operational bound, not a product decision, and it exists so that the
 * first run after an admin turns the feature on charges recent history rather than every
 * match the app has ever left in `upcoming`. Render can override it with
 * `ORGANIZER_PENALTY_LOOKBACK_HOURS`.
 */
const DEFAULT_LOOKBACK_HOURS = 48;
const MAX_LOOKBACK_HOURS = 720;

/** The per-sweep bound on how many matches are examined, so one pass cannot run away. */
const MAX_CASES_PER_SWEEP = 200;

/** A document id this service is willing to build. Match ids are push ids; anything that
 *  could turn into a path is refused rather than charged. */
const SAFE_ID = /^[A-Za-z0-9_:.-]{1,120}$/;

function trim(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** A Firestore Timestamp, a Date, a number of milliseconds, or nothing at all. */
function toMillis(value) {
  if (!value) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value.toDate === 'function') {
    try {
      const ms = value.toDate().getTime();
      return Number.isFinite(ms) ? ms : null;
    } catch (error) {
      return null;
    }
  }
  if (typeof value.seconds === 'number') {
    return value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1e6);
  }
  return null;
}

/**
 * Whether this stored match is a deadline violation right now.
 *
 * Every condition the brief names is checked here, in the order that costs least, and any
 * doubt at any step returns null - which means "do not charge". An absent status is not
 * read as `upcoming` even though the app model would default it, because a missing field is
 * not proof that an organizer failed to start a match.
 */
function classifyViolation(data, { nowMs, graceMinutes }) {
  const status = trim(data.status).toLowerCase();
  if (status !== NOT_STARTED_STATUS) return null;
  if (data.isActive === false) return null;

  const scheduledAt = toMillis(data.dateTime);
  if (scheduledAt === null) return null;

  const deadlineAt = scheduledAt + Math.max(0, Number(graceMinutes) || 0) * 60000;
  if (nowMs < deadlineAt) return null;

  const roomId = trim(data.roomId);
  const roomPassword = trim(data.roomPassword);
  if (!roomId || !roomPassword) {
    return {
      type: VIOLATION_TYPES.ROOM_DETAILS_MISSING,
      scheduledAt,
      deadlineAt,
      detail: roomId || roomPassword
        ? 'Room id or password was still missing when the deadline passed'
        : 'Room id and password were still missing when the deadline passed'
    };
  }

  return {
    type: VIOLATION_TYPES.FAILED_TO_START,
    scheduledAt,
    deadlineAt,
    detail: 'The match was still upcoming after its scheduled start and grace period'
  };
}

/** The organizer answerable for this match, and how the answer was reached. */
function resolveResponsible(data) {
  const assignee = trim(data.assignedOrganizerUid);
  if (assignee) return { organizerUid: assignee, basis: 'assigned_organizer' };
  const creator = trim(data.createdByOrganizerUid);
  if (creator) return { organizerUid: creator, basis: 'creator' };
  return { organizerUid: '', basis: 'unattributed' };
}

/**
 * @param {object} deps
 * @param {object} deps.db                       Firestore handle (Admin SDK)
 * @param {object} deps.economy                  `createOrganizerEconomyService()` instance
 * @param {Function} deps.serverTimestamp        the server clock behind every written event
 * @param {Function} [deps.now]                  injectable clock, so a sweep is testable
 * @param {number} [deps.lookbackHours]          how far back a missed deadline still counts
 * @param {string} [deps.collection]             tournaments collection override (tests)
 */
function createPenaltyEnforcementService({
  db,
  economy,
  serverTimestamp,
  now = () => Date.now(),
  lookbackHours = DEFAULT_LOOKBACK_HOURS,
  maxCasesPerSweep = MAX_CASES_PER_SWEEP,
  collection = 'tournaments'
} = {}) {
  if (!db || !economy || !serverTimestamp) {
    throw new Error('createPenaltyEnforcementService requires db, economy and serverTimestamp');
  }

  const boundedLookback = Math.min(
    Math.max(0, Number(lookbackHours) || DEFAULT_LOOKBACK_HOURS),
    MAX_LOOKBACK_HOURS
  );
  const scanLimit = Math.max(1, Number(maxCasesPerSweep) || MAX_CASES_PER_SWEEP);

  const caseRefOf = id => db.collection(CASES_COLLECTION).doc(id);

  /** One line of the sweep's report: how many matches were looked at, and what each became. */
  function tally() {
    const counts = { scanned: 0 };
    return {
      counts,
      record(outcome) {
        counts[outcome] = (counts[outcome] || 0) + 1;
      },
      summary() {
        return counts;
      }
    };
  }

  /**
   * The deterministic charge key. One deduction per match and per missed deadline, so a
   * sweep that runs twice, a retry after a dropped connection and two replicas all land on
   * the same ledger document. The violation type is deliberately *not* in the key: a match
   * whose room was missing at the first pass and merely unstarted at the second is the same
   * violation, and a key that changed with the classification would charge it twice.
   */
  const chargeKeyFor = tournamentId => `penalty:${tournamentId}:deadline_missed`;
  const caseIdFor = tournamentId => `penalty_case:${tournamentId}`;

  async function writeCase({ caseId, tournamentId, organizerUid, basis, violation,
    outcome, configuredAmount, detail, ledgerEntryId }) {
    await caseRefOf(caseId).set({
      tournamentId,
      organizerUid: organizerUid || null,
      responsibilityBasis: basis,
      violationType: violation ? violation.type : null,
      scheduledAt: violation ? violation.scheduledAt : null,
      deadlineAt: violation ? violation.deadlineAt : null,
      currency: 'coins',
      configuredAmount: configuredAmount === null || configuredAmount === undefined
        ? null : configuredAmount,
      outcome,
      detail: detail || null,
      ledgerEntryId: ledgerEntryId || null,
      processedBy: SCHEDULER_ACTOR,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    }, { merge: true });
  }

  /**
   * One match, one decision, one audit row. Returns the outcome name so the sweep can count
   * it; never throws, because one bad document must not end a sweep that is also responsible
   * for every other match in the window.
   */
  async function processMatch(document, config) {
    const tournamentId = String(document.id || '');
    if (!SAFE_ID.test(tournamentId)) {
      console.error('[OrganizerPenalties] Unusable match id, skipped:', tournamentId);
      return 'skipped_id';
    }

    const data = (typeof document.data === 'function' && document.data()) || {};
    const violation = classifyViolation(data, {
      nowMs: now(),
      graceMinutes: config.deadlineGraceMinutes
    });
    if (!violation) return 'not_a_violation';

    const caseId = caseIdFor(tournamentId);
    const existing = await caseRefOf(caseId).get();
    if (existing.exists) {
      const closed = trim((existing.data() || {}).outcome);
      // A match already dealt with is not dealt with twice. The ledger key is still the real
      // guarantee; this is the one that keeps the audit trail from being rewritten and keeps
      // a sweep from re-reading the whole window every five minutes.
      if (closed && closed !== CASE_OUTCOMES.ERROR) return 'already_closed';
    }

    const responsible = resolveResponsible(data);
    if (!responsible.organizerUid) {
      await writeCase({ caseId, tournamentId, organizerUid: '', basis: responsible.basis,
        violation, outcome: CASE_OUTCOMES.UNATTRIBUTED,
        configuredAmount: config.defaultDeadlinePenalty,
        detail: `${violation.detail}; no organizer is named on the match, so nobody was charged` });
      return 'unattributed';
    }
    if (!SAFE_ID.test(responsible.organizerUid)) {
      console.error('[OrganizerPenalties] Unusable organizer uid on match', tournamentId);
      return 'skipped_uid';
    }

    // A uid is not a role. Penalty money only moves for an account that exists in
    // `organizer_users`, so a match that names a deleted or player uid cannot charge anybody.
    const accountSnap = await db.collection('organizer_users').doc(responsible.organizerUid).get();
    if (!accountSnap.exists) {
      await writeCase({ caseId, tournamentId, organizerUid: responsible.organizerUid,
        basis: responsible.basis, violation, outcome: CASE_OUTCOMES.NOT_AN_ORGANIZER,
        configuredAmount: config.defaultDeadlinePenalty,
        detail: `${violation.detail}; the attributed account is not a registered organizer` });
      return 'not_organizer';
    }

    const walletSnap = await db.collection('organizer_wallets')
      .doc(responsible.organizerUid).get();
    if (!walletSnap.exists) {
      // The wallet is opened at zero by the trusted path. A penalty does not conjure one,
      // and it certainly does not conjure a negative balance inside one.
      await writeCase({ caseId, tournamentId, organizerUid: responsible.organizerUid,
        basis: responsible.basis, violation, outcome: CASE_OUTCOMES.WALLET_MISSING,
        configuredAmount: config.defaultDeadlinePenalty,
        detail: `${violation.detail}; this organizer has no wallet yet, so nothing was charged` });
      return 'wallet_missing';
    }

    const result = await economy.deductPenalty({
      organizerUid: responsible.organizerUid,
      // The amount is read from the settings document on this pass, never from the match and
      // never from a client.
      amount: config.defaultDeadlinePenalty,
      idempotencyKey: chargeKeyFor(tournamentId),
      relatedViolationId: caseId,
      reason: `${violation.type}: match ${tournamentId} missed its scheduled start`,
      actorUid: SCHEDULER_ACTOR
    });

    if (result.code === 'COMPLETE') {
      await writeCase({ caseId, tournamentId, organizerUid: responsible.organizerUid,
        basis: responsible.basis, violation, outcome: CASE_OUTCOMES.CHARGED,
        configuredAmount: config.defaultDeadlinePenalty, ledgerEntryId: result.entryId,
        detail: `${violation.detail}; ${config.defaultDeadlinePenalty} coins deducted` });
      return 'charged';
    }

    if (result.code === 'DUPLICATE') {
      await writeCase({ caseId, tournamentId, organizerUid: responsible.organizerUid,
        basis: responsible.basis, violation, outcome: CASE_OUTCOMES.DUPLICATE,
        configuredAmount: config.defaultDeadlinePenalty, ledgerEntryId: result.entryId,
        detail: `${violation.detail}; already charged for this deadline` });
      return 'duplicate';
    }

    if (result.code === 'INSUFFICIENT_BALANCE') {
      // Part E: the violation stands, the charge does not happen, and no negative balance is
      // invented. The record is what an admin reviews.
      await writeCase({ caseId, tournamentId, organizerUid: responsible.organizerUid,
        basis: responsible.basis, violation, outcome: CASE_OUTCOMES.INSUFFICIENT_BALANCE,
        configuredAmount: config.defaultDeadlinePenalty,
        detail: `${violation.detail}; ${config.defaultDeadlinePenalty} coins were due and the ` +
          `available balance was ${result.availableBalance}, so nothing was deducted` });
      return 'insufficient';
    }

    if (result.code === 'WALLET_MISSING') {
      await writeCase({ caseId, tournamentId, organizerUid: responsible.organizerUid,
        basis: responsible.basis, violation, outcome: CASE_OUTCOMES.WALLET_MISSING,
        configuredAmount: config.defaultDeadlinePenalty, detail: result.message });
      return 'wallet_missing';
    }

    console.error('[OrganizerPenalties] Deduction refused for match', tournamentId,
      '|', result.code, result.message);
    await writeCase({ caseId, tournamentId, organizerUid: responsible.organizerUid,
      basis: responsible.basis, violation, outcome: CASE_OUTCOMES.ERROR,
      configuredAmount: config.defaultDeadlinePenalty,
      detail: `${violation.detail}; refused with ${result.code}` });
    return 'error';
  }

  /**
   * One pass over the deadline window.
   *
   * The query is `status == upcoming` plus a `dateTime` range - one equality and one range
   * on one field, which is the shape of an index this project already deploys
   * (`firestore.indexes.json`, tournaments `status` + `dateTime`). Nothing new has to be
   * indexed for penalties to work, and nothing here trusts the broken `startTime` reminder
   * query that already ships.
   */
  async function sweepOnce() {
    const config = await economy.readConfig();

    // Disabled by default and stays disabled until an admin enables it by name. A configured
    // amount without the switch is not permission to charge anybody.
    if (!config.deadlinePenaltyEnabled) {
      return { code: 'DISABLED', enabled: false, summary: tally().summary() };
    }
    // A penalty of zero coins is not a small penalty, it is no penalty: the economy service
    // refuses a zero movement outright, so charging would only produce error noise.
    if (!(config.defaultDeadlinePenalty > 0)) {
      console.warn('[OrganizerPenalties] Enabled with no penalty amount configured; nothing charged');
      return { code: 'NO_AMOUNT_CONFIGURED', enabled: true, summary: tally().summary() };
    }

    const nowMs = now();
    const graceMs = config.deadlineGraceMinutes * 60000;
    const upperBound = new Date(nowMs - graceMs);
    const lowerBound = new Date(nowMs - boundedLookback * 3600000);

    const snapshot = await db.collection(collection)
      .where('status', '==', NOT_STARTED_STATUS)
      .where('dateTime', '>=', lowerBound)
      .where('dateTime', '<=', upperBound)
      .limit(scanLimit)
      .get();

    const report = tally();
    const outcomes = [];
    for (const document of snapshot.docs) {
      report.counts.scanned++;
      try {
        const outcome = await processMatch(document, config);
        outcomes.push({ tournamentId: document.id, outcome });
        report.record(outcome);
      } catch (error) {
        // A transient Firestore failure is reported and left for the next pass, which is
        // safe because the charge itself is idempotent. The case document is deliberately
        // not written as `error` here: the next sweep will reach the same match again.
        report.counts.errors++;
        outcomes.push({ tournamentId: document.id, outcome: 'threw' });
        console.error('[OrganizerPenalties] Match', document.id,
          'could not be processed:', error.message);
      }
    }

    return {
      code: 'COMPLETE',
      enabled: true,
      penaltyAmount: config.defaultDeadlinePenalty,
      graceMinutes: config.deadlineGraceMinutes,
      window: { from: lowerBound.toISOString(), to: upperBound.toISOString() },
      summary: report.summary(),
      outcomes
    };
  }

  return { sweepOnce, processMatch, classifyViolation, resolveResponsible, CASES_COLLECTION };
}

module.exports = {
  createPenaltyEnforcementService,
  classifyViolation,
  resolveResponsible,
  CASES_COLLECTION,
  VIOLATION_TYPES,
  CASE_OUTCOMES,
  NOT_STARTED_STATUS,
  SCHEDULER_ACTOR,
  DEFAULT_LOOKBACK_HOURS,
  MAX_LOOKBACK_HOURS,
  MAX_CASES_PER_SWEEP
};
