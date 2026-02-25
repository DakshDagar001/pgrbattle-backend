require("dotenv").config();

const express = require("express");
const axios = require("axios");
const admin = require("firebase-admin");
const cors = require("cors");

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
    const { title, message, type, selectedUsers } = req.body;

    if (!title || !message) {
      return res.status(400).json({
        success: false,
        error: "Title and message required"
      });
    }

    let snapshot;

    if (type === "all") {
      snapshot = await db.collection("users").get();
    } else {
      if (!selectedUsers || selectedUsers.length === 0) {
        return res.status(400).json({
          success: false,
          error: "No users selected"
        });
      }

      snapshot = await db.collection("users")
        .where(admin.firestore.FieldPath.documentId(), "in", selectedUsers)
        .get();
    }

    const playerIds = [];

    snapshot.forEach(doc => {
      const data = doc.data();
      if (data.playerId) {
        playerIds.push(data.playerId);
      }
    });

    if (playerIds.length === 0) {
      return res.status(200).json({
        success: true,
        message: "No subscribed users found"
      });
    }

    const response = await axios.post(
      "https://api.onesignal.com/notifications",
      {
        app_id: process.env.ONESIGNAL_APP_ID,
        include_player_ids: playerIds,
        headings: { en: title },
        contents: { en: message }
      },
      {
        headers: {
          Authorization: `Basic ${process.env.ONESIGNAL_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    console.log("OneSignal response:", response.data);

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
   DEFAULT ROUTE (OPTIONAL)
================================*/
app.get("/", (req, res) => {
  res.send("PGR Battle Notification API Running 🚀");
});

/* ===============================
   SERVER START
================================*/
const PORT = process.env.PORT || 5230;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});