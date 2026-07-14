require("dotenv").config();
const { validateEnv } = require('./config/envValidator');

// Validate environment before proceeding
validateEnv();

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
  serviceAccount = {
    type: "service_account",
    project_id: process.env.FIREBASE_PROJECT_ID,
    private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
    private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
    client_id: process.env.FIREBASE_CLIENT_ID,
    auth_uri: "https://accounts.google.com/o/oauth2/auth",
    token_uri: "https://oauth2.googleapis.com/token",
    auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
    client_x509_cert_url: `https://www.googleapis.com/robot/v1/metadata/x509/${encodeURIComponent(process.env.FIREBASE_CLIENT_EMAIL)}`
  };

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL
  });
  console.log('✓ Firebase initialized');
} catch (err) {
  console.error('Firebase init failed:', err.message);
  process.exit(1);
}

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
  console.log('✓ Gmail initialized');
} catch (err) {
  console.error('Gmail init failed (deposits will not auto-verify):', err.message);
}

try {
  initVerifier(notifyUser);
  console.log('✓ Deposit Verifier initialized');
} catch (err) {
  console.error('Deposit Verifier init failed:', err.message);
}

// Mount routes
try {
  app.use('/api/deposit', depositRoutes);
  app.use('/', notificationRoutes);
  console.log('✓ Express Routes loaded');
} catch (err) {
  console.error('Route mounting failed:', err.message);
}

// Initialize triggers
initRoomTriggers();



/* ===============================
   HEALTH & ROOT ENDPOINTS
================================*/
app.get("/health", (_, res) => {
  res.json({
    status: "healthy",
    version: "1.0.0",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || "development",
    services: {
      firebase: admin.apps.length > 0 ? "connected" : "disconnected",
      firestore: "connected",
      rtdb: "connected",
      gmail: "initialized",
      notifications: "initialized"
    }
  });
});

app.get("/", (_, res) => {
  res.json({
    project: "PGR Battle",
    version: "1.0.0",
    environment: process.env.NODE_ENV || "development",
    status: "running"
  });
});

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

  const server = app.listen(PORT, () => {
    console.log("✓ Server listening on port", PORT);
  });

  // Graceful shutdown
  process.on('SIGTERM', () => {
    console.log('SIGTERM received – shutting down gracefully');
    server.close(() => process.exit(0));
  });
}

try {
  startServer();
} catch (err) {
  console.error('Failed to start server:', err.message);
}
