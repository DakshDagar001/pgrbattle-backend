# PGR Battle Backend

Production-grade backend infrastructure for the **PGR Battle** ecosystem.

This repository powers the server-side architecture of the platform including:

* Authentication & Authorization
* Tournament Management
* Real-time Match Systems
* Wallet & Coin Handling
* Automated Deposit Verification
* Gmail API Integration
* Push Notifications
* Admin Systems
* Firebase Integration
* Secure API Infrastructure
* Cron & Scheduler Services
* Real-time Data Synchronization

---

# Features

## Authentication

* Firebase Authentication
* Secure JWT validation
* Role-based access control
* Admin/user separation

## Wallet System

* Coin balance management
* Deposit handling
* Transaction tracking
* Auto verification support

## Gmail Deposit Verification

* Gmail API integration
* OAuth2 authentication
* Automatic token refresh
* FamPay/FamX payment email parsing
* Duplicate transaction prevention

## Notifications

* Push notification support
* Firebase Cloud Messaging integration
* Real-time alerts
* Admin announcements

## Real-time Infrastructure

* Firestore + Realtime Database support
* Live updates
* Match synchronization
* Tournament state management

## Security

* Environment variable protection
* OAuth credential isolation
* Secure backend validation
* Anti-duplicate verification logic

---

# Tech Stack

* Node.js
* Express.js
* Firebase
* Firestore
* Firebase Realtime Database
* Gmail API
* Render Deployment
* Google OAuth2
* Cron Jobs
* REST APIs

---

# Environment Variables

Example configuration:

```env
PORT=8080

FIREBASE_PROJECT_ID=pgr-battle
FIREBASE_PRIVATE_KEY_ID=
FIREBASE_PRIVATE_KEY=
FIREBASE_CLIENT_EMAIL=
FIREBASE_CLIENT_ID=
FIREBASE_DATABASE_URL=

GMAIL_CLIENT_ID=
GMAIL_CLIENT_SECRET=
GMAIL_REDIRECT_URI=
GMAIL_REFRESH_TOKEN=

JWT_SECRET=
```

---

# Deployment

Backend is optimized for:

* Render
* VPS Deployments
* Docker-based environments

---

# API Status

Health routes:

```bash
GET /
GET /status
```

---

# Gmail Integration

Supports:

* Automatic Gmail parsing
* OAuth token refresh
* Deposit email verification
* Transaction extraction

Supported sender example:

```txt
no-reply@famapp.in
```

---

# Security Notice

Sensitive files are never intended for public exposure.

Do NOT upload:

* OAuth tokens
* Firebase service accounts
* Secret keys
* Production credentials

Use environment variables instead.

---

# Development

Install dependencies:

```bash
npm install
```

Run development server:

```bash
npm run dev
```

Run production:

```bash
npm start
```

---

# Status

Backend currently supports:

* Production Render deployment
* Gmail verification services
* Real-time infrastructure
* Notification systems
* Firebase integration

---

# Author

Developed by Daksh Dagar

GitHub:
https://github.com/DakshDagar001
