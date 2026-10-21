const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SUPPORTED_REGIONS,
  normalizeUsername,
  isValidUsername,
  regionForPhone,
  regionByCode,
  regionByCallingCode
} = require('../services/authPolicy');

test('username normalization makes case-insensitivity explicit', () => {
  assert.equal(normalizeUsername('  Daksh_2028  '), 'daksh_2028');
  assert.equal(normalizeUsername('DAKSH'), 'daksh');
  assert.equal(normalizeUsername('daksh'), 'daksh');
  assert.equal(normalizeUsername(undefined), '');
  assert.equal(normalizeUsername(null), '');
});

test('username syntax policy matches the client rule', () => {
  assert.equal(isValidUsername('daksh'), true);
  assert.equal(isValidUsername('daksh_2028'), true);
  assert.equal(isValidUsername('ab'), false);
  assert.equal(isValidUsername('a'.repeat(21)), false);
  assert.equal(isValidUsername('dak sh'), false);
  assert.equal(isValidUsername('dak-sh'), false);
  assert.equal(isValidUsername('dak.sh'), false);
  assert.equal(isValidUsername('.'), false);
  assert.equal(isValidUsername('..'), false);
  assert.equal(isValidUsername(normalizeUsername(' Daksh ')), true);
});

test('only the four supported calling codes resolve a region', () => {
  assert.deepEqual(SUPPORTED_REGIONS.map(region => region.callingCode), ['+91', '+92', '+977', '+880']);
  assert.deepEqual(regionForPhone('+919876543210'), { callingCode: '+91', region: 'IN' });
  assert.deepEqual(regionForPhone('+923012345678'), { callingCode: '+92', region: 'PK' });
  assert.deepEqual(regionForPhone('+9779812345678'), { callingCode: '+977', region: 'NP' });
  assert.deepEqual(regionForPhone('+8801712345678'), { callingCode: '+880', region: 'BD' });
});

test('region resolution rejects unsupported and malformed numbers', () => {
  assert.equal(regionForPhone('+14155552671'), null);
  assert.equal(regionForPhone('9876543210'), null);
  assert.equal(regionForPhone(''), null);
  assert.equal(regionForPhone(undefined), null);
  assert.equal(regionForPhone(null), null);
  assert.deepEqual(regionForPhone('+9771234'), { callingCode: '+977', region: 'NP' });
});

test('region lookups by code and calling code are case tolerant', () => {
  assert.equal(regionByCode('in').name, 'India');
  assert.equal(regionByCode(' NP ').name, 'Nepal');
  assert.equal(regionByCode('XX'), null);
  assert.equal(regionByCode(123), null);
  assert.equal(regionByCallingCode('91').name, 'India');
  assert.equal(regionByCallingCode('+880').code, 'BD');
  assert.equal(regionByCallingCode('+1'), null);
});
