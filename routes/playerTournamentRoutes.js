/**
 * Player tournament routes (mounted at /api/player/tournament).
 *
 *   POST /join-intent  { tournamentId, password }  – validate the password and open a join
 *
 * A player reads a tournament from Firestore; this route is the one thing a player cannot decide
 * locally, because deciding it locally is the same as not checking it. It answers with a permit the
 * join write needs, and it answers with nothing at all when the password is wrong - the money is
 * only ever spent by the join the app performs afterwards, so a wrong password costs nothing.
 *
 * The body never names an account: the player is the verified token. The password is read, compared
 * and dropped - it is not logged, not stored, and not returned.
 */

const express = require('express');
const admin = require('firebase-admin');
const { verifyAuth } = require('../middleware/auth');
const { createTournamentJoinIntents } = require('../services/tournamentJoinIntents');

function statusFor(code) {
  switch (code) {
    case 'PASSWORD_INCORRECT':
    case 'PASSWORD_REQUIRED':
    // A password that has to be guessed is refused the same way a wrong one is; the body says
    // which, so the app can show "too many attempts" instead of "wrong password".
    case 'TOO_MANY_ATTEMPTS':
      return 403;
    case 'ALREADY_JOINED':
      return 409;
    case 'TOURNAMENT_FULL':
      return 409;
    case 'TOURNAMENT_CLOSED':
      return 410;
    case 'TOURNAMENT_NOT_FOUND':
      return 404;
    default:
      return 400;
  }
}

function createPlayerTournamentRouter({
  authenticator = verifyAuth,
  joinIntents,
  database,
  serverTimestamp = () => admin.firestore.FieldValue.serverTimestamp()
} = {}) {
  const router = express.Router();

  const db = () => (database ? database() : admin.firestore());

  let intentService = joinIntents || null;

  function resolveIntents() {
    if (!intentService) {
      intentService = createTournamentJoinIntents({ db: db(), serverTimestamp });
    }
    return intentService;
  }

  router.post('/join-intent', authenticator, async (req, res) => {
    const body = req.body || {};

    try {
      const result = await resolveIntents().openIntent({
        playerUid: req.user.uid,
        tournamentId: body.tournamentId,
        password: typeof body.password === 'string' ? body.password : ''
      });

      if (result.code === 'COMPLETE') {
        return res.json({
          success: true,
          code: result.code,
          tournamentId: result.tournamentId,
          required: result.required === true,
          // `renewed` says the password was already proven for this match and only the permit's
          // clock was extended. It is reported rather than hidden because a screen may show a
          // different sentence for it, and because a client should be able to tell the two
          // successful answers apart.
          renewed: result.renewed === true,
          permit: result.permit || null
        });
      }

      return res.status(statusFor(result.code)).json({
        success: false,
        code: result.code,
        message: result.message,
        required: result.required === true,
        retryable: result.retryable === true
      });
    } catch (error) {
      // Never the submitted password, never the stored one.
      console.error('[PlayerTournament] Join intent failed:', error.message);
      return res.status(500).json({
        success: false,
        code: 'REQUEST_FAILED',
        message: 'The join could not be validated. Try again.',
        retryable: true
      });
    }
  });

  return router;
}

module.exports = createPlayerTournamentRouter();
module.exports.createPlayerTournamentRouter = createPlayerTournamentRouter;
module.exports.statusFor = statusFor;
