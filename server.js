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
const depositRoutes = require('./routes/depositRoutes');

// Initialise Gmail API and deposit verifier
try {
  initGmail();
  console.log('Gmail service initialised');
} catch (err) {
  console.error('Gmail init failed (deposits will not auto-verify):', err.message);
}
initVerifier(sendPushNotification);

// Mount deposit routes
app.use('/api/deposit', depositRoutes);

/* ===============================
   GLOBAL JOB STORAGE
================================*/
const scheduledJobs = new Map();

/* ===============================
   SAFE ONE SIGNAL PUSH
================================*/
async function sendPushNotification(playerIds, title, message, metadata = {}) {
  try {
    if (!playerIds || !playerIds.length) {
      return { success: true, sentTo: 0 };
    }

    const response = await axios.post(
      "https://api.onesignal.com/notifications",
      {
        app_id: process.env.ONESIGNAL_APP_ID,
        include_subscription_ids: playerIds,
        headings: { en: title },
        contents: { en: message },
        data: metadata
      },
      {
        timeout: 8000,
        headers: {
          Authorization: `Basic ${process.env.ONESIGNAL_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    console.log("OneSignal:", response.data);

    return {
      success: true,
      sentTo: playerIds.length
    };

  } catch (err) {
    console.error("Push error:", err.response?.data || err.message);
    return { success: false };
  }
}

/* ===============================
   LOG HISTORY
================================*/
async function logHistory(title, message, type, tournamentId, count) {
  try {
    await db.collection("notificationHistory").add({
      title,
      message,
      type,
      tournamentId,
      targetCount: count,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (e) {
    console.error("History log error:", e);
  }
}

/* ===============================
   ARRAY CHUNK UTILITY
================================*/
function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/* ===============================
   FIRESTORE IN LIMIT FIX
================================*/
async function getUsersPlayerIds(userIds) {

  const chunks = chunkArray(userIds, 10);
  const playerIds = [];

  for (const chunk of chunks) {
    const snap = await db.collection("users")
      .where(admin.firestore.FieldPath.documentId(), "in", chunk)
      .get();

    snap.forEach(doc => {
      const data = doc.data();
      if (data.playerId) {
        playerIds.push(data.playerId);
      }
    });
  }

  return playerIds;
}

/* ===============================
   TOURNAMENT PARTICIPANTS
================================*/
async function getTournamentParticipants(tournamentId) {

  const participants = await db
    .collection("tournaments")
    .doc(tournamentId)
    .collection("participants")
    .get();

  const userIds = participants.docs.map(d => d.id);

  if (!userIds.length) return [];

  return await getUsersPlayerIds(userIds);
}

/* ===============================
   HEALTH ENDPOINT
================================*/
app.get("/health", (_, res) => res.send("OK"));

/* ===============================
   SEND NOTIFICATION
================================*/
app.post("/sendNotification", async (req, res) => {

  try {

    const {
      title,
      message,
      type,
      selectedUsers = [],
      tournamentId = null
    } = req.body;

    if (!title || !message) {
      return res.status(400).json({
        success: false,
        error: "Missing data"
      });
    }

    let playerIds = [];

    if (type === "all") {

      const users = await db.collection("users").get();

      users.forEach(d => {
        if (d.data().playerId) {
          playerIds.push(d.data().playerId);
        }
      });

    }

    if (type === "selected") {
      playerIds = await getUsersPlayerIds(selectedUsers);
    }

    if (type === "tournament") {

      if (!tournamentId) {
        return res.status(400).json({
          success: false,
          error: "Tournament ID required"
        });
      }

      playerIds = await getTournamentParticipants(tournamentId);
    }

    const result = await sendPushNotification(
      playerIds,
      title,
      message,
      { type, tournamentId }
    );

    await logHistory(title, message, type, tournamentId, result.sentTo);

    res.json(result);

  } catch (e) {

    console.error(e);

    res.status(500).json({
      success: false,
      error: "Notification failed"
    });

  }

});

/* ===============================
   CHAT MESSAGE NOTIFICATION
================================*/
app.post("/chatNotification", async (req, res) => {

  try {

    const { receiverUserId, senderName, messagePreview } = req.body;

    if (!receiverUserId) {
      return res.status(400).json({
        success: false,
        error: "Missing receiverUserId"
      });
    }

    const userDoc = await db.collection("users").doc(receiverUserId).get();

    if (!userDoc.exists) {
      return res.status(404).json({
        success: false,
        error: "User not found"
      });
    }

    const playerId = userDoc.data().playerId;

    if (!playerId) {
      return res.json({
        success: true,
        sentTo: 0
      });
    }

    const title = senderName || "New Message";
    const message = messagePreview || "You received a new message";

    const result = await sendPushNotification(
      [playerId],
      title,
      message,
      { type: "chat_message" }
    );

    res.json(result);

  } catch (e) {

    console.error("Chat notification error:", e);

    res.status(500).json({
      success: false
    });

  }

});

/* ===============================
   SCHEDULE NOTIFICATION
================================*/
app.post("/scheduleNotification", async (req, res) => {

  try {

    const {
      title,
      message,
      type,
      selectedUsers,
      tournamentId,
      scheduleConfig
    } = req.body;

    const ref = await db.collection("scheduledNotifications").add({
      title,
      message,
      type,
      selectedUsers,
      tournamentId,
      scheduleConfig,
      isActive: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await createScheduledJob(ref.id, req.body);

    res.json({
      success: true,
      scheduleId: ref.id
    });

  } catch (e) {

    console.error(e);

    res.status(500).json({
      success: false
    });

  }

});

/* ===============================
   CRON CREATION
================================*/
async function createScheduledJob(id, data) {

  try {

    const { scheduleConfig } = data;

    if (!scheduleConfig) {
      console.log("Missing scheduleConfig for:", id);
      return;
    }

    let cronExp;

    if (
      scheduleConfig.scheduleType === "daily" &&
      scheduleConfig.time
    ) {

      const [h, m] = scheduleConfig.time.split(":");

      cronExp = `${m} ${h} * * *`;
    }

    if (!cronExp) {
      console.log("Invalid cron expression for:", id);
      return;
    }

    if (scheduledJobs.has(id)) {
      scheduledJobs.get(id).stop();
    }

    const job = cron.schedule(cronExp, async () => {

      console.log("Running scheduled job:", id);

      await axios.post(
        `${process.env.API_URL}/sendNotification`,
        data
      );

    });

    scheduledJobs.set(id, job);

  } catch (e) {

    console.error("Scheduled job error:", e);

  }

}

/* ===============================
   LOAD JOBS ON START
================================*/
async function loadScheduledJobs() {

  const snap = await db.collection("scheduledNotifications")
    .where("isActive", "==", true)
    .get();

  for (const doc of snap.docs) {
    await createScheduledJob(doc.id, doc.data());
  }

  console.log("Loaded schedules:", snap.size);
}

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

      const playerIds = await getTournamentParticipants(doc.id);

      await sendPushNotification(
        playerIds,
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

/* Old gmail stub removed – replaced by services/gmailService.js */

/* ===============================
   START SERVER
================================*/
async function startServer() {

  await loadScheduledJobs();

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
