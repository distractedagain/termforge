'use strict';
// Development-only loopback test. Neither this server nor its keys ship in the app.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Server } = require('ssh2');
const { createTerminalManager } = require('../app/terminals.cjs');
const pty = require('node-pty');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, description) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(30);
  }
  throw new Error(`SSH smoke timed out: ${description}`);
}
module.exports = async (directory) => {
  const keyOne = path.join(directory, 'test-host-one');
  const keyTwo = path.join(directory, 'test-host-two');
  for (const key of [keyOne, keyTwo]) if (!fs.existsSync(key)) execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
  const clients = new Set();
  async function startServer(key, port = 0) {
    const server = new Server({ hostKeys: [fs.readFileSync(key)] }, (client) => {
      clients.add(client);
      client.on('error', () => {});
      client.on('close', () => clients.delete(client));
      client.on('authentication', (context) => {
        if (context.method === 'password' && context.username === 'harbor-test' && context.password === 'test-only-password') context.accept();
        else context.reject(['password']);
      });
      client.on('ready', () => client.on('session', (accept) => {
        const session = accept();
        session.on('pty', (acceptPty) => acceptPty());
        session.on('window-change', (acceptWindow) => acceptWindow && acceptWindow());
        session.on('shell', (acceptShell) => {
          const stream = acceptShell();
          stream.write('Loopback SSH test shell\r\nharbor-test> ');
          stream.on('data', (data) => {
            if (data.toString().includes('harbor-probe')) stream.write('HARBOR_SSH_AUTHENTICATED\r\n');
          });
        });
      }));
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    return server;
  }
  async function stopServer(server) {
    for (const client of clients) client.end();
    await new Promise((resolve) => server.close(resolve));
  }
  let output = '';
  let exited = false;
  const manager = createTerminalManager({
    cwd: directory,
    spawn(file, args, options) {
      // Isolate host trust from the user's actual ~/.ssh/known_hosts.
      const isolated = [...args];
      isolated.splice(2, 0, '-o', `UserKnownHostsFile=${path.join(directory, 'known_hosts')}`, '-o', 'GlobalKnownHostsFile=none', '-o', 'PubkeyAuthentication=no', '-o', 'PreferredAuthentications=password', '-o', 'NumberOfPasswordPrompts=1');
      return pty.spawn(file, isolated, options);
    },
    emitData: (event) => { output += event.data; },
    emitExit: () => { exited = true; }
  });
  let server;
  try {
    server = await startServer(keyOne);
    const port = server.address().port;
    const profile = { name: 'Loopback SSH test', protocol: 'ssh', host: '127.0.0.1', username: 'harbor-test', port };
    const connection = manager.open(profile);
    await waitFor(() => output.includes('Are you sure you want to continue connecting'), 'new host confirmation');
    manager.write({ id: connection.id, data: 'yes\r' });
    await waitFor(() => output.includes('password:'), 'authentication prompt');
    manager.write({ id: connection.id, data: 'test-only-password\r' });
    await waitFor(() => output.includes('harbor-test>'), 'authenticated remote shell');
    manager.resize({ id: connection.id, cols: 100, rows: 40 });
    manager.write({ id: connection.id, data: 'harbor-probe\r' });
    await waitFor(() => output.includes('HARBOR_SSH_AUTHENTICATED'), 'remote command output');
    manager.close(connection.id);
    await stopServer(server); server = null;
    output = ''; exited = false;
    server = await startServer(keyTwo, port);
    manager.open(profile);
    await waitFor(() => output.includes('REMOTE HOST IDENTIFICATION HAS CHANGED'), 'changed host key refusal');
    await waitFor(() => exited, 'refused connection exit');
    if (output.includes('password:')) throw new Error('Changed host key reached authentication');
    return { realSSH: true, newHostPrompt: true, passwordAuthentication: true, remoteCommand: true, changedHostKeyRefused: true };
  } finally {
    manager.closeAll();
    if (server) await stopServer(server);
  }
};
