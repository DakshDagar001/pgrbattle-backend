require("dotenv").config();

const express = require("express");
const axios = require("axios");
const admin = require("firebase-admin");
const cors = require("cors");
const cron = require("node-cron");

const app = express();

/* ===============================
   MIDDLEWARE
================================*/
app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
  console.log("Incoming request:", req.method, req.url);
  next();
});

/* ===============================
   FCM NOTIFICATION SETUP
================================*/
// Environment configuration for FCM is handled via FIREBASE_SERVICE_ACCOUNT

/* ===============================
   FIREBASE INIT
================================*/
let serviceAccount;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    console.log('Firebase: Using env FIREBASE_SERVICE_ACCOUNT');
  } else {
    serviceAccount = require('./serviceAccount.json');
    console.log('Firebase: Using local serviceAccount.json');
  }
} catch (err) {
  console.error('Firebase init failed:', err.message);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL || 'https://pgr-battle-default-rtdb.firebaseio.com'
});

const db = admin.firestore();
const rtdb = admin.database();

/* ===============================
   DEPOSIT SYSTEM INIT
================================*/
const { initGmail } = require('./services/gmailService');
const { initVerifier } = require('./services/depositVerifier');
const { notifyUser, notifyTournament } = require('./services/notificationEngine');
const depositRoutes = require('./routes/depositRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const { initRoomTriggers } = require('./services/tournamentTriggers');

// Initialise Gmail API and deposit verifier
try {
  initGmail();
  console.log('Gmail service initialised');
} catch (err) {
  console.error('Gmail init failed (deposits will not auto-verify):', err.message);
}
initVerifier(notifyUser);

// Mount routes
app.use('/api/deposit', depositRoutes);
app.use('/', notificationRoutes);

// Initialize triggers
initRoomTriggers();



/* ===============================
   HEALTH ENDPOINT
================================*/
app.get("/health", (_, res) => res.send("OK"));

/* ===============================
   TOURNAMENT REMINDERS
================================*/
async function checkTournamentReminders() {
  const now = new Date();
  const offsets = [60, 30, 5];

  for (const offset of offsets) {
    const future = new Date(now.getTime() + offset * 60000);

    const snap = await db.collection("tournaments")
      .where("startTime", ">=", now)
      .where("startTime", "<=", future)
      .get();

    for (const doc of snap.docs) {
      const data = doc.data();

      if (data.reminderSent?.includes(offset)) continue;

      await notifyTournament(
        doc.id,
        "Tournament Reminder",
        `${data.name} starts in ${offset} minutes`,
        { type: "tournament_reminder" }
      );

      await db.collection("tournaments").doc(doc.id).update({
        reminderSent: admin.firestore.FieldValue.arrayUnion(offset)
      });
    }
  }
}

/* ===============================
   START SERVER
================================*/
async function startServer() {

  // Schedules are now initialized in notificationRoutes.js

  cron.schedule("*/5 * * * *", checkTournamentReminders);

  const PORT = process.env.PORT || 8080;

  const server = app.listen(PORT, () =>
    console.log("Server running on", PORT)
  );

  // Graceful shutdown
  process.on('SIGTERM', () => {
    console.log('SIGTERM received – shutting down gracefully');
    server.close(() => process.exit(0));
  });
}

startServer();

/* =============================== */
app.get("/", (_, res) =>
  res.send("PGR Battle API Running 🚀")
);
