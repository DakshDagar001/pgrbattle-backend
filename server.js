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
   ONESIGNAL ENV VALIDATION
================================*/
if (!process.env.ONESIGNAL_APP_ID) {
  console.error("⚠️  WARNING: ONESIGNAL_APP_ID environment variable is NOT set. Push notifications will fail.");
}
if (!process.env.ONESIGNAL_API_KEY) {
  console.error("⚠️  WARNING: ONESIGNAL_API_KEY environment variable is NOT set. Push notifications will fail.");
} else {
  console.log("OneSignal: API key loaded (" + process.env.ONESIGNAL_API_KEY.substring(0, 12) + "...)");
}

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
   NOTIFICATION HELPERS
================================*/
function normalizeErrorMessage(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(normalizeErrorMessage).filter(Boolean).join("; ");
  if (typeof value === "object") {
    if (value.message) return normalizeErrorMessage(value.message);
    return Object.entries(value)
      .map(([key, val]) => `${key}: ${normalizeErrorMessage(val) || JSON.stringify(val)}`)
      .join("; ");
  }
  return String(value);
}

function oneSignalResponseError(data) {
  if (!data) return "Empty OneSignal response";

  const details = [];
  const errors = normalizeErrorMessage(data.errors);
  const warnings = normalizeErrorMessage(data.warnings);
  const invalidPlayerIds = normalizeErrorMessage(data.invalid_player_ids);
  const invalidSubscriptionIds = normalizeErrorMessage(data.invalid_subscription_ids);

  if (errors) details.push(errors);
  if (warnings) details.push(`Warnings: ${warnings}`);
  if (invalidPlayerIds) details.push(`Invalid player IDs: ${invalidPlayerIds}`);
  if (invalidSubscriptionIds) details.push(`Invalid subscription IDs: ${invalidSubscriptionIds}`);

  return details.join("; ");
}

function getOneSignalAuthorizationHeader(apiKey) {
  const trimmedKey = String(apiKey || "").trim();
  if (/^(Basic|Key|Bearer)\s+/i.test(trimmedKey)) {
    return trimmedKey;
  }
  return trimmedKey.startsWith("os_v2_")
    ? `Key ${trimmedKey}`
    : `Basic ${trimmedKey}`;
}

function formatTimestamp(value) {
  if (!value) return null;
  if (value.toDate) return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function weekdayToCronValue(weekday) {
  const days = {
    sunday: 0,
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6
  };
  return days[String(weekday).toLowerCase()];
}

function parseScheduleDateTime(dateTime) {
  const value = String(dateTime || "").trim();
  if (!value) return new Date(NaN);
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(value)) return new Date(value);
  return new Date(`${value}${process.env.NOTIFICATION_UTC_OFFSET || "+05:30"}`);
}

async function collectFcmTokens(collectionName) {
  const snap = await db.collection(collectionName).get();
  const tokens = [];

  snap.forEach(doc => {
    const token = doc.data().fcmToken;
    if (typeof token === "string" && token.trim()) {
      tokens.push(token.trim());
    }
  });

  return tokens;
}

async function sendFcmNotification(tokens, title, body, data = {}) {
  const uniqueTokens = [...new Set((tokens || []).filter(Boolean))];

  if (!uniqueTokens.length) {
    return {
      success: false,
      sentTo: 0,
      error: "No FCM tokens found for the requested recipients"
    };
  }

  let successCount = 0;
  let failureCount = 0;
  const errors = [];

  for (const tokenChunk of chunkArray(uniqueTokens, 500)) {
    const response = await admin.messaging().sendEachForMulticast({
      tokens: tokenChunk,
      notification: { title, body },
      data: Object.fromEntries(
        Object.entries(data).map(([key, value]) => [key, String(value ?? "")])
      ),
      android: {
        priority: "high",
        notification: {
          channelId: "pgr_battle_notifications"
        }
      }
    });

    successCount += response.successCount;
    failureCount += response.failureCount;

    response.responses.forEach((item, index) => {
      if (!item.success) {
        errors.push(`${tokenChunk[index]}: ${item.error?.message || "Unknown FCM error"}`);
      }
    });
  }

  return {
    success: successCount > 0,
    sentTo: successCount,
    failed: failureCount,
    error: successCount > 0 ? null : (errors[0] || "FCM failed for every recipient"),
    errors: errors.slice(0, 10)
  };
}

async function sendPushNotification(playerIds, title, message, metadata = {}) {
  try {
    if (!playerIds || !playerIds.length) {
      return {
        success: false,
        sentTo: 0,
        error: "No OneSignal subscription IDs found for the selected recipients"
      };
    }

    if (!process.env.ONESIGNAL_APP_ID) {
      return { success: false, sentTo: 0, error: "ONESIGNAL_APP_ID is not configured" };
    }

    if (!process.env.ONESIGNAL_API_KEY) {
      return { success: false, sentTo: 0, error: "ONESIGNAL_API_KEY is not configured" };
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
          Authorization: getOneSignalAuthorizationHeader(process.env.ONESIGNAL_API_KEY),
          "Content-Type": "application/json"
        }
      }
    );

    console.log("OneSignal:", response.data);

    const providerError = oneSignalResponseError(response.data);
    const recipients = Number(response.data?.recipients ?? 0);

    if (providerError || recipients === 0) {
      return {
        success: false,
        sentTo: recipients,
        error: providerError || "OneSignal accepted the request but delivered it to 0 recipients"
      };
    }

    return {
      success: true,
      sentTo: recipients
    };

  } catch (err) {
    const providerError = normalizeErrorMessage(err.response?.data?.errors)
      || normalizeErrorMessage(err.response?.data)
      || err.message;
    console.error("Push error:", err.response?.data || err.message);
    return {
      success: false,
      sentTo: 0,
      error: providerError || "Push notification failed"
    };
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

  const userIds = participants.docs
    .map(d => d.get("odcUid") || d.id)
    .filter(Boolean);

  if (!userIds.length) return [];

  return await getUsersPlayerIds(userIds);
}

async function resolvePlayerIdsForRequest({ type, selectedUsers = [], tournamentId = null }) {
  let playerIds = [];

  if (type === "all") {
    const users = await db.collection("users").get();

    users.forEach(d => {
      if (d.data().playerId) {
        playerIds.push(d.data().playerId);
      }
    });
  } else if (type === "selected") {
    playerIds = await getUsersPlayerIds(selectedUsers || []);
  } else if (type === "tournament") {
    if (!tournamentId) {
      throw Object.assign(new Error("Tournament ID required"), { statusCode: 400 });
    }
    playerIds = await getTournamentParticipants(tournamentId);
  } else {
    throw Object.assign(new Error(`Invalid notification type: ${type}`), { statusCode: 400 });
  }

  return [...new Set(playerIds.filter(Boolean))];
}

async function dispatchNotification(data) {
  const playerIds = await resolvePlayerIdsForRequest(data);

  if (!playerIds.length) {
    return {
      success: false,
      sentTo: 0,
      error: "No target users with valid OneSignal subscription IDs were found"
    };
  }

  return await sendPushNotification(
    playerIds,
    data.title,
    data.message,
    { type: data.type, tournamentId: data.tournamentId || "" }
  );
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

    const result = await dispatchNotification({
      title,
      message,
      type,
      selectedUsers,
      tournamentId
    });

    await logHistory(title, message, type, tournamentId, result.sentTo);

    res.status(result.success ? 200 : 400).json(result);

  } catch (e) {

    console.error(e);

    res.status(e.statusCode || 500).json({
      success: false,
      error: e.message || "Notification failed"
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
      return res.status(400).json({
        success: false,
        sentTo: 0,
        error: "Receiver user does not have a OneSignal subscription ID"
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

    res.status(result.success ? 200 : 400).json(result);

  } catch (e) {

    console.error("Chat notification error:", e);

    res.status(500).json({
      success: false,
      error: e.message || "Chat notification failed"
    });

  }

});

/* ===============================
   SUPPORT STAFF CHAT NOTIFICATION
================================*/
app.post("/supportStaffNotification", async (req, res) => {
  try {
    const { senderName, messagePreview, chatId } = req.body;
    const title = senderName || "New support message";
    const body = messagePreview || "A player sent a support message";

    const [adminTokens, organizerTokens] = await Promise.all([
      collectFcmTokens("admin_users"),
      collectFcmTokens("organizer_users")
    ]);

    const result = await sendFcmNotification(
      [...adminTokens, ...organizerTokens],
      title,
      body,
      {
        type: "support_chat",
        category: "support",
        chatId: chatId || ""
      }
    );

    res.status(result.success ? 200 : 400).json(result);
  } catch (e) {
    console.error("Support staff notification error:", e);
    res.status(500).json({
      success: false,
      error: e.message || "Support staff notification failed"
    });
  }
});

/* ===============================
   SCHEDULE NOTIFICATION
================================*/
app.post("/scheduleNotification", async (req, res) => {
  let ref = null;

  try {

    const {
      title,
      message,
      type,
      selectedUsers,
      tournamentId,
      scheduleConfig
    } = req.body;

    if (!title || !message) {
      return res.status(400).json({
        success: false,
        error: "Title and message are required"
      });
    }

    if (!scheduleConfig || !scheduleConfig.scheduleType) {
      return res.status(400).json({
        success: false,
        error: "scheduleConfig.scheduleType is required"
      });
    }

    await resolvePlayerIdsForRequest({
      type,
      selectedUsers: selectedUsers || [],
      tournamentId: tournamentId || null
    });

    ref = await db.collection("scheduledNotifications").add({
      title,
      message,
      type,
      selectedUsers: selectedUsers || [],
      tournamentId: tournamentId || null,
      scheduleConfig,
      isActive: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await createScheduledJob(ref.id, {
      title,
      message,
      type,
      selectedUsers: selectedUsers || [],
      tournamentId: tournamentId || null,
      scheduleConfig
    });

    res.json({
      success: true,
      scheduleId: ref.id
    });

  } catch (e) {

    console.error(e);

    if (ref) {
      await ref.set({
        isActive: false,
        lastError: e.message || "Failed to create scheduled job",
        deletedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true }).catch(err => {
        console.error("Failed to mark invalid schedule inactive:", err.message);
      });
    }

    res.status(e.statusCode || 500).json({
      success: false,
      error: e.message || "Failed to schedule notification"
    });

  }

});

app.get("/scheduledNotifications", async (_, res) => {
  try {
    const snap = await db.collection("scheduledNotifications")
      .orderBy("createdAt", "desc")
      .get();

    const schedules = snap.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        title: data.title || "",
        message: data.message || "",
        type: data.type || "all",
        tournamentId: data.tournamentId || null,
        selectedUsers: data.selectedUsers || [],
        scheduleConfig: data.scheduleConfig || {},
        isActive: data.isActive !== false,
        createdAt: formatTimestamp(data.createdAt)
      };
    });

    res.json({ success: true, schedules });
  } catch (e) {
    console.error("Scheduled notifications fetch error:", e);
    res.status(500).json({
      success: false,
      error: e.message || "Failed to load scheduled notifications"
    });
  }
});

app.delete("/scheduledNotification/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({ success: false, error: "Schedule ID required" });
    }

    const scheduledJob = scheduledJobs.get(id);
    if (scheduledJob) {
      scheduledJob.stop();
      scheduledJobs.delete(id);
    }

    await db.collection("scheduledNotifications").doc(id).set({
      isActive: false,
      deletedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    res.json({ success: true });
  } catch (e) {
    console.error("Scheduled notification delete error:", e);
    res.status(500).json({
      success: false,
      error: e.message || "Failed to delete scheduled notification"
    });
  }
});

app.get("/notificationHistory", async (_, res) => {
  try {
    const snap = await db.collection("notificationHistory")
      .orderBy("createdAt", "desc")
      .limit(200)
      .get();

    const history = snap.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        title: data.title || "",
        message: data.message || "",
        type: data.type || "all",
        tournamentId: data.tournamentId || null,
        targetCount: Number(data.targetCount || 0),
        createdAt: formatTimestamp(data.createdAt)
      };
    });

    res.json({ success: true, history });
  } catch (e) {
    console.error("Notification history fetch error:", e);
    res.status(500).json({
      success: false,
      error: e.message || "Failed to load notification history"
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
      throw Object.assign(new Error("Missing scheduleConfig"), { statusCode: 400 });
    }

    let cronExp;
    let timeoutDelayMs;
    const timezone = process.env.NOTIFICATION_TIMEZONE || "Asia/Kolkata";
    const scheduleType = scheduleConfig.scheduleType;

    if (scheduleType === "oneTime" && scheduleConfig.dateTime) {
      const runAt = parseScheduleDateTime(scheduleConfig.dateTime);
      if (Number.isNaN(runAt.getTime())) {
        throw Object.assign(new Error("Invalid one-time schedule dateTime"), { statusCode: 400 });
      }

      timeoutDelayMs = runAt.getTime() - Date.now();
      if (timeoutDelayMs <= 0) {
        throw Object.assign(new Error("Schedule date/time must be in the future"), { statusCode: 400 });
      }
      if (timeoutDelayMs > 2147483647) {
        throw Object.assign(new Error("One-time schedule must be within 24 days"), { statusCode: 400 });
      }
    }

    if (scheduleType === "daily" && scheduleConfig.time) {
      const [h, m] = scheduleConfig.time.split(":");
      if (h === undefined || m === undefined) {
        throw Object.assign(new Error("Daily schedule time must be HH:mm"), { statusCode: 400 });
      }

      cronExp = `${m} ${h} * * *`;
    }

    if (scheduleType === "weekly" && scheduleConfig.time) {
      const [h, m] = scheduleConfig.time.split(":");
      const days = (scheduleConfig.weekdays || [])
        .map(weekdayToCronValue)
        .filter(value => value !== undefined);

      if (h === undefined || m === undefined) {
        throw Object.assign(new Error("Weekly schedule time must be HH:mm"), { statusCode: 400 });
      }
      if (!days.length) {
        throw Object.assign(new Error("Weekly schedule requires at least one valid weekday"), { statusCode: 400 });
      }

      cronExp = `${m} ${h} * * ${days.join(",")}`;
    }

    if (!cronExp && timeoutDelayMs === undefined) {
      throw Object.assign(new Error(`Unsupported schedule configuration: ${JSON.stringify(scheduleConfig)}`), { statusCode: 400 });
    }

    if (scheduledJobs.has(id)) {
      scheduledJobs.get(id).stop();
    }

    const runScheduledNotification = async () => {
      console.log("Running scheduled job:", id);
      const doc = await db.collection("scheduledNotifications").doc(id).get();
      if (!doc.exists || doc.data().isActive === false) {
        const existingJob = scheduledJobs.get(id);
        if (existingJob) existingJob.stop();
        scheduledJobs.delete(id);
        return;
      }

      const result = await dispatchNotification(data);
      await logHistory(data.title, data.message, data.type, data.tournamentId || null, result.sentTo || 0);

      if (!result.success) {
        await db.collection("scheduledNotifications").doc(id).set({
          lastError: result.error || "Scheduled notification failed",
          lastRunAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        console.error("Scheduled notification failed:", id, result.error);
      } else {
        await db.collection("scheduledNotifications").doc(id).set({
          lastError: null,
          lastRunAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      }

      if (scheduleType === "oneTime") {
        await db.collection("scheduledNotifications").doc(id).set({
          isActive: false,
          completedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        scheduledJobs.delete(id);
      }
    };

    let timeoutHandle = null;
    const job = timeoutDelayMs !== undefined
      ? { stop: () => clearTimeout(timeoutHandle) }
      : cron.schedule(cronExp, runScheduledNotification, { timezone });

    if (timeoutDelayMs !== undefined) {
      timeoutHandle = setTimeout(runScheduledNotification, timeoutDelayMs);
    }

    scheduledJobs.set(id, job);

  } catch (e) {

    console.error("Scheduled job error:", e);
    throw e;

  }

}

/* ===============================
   LOAD JOBS ON START
================================*/
async function disableInvalidScheduledJob(id, reason) {
  await db.collection("scheduledNotifications").doc(id).set({
    isActive: false,
    lastError: reason,
    disabledAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
}

async function loadScheduledJobs() {

  const snap = await db.collection("scheduledNotifications")
    .where("isActive", "==", true)
    .get();

  let loadedCount = 0;
  let skippedCount = 0;

  for (const doc of snap.docs) {
    try {
      await createScheduledJob(doc.id, doc.data());
      loadedCount += 1;
    } catch (e) {
      skippedCount += 1;
      const message = e.message || "Invalid scheduled notification";
      console.error(`Skipping scheduled job ${doc.id}:`, message);

      try {
        await disableInvalidScheduledJob(doc.id, message);
      } catch (updateError) {
        console.error(`Failed to disable invalid scheduled job ${doc.id}:`, updateError);
      }
    }
  }

  console.log("Loaded schedules:", loadedCount, "Skipped invalid schedules:", skippedCount);
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

  try {
    await loadScheduledJobs();
  } catch (e) {
    console.error("Scheduled jobs could not be loaded on startup:", e);
  }

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
