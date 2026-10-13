'use strict';

const { createPrivateKey, createPublicKey } = require('node:crypto');

// Deliberately public, deterministic test identity; never use outside fixtures.
// The seed ending in 36 yields a 32-byte public key beginning with two zeros.
module.exports = function leadingZeroEd25519({ truncated = false } = {}) {
  const seed = Buffer.alloc(32); seed.writeUInt32BE(36, 28);
  const nativeKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
  let publicBytes = createPublicKey(nativeKey).export({ format: 'der', type: 'spki' }).subarray(-32);
  if (publicBytes[0] !== 0 || publicBytes[1] !== 0 || publicBytes[2] === 0) throw new Error('Leading-zero fixture identity changed.');
  if (truncated) publicBytes = publicBytes.subarray(2); // Reproduce ssh2's generator defect.
  const uint32 = value => { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(value); return bytes; };
  const field = value => { const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value); return Buffer.concat([uint32(bytes.length), bytes]); };
  const publicWire = Buffer.concat([field('ssh-ed25519'), field(publicBytes)]);
  let privateWire = Buffer.concat([uint32(0x12345678), uint32(0x12345678), publicWire, field(Buffer.concat([seed, publicBytes])), field('TermForge public test identity')]);
  const padding = Buffer.from(Array.from({ length: (8 - privateWire.length % 8) % 8 }, (_, index) => index + 1));
  privateWire = Buffer.concat([privateWire, padding]);
  const wire = Buffer.concat([Buffer.from('openssh-key-v1\0'), field('none'), field('none'), field(''), uint32(1), field(publicWire), field(privateWire)]);
  return {
    private: `-----BEGIN OPENSSH PRIVATE KEY-----\n${wire.toString('base64').match(/.{1,70}/gu).join('\n')}\n-----END OPENSSH PRIVATE KEY-----\n`,
    public: `ssh-ed25519 ${publicWire.toString('base64')} TermForge public test identity`,
  };
};
