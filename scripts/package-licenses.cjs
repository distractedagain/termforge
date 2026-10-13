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
    ['monaco-editor/LICENSE', 'Monaco.txt'],
    ['monaco-editor/ThirdPartyNotices.txt', 'Monaco-third-party.txt'],
    ['yaml/LICENSE', 'YAML.txt'],
    ['dompurify/LICENSE', 'DOMPurify.txt'],
    ['dompurify/LICENSE-MPL', 'DOMPurify-MPL.txt'],
    ['marked/LICENSE.md', 'Marked.txt'],
    ['node-pty/deps/winpty/LICENSE', 'winpty.txt'],
    ['node-addon-api/LICENSE.md', 'node-addon-api.txt'],
    ['serialport/LICENSE', 'serialport.txt'],
    ['ssh2/LICENSE', 'ssh2.txt'],
    ['basic-ftp/LICENSE.txt', 'basic-ftp.txt'],
    ['basic-ftp/NOTICE.txt', 'basic-ftp-notice.txt'],
    ['asn1/LICENSE', 'asn1.txt'],
    ['bcrypt-pbkdf/LICENSE', 'bcrypt-pbkdf.txt'],
    ['tweetnacl/LICENSE', 'tweetnacl.txt'],
    ['safer-buffer/LICENSE', 'safer-buffer.txt'],
    ['node-gyp-build/LICENSE', 'node-gyp-build.txt']
  ];
  for (const [source, destination] of notices) fs.copyFileSync(path.join(root, 'node_modules', source), path.join(directory, destination));
  for (const [source, destination] of [['cpu-features/LICENSE', 'cpu-features.txt'], ['cpu-features/deps/cpu_features/LICENSE', 'cpu-features-upstream.txt'], ['buildcheck/LICENSE', 'buildcheck.txt'], ['nan/LICENSE.md', 'nan.txt']]) {
    const filename = path.join(root, 'node_modules', source);
    if (fs.existsSync(filename)) fs.copyFileSync(filename, path.join(directory, destination));
  }
  const serialModules = path.join(root, 'node_modules', '@serialport');
  for (const entry of fs.readdirSync(serialModules, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-z0-9-]+$/.test(entry.name)) continue;
    fs.copyFileSync(path.join(serialModules, entry.name, 'LICENSE'), path.join(directory, `serialport-${entry.name}.txt`));
  }
};
