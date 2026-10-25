/**
 * Trusted organizer tournament routes (mounted at /api/organizer/tournaments).
 *
 *   POST /  { requestId, modeId, name, dateTime, ... }  – create a match
 *
 * This is the one write an organizer can no longer make straight to Firestore, because two of the
 * rules that apply to it cannot be expressed in security rules: the day's allowance has to be
 * counted and compared atomically, and the phone has to be the approved one. Everything the route
 * decides is derived from the verified token and the stored mode record; the body carries the
 * match's own content and nothing about who owns it or where it lives.
 *
 * The response is structured rather than a sentence: a refusal names a machine-readable code, and
 * a daily-limit refusal carries the day, the effective limit, what is used and what is left, so the
 * Organizer app can say exactly why instead of showing a generic failure.
 */

const express = require('express');
const admin = require('firebase-admin');
const { verifyAuth } = require('../middleware/auth');
const { createOrganizerEconomyService } = require('../services/organizerEconomy');
const { createOrganizerTournamentIntakeService } = require('../services/organizerTournamentIntake');
const { createOrganizerDeviceService } = require('../services/organizerDevices');
const { createOrganizerDeviceGate } = require('../services/organizerDeviceGate');
const { createAuditTrail } = require('../services/auditTrail');

/** How each refusal reads over HTTP. */
function statusFor(code) {
  switch (code) {
    case 'NOT_AN_ORGANIZER':
    case 'ORGANIZER_BANNED':
    case 'ORGANIZER_INACTIVE':
    case 'FORBIDDEN_PERMISSION':
    case 'ORGANIZER_SERVER_FORBIDDEN':
    case 'ORGANIZER_MODE_FORBIDDEN':
      return 403;
    case 'DAILY_LIMIT_REACHED':
      // The request is valid and would succeed tomorrow; it is a conflict with a limit, not a
      // malformed request.
      return 429;
    case 'REQUEST_ID_TAKEN':
      return 409;
    case 'TRANSIENT_FAILURE':
      return 503;
    default:
      return 400;
  }
}

function createOrganizerTournamentRouter({
  authenticator = verifyAuth,
  intake,
  economy,
  devices,
  audit,
  // Injectable so a test never needs live Firebase credentials.
  database,
  serverTimestamp = () => admin.firestore.FieldValue.serverTimestamp(),
  dailyLimitOffsetMinutes = process.env.ORGANIZER_DAILY_LIMIT_UTC_OFFSET
} = {}) {
  const router = express.Router();

  const db = () => (database ? database() : admin.firestore());

  let intakeService = intake || null;
  let economyService = economy || null;
  let deviceService = devices || null;
  let auditTrail = audit || null;

  function resolveEconomy() {
    if (!economyService) {
      economyService = createOrganizerEconomyService({ db: db(), serverTimestamp });
    }
    return economyService;
  }

  function resolveDevices() {
    if (!deviceService) {
      deviceService = createOrganizerDeviceService({ db: db(), serverTimestamp });
    }
    return deviceService;
  }

  function resolveAudit() {
    if (!auditTrail) auditTrail = createAuditTrail({ db: db(), serverTimestamp });
    return auditTrail;
  }

  function resolveIntake() {
    if (!intakeService) {
      intakeService = createOrganizerTournamentIntakeService({
        db: db(),
        economy: resolveEconomy(),
        audit: resolveAudit(),
        serverTimestamp,
        // The same day boundary the allowance report uses, so the number an organizer is shown
        // and the number that is enforced cannot differ.
        offsetMinutes: dailyLimitOffsetMinutes
      });
    }
    return intakeService;
  }

  // The identical gate the withdrawal route uses: one definition, so one protected operation
  // cannot be guarded differently from its neighbour.
  const gate = createOrganizerDeviceGate({
    devices: {
      requireApprovedDevice: args => resolveDevices().requireApprovedDevice(args),
      bindingOf: args => resolveDevices().bindingOf(args)
    }
  });

  // ==========================================================================
  // POST /
  // ==========================================================================
  router.post('/', authenticator, async (req, res) => {
    const body = req.body || {};

    try {
      // Before anything is counted or written: an organizer on an unapproved device must not be
      // able to consume a place in the day's allowance.
      const blocked = await gate.check(req);
      if (blocked) {
        console.error('[OrganizerTournament] Create blocked by device gate', blocked.code,
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

      const result = await resolveIntake().createTournament({
        // The organizer is always the verified caller, never a body field.
        organizerUid: req.user.uid,
        requestId: body.requestId,
        input: body,
        actorEmail: req.user.email || ''
      });

      if (result.code === 'COMPLETE') {
        return res.status(result.duplicate ? 200 : 201).json({
          success: true,
          code: result.code,
          message: result.message || 'Tournament created.',
          duplicate: result.duplicate === true,
          tournamentId: result.tournamentId,
          tournament: result.tournament,
          limit: result.limit,
          auditRecorded: result.auditRecorded === true
        });
      }

      const status = statusFor(result.code);
      if (status >= 500) {
        console.error('[OrganizerTournament] Create', result.code, 'for', req.user.uid,
          '|', result.message);
      }

      return res.status(status).json({
        success: false,
        code: result.code,
        message: result.message,
        field: result.field || null,
        limit: result.limit || null,
        retryable: result.retryable === true
      });
    } catch (error) {
      console.error('[OrganizerTournament] Create failed:', error.message);
      return res.status(500).json({
        success: false,
        code: 'REQUEST_FAILED',
        message: 'The tournament could not be created. Try again.',
        retryable: true
      });
    }
  });

  return router;
}

module.exports = createOrganizerTournamentRouter();
module.exports.createOrganizerTournamentRouter = createOrganizerTournamentRouter;
module.exports.statusFor = statusFor;
