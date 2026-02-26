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
admin.initializeApp({
  credential: admin.credential.cert(require("./serviceAccount.json"))
});

const db = admin.firestore();

/* ===============================
   GLOBAL VARIABLES
================================*/
const scheduledJobs = new Map(); // Store active cron jobs

/* ===============================
   REUSABLE PUSH NOTIFICATION FUNCTION
================================*/
async function sendPushNotification(playerIds, title, message, metadata = {}) {
  try {
    const response = await axios.post(
      "https://api.onesignal.com/notifications",
      {
        app_id: process.env.ONESIGNAL_APP_ID,
        include_player_ids: playerIds,
        headings: { en: title },
        contents: { en: message },
        data: metadata
      },
      {
        headers: {
          Authorization: `Basic ${process.env.ONESIGNAL_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    console.log("OneSignal response:", response.data);
    return { success: true, sentTo: playerIds.length, response: response.data };
  } catch (error) {
    console.error("OneSignal Error:", error.response?.data || error.message);
    throw error;
  }
}

/* ===============================
   NOTIFICATION HISTORY LOGGING
================================*/
async function logNotificationHistory(title, message, type, tournamentId = null, targetCount) {
  try {
    const historyRef = db.collection("notificationHistory");
    await historyRef.add({
      title,
      message,
      type,
      tournamentId,
      targetCount,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    console.log("Notification history logged");
  } catch (error) {
    console.error("Error logging notification history:", error);
  }
}

/* ===============================
   GET TOURNAMENT PARTICIPANTS
================================*/
async function getTournamentParticipants(tournamentId) {
  try {
    const participantsSnapshot = await db.collection("tournaments")
      .doc(tournamentId)
      .collection("participants")
      .get();

    const userIds = [];
    participantsSnapshot.forEach(doc => {
      userIds.push(doc.id);
    });

    if (userIds.length === 0) {
      return [];
    }

    const usersSnapshot = await db.collection("users")
      .where(admin.firestore.FieldPath.documentId(), "in", userIds)
      .get();

    const playerIds = [];
    usersSnapshot.forEach(doc => {
      const data = doc.data();
      if (data.playerId) {
        playerIds.push(data.playerId);
      }
    });

    return playerIds;
  } catch (error) {
    console.error("Error getting tournament participants:", error);
    throw error;
  }
}

/* ===============================
   HEALTH ENDPOINT (ANTI-SLEEP)
================================*/
app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

/* ===============================
   SEND NOTIFICATION ENDPOINT
================================*/
app.post("/sendNotification", async (req, res) => {
  try {
    const { title, message, type, selectedUsers, tournamentId } = req.body;

    if (!title || !message) {
      return res.status(400).json({
        success: false,
        error: "Title and message required"
      });
    }

    if (!type || !["all", "selected", "tournament"].includes(type)) {
      return res.status(400).json({
        success: false,
        error: "Valid type required (all, selected, tournament)"
      });
    }

    let playerIds = [];

    if (type === "all") {
      const snapshot = await db.collection("users").get();
      snapshot.forEach(doc => {
        const data = doc.data();
        if (data.playerId) {
          playerIds.push(data.playerId);
        }
      });
    } else if (type === "selected") {
      if (!selectedUsers || selectedUsers.length === 0) {
        return res.status(400).json({
          success: false,
          error: "No users selected"
        });
      }

      const snapshot = await db.collection("users")
        .where(admin.firestore.FieldPath.documentId(), "in", selectedUsers)
        .get();

      snapshot.forEach(doc => {
        const data = doc.data();
        if (data.playerId) {
          playerIds.push(data.playerId);
        }
      });
    } else if (type === "tournament") {
      if (!tournamentId) {
        return res.status(400).json({
          success: false,
          error: "Tournament ID required for tournament type"
        });
      }

      playerIds = await getTournamentParticipants(tournamentId);
    }

    if (playerIds.length === 0) {
      return res.status(200).json({
        success: true,
        message: "No subscribed users found"
      });
    }

    const metadata = { type };
    if (tournamentId) {
      metadata.tournamentId = tournamentId;
    }

    const result = await sendPushNotification(playerIds, title, message, metadata);

    // Log notification history
    await logNotificationHistory(title, message, type, tournamentId, playerIds.length);

    res.json({
      success: true,
      sentTo: playerIds.length
    });

  } catch (error) {
    console.error("Notification Error:", error.response?.data || error.message);

    res.status(500).json({
      success: false,
      error: "Notification failed"
    });
  }
});

/* ===============================
   SCHEDULE NOTIFICATION ENDPOINT
================================*/
app.post("/scheduleNotification", async (req, res) => {
  try {
    const { title, message, type, selectedUsers, tournamentId, scheduleConfig } = req.body;

    if (!title || !message || !scheduleConfig) {
      return res.status(400).json({
        success: false,
        error: "Title, message, and scheduleConfig required"
      });
    }

    const { scheduleType, dateTime, time, weekdays } = scheduleConfig;

    if (!["oneTime", "daily", "weekly"].includes(scheduleType)) {
      return res.status(400).json({
        success: false,
        error: "Invalid scheduleType (oneTime, daily, weekly)"
      });
    }

    // Store schedule in Firestore
    const scheduleRef = await db.collection("scheduledNotifications").add({
      title,
      message,
      type,
      selectedUsers,
      tournamentId,
      scheduleConfig,
      isActive: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const scheduleId = scheduleRef.id;

    // Create cron job
    await createScheduledJob(scheduleId, {
      title,
      message,
      type,
      selectedUsers,
      tournamentId,
      scheduleConfig
    });

    res.json({
      success: true,
      scheduleId
    });

  } catch (error) {
    console.error("Schedule Notification Error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to schedule notification"
    });
  }
});

/* ===============================
   GET SCHEDULED NOTIFICATIONS
================================*/
app.get("/scheduledNotifications", async (req, res) => {
  try {
    const snapshot = await db.collection("scheduledNotifications")
      .orderBy("createdAt", "desc")
      .get();

    const schedules = [];
    snapshot.forEach(doc => {
      schedules.push({
        id: doc.id,
        ...doc.data()
      });
    });

    res.json({
      success: true,
      schedules
    });

  } catch (error) {
    console.error("Get Scheduled Notifications Error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to get scheduled notifications"
    });
  }
});

/* ===============================
   DELETE SCHEDULED NOTIFICATION
================================*/
app.delete("/scheduledNotification/:id", async (req, res) => {
  try {
    const { id } = req.params;

    // Stop and remove cron job
    if (scheduledJobs.has(id)) {
      scheduledJobs.get(id).stop();
      scheduledJobs.delete(id);
    }

    // Update Firestore
    await db.collection("scheduledNotifications").doc(id).update({
      isActive: false,
      deletedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({
      success: true,
      message: "Scheduled notification deleted"
    });

  } catch (error) {
    console.error("Delete Scheduled Notification Error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to delete scheduled notification"
    });
  }
});

/* ===============================
   GET NOTIFICATION HISTORY
================================*/
app.get("/notificationHistory", async (req, res) => {
  try {
    const snapshot = await db.collection("notificationHistory")
      .orderBy("createdAt", "desc")
      .limit(100)
      .get();

    const history = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      history.push({
        id: doc.id,
        ...data,
        createdAt: data.createdAt?.toDate()
      });
    });

    res.json({
      success: true,
      history
    });

  } catch (error) {
    console.error("Get Notification History Error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to get notification history"
    });
  }
});

/* ===============================
   CREATE SCHEDULED CRON JOB
================================*/
async function createScheduledJob(scheduleId, notificationData) {
  const { title, message, type, selectedUsers, tournamentId, scheduleConfig } = notificationData;
  const { scheduleType, dateTime, time, weekdays } = scheduleConfig;

  let cronExpression;
  let executeOnce = false;

  if (scheduleType === "oneTime") {
    const date = new Date(dateTime);
    const minute = date.getMinutes();
    const hour = date.getHours();
    const day = date.getDate();
    const month = date.getMonth() + 1;
    cronExpression = `${minute} ${hour} ${day} ${month} *`;
    executeOnce = true;
  } else if (scheduleType === "daily") {
    const [hour, minute] = time.split(":");
    cronExpression = `${minute} ${hour} * * *`;
  } else if (scheduleType === "weekly") {
    const [hour, minute] = time.split(":");
    const dayNumbers = weekdays.map(day => {
      const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
      return days.indexOf(day.toLowerCase());
    }).join(",");
    cronExpression = `${minute} ${hour} * * ${dayNumbers}`;
  }

  const task = cron.schedule(cronExpression, async () => {
    try {
      console.log(`Executing scheduled notification: ${scheduleId}`);
      
      let playerIds = [];

      if (type === "all") {
        const snapshot = await db.collection("users").get();
        snapshot.forEach(doc => {
          const data = doc.data();
          if (data.playerId) {
            playerIds.push(data.playerId);
          }
        });
      } else if (type === "selected") {
        const snapshot = await db.collection("users")
          .where(admin.firestore.FieldPath.documentId(), "in", selectedUsers)
          .get();

        snapshot.forEach(doc => {
          const data = doc.data();
          if (data.playerId) {
            playerIds.push(data.playerId);
          }
        });
      } else if (type === "tournament") {
        playerIds = await getTournamentParticipants(tournamentId);
      }

      if (playerIds.length > 0) {
        const metadata = { type, scheduled: true };
        if (tournamentId) {
          metadata.tournamentId = tournamentId;
        }

        await sendPushNotification(playerIds, title, message, metadata);
        await logNotificationHistory(title, message, type, tournamentId, playerIds.length);
      }

      // Stop job if it's one-time
      if (executeOnce) {
        scheduledJobs.get(scheduleId).stop();
        scheduledJobs.delete(scheduleId);
        await db.collection("scheduledNotifications").doc(scheduleId).update({
          isActive: false,
          executedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }

    } catch (error) {
      console.error("Error executing scheduled notification:", error);
    }
  }, {
    scheduled: true,
    timezone: "UTC"
  });

  scheduledJobs.set(scheduleId, task);
}

/* ===============================
   LOAD SCHEDULED JOBS ON STARTUP
================================*/
async function loadScheduledJobs() {
  try {
    const snapshot = await db.collection("scheduledNotifications")
      .where("isActive", "==", true)
      .get();

    for (const doc of snapshot.docs) {
      const data = doc.data();
      await createScheduledJob(doc.id, data);
    }

    console.log(`Loaded ${snapshot.size} scheduled jobs`);
  } catch (error) {
    console.error("Error loading scheduled jobs:", error);
  }
}

/* ===============================
   TOURNAMENT REMINDER SYSTEM
================================*/
async function checkTournamentReminders() {
  try {
    const now = new Date();
    const reminderOffsets = [60, 30, 5]; // minutes before start

    for (const offset of reminderOffsets) {
      const reminderTime = new Date(now.getTime() + offset * 60 * 1000);
      
      const snapshot = await db.collection("tournaments")
        .where("startTime", ">=", now)
        .where("startTime", "<=", reminderTime)
        .get();

      for (const doc of snapshot.docs) {
        const tournamentData = doc.data();
        const tournamentId = doc.id;

        // Check if reminder for this offset was already sent
        if (tournamentData.reminderSent && tournamentData.reminderSent.includes(offset)) {
          continue;
        }

        const playerIds = await getTournamentParticipants(tournamentId);
        
        if (playerIds.length > 0) {
          const title = `Tournament Reminder`;
          const message = `Your tournament "${tournamentData.name}" starts in ${offset} minutes!`;
          
          await sendPushNotification(playerIds, title, message, {
            type: "tournament_reminder",
            tournamentId,
            offset
          });

          await logNotificationHistory(title, message, "tournament_reminder", tournamentId, playerIds.length);

          // Mark reminder as sent
          await db.collection("tournaments").doc(tournamentId).update({
            reminderSent: admin.firestore.FieldValue.arrayUnion(offset)
          });
        }
      }
    }
  } catch (error) {
    console.error("Error checking tournament reminders:", error);
  }
}

/* ===============================
   STARTUP
================================*/
async function startServer() {
  // Load scheduled jobs
  await loadScheduledJobs();

  // Schedule tournament reminder check (every 5 minutes)
  cron.schedule("*/5 * * * *", checkTournamentReminders, {
    scheduled: true,
    timezone: "UTC"
  });

  // Start server
  const PORT = process.env.PORT || 5230;
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer().catch(console.error);

/* ===============================
   DEFAULT ROUTE (OPTIONAL)
================================*/
app.get("/", (req, res) => {
  res.send("PGR Battle Notification API Running 🚀");
});