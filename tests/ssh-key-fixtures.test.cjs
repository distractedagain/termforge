'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { utils } = require('ssh2');
const { generateEd25519Fixture } = require('../scripts/ssh-key-fixtures.cjs');
const leadingZeroEd25519 = require('./fixtures/leading-zero-ed25519.cjs');

test('fixture helper retries only the known truncated Ed25519 generator output', () => {
  const malformed = leadingZeroEd25519({ truncated: true }), valid = leadingZeroEd25519(); let calls = 0;
  assert.equal(utils.parseKey(malformed.private).message, 'Malformed OpenSSH private key');
  assert.equal(utils.parseKey(malformed.public).message, 'Malformed OpenSSH public key');
  assert.equal(generateEd25519Fixture({}, () => ++calls === 1 ? malformed : valid), valid);
  assert.equal(calls, 2);
});

test('fixture helper bounds known-defect retries and rejects other errors immediately', () => {
  let calls = 0;
  assert.throws(() => generateEd25519Fixture({}, () => { calls++; return leadingZeroEd25519({ truncated: true }); }), /eight truncated/);
  assert.equal(calls, 8);
  calls = 0;
  assert.throws(() => generateEd25519Fixture({}, () => { calls++; return { private: 'broken', public: 'broken' }; }), /invalid key pair/);
  assert.equal(calls, 1);
});

test('fixture helper validates encryption and matching public/private signing identities', () => {
  const encrypted = generateEd25519Fixture({ cipher: 'aes256-cbc', passphrase: 'synthetic fixture secret' });
  assert.match(utils.parseKey(encrypted.private).message, /Encrypted/);
  let calls = 0;
  assert.throws(() => generateEd25519Fixture({ passphrase: 'incorrect' }, () => { calls++; return encrypted; }), /invalid key pair/);
  assert.equal(calls, 1);
  assert.throws(() => generateEd25519Fixture({ passphrase: 'synthetic fixture secret' }, () => ({ private: encrypted.private, public: leadingZeroEd25519().public })), /identities do not match/);
});
