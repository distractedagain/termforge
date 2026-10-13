'use strict';

// Test fixtures only. ssh2 1.17.0's Ed25519 generator strips every leading zero
// from a DER BIT STRING, including real public-key bytes after the unused-bits
// byte. Its own parser then correctly rejects the resulting short key. Retry
// only that recognizable generator defect; never retry application failures.
const { utils } = require('ssh2');
const challenge = Buffer.from('TermForge synthetic SSH fixture identity check');

function truncatedEd25519Public(value) {
  if (typeof value !== 'string') return false;
  const match = /^ssh-ed25519 ([A-Za-z0-9+/]+={0,2})(?: .*|)$/u.exec(value.trim());
  if (!match) return false;
  const wire = Buffer.from(match[1], 'base64');
  if (wire.length < 20 || wire.readUInt32BE(0) !== 11 || wire.toString('ascii', 4, 15) !== 'ssh-ed25519') return false;
  const length = wire.readUInt32BE(15);
  return length > 0 && length < 32 && wire.length === 19 + length && wire[19] !== 0;
}

function generateEd25519Fixture(options = {}, generate = utils.generateKeyPairSync) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const pair = generate('ed25519', options);
    if (pair instanceof Error) throw pair;
    const privateKey = utils.parseKey(pair?.private, options.passphrase);
    const publicKey = utils.parseKey(pair?.public);
    if (privateKey instanceof Error || publicKey instanceof Error) {
      if (privateKey instanceof Error && privateKey.message === 'Malformed OpenSSH private key'
        && publicKey instanceof Error && publicKey.message === 'Malformed OpenSSH public key'
        && truncatedEd25519Public(pair.public)) continue;
      throw new Error('Synthetic Ed25519 fixture generation returned an invalid key pair.', { cause: privateKey instanceof Error ? privateKey : publicKey });
    }
    if (Array.isArray(privateKey) || Array.isArray(publicKey) || !privateKey.isPrivateKey()
      || privateKey.type !== 'ssh-ed25519' || publicKey.type !== 'ssh-ed25519'
      || !privateKey.getPublicSSH().equals(publicKey.getPublicSSH())) {
      throw new Error('Synthetic Ed25519 fixture identities do not match.');
    }
    const signature = privateKey.sign(challenge);
    if (signature instanceof Error || publicKey.verify(challenge, signature) !== true) {
      throw new Error('Synthetic Ed25519 fixture signature could not be verified.');
    }
    return pair;
  }
  throw new Error('ssh2 generated eight truncated Ed25519 fixtures consecutively.');
}

module.exports = { generateEd25519Fixture };
