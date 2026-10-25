/**
 * Organizer wallet routes (mounted at /api/organizer/wallet).
 *
 *   POST /withdrawal  { amount, upiId, idempotencyToken }  – ask for a payout of coins
 *   GET  /withdrawals                                      – this organizer's own requests
 *   GET  /daily-limit                                      – this organizer's own allowance today
 *
 * The caller is the verified ID token, always. There is no organizer uid in either request
 * body, because a body field that names an account is a body field anybody can set: the
 * service reserves against, and lists only, `req.user.uid`. A wallet balance is never read
 * from a client either - the organizer app reads its own `organizer_wallets/{uid}` document,
 * which the rules already let its owner read - so this route exists for the one thing a
 * client must not do on its own: start a money movement.
 *
 * `/daily-limit` follows the same rule for the same reason: it reports the signed-in
 * organizer's own allowance and nothing else, takes no uid and no date from the request, and
 * writes nothing. It is the same count the trusted create route (`POST /api/organizer/tournaments`)
 * enforces, so what this route reports and what that route permits are one number.
 *
 * Device enforcement (Phase 7)
 * ---------------------------
 * `POST /withdrawal` is a financial mutation, so it is gated on the organizer's approved device -
 * see `deviceGate` below for the four cases and why an account that has never enrolled is allowed
 * through once, while an account that *has* an approved device is refused without the header. The
 * two listings stay open: reading your own history is not an operation a device check protects, and
 * an organizer sitting on an unapproved phone still has to be able to see the withdrawals they are
 * locked out of asking for.
 */

const express = require('express');
const admin = require('firebase-admin');
const { verifyAuth } = require('../middleware/auth');
const { createOrganizerEconomyService } = require('../services/organizerEconomy');
const { createOrganizerWithdrawalService } = require('../services/organizerWithdrawals');
const { createOrganizerLedgerService } = require('../services/organizerLedger');
const { createOrganizerDailyLimitService } = require('../services/organizerDailyLimits');
const { createOrganizerDeviceService } = require('../services/organizerDevices');
const { createOrganizerDeviceGate } = require('../services/organizerDeviceGate');
const { createAuditTrail, SECTIONS } = require('../services/auditTrail');

function createOrganizerWalletRouter({
  authenticator = verifyAuth,
  withdrawals,
  economy,
  limits,
  devices,
  audit,
  // Injectable for the same reason the admin router injects it: a service built here on behalf of
  // a test must not need live Firebase credentials.
  database,
  // The clock every event this router writes is stamped with. Injectable for the same reason the
  // database is: the audit rows a test produces have to be written by the same double.
  serverTimestamp = () => admin.firestore.FieldValue.serverTimestamp(),
  dailyLimitOffsetMinutes = process.env.ORGANIZER_DAILY_LIMIT_UTC_OFFSET
} = {}) {
  const router = express.Router();

  const db = () => (database ? database() : admin.firestore());

  // Built on first use, so requiring this module never needs live Firebase credentials and a
  // test can hand the router its own service.
  let service = withdrawals || null;
  let limitService = limits || null;
  let economyService = economy || null;
  let deviceService = devices || null;
  let auditTrail = audit || null;
  let ledgerService = null;

  // One economy handle shared by both features, so the settings document is read through the
  // same validated service either way it is asked.
  function resolveEconomy() {
    if (!economyService) {
      economyService = createOrganizerEconomyService({
        db: db(),
        serverTimestamp
      });
    }
    return economyService;
  }

  function resolveService() {
    if (!service) {
      service = createOrganizerWithdrawalService({
        db: db(),
        economy: resolveEconomy(),
        serverTimestamp
      });
    }
    return service;
  }

  function resolveLimits() {
    if (!limitService) {
      limitService = createOrganizerDailyLimitService({
        db: db(),
        economy: resolveEconomy(),
        // The day boundary is the one this project already publishes for scheduled
        // notifications, overridable the same way, so "today" cannot differ between the two
        // features that both depend on it.
        offsetMinutes: dailyLimitOffsetMinutes
      });
    }
    return limitService;
  }

  function resolveDevices() {
    if (!deviceService) {
      deviceService = createOrganizerDeviceService({
        db: db(),
        serverTimestamp
      });
    }
    return deviceService;
  }

  function resolveAudit() {
    if (!auditTrail) {
      auditTrail = createAuditTrail({ db: db(), serverTimestamp });
    }
    return auditTrail;
  }

  function resolveLedger() {
    if (!ledgerService) {
      ledgerService = createOrganizerLedgerService({ db: db() });
    }
    return ledgerService;
  }

  /**
   * The device check, shared verbatim with the trusted tournament route.
   *
   * `services/organizerDeviceGate.js` owns the four cases - approved, no binding yet, a different
   * device, and no usable identifier while a binding exists - so a financial operation and a
   * match creation can never be guarded by subtly different rules.
   */
  const gate = createOrganizerDeviceGate({
    devices: {
      requireApprovedDevice: args => resolveDevices().requireApprovedDevice(args),
      bindingOf: args => resolveDevices().bindingOf(args)
    }
  });

  // ==========================================================================
  // POST /withdrawal
  // ==========================================================================
  router.post('/withdrawal', authenticator, async (req, res) => {
    const body = req.body || {};
    const amount = typeof body.amount === 'number' ? body.amount : Number(body.amount);
    const upiId = typeof body.upiId === 'string' ? body.upiId : '';
    const token = typeof body.idempotencyToken === 'string' ? body.idempotencyToken : '';

    try {
      // Before anything is reserved: an organizer on an unapproved device must not be able to hold
      // coins against a request that no admin will ever be shown. Nothing has been written here yet,
      // so refusing is a complete no-op, not a half-done money movement.
      const blocked = await gate.check(req);
      if (blocked) {
        console.error('[OrganizerWallet] Withdrawal blocked by device gate', blocked.code,
          'for', req.user.uid, '|', blocked.message);
        return res.status(gate.status(blocked.code)).json({
          success: false,
          code: blocked.code,
          message: blocked.message,
          retryable: blocked.retryable === true,
          approvalRequired: blocked.approvalRequired === true,
          pendingRequestId: blocked.pendingRequestId || null
        });
      }

      const result = await resolveService().createRequest({
        // The organizer is whoever signed in, never whoever the body claims.
        organizerUid: req.user.uid,
        amount,
        upiId,
        idempotencyToken: token
      });

      if (result.code === 'COMPLETE') {
        /*
         * Phase 9: the request is written down by the backend that performed it.
         *
         * The row points at the ledger (`reservationKey`) instead of restating a balance, so the
         * audit trail and the wallet can never disagree - there is only ever one number, and it is
         * the economy service's. A UPI id is deliberately not carried: it is not needed to explain
         * the event and a transcript is readable by every admin account.
         *
         * And an audit failure does not undo or disguise the money: the request stands, the answer
         * stays a success, and `auditRecorded: false` says out loud that it happened without being
         * written down.
         */
        const request = result.request || {};
        const logged = await resolveAudit().record({
          section: SECTIONS.ORGANIZER_ECONOMY,
          actionType: result.duplicate ? 'withdrawal_requested_repeat'
            : 'withdrawal_requested',
          title: 'Organizer withdrawal requested',
          payload: {
            organizerUid: req.user.uid,
            requestId: result.requestId,
            ledgerRef: request.reservationKey || null,
            amount: request.amount,
            currency: request.currency || 'coins',
            outcome: request.status || 'pending',
            device: gate.declaredDevice(req) ? 'declared' : 'not declared'
          },
          performedBy: 'organizer',
          performerId: req.user.uid,
          performerEmail: req.user.email || ''
        });

        return res.json({
          success: true,
          code: result.code,
          message: result.message,
          requestId: result.requestId,
          duplicate: result.duplicate === true,
          resumed: result.resumed === true,
          request: result.request,
          auditRecorded: logged.recorded === true
        });
      }

      const status = result.code === 'NOT_AN_ORGANIZER' ? 403
        : result.code === 'ORGANIZER_BANNED' || result.code === 'ORGANIZER_INACTIVE' ? 403
          : result.code === 'INSUFFICIENT_BALANCE' ? 409
            : result.code === 'FORBIDDEN' ? 403
              : result.code === 'TRANSIENT_FAILURE' ? 503
                : 400;

      if (status >= 400 && result.code !== 'INSUFFICIENT_BALANCE') {
        console.error('[OrganizerWallet] Withdrawal', result.code, 'for', req.user.uid,
          '|', result.message);
      }

      return res.status(status).json({
        success: false,
        code: result.code,
        message: result.message,
        requestId: result.requestId || null,
        request: result.request || null,
        retryable: result.retryable === true
      });
    } catch (error) {
      console.error('[OrganizerWallet] Withdrawal request failed:', error.message);
      return res.status(500).json({
        success: false,
        code: 'REQUEST_FAILED',
        message: 'The withdrawal request could not be processed. Try again.',
        retryable: true
      });
    }
  });

  // ==========================================================================
  // GET /withdrawals
  //
  // The organizer's own history. The uid is taken from the token and passed as a filter, so
  // this can only ever return rows the caller owns; the app could read the same rows straight
  // from Firestore, and does, but a listing that also has to be correct for a client that
  // asks for everything is worth having on the trusted side.
  // ==========================================================================
  router.get('/withdrawals', authenticator, async (req, res) => {
    try {
      const result = await resolveService().listRequests({ organizerUid: req.user.uid });
      return res.json({
        success: true,
        code: 'COMPLETE',
        requests: result.requests,
        count: result.count
      });
    } catch (error) {
      console.error('[OrganizerWallet] History read failed:', error.message);
      return res.status(500).json({
        success: false,
        code: 'REQUEST_FAILED',
        message: 'The withdrawal history could not be read.',
        retryable: true
      });
    }
  });

  // ==========================================================================
  // GET /daily-limit
  //
  // Today's allowance for the signed-in organizer: what is configured, what they have used, and
  // what is left. The uid comes from the token and there is no other input, so one organizer
  // cannot ask about another one's schedule.
  //
  // `enforced` is answered by the server rather than hard-coded on the phone, and it is true
  // because `POST /api/organizer/tournaments` now counts and refuses on the same service. The
  // allowance this route reports is therefore the allowance creation is held to - one reading of
  // the settings, one day boundary, one set of excluded statuses.
  // ==========================================================================
  router.get('/daily-limit', authenticator, async (req, res) => {
    try {
      const result = await resolveLimits().summarize({ organizerUid: req.user.uid });

      if (result.code !== 'COMPLETE') {
        // The same refusal vocabulary the withdrawal route uses, so one caller standing in front
        // of one of these endpoints is told the same thing in both cases.
        const status = result.code === 'NOT_AN_ORGANIZER' ? 403 : 400;
        return res.status(status).json({
          success: false,
          code: result.code,
          message: result.message,
          retryable: false
        });
      }

      return res.json({
        success: true,
        code: result.code,
        day: result.day,
        window: result.window,
        configuredDefaultLimit: result.configuredDefaultLimit,
        overrideLimit: result.overrideLimit,
        effectiveLimit: result.effectiveLimit,
        unlimited: result.unlimited,
        used: result.used,
        remaining: result.remaining,
        reached: result.reached,
        matches: result.matches,
        enforced: true,
        note: 'Creating a match is refused once this allowance is spent.'
      });
    } catch (error) {
      console.error('[OrganizerWallet] Daily limit read failed:', error.message);
      return res.status(500).json({
        success: false,
        code: 'REQUEST_FAILED',
        message: 'The daily tournament limit could not be read.',
        retryable: true
      });
    }
  });

  // ==========================================================================
  // GET /ledger
  //
  // The organizer's own transaction history, read from `organizer_ledger` - the only record of
  // an organizer's money. The uid is the verified caller's and there is no parameter that could
  // name somebody else, so this route can only ever answer with the caller's rows.
  //
  // The page is bounded, filters may only narrow it, and the answer says whether there is more.
  // Nothing here totals, amends or deletes an entry: this is the history, not a way to change it.
  // ==========================================================================
  router.get('/ledger', authenticator, async (req, res) => {
    const query = req.query || {};
    try {
      const result = await resolveLedger().listEntries({
        organizerUid: req.user.uid,
        limit: query.limit,
        cursor: typeof query.cursor === 'string' ? query.cursor : '',
        type: typeof query.type === 'string' ? query.type : '',
        status: typeof query.status === 'string' ? query.status : '',
        fromMillis: query.from === undefined ? null : Number(query.from),
        toMillis: query.to === undefined ? null : Number(query.to)
      });

      if (result.code !== 'COMPLETE') {
        // A refusal answers with no entries at all, so a screen that mishandles the code still
        // cannot show a partial history as though it were the whole one.
        const status = result.code === 'INDEX_NOT_READY' ? 503 : 400;
        return res.status(status).json({
          success: false,
          code: result.code,
          message: result.message,
          retryable: result.retryable === true
        });
      }

      return res.json({
        success: true,
        code: result.code,
        entries: result.entries,
        count: result.count,
        hasMore: result.hasMore,
        nextCursor: result.nextCursor,
        pageSize: result.pageSize,
        filters: result.filters
      });
    } catch (error) {
      console.error('[OrganizerWallet] Ledger read failed:', error.message);
      return res.status(500).json({
        success: false,
        code: 'REQUEST_FAILED',
        message: 'The transaction history could not be read.',
        retryable: true
      });
    }
  });

  return router;
}

module.exports = createOrganizerWalletRouter();
module.exports.createOrganizerWalletRouter = createOrganizerWalletRouter;
