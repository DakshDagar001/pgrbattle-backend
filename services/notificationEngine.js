const admin = require('firebase-admin');

/**
 * Enterprise Notification Engine (FCM)
 * Handles dispatching push notifications via Firebase Cloud Messaging.
 */

function replacePlaceholders(text, params) {
  if (!text) return text;
  return text.replace(/\{\{([A-Z_]+)\}\}/g, (match, key) => {
    return params[key] !== undefined ? params[key] : match;
  });
}

/**
 * Sends an FCM notification to a specific user by their ID.
 * Resolves their FCM tokens from Firestore and sends the message.
 *
 * @param {string} userId
 * @param {string} title
 * @param {string} body
 * @param {object} data
 */
async function notifyUser(userId, title, body, data = {}) {
  try {
    const userDoc = await admin.firestore().collection('users').doc(userId).get();
    if (!userDoc.exists) return { success: false, error: 'User not found' };

    const userData = userDoc.data();
    const fcmTokens = userData.fcmTokens || [];

    if (!fcmTokens.length) {
      return { success: false, error: 'No FCM tokens for user' };
    }

    const params = {
      USERNAME: userData.name || userData.username || 'User',
      EMAIL: userData.email || '',
      ...data
    };

    const messages = fcmTokens.map(token => ({ token, params }));
    return await sendPersonalized(messages, title, body, data);
  } catch (err) {
    console.error(`[NotificationEngine] Error notifying user ${userId}:`, err);
    return { success: false, error: err.message };
  }
}

/**
 * Sends a multicast FCM notification to an array of tokens (unpersonalized fallback).
 */
async function sendMulticast(tokens, title, body, data = {}) {
  const messages = tokens.map(token => ({ token, params: data }));
  return await sendPersonalized(messages, title, body, data);
}

/**
 * Sends personalized messages to specific tokens using FCM sendEach().
 * @param {Array<{token: string, params: object}>} tokenDataList 
 */
async function sendPersonalized(tokenDataList, titleTemplate, bodyTemplate, extraData = {}) {
  // Deduplicate by token keeping first occurrence
  const seen = new Set();
  const uniqueList = tokenDataList.filter(item => {
    if (!item.token || seen.has(item.token)) return false;
    seen.add(item.token);
    return true;
  });

  if (!uniqueList.length) return { success: false, sentTo: 0, error: 'No tokens provided' };

  let successCount = 0;
  let failureCount = 0;
  const errors = [];

  // Batch tokens in chunks of 500 (FCM limit for sendEach)
  for (let i = 0; i < uniqueList.length; i += 500) {
    const chunk = uniqueList.slice(i, i + 500);
    const messages = chunk.map(item => ({
      token: item.token,
      notification: { 
        title: replacePlaceholders(titleTemplate, item.params), 
        body: replacePlaceholders(bodyTemplate, item.params) 
      },
      data: Object.fromEntries(
        Object.entries(extraData).map(([key, value]) => [key, String(value ?? "")])
      ),
      android: {
        priority: 'high',
        notification: {
          channelId: 'pgr_battle_notifications'
        }
      }
    }));

    const response = await admin.messaging().sendEach(messages);

    successCount += response.successCount;
    failureCount += response.failureCount;

    response.responses.forEach((res, idx) => {
      if (!res.success) {
        errors.push(`${chunk[idx].token}: ${res.error?.message || 'Unknown error'}`);
      }
    });
  }

  return {
    success: successCount > 0,
    sentTo: successCount,
    failed: failureCount,
    errors: errors.slice(0, 10)
  };
}

/**
 * Sends notification to multiple users.
 */
async function notifyUsers(userIds, title, body, data = {}) {
  let allTokenData = [];
  
  // Chunk users to respect Firestore limits
  for (let i = 0; i < userIds.length; i += 10) {
    const chunk = userIds.slice(i, i + 10);
    const snap = await admin.firestore().collection('users')
      .where(admin.firestore.FieldPath.documentId(), 'in', chunk)
      .get();
      
    snap.forEach(doc => {
      const userData = doc.data();
      const fcmTokens = userData.fcmTokens || [];
      const params = {
        USERNAME: userData.name || userData.username || 'User',
        EMAIL: userData.email || '',
        ...data
      };
      fcmTokens.forEach(token => {
        allTokenData.push({ token, params });
      });
    });
  }
  
  return await sendPersonalized(allTokenData, title, body, data);
}

/**
 * Sends notification to all participants of a tournament.
 */
async function notifyTournament(tournamentId, title, body, data = {}) {
  try {
    const participantsSnap = await admin.firestore()
      .collection('tournaments')
      .doc(tournamentId)
      .collection('participants')
      .get();
      
    const userIds = participantsSnap.docs
      .map(d => d.get('odcUid') || d.id)
      .filter(Boolean);
      
    if (!userIds.length) return { success: false, sentTo: 0, error: 'No participants' };
    
    return await notifyUsers(userIds, title, body, { ...data, tournamentId });
  } catch (err) {
    console.error(`[NotificationEngine] Error notifying tournament ${tournamentId}:`, err);
    return { success: false, error: err.message };
  }
}

/**
 * Sends notification to all users.
 */
async function notifyAll(title, body, data = {}) {
  try {
    const usersSnap = await admin.firestore().collection('users').get();
    let allTokenData = [];
    
    usersSnap.forEach(doc => {
      const userData = doc.data();
      const fcmTokens = userData.fcmTokens || [];
      const params = {
        USERNAME: userData.name || userData.username || 'User',
        EMAIL: userData.email || '',
        ...data
      };
      fcmTokens.forEach(token => {
        allTokenData.push({ token, params });
      });
    });
    
    return await sendPersonalized(allTokenData, title, body, data);
  } catch (err) {
    console.error(`[NotificationEngine] Error notifying all:`, err);
    return { success: false, error: err.message };
  }
}

/**
 * Dispatches a notification based on standard request format.
 */
async function dispatchNotification({ type, title, message, selectedUsers = [], tournamentId = null }) {
  let result;
  
  if (type === 'all') {
    result = await notifyAll(title, message, { type });
  } else if (type === 'selected') {
    result = await notifyUsers(selectedUsers, title, message, { type });
  } else if (type === 'tournament') {
    if (!tournamentId) throw new Error('Tournament ID required');
    result = await notifyTournament(tournamentId, title, message, { type });
  } else {
    throw new Error(`Invalid notification type: ${type}`);
  }
  
  return result;
}

module.exports = {
  notifyUser,
  notifyUsers,
  notifyTournament,
  notifyAll,
  dispatchNotification,
  sendMulticast
};
