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

/** Track consecutive auth failures to avoid infinite retry loops. */
let consecutiveAuthFailures = 0;
const MAX_AUTH_FAILURES = 3;

/** Set of Gmail message IDs that have already been fetched & returned. */
const processedMessageIds = new Set();

// ── Initialisation ─────────────────────────────────────────────────────────────

/**
 * Sanitize a credential string – strip whitespace, newlines, carriage returns.
 * This prevents "Invalid Header" errors caused by trailing \n or \r in env vars.
 */
function sanitizeCredential(value) {
  if (!value) return value;
  return value.replace(/[\r\n]+/g, '').trim();
}

/**
 * Build the OAuth2 client and bootstrap the Gmail API instance.
 * Safe to call multiple times – subsequent calls are no-ops unless forceReinit is true.
 *
 * @param {boolean} forceReinit – if true, tear down existing client and rebuild
 */
function initGmail(forceReinit = false) {
  if (gmail && !forceReinit) return; // already initialised

  // Tear down existing client if force-reiniting
  if (forceReinit) {
    gmail = null;
    oauth2Client = null;
    console.log('[Gmail] Force re-initialising client');
  }

  // Sanitize credentials to prevent Invalid Header errors
  const clientId = sanitizeCredential(process.env.GMAIL_CLIENT_ID);
  const clientSecret = sanitizeCredential(process.env.GMAIL_CLIENT_SECRET);
  const redirectUri = sanitizeCredential(process.env.GMAIL_REDIRECT_URI);
  const refreshToken = sanitizeCredential(process.env.GMAIL_REFRESH_TOKEN);

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
    consecutiveAuthFailures = 0; // reset failure counter on success
  });

  // Create Gmail client
  gmail = google.gmail({ version: 'v1', auth: oauth2Client });
  console.log('[Gmail] Service initialised successfully');
}

/**
 * Force the OAuth2 client to refresh its access token.
 * Call this when encountering auth-related errors.
 */
async function forceTokenRefresh() {
  if (!oauth2Client) {
    console.error('[Gmail] Cannot refresh token – OAuth2 client not initialised');
    return false;
  }
  try {
    console.log('[Gmail] Forcing access token refresh...');
    const { credentials } = await oauth2Client.refreshAccessToken();
    oauth2Client.setCredentials(credentials);
    console.log('[Gmail] Access token refreshed successfully');
    consecutiveAuthFailures = 0;
    return true;
  } catch (err) {
    console.error('[Gmail] Force token refresh failed:', err.message);
    return false;
  }
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

/**
 * Check if an error is related to auth / header issues.
 */
function isAuthOrHeaderError(err) {
  const msg = (err.message || '').toLowerCase();
  const code = err.code || err.status || 0;
  return (
    code === 401 || code === 403 ||
    msg.includes('invalid header') ||
    msg.includes('invalid_grant') ||
    msg.includes('token') ||
    msg.includes('unauthorized') ||
    msg.includes('forbidden')
  );
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Fetch payment emails from FamPay received after `sinceTimestamp` (epoch ms).
 *
 * Includes retry logic: on auth/header errors, force-refreshes the token
 * and retries once. On persistent failure, re-initialises the entire Gmail client.
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

  // Attempt up to 2 tries: first with current token, second after refresh
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const listRes = await gmail.users.messages.list({
        userId: 'me',
        q: query,
        maxResults: 20
      });

      const messages = listRes.data.messages;
      if (!messages || messages.length === 0) {
        consecutiveAuthFailures = 0; // API call succeeded
        return [];
      }

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

      // Success – reset failure counter
      consecutiveAuthFailures = 0;
      console.log(`[Gmail] Returning ${results.length} new email(s)`);
      return results;

    } catch (err) {
      console.error(`[Gmail] Attempt ${attempt} failed:`, err.message);

      if (isAuthOrHeaderError(err) && attempt === 1) {
        // First failure – try refreshing the token
        consecutiveAuthFailures++;
        console.warn(`[Gmail] Auth/header error detected (consecutive: ${consecutiveAuthFailures}). Refreshing token...`);

        const refreshed = await forceTokenRefresh();
        if (!refreshed && consecutiveAuthFailures >= MAX_AUTH_FAILURES) {
          // Multiple consecutive failures – full re-init
          console.warn('[Gmail] Multiple auth failures – re-initialising Gmail client');
          initGmail(true);
        }
        // Loop continues to attempt 2
      } else {
        // Non-auth error or second attempt failed
        consecutiveAuthFailures++;
        throw err;
      }
    }
  }

  // Should not reach here, but just in case
  return [];
}

module.exports = {
  initGmail,
  fetchLatestPaymentEmails
};
