/**
 * The device gate every protected organizer operation goes through.
 *
 * One definition, used by the withdrawal route and by the trusted tournament route, so an
 * operation can never be protected by a subtly different rule than its neighbour. The contract is
 * the `X-Device-Id` header the Organizer app already sends, and the organizer is always the
 * verified caller - never a body field.
 *
 * Four cases, and each exists for a reason:
 *
 * - an approved device - allowed;
 * - an organizer with no binding at all - allowed, because enrolling a first device is
 *   self-service for exactly this case and refusing here would be a wall an attacker walks
 *   around one call earlier. It stops being true the moment a binding exists;
 * - a *different* device than the approved one - refused, whether or not a request is pending;
 * - no usable identifier while a binding exists - refused. This is the case that would
 *   otherwise be the bypass: an unapproved phone that simply omits the header must not sail
 *   past a check that only looks at a header when one arrives.
 *
 * A check that cannot be completed refuses rather than allowing: no protected operation is
 * carried out on an assumption about who is holding the phone.
 */

/** The same bound the device routes put on the header, so one app cannot pass in one call. */
const MAX_HEADER_LENGTH = 128;

/**
 * @param {object} deps
 * @param {object} deps.devices  `createOrganizerDeviceService()` instance, or a lazy proxy of one
 */
function createOrganizerDeviceGate({ devices, maxHeaderLength = MAX_HEADER_LENGTH } = {}) {
  if (!devices) throw new Error('createOrganizerDeviceGate requires a device service');

  /** The caller's declared device, read the same way the device router reads it. */
  function declaredDevice(req) {
    const raw = req && req.headers ? req.headers['x-device-id'] : '';
    if (typeof raw !== 'string') return '';
    return raw.trim().slice(0, maxHeaderLength);
  }

  /** `null` to let the request through, or the refusal to answer with. */
  async function check(req) {
    const deviceId = declaredDevice(req);
    const result = await devices.requireApprovedDevice({
      organizerUid: req.user.uid, deviceId
    });

    if (result.ok === true) return null;
    if (result.code === 'ENROLLMENT_REQUIRED') return null;

    if (result.code === 'DEVICE_ID_INVALID' || result.code === 'ORGANIZER_UID_INVALID') {
      // An old build that has never enrolled still has to be able to work.
      const binding = await devices.bindingOf({ organizerUid: req.user.uid });
      if (binding.code === 'NO_BINDING') return null;
    }

    return result;
  }

  /** How a device refusal reads over HTTP. */
  function status(code) {
    if (code === 'DEVICE_NOT_APPROVED') return 403;
    if (code === 'TRANSIENT_FAILURE') return 503;
    if (code === 'ORGANIZER_BANNED' || code === 'ORGANIZER_INACTIVE' || code === 'NOT_AN_ORGANIZER') {
      return 403;
    }
    return 400;
  }

  return { declaredDevice, check, status };
}

module.exports = { createOrganizerDeviceGate, MAX_HEADER_LENGTH };
