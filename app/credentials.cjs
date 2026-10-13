'use strict';
const fs = require('node:fs/promises');
const constants = require('node:fs').constants;
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { writePrivateFile } = require('./files.cjs');

const MAX_ENTRIES = 200;
const MAX_BYTES = 4 * 1024 * 1024;
const LINUX_BACKENDS = new Set(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']);
function text(value, label, max, required = true) {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/u.test(value) || (required && !value.trim())) throw new Error(`${label} is invalid.`);
  return value;
}
function identifier(value) { if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u.test(value)) throw new Error('Credential identifier is invalid.'); return value; }
function endpoint(profile, fingerprint) {
  const host = text(profile?.host, 'Credential host', 253).toLowerCase();
  if (!Number.isInteger(profile.port) || profile.port < 1 || profile.port > 65535 || typeof fingerprint !== 'string' || !/^SHA256:[A-Za-z0-9+/]{43}=?$/u.test(fingerprint)) throw new Error('A verified SSH host key is required before using credentials.');
  return { host, port: profile.port, fingerprint };
}

// There is intentionally no IPC-accessible decrypt/read-password operation.
// Only the verified SSH authentication callback receives decrypted credentials.
function createCredentialVault({ directory, safeStorage, platform = process.platform, confirmUse = async () => false } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || !safeStorage) throw new Error('Credential storage requires an absolute directory and OS encryption.');
  const filename = path.join(directory, 'credentials.json');
  let tail = Promise.resolve();
  const serial = operation => { const result = tail.then(operation); tail = result.catch(() => {}); return result; };
  async function status() {
    try {
      // Electron's async Linux provider can fall back independently of the
      // synchronous backend. Use the explicitly inspectable secure provider on
      // Linux, and async Keychain/DPAPI on macOS/Windows.
      const backend = platform === 'linux' ? safeStorage.getSelectedStorageBackend() : platform === 'darwin' ? 'Keychain' : platform === 'win32' ? 'DPAPI' : 'unsupported';
      const available = platform === 'linux' ? LINUX_BACKENDS.has(backend) && safeStorage.isEncryptionAvailable() : ['darwin', 'win32'].includes(platform) && await safeStorage.isAsyncEncryptionAvailable();
      return { available: Boolean(available), backend, message: available ? `Saved usernames and passwords are encrypted using ${backend}. Credential names remain visible locally.` : 'Secure OS storage is unavailable. Passwords can be entered for each connection, but cannot be saved.' };
    } catch { return { available: false, backend: 'unavailable', message: 'Secure OS storage is unavailable. Unlock your keychain or desktop keyring and try again.' }; }
  }
  async function requireSecure() { if (!(await status()).available) throw new Error('Secure OS storage is unavailable. Credentials were not read or saved.'); }
  async function checkDirectory(create = false) {
    if (create) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Credential directory must be a regular directory, not a symbolic link.');
    if (create && platform !== 'win32') await fs.chmod(directory, 0o700);
  }
  async function read() {
    let handle;
    try {
      await checkDirectory();
      const link = await fs.lstat(filename);
      if (!link.isFile() || link.isSymbolicLink()) throw new Error('Credential storage is not a regular file.');
      handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('Credential storage is too large or invalid.');
      const bytes = Buffer.alloc(MAX_BYTES + 1); let length = 0;
      while (length < bytes.length) { const result = await handle.read(bytes, length, bytes.length - length, null); if (!result.bytesRead) break; length += result.bytesRead; }
      if (length > MAX_BYTES) throw new Error('Credential storage is too large.');
      const value = JSON.parse(bytes.subarray(0, length).toString('utf8'));
      if (value?.version !== 1 || Object.keys(value).some(key => !['version', 'entries'].includes(key)) || !Array.isArray(value.entries) || value.entries.length > MAX_ENTRIES) throw new Error('Invalid credential storage.');
      const ids = new Set();
      for (const entry of value.entries) {
        identifier(entry.id); text(entry.name, 'Credential name', 120); text(entry.updatedAt, 'Credential date', 40);
        if (Object.keys(entry).some(key => !['id', 'name', 'updatedAt', 'format', 'ciphertext'].includes(key)) || ids.has(entry.id) || !['sync', 'async'].includes(entry.format) || typeof entry.ciphertext !== 'string' || entry.ciphertext.length > 256 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(entry.ciphertext)) throw new Error('Invalid credential storage.');
        ids.add(entry.id);
      }
      return value;
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, entries: [] };
      // Do not echo corrupt file contents, OS errors, or decryption errors.
      throw new Error('Cannot read credential storage. The existing file has been left untouched.');
    } finally { await handle?.close(); }
  }
  async function persist(value) {
    const serialized = JSON.stringify(value, null, 2) + '\n';
    if (Buffer.byteLength(serialized) > MAX_BYTES) throw new Error('Credential storage is full.');
    await checkDirectory(true);
    await writePrivateFile(filename, serialized);
  }
  function metadata(entry) { return { id: entry.id, name: entry.name, updatedAt: entry.updatedAt }; }
  async function encrypt(payload) {
    await requireSecure();
    const format = platform === 'linux' ? 'sync' : 'async';
    try {
      const encrypted = format === 'sync' ? safeStorage.encryptString(JSON.stringify(payload)) : await safeStorage.encryptStringAsync(JSON.stringify(payload));
      if (!Buffer.isBuffer(encrypted) || !encrypted.length) throw new Error('Invalid encryption result');
      await requireSecure();
      return { format, ciphertext: encrypted.toString('base64') };
    } catch { throw new Error('The OS could not encrypt the credentials. Nothing was saved.'); }
  }
  async function decrypt(entry) {
    await requireSecure();
    try {
      // Vaults are tied to the OS user and are not portable exports.
      if (entry.format !== (platform === 'linux' ? 'sync' : 'async')) throw new Error('Different storage backend');
      const result = entry.format === 'sync' ? safeStorage.decryptString(Buffer.from(entry.ciphertext, 'base64')) : (await safeStorage.decryptStringAsync(Buffer.from(entry.ciphertext, 'base64'))).result;
      const payload = JSON.parse(result);
      if (payload.version !== 1 || payload.id !== entry.id || payload.name !== entry.name || !Array.isArray(payload.targets) || payload.targets.length > 200) throw new Error('Invalid credentials');
      text(payload.username, 'Username', 128); text(payload.password, 'Password', 4096);
      for (const target of payload.targets) endpoint(target, target.fingerprint);
      return payload;
    } catch { throw new Error('The OS could not unlock these credentials. Check the keychain or replace this entry.'); }
  }
  return {
    status,
    list: () => serial(async () => (await read()).entries.map(metadata)),
    save: input => serial(async () => {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['id', 'name', 'username', 'password'].includes(key))) throw new Error('Invalid credential request.');
      const name = text(input.name, 'Credential name', 120).trim();
      const username = text(input.username, 'Username', 128).trim();
      const password = text(input.password, 'Password', 4096);
      const value = await read();
      const id = input.id ? identifier(input.id) : randomUUID();
      const index = value.entries.findIndex(entry => entry.id === id);
      if (input.id && index < 0) throw new Error('Credential no longer exists.');
      if (value.entries.some(entry => entry.id !== id && entry.name.toLowerCase() === name.toLowerCase())) throw new Error('Choose a unique credential name.');
      if (index < 0 && value.entries.length >= MAX_ENTRIES) throw new Error('You can save up to 200 credentials.');
      // Replacing an entry clears host grants so new credentials need review.
      const encrypted = await encrypt({ version: 1, id, name, username, password, targets: [] });
      const entry = { id, name, ...encrypted, updatedAt: new Date().toISOString() };
      if (index < 0) value.entries.push(entry); else value.entries[index] = entry;
      await persist(value);
      return metadata(entry);
    }),
    delete: id => serial(async () => { identifier(id); const value = await read(); const before = value.entries.length; value.entries = value.entries.filter(entry => entry.id !== id); if (before !== value.entries.length) await persist(value); return { deleted: before !== value.entries.length }; }),
    use: (id, profile, { fingerprint, signal } = {}) => serial(async () => {
      identifier(id);
      const target = endpoint(profile, fingerprint);
      if (signal?.aborted) throw new Error('Authentication cancelled.');
      const value = await read(); const entry = value.entries.find(item => item.id === id);
      if (!entry) throw new Error('Saved credential no longer exists. Choose another credential or prompt for a password.');
      const payload = await decrypt(entry);
      const matches = item => item.host === target.host && item.port === target.port && item.fingerprint === target.fingerprint;
      if (!payload.targets.some(matches)) {
        const allowed = await confirmUse({ name: entry.name, ...target, signal });
        if (!allowed || signal?.aborted) throw new Error('Credential use cancelled.');
        if (payload.targets.length >= 200) throw new Error('Credential host limit reached. Replace this entry to reset its grants.');
        payload.targets.push(target);
        Object.assign(entry, await encrypt(payload));
        if (signal?.aborted) throw new Error('Authentication cancelled.');
        await persist(value);
      }
      if (signal?.aborted) throw new Error('Authentication cancelled.');
      return { username: payload.username, password: payload.password };
    }),
  };
}
module.exports = { createCredentialVault };
