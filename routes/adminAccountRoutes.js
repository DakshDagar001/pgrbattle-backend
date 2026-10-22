/**
 * Admin account routes (mounted at /api/admin/account).
 *
 *   POST /delete  { uid, username }  – fully remove one player account
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
  deletion
} = {}) {
  const router = express.Router();

  // Built on first use so requiring this module never needs live Firebase
  // credentials; tests inject their own `deletion` service.
  let service = deletion || null;

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

  return router;
}

module.exports = createAdminAccountRouter();
module.exports.createAdminAccountRouter = createAdminAccountRouter;
