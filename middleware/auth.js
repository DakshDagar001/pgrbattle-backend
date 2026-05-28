/**
 * Firebase Auth Middleware
 *
 * Verifies Firebase ID tokens from the Authorization header.
 * Attaches decoded user info (uid, email) to req.user on success.
 */

const admin = require('firebase-admin');

/**
 * Express middleware that verifies a Firebase ID token.
 *
 * Expects header:  Authorization: Bearer <idToken>
 * On success:      req.user = { uid, email }
 * On failure:      401 JSON response
 */
async function verifyAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      console.warn('[Auth] Missing or malformed Authorization header');
      return res.status(401).json({
        success: false,
        error: 'Missing or malformed Authorization header. Expected: Bearer <idToken>'
      });
    }

    const idToken = authHeader.split('Bearer ')[1];

    if (!idToken || !idToken.trim()) {
      console.warn('[Auth] Empty token after Bearer prefix');
      return res.status(401).json({
        success: false,
        error: 'Empty authentication token'
      });
    }

    const decodedToken = await admin.auth().verifyIdToken(idToken);

    req.user = {
      uid: decodedToken.uid,
      email: decodedToken.email || null
    };

    next();
  } catch (err) {
    console.error('[Auth] Token verification failed:', err.code || err.message);

    // Provide specific messages for common Firebase auth errors
    let message = 'Invalid or expired authentication token';

    if (err.code === 'auth/id-token-expired') {
      message = 'Authentication token has expired. Please sign in again.';
    } else if (err.code === 'auth/id-token-revoked') {
      message = 'Authentication token has been revoked. Please sign in again.';
    } else if (err.code === 'auth/argument-error') {
      message = 'Malformed authentication token';
    }

    return res.status(401).json({
      success: false,
      error: message
    });
  }
}

module.exports = { verifyAuth };
