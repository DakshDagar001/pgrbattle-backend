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

// Trust reverse proxy headers (e.g. Render, Cloudflare, load balancers)
app.set('trust proxy', true);

/* ===============================
   MIDDLEWARE
================================*/
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

// Mode browsing remains available to authenticated players, but the legacy mode password field
// must not remain readable in old documents. Cleanup is idempotent and runs before routes start.
removeLegacyModePasswords({ db, admin })
  .then(result => {
    if (result.cleaned > 0) {
      console.log('[TournamentModes] Removed legacy plaintext passwords:', result.cleaned);
    }
  })
  .catch(error => {
    // Do not silently claim cleanup succeeded; deployment operators need to see a failed scrub.
    console.error('[TournamentModes] Legacy password cleanup failed:', error.message);
  });

/* ===============================
   DEPOSIT SYSTEM INIT
================================*/
const { initVerifier } = require('./services/depositVerifier');
const { notifyUser, notifyTournament, notifyByEvent } = require('./services/notificationEngine');
const depositRoutes = require('./routes/depositRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const emulatorRoutes = require('./routes/emulatorRoutes');
const authRoutes = require('./routes/authRoutes');
const adminAccountRoutes = require('./routes/adminAccountRoutes');
const { createOrganizerEconomyService } = require('./services/organizerEconomy');
const { createOrganizerRewardService } = require('./services/organizerRewards');
const { createPenaltyEnforcementService } = require('./services/organizerPenalties');
const { createTournamentReminders } = require('./services/tournamentReminders');
const { createOrganizerDeviceService } = require('./services/organizerDevices');
const { createAuditTrail } = require('./services/auditTrail');
// Mounted below through their factories, because the organizer routes share one audit trail and
// one device service with each other.
const { createOrganizerDeviceRouter } = require('./routes/organizerDeviceRoutes');
const { createOrganizerWalletRouter } = require('./routes/organizerWalletRoutes');
const { createOrganizerTournamentRouter } = require('./routes/organizerTournamentRoutes');
const { createOrganizerOpsRouter } = require('./routes/organizerOpsRoutes');
const { createPlayerTournamentRouter } = require('./routes/playerTournamentRoutes');
const { createAdminOrganizerRouter } = require('./routes/organizerAdminRoutes');
const { initRoomTriggers, initTournamentNotificationTriggers, initOrganizerRewardTriggers } = require('./services/tournamentTriggers');
const { removeLegacyModePasswords } = require('./services/tournamentModePasswordCleanup');

// Gmail init — legacy, only attempt if env vars are present
if (process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET && process.env.GMAIL_REFRESH_TOKEN) {
  try {
    const { initGmail } = require('./services/gmailService');
    initGmail();
    console.log('✓ Gmail initialized (legacy – ZapUPI is primary)');
  } catch (err) {
    console.warn('Gmail init failed (non-critical – ZapUPI is primary):', err.message);
  }
} else {
  console.log('ℹ Gmail not configured – skipped (ZapUPI is primary deposit method)');
}

// Deposit verifier — still needed for creditWallet (used by admin override and webhook)
try {
  initVerifier(notifyUser);
  console.log('✓ Deposit Verifier initialized');
} catch (err) {
  console.error('Deposit Verifier init failed:', err.message);
}

/* ===============================
   ORGANIZER AUDIT TRAIL AND DEVICE BINDING

   Two shared instances for the same reason the economy service has one: neither holds state
   beyond the database handle and the server clock, and a privileged act that is recorded through
   one trail and a binding that is read through one service is the whole point of both features.
   `transcripts` is the schema every administrative act in this project has always used - this
   adds sections to it, not a parallel log - and the device records are written only here, which
   is what lets the rules deny every client write to them.
================================*/
const organizerAudit = createAuditTrail({
  db,
  serverTimestamp: () => admin.firestore.FieldValue.serverTimestamp()
});

const organizerDevices = createOrganizerDeviceService({
  db,
  serverTimestamp: () => admin.firestore.FieldValue.serverTimestamp(),
  audit: organizerAudit
});

try {
  // Mount routes
  app.use('/api/deposit', depositRoutes);
  app.use('/', notificationRoutes);
  app.use('/', emulatorRoutes);
  app.use('/api/auth', authRoutes);
  app.use('/api/admin/account', adminAccountRoutes);
  app.use('/api/organizer/wallet', createOrganizerWalletRouter({
    devices: organizerDevices, audit: organizerAudit
  }));
  // Creating a match is the one tournament write that cannot be a direct client write: the daily
  // allowance has to be counted atomically and the device has to be the approved one.
  app.use('/api/organizer/tournaments', createOrganizerTournamentRouter({
    devices: organizerDevices, audit: organizerAudit
  }));
  app.use('/api/organizer/devices', createOrganizerDeviceRouter({
    devices: organizerDevices, audit: organizerAudit
  }));
  // The trusted decision behind every protected organizer edit, cancellation, result and prize
  // issue: the answer is a permit `firestore.rules` requires before it accepts the write.
  app.use('/api/organizer/ops', createOrganizerOpsRouter({ devices: organizerDevices }));
  // The Player app's one server-side question: does this password open this match?
  app.use('/api/player/tournament', createPlayerTournamentRouter());
  app.use('/api/admin/organizer', createAdminOrganizerRouter({
    devices: organizerDevices, audit: organizerAudit
  }));
  console.log('✓ Organizer routes', [
    '/api/organizer/wallet', '/api/organizer/tournaments', '/api/organizer/devices',
    '/api/organizer/ops', '/api/player/tournament', '/api/admin/organizer'
  ].join(' '));
  console.log('✓ Express Routes loaded');
} catch (err) {
  console.error('Route mounting failed:', err.message);
}

// The organizer economy's only balance writer. One instance for the schedules below: it holds
// no state, only the database handle and the server clock, so sharing it costs nothing and
// keeps every movement inside the same transaction rules.
const organizerEconomy = createOrganizerEconomyService({
  db,
  serverTimestamp: () => admin.firestore.FieldValue.serverTimestamp()
});

// Initialize triggers
initRoomTriggers();
initTournamentNotificationTriggers();

/* ===============================
   ORGANIZER COMPLETION REWARDS

   The listener pays on the `prizesDistributed` transition, which the results transaction writes
   together with the player payouts. The bounded catch-up below covers what a restart can miss;
   both paths use one ledger key per match, so neither can pay the same match twice.
================================*/
const organizerRewards = createOrganizerRewardService({
  db,
  economy: organizerEconomy,
  audit: organizerAudit
});

try {
  initOrganizerRewardTriggers(organizerRewards);
} catch (err) {
  // A listener that cannot start does not stop the rewards the catch-up pass will find.
  console.error('[OrganizerRewards] Listener failed to start:', err.message);
}

async function checkOrganizerRewards() {
  try {
    const result = await organizerRewards.catchUp({ sinceHours: 168, limit: 300 });
    // Only a pass that actually paid or found something worth reporting gets a log line.
    if (result.summary.credited || result.summary.duplicate || result.summary.failed) {
      console.log('[OrganizerRewards] Catch-up', JSON.stringify(result.summary));
    }
  } catch (err) {
    console.error('[OrganizerRewards] Catch-up failed:', err.message);
  }
}

// Render owns this listener. Status changes are written by the admin app; the
// listener sends exactly once through the same template-aware FCM engine.
rtdb.ref('withdrawalRequests').on('child_changed', async snapshot => {
  const request = snapshot.val() || {};
  const status = String(request.status || '').toLowerCase();
  if (!['approved', 'rejected'].includes(status)) return;
  const eventKey = `withdrawal_${status}`;
  try {
    const claimed = await db.collection('notificationEventClaims').doc(`${eventKey}_${snapshot.key}`).create({
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    }).then(() => true).catch(error => {
      if (error.code === 6 || error.code === 'already-exists') return false;
      throw error;
    });
    if (!claimed) return;
    await notifyByEvent(eventKey, 'user', request.userId || request.odcUserId, {
      AMOUNT: request.amount || '', REQUEST_ID: snapshot.key,
      deepLink: 'pgr://wallet/withdrawals'
    }, {
      title: status === 'approved' ? 'Withdrawal Approved' : 'Withdrawal Rejected',
      body: `Your withdrawal of ₹{{AMOUNT}} has been ${status}.`
    });
  } catch (error) {
    console.error('[Triggers] Withdrawal notification failed:', error.message);
  }
});



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
      zapupi: "configured",
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

   Fixed in Phase 10: this job used to query `tournaments.startTime`, a field no client in this
   project writes, so it could never match a match. It now reads `dateTime` - the field the
   Organizer compose screen writes and the Player app reads - and does its work in
   `services/tournamentReminders.js`, where the window, the exclusions, the milestone choice and
   the duplicate-notification guard can be tested without a scheduler.
================================*/
const tournamentReminders = createTournamentReminders({
  db,
  notify: notifyByEvent
});

async function checkTournamentReminders() {
  try {
    const result = await tournamentReminders.runOnce();
    // A pass with nothing due is the normal case and is not worth a log line every five minutes.
    if (result.summary.sent > 0 || result.summary.failed > 0) {
      console.log('[TournamentReminders] Pass', result.code, JSON.stringify(result.summary));
    }
  } catch (err) {
    // Operational, not financial: a failed pass leaves every match for the next one.
    console.error('[TournamentReminders] Pass failed:', err.message);
  }
}

/* ===============================
   ORGANIZER DEADLINE PENALTIES

   A recurring check rather than an event, because the violation is "nothing happened by the
   deadline": there is no write to listen for. The charge itself is the economy service's
   `deductPenalty`, whose ledger key is derived from the match, so this job is free to run
   twice, restart mid-pass or exist on more than one replica.

   It reads `dateTime`, which is the field the Organizer and Admin compose screens actually
   write as the scheduled start - and now so does the reminder job above, which used to query
   `startTime` and therefore never matched a match.
================================*/
const penaltyEnforcement = createPenaltyEnforcementService({
  db,
  economy: organizerEconomy,
  serverTimestamp: () => admin.firestore.FieldValue.serverTimestamp(),
  ...(Number(process.env.ORGANIZER_PENALTY_LOOKBACK_HOURS) > 0
    ? { lookbackHours: Number(process.env.ORGANIZER_PENALTY_LOOKBACK_HOURS) }
    : {})
});

async function checkOrganizerDeadlines() {
  try {
    const result = await penaltyEnforcement.sweepOnce();
    // A sweep that is switched off is the normal state and not worth a log line every ten
    // minutes; anything that actually looked at matches is reported with its counts.
    if (result.code !== 'DISABLED') {
      console.log('[OrganizerPenalties] Sweep', result.code, JSON.stringify(result.summary || {}));
    }
  } catch (err) {
    // Operational, not financial: a failed pass leaves every match for the next one.
    console.error('[OrganizerPenalties] Sweep failed:', err.message);
  }
}

/* ===============================
   START SERVER
================================*/
async function startServer() {

  // Schedules are now initialized in notificationRoutes.js

  cron.schedule("*/5 * * * *", checkTournamentReminders);
  // The deadline sweep and the reward catch-up share one ten-minute schedule: both are bounded,
  // both are idempotent, and neither needs a scheduler of its own.
  cron.schedule("*/10 * * * *", async () => {
    await checkOrganizerDeadlines();
    await checkOrganizerRewards();
  });

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
