/**
 * Deposit Routes
 *
 * Express Router for the deposit / payment flow:
 *   POST   /create              – create a new deposit request + ZapUPI order
 *   POST   /submit-utr          – submit Transaction ID and start verification (legacy Gmail path)
 *   POST   /zapupi-webhook      – ZapUPI payment webhook (unauthenticated)
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
const { createOrder, getOrderStatus } = require('../services/zapupiService');

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

/**
 * Send an event-driven push notification to a user.
 */
async function notifyEvent(eventKey, userId, title, message, data = {}) {
  try {
    const { notifyByEvent } = require('../services/notificationEngine');
    await notifyByEvent(
      eventKey,
      'user',
      userId,
      data,
      { title, body: message }
    );
  } catch (e) {
    console.error('[Deposit] Notification failed:', e.message);
  }
}

/**
 * Append a log entry to the deposit's verificationLogs array in RTDB.
 */
async function appendVerificationLog(requestId, userId, logEntry) {
  try {
    const logRef = rtdb().ref(`wallets/${userId}/deposits/${requestId}/verificationLogs`);
    const snap = await logRef.once('value');
    const logs = snap.val() || [];
    logs.push(logEntry);
    await logRef.set(logs);

    // Also update global record
    await rtdb().ref(`depositOrders/${requestId}/verificationLogs`).set(logs);
  } catch (e) {
    console.error('[Deposit] Failed to append log:', e.message);
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

    // ── Create ZapUPI order ──
    let zapupiResult;
    try {
      zapupiResult = await createOrder({
        orderId: requestId,
        amount,
        remark: `PGR Deposit ${requestId} by ${userId}`
      });
    } catch (zapErr) {
      console.error(`[Deposit] ZapUPI order creation failed for ${requestId}:`, zapErr.message);
      return res.status(502).json({
        success: false,
        error: 'Payment gateway unavailable. Please try again later.'
      });
    }

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
      processedBy: 'backend-auto',
      // ZapUPI fields
      zapupiOrderId: zapupiResult.orderId || requestId,
      paymentUrl: zapupiResult.paymentUrl,
      zapupiTxnId: null,
      zapupiUtr: null,
      webhookReceivedAt: null,
      orderStatusCheckedAt: null
    };

    // Write to user-scoped deposits
    await rtdb().ref(`wallets/${userId}/deposits/${requestId}`).set(depositRecord);

    // Write to global depositOrders
    await rtdb().ref(`depositOrders/${requestId}`).set(depositRecord);

    console.log(`[Deposit] Created ${requestId} for user ${userId}, ₹${amount} – ZapUPI paymentUrl ready`);

    // Read admin UPI ID (backward compat for manual deposit display)
    const adminUpiId = await getAppConfig('adminUpiId', null);

    return res.json({
      success: true,
      requestId,
      orderId: zapupiResult.orderId || requestId,
      paymentUrl: zapupiResult.paymentUrl,
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
// Legacy route: user-submitted UTR triggers Gmail-based verification.
// Preserved for backward compatibility until Gmail system is fully removed.

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

// ── POST /zapupi-webhook ──────────────────────────────────────────────────────
// ZapUPI calls this endpoint when a payment status changes.
// NO Firebase auth — ZapUPI cannot provide a Firebase token.
//
// Security:
//   - Optional IP whitelist (ZAPUPI_GATEWAY_IP env var)
//   - Server-side order-status verification (never trust webhook alone)
//   - Idempotency via deposit status guard + creditWallet's own guards

router.post('/zapupi-webhook', async (req, res) => {
  try {
    // Always return 200 to ZapUPI to prevent infinite retries
    const respondOk = () => res.status(200).json({ status: 'ok' });

    const payload = req.body;

    console.log('[Deposit] ZapUPI webhook received:', JSON.stringify(payload));

    // ── Optional IP whitelist ──
    const gatewayIp = process.env.ZAPUPI_GATEWAY_IP;
    if (gatewayIp) {
      const clientIp = req.ip || req.connection?.remoteAddress || '';
      // Handle IPv6-mapped IPv4 (e.g. ::ffff:148.135.143.154)
      const normalizedIp = clientIp.replace(/^::ffff:/, '');
      if (normalizedIp !== gatewayIp) {
        console.warn(`[Deposit] Webhook from unexpected IP: ${clientIp} (expected ${gatewayIp})`);
        // Still return 200 – don't leak info about validation
        return respondOk();
      }
    }

    // ── Validate payload ──
    if (!payload || !payload.order_id) {
      console.error('[Deposit] Webhook missing order_id');
      return respondOk();
    }

    const webhookOrderId = String(payload.order_id);
    const webhookStatus = String(payload.status || '');
    const webhookAmount = parseFloat(payload.amount) || 0;
    const webhookUtr = payload.utr || null;
    const webhookTxnId = payload.txn_id || null;

    console.log(`[Deposit] Webhook: orderId=${webhookOrderId}, status=${webhookStatus}, amount=${webhookAmount}`);

    // ── Fetch deposit record ──
    // The ZapUPI order_id IS the PGR requestId
    const requestId = webhookOrderId;
    const depositSnap = await rtdb().ref(`depositOrders/${requestId}`).once('value');
    const deposit = depositSnap.val();

    if (!deposit) {
      console.error(`[Deposit] Webhook: deposit not found for requestId=${requestId}`);
      return respondOk();
    }

    // ── Idempotency: already processed ──
    if (deposit.status === 'SUCCESS') {
      console.log(`[Deposit] Webhook: deposit ${requestId} already SUCCESS – ignoring duplicate`);
      return respondOk();
    }

    // ── Only process automatic deposits ──
    if (deposit.depositType !== 'automatic') {
      console.warn(`[Deposit] Webhook: deposit ${requestId} is ${deposit.depositType}, not automatic – ignoring`);
      return respondOk();
    }

    // ── Atomic Claim: Ensure only ONE request can process this specific deposit ──
    // Atomically transition status from PENDING to PROCESSING using RTDB transaction.
    // If status is not PENDING (e.g. already PROCESSING, VERIFYING, SUCCESS, FAILED), the transaction aborts.
    const statusRef = rtdb().ref(`depositOrders/${requestId}/status`);
    const claimTxResult = await statusRef.transaction((currentStatus) => {
      if (currentStatus === 'PENDING') {
        return 'PROCESSING';
      }
      return; // returning undefined aborts the transaction
    });

    if (!claimTxResult.committed) {
      console.log(`[Deposit] Webhook: deposit ${requestId} already claimed or processed (status was not PENDING) – ignoring duplicate`);
      return respondOk();
    }

    const userId = deposit.userId;
    const expectedAmount = deposit.amount;

    // Mirror the claimed PROCESSING status to the user-scoped record
    await rtdb().ref(`wallets/${userId}/deposits/${requestId}/status`).set('PROCESSING');

    // Record that webhook was received
    await rtdb().ref(`wallets/${userId}/deposits/${requestId}/webhookReceivedAt`).set(Date.now());
    await rtdb().ref(`depositOrders/${requestId}/webhookReceivedAt`).set(Date.now());

    // ── Handle non-success webhook ──
    if (webhookStatus !== 'Success') {
      console.log(`[Deposit] Webhook: non-success status "${webhookStatus}" for ${requestId}`);

      await appendVerificationLog(requestId, userId, {
        timestamp: Date.now(),
        event: 'WEBHOOK_NON_SUCCESS',
        message: `ZapUPI webhook status: ${webhookStatus}`,
        webhookData: { status: webhookStatus, amount: webhookAmount, txnId: webhookTxnId }
      });

      // Revert status back to PENDING so user/gateway can retry
      await rtdb().ref(`depositOrders/${requestId}/status`).set('PENDING');
      await rtdb().ref(`wallets/${userId}/deposits/${requestId}/status`).set('PENDING');

      return respondOk();
    }

    // ── Webhook says Success — VERIFY independently via Order Status API ──
    console.log(`[Deposit] Webhook success for ${requestId} – verifying via Order Status API...`);

    let orderStatus;
    try {
      orderStatus = await getOrderStatus(requestId);
    } catch (statusErr) {
      console.error(`[Deposit] Order Status API call failed for ${requestId}:`, statusErr.message);

      await appendVerificationLog(requestId, userId, {
        timestamp: Date.now(),
        event: 'STATUS_API_FAILED',
        message: `Order Status API call failed: ${statusErr.message}`,
        webhookData: { status: webhookStatus, amount: webhookAmount }
      });

      // Revert status back to PENDING so future webhook retries from ZapUPI can re-claim and process
      await rtdb().ref(`depositOrders/${requestId}/status`).set('PENDING');
      await rtdb().ref(`wallets/${userId}/deposits/${requestId}/status`).set('PENDING');

      return respondOk();
    }

    // Record status check timestamp
    await rtdb().ref(`wallets/${userId}/deposits/${requestId}/orderStatusCheckedAt`).set(Date.now());
    await rtdb().ref(`depositOrders/${requestId}/orderStatusCheckedAt`).set(Date.now());

    // ── Verify status from Order Status API ──
    if (orderStatus.status !== 'Success') {
      console.warn(`[Deposit] Order Status API says "${orderStatus.status}" for ${requestId} (webhook said Success) – aborting`);

      await appendVerificationLog(requestId, userId, {
        timestamp: Date.now(),
        event: 'STATUS_MISMATCH',
        message: `Webhook said Success but Order Status API says: ${orderStatus.status}`,
        orderStatusData: orderStatus
      });

      // Revert status back to PENDING
      await rtdb().ref(`depositOrders/${requestId}/status`).set('PENDING');
      await rtdb().ref(`wallets/${userId}/deposits/${requestId}/status`).set('PENDING');

      return respondOk();
    }

    // ── Verify amount ──
    const confirmedAmount = orderStatus.amount;
    if (Math.abs(confirmedAmount - expectedAmount) >= 0.01) {
      console.error(`[Deposit] Amount mismatch for ${requestId}: expected=${expectedAmount}, confirmed=${confirmedAmount}`);

      const failUpdate = {
        status: 'FAILED',
        failureReason: `Amount mismatch: expected ₹${expectedAmount}, got ₹${confirmedAmount}`
      };
      await rtdb().ref(`wallets/${userId}/deposits/${requestId}`).update(failUpdate);
      await rtdb().ref(`depositOrders/${requestId}`).update(failUpdate);

      await appendVerificationLog(requestId, userId, {
        timestamp: Date.now(),
        event: 'AMOUNT_MISMATCH',
        message: `Expected ₹${expectedAmount}, confirmed ₹${confirmedAmount}`,
        orderStatusData: orderStatus
      });

      await notifyEvent('deposit_rejected', userId, 'Deposit Issue',
        `Your deposit of ₹${expectedAmount} could not be verified due to an amount mismatch. Please contact support.`, {
          type: 'deposit_amount_mismatch',
          requestId,
          amount: expectedAmount
        });

      return respondOk();
    }

    // ── All verifications passed — set status to VERIFYING so creditWallet guard passes ──
    await rtdb().ref(`wallets/${userId}/deposits/${requestId}/status`).set('VERIFYING');
    await rtdb().ref(`depositOrders/${requestId}/status`).set('VERIFYING');

    // ── Credit wallet ──
    const credited = await creditWallet(userId, expectedAmount, requestId);

    if (!credited) {
      console.error(`[Deposit] creditWallet failed for ${requestId}`);

      // creditWallet may have set status to FAILED (duplicate UTR) — check
      const recheckSnap = await rtdb().ref(`depositOrders/${requestId}/status`).once('value');
      const recheckStatus = recheckSnap.val();

      if (recheckStatus !== 'FAILED') {
        // creditWallet failed for another reason — revert to PENDING
        await rtdb().ref(`wallets/${userId}/deposits/${requestId}/status`).set('PENDING');
        await rtdb().ref(`depositOrders/${requestId}/status`).set('PENDING');
      }

      await appendVerificationLog(requestId, userId, {
        timestamp: Date.now(),
        event: 'CREDIT_FAILED',
        message: 'ZapUPI verified but wallet credit failed',
        orderStatusData: orderStatus
      });

      return respondOk();
    }

    // ── Success — update deposit record with ZapUPI metadata ──
    const successUpdate = {
      status: 'SUCCESS',
      verifiedAt: Date.now(),
      verificationSource: 'zapupi',
      processedBy: 'backend-auto',
      zapupiTxnId: orderStatus.txnId || webhookTxnId || null,
      zapupiUtr: orderStatus.utr || webhookUtr || null,
      utr: orderStatus.utr || webhookUtr || null // Also set legacy utr field for admin visibility
    };

    await rtdb().ref(`wallets/${userId}/deposits/${requestId}`).update(successUpdate);
    await rtdb().ref(`depositOrders/${requestId}`).update(successUpdate);

    console.log(`[Deposit] ✅ ZapUPI deposit SUCCESS: ${requestId}, ₹${expectedAmount} credited to ${userId}`);

    await appendVerificationLog(requestId, userId, {
      timestamp: Date.now(),
      event: 'SUCCESS',
      message: `ZapUPI payment verified and wallet credited`,
      zapupiData: {
        txnId: orderStatus.txnId,
        utr: orderStatus.utr,
        confirmedAmount: confirmedAmount
      }
    });

    await notifyEvent('deposit_approved', userId, 'Deposit Successful! 🎉',
      `₹${expectedAmount} has been added to your wallet.`, {
        type: 'deposit_success',
        requestId,
        amount: expectedAmount
      });

    return respondOk();

  } catch (err) {
    console.error('[Deposit] Webhook processing error:', err);
    // Always return 200 to prevent ZapUPI retries on internal errors
    return res.status(200).json({ status: 'ok' });
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
      PENDING: 'Waiting for payment',
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
      paymentUrl: deposit.paymentUrl || null,
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

    // If VERIFYING, stop the background job (legacy Gmail path)
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
