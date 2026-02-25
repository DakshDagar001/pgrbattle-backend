require("dotenv").config();
const express = require("express");
const axios = require("axios");
const admin = require("firebase-admin");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());
app.use((req, res, next) => {
  console.log("Incoming request:", req.method, req.url);
  next();
});

admin.initializeApp({
  credential: admin.credential.cert(require("./serviceAccount.json"))
});

const db = admin.firestore();

app.post("/sendNotification", async (req, res) => {
  try {
    const { title, message, type, selectedUsers } = req.body;

    let snapshot;

    if (type === "all") {
      snapshot = await db.collection("users").get();
    } else {
      snapshot = await db.collection("users")
        .where(admin.firestore.FieldPath.documentId(), "in", selectedUsers)
        .get();
    }

    const playerIds = [];

    snapshot.forEach(doc => {
      const data = doc.data();
      if (data.playerId) playerIds.push(data.playerId);
    });

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

    res.json({ success: true });

  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false });
  }
});

const PORT = process.env.PORT || 5230;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});