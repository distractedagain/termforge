'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { fixPtyPermissions } = require('./fix-pty-permissions.cjs');
module.exports = async () => {
  const root = path.join(__dirname, '..');
  fixPtyPermissions(root);
  // Resolves/downloads the runtime; it does not launch a desktop process.
  require('electron');
  const directory = path.join(root, 'third-party-licenses');
  fs.mkdirSync(directory, { recursive: true });
  const notices = [
    ['electron/dist/LICENSE', 'Electron.txt'],
    ['electron/dist/LICENSES.chromium.html', 'Chromium.html'],
    ['@xterm/xterm/LICENSE', 'xterm.txt'],
    ['@xterm/addon-fit/LICENSE', 'xterm-addon-fit.txt'],
    ['@xterm/addon-search/LICENSE', 'xterm-addon-search.txt'],
    ['node-pty/LICENSE', 'node-pty.txt'],
    ['node-pty/deps/winpty/LICENSE', 'winpty.txt'],
    ['node-addon-api/LICENSE.md', 'node-addon-api.txt']
  ];
  for (const [source, destination] of notices) fs.copyFileSync(path.join(root, 'node_modules', source), path.join(directory, destination));
};
