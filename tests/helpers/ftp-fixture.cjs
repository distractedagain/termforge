'use strict';
// A test-only loopback FTP/FTPS peer. Never used by the packaged application.
const net = require('node:net');
const tls = require('node:tls');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { once } = require('node:events');
const certPath = path.join(__dirname, '../fixtures/ftp-tls');
const certificates = name => ({ key: fs.readFileSync(path.join(certPath, `${name}-key.pem`)), cert: fs.readFileSync(path.join(certPath, `${name}-cert.pem`)) });
const good = certificates('localhost'); const wrong = certificates('wrong');
async function startFtpFixture(root, options = {}) {
  const sockets = new Set(); const passiveServers = new Set(); const commands = []; const encryptedLogins = []; const dataTls = []; let controls = 0;
  function track(socket) { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); return socket; }
  function serve(initial) {
    controls++; let socket = track(initial); let buffer = ''; let isTLS = Boolean(socket.encrypted); let protect = false; let passive; let waitingData; let renamed; let cwd = '/';
    const reply = value => { if (!socket.destroyed) socket.write(`${value}\r\n`); };
    const filename = value => { const remote = path.posix.resolve(cwd, value); const target = path.join(root, remote); if (!target.startsWith(root + path.sep) && target !== root) throw new Error('bad fixture path'); return target; };
    function listenData(target) { target.on('data', chunk => { buffer += chunk.toString(); let end; while ((end = buffer.indexOf('\r\n')) >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 2); sequence = sequence.then(() => command(line)).catch(() => reply('550 fixture failure')); } }); }
    let sequence = Promise.resolve();
    async function command(line) {
      const match = /^(\S+)(?: (.*))?$/.exec(line); const verb = match[1].toUpperCase(), arg = match[2] || ''; commands.push(verb); options.onCommand?.(verb, arg);
      if (verb === 'AUTH') {
        if (options.rejectTls) return reply('500 TLS unavailable');
        if (isTLS) return reply('503 already TLS');
        socket.removeAllListeners('data'); reply('234 Begin TLS');
        socket = track(new tls.TLSSocket(socket, { isServer: true, secureContext: tls.createSecureContext(options.controlWrong ? wrong : good) }));
        isTLS = true; listenData(socket); return;
      }
      if (verb === 'USER') { encryptedLogins.push(isTLS); reply('331 password required'); }
      else if (verb === 'PASS') reply(options.echoPasswordFailure ? `530 Rejected ${arg}` : '230 logged in');
      else if (verb === 'FEAT') reply('211-Features\r\n MLST type*;size*;modify*;\r\n UTF8\r\n211 End');
      else if (['OPTS', 'TYPE', 'STRU', 'PBSZ'].includes(verb)) reply('200 okay');
      else if (verb === 'PROT') { if (options.rejectProtection) return reply('534 protection denied'); protect = arg === 'P'; reply('200 protected'); }
      else if (verb === 'PWD') reply(`257 "${cwd}"`);
      else if (verb === 'CWD') { const stat = await fsp.stat(filename(arg)); if (!stat.isDirectory()) return reply('550 not directory'); cwd = path.posix.resolve(cwd, arg); reply('250 changed'); }
      else if (verb === 'EPSV') {
        if (passive) passive.close();
        let resolveData; waitingData = new Promise(resolve => { resolveData = resolve; });
        const connected = data => { track(data); dataTls.push(Boolean(data.encrypted)); resolveData(data); };
        passive = net.createServer(raw => { track(raw); connected(protect ? new tls.TLSSocket(raw, {isServer:true, secureContext:tls.createSecureContext(options.dataWrong ? wrong : good)}) : raw); });
        passive.on('connection', track); passive.on('tlsClientError', () => {}); passive.on('error', () => {}); passiveServers.add(passive);
        passive.on('close', () => passiveServers.delete(passive)); await new Promise(resolve => passive.listen(0, '127.0.0.1', resolve));
        reply(`229 Entering Extended Passive Mode (|||${passive.address().port}|)`);
      }
      else if (['MLSD', 'LIST', 'RETR', 'STOR'].includes(verb)) {
        reply('150 Opening data'); const data = await waitingData; passive.close();
        if (verb === 'MLSD' || verb === 'LIST') {
          if (options.rawListing) data.end(options.rawListing);
          else {
            const directory = filename(arg || cwd); const rows = [];
            for (const entry of await fsp.readdir(directory)) { const stat = await fsp.lstat(path.join(directory, entry)); const type = stat.isSymbolicLink() ? 'OS.unix=slink' : stat.isDirectory() ? 'dir' : 'file'; const stamp = stat.mtime.toISOString().replace(/[-:]/g, '').replace(/T/, '').slice(0, 14); rows.push(`type=${type};size=${stat.size};modify=${stamp}; ${entry}\r\n`); }
            data.end(rows.join(''));
          }
          await once(data, 'close'); reply('226 Listed');
        } else if (verb === 'RETR') {
          await options.beforeRetrieve?.(arg); const contents = await fsp.readFile(filename(arg));
          if (options.slowDownload) { for (let offset = 0; offset < contents.length && !data.destroyed; offset += 65536) { data.write(contents.subarray(offset, offset + 65536)); await new Promise(resolve => setTimeout(resolve, 20)); } data.end(); }
          else data.end(contents);
          await once(data, 'close'); reply('226 Downloaded');
        } else {
          const chunks = []; for await (const chunk of data) chunks.push(chunk); await fsp.writeFile(filename(arg), Buffer.concat(chunks)); reply('226 Uploaded');
        }
      }
      else if (verb === 'RNFR') { renamed = filename(arg); await fsp.lstat(renamed); reply('350 Rename target'); }
      else if (verb === 'RNTO') { if (options.dropCommit) { socket.destroy(); return; } await fsp.rename(renamed, filename(arg)); renamed = undefined; reply('250 Renamed'); }
      else if (verb === 'QUIT') { reply('221 bye'); socket.end(); }
      else reply('502 unsupported');
    }
    listenData(socket); reply('220 TermForge loopback fixture');
  }
  const server = options.implicit ? tls.createServer(options.controlWrong ? wrong : good, serve) : net.createServer(serve);
  server.on('connection', track); server.on('tlsClientError', () => {}); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, commands, encryptedLogins, dataTls, get controls() { return controls; },
    async close() { for (const socket of sockets) socket.destroy(); for (const passive of passiveServers) passive.close(); await new Promise(resolve => server.close(resolve)); } };
}
module.exports = { startFtpFixture, good, wrong };
