/**
 * The project's existing audit trail, written from the trusted backend (Phase 9).
 *
 * This is not a new logging system. `transcripts/{section}/entries/{transcriptId}` is how every
 * administrative act in PGR Battle has always been recorded - bans, tournaments, results, banners,
 * users, deleted users and the emulator HWID resets - and the Admin app already has a screen that
 * reads it. A second, parallel audit collection would have meant a second thing to reconcile, so
 * the fields written here are exactly the nine the live rules already require
 * (`firestore.rules`, "TRANSCRIPTS COLLECTION"), which is also what lets a new section appear in
 * the existing screen without a schema change anywhere.
 *
 * Two rules of the phase shape the rest of this file:
 *
 * - A privileged operation is recorded by the backend that performed it, not by the app that
 *   asked for it. An organizer's client cannot reach this code with someone else's identity, and
 *   the transcript rows themselves are immutable for every client (`allow update, delete: false`).
 * - An audit failure never turns a committed operation into a reported success. Nothing here
 *   throws into a financial path: the answer is always `{ recorded, ... }`, and a caller that has
 *   already moved coins keeps its outcome and passes `recorded: false` through to the screen,
 *   where it is shown as what it is - a decision that happened but was not written down.
 */

/** The sections this project already uses, plus the three this phase adds. */
const SECTIONS = {
  BANS: 'bans',
  TOURNAMENTS: 'tournaments',
  TOURNAMENT_MODES: 'tournament_modes',
  RESULTS: 'results',
  BANNERS: 'banners',
  HWID: 'hwid',
  USERS: 'users',
  DELETED_USERS: 'deleted_users',
  ORGANIZERS: 'organizers',
  ORGANIZER_DEVICES: 'organizer_devices',
  ORGANIZER_ECONOMY: 'organizer_economy'
};

const ROOT_COLLECTION = 'transcripts';
const ENTRY_SUBCOLLECTION = 'entries';

/**
 * Anything whose name suggests a credential is dropped before it is written.
 *
 * A transcript is read by every admin account and exported to plain text by the Admin app, so an
 * authentication token, a PIN or a password that happens to ride in on some payload would become
 * a leaked secret in the audit record itself. The match is on the key name, because a value that
 * is already described as a `password` is not something this file is ever going to want.
 */
const SECRET_KEY_PATTERN = /(pass(word|wd)?|pin|otp|secret|token|authorization|api[-_]?key|credential)s?$/i;

/** The actor roles the existing rows already use, so nothing here invents a third. */
const ACTOR_ROLES = ['admin', 'organizer', 'system', 'backend'];

/** Bounded, because a log line is not a place to store a document. */
const MAX_TEXT = 300;
const MAX_PAYLOAD_KEYS = 24;

/**
 * The most documents one read will look at, whatever it was asked for.
 *
 * A page is a page: the same ceiling holds whether the read is the newest rows of a section or a
 * scan widened to find one organizer's older ones.
 */
const MAX_SCAN = 200;

function text(value, max = MAX_TEXT) {
  if (typeof value === 'string') return value.slice(0, max);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/**
 * A payload the record can safely carry: flat scalars only, named keys, no secrets.
 *
 * A nested object or an array would render as `[object Object]` in the Admin screen's text view,
 * which is an unreadable log rather than a safe one, so anything that is not a scalar is
 * summarised by type. That keeps the ledger reference, the tournament id and the decision - which
 * is all an audit row is for - and leaves the data itself in the collection that owns it.
 */
function sanitizePayload(payload) {
  const clean = {};
  if (!payload || typeof payload !== 'object') return clean;
  let redacted = 0;

  for (const [rawKey, rawValue] of Object.entries(payload)) {
    const key = text(rawKey, 60);
    if (!key) continue;
    if (SECRET_KEY_PATTERN.test(key)) {
      redacted += 1;
      continue;
    }
    if (Object.keys(clean).length >= MAX_PAYLOAD_KEYS) break;

    if (rawValue === null || rawValue === undefined) {
      clean[key] = null;
    } else if (typeof rawValue === 'number' || typeof rawValue === 'boolean') {
      clean[key] = rawValue;
    } else if (typeof rawValue === 'string') {
      clean[key] = rawValue.slice(0, MAX_TEXT);
    } else if (Array.isArray(rawValue)) {
      clean[key] = `${rawValue.length} item(s)`;
    } else {
      clean[key] = 'object';
    }
  }

  if (redacted > 0) clean.redactedKeys = `${redacted} secret-shaped key(s) not stored`;
  return clean;
}

/**
 * @param {object} deps
 * @param {object} deps.db                Firestore handle (Admin SDK) - the only writer
 * @param {Function} deps.serverTimestamp  the server clock behind every recorded event
 */
function createAuditTrail({ db, serverTimestamp } = {}) {
  if (!db || !serverTimestamp) {
    throw new Error('createAuditTrail requires db and serverTimestamp');
  }

  /**
   * Append one event.
   *
   * Resolves, never rejects: a caller that has already committed a wallet movement must be able
   * to report the truth about it whether or not this write landed. `recorded: false` is the
   * signal the phase asks for, and it is the caller's job to put it in front of a human.
   */
  async function record({
    section,
    actionType,
    title,
    payload,
    performedBy = 'admin',
    performerId = '',
    performerEmail = ''
  } = {}) {
    const knownSection = text(section, 60);
    const knownAction = text(actionType, 60);
    if (!knownSection || !knownAction) {
      return { recorded: false, error: 'A transcript needs a section and an action type.' };
    }

    let docRef = null;

    try {
      docRef = db.collection(ROOT_COLLECTION)
        .document(knownSection)
        .collection(ENTRY_SUBCOLLECTION)
        .doc();

      // The clock is called inside the guard, not outside it: a server timestamp that cannot be
      // resolved is exactly the kind of infrastructure failure this function must not let reach a
      // caller that has already moved coins.
      const entry = {
        // The row repeats its own id because the rules require the field and the existing screen
        // prints it; `docRef.id` is the Firestore auto-id, so this matches every older row.
        transcriptId: docRef.id,
        section: knownSection,
        actionType: knownAction,
        title: text(title, MAX_TEXT) || knownAction,
        payload: sanitizePayload(payload),
        performedBy: ACTOR_ROLES.includes(performedBy) ? performedBy : 'admin',
        performerId: text(performerId, 128),
        performerEmail: text(performerEmail, 200),
        createdAt: serverTimestamp()
      };

      await docRef.set(entry);
      return { recorded: true, transcriptId: docRef.id };
    } catch (error) {
      console.error(`[AuditTrail] Could not record ${knownSection}/${knownAction}:`, error.message);
      return { recorded: false, error: error.message };
    }
  }

  /**
   * A bounded page of one section, newest first.
   *
   * The Admin screen already reads a section with `orderBy createdAt desc limit 300`; this is the
   * same shape for the routes that answer for the dashboard, so a history is always a page and
   * never a collection.
   */
  async function list({ section, limit = 50, filterOrganizerUid = '' } = {}) {
    const knownSection = text(section, 60);
    if (!knownSection) {
      return { code: 'SECTION_REQUIRED', entries: [], total: 0, scanned: 0, truncated: false };
    }

    const cap = Math.min(Math.max(Number(limit) || 0, 1), MAX_SCAN);
    /*
     * A section read for one organizer is widened before it is cut.
     *
     * The newest page of a section belongs to whoever acted most recently, so asking for the newest
     * 20 rows and then dropping the ones that are not this organizer's would report "no activity"
     * for an account whose rows are merely older than twenty other people's - a false zero, which is
     * the one thing this screen is not allowed to invent. `scanned` and `truncated` travel with the
     * page so a caller can say "no matching rows in the newest N" instead of "none".
     */
    const scanCap = filterOrganizerUid ? Math.min(cap * 4, MAX_SCAN) : cap;
    const snapshot = await db.collection(ROOT_COLLECTION)
      .document(knownSection)
      .collection(ENTRY_SUBCOLLECTION)
      .orderBy('createdAt', 'desc')
      .limit(scanCap)
      .get();

    const entries = [];
    let scanned = 0;
    for (const doc of snapshot.docs || []) {
      scanned += 1;
      const data = (doc.data && doc.data()) || {};
      const organizerUid = text(data.payload && data.payload.organizerUid, 128);
      // An organizer's own history is their own rows. The dashboard asks per organizer, and the
      // filter happens here rather than in a query so the single-field orderBy index the screen
      // already uses stays the only one needed.
      if (filterOrganizerUid && organizerUid !== filterOrganizerUid) continue;
      entries.push({
        transcriptId: text(data.transcriptId, 128) || doc.id,
        section: knownSection,
        actionType: text(data.actionType, 60),
        title: text(data.title, MAX_TEXT),
        payload: (data.payload && typeof data.payload === 'object') ? data.payload : {},
        performedBy: text(data.performedBy, 40),
        performerId: text(data.performerId, 128),
        performerEmail: text(data.performerEmail, 200),
        createdAt: timeOf(data.createdAt)
      });
      if (entries.length >= cap) break;
    }

    return {
      code: 'COMPLETE',
      section: knownSection,
      entries,
      total: entries.length,
      scanned,
      // True when the read stopped at its own ceiling, which is the only case in which "nothing
      // else matched" would be a claim this function has not checked.
      truncated: scanned >= scanCap
    };
  }

  return { record, list, SECTIONS };
}

/** A written event time as milliseconds, or null when the write has not resolved yet. */
function timeOf(value) {
  if (!value) return null;
  if (typeof value.toMillis === 'function') {
    const ms = value.toMillis();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value.seconds === 'number') {
    return value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1e6);
  }
  return null;
}

module.exports = { createAuditTrail, SECTIONS };
