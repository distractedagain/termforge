'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
async function writePrivateFile(filename, text) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename) || /[\u0000\r\n]/u.test(filename) || typeof text !== 'string' || Buffer.byteLength(text) > 16 * 1024 * 1024) throw new Error('Choose an absolute filename for text of at most 16 MiB.');
  try { const stat = await fsp.lstat(filename); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Refusing to replace a link or non-regular file.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = path.join(path.dirname(filename), `.termforge-export-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fsp.open(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    await handle.writeFile(text, 'utf8'); await handle.sync(); await handle.close(); handle = null;
    await fsp.rename(temporary, filename);
  } finally { await handle?.close(); await fsp.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
function resolveDataDirectory(appData, current, env = process.env) {
  const explicit = env.TERMFORGE_DATA_DIR || env.HARBOR_DATA_DIR;
  if (explicit) return explicit;
  if (fs.existsSync(path.join(current, 'config.json'))) return current;
  for (const name of ['Harbor Terminal', 'harbor-terminal']) {
    const legacy = path.join(appData, name);
    if (fs.existsSync(path.join(legacy, 'config.json'))) return legacy;
  }
  return current;
}
module.exports = { writePrivateFile, resolveDataDirectory };
