/**
 * Authentication support routes (mounted at /api/auth).
 *
 *   GET  /username-availability  – authoritative pre-signup lookup (rate limited)
 *   POST /claim-username         – atomic reservation for a signed-up uid
 *   POST /release-username       – roll back a reservation that never completed
 *   POST /assign-region          – server-authoritative region assignment
 *
 * There is deliberately NO phone/password login endpoint: Firebase phone
 * credentials require an SMS verification factor, which is not enabled.
 */

const express = require('express');
const admin = require('firebase-admin');
const { verifyAuth } = require('../middleware/auth');
const {
  regionForPhone,
  normalizeUsername,
  isValidUsername
} = require('../services/authPolicy');
const { createUsernameRegistry } = require('../services/usernameRegistry');

/** In-memory sliding window limiter, mirroring the emulator routes. */
function createRateLimiter(windowMs = 600000) {
  const hits = new Map();

  function allowed(key, limit, window) {
    const now = Date.now();
    const recent = (hits.get(key) || []).filter(time => now - time < window);
    if (recent.length >= limit) {
      hits.set(key, recent);
      return false;
    }
    recent.push(now);
    hits.set(key, recent);
    return true;
  }

  function sweep() {
    const now = Date.now();
    for (const [key, timestamps] of hits.entries()) {
      const valid = timestamps.filter(time => now - time < windowMs);
      if (valid.length === 0) hits.delete(key);
      else hits.set(key, valid);
    }
  }

  const timer = setInterval(sweep, 600000);
  if (typeof timer.unref === 'function') timer.unref();

  return { allowed, hits };
}

function clientIp(req) {
  return req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
}

function createAuthRouter({
  firestore = () => admin.firestore(),
  serverTimestamp = () => admin.firestore.FieldValue.serverTimestamp(),
  authenticator = verifyAuth,
  limiter = createRateLimiter()
} = {}) {
  const router = express.Router();
  const registry = createUsernameRegistry({
    db: {
      collection: name => firestore().collection(name)
    },
    serverTimestamp
  });

  // ==========================================================================
  // GET /username-availability?username=...
  // Public because the signup screen needs it before any credentials exist.
  // Discards everything except a boolean, and never reports "available" on error.
  // ==========================================================================
  router.get('/username-availability', async (req, res) => {
    try {
      if (!limiter.allowed(`availability_${clientIp(req)}`, 30, 60000)) {
        return res.status(429).json({
          success: false,
          message: 'Too many availability checks. Please wait a moment.'
        });
      }

      const normalized = normalizeUsername(req.query.username);
      if (!isValidUsername(normalized)) {
        return res.status(400).json({
          success: false,
          message: 'Username must be 3-20 letters, numbers or underscores.'
        });
      }

      const result = await registry.availability(normalized);
      return res.json({ success: true, available: result.available, username: result.normalized });
    } catch (error) {
      console.error('[Auth] Username availability check failed:', error.message);
      return res.status(500).json({ success: false, message: 'Unable to verify username right now.' });
    }
  });

  // ==========================================================================
  // POST /claim-username  { username }
  // Authenticated. Atomic: only one concurrent caller can win a normalized name.
  // ==========================================================================
  router.post('/claim-username', authenticator, async (req, res) => {
    try {
      if (!limiter.allowed(`claim_${req.user.uid}`, 20, 600000)) {
        return res.status(429).json({ success: false, message: 'Too many claims. Please contact support.' });
      }

      const normalized = normalizeUsername(req.body && req.body.username);
      if (!isValidUsername(normalized)) {
        return res.status(400).json({
          success: false,
          message: 'Username must be 3-20 letters, numbers or underscores.'
        });
      }

      const claim = await registry.claim(req.user.uid, normalized);
      if (claim.ok) {
        return res.status(201).json({ success: true, username: claim.normalized });
      }
      if (claim.reason === 'OWNED') {
        // Idempotent retry from the same account (e.g. after a dropped response).
        return res.json({ success: true, username: claim.normalized });
      }
      if (claim.reason === 'INVALID') {
        return res.status(400).json({ success: false, message: 'Username format is invalid.' });
      }
      return res.status(409).json({ success: false, message: 'Username already taken.' });
    } catch (error) {
      console.error('[Auth] Username claim failed:', error.message);
      return res.status(500).json({ success: false, message: 'Unable to reserve username right now.' });
    }
  });

  // ==========================================================================
  // POST /release-username  { username }
  // Authenticated compensation path for a signup that failed after claiming.
  // Refuses to touch a name whose owner already has a profile.
  // ==========================================================================
  router.post('/release-username', authenticator, async (req, res) => {
    try {
      const normalized = normalizeUsername(req.body && req.body.username);
      if (!isValidUsername(normalized)) {
        return res.status(400).json({ success: false, message: 'Username format is invalid.' });
      }

      const result = await registry.release(req.user.uid, normalized);
      if (!result.ok) {
        const status = result.reason === 'NOT_OWNER' ? 403 : 409;
        return res.status(status).json({ success: false, message: 'Unable to release username.' });
      }
      return res.json({ success: true, released: result.released });
    } catch (error) {
      console.error('[Auth] Username release failed:', error.message);
      return res.status(500).json({ success: false, message: 'Unable to release username right now.' });
    }
  });

  // ==========================================================================
  // POST /assign-region
  // Authenticated and server-controlled: the region comes exclusively from the
  // phone number on the verified ID token. The request body is never consulted.
  // ==========================================================================
  router.post('/assign-region', authenticator, async (req, res) => {
    const assignment = regionForPhone(req.user.phoneNumber);
    if (!assignment) {
      return res.status(400).json({ success: false, message: 'A supported verified phone number is required.' });
    }

    try {
      const db = firestore();
      const userRef = db.collection('users').doc(req.user.uid);
      const phoneRef = db.collection('phoneNumbers').doc(req.user.phoneNumber);
      await db.runTransaction(async transaction => {
        const [phoneSnapshot, userSnapshot] = await Promise.all([
          transaction.get(phoneRef),
          transaction.get(userRef)
        ]);

        if (phoneSnapshot.exists && phoneSnapshot.data().uid !== req.user.uid) {
          const error = new Error('PHONE_ALREADY_ASSIGNED');
          error.code = 'PHONE_ALREADY_ASSIGNED';
          throw error;
        }

        // A region that already exists on the account is final. Repeated calls
        // may confirm it, never move the account to another region.
        const currentRegion = userSnapshot.exists
          ? (userSnapshot.data().phoneRegion || '')
          : '';
        if (currentRegion && currentRegion !== assignment.region) {
          const error = new Error('REGION_ALREADY_ASSIGNED');
          error.code = 'REGION_ALREADY_ASSIGNED';
          error.region = currentRegion;
          throw error;
        }

        transaction.set(phoneRef, {
          uid: req.user.uid,
          phoneNumber: req.user.phoneNumber,
          region: assignment.region,
          createdAt: phoneSnapshot.exists
            ? phoneSnapshot.data().createdAt
            : serverTimestamp()
        }, { merge: true });

        transaction.set(userRef, {
          phone: req.user.phoneNumber,
          phoneVerified: true,
          phoneRegion: assignment.region
        }, { merge: true });
      });
      return res.json({ success: true, region: assignment.region });
    } catch (error) {
      if (error.code === 'PHONE_ALREADY_ASSIGNED') {
        return res.status(409).json({ success: false, message: 'That phone number is already registered.' });
      }
      if (error.code === 'REGION_ALREADY_ASSIGNED') {
        return res.status(409).json({ success: false, message: 'Account region is already assigned.' });
      }
      console.error('[Auth] Region assignment failed:', error.message);
      return res.status(500).json({ success: false, message: 'Unable to assign account region.' });
    }
  });

  return router;
}

module.exports = createAuthRouter();
module.exports.createAuthRouter = createAuthRouter;
module.exports.createRateLimiter = createRateLimiter;
