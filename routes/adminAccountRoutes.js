/**
 * Admin account routes (mounted at /api/admin/account).
 *
 *   POST /delete        { uid, username }    – fully remove one player account
 *   POST /update-phone  { uid, phoneNumber } – move an account to a new phone number
 *
 * Authorization is two-factor on the server side: a valid Firebase ID token from
 * `verifyAuth`, plus that uid existing in `admin_users` (the same source the
 * Firestore rules use for isAdmin()). The target uid in the body is only a
 * selector; it never carries authority, which is why this cannot be driven by a
 * non-admin client even if the request is forged.
 */

const express = require('express');
const admin = require('firebase-admin');
const { verifyAuth } = require('../middleware/auth');
const { createUsernameRegistry } = require('../services/usernameRegistry');
const { createAccountDeletionService } = require('../services/accountDeletion');
const { createAdminPhoneUpdateService } = require('../services/adminPhoneUpdate');

/** Same admin source of truth the other admin routes already use. */
async function defaultIsAdminUid(uid) {
  if (!uid) return false;
  try {
    const doc = await admin.firestore().collection('admin_users').doc(uid).get();
    return doc.exists;
  } catch (error) {
    console.error('[AdminAccount] Admin check failed:', error.message);
    return false;
  }
}

function createAdminAccountRouter({
  authenticator = verifyAuth,
  isAdminUid = defaultIsAdminUid,
  deletion,
  phoneUpdate
} = {}) {
  const router = express.Router();

  // Built on first use so requiring this module never needs live Firebase
  // credentials; tests inject their own `deletion` service.
  let service = deletion || null;
  let phoneService = phoneUpdate || null;

  function resolveService() {
    if (!service) {
      service = createAccountDeletionService({
        db: admin.firestore(),
        auth: admin.auth(),
        rtdb: admin.database(),
        registry: createUsernameRegistry({
          db: { collection: name => admin.firestore().collection(name) },
          serverTimestamp: () => admin.firestore.FieldValue.serverTimestamp()
        }),
        isAdminUid
      });
    }
    return service;
  }

  function resolvePhoneService() {
    if (!phoneService) {
      phoneService = createAdminPhoneUpdateService({
        db: admin.firestore(),
        auth: admin.auth(),
        isAdminUid,
        serverTimestamp: () => admin.firestore.FieldValue.serverTimestamp()
      });
    }
    return phoneService;
  }

  // ==========================================================================
  // POST /delete
  // ==========================================================================
  router.post('/delete', authenticator, async (req, res) => {
    const body = req.body || {};
    const uid = typeof body.uid === 'string' ? body.uid.trim() : '';
    const username = typeof body.username === 'string' ? body.username.trim() : '';

    if (!uid) {
      return res.status(400).json({ success: false, code: 'INVALID_UID', message: 'Account identifier is required.' });
    }

    try {
      const result = await resolveService().deleteAccount({
        uid,
        // The actor is the authenticated caller, never a value from the body.
        actorUid: req.user.uid,
        usernameHint: username
      });

      const report = result.report || { removed: [], alreadyGone: [], skipped: [], failed: [] };

      if (result.code === 'COMPLETE') {
        return res.json({
          success: true,
          code: 'COMPLETE',
          message: result.message,
          uid,
          removed: report.removed,
          alreadyGone: report.alreadyGone,
          skipped: report.skipped
        });
      }

      if (result.code === 'NOT_FOUND') {
        return res.status(404).json({
          success: false, code: 'NOT_FOUND', message: result.message, uid
        });
      }

      const status = result.code === 'FORBIDDEN' ? 403
        : result.code === 'INVALID_UID' ? 400
          : 500;
      console.error('[AdminAccount] Deletion incomplete for', uid,
        '| failed steps:', report.failed.map(entry => `${entry.step}:${entry.detail}`).join(', '));
      return res.status(status).json({
        success: false,
        code: result.code,
        message: result.message,
        uid,
        halted: result.halted === true,
        retryable: result.retryable === true,
        removed: report.removed,
        alreadyGone: report.alreadyGone,
        skipped: report.skipped,
        failed: report.failed
      });
    } catch (error) {
      console.error('[AdminAccount] Deletion request failed:', error.message);
      return res.status(500).json({
        success: false,
        code: 'PARTIAL',
        message: 'Deletion could not be completed. Retry once the connection to Firebase is healthy.',
        uid,
        retryable: true
      });
    }
  });

  // ==========================================================================
  // POST /update-phone
  //
  // The only supported way to move a Firebase Authentication phone number. The
  // Admin app never writes `phoneNumber` itself - it cannot - so this endpoint is
  // the authoritative half of the operation and the client-side collision check
  // is advisory only.
  // ==========================================================================
  router.post('/update-phone', authenticator, async (req, res) => {
    const body = req.body || {};
    const uid = typeof body.uid === 'string' ? body.uid.trim() : '';
    const phoneNumber = typeof body.phoneNumber === 'string' ? body.phoneNumber.trim() : '';

    if (!uid) {
      return res.status(400).json({ success: false, code: 'INVALID_UID', message: 'Account identifier is required.' });
    }
    if (!phoneNumber) {
      return res.status(400).json({ success: false, code: 'INVALID_PHONE', message: 'A phone number is required.' });
    }

    try {
      const result = await resolvePhoneService().updatePhoneNumber({
        uid,
        phoneNumber,
        // The actor is the authenticated caller, never a value from the body.
        actorUid: req.user.uid
      });

      // Step details stay in the server log; the client only ever gets step names,
      // so an internal error string can never reach the Admin UI.
      const steps = (result.steps || []).map(entry => entry.step);

      if (result.code === 'COMPLETE' || result.code === 'RECONCILED') {
        return res.json({
          success: true,
          code: result.code,
          message: result.message,
          uid,
          phone: result.phone,
          region: result.region,
          // Truthful: an administrative change is not an SMS verification.
          phoneVerified: false,
          steps
        });
      }

      const status = result.code === 'PHONE_ALREADY_ASSIGNED' ? 409
        : result.code === 'FORBIDDEN' ? 403
          : result.code === 'NOT_FOUND' ? 404
            : result.code === 'PARTIAL' ? 500
              : 400;

      console.error('[AdminAccount] Phone update', result.code, 'for', uid,
        '| steps:', (result.steps || [])
          .map(entry => `${entry.step}:${entry.detail}`).join(', '));

      return res.status(status).json({
        success: false,
        code: result.code,
        message: result.message,
        uid,
        steps,
        authUpdated: result.authUpdated === true,
        retryable: result.retryable === true
      });
    } catch (error) {
      console.error('[AdminAccount] Phone update request failed:', error.message);
      return res.status(500).json({
        success: false,
        code: 'PARTIAL',
        message: 'The phone number could not be updated. Retry once the connection to Firebase is healthy.',
        uid,
        retryable: true
      });
    }
  });

  return router;
}

module.exports = createAdminAccountRouter();
module.exports.createAdminAccountRouter = createAdminAccountRouter;
