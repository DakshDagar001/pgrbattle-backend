/**
 * Gmail Service
 *
 * Initialises a Gmail API client using OAuth2 credentials and provides
 * a function to fetch payment-related emails from FamPay.
 *
 * Credential sources: Environment variables GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REDIRECT_URI, GMAIL_REFRESH_TOKEN
 */

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

// ── State ──────────────────────────────────────────────────────────────────────
let gmail = null;
let oauth2Client = null;

/** Set of Gmail message IDs that have already been fetched & returned. */
const processedMessageIds = new Set();

// ── Paths ──────────────────────────────────────────────────────────────────────
const CREDENTIALS_PATH = path.join(__dirname, '..', 'config', 'gmail-oauth.json');
const TOKEN_PATH = path.join(__dirname, '..', 'token.json');

// ── Initialisation ─────────────────────────────────────────────────────────────

/**
 * Build the OAuth2 client and bootstrap the Gmail API instance.
 * Safe to call multiple times – subsequent calls are no-ops.
 */
function initGmail() {
  if (gmail) return; // already initialised

  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const redirectUri = process.env.GMAIL_REDIRECT_URI;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !redirectUri || !refreshToken) {
    throw new Error('Missing one or more required Gmail environment variables.');
  }

  oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  
  // Set credentials from environment
  oauth2Client.setCredentials({
    refresh_token: refreshToken
  });

  // Listen for automatic token refreshes
  oauth2Client.on('tokens', (newTokens) => {
    console.log('[Gmail] Token refreshed successfully');
    // Note: In a robust setup, you might want to save the new refresh_token back to your DB/Env if it changes.
  });

  // Create Gmail client
  gmail = google.gmail({ version: 'v1', auth: oauth2Client });
  console.log('[Gmail] Service initialised successfully');
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Decode a base64url-encoded string (used by the Gmail API for message parts).
 */
function decodeBase64Url(data) {
  if (!data) return '';
  // Replace URL-safe chars and add padding
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(base64, 'base64').toString('utf8');
}

/**
 * Walk the payload tree and return the body text for the requested mimeType.
 * Gmail nests parts inside parts for multipart messages.
 */
function extractBodyFromPayload(payload, mimeType) {
  if (!payload) return '';

  // Simple single-part message
  if (payload.mimeType === mimeType && payload.body && payload.body.data) {
    return decodeBase64Url(payload.body.data);
  }

  // Multipart – recurse through parts
  if (payload.parts && payload.parts.length) {
    for (const part of payload.parts) {
      const result = extractBodyFromPayload(part, mimeType);
      if (result) return result;
    }
  }

  return '';
}

/**
 * Extract the internal date (or fallback to header Date) as epoch ms.
 */
function getReceivedAt(messageData) {
  if (messageData.internalDate) {
    return parseInt(messageData.internalDate, 10);
  }
  const dateHeader = (messageData.payload.headers || []).find(
    (h) => h.name.toLowerCase() === 'date'
  );
  if (dateHeader) {
    return new Date(dateHeader.value).getTime();
  }
  return Date.now();
}

/**
 * Get the Subject header from a message.
 */
function getSubject(messageData) {
  const subjectHeader = (messageData.payload.headers || []).find(
    (h) => h.name.toLowerCase() === 'subject'
  );
  return subjectHeader ? subjectHeader.value : '';
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Fetch payment emails from FamPay received after `sinceTimestamp` (epoch ms).
 *
 * @param {number} sinceTimestamp – Unix epoch **milliseconds**
 * @returns {Promise<Array<{messageId: string, body: string, subject: string, snippet: string, receivedAt: number}>>}
 */
async function fetchLatestPaymentEmails(sinceTimestamp) {
  if (!gmail) {
    initGmail(); // lazy-init if caller forgot
  }

  const sinceEpochSeconds = Math.floor((sinceTimestamp || 0) / 1000);
  const query = `from:no-reply@famapp.in after:${sinceEpochSeconds}`;

  console.log('[Gmail] Querying:', query);

  try {
    const listRes = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: 20
    });

    const messages = listRes.data.messages;
    if (!messages || messages.length === 0) {
      console.log('[Gmail] No new payment emails found');
      return [];
    }

    console.log(`[Gmail] Found ${messages.length} message(s), filtering already-processed`);

    const results = [];

    for (const msgMeta of messages) {
      // Skip messages we have already returned in a previous call
      if (processedMessageIds.has(msgMeta.id)) {
        continue;
      }

      try {
        const msgRes = await gmail.users.messages.get({
          userId: 'me',
          id: msgMeta.id,
          format: 'full'
        });

        const msgData = msgRes.data;

        // Prefer plain text, fall back to HTML
        let body = extractBodyFromPayload(msgData.payload, 'text/plain');
        if (!body) {
          body = extractBodyFromPayload(msgData.payload, 'text/html');
        }

        const subject = getSubject(msgData);
        const receivedAt = getReceivedAt(msgData);

        results.push({
          messageId: msgMeta.id,
          body,
          subject,
          snippet: msgData.snippet || '',
          receivedAt
        });

        // Mark as processed so future calls skip it
        processedMessageIds.add(msgMeta.id);
      } catch (msgErr) {
        console.error(`[Gmail] Failed to fetch message ${msgMeta.id}:`, msgErr.message);
        // Continue with remaining messages
      }
    }

    console.log(`[Gmail] Returning ${results.length} new email(s)`);
    return results;
  } catch (err) {
    console.error('[Gmail] Failed to list messages:', err.message);
    // If the error is an auth issue, try to provide a clearer message
    if (err.code === 401 || err.code === 403) {
      console.error('[Gmail] Authentication error – token may need to be regenerated');
    }
    throw err;
  }
}

module.exports = {
  initGmail,
  fetchLatestPaymentEmails
};
