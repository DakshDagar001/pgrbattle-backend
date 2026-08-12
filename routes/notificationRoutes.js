const express = require('express');
const admin = require('firebase-admin');
const { notifyUser, dispatchNotification, sendMulticast } = require('../services/notificationEngine');

const router = express.Router();
const db = admin.firestore();

// Global job storage
const scheduledJobs = new Map();

/* ===============================
   HELPERS
================================*/
function formatTimestamp(value) {
  if (!value) return null;
  if (value.toDate) return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function weekdayToCronValue(weekday) {
  const days = {
    sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6
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
    const data = doc.data();
    const docTokens = data.fcmTokens || [];
    docTokens.forEach(t => {
      if (typeof t === "string" && t.trim()) {
        tokens.push(t.trim());
      }
    });
  });
  return tokens;
}

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
   ROUTES
================================*/

// Standard push notification — supports type: all, selected, tournament, fcm_token
router.post('/sendNotification', async (req, res) => {
  try {
    const { title, message, type, selectedUsers = [], tournamentId = null, fcmToken = null } = req.body;

    if (!title || !message) {
      return res.status(400).json({ success: false, error: "Missing data" });
    }

    let result;

    if (type === 'fcm_token' && fcmToken) {
      // Direct send to a specific FCM token
      result = await sendMulticast([fcmToken], title, message, { type });
    } else {
      result = await dispatchNotification({
        title,
        message,
        type,
        selectedUsers,
        tournamentId
      });
    }

    await logHistory(title, message, type, tournamentId, result.sentTo || 0);

    // Increment global sent counter
    try {
      const counterRef = db.collection('notificationStats').doc('global');
      await counterRef.set({
        totalSent: admin.firestore.FieldValue.increment(result.sentTo || 0),
        lastSentAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    } catch (counterErr) {
      console.error('Counter update error:', counterErr);
    }

    res.status(result.success ? 200 : 400).json(result);
  } catch (e) {
    console.error(e);
    res.status(e.statusCode || 500).json({ success: false, error: e.message || "Notification failed" });
  }
});

// Chat message notification
router.post('/chatNotification', async (req, res) => {
  try {
    const { receiverUserId, senderName, messagePreview } = req.body;

    if (!receiverUserId) {
      return res.status(400).json({ success: false, error: "Missing receiverUserId" });
    }

    const title = senderName || "New Message";
    const message = messagePreview || "You received a new message";

    const result = await notifyUser(receiverUserId, title, message, { type: "chat_message" });

    res.status(result.success ? 200 : 400).json(result);
  } catch (e) {
    console.error("Chat notification error:", e);
    res.status(500).json({ success: false, error: e.message || "Chat notification failed" });
  }
});

// Support staff notification
router.post('/supportStaffNotification', async (req, res) => {
  try {
    const { senderName, messagePreview, chatId } = req.body;
    const title = senderName || "New support message";
    const body = messagePreview || "A player sent a support message";

    const [adminTokens, organizerTokens] = await Promise.all([
      collectFcmTokens("admin_users"),
      collectFcmTokens("organizer_users")
    ]);

    const result = await sendMulticast(
      [...adminTokens, ...organizerTokens],
      title,
      body,
      { type: "support_chat", category: "support", chatId: chatId || "" }
    );

    res.status(result.success ? 200 : 400).json(result);
  } catch (e) {
    console.error("Support staff notification error:", e);
    res.status(500).json({ success: false, error: e.message || "Support staff notification failed" });
  }
});

// ── Notification Count (fixes "Total Sent" stuck at 200) ──
router.get('/notificationCount', async (_, res) => {
  try {
    // History stores the number of successful device deliveries for each send.
    // Sum it rather than returning an old capped counter or merely row count.
    const history = await db.collection("notificationHistory").get();
    const totalSent = history.docs.reduce((sum, doc) => sum + Number(doc.get('targetCount') || 0), 0);
    await db.collection('notificationStats').doc('global').set({
      totalSent,
      lastSentAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    res.json({ success: true, totalSent });
  } catch (e) {
    console.error("Notification count error:", e);
    res.status(500).json({ success: false, error: e.message || "Failed to get count" });
  }
});

// Schedule endpoints
router.post('/scheduleNotification', async (req, res) => {
  let ref = null;
  try {
    const { title, message, type, selectedUsers, tournamentId, fcmToken, scheduleConfig } = req.body;

    if (!title || !message) {
      return res.status(400).json({ success: false, error: "Title and message are required" });
    }

    if (!scheduleConfig || !scheduleConfig.scheduleType) {
      return res.status(400).json({ success: false, error: "scheduleConfig.scheduleType is required" });
    }

    ref = await db.collection("scheduledNotifications").add({
      title,
      message,
      type,
      selectedUsers: selectedUsers || [],
      tournamentId: tournamentId || null,
      fcmToken: fcmToken || null,
      scheduleConfig,
      isActive: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await createScheduledJob(ref.id, req.body);
    res.json({ success: true, scheduleId: ref.id });
  } catch (e) {
    console.error(e);
    if (ref) {
      await ref.set({
        isActive: false,
        lastError: e.message || "Failed to create scheduled job",
        deletedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true }).catch(() => {});
    }
    res.status(e.statusCode || 500).json({ success: false, error: e.message || "Failed to schedule notification" });
  }
});

router.get('/scheduledNotifications', async (_, res) => {
  try {
    const snap = await db.collection("scheduledNotifications").orderBy("createdAt", "desc").get();
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
    res.status(500).json({ success: false, error: e.message || "Failed to load scheduled notifications" });
  }
});

router.delete('/scheduledNotification/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ success: false, error: "Schedule ID required" });

    const scheduledJob = scheduledJobs.get(id);
    if (scheduledJob) {
      // Logic handled in createScheduledJob interval/timeout, here we just stop it
      if (scheduledJob.stop) scheduledJob.stop();
      if (scheduledJob.clear) scheduledJob.clear();
      scheduledJobs.delete(id);
    }

    await db.collection("scheduledNotifications").doc(id).set({
      isActive: false,
      deletedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    res.json({ success: true });
  } catch (e) {
    console.error("Scheduled notification delete error:", e);
    res.status(500).json({ success: false, error: e.message || "Failed to delete scheduled notification" });
  }
});

router.get('/notificationHistory', async (_, res) => {
  try {
    const snap = await db.collection("notificationHistory").orderBy("createdAt", "desc").limit(200).get();
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
    res.status(500).json({ success: false, error: e.message || "Failed to load notification history" });
  }
});

/* ===============================
   CRON / SCHEDULE CREATION
================================*/
const cron = require('node-cron');

async function createScheduledJob(id, data) {
  try {
    const { scheduleConfig } = data;
    if (!scheduleConfig) throw new Error("Missing scheduleConfig");

    let cronExp;
    let timeoutDelayMs;
    const scheduleType = scheduleConfig.scheduleType;

    if (scheduleType === "oneTime" && scheduleConfig.dateTime) {
      const runAt = parseScheduleDateTime(scheduleConfig.dateTime);
      if (Number.isNaN(runAt.getTime())) throw new Error("Invalid one-time schedule dateTime");
      timeoutDelayMs = runAt.getTime() - Date.now();
      if (timeoutDelayMs <= 0) throw new Error("Schedule date/time must be in the future");
      if (timeoutDelayMs > 2147483647) throw new Error("One-time schedule must be within 24 days");
    }

    if (scheduleType === "daily" && scheduleConfig.time) {
      const [h, m] = scheduleConfig.time.split(":");
      if (h === undefined || m === undefined) throw new Error("Daily schedule time must be HH:mm");
      cronExp = `${m} ${h} * * *`;
    }

    if (scheduleType === "weekly" && scheduleConfig.time) {
      const [h, m] = scheduleConfig.time.split(":");
      const days = (scheduleConfig.weekdays || []).map(weekdayToCronValue).filter(v => v !== undefined);
      if (h === undefined || m === undefined) throw new Error("Weekly schedule time must be HH:mm");
      if (!days.length) throw new Error("Weekly schedule requires at least one valid weekday");
      cronExp = `${m} ${h} * * ${days.join(",")}`;
    }

    if (!cronExp && timeoutDelayMs === undefined) {
      throw new Error(`Unsupported schedule configuration`);
    }

    if (scheduledJobs.has(id)) {
      const existing = scheduledJobs.get(id);
      if (existing.stop) existing.stop();
      if (existing.clear) existing.clear();
    }

    const runScheduledNotification = async () => {
      console.log("Running scheduled job:", id);
      const doc = await db.collection("scheduledNotifications").doc(id).get();
      if (!doc.exists || doc.data().isActive === false) {
        const existingJob = scheduledJobs.get(id);
        if (existingJob) {
          if (existingJob.stop) existingJob.stop();
          if (existingJob.clear) existingJob.clear();
        }
        scheduledJobs.delete(id);
        return;
      }
      const result = data.type === 'fcm_token'
        ? await sendMulticast([data.fcmToken], data.title, data.message, { type: data.type })
        : await dispatchNotification(data);
      await logHistory(data.title, data.message, data.type, data.tournamentId || null, result.sentTo || 0);
      
      // If oneTime, deactivate after running
      if (scheduleType === "oneTime") {
        await db.collection("scheduledNotifications").doc(id).set({ isActive: false }, { merge: true });
        scheduledJobs.delete(id);
      }
    };

    if (cronExp) {
      const task = cron.schedule(cronExp, runScheduledNotification, { timezone: process.env.NOTIFICATION_TIMEZONE || "Asia/Kolkata" });
      scheduledJobs.set(id, { stop: () => task.stop() });
    } else {
      const timeoutId = setTimeout(runScheduledNotification, timeoutDelayMs);
      scheduledJobs.set(id, { clear: () => clearTimeout(timeoutId) });
    }
  } catch (err) {
    throw err;
  }
}

// Load existing schedules on init
async function initSchedules() {
  try {
    const snap = await db.collection("scheduledNotifications").where("isActive", "==", true).get();
    snap.forEach(doc => {
      const data = doc.data();
      createScheduledJob(doc.id, data).catch(err => console.error("Failed to init schedule:", doc.id, err.message));
    });
    console.log(`[NotificationRoutes] Initialized ${snap.size} active schedules`);
  } catch (e) {
    console.error("Failed to initialize schedules:", e.message);
  }
}
initSchedules();

/* ===============================
   TEMPLATES CRUD
================================*/

router.post('/createTemplate', async (req, res) => {
  try {
    const { name, title, message, type, usageType, placeholders, imageUrl, deepLink } = req.body;
    if (!name || !title || !message) {
      return res.status(400).json({ success: false, error: "Name, title, and message are required" });
    }

    const newTemplate = {
      name,
      title,
      message,
      type: type || "general",
      usageType: usageType || null,
      placeholders: placeholders || [],
      imageUrl: imageUrl || null,
      deepLink: deepLink || null,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const docRef = await db.collection("notificationTemplates").add(newTemplate);
    res.json({ success: true, templateId: docRef.id });
  } catch (e) {
    console.error("Create template error:", e);
    res.status(500).json({ success: false, error: e.message || "Failed to create template" });
  }
});

router.get('/templates', async (req, res) => {
  try {
    const snap = await db.collection("notificationTemplates").orderBy("createdAt", "desc").get();
    const templates = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ success: true, templates });
  } catch (e) {
    console.error("Get templates error:", e);
    res.status(500).json({ success: false, error: e.message || "Failed to get templates" });
  }
});

router.put('/updateTemplate/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, title, message, type, usageType, placeholders, imageUrl, deepLink } = req.body;
    if (!name || !title || !message) {
      return res.status(400).json({ success: false, error: "Name, title, and message are required" });
    }

    const updatedTemplate = {
      name,
      title,
      message,
      type: type || "general",
      usageType: usageType || null,
      placeholders: placeholders || [],
      imageUrl: imageUrl || null,
      deepLink: deepLink || null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await db.collection("notificationTemplates").doc(id).update(updatedTemplate);
    res.json({ success: true });
  } catch (e) {
    console.error("Update template error:", e);
    res.status(500).json({ success: false, error: e.message || "Failed to update template" });
  }
});

router.delete('/deleteTemplate/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await db.collection("notificationTemplates").doc(id).delete();
    res.json({ success: true });
  } catch (e) {
    console.error("Delete template error:", e);
    res.status(500).json({ success: false, error: e.message || "Failed to delete template" });
  }
});

/* ===============================
   NOTIFICATION HISTORY DELETE/CLEAR
================================*/

// Delete a single notification history entry
router.delete('/notificationHistory/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ success: false, error: "History ID required" });

    await db.collection("notificationHistory").doc(id).delete();
    res.json({ success: true });
  } catch (e) {
    console.error("Delete notification history error:", e);
    res.status(500).json({ success: false, error: e.message || "Failed to delete history entry" });
  }
});

// Clear all notification history
router.delete('/notificationHistory', async (_, res) => {
  try {
    const snap = await db.collection("notificationHistory").get();
    let batch = db.batch();
    let count = 0;

    for (const doc of snap.docs) {
      batch.delete(doc.ref);
      count++;

      // Firestore batch limit is 500
      if (count % 500 === 0) {
        await batch.commit();
        batch = db.batch();
      }
    }

    if (count % 500 !== 0) {
      await batch.commit();
    }

    // Reset the counter
    await db.collection('notificationStats').doc('global').set({
      totalSent: 0,
      lastSentAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    res.json({ success: true, deletedCount: count });
  } catch (e) {
    console.error("Clear notification history error:", e);
    res.status(500).json({ success: false, error: e.message || "Failed to clear history" });
  }
});

module.exports = router;
