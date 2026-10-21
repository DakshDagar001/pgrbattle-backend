/**
 * Authentication policy helpers.
 *
 * Pure, dependency-free rules shared by the auth routes so username
 * normalisation and region resolution behave identically on every caller.
 */

// Supported server regions. Keep in sync with the player app's
// PhoneNumberUtils.supportedRegions and the country codes +91/+92/+977/+880.
const SUPPORTED_REGIONS = [
  { name: 'India', code: 'IN', callingCode: '+91', nationalLength: 10 },
  { name: 'Pakistan', code: 'PK', callingCode: '+92', nationalLength: 10 },
  { name: 'Nepal', code: 'NP', callingCode: '+977', nationalLength: 10 },
  { name: 'Bangladesh', code: 'BD', callingCode: '+880', nationalLength: 10 }
];

const REGION_BY_CALLING_CODE = new Map(
  SUPPORTED_REGIONS.map(region => [region.callingCode, region.code])
);

const USERNAME_PATTERN = /^[a-z0-9_]{3,20}$/;

/**
 * A phone number is the only authoritative input for region assignment.
 * Longest calling code wins so +977 is never mistaken for +9.
 */
function regionForPhone(phoneNumber) {
  if (typeof phoneNumber !== 'string') return null;
  const prefix = [...REGION_BY_CALLING_CODE.keys()]
    .sort((a, b) => b.length - a.length)
    .find(value => phoneNumber.startsWith(value));
  return prefix ? { callingCode: prefix, region: REGION_BY_CALLING_CODE.get(prefix) } : null;
}

/**
 * Usernames are stored and compared case-insensitively. The normalized value
 * doubles as the `usernames/{docId}` key, so it must also be document-id safe.
 */
function normalizeUsername(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().toLowerCase();
}

function isValidUsername(normalized) {
  return USERNAME_PATTERN.test(normalized) && normalized !== '.' && normalized !== '..';
}

/**
 * Region lookup used to validate a client's requested server region. Returns the
 * canonical region record or null for anything unsupported.
 */
function regionByCode(code) {
  if (typeof code !== 'string') return null;
  const needle = code.trim().toUpperCase();
  return SUPPORTED_REGIONS.find(region => region.code === needle) || null;
}

function regionByCallingCode(callingCode) {
  if (typeof callingCode !== 'string') return null;
  const needle = callingCode.trim();
  const normalized = needle.startsWith('+') ? needle : `+${needle}`;
  return SUPPORTED_REGIONS.find(region => region.callingCode === normalized) || null;
}

module.exports = {
  SUPPORTED_REGIONS,
  REGION_BY_CALLING_CODE,
  normalizeUsername,
  isValidUsername,
  regionForPhone,
  regionByCode,
  regionByCallingCode
};
