'use strict';
const fs = require('node:fs');
const path = require('node:path');

function fixPtyPermissions(root = path.join(__dirname, '..')) {
  if (process.platform !== 'darwin') return [];
  const ptyDirectory = path.join(root, 'node_modules', 'node-pty');
  const helpers = [path.join(ptyDirectory, 'build', 'Release', 'spawn-helper')];
  const prebuildDirectory = path.join(ptyDirectory, 'prebuilds');
  let prebuilds = [];
  try {
    prebuilds = fs.readdirSync(prebuildDirectory, { withFileTypes: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  for (const directory of prebuilds) {
    if (directory.isDirectory() && !directory.isSymbolicLink() && directory.name.startsWith('darwin-')) {
      helpers.push(path.join(prebuildDirectory, directory.name, 'spawn-helper'));
    }
  }
  const repaired = [];
  for (const helper of helpers) {
    let stat;
    try {
      stat = fs.lstatSync(helper);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    // node-pty 1.1.0 ships macOS prebuilt helpers without their executable bit.
    fs.chmodSync(helper, 0o755);
    repaired.push(helper);
  }
  return repaired;
}

module.exports = { fixPtyPermissions };
if (require.main === module) fixPtyPermissions();
