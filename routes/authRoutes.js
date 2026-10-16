const express = require('express');
const admin = require('firebase-admin');
const { verifyAuth } = require('../middleware/auth');

const router = express.Router();
const REGIONS = new Map([
  ['+91', 'IN'],
  ['+92', 'PK'],
  ['+977', 'NP'],
  ['+880', 'BD']
]);

function regionForPhone(phoneNumber) {
  if (typeof phoneNumber !== 'string') return null;
  const prefix = [...REGIONS.keys()].sort((a, b) => b.length - a.length)
    .find(value => phoneNumber.startsWith(value));
  return prefix ? { callingCode: prefix, region: REGIONS.get(prefix) } : null;
}

router.post('/assign-region', verifyAuth, async (req, res) => {
  const assignment = regionForPhone(req.user.phoneNumber);
  if (!assignment) {
    return res.status(400).json({ success: false, message: 'A supported verified phone number is required.' });
  }

  try {
    const userRef = admin.firestore().collection('users').doc(req.user.uid);
    const phoneRef = admin.firestore().collection('phoneNumbers').doc(req.user.phoneNumber);
    await admin.firestore().runTransaction(async transaction => {
      const phoneSnapshot = await transaction.get(phoneRef);
      if (phoneSnapshot.exists && phoneSnapshot.data().uid !== req.user.uid) {
        const error = new Error('PHONE_ALREADY_ASSIGNED');
        error.code = 'PHONE_ALREADY_ASSIGNED';
        throw error;
      }
      transaction.set(phoneRef, {
        uid: req.user.uid,
        phoneNumber: req.user.phoneNumber,
        region: assignment.region,
        createdAt: phoneSnapshot.exists
          ? phoneSnapshot.data().createdAt
          : admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      transaction.set(userRef, {
        phone: req.user.phoneNumber,
        phoneVerified: true,
        phoneRegion: assignment.region
      }, { merge: true });
    });
    return res.json({ success: true, region: assignment.region });
  } catch (error) {
    if (error.code === 'PHONE_ALREADY_ASSIGNED') {
      return res.status(409).json({ success: false, message: 'That phone number is already registered.' });
    }
    console.error('[Auth] Region assignment failed:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to assign account region.' });
  }
});

module.exports = router;
