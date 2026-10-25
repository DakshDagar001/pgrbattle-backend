/**
 * Organizer-facing device routes (mounted at /api/organizer/devices).
 *
 *   GET  /status    – where this device stands, and what the organizer can do about it
 *   POST /enroll    – the first device for an account that has never had one
 *   POST /request   – a device asking to replace the approved one (never approves itself)
 *   GET  /history   – this organizer's own device requests and decisions, bounded
 *
 * The organizer is always `req.user.uid`, from a verified ID token. The device is read from the
 * `X-Device-Id` header and taken from nowhere else: an identifier that arrived inside a JSON body
 * would be one more field a modified client can choose, and the whole point of the header is that
 * the app sets it from `Settings.Secure.ANDROID_ID` and the service decides what it means.
 *
 * Nothing here hands out another organizer's data, and nothing here describes the approved device
 * to a caller that is not standing on it - `service.status()` is written to return that answer
 * safely, and this router does not widen it.
 */

const express = require('express');
const admin = require('firebase-admin');
const { verifyAuth } = require('../middleware/auth');
const { createOrganizerDeviceService } = require('../services/organizerDevices');
const { createAuditTrail } = require('../services/auditTrail');

/** A device identifier is validated by the service; this only bounds what a header can carry. */
const MAX_HEADER_LENGTH = 128;

/** What each refusal costs the caller, in HTTP terms, and why. */
const STATUS_BY_CODE = {
  NOT_AN_ORGANIZER: 403,
  ORGANIZER_BANNED: 403,
  ORGANIZER_INACTIVE: 403,
  DEVICE_NOT_APPROVED: 403,
  ENROLLMENT_REQUIRED: 409,
  ENROLLMENT_AVAILABLE: 409,
  REPLACEMENT_REQUIRES_APPROVAL: 409,
  DEVICE_ID_INVALID: 400,
  ORGANIZER_UID_INVALID: 400,
  TRANSIENT_FAILURE: 503
};

function answer(res, result, fallbackMessage) {
  if (result.code === 'COMPLETE' || result.code === 'REJECTED') {
    return res.json({ success: true, ...result });
  }
  const status = STATUS_BY_CODE[result.code] || 400;
  return res.status(status).json({
    success: false,
    code: result.code,
    message: result.message || fallbackMessage,
    retryable: result.retryable === true,
    ...('enrollmentAvailable' in result ? { enrollmentAvailable: result.enrollmentAvailable } : {}),
    ...('approvalRequired' in result ? { approvalRequired: result.approvalRequired } : {}),
    ...('pendingRequestId' in result ? { pendingRequestId: result.pendingRequestId } : {}),
    ...('requestStatus' in result ? { requestStatus: result.requestStatus } : {})
  });
}

function createOrganizerDeviceRouter({
  authenticator = verifyAuth,
  devices,
  audit
} = {}) {
  const router = express.Router();

  // Built on first use, so requiring this module never needs live Firebase credentials and a test
  // can hand the router its own service over its own database double.
  let deviceService = devices || null;
  let auditTrail = audit || null;

  function resolveAudit() {
    if (!auditTrail) {
      auditTrail = createAuditTrail({
        db: admin.firestore(),
        serverTimestamp: () => admin.firestore.FieldValue.serverTimestamp()
      });
    }
    return auditTrail;
  }

  function resolveDevices() {
    if (!deviceService) {
      deviceService = createOrganizerDeviceService({
        db: admin.firestore(),
        serverTimestamp: () => admin.firestore.FieldValue.serverTimestamp(),
        audit: resolveAudit()
      });
    }
    return deviceService;
  }

  /** The caller's device as they declare it - validated, never trusted, and never a body field. */
  function declaredDevice(req) {
    const raw = req.headers['x-device-id'];
    if (typeof raw !== 'string') return '';
    return raw.trim().slice(0, MAX_HEADER_LENGTH);
  }

  router.get('/status', authenticator, async (req, res) => {
    try {
      const result = await resolveDevices().status({
        organizerUid: req.user.uid,
        deviceId: declaredDevice(req)
      });
      return answer(res, result, 'The device status could not be read.');
    } catch (error) {
      console.error('[OrganizerDevices] Route status failed:', error.message);
      return res.status(500).json({ success: false, code: 'REQUEST_FAILED',
        message: 'The device status could not be read.', retryable: true });
    }
  });

  router.post('/enroll', authenticator, async (req, res) => {
    try {
      const body = req.body || {};
      const result = await resolveDevices().enrollFirstDevice({
        organizerUid: req.user.uid,
        deviceId: declaredDevice(req),
        deviceLabel: typeof body.deviceLabel === 'string' ? body.deviceLabel : ''
      });
      return answer(res, result, 'This device could not be enrolled.');
    } catch (error) {
      console.error('[OrganizerDevices] Route enroll failed:', error.message);
      return res.status(500).json({ success: false, code: 'REQUEST_FAILED',
        message: 'This device could not be enrolled.', retryable: true });
    }
  });

  router.post('/request', authenticator, async (req, res) => {
    try {
      const body = req.body || {};
      const result = await resolveDevices().requestReplacement({
        organizerUid: req.user.uid,
        deviceId: declaredDevice(req),
        deviceLabel: typeof body.deviceLabel === 'string' ? body.deviceLabel : ''
      });
      return answer(res, result, 'The device request could not be submitted.');
    } catch (error) {
      console.error('[OrganizerDevices] Route request failed:', error.message);
      return res.status(500).json({ success: false, code: 'REQUEST_FAILED',
        message: 'The device request could not be submitted.', retryable: true });
    }
  });

  /**
   * The caller's own device history, and nothing else.
   *
   * `organizerUid` is applied by the service as a server-side filter rather than accepted from the
   * query string, so a history page cannot be pointed at somebody else's phone, and an organizer's
   * older requests still appear even when the whole collection has moved on past them.
   *
   * Each row is then narrowed to what the asking device is allowed to know. `requestView` carries
   * `approvedDeviceAtRequest` - the identifier of the device that was approved when the request was
   * made - which an admin deciding a month-old request genuinely needs, and which a phone that is
   * not the approved one must not be handed: this route exists precisely so that an unapproved
   * device can see where it stands, and the promise in the header of this file is that it never sees
   * the approved identifier itself.
   */
  router.get('/history', authenticator, async (req, res) => {
    try {
      const uid = req.user.uid;
      const page = await resolveDevices().listRequests({
        status: 'all',
        organizerUid: uid,
        limit: Math.min(Number(req.query.limit) || 20, 50)
      });
      const mine = (page.requests || [])
        .filter(request => request.organizerUid === uid)
        .map(({ approvedDeviceAtRequest, ...safe }) => safe);
      return res.json({ success: true, code: 'COMPLETE', requests: mine, count: mine.length });
    } catch (error) {
      console.error('[OrganizerDevices] Route history failed:', error.message);
      return res.status(500).json({ success: false, code: 'REQUEST_FAILED',
        message: 'The device history could not be read.', retryable: true });
    }
  });

  return router;
}

module.exports = createOrganizerDeviceRouter();
module.exports.createOrganizerDeviceRouter = createOrganizerDeviceRouter;
