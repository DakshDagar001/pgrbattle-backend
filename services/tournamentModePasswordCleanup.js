/**
 * Removes the legacy tournament-mode password field.
 *
 * Mode access is authenticated but not password-gated. The old field was copied into every
 * client-readable mode document and compared on the client, so retaining it would keep a
 * plaintext secret in the database even after the UI stopped using it.
 */

const COLLECTION = 'tournamentModes';

async function removeLegacyModePasswords({ db, admin } = {}) {
  if (!db || !admin) throw new Error('removeLegacyModePasswords requires db and admin');

  const snapshot = await db.collection(COLLECTION).get();
  const documents = (snapshot.docs || []).filter(document => {
    const data = document.data() || {};
    return Object.prototype.hasOwnProperty.call(data, 'entryPassword');
  });

  for (let index = 0; index < documents.length; index += 450) {
    const batch = db.batch();
    documents.slice(index, index + 450).forEach(document => {
      batch.update(document.ref, {
        entryPassword: admin.firestore.FieldValue.delete(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });
    await batch.commit();
  }

  return { scanned: (snapshot.docs || []).length, cleaned: documents.length };
}

module.exports = { removeLegacyModePasswords, COLLECTION };
