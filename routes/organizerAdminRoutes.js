/**
 * Admin organizer-economy routes (mounted at /api/admin/organizer).
 *
 *   GET  /withdrawals                  ?status=pending   – the review queue
 *   POST /withdrawal/approve         { requestId }          – finalize the hold, once
 *   POST /withdrawal/reject          { requestId, reason }  – release the hold, once
 *   POST /penalty-sweep              {}                      – run the deadline check now
 *
 *   GET  /devices                      ?status=pending      – the device-approval queue
 *   GET  /device/binding                 ?organizerUid      – one organizer's approved device
 *   POST /device/approve               { requestId }          – bind that device, once
 *   POST /device/reject                { requestId, reason }  – refuse it, binding untouched
 *   POST /device/reset                 { organizerUid, reason } – clear a lost device
 *
 *   GET  /audit                        ?section=&organizerUid= – the activity history
 *   GET  /ledger                       ?organizerUid=&limit=&cursor= – the coin movements
 *   POST /tournament/assign           { tournamentId, organizerUid } – hand a match to an organizer
 *
 * `/audit` with a `section` is one page of that section. With an `organizerUid` and no `section`
 * it is one organizer's whole history: the three sections this phase writes, merged newest first
 * and cut to the same bounded page.
 *
 * Authorization is the same two-factor check the other admin routes use: a valid Firebase ID
 * token from `verifyAuth`, plus that uid existing in `admin_users` - the same source the
 * Firestore rules use for `isAdmin()`. The request id in the body is a selector and carries
 * no authority, and the reviewer recorded on a withdrawal is always `req.user.uid`.
 *
 * The amounts are never read from a body here. Approving pays the amount the request was
 * created with, releasing restores the amount that was actually held, and the sweep reads its
 * amount from `appConfig/organizerEconomy`. An admin who could name an amount in a request
 * would be an admin who could take coins from any wallet.
 */

const express = require('express');
const admin = require('firebase-admin');
const { verifyAuth } = require('../middleware/auth');
const { createOrganizerEconomyService } = require('../services/organizerEconomy');
const { createOrganizerWithdrawalService } = require('../services/organizerWithdrawals');
const { createPenaltyEnforcementService } = require('../services/organizerPenalties');
const { createOrganizerDeviceService } = require('../services/organizerDevices');
const { createOrganizerLedgerService } = require('../services/organizerLedger');
const { createOrganizerAssignments } = require('../services/organizerAssignments');
const { createAuditTrail, SECTIONS } = require('../services/auditTrail');

/**
 * The sections one organizer's activity is assembled from, in the order a reader expects them:
 * the account first, then the phone it may act from, then the coins it moved.
 */
const ORGANIZER_SECTIONS = [
  SECTIONS.ORGANIZERS,
  SECTIONS.ORGANIZER_DEVICES,
  SECTIONS.ORGANIZER_ECONOMY
];

/**
 * How many rows one merged page may contain. Smaller than a single-section page because the merged
 * read touches three collections, and a screen that shows a history shows a screenful, not a table.
 */
const ORGANIZER_PAGE_SIZE = 25;

/** Same admin source of truth the other admin routes already use. */
async function defaultIsAdminUid(uid) {
  if (!uid) return false;
  try {
    const doc = await admin.firestore().collection('admin_users').doc(uid).get();
    return doc.exists;
  } catch (error) {
    console.error('[AdminOrganizer] Admin check failed:', error.message);
    return false;
  }
}

function createAdminOrganizerRouter({
  authenticator = verifyAuth,
  isAdminUid = defaultIsAdminUid,
  withdrawals,
  penalties,
  devices,
  audit,
  ledger,
  assignments,
  // Injectable for the same reason the admin router injects the database: a test's transcript rows
  // have to be written through the same double as everything else.
  serverTimestamp = () => admin.firestore.FieldValue.serverTimestamp(),
  // Injectable for the same reason the services are: the queue joins each request to the
  // organizer's display name, and a test of that join must not need live credentials.
  database
} = {}) {
  const router = express.Router();

  const db = () => (database ? database() : admin.firestore());

  // Built on first use so requiring this module never needs live Firebase credentials, and so
  // a test can hand the router its own services.
  let withdrawalService = withdrawals || null;
  let penaltyService = penalties || null;
  let deviceService = devices || null;
  let auditTrail = audit || null;
  let ledgerService = ledger || null;
  let assignmentService = assignments || null;

  function resolveAssignments() {
    if (!assignmentService) {
      assignmentService = createOrganizerAssignments({
        db: db(),
        economy: createOrganizerEconomyService({ db: db(), serverTimestamp }),
        audit: resolveAudit(),
        serverTimestamp
      });
    }
    return assignmentService;
  }

  function resolveLedger() {
    if (!ledgerService) ledgerService = createOrganizerLedgerService({ db: db() });
    return ledgerService;
  }

  function resolveAudit() {
    if (!auditTrail) auditTrail = createAuditTrail({ db: db(), serverTimestamp });
    return auditTrail;
  }

  function resolveDevices() {
    if (!deviceService) {
      deviceService = createOrganizerDeviceService({
        db: db(), serverTimestamp, audit: resolveAudit()
      });
    }
    return deviceService;
  }

  function resolveWithdrawals() {
    if (!withdrawalService) {
      withdrawalService = createOrganizerWithdrawalService({
        db: db(),
        economy: createOrganizerEconomyService({ db: db(), serverTimestamp }),
        serverTimestamp
      });
    }
    return withdrawalService;
  }

  function resolvePenalties() {
    if (!penaltyService) {
      const economy = createOrganizerEconomyService({ db: db(), serverTimestamp });
      const lookback = Number(process.env.ORGANIZER_PENALTY_LOOKBACK_HOURS);
      penaltyService = createPenaltyEnforcementService({
        db: db(),
        economy,
        serverTimestamp,
        ...(Number.isFinite(lookback) && lookback > 0 ? { lookbackHours: lookback } : {})
      });
    }
    return penaltyService;
  }

  /** Every route below is admin-only, and says so before it reads anything. */
  async function requireAdmin(req, res) {
    let allowed = false;
    try {
      allowed = await isAdminUid(req.user.uid);
    } catch (error) {
      console.error('[AdminOrganizer] Admin check threw:', error.message);
      allowed = false;
    }
    if (!allowed) {
      res.status(403).json({ success: false, code: 'FORBIDDEN',
        message: 'Only an administrator can review organizer withdrawals and devices.' });
      return false;
    }
    return true;
  }

  /**
   * The review queue, with the identity an admin needs beside each amount. Organizer names
   * are read from `organizer_users` rather than stored on the request, so a rename does not
   * rewrite financial history and a request cannot be pointed at a different organizer.
   */
  router.get('/withdrawals', authenticator, async (req, res) => {
    if (!await requireAdmin(req, res)) return undefined;
    const status = typeof req.query.status === 'string' ? req.query.status.trim() : '';
    /*
     * Optional, and only ever a filter. The organizer detail view opens this same review narrowed
     * to the account whose page the admin is on, rather than growing a second, weaker list. It
     * selects rows: it grants no authority, and both decision routes below still take their
     * reviewer from the verified caller rather than from anything a listing was asked with.
     */
    const organizerUid = typeof req.query.organizerUid === 'string'
      ? req.query.organizerUid.trim()
      : '';
    const limit = Number(req.query.limit) || 50;

    try {
      const result = await resolveWithdrawals().listRequests({ organizerUid, status, limit });
      const withIdentity = [];
      for (const request of result.requests) {
        let username = '';
        try {
          const account = await db().collection('organizer_users')
            .doc(request.organizerUid).get();
          username = (account.exists && account.data().username) || '';
        } catch (error) {
          // An unreadable display name is not a reason to hide a withdrawal from review.
          console.error('[AdminOrganizer] Organizer name read failed:', error.message);
        }
        withIdentity.push({ ...request, username });
      }
      return res.json({ success: true, code: 'COMPLETE', requests: withIdentity,
        count: withIdentity.length });
    } catch (error) {
      console.error('[AdminOrganizer] Withdrawal list failed:', error.message);
      return res.status(500).json({ success: false, code: 'REQUEST_FAILED',
        message: 'The withdrawal requests could not be read.', retryable: true });
    }
  });

  /** The single difference between the two review routes is the decision. */
  function reviewRoute(decision) {
    return async (req, res) => {
      if (!await requireAdmin(req, res)) return undefined;
      const body = req.body || {};
      const requestId = typeof body.requestId === 'string' ? body.requestId.trim() : '';
      const reason = typeof body.reason === 'string' ? body.reason : '';

      if (!requestId) {
        return res.status(400).json({ success: false, code: 'REQUEST_ID_REQUIRED',
          message: 'The withdrawal to review has to be named.' });
      }

      try {
        const result = await resolveWithdrawals().reviewRequest({
          requestId,
          // The reviewer is the authenticated admin, never a value from the body.
          reviewerUid: req.user.uid,
          decision,
          reason
        });

        if (result.code === 'COMPLETE' || result.code === 'REJECTED') {
          /*
           * Phase 9: the decision is recorded by the backend that carried it out, and the row
           * points at the ledger entry rather than repeating a balance. `reconciled` is kept in
           * the payload because "this decision was already made, and the coins moved on the first
           * one" is exactly the fact an audit reader wants beside the two admin uids.
           */
          const reviewed = result.request || {};
          const logged = await resolveAudit().record({
            section: SECTIONS.ORGANIZER_ECONOMY,
            actionType: decision === 'approve' ? 'withdrawal_approved' : 'withdrawal_rejected',
            title: decision === 'approve'
              ? 'Organizer withdrawal approved'
              : 'Organizer withdrawal rejected',
            payload: {
              organizerUid: reviewed.organizerUid || '',
              requestId,
              ledgerRef: reviewed.reservationKey || null,
              amount: reviewed.amount,
              currency: reviewed.currency || 'coins',
              outcome: reviewed.status || (decision === 'approve' ? 'approved' : 'rejected'),
              reconciled: result.reconciled === true,
              // The reason text is recorded, never the UPI id or anything that reads like a token.
              ...(decision === 'reject' ? { reason: reason.slice(0, 300) } : {})
            },
            performedBy: 'admin',
            performerId: req.user.uid,
            performerEmail: req.user.email || ''
          });

          return res.json({
            success: true,
            code: result.code,
            message: result.message,
            requestId: result.requestId,
            request: result.request,
            reconciled: result.reconciled === true,
            auditRecorded: logged.recorded === true
          });
        }

        const status = result.code === 'NOT_FOUND' ? 404
          : result.code === 'ALREADY_PROCESSED' || result.code === 'NOT_RESERVED' ||
            result.code === 'INSUFFICIENT_BALANCE' ? 409
            : result.code === 'REASON_REQUIRED' || result.code === 'REASON_TOO_LONG' ||
              result.code === 'DECISION_INVALID' || result.code === 'REQUEST_ID_INVALID' ||
              result.code === 'AMOUNT_INVALID' ? 400
              : 500;

        console.error('[AdminOrganizer] Withdrawal', decision, result.code,
          'for', requestId, '|', result.message);
        return res.status(status).json({
          success: false,
          code: result.code,
          message: result.message,
          requestId,
          request: result.request || null
        });
      } catch (error) {
        console.error('[AdminOrganizer] Withdrawal review failed:', error.message);
        return res.status(500).json({ success: false, code: 'REQUEST_FAILED',
          message: 'The withdrawal could not be reviewed. Check the request and try again.',
          retryable: true });
      }
    };
  }

  router.post('/withdrawal/approve', authenticator, reviewRoute('approve'));
  router.post('/withdrawal/reject', authenticator, reviewRoute('reject'));

  /**
   * Run the deadline check now instead of waiting for the schedule.
   *
   * Safe to call twice, from two admins, on the same minute: the sweep only charges through
   * the economy service, whose ledger key is derived from the match, so a repeated pass
   * records a duplicate and moves nothing. It reads its amount from the settings document and
   * takes none from the body, so this is a trigger and not a way to name a number.
   */
  router.post('/penalty-sweep', authenticator, async (req, res) => {
    if (!await requireAdmin(req, res)) return undefined;
    try {
      const result = await resolvePenalties().sweepOnce();
      // A sweep that charged nothing is not an event worth a row; one that moved coins is, and it
      // is recorded once with its counts rather than as one row per charge, because every charge
      // already has its own immutable ledger entry keyed from the match.
      const charged = Number((result.summary || {}).charged || 0);
      if (charged > 0) {
        const logged = await resolveAudit().record({
          section: SECTIONS.ORGANIZER_ECONOMY,
          actionType: 'deadline_penalty_sweep',
          title: 'Organizer deadline penalties charged',
          payload: { ...result.summary, outcome: result.code,
            ledgerRef: 'organizer_ledger:penalty:{tournamentId}:deadline_missed' },
          performedBy: 'admin',
          performerId: req.user.uid,
          performerEmail: req.user.email || ''
        });
        return res.json({ success: true, ...result, auditRecorded: logged.recorded === true });
      }
      return res.json({ success: true, ...result });
    } catch (error) {
      console.error('[AdminOrganizer] Penalty sweep failed:', error.message);
      return res.status(500).json({ success: false, code: 'REQUEST_FAILED',
        message: 'The deadline check could not be completed.', retryable: true });
    }
  });

  /**
   * What a device decision costs the caller in HTTP terms. A request that has left `pending`, and
   * a binding there is nothing to clear, are both conflicts rather than bad input: the admin's
   * screen has to be able to tell "somebody decided this already" from "you sent me nothing".
   */
  const DEVICE_STATUS_BY_CODE = {
    NOT_FOUND: 404,
    ALREADY_PROCESSED: 409,
    NO_BINDING: 409,
    NOT_AN_ORGANIZER: 403,
    ORGANIZER_BANNED: 403,
    ORGANIZER_INACTIVE: 403,
    TRANSIENT_FAILURE: 503
  };

  function answerDevice(res, result, fallback) {
    if (result.code === 'COMPLETE' || result.code === 'REJECTED') {
      return res.json({ success: true, ...result });
    }
    console.error('[AdminOrganizer] Device decision', result.code, '|', result.message);
    return res.status(DEVICE_STATUS_BY_CODE[result.code] || 400).json({
      success: false,
      code: result.code,
      message: result.message || fallback,
      retryable: result.retryable === true,
      ...(result.request ? { request: result.request } : {})
    });
  }

  /**
   * The device-approval queue, with the organizer's name beside each request.
   *
   * Names come from `organizer_users` and are never stored on the request, for the same reason the
   * withdrawal queue does it that way: a rename must not rewrite device history, and a request
   * cannot be pointed at somebody else's account by editing a display name.
   */
  router.get('/devices', authenticator, async (req, res) => {
    if (!await requireAdmin(req, res)) return undefined;
    const status = typeof req.query.status === 'string' ? req.query.status.trim() : '';
    const organizerUid = typeof req.query.organizerUid === 'string' ? req.query.organizerUid.trim() : '';
    const limit = Number(req.query.limit) || 50;

    try {
      const page = await resolveDevices().listRequests({ status, organizerUid, limit });
      const withIdentity = [];
      for (const request of page.requests) {
        let username = '';
        try {
          const account = await db().collection('organizer_users')
            .doc(request.organizerUid).get();
          username = (account.exists && account.data().username) || '';
        } catch (error) {
          // An unreadable display name is not a reason to hide a request from review.
          console.error('[AdminOrganizer] Organizer name read failed:', error.message);
        }
        withIdentity.push({ ...request, username });
      }
      return res.json({ success: true, code: 'COMPLETE', requests: withIdentity,
        count: withIdentity.length });
    } catch (error) {
      console.error('[AdminOrganizer] Device list failed:', error.message);
      return res.status(500).json({ success: false, code: 'REQUEST_FAILED',
        message: 'The device requests could not be read.', retryable: true });
    }
  });

  /** One organizer's approved device, for the details screen and for a reset that needs confirming. */
  router.get('/device/binding', authenticator, async (req, res) => {
    if (!await requireAdmin(req, res)) return undefined;
    const organizerUid = typeof req.query.organizerUid === 'string' ? req.query.organizerUid.trim() : '';
    try {
      const result = await resolveDevices().bindingOf({ organizerUid });
      // `COMPLETE` is a binding, `NO_BINDING` is the absence of one - both are facts about the
      // organizer. Anything else is a fact about the call, and a 200 marked successful would let a
      // screen read "this organizer has no approved device" for a read that never happened, which is
      // exactly how an unnecessary binding reset gets started.
      if (result.code !== 'COMPLETE' && result.code !== 'NO_BINDING') {
        console.error('[AdminOrganizer] Binding read refused:', result.code);
        return res.status(400).json({ success: false, ...result });
      }
      return res.json({ success: true, ...result });
    } catch (error) {
      console.error('[AdminOrganizer] Binding read failed:', error.message);
      return res.status(500).json({ success: false, code: 'REQUEST_FAILED',
        message: 'The approved device could not be read.', retryable: true });
    }
  });

  /**
   * Approve, reject or clear, all through the service that owns the records.
   *
   * The request id in a body is only a selector: it says which row to look at, and the service
   * refuses it unless that row is still `pending`. Nothing here can name a device, an organizer or
   * a reviewer - a body field that could would be a way to approve a phone nobody asked with.
   */
  router.post('/device/approve', authenticator, async (req, res) => {
    if (!await requireAdmin(req, res)) return undefined;
    const body = req.body || {};
    const requestId = typeof body.requestId === 'string' ? body.requestId.trim() : '';
    if (!requestId) {
      return res.status(400).json({ success: false, code: 'REQUEST_ID_REQUIRED',
        message: 'The device request to approve has to be named.' });
    }
    try {
      return answerDevice(res,
        await resolveDevices().approveRequest({
          requestId, adminUid: req.user.uid, adminEmail: req.user.email || ''
        }),
        'The device could not be approved.');
    } catch (error) {
      console.error('[AdminOrganizer] Device approve failed:', error.message);
      return res.status(500).json({ success: false, code: 'REQUEST_FAILED',
        message: 'The device could not be approved.', retryable: true });
    }
  });

  router.post('/device/reject', authenticator, async (req, res) => {
    if (!await requireAdmin(req, res)) return undefined;
    const body = req.body || {};
    const requestId = typeof body.requestId === 'string' ? body.requestId.trim() : '';
    if (!requestId) {
      return res.status(400).json({ success: false, code: 'REQUEST_ID_REQUIRED',
        message: 'The device request to reject has to be named.' });
    }
    try {
      return answerDevice(res,
        await resolveDevices().rejectRequest({
          requestId,
          adminUid: req.user.uid,
          adminEmail: req.user.email || '',
          reason: typeof body.reason === 'string' ? body.reason : ''
        }),
        'The device request could not be rejected.');
    } catch (error) {
      console.error('[AdminOrganizer] Device reject failed:', error.message);
      return res.status(500).json({ success: false, code: 'REQUEST_FAILED',
        message: 'The device request could not be rejected.', retryable: true });
    }
  });

  /**
   * Recover an organizer whose approved device is gone. A reason is mandatory, because this is the
   * one device operation that removes something rather than granting it.
   */
  router.post('/device/reset', authenticator, async (req, res) => {
    if (!await requireAdmin(req, res)) return undefined;
    const body = req.body || {};
    try {
      return answerDevice(res,
        await resolveDevices().resetBinding({
          organizerUid: typeof body.organizerUid === 'string' ? body.organizerUid : '',
          adminUid: req.user.uid,
          adminEmail: req.user.email || '',
          reason: typeof body.reason === 'string' ? body.reason : ''
        }),
        'The device binding could not be cleared.');
    } catch (error) {
      console.error('[AdminOrganizer] Device reset failed:', error.message);
      return res.status(500).json({ success: false, code: 'REQUEST_FAILED',
        message: 'The device binding could not be cleared.', retryable: true });
    }
  });

  /**
   * The activity history the dashboard shows a page of.
   *
   * This reads the transcript sections that already exist; it does not add a query that could be
   * pointed at a collection the audit trail does not use, so `section` has to be one this project
   * already writes and a page is capped by the service.
   */
  router.get('/audit', authenticator, async (req, res) => {
    if (!await requireAdmin(req, res)) return undefined;
    const section = typeof req.query.section === 'string' ? req.query.section.trim() : '';
    const organizerUid = typeof req.query.organizerUid === 'string' ? req.query.organizerUid.trim() : '';
    const limit = Number(req.query.limit) || 50;

    const allowed = Object.values(SECTIONS);
    if (section && !allowed.includes(section)) {
      return res.status(400).json({ success: false, code: 'SECTION_UNKNOWN',
        message: 'That activity section is not one this project records.',
        sections: allowed });
    }

    try {
      const audit = resolveAudit();

      /*
       * One organizer's history is one page.
       *
       * The three sections this phase writes are three halves of the same story - who the account
       * is, which phone was approved, which coins moved - so asking for an organizer without naming
       * a section reads all three and merges them, newest first. Three separate screen requests
       * would have shown three pages from three different moments and left the admin to interleave
       * them; the read stays bounded because each section is capped and the merge is cut to the same
       * page size.
       */
      if (!section && organizerUid) {
        const perSection = Math.min(Math.max(limit, 1), ORGANIZER_PAGE_SIZE);
        const merged = [];
        let scanned = 0;
        let truncated = false;

        for (const name of ORGANIZER_SECTIONS) {
          const page = await audit.list({
            section: name, limit: perSection, filterOrganizerUid: organizerUid
          });
          merged.push(...page.entries);
          scanned += page.scanned || 0;
          truncated = truncated || page.truncated === true;
        }

        // Newest first across the three. A row whose write has not resolved has no time yet, so it
        // sorts last rather than pretending to be the most recent thing that happened.
        merged.sort((left, right) => (right.createdAt || 0) - (left.createdAt || 0));
        const entries = merged.slice(0, perSection);

        return res.json({
          success: true,
          code: 'COMPLETE',
          sections: ORGANIZER_SECTIONS,
          entries,
          total: entries.length,
          scanned,
          truncated
        });
      }

      const page = await audit.list({
        section: section || SECTIONS.ORGANIZERS, organizerUid: '', limit,
        ...(organizerUid ? { filterOrganizerUid: organizerUid } : {})
      });
      return res.json({ success: true, ...page });
    } catch (error) {
      console.error('[AdminOrganizer] Audit read failed:', error.message);
      return res.status(500).json({ success: false, code: 'REQUEST_FAILED',
        message: 'The activity history could not be read.', retryable: true });
    }
  });

  /**
   * One organizer's complete coin history, a page at a time.
   *
   * This is the read half of `organizer_ledger`, the same collection the organizer's own wallet
   * screen reads through `GET /api/organizer/wallet/ledger`. The audit trail above answers "who did
   * what, and did it work"; this answers "which coins moved, from what balance to what balance". An
   * admin looking at an organizer needs both, and lifetime totals are not a substitute for either -
   * a total cannot show a penalty that was only half covered or a withdrawal that is still held.
   *
   * `organizerUid` is a required selector, not an authorization: the route is behind `requireAdmin`,
   * and the service treats the uid as a filter over rows it may read. There is no "all organizers"
   * shape here, because a page of mixed ledgers is unreadable and the dashboard always has an
   * organizer open when it asks.
   *
   * Paging is a stable `(createdAt, document id)` cursor handed back as `nextCursor`, so a long
   * history is walked without repeating or skipping entries and `hasMore` says plainly whether the
   * page shown is the whole story. A missing index is `503 INDEX_NOT_READY` rather than an empty
   * page, because "no transactions" and "not built yet" are not the same answer.
   */
  router.get('/ledger', authenticator, async (req, res) => {
    if (!await requireAdmin(req, res)) return undefined;
    const query = req.query || {};
    const organizerUid = typeof query.organizerUid === 'string' ? query.organizerUid.trim() : '';
    if (!organizerUid) {
      return res.status(400).json({ success: false, code: 'ORGANIZER_UID_REQUIRED',
        message: 'Choose an organizer to read the transaction history of.' });
    }

    try {
      const result = await resolveLedger().listEntries({
        organizerUid,
        limit: query.limit,
        cursor: typeof query.cursor === 'string' ? query.cursor : '',
        type: typeof query.type === 'string' ? query.type : '',
        status: typeof query.status === 'string' ? query.status : '',
        fromMillis: query.from === undefined ? null : Number(query.from),
        toMillis: query.to === undefined ? null : Number(query.to)
      });

      if (result.code !== 'COMPLETE') {
        const status = result.code === 'INDEX_NOT_READY' ? 503 : 400;
        return res.status(status).json({
          success: false, code: result.code, message: result.message,
          retryable: result.retryable === true
        });
      }

      return res.json({
        success: true,
        code: result.code,
        organizerUid: result.organizerUid,
        entries: result.entries,
        count: result.count,
        hasMore: result.hasMore,
        nextCursor: result.nextCursor,
        pageSize: result.pageSize,
        filters: result.filters
      });
    } catch (error) {
      console.error('[AdminOrganizer] Ledger read failed:', error.message);
      return res.status(500).json({ success: false, code: 'REQUEST_FAILED',
        message: 'The transaction history could not be read.', retryable: true });
    }
  });

  /**
   * Hand a match to an organizer, or take it back.
   *
   * The daily allowance is what this route is for. An assignment is what makes a match count, so an
   * admin handing out a fifth match to an organizer whose limit is four has to be told, not
   * permitted silently - and when an admin genuinely needs to (an emergency cover for a sick
   * organizer, for instance) the override is an explicit field on the request and a line in the
   * audit trail, not a limit that quietly stops applying.
   *
   * `organizerUid: ''` clears the assignment. Clearing is never limited: taking work off somebody
   * whose day is full is the recovery path, and it cannot place anything over a limit.
   */
  router.post('/tournament/assign', authenticator, async (req, res) => {
    if (!await requireAdmin(req, res)) return undefined;
    const body = req.body || {};

    try {
      const result = await resolveAssignments().assign({
        tournamentId: body.tournamentId,
        organizerUid: typeof body.organizerUid === 'string' ? body.organizerUid : '',
        adminUid: req.user.uid,
        adminEmail: req.user.email || '',
        override: body.override === true,
        reason: typeof body.reason === 'string' ? body.reason : ''
      });

      if (result.code === 'COMPLETE') {
        return res.json({
          success: true,
          code: result.code,
          applied: result.applied === true,
          unchanged: result.unchanged === true,
          tournamentId: result.tournamentId,
          organizerUid: result.organizerUid,
          previousAssignee: result.previousAssignee || null,
          overridden: result.overridden === true,
          limit: result.limit || null,
          auditRecorded: result.auditRecorded === true
        });
      }

      const status = result.code === 'DAILY_LIMIT_REACHED' ? 429
        : result.code === 'TOURNAMENT_NOT_FOUND' ? 404
          : result.code === 'TRANSIENT_FAILURE' ? 503 : 400;
      return res.status(status).json({
        success: false,
        code: result.code,
        message: result.message,
        limit: result.limit || null,
        overrideAvailable: result.overrideAvailable === true,
        retryable: result.retryable === true
      });
    } catch (error) {
      console.error('[AdminOrganizer] Assignment failed:', error.message);
      return res.status(500).json({ success: false, code: 'REQUEST_FAILED',
        message: 'The organizer could not be assigned.', retryable: true });
    }
  });

  return router;
}

module.exports = createAdminOrganizerRouter();
module.exports.createAdminOrganizerRouter = createAdminOrganizerRouter;
