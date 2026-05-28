/**
 * Deposit Routes
 *
 * Express Router for the deposit / payment flow:
 *   POST   /create              – create a new deposit request
 *   POST   /submit-utr          – submit Transaction ID and start verification
 *   GET    /status/:requestId   – check deposit status
 *   POST   /cancel/:requestId   – cancel a deposit
 *   POST   /admin/override/:requestId – admin force-approve
 *   GET    /admin/active-jobs   – list active verification jobs
 */

const express = require('express');
const admin = require('firebase-admin');
const { verifyAuth } = require('../middleware/auth');
const {
  startVerification,
  cancelVerification,
  getActiveJobs,
  creditWallet
} = require('../services/depositVerifier');

const router = express.Router();

// ── Helpers ────────────────────────────────────────────────────────────────────

function rtdb() {
  return admin.database();
}

function firestore() {
  return admin.firestore();
}

/**
 * Check whether a user is an admin by looking up the admin_users collection.
 */
async function isAdmin(uid) {
  try {
    const doc = await firestore().collection('admin_users').doc(uid).get();
    return doc.exists;
  } catch (e) {
    console.error('[Deposit] Admin check failed:', e.message);
    return false;
  }
}

/**
 * Read a config value from RTDB appConfig/{key}, with an optional default.
 */
async function getAppConfig(key, defaultValue) {
  try {
    const snap = await rtdb().ref(`appConfig/${key}`).once('value');
    const val = snap.val();
    return val !== null && val !== undefined ? val : defaultValue;
  } catch (e) {
    console.error(`[Deposit] Failed to read appConfig/${key}:`, e.message);
    return defaultValue;
  }
}

// ── POST /create ───────────────────────────────────────────────────────────────

router.post('/create', verifyAuth, async (req, res) => {
  try {
    const { userId, amount, username, email } = req.body;

    // Validate userId matches authenticated user
    if (!userId || userId !== req.user.uid) {
      return res.status(403).json({
        success: false,
        error: 'User ID does not match authenticated user'
      });
    }

    // Validate amount
    if (amount === undefined || amount === null || typeof amount !== 'number' || isNaN(amount)) {
      return res.status(400).json({
        success: false,
        error: 'Amount must be a valid number'
      });
    }

    // Read min/max from config
    const minDeposit = await getAppConfig('minDeposit', 10);
    const maxDeposit = await getAppConfig('maxDeposit', 10000);

    if (amount < minDeposit || amount > maxDeposit) {
      return res.status(400).json({
        success: false,
        error: `Amount must be between ₹${minDeposit} and ₹${maxDeposit}`
      });
    }

    // Generate request ID: PGR + 12 alphanumeric characters
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let randomPart = '';
    for (let i = 0; i < 12; i++) {
      randomPart += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    const requestId = `PGR${randomPart}`;

    const now = Date.now();

    const depositRecord = {
      requestId,
      userId,
      username: username || '',
      email: email || '',
      amount,
      utr: null,
      status: 'PENDING',
      depositType: 'automatic',
      createdAt: now,
      utrSubmittedAt: null,
      verifiedAt: null,
      verificationSource: null,
      verificationLogs: [],
      failureReason: null,
      processedBy: 'backend-auto'
    };

    // Write to user-scoped deposits
    await rtdb().ref(`wallets/${userId}/deposits/${requestId}`).set(depositRecord);

    // Write to global depositOrders
    await rtdb().ref(`depositOrders/${requestId}`).set(depositRecord);

    console.log(`[Deposit] Created ${requestId} for user ${userId}, ₹${amount}`);

    // Read admin UPI ID
    const adminUpiId = await getAppConfig('adminUpiId', null);

    return res.json({
      success: true,
      requestId,
      adminUpiId,
      amount
    });

  } catch (err) {
    console.error('[Deposit] Create error:', err);
    return res.status(500).json({
      success: false,
      error: 'Failed to create deposit request'
    });
  }
});

// ── POST /submit-utr ──────────────────────────────────────────────────────────

router.post('/submit-utr', verifyAuth, async (req, res) => {
  try {
    const { requestId, utr, userId } = req.body;

    // Validate input
    if (!requestId || !utr || !userId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: requestId, utr (Transaction ID), userId'
      });
    }

    // Validate userId matches authenticated user
    if (userId !== req.user.uid) {
      return res.status(403).json({
        success: false,
        error: 'User ID does not match authenticated user'
      });
    }

    // Validate UTR format: alphanumeric, 8-30 characters
    const utrTrimmed = utr.trim();
    if (!/^[A-Za-z0-9]{8,30}$/.test(utrTrimmed)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid Transaction ID format. Must be 8-30 alphanumeric characters.'
      });
    }

    // Fetch deposit record
    const depositSnap = await rtdb().ref(`depositOrders/${requestId}`).once('value');
    const deposit = depositSnap.val();

    if (!deposit) {
      return res.status(404).json({
        success: false,
        error: 'Deposit request not found'
      });
    }

    if (deposit.status !== 'PENDING') {
      return res.status(400).json({
        success: false,
        error: `Cannot submit Transaction ID – deposit status is ${deposit.status}`
      });
    }

    if (deposit.userId !== req.user.uid) {
      return res.status(403).json({
        success: false,
        error: 'You do not own this deposit request'
      });
    }

    // Check for duplicate UTR among SUCCESS deposits
    const allOrdersSnap = await rtdb()
      .ref('depositOrders')
      .orderByChild('utr')
      .equalTo(utrTrimmed)
      .once('value');

    if (allOrdersSnap.exists()) {
      const existingOrders = allOrdersSnap.val();
      for (const [existingId, existingOrder] of Object.entries(existingOrders)) {
        if (existingId !== requestId && existingOrder.status === 'SUCCESS') {
          return res.status(409).json({
            success: false,
            error: 'This Transaction ID has already been used for another deposit'
          });
        }
      }
    }

    // Update deposit record
    const updateData = {
      utr: utrTrimmed,
      utrSubmittedAt: Date.now(),
      status: 'VERIFYING'
    };

    await rtdb().ref(`wallets/${userId}/deposits/${requestId}`).update(updateData);
    await rtdb().ref(`depositOrders/${requestId}`).update(updateData);

    console.log(`[Deposit] UTR submitted for ${requestId}: ${utrTrimmed}`);

    // Start automatic verification
    startVerification(requestId, userId, deposit.amount, utrTrimmed);

    return res.json({
      success: true,
      message: 'Verification started'
    });

  } catch (err) {
    console.error('[Deposit] Submit UTR error:', err);
    return res.status(500).json({
      success: false,
      error: 'Failed to submit Transaction ID'
    });
  }
});

// ── GET /status/:requestId ─────────────────────────────────────────────────────

router.get('/status/:requestId', verifyAuth, async (req, res) => {
  try {
    const { requestId } = req.params;

    const depositSnap = await rtdb().ref(`depositOrders/${requestId}`).once('value');
    const deposit = depositSnap.val();

    if (!deposit) {
      return res.status(404).json({
        success: false,
        error: 'Deposit request not found'
      });
    }

    // Check ownership or admin
    const userIsAdmin = await isAdmin(req.user.uid);
    if (deposit.userId !== req.user.uid && !userIsAdmin) {
      return res.status(403).json({
        success: false,
        error: 'You do not have permission to view this deposit'
      });
    }

    // Build a human-readable message
    const statusMessages = {
      PENDING: 'Waiting for Transaction ID submission',
      VERIFYING: 'Verifying payment – this may take a few minutes',
      SUCCESS: 'Payment verified and wallet credited',
      FAILED: deposit.failureReason || 'Verification failed',
      EXPIRED: 'Verification timed out – please contact support',
      CANCELLED: 'Deposit was cancelled'
    };

    return res.json({
      success: true,
      status: deposit.status,
      amount: deposit.amount,
      utr: deposit.utr,
      verifiedAt: deposit.verifiedAt || null,
      createdAt: deposit.createdAt,
      message: statusMessages[deposit.status] || deposit.status
    });

  } catch (err) {
    console.error('[Deposit] Status check error:', err);
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch deposit status'
    });
  }
});

// ── POST /cancel/:requestId ────────────────────────────────────────────────────

router.post('/cancel/:requestId', verifyAuth, async (req, res) => {
  try {
    const { requestId } = req.params;

    const depositSnap = await rtdb().ref(`depositOrders/${requestId}`).once('value');
    const deposit = depositSnap.val();

    if (!deposit) {
      return res.status(404).json({
        success: false,
        error: 'Deposit request not found'
      });
    }

    // Validate ownership
    if (deposit.userId !== req.user.uid) {
      return res.status(403).json({
        success: false,
        error: 'You do not own this deposit request'
      });
    }

    // Only PENDING or VERIFYING can be cancelled
    if (deposit.status !== 'PENDING' && deposit.status !== 'VERIFYING') {
      return res.status(400).json({
        success: false,
        error: `Cannot cancel deposit with status ${deposit.status}`
      });
    }

    // If VERIFYING, stop the background job
    if (deposit.status === 'VERIFYING') {
      cancelVerification(requestId);
    }

    const updateData = {
      status: 'CANCELLED',
      cancelledAt: Date.now()
    };

    await rtdb().ref(`wallets/${deposit.userId}/deposits/${requestId}`).update(updateData);
    await rtdb().ref(`depositOrders/${requestId}`).update(updateData);

    console.log(`[Deposit] Cancelled ${requestId}`);

    return res.json({ success: true });

  } catch (err) {
    console.error('[Deposit] Cancel error:', err);
    return res.status(500).json({
      success: false,
      error: 'Failed to cancel deposit'
    });
  }
});

// ── POST /admin/override/:requestId ────────────────────────────────────────────

router.post('/admin/override/:requestId', verifyAuth, async (req, res) => {
  try {
    const { requestId } = req.params;

    // Admin check
    const userIsAdmin = await isAdmin(req.user.uid);
    if (!userIsAdmin) {
      return res.status(403).json({
        success: false,
        error: 'Admin access required'
      });
    }

    const depositSnap = await rtdb().ref(`depositOrders/${requestId}`).once('value');
    const deposit = depositSnap.val();

    if (!deposit) {
      return res.status(404).json({
        success: false,
        error: 'Deposit request not found'
      });
    }

    // Only FAILED or EXPIRED deposits can be overridden
    if (deposit.status !== 'FAILED' && deposit.status !== 'EXPIRED') {
      return res.status(400).json({
        success: false,
        error: `Cannot override deposit with status ${deposit.status}. Only FAILED or EXPIRED deposits can be overridden.`
      });
    }

    console.log(`[Deposit] Admin override for ${requestId} by ${req.user.uid}`);

    // Temporarily set status to VERIFYING so creditWallet's guard passes
    await rtdb().ref(`depositOrders/${requestId}/status`).set('VERIFYING');
    await rtdb().ref(`wallets/${deposit.userId}/deposits/${requestId}/status`).set('VERIFYING');

    // Credit wallet
    const credited = await creditWallet(deposit.userId, deposit.amount, requestId);

    if (!credited) {
      // Revert status
      await rtdb().ref(`depositOrders/${requestId}/status`).set(deposit.status);
      await rtdb().ref(`wallets/${deposit.userId}/deposits/${requestId}/status`).set(deposit.status);

      return res.status(500).json({
        success: false,
        error: 'Wallet credit failed during admin override'
      });
    }

    // Update deposit record
    const updateData = {
      status: 'SUCCESS',
      verifiedAt: Date.now(),
      processedBy: req.user.uid,
      verificationSource: 'admin_override'
    };

    await rtdb().ref(`wallets/${deposit.userId}/deposits/${requestId}`).update(updateData);
    await rtdb().ref(`depositOrders/${requestId}`).update(updateData);

    console.log(`[Deposit] Admin override SUCCESS for ${requestId}`);

    return res.json({ success: true });

  } catch (err) {
    console.error('[Deposit] Admin override error:', err);
    return res.status(500).json({
      success: false,
      error: 'Admin override failed'
    });
  }
});

// ── GET /admin/active-jobs ─────────────────────────────────────────────────────

router.get('/admin/active-jobs', verifyAuth, async (req, res) => {
  try {
    // Admin check
    const userIsAdmin = await isAdmin(req.user.uid);
    if (!userIsAdmin) {
      return res.status(403).json({
        success: false,
        error: 'Admin access required'
      });
    }

    const jobs = getActiveJobs();

    return res.json({
      success: true,
      count: jobs.length,
      jobs
    });

  } catch (err) {
    console.error('[Deposit] Active jobs error:', err);
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch active jobs'
    });
  }
});

module.exports = router;
