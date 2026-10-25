/**
 * Tournament-completion rewards for organizers.
 *
 * ## The completion milestone this trusts, and why
 *
 * A tournament document never carries `status == "completed"`: the status vocabulary the
 * compose screens write is `upcoming`, `ongoing`, `results`, `cancelled`, `removed`, and
 * `completed` is written on a *player payout row* in `transactions/`, not on the match. Reading
 * a status name as proof of completion would therefore be guessing.
 *
 * The signal that is real is `tournaments/{id}.prizesDistributed === true`. It is written by the
 * results transaction itself - the same transaction that writes every participant's
 * `odcPrizeIssued` flag and the player payout row - so it cannot be true before results are
 * finalised and paid, and the admin "reset results" flow sets it back to false when a result is
 * withdrawn. Both apps' `ResultsAssignActivity` write it in exactly one place.
 *
 * The status guard below is the other half: an `upcoming`, `ongoing`, `cancelled` or `removed`
 * match is never rewarded, however its payout flag reads, so a stale or hand-edited flag on a
 * match that is not finished cannot pay an organizer.
 *
 * ## Who is paid
 *
 * `resolveResponsible` - the assignee if the platform handed the match to somebody, otherwise
 * the creator. That is the identical rule the deadline penalty and the daily allowance use, so
 * the three features can never disagree about who a match belongs to. A match with neither field
 * is recorded as unattributed and nobody is paid; the brief's ambiguity (creator and assignee may
 * differ) is resolved by the policy the codebase already applies to money, not by a new guess.
 *
 * ## Why retries cannot double-pay
 *
 * The ledger key is `reward:{tournamentId}:tournament_completed`: it names the milestone and the
 * match, nothing about the amount, the recipient or the moment. `creditReward` reads that entry
 * inside the same transaction as the balance, so a listener that fires twice, a catch-up pass that
 * runs beside the listener, and two replicas all land on one ledger document and move coins once.
 * The audit row likewise records the duplicate rather than hiding it.
 *
 * ## What this does not do
 *
 * It does not open a wallet for somebody who should not have one, it does not pay rupees, and it
 * does not touch a player's `transactions/` balance. A wallet that does not exist yet is opened at
 * zero by the trusted primitive first, because a credit into a missing wallet is refused and a
 * reward that is silently lost is worse than one that is slightly later.
 */

const { resolveResponsible } = require('./organizerPenalties');

/** The actor every reward row is attributed to. Not a person; no client can claim it. */
const REWARD_ACTOR = 'backend:organizer-reward-scheduler';

/**
 * The states a match must not be in, whatever its payout flag says. A reward is for a match that
 * was played and settled, not for one that is scheduled, running, cancelled or removed.
 */
const NOT_REWARDABLE_STATUSES = ['upcoming', 'ongoing', 'cancelled', 'removed'];

/** The audit section these rows belong to, matching the rest of the economy. */
const AUDIT_SECTION = 'organizer_economy';

/** A document id this service is willing to build a ledger key from. */
const SAFE_ID = /^[A-Za-z0-9_:.-]{1,120}$/;

function trim(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function refused(code, message, extra = {}) {
  return { code, message, applied: false, credited: false, ...extra };
}

/**
 * The deterministic idempotency key. Stable per match and per milestone - never per attempt - so
 * a duplicate delivery is detected by the ledger rather than by whoever happened to be listening.
 */
function rewardKeyFor(tournamentId) {
  return `reward:${tournamentId}:tournament_completed`;
}

/**
 * @param {object} deps
 * @param {object} deps.db                 Firestore handle (Admin SDK)
 * @param {object} deps.economy            `createOrganizerEconomyService()` instance
 * @param {object} [deps.audit]            `createAuditTrail()` instance, optional
 * @param {Function} [deps.now]            injectable clock
 * @param {string} [deps.collection]       tournaments collection override (tests)
 * @param {string} [deps.organizerCollection] organizer_users override (tests)
 */
function createOrganizerRewardService({
  db,
  economy,
  audit = null,
  now = () => Date.now(),
  collection = 'tournaments',
  organizerCollection = 'organizer_users'
} = {}) {
  if (!db || !economy) {
    throw new Error('createOrganizerRewardService requires db and economy');
  }

  async function record(actionType, payload) {
    if (!audit) return { recorded: false, error: 'no audit trail wired' };
    return audit.record({
      section: AUDIT_SECTION,
      actionType,
      title: actionType === 'reward_credited' ? 'Organizer tournament reward credited'
        : actionType === 'reward_already_credited' ? 'Organizer tournament reward already credited'
          : 'Organizer tournament reward skipped',
      payload,
      performedBy: 'backend',
      performerId: REWARD_ACTOR,
      performerEmail: ''
    });
  }

  /**
   * Pay the reward for one match, if that match is verifiably finished.
   *
   * Never throws for a match that simply does not qualify: a listener that receives every
   * tournament write must not turn "this one is still upcoming" into an error log line every
   * time the document is touched.
   */
  async function grantForTournament({ tournamentId } = {}) {
    const id = trim(tournamentId);
    if (!id || !SAFE_ID.test(id)) {
      return refused('TOURNAMENT_ID_INVALID', 'A usable tournament id is required.');
    }

    const snapshot = await db.collection(collection).doc(id).get();
    if (!snapshot.exists) return refused('NOT_FOUND', 'This tournament does not exist.');

    const data = (snapshot.data && snapshot.data()) || {};

    // The milestone. Everything below this line is only reached for a match whose results have
    // been finalised and whose player prizes have been paid.
    if (data.prizesDistributed !== true) {
      return refused('NOT_COMPLETED',
        'Results have not been finalised for this tournament, so no reward is due.');
    }

    const status = trim(data.status).toLowerCase();
    if (NOT_REWARDABLE_STATUSES.includes(status)) {
      const logged = await record('reward_skipped', {
        tournamentId: id, reason: 'status_not_rewardable', status: status || 'unknown',
        outcome: 'skipped'
      });
      return refused('NOT_REWARDABLE',
        `A ${status || 'non-final'} tournament is not rewarded.`,
        { auditRecorded: logged.recorded === true });
    }

    // The amount is the platform's configured reward and nothing else. Absent, zero or
    // out-of-range means no reward has been decided, which is not the same as "pay nothing
    // silently" - it is recorded once per match so the gap is visible to an admin.
    const config = await economy.readConfig();
    const amount = config.defaultRewardPerTournament;
    if (!(amount > 0)) {
      const logged = await record('reward_skipped', {
        tournamentId: id, reason: 'no_reward_configured', amount: 0, outcome: 'skipped'
      });
      return refused('NO_AMOUNT_CONFIGURED',
        'No reward per tournament is configured, so nothing was credited.',
        { auditRecorded: logged.recorded === true });
    }

    const responsible = resolveResponsible(data);
    if (!responsible.organizerUid) {
      const logged = await record('reward_skipped', {
        tournamentId: id, reason: 'unattributed', amount, currency: 'coins', outcome: 'skipped'
      });
      return refused('UNATTRIBUTED',
        'The match names no organizer, so there is nobody to pay.',
        { auditRecorded: logged.recorded === true });
    }

    const organizerUid = responsible.organizerUid;
    if (!SAFE_ID.test(organizerUid)) {
      return refused('ORGANIZER_UID_INVALID', 'The organizer named on this match is not usable.');
    }

    // A uid is not a role: only an account this platform registers as an organizer can hold
    // organizer coins. A deleted or player uid on a match pays nobody.
    const accountSnap = await db.collection(organizerCollection).doc(organizerUid).get();
    if (!accountSnap.exists) {
      const logged = await record('reward_skipped', {
        tournamentId: id, organizerUid, reason: 'not_an_organizer', amount,
        currency: 'coins', outcome: 'skipped'
      });
      return refused('NOT_AN_ORGANIZER',
        'The account named on this match is not a registered organizer.',
        { auditRecorded: logged.recorded === true });
    }

    // A credit into a wallet that does not exist is refused by the economy service, and an
    // organizer whose first event is a reward would lose it. Opening the wallet is idempotent:
    // an existing one is returned untouched.
    const opened = await economy.initializeWallet({ organizerUid, actorUid: REWARD_ACTOR });
    if (opened.code !== 'COMPLETE' && opened.code !== 'EXISTS') {
      return refused(opened.code || 'WALLET_UNAVAILABLE',
        opened.message || 'The organizer wallet could not be opened.');
    }

    const result = await economy.creditReward({
      organizerUid,
      // Read from the settings document on this pass, never from the match and never from a
      // client request.
      amount,
      idempotencyKey: rewardKeyFor(id),
      relatedTournamentId: id,
      reason: `Completed tournament ${id}`,
      actorUid: REWARD_ACTOR
    });

    if (result.code === 'COMPLETE') {
      const logged = await record('reward_credited', {
        tournamentId: id,
        organizerUid,
        responsibilityBasis: responsible.basis,
        amount,
        currency: 'coins',
        // The ledger entry is the balance history; the audit row only points at it.
        ledgerRef: result.entryId || rewardKeyFor(id),
        availableAfter: result.availableBalance,
        outcome: 'credited'
      });
      return {
        code: 'COMPLETE', applied: true, credited: true, duplicate: false,
        tournamentId: id, organizerUid, amount, entryId: result.entryId,
        availableBalance: result.availableBalance,
        auditRecorded: logged.recorded === true
      };
    }

    if (result.code === 'DUPLICATE') {
      // The ledger already holds this reward. Nothing moved, and saying so is the correct answer
      // rather than an error: it is what a retry, a second listener or a catch-up pass sees.
      const logged = await record('reward_already_credited', {
        tournamentId: id, organizerUid, amount, currency: 'coins',
        ledgerRef: result.entryId || rewardKeyFor(id), outcome: 'duplicate'
      });
      return {
        code: 'DUPLICATE', applied: false, credited: false, duplicate: true,
        tournamentId: id, organizerUid, amount, entryId: result.entryId,
        auditRecorded: logged.recorded === true
      };
    }

    console.error('[OrganizerRewards] Credit refused for', id, '|', result.code, result.message);
    const logged = await record('reward_skipped', {
      tournamentId: id, organizerUid, amount, currency: 'coins',
      reason: result.code || 'refused', outcome: 'refused'
    });
    return refused(result.code || 'REFUSED',
      result.message || 'The reward could not be credited.',
      { auditRecorded: logged.recorded === true });
  }

  /**
   * A bounded safety net for the window a listener cannot cover: a restart, a dropped snapshot
   * connection, or a completion that happened while the backend was down.
   *
   * The scan is bounded by the match's scheduled start - one range on one field, no new index -
   * and `prizesDistributed` is filtered in memory rather than in a second equality, because the
   * project deploys no composite index for this collection. Re-running it is free: every match it
   * reaches is protected by the same ledger key.
   */
  async function catchUp({ sinceHours = 168, limit = 300 } = {}) {
    const hours = Math.min(Math.max(Number(sinceHours) || 0, 1), 720);
    const cap = Math.min(Math.max(Number(limit) || 0, 1), 500);
    const since = new Date(now() - hours * 3600000);

    const snapshot = await db.collection(collection)
      .where('dateTime', '>=', since)
      .limit(cap)
      .get();

    const summary = { scanned: 0, credited: 0, duplicate: 0, skipped: 0, failed: 0 };
    const results = [];

    for (const document of snapshot.docs || []) {
      const data = (document.data && document.data()) || {};
      summary.scanned++;
      if (data.prizesDistributed !== true) continue;

      try {
        const result = await grantForTournament({ tournamentId: document.id });
        if (result.code === 'COMPLETE') summary.credited++;
        else if (result.code === 'DUPLICATE') summary.duplicate++;
        else summary.skipped++;
        results.push({ tournamentId: document.id, code: result.code });
      } catch (error) {
        // A transient failure is left for the next pass; the ledger key makes that safe.
        summary.failed++;
        results.push({ tournamentId: document.id, code: 'ERROR' });
        console.error('[OrganizerRewards] Catch-up failed for', document.id, '|', error.message);
      }
    }

    return { code: 'COMPLETE', window: { since: since.toISOString(), hours }, summary, results };
  }

  return { grantForTournament, catchUp, rewardKeyFor };
}

module.exports = {
  createOrganizerRewardService,
  rewardKeyFor,
  REWARD_ACTOR,
  NOT_REWARDABLE_STATUSES,
  SAFE_ID
};
