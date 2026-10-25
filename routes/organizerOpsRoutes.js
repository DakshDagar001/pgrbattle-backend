/**
 * Organizer operation permits (mounted at /api/organizer/ops).
 *
 *   POST /authorize  { scope, tournamentId }  – may this phone perform this operation, now?
 *
 * The answer is a permit document `firestore.rules` requires before it accepts the write the
 * operation consists of; see `services/organizerOperationPermits.js` for why the decision is a
 * permit rather than a route that performs the work, and which scopes exist.
 *
 * Two things about this route are load-bearing:
 *
 *   - The organizer is `req.user.uid`. No body field names an account, so a caller cannot ask for
 *     somebody else's permission and cannot present one.
 *   - The device gate runs before anything is written. It is the same gate the withdrawal and
 *     tournament-create routes run, so "an approved phone" means one thing across every protected
 *     operation. A refusal happens before a permit exists, which is a complete no-op.
 *
 * A permit is not a session and not a login: it is a two-minute statement about one operation on
 * one match, re-derived from the organizer account and the match document every time it is asked
 * for. Losing one costs a retry, not a session.
 */

const express = require('express');
const admin = require('firebase-admin');
const { verifyAuth } = require('../middleware/auth');
const { createOrganizerOperationPermits, SCOPES } = require('../services/organizerOperationPermits');
const { createOrganizerDeviceService } = require('../services/organizerDevices');
const { createOrganizerDeviceGate } = require('../services/organizerDeviceGate');

/** How each refusal reads over HTTP. */
function statusFor(code) {
  switch (code) {
    case 'NOT_AN_ORGANIZER':
    case 'ORGANIZER_BANNED':
    case 'ORGANIZER_INACTIVE':
    case 'FORBIDDEN_PERMISSION':
    case 'ORGANIZER_SERVER_FORBIDDEN':
    case 'ORGANIZER_MODE_FORBIDDEN':
    case 'TOURNAMENT_NOT_YOURS':
      return 403;
    case 'TOURNAMENT_NOT_FOUND':
      return 404;
    case 'TRANSIENT_FAILURE':
      return 503;
    default:
      return 400;
  }
}

function createOrganizerOpsRouter({
  authenticator = verifyAuth,
  permits,
  devices,
  // Injectable so a test never needs live Firebase credentials.
  database,
  serverTimestamp = () => admin.firestore.FieldValue.serverTimestamp()
} = {}) {
  const router = express.Router();

  const db = () => (database ? database() : admin.firestore());

  let permitService = permits || null;
  let deviceService = devices || null;

  function resolvePermits() {
    if (!permitService) {
      permitService = createOrganizerOperationPermits({ db: db(), serverTimestamp });
    }
    return permitService;
  }

  function resolveDevices() {
    if (!deviceService) {
      deviceService = createOrganizerDeviceService({ db: db(), serverTimestamp });
    }
    return deviceService;
  }

  // The identical gate the withdrawal and create routes use: one definition, so no protected
  // operation is guarded by a subtly different rule than its neighbour.
  const gate = createOrganizerDeviceGate({
    devices: {
      requireApprovedDevice: args => resolveDevices().requireApprovedDevice(args),
      bindingOf: args => resolveDevices().bindingOf(args)
    }
  });

  router.post('/authorize', authenticator, async (req, res) => {
    const body = req.body || {};

    try {
      // Before a permit exists: an organizer on an unapproved phone must not be able to obtain
      // one, because the permit is the only thing the rules will accept.
      const blocked = await gate.check(req);
      if (blocked) {
        console.error('[OrganizerOps] Authorize blocked by device gate', blocked.code,
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

      const result = await resolvePermits().authorize({
        // The organizer is whoever signed in, never whoever the body claims.
        organizerUid: req.user.uid,
        scope: body.scope,
        tournamentId: body.tournamentId
      });

      if (result.code === 'COMPLETE') {
        return res.json({ success: true, code: 'COMPLETE', permit: result.permit });
      }

      const status = statusFor(result.code);
      if (status >= 500) {
        console.error('[OrganizerOps] Authorize', result.code, 'for', req.user.uid, '|',
          result.message);
      }
      return res.status(status).json({
        success: false,
        code: result.code,
        message: result.message,
        permission: result.permission || null,
        scopes: result.scopes || null,
        retryable: result.retryable === true
      });
    } catch (error) {
      console.error('[OrganizerOps] Authorize failed:', error.message);
      return res.status(500).json({
        success: false,
        code: 'REQUEST_FAILED',
        message: 'The operation could not be authorized. Try again.',
        retryable: true
      });
    }
  });

  return router;
}

module.exports = createOrganizerOpsRouter();
module.exports.createOrganizerOpsRouter = createOrganizerOpsRouter;
module.exports.statusFor = statusFor;
module.exports.SCOPES = SCOPES;
