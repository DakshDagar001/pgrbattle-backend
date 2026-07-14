/**
 * Deposit Verifier
 *
 * Core verification engine for automatic deposit processing.
 * Polls Gmail for payment emails, parses them, matches against pending
 * deposits by UTR + amount, and credits the user's wallet atomically.
 *
 * Depends on:
 *   - Firebase Admin (RTDB + Firestore)
 *   - gmailService.fetchLatestPaymentEmails()
 *   - paymentParser.parsePaymentEmail()
 *   - notificationEngine.notifyUser() (injected via initVerifier)
 */

const admin = require('firebase-admin');
const { fetchLatestPaymentEmails } = require('./gmailService');
const { parsePaymentEmail } = require('./paymentParser');

// ── State ──────────────────────────────────────────────────────────────────────

/** Map<requestId, { intervalId, userId, amount, utr, iteration, startedAt }> */
const activeJobs = new Map();

/** Reference to the notifyUser function (injected at startup). */
let notifyUserFn = null;

// ── Init ───────────────────────────────────────────────────────────────────────

/**
 * Store a reference to the push notification function so the verifier
 * can notify users when deposits are verified or expire.
 *
 * @param {Function} notifyUser
 */
function initVerifier(notifyUser) {
  notifyUserFn = notifyUser;
  console.log('[Verifier] Initialised');
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function rtdb() {
  return admin.database();
}

function firestore() {
  return admin.firestore();
}

/**
 * Send a push notification to a user (no-op if notifyUserFn is not set).
 */
async function notify(userId, title, message, data = {}) {
  if (!notifyUserFn) {
    console.warn('[Verifier] notifyUserFn not set – skipping notification');
    return;
  }
  try {
    await notifyUserFn(userId, title, message, data);
  } catch (e) {
    console.error('[Verifier] Notification failed:', e.message);
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
    console.error('[Verifier] Failed to append log:', e.message);
  }
}

// ── Duplicate UTR Check ────────────────────────────────────────────────────────

/**
 * Scan depositOrders for any record with the same UTR that is already SUCCESS.
 * Returns true if a duplicate is found.
 */
async function isDuplicateUTR(utr, excludeRequestId) {
  try {
    const snap = await rtdb()
      .ref('depositOrders')
      .orderByChild('utr')
      .equalTo(utr)
      .once('value');

    if (!snap.exists()) return false;

    const orders = snap.val();
    for (const [reqId, order] of Object.entries(orders)) {
      if (reqId !== excludeRequestId && order.status === 'SUCCESS') {
        console.warn(`[Verifier] Duplicate UTR ${utr} found on ${reqId}`);
        return true;
      }
    }
    return false;
  } catch (e) {
    console.error('[Verifier] Duplicate UTR check failed:', e.message);
    return false; // fail open – creditWallet will do its own check
  }
}

// ── Credit Wallet ──────────────────────────────────────────────────────────────

/**
 * ATOMICALLY credit the user's wallet in both RTDB and Firestore, and create
 * a transaction record.
 *
 * Guards:
 *   - Duplicate UTR check across all depositOrders
 *   - Anti-double-credit: verify deposit status is still VERIFYING
 *
 * @param {string} userId
 * @param {number} amount
 * @param {string} requestId
 * @returns {Promise<boolean>} true if credit succeeded
 */
async function creditWallet(userId, amount, requestId) {
  console.log(`[Verifier] creditWallet: userId=${userId}, amount=${amount}, requestId=${requestId}`);

  // 1. Read deposit status – must still be VERIFYING
  const depositSnap = await rtdb().ref(`depositOrders/${requestId}`).once('value');
  const deposit = depositSnap.val();

  if (!deposit) {
    console.error('[Verifier] Deposit record not found for', requestId);
    return false;
  }

  if (deposit.status !== 'VERIFYING') {
    console.warn(`[Verifier] Deposit ${requestId} status is ${deposit.status}, not VERIFYING – aborting credit`);
    return false;
  }

  // 2. Duplicate UTR check
  if (deposit.utr) {
    const dup = await isDuplicateUTR(deposit.utr, requestId);
    if (dup) {
      console.error(`[Verifier] Refusing to credit – UTR ${deposit.utr} already used`);
      await updateDepositStatus(requestId, userId, 'FAILED', {
        failureReason: 'Duplicate UTR detected'
      });
      return false;
    }
  }

  // 3. RTDB atomic balance update
  const balanceRef = rtdb().ref(`wallets/${userId}/balances`);

  const txResult = await balanceRef.transaction((current) => {
    if (current === null) {
      // First deposit ever – initialise balances
      return {
        depositBalance: amount,
        walletBalance: amount
      };
    }
    return {
      ...current,
      depositBalance: (current.depositBalance || 0) + amount,
      walletBalance: (current.walletBalance || 0) + amount
    };
  });

  if (!txResult.committed) {
    console.error('[Verifier] RTDB balance transaction failed for', userId);
    return false;
  }

  console.log('[Verifier] RTDB balance updated for', userId, '– new:', txResult.snapshot.val());

  // 4. Firestore balance update (best-effort mirror)
  try {
    await firestore().collection('users').doc(userId).update({
      depositBalance: admin.firestore.FieldValue.increment(amount),
      walletBalance: admin.firestore.FieldValue.increment(amount)
    });
    console.log('[Verifier] Firestore balance updated for', userId);
  } catch (e) {
    console.error('[Verifier] Firestore balance update failed (RTDB is source of truth):', e.message);
  }

  // 5. Create transaction record
  const txnId = `TXN_DEP_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const txnRecord = {
    txnId,
    type: 'deposit',
    amount,
    requestId,
    status: 'SUCCESS',
    createdAt: Date.now(),
    description: `Deposit of ₹${amount} verified automatically`
  };

  try {
    await rtdb().ref(`wallets/${userId}/transactions/${txnId}`).set(txnRecord);
    console.log('[Verifier] Transaction record created:', txnId);
  } catch (e) {
    console.error('[Verifier] Failed to create transaction record:', e.message);
  }

  return true;
}

// ── Status Updates ─────────────────────────────────────────────────────────────

/**
 * Update the deposit status in both the user-scoped and global records.
 */
async function updateDepositStatus(requestId, userId, status, extra = {}) {
  const update = { status, ...extra };
  try {
    await rtdb().ref(`wallets/${userId}/deposits/${requestId}`).update(update);
    await rtdb().ref(`depositOrders/${requestId}`).update(update);
  } catch (e) {
    console.error('[Verifier] Failed to update deposit status:', e.message);
  }
}

// ── Verification Loop ──────────────────────────────────────────────────────────

/**
 * Start an automatic verification job for a deposit.
 *
 * Polls Gmail every 3 seconds for up to 5 minutes (≈ 100 iterations).
 * On match: credits wallet, marks SUCCESS, sends push.
 * On timeout: marks EXPIRED, sends failure push.
 *
 * @param {string} requestId
 * @param {string} userId
 * @param {number} amount
 * @param {string} utr
 */
function startVerification(requestId, userId, amount, utr) {
  console.log(`[Verifier] Starting verification: ${requestId} | user=${userId} | ₹${amount} | UTR=${utr}`);

  if (activeJobs.has(requestId)) {
    console.warn(`[Verifier] Job already active for ${requestId}`);
    return;
  }

  const MAX_ITERATIONS = 100;
  const INTERVAL_MS = 3000; // 3 seconds
  const startedAt = Date.now();
  let iteration = 0;

  const job = {
    userId,
    amount,
    utr,
    startedAt,
    iteration: 0,
    intervalId: null
  };

  const intervalId = setInterval(async () => {
    iteration++;
    job.iteration = iteration;

    if (iteration > MAX_ITERATIONS) {
      // ── Timeout ──
      clearInterval(intervalId);
      activeJobs.delete(requestId);

      console.log(`[Verifier] Verification EXPIRED for ${requestId} after ${iteration - 1} iterations`);

      await updateDepositStatus(requestId, userId, 'EXPIRED', {
        failureReason: 'Verification timed out after 5 minutes'
      });

      await appendVerificationLog(requestId, userId, {
        iteration,
        timestamp: Date.now(),
        event: 'EXPIRED',
        message: 'Verification timed out'
      });

      await notify(userId, 'Deposit Failed', `Your deposit of ₹${amount} could not be verified. Please contact support.`, {
        type: 'deposit_expired',
        requestId
      });

      return;
    }

    try {
      // Fetch emails received since the job started (minus a 5-minute buffer)
      const sinceTs = startedAt - 5 * 60 * 1000;
      const emails = await fetchLatestPaymentEmails(sinceTs);

      let matched = false;

      for (const email of emails) {
        const parsed = parsePaymentEmail(email.body, email.subject);

        if (!parsed) continue;

        // Match by UTR (case-insensitive) AND amount
        const utrMatch = parsed.utr && utr &&
          parsed.utr.toLowerCase() === utr.toLowerCase();
        const amountMatch = parsed.amount && Math.abs(parsed.amount - amount) < 0.01;

        if (utrMatch && amountMatch) {
          console.log(`[Verifier] ✅ MATCH for ${requestId}: UTR=${parsed.utr}, Amount=${parsed.amount}`);
          matched = true;

          // Stop the loop
          clearInterval(intervalId);
          activeJobs.delete(requestId);

          // Credit wallet
          const credited = await creditWallet(userId, amount, requestId);

          if (credited) {
            await updateDepositStatus(requestId, userId, 'SUCCESS', {
              verifiedAt: Date.now(),
              verificationSource: `email:${email.messageId}`,
              processedBy: 'backend-auto'
            });

            await appendVerificationLog(requestId, userId, {
              iteration,
              timestamp: Date.now(),
              event: 'SUCCESS',
              message: `Matched email ${email.messageId}`,
              parsedData: parsed
            });

            await notify(userId, 'Deposit Successful! 🎉', `₹${amount} has been added to your wallet.`, {
              type: 'deposit_success',
              requestId,
              amount
            });
          } else {
            await updateDepositStatus(requestId, userId, 'FAILED', {
              failureReason: 'Wallet credit failed after UTR match'
            });

            await appendVerificationLog(requestId, userId, {
              iteration,
              timestamp: Date.now(),
              event: 'CREDIT_FAILED',
              message: 'UTR matched but wallet credit failed'
            });

            await notify(userId, 'Deposit Issue', `Your deposit of ₹${amount} was found but could not be credited. Contact support.`, {
              type: 'deposit_credit_failed',
              requestId
            });
          }

          break; // exit email loop
        }
      }

      // Log check attempt (only every 10th iteration to avoid log spam)
      if (!matched && iteration % 10 === 0) {
        await appendVerificationLog(requestId, userId, {
          iteration,
          timestamp: Date.now(),
          event: 'CHECK',
          message: `Checked ${emails.length} email(s), no match yet`
        });
      }

    } catch (err) {
      console.error(`[Verifier] Error in iteration ${iteration} for ${requestId}:`, err.message);

      if (iteration % 10 === 0) {
        await appendVerificationLog(requestId, userId, {
          iteration,
          timestamp: Date.now(),
          event: 'ERROR',
          message: err.message
        });
      }
    }
  }, INTERVAL_MS);

  job.intervalId = intervalId;
  activeJobs.set(requestId, job);

  console.log(`[Verifier] Job registered: ${requestId}`);
}

// ── Cancel ─────────────────────────────────────────────────────────────────────

/**
 * Cancel an active verification job.
 *
 * @param {string} requestId
 * @returns {boolean} true if a running job was cancelled
 */
function cancelVerification(requestId) {
  const job = activeJobs.get(requestId);
  if (!job) {
    console.log(`[Verifier] No active job for ${requestId}`);
    return false;
  }

  clearInterval(job.intervalId);
  activeJobs.delete(requestId);
  console.log(`[Verifier] Cancelled job ${requestId}`);
  return true;
}

// ── Query ──────────────────────────────────────────────────────────────────────

/**
 * Return a snapshot of all currently active verification jobs.
 *
 * @returns {Array<{ requestId, userId, amount, utr, iteration, startedAt, runningForMs }>}
 */
function getActiveJobs() {
  const now = Date.now();
  const list = [];

  for (const [requestId, job] of activeJobs.entries()) {
    list.push({
      requestId,
      userId: job.userId,
      amount: job.amount,
      utr: job.utr,
      iteration: job.iteration,
      startedAt: job.startedAt,
      runningForMs: now - job.startedAt
    });
  }

  return list;
}

module.exports = {
  initVerifier,
  startVerification,
  cancelVerification,
  getActiveJobs,
  creditWallet // exported so admin override route can use it directly
};
