const admin = require('firebase-admin');
const { notifyByEvent } = require('./notificationEngine');

// We implement a simpler state machine for Room ID / Pass.
const knownRooms = new Map();
const knownTournamentStatus = new Map();
const knownPrizeIssued = new Map();

async function claimEvent(id) {
  try {
    await admin.firestore().collection('notificationEventClaims').doc(id).create({
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return true;
  } catch (error) {
    // ALREADY_EXISTS means this event was already delivered, including after a
    // Render restart or multiple slots being joined at once.
    if (error.code === 6 || error.code === 'already-exists') return false;
    throw error;
  }
}

async function participantUserIds(tournamentId) {
  const snap = await admin.firestore().collection('tournaments').doc(tournamentId)
    .collection('participants').get();
  return [...new Set(snap.docs.map(doc => doc.get('odcUid')).filter(Boolean))];
}

function initRoomTriggers() {
  const db = admin.firestore();
  
  db.collection('tournaments')
    .where('status', 'in', ['upcoming', 'ongoing'])
    .onSnapshot((snapshot) => {
      snapshot.forEach(async (doc) => {
        const data = doc.data();
        const docId = doc.id;
        
        const currentRoomId = data.roomId || "";
        const currentRoomPass = data.roomPassword || "";
        
        const previousState = knownRooms.get(docId);
        
        // If this is the first time we see this tournament, just store the state
        if (!previousState) {
          knownRooms.set(docId, { roomId: currentRoomId, roomPass: currentRoomPass });
          return;
        }
        
        // Check if room details changed
        const roomChanged = currentRoomId !== previousState.roomId || currentRoomPass !== previousState.roomPass;
        
        // Only notify if there are actual room details (not both empty)
        if (roomChanged && (currentRoomId || currentRoomPass)) {
          console.log(`[Triggers] Room details updated for tournament ${docId}`);
          
          // Determine if this is the first upload or an update
          const isFirstUpload = (!previousState.roomId && !previousState.roomPass);
          const eventKey = isFirstUpload ? 'room_uploaded' : 'room_updated';
          
          await notifyByEvent(
            eventKey,
            'tournament',
            docId,
            { 
              TOURNAMENT_NAME: data.name || 'Tournament',
              ROOM_ID: currentRoomId,
              ROOM_PASS: currentRoomPass,
              deepLink: `pgr://tournament/${docId}`
            },
            {
              title: isFirstUpload ? "Room Details Uploaded!" : "Room Details Updated",
              body: isFirstUpload ? `Room ID and Password for {{TOURNAMENT_NAME}} are now available. Tap to view.` : `Room ID and Password for {{TOURNAMENT_NAME}} have been updated. Tap to view.`
            }
          );
          
          // Update known state
          knownRooms.set(docId, { roomId: currentRoomId, roomPass: currentRoomPass });
        }
      });
    });
}

function initTournamentNotificationTriggers() {
  const db = admin.firestore();
  let participantsInitialized = false;

  db.collection('tournaments').onSnapshot(snapshot => {
    snapshot.docChanges().forEach(async change => {
      const tournament = change.doc.data();
      const tournamentId = change.doc.id;
      const status = String(tournament.status || '').toLowerCase();

      if (change.type === 'added') {
        knownTournamentStatus.set(tournamentId, status);
        return;
      }

      const previousStatus = knownTournamentStatus.get(tournamentId);
      knownTournamentStatus.set(tournamentId, status);
      if (previousStatus === status) return;

      const eventKey = status === 'ongoing' ? 'tournament_starting'
        : status === 'cancelled' ? 'tournament_cancelled' : null;
      if (!eventKey || !(await claimEvent(`${eventKey}_${tournamentId}`))) return;

      await notifyByEvent(eventKey, 'users', await participantUserIds(tournamentId), {
        TOURNAMENT_NAME: tournament.name || 'Tournament',
        deepLink: `pgr://tournament/${tournamentId}`
      }, {
        title: status === 'ongoing' ? 'Tournament Starting' : 'Tournament Cancelled',
        body: status === 'ongoing' ? '{{TOURNAMENT_NAME}} is starting now.' : '{{TOURNAMENT_NAME}} has been cancelled.'
      });
    });
  });

  db.collectionGroup('participants').onSnapshot(snapshot => {
    const isInitialSnapshot = !participantsInitialized;
    snapshot.docChanges().forEach(async change => {
      const participant = change.doc.data();
      const tournamentRef = change.doc.ref.parent.parent;
      if (!tournamentRef) return;
      const tournamentId = tournamentRef.id;

      if (change.type === 'added') {
        knownPrizeIssued.set(change.doc.id, Boolean(participant.odcPrizeIssued));
        if (isInitialSnapshot) return;
        // Added records after the listener is established are genuine joins.
        // Claiming by tournament/user prevents a multi-slot join from sending twice.
        if (!(await claimEvent(`tournament_joined_${tournamentId}_${participant.odcUid}`))) return;
        const tournament = await tournamentRef.get();
        await notifyByEvent('tournament_joined', 'user', participant.odcUid, {
          TOURNAMENT_NAME: tournament.get('name') || 'Tournament',
          deepLink: `pgr://tournament/${tournamentId}`
        }, { title: 'Tournament Joined', body: 'You have joined {{TOURNAMENT_NAME}}.' });
        return;
      }

      const wasIssued = knownPrizeIssued.get(change.doc.id) === true;
      const isIssued = Boolean(participant.odcPrizeIssued);
      knownPrizeIssued.set(change.doc.id, isIssued);
      if (wasIssued || !isIssued || !(await claimEvent(`prize_credited_${tournamentId}_${change.doc.id}`))) return;
      const tournament = await tournamentRef.get();
      await notifyByEvent('prize_credited', 'user', participant.odcUid, {
        TOURNAMENT_NAME: tournament.get('name') || 'Tournament',
        PRIZE: participant.odcPrizeWon || 0,
        deepLink: `pgr://tournament/${tournamentId}`
      }, { title: 'Prize Credited', body: '₹{{PRIZE}} from {{TOURNAMENT_NAME}} has been credited.' });
    });
    participantsInitialized = true;
  });
}

// The completion milestone as the reward service reads it, tracked per match so only the
// false -> true transition is acted on.
const knownPrizesDistributed = new Map();

/**
 * Pays the organizer reward when a match's results are finalised.
 *
 * `prizesDistributed` is written by the results transaction in both apps' results screen, in the
 * same transaction that pays the players, so it is the one signal that means "finished and
 * settled" rather than "a status string changed". The listener acts on the transition only: an
 * initial snapshot seeds the map without paying, which is what keeps a restart from mass-crediting
 * every match completed before it. Everything the listener misses is picked up by the bounded
 * catch-up pass the cron runs, and both paths share the ledger key, so neither can pay twice.
 */
function initOrganizerRewardTriggers(rewards) {
  if (!rewards) return;
  const db = admin.firestore();

  db.collection('tournaments').onSnapshot(snapshot => {
    snapshot.docChanges().forEach(async change => {
      const tournamentId = change.doc.id;
      const data = change.doc.data() || {};
      const distributed = data.prizesDistributed === true;
      const previous = knownPrizesDistributed.get(tournamentId);
      knownPrizesDistributed.set(tournamentId, distributed);

      // A deleted match is forgotten rather than paid, and an initial `added` is only seeded.
      if (change.type === 'removed') {
        knownPrizesDistributed.delete(tournamentId);
        return;
      }
      if (change.type === 'added') return;
      if (!distributed || previous === true) return;

      try {
        const result = await rewards.grantForTournament({ tournamentId });
        if (result.code !== 'NOT_COMPLETED') {
          console.log('[Triggers] Reward for', tournamentId, '->', result.code,
            result.organizerUid || '', result.amount || '');
        }
      } catch (error) {
        // The catch-up pass will reach the same match, and the ledger key keeps that safe.
        console.error('[Triggers] Reward for', tournamentId, 'failed:', error.message);
      }
    });
  });
}

module.exports = {
  initRoomTriggers,
  initTournamentNotificationTriggers,
  initOrganizerRewardTriggers
};
