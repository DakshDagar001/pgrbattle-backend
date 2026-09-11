/**
 * Emulator Authorization Routes (Phase 9)
 *
 * Provides trusted server-side management of emulator authorization requests:
 *   GET   /api/emulator/status          – Player pre-login/post-login status check (minimal data)
 *   POST  /api/emulator/request         – Player submit emulator authorization request (forces 'pending')
 *   GET   /api/admin/emulator-requests  – Admin list emulator requests (authenticated, requires isAdmin)
 *   POST  /api/admin/emulator-requests/:hwid/approve – Admin approve emulator
 *   POST  /api/admin/emulator-requests/:hwid/reject  – Admin reject emulator (with reason)
 *   POST  /api/admin/emulator-requests/:hwid/revoke  – Admin revoke emulator access
 */

const express = require('express');
const admin = require('firebase-admin');
const { verifyAuth } = require('../middleware/auth');

const router = express.Router();

function firestore() {
  return admin.firestore();
}

/**
 * Check whether a user is an admin by looking up the admin_users collection.
 */
async function isAdmin(uid) {
  if (!uid) return false;
  try {
    const doc = await firestore().collection('admin_users').doc(uid).get();
    return doc.exists;
  } catch (e) {
    console.error('[Emulator] Admin check failed:', e.message);
    return false;
  }
}

/**
 * In-memory sliding window rate limiter to prevent abuse and brute-force queries.
 */
const rateLimitMap = new Map();
function checkRateLimit(key, limit, windowMs) {
  const now = Date.now();
  const record = rateLimitMap.get(key) || [];
  const recent = record.filter(time => now - time < windowMs);
  if (recent.length >= limit) {
    return false;
  }
  recent.push(now);
  rateLimitMap.set(key, recent);
  return true;
}

// Clean up stale rate limit entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, timestamps] of rateLimitMap.entries()) {
    const valid = timestamps.filter(t => now - t < 600000);
    if (valid.length === 0) {
      rateLimitMap.delete(key);
    } else {
      rateLimitMap.set(key, valid);
    }
  }
}, 600000);

/**
 * Validates hardware identifier (Android ID) format.
 * Expects non-empty alphanumeric string between 6 and 64 characters.
 */
function isValidHwid(hwid) {
  if (typeof hwid !== 'string') return false;
  const trimmed = hwid.trim();
  return trimmed.length >= 6 && trimmed.length <= 64 && /^[a-zA-Z0-9_-]+$/.test(trimmed);
}

/**
 * Logs an administrative audit action to the transcripts/hwid collection.
 */
async function logAuditTranscript(actionType, title, payload, adminUid, adminEmail) {
  try {
    const docRef = firestore().collection('transcripts').doc('hwid').collection('entries').doc();
    await docRef.set({
      transcriptId: docRef.id,
      section: 'hwid',
      actionType,
      title,
      payload,
      performedBy: 'admin',
      performerId: adminUid || '',
      performerEmail: adminEmail || '',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (err) {
    console.warn('[EmulatorAudit] Failed to log audit transcript:', err.message);
  }
}

// =============================================================================
// PLAYER ENDPOINTS (Pre-login safe, minimal data disclosure)
// =============================================================================

/**
 * GET /api/emulator/status?hwid=...
 *
 * Checks authorization status for a given HWID.
 * Safe for pre-login checks. Returns ONLY { success, approved, status }.
 * Never leaks other users' data, admin notes, or internal metadata.
 */
router.get('/api/emulator/status', async (req, res) => {
  try {
    const hwid = req.query.hwid;
    const clientIp = req.ip || req.connection?.remoteAddress || 'unknown';

    // Rate limit: 60 requests per minute per IP
    if (!checkRateLimit(`status_${clientIp}`, 60, 60000)) {
      return res.status(429).json({
        success: false,
        error: 'Too many status check requests. Please wait a moment.'
      });
    }

    if (!isValidHwid(hwid)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid or missing HWID parameter'
      });
    }

    const cleanHwid = hwid.trim();
    const doc = await firestore().collection('emulator_requests').doc(cleanHwid).get();

    if (!doc.exists) {
      return res.json({
        success: true,
        approved: false,
        status: 'not_found'
      });
    }

    const data = doc.data() || {};
    const status = String(data.status || 'pending').toLowerCase();
    const isApproved = status === 'approved';

    return res.json({
      success: true,
      approved: isApproved,
      status: status
    });
  } catch (err) {
    console.error('[Emulator] Status check failed:', err.message);
    return res.status(500).json({
      success: false,
      error: 'Failed to check emulator authorization status'
    });
  }
});

/**
 * POST /api/emulator/request
 *
 * Submits an emulator authorization request.
 * Server controls database writes: forces status to 'pending'.
 * Client CANNOT self-approve.
 */
router.post('/api/emulator/request', async (req, res) => {
  try {
    const {
      hwid,
      deviceModel,
      manufacturer,
      fingerprint,
      androidVersion,
      playerName,
      userEmail,
      uid
    } = req.body || {};

    const clientIp = req.ip || req.connection?.remoteAddress || 'unknown';

    // Rate limit: 10 submissions per 10 minutes per HWID/IP
    if (!checkRateLimit(`request_${hwid || clientIp}`, 10, 600000)) {
      return res.status(429).json({
        success: false,
        error: 'Too many requests submitted. Please wait before retrying.'
      });
    }

    if (!isValidHwid(hwid)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid or missing HWID in request body'
      });
    }

    const cleanHwid = hwid.trim();
    const docRef = firestore().collection('emulator_requests').doc(cleanHwid);
    const existingDoc = await docRef.get();

    // Sanitize string inputs
    const sanitizeStr = (val, maxLen = 100) => {
      if (typeof val !== 'string') return '';
      return val.trim().substring(0, maxLen);
    };

    const cleanModel = sanitizeStr(deviceModel, 80);
    const cleanManufacturer = sanitizeStr(manufacturer, 80);
    const cleanFingerprint = sanitizeStr(fingerprint, 200);
    const cleanAndroidVersion = sanitizeStr(androidVersion, 30);
    const cleanPlayerName = sanitizeStr(playerName, 60);
    const cleanEmail = sanitizeStr(userEmail, 100);
    const cleanUid = sanitizeStr(uid, 64);

    if (existingDoc.exists) {
      const existing = existingDoc.data() || {};
      const currentStatus = String(existing.status || '').toLowerCase();

      if (currentStatus === 'approved') {
        return res.json({
          success: true,
          approved: true,
          status: 'approved',
          message: 'Device is already authorized'
        });
      }

      if (currentStatus === 'pending') {
        return res.json({
          success: true,
          approved: false,
          status: 'pending',
          message: 'Authorization request is already pending administrator review'
        });
      }

      if (currentStatus === 'revoked') {
        return res.status(403).json({
          success: false,
          approved: false,
          status: 'revoked',
          message: 'Emulator authorization for this device was revoked by an administrator'
        });
      }

      // If rejected, permit re-submitting by setting status back to pending
      await docRef.update({
        status: 'pending',
        deviceModel: cleanModel || existing.deviceModel || '',
        manufacturer: cleanManufacturer || existing.manufacturer || '',
        fingerprint: cleanFingerprint || existing.fingerprint || '',
        androidVersion: cleanAndroidVersion || existing.androidVersion || '',
        playerName: cleanPlayerName || existing.playerName || '',
        userEmail: cleanEmail || existing.userEmail || '',
        uid: cleanUid || existing.uid || '',
        requestedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        rejectReason: '',
        rejectedAt: null,
        rejectedBy: ''
      });

      return res.json({
        success: true,
        approved: false,
        status: 'pending',
        message: 'Authorization request re-submitted for administrator review'
      });
    }

    // New request: create document
    const newRecord = {
      hwid: cleanHwid,
      uid: cleanUid,
      playerName: cleanPlayerName || 'Player',
      userEmail: cleanEmail,
      status: 'pending',
      isEmulator: true,
      deviceModel: cleanModel,
      manufacturer: cleanManufacturer,
      fingerprint: cleanFingerprint,
      androidVersion: cleanAndroidVersion,
      requestedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await docRef.set(newRecord);

    return res.json({
      success: true,
      approved: false,
      status: 'pending',
      message: 'Authorization request submitted successfully'
    });
  } catch (err) {
    console.error('[Emulator] Request submission failed:', err.message);
    return res.status(500).json({
      success: false,
      error: 'Failed to submit emulator authorization request'
    });
  }
});

// =============================================================================
// ADMIN ENDPOINTS (Requires authenticated Firebase ID token + isAdmin check)
// =============================================================================

/**
 * GET /api/admin/emulator-requests
 *
 * Retrieves emulator requests. Filterable by ?status=pending|approved|rejected|revoked|all
 */
router.get('/api/admin/emulator-requests', verifyAuth, async (req, res) => {
  try {
    const adminCheck = await isAdmin(req.user.uid);
    if (!adminCheck) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden. Administrator privileges required.'
      });
    }

    const filterStatus = String(req.query.status || 'all').toLowerCase();
    let query = firestore().collection('emulator_requests');

    if (filterStatus !== 'all' && ['pending', 'approved', 'rejected', 'revoked'].includes(filterStatus)) {
      query = query.where('status', '==', filterStatus);
    }

    const snapshots = await query.orderBy('requestedAt', 'desc').limit(150).get();
    const requests = [];

    for (const doc of snapshots.docs) {
      const data = doc.data();
      requests.push({
        hwid: doc.id,
        ...data,
        requestedAt: data.requestedAt?.toDate?.() || null,
        approvedAt: data.approvedAt?.toDate?.() || null,
        rejectedAt: data.rejectedAt?.toDate?.() || null,
        revokedAt: data.revokedAt?.toDate?.() || null,
        updatedAt: data.updatedAt?.toDate?.() || null
      });
    }

    return res.json({
      success: true,
      count: requests.length,
      requests
    });
  } catch (err) {
    console.error('[EmulatorAdmin] Failed to load requests:', err.message);
    return res.status(500).json({
      success: false,
      error: 'Failed to retrieve emulator requests'
    });
  }
});

/**
 * POST /api/admin/emulator-requests/:hwid/approve
 */
router.post('/api/admin/emulator-requests/:hwid/approve', verifyAuth, async (req, res) => {
  try {
    const adminCheck = await isAdmin(req.user.uid);
    if (!adminCheck) {
      return res.status(403).json({ success: false, error: 'Forbidden. Administrator privileges required.' });
    }

    const hwid = req.params.hwid;
    if (!isValidHwid(hwid)) {
      return res.status(400).json({ success: false, error: 'Invalid HWID parameter' });
    }

    const cleanHwid = hwid.trim();
    const docRef = firestore().collection('emulator_requests').doc(cleanHwid);
    const snap = await docRef.get();

    if (!snap.exists) {
      return res.status(404).json({ success: false, error: 'Emulator request not found' });
    }

    const existing = snap.data() || {};
    const oldStatus = existing.status || 'pending';

    await docRef.update({
      status: 'approved',
      approvedAt: admin.firestore.FieldValue.serverTimestamp(),
      approvedBy: req.user.uid,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await logAuditTranscript(
      'approved',
      'Emulator Approved',
      {
        hwid: cleanHwid,
        playerName: existing.playerName || '',
        userEmail: existing.userEmail || '',
        oldStatus,
        newStatus: 'approved'
      },
      req.user.uid,
      req.user.email
    );

    return res.json({
      success: true,
      message: `Emulator ${cleanHwid} has been approved`
    });
  } catch (err) {
    console.error('[EmulatorAdmin] Approve failed:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to approve emulator' });
  }
});

/**
 * POST /api/admin/emulator-requests/:hwid/reject
 */
router.post('/api/admin/emulator-requests/:hwid/reject', verifyAuth, async (req, res) => {
  try {
    const adminCheck = await isAdmin(req.user.uid);
    if (!adminCheck) {
      return res.status(403).json({ success: false, error: 'Forbidden. Administrator privileges required.' });
    }

    const hwid = req.params.hwid;
    if (!isValidHwid(hwid)) {
      return res.status(400).json({ success: false, error: 'Invalid HWID parameter' });
    }

    const cleanHwid = hwid.trim();
    const docRef = firestore().collection('emulator_requests').doc(cleanHwid);
    const snap = await docRef.get();

    if (!snap.exists) {
      return res.status(404).json({ success: false, error: 'Emulator request not found' });
    }

    const existing = snap.data() || {};
    const oldStatus = existing.status || 'pending';
    const rejectReason = typeof req.body?.rejectReason === 'string' ? req.body.rejectReason.trim().substring(0, 200) : '';

    await docRef.update({
      status: 'rejected',
      rejectedAt: admin.firestore.FieldValue.serverTimestamp(),
      rejectedBy: req.user.uid,
      rejectReason,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await logAuditTranscript(
      'rejected',
      'Emulator Request Rejected',
      {
        hwid: cleanHwid,
        playerName: existing.playerName || '',
        userEmail: existing.userEmail || '',
        oldStatus,
        newStatus: 'rejected',
        rejectReason
      },
      req.user.uid,
      req.user.email
    );

    return res.json({
      success: true,
      message: `Emulator ${cleanHwid} request rejected`
    });
  } catch (err) {
    console.error('[EmulatorAdmin] Reject failed:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to reject emulator request' });
  }
});

/**
 * POST /api/admin/emulator-requests/:hwid/revoke
 */
router.post('/api/admin/emulator-requests/:hwid/revoke', verifyAuth, async (req, res) => {
  try {
    const adminCheck = await isAdmin(req.user.uid);
    if (!adminCheck) {
      return res.status(403).json({ success: false, error: 'Forbidden. Administrator privileges required.' });
    }

    const hwid = req.params.hwid;
    if (!isValidHwid(hwid)) {
      return res.status(400).json({ success: false, error: 'Invalid HWID parameter' });
    }

    const cleanHwid = hwid.trim();
    const docRef = firestore().collection('emulator_requests').doc(cleanHwid);
    const snap = await docRef.get();

    if (!snap.exists) {
      return res.status(404).json({ success: false, error: 'Emulator request not found' });
    }

    const existing = snap.data() || {};
    const oldStatus = existing.status || 'approved';

    await docRef.update({
      status: 'revoked',
      revokedAt: admin.firestore.FieldValue.serverTimestamp(),
      revokedBy: req.user.uid,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await logAuditTranscript(
      'revoked',
      'Emulator Access Revoked',
      {
        hwid: cleanHwid,
        playerName: existing.playerName || '',
        userEmail: existing.userEmail || '',
        oldStatus,
        newStatus: 'revoked'
      },
      req.user.uid,
      req.user.email
    );

    return res.json({
      success: true,
      message: `Emulator ${cleanHwid} authorization revoked`
    });
  } catch (err) {
    console.error('[EmulatorAdmin] Revoke failed:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to revoke emulator access' });
  }
});

module.exports = router;
