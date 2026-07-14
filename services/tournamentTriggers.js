const admin = require('firebase-admin');
const { notifyTournament, notifyAll } = require('./notificationEngine');

/**
 * Initializes listeners for tournament changes to automatically dispatch notifications.
 */
function initTournamentTriggers() {
  const db = admin.firestore();

  // Listen for changes to active tournaments
  db.collection('tournaments')
    .where('status', 'in', ['upcoming', 'ongoing'])
    .onSnapshot((snapshot) => {
      snapshot.docChanges().forEach(async (change) => {
        const data = change.doc.data();
        const docId = change.doc.id;

        if (change.type === 'added') {
          // You could optionally notify all users about a new tournament here,
          // but usually that's done manually or via a promo.
          // If the requirement is "backend triggers for Tournaments", this might be it.
          // We check if it was created within the last 5 minutes to avoid spamming on restart.
          const now = Date.now();
          const createdAt = data.createdAt ? data.createdAt.toDate().getTime() : 0;
          if (now - createdAt < 5 * 60 * 1000) {
            console.log(`[Triggers] New tournament created: ${data.name}`);
            // Uncomment to notify all on new tournament
            // await notifyAll("New Tournament!", `Join ${data.name} now!`, { deepLink: `pgr://tournament/${docId}` });
          }
        }

        if (change.type === 'modified') {
          const oldData = change.doc._oldData || {}; // We don't get oldData in client SDKs, but this is a rough approximation if we cache, wait...
          // Actually, Firebase Admin SDK docChanges doesn't provide oldData in onSnapshot directly.
          // So we should track known room details in memory to detect changes.
        }
      });
    }, (error) => {
      console.error("[Triggers] Error listening to tournaments:", error);
    });
}

// Since Admin SDK onSnapshot doesn't provide previous data easily, 
// let's implement a simpler state machine for Room ID / Pass.
const knownRooms = new Map();

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
          
          await notifyTournament(
            docId,
            "Room Details Updated",
            `Room ID and Password for ${data.name} have been updated. Tap to view.`,
            { 
              type: "room_update",
              deepLink: `pgr://tournament/${docId}`
            }
          );
          
          // Update known state
          knownRooms.set(docId, { roomId: currentRoomId, roomPass: currentRoomPass });
        }
      });
    });
}

module.exports = {
  initRoomTriggers
};
