'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { randomUUID } = require('node:crypto');

const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
const SESSION_KEYS = ['id', 'name', 'folder', 'protocol', 'host', 'port', 'username', 'identityFile', 'jumpHost', 'cwd', 'description', 'color', 'forwardings'];
const SETTINGS_KEYS = ['theme', 'fontSize', 'scrollback'];
const DEFAULT_SETTINGS = Object.freeze({ theme: 'light', fontSize: 14, scrollback: 5000 });

function fail(message) { throw new Error(message); }
function object(input, label, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail(`${label} must be an object.`);
  for (const key of Object.keys(input)) if (!allowed.includes(key)) fail(`${label} contains an unsupported field: ${key}.`);
  return input;
}
function string(value, label, max, fallback = '') {
  const actual = value === undefined ? fallback : value;
  if (typeof actual !== 'string' || actual.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(actual)) fail(`${label} is invalid.`);
  return actual;
}
function singleLine(value, label, max, fallback = '') {
  const result = string(value, label, max, fallback).trim();
  if (/[\r\n\t]/u.test(result)) fail(`${label} must be a single line.`);
  return result;
}
function id(value) {
  const result = value === undefined || value === '' ? randomUUID() : singleLine(value, 'ID', 80);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(result)) fail('ID is invalid.');
  return result;
}
function integer(value, label, min, max, fallback) {
  let result = value === undefined || value === '' ? fallback : value;
  if (typeof result === 'string' && /^\d+$/u.test(result)) result = Number(result);
  if (!Number.isInteger(result) || result < min || result > max) fail(`${label} must be an integer from ${min} to ${max}.`);
  return result;
}
function hostname(value, label = 'Host', optional = false) {
  let result = singleLine(value, label, 253);
  if (!result && optional) return '';
  if (result.startsWith('[') && result.endsWith(']')) result = result.slice(1, -1);
  if (net.isIP(result)) return result;
  // OpenSSH accepts options and user@host syntax as destinations. Only hostnames
  // and IP addresses belong in this field; all other options have separate args.
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9.])?$/u.test(result) || result.includes('..') || result.split('.').some(part => part.length > 63 || part.startsWith('-') || part.endsWith('-'))) fail(`${label} must be a hostname or IP address.`);
  return result;
}
function username(value) {
  const result = singleLine(value, 'Username', 128);
  if (result && !/^[A-Za-z0-9_][A-Za-z0-9_.\\-]*$/u.test(result)) fail('Username contains unsupported characters.');
  return result;
}
function jumpHost(value) {
  const result = singleLine(value, 'Jump host', 400);
  if (!result) return '';
  // One explicit hop. Reject comma lists, URI syntax and arbitrary SSH options.
  const match = /^(?:([^@]+)@)?(\[[^\]]+\]|[^:\[\]@]+)(?::([0-9]+))?$/u.exec(result);
  if (!match) fail('Jump host must use [user@]host[:port], with brackets around IPv6 addresses.');
  const user = username(match[1] || '');
  const host = hostname(match[2], 'Jump host');
  const port = match[3] === undefined ? '' : `:${integer(match[3], 'Jump port', 1, 65535)}`;
  return `${user ? `${user}@` : ''}${net.isIP(host) === 6 ? `[${host}]` : host}${port}`;
}
function folder(value) {
  const result = singleLine(value, 'Folder', 240).replace(/\\/gu, '/');
  if (result && (result.startsWith('/') || result.endsWith('/') || result.split('/').some(part => !part || part === '.' || part === '..'))) fail('Folder must be a relative group name.');
  return result;
}
function filePath(value, label) {
  return singleLine(value, label, 4096);
}
function validateForwardings(value = []) {
  if (!Array.isArray(value) || value.length > 32) fail('Forwardings must be an array with at most 32 entries.');
  const listeners = new Set();
  return value.map(item => {
    object(item, 'Forwarding', ['type', 'listenPort', 'targetHost', 'targetPort']);
    if (!['local', 'remote', 'dynamic'].includes(item.type)) fail('Forwarding type is invalid.');
    const listenPort = integer(item.listenPort, 'Listen port', 1, 65535);
    const listener = `${item.type === 'remote' ? 'remote' : 'local'}:${listenPort}`;
    if (listeners.has(listener)) fail('Duplicate forwarding listen port.');
    listeners.add(listener);
    if (item.type === 'dynamic') {
      if ((item.targetHost !== undefined && item.targetHost !== '') || (item.targetPort !== undefined && item.targetPort !== '' && item.targetPort !== 0)) fail('Dynamic forwarding has no target host or port.');
      return { type: item.type, listenPort, targetHost: '', targetPort: 0 };
    }
    return { type: item.type, listenPort, targetHost: hostname(item.targetHost, 'Forwarding target host'), targetPort: integer(item.targetPort, 'Target port', 1, 65535) };
  });
}
function validateSession(input) {
  object(input, 'Session', SESSION_KEYS);
  const protocol = input.protocol === undefined ? 'ssh' : input.protocol;
  if (!['ssh', 'local', 'sftp'].includes(protocol)) fail('Session protocol must be ssh, local, or sftp.');
  const host = hostname(input.host, 'Host', protocol === 'local');
  const name = singleLine(input.name, 'Session name', 120, protocol === 'local' ? 'Local shell' : host);
  if (!name) fail('Session name is required.');
  const forwardings = validateForwardings(input.forwardings);
  if (protocol !== 'ssh' && forwardings.length) fail('Port forwarding is available for SSH sessions only.');
  const color = singleLine(input.color, 'Color', 7, '#60a5fa');
  if (!/^#[0-9a-f]{6}$/iu.test(color)) fail('Color must be a six-digit hex color.');
  return {
    id: id(input.id), name, folder: folder(input.folder), protocol, host,
    port: integer(input.port, 'Port', 1, 65535, 22), username: username(input.username),
    identityFile: filePath(input.identityFile, 'Identity file'), jumpHost: jumpHost(input.jumpHost),
    cwd: filePath(input.cwd, 'Working directory'), description: string(input.description, 'Description', 4096), color: color.toLowerCase(), forwardings,
  };
}
function validateSettings(input = {}) {
  object(input, 'Settings', SETTINGS_KEYS);
  const theme = input.theme === undefined ? DEFAULT_SETTINGS.theme : input.theme;
  if (!['dark', 'light'].includes(theme)) fail('Theme must be dark or light.');
  return { theme, fontSize: integer(input.fontSize, 'Font size', 10, 28, DEFAULT_SETTINGS.fontSize), scrollback: integer(input.scrollback, 'Scrollback', 100, 100000, DEFAULT_SETTINGS.scrollback) };
}
function validateSnippets(input) {
  if (!Array.isArray(input) || input.length > 200) fail('Snippets must be an array with at most 200 entries.');
  const ids = new Set();
  return input.map(item => {
    object(item, 'Snippet', ['id', 'name', 'command']);
    const snippet = { id: id(item.id), name: singleLine(item.name, 'Snippet name', 120), command: string(item.command, 'Snippet command', 16384) };
    if (!snippet.name || !snippet.command.trim()) fail('Snippet name and command are required.');
    if (ids.has(snippet.id)) fail('Snippet IDs must be unique.');
    ids.add(snippet.id);
    return snippet;
  });
}
function expandHome(value, env) {
  if (!value.startsWith('~')) return value;
  if (value !== '~' && !/^~[/\\]/u.test(value)) fail('Only the current user home shortcut (~) is supported.');
  const home = env.HOME || env.USERPROFILE;
  if (!home) fail('Home directory is unavailable. Choose an absolute path.');
  return path.join(home, value.slice(2));
}
function buildLaunch(input, { platform = process.platform, env = process.env, cwd = process.cwd() } = {}) {
  const session = validateSession(input);
  const options = { name: 'xterm-256color', cols: 100, rows: 30, cwd: expandHome(session.cwd || cwd, env), env: { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } };
  if (session.protocol === 'local') {
    if (platform === 'win32') return { file: env.ComSpec || env.COMSPEC || 'cmd.exe', args: ['/Q'], options };
    const shell = env.SHELL && path.posix.isAbsolute(env.SHELL) && !/[\r\n\u0000]/u.test(env.SHELL) ? env.SHELL : (platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
    return { file: shell, args: ['-l'], options };
  }
  // Ignore inherited SSH config. Besides preventing unrequested local commands,
  // this keeps a ProxyJump child from inheriting StrictHostKeyChecking=no.
  const args = ['-F', 'none', '-o', 'StrictHostKeyChecking=ask', '-o', 'PermitLocalCommand=no', '-o', 'ConnectTimeout=15'];
  args.push(session.protocol === 'sftp' ? '-P' : '-p', String(session.port));
  if (session.identityFile) args.push('-i', expandHome(session.identityFile, env), '-o', 'IdentitiesOnly=yes');
  if (session.jumpHost) args.push('-J', session.jumpHost);
  if (session.protocol === 'ssh') {
    args.push('-a', '-o', 'ForwardX11=no', '-o', 'ControlMaster=no', '-o', 'ControlPath=none');
    if (session.username) args.push('-l', session.username);
    if (session.forwardings.length) args.push('-o', 'ExitOnForwardFailure=yes');
    for (const forwarding of session.forwardings) {
      const flag = { local: '-L', remote: '-R', dynamic: '-D' }[forwarding.type];
      const target = net.isIP(forwarding.targetHost) === 6 ? `[${forwarding.targetHost}]` : forwarding.targetHost;
      const address = `127.0.0.1:${forwarding.listenPort}${forwarding.type === 'dynamic' ? '' : `:${target}:${forwarding.targetPort}`}`;
      args.push(flag, address);
    }
    args.push('--', session.host);
  } else {
    const destination = `${session.username ? `${session.username}@` : ''}${net.isIP(session.host) === 6 ? `[${session.host}]` : session.host}`;
    args.push('--', destination);
  }
  return { file: `${session.protocol === 'sftp' ? 'sftp' : 'ssh'}${platform === 'win32' ? '.exe' : ''}`, args, options };
}

function parseSecureCRTIni(text, { name, folder: group = '' } = {}) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 1024 * 1024 || text.includes('\u0000')) fail('SecureCRT session file is invalid or too large.');
  const fields = new Map();
  const allowed = new Set(['Protocol Name', 'Hostname', 'Username', 'Port', '[SSH2] Port', 'Identity Filename', 'Identity file']);
  for (const line of text.replace(/^\uFEFF/u, '').split(/\r?\n/u)) {
    const match = /^([SD]):"([^"\r\n]+)"=(.*)$/u.exec(line.trim());
    if (!match || !allowed.has(match[2])) continue;
    if (fields.has(match[2])) fail(`Duplicate SecureCRT field: ${match[2]}.`);
    fields.set(match[2], { type: match[1], value: match[3] });
  }
  const protocol = fields.get('Protocol Name');
  if (!protocol || protocol.type !== 'S' || protocol.value.trim().toUpperCase() !== 'SSH2') return null;
  const hostField = fields.get('Hostname');
  if (!hostField || hostField.type !== 'S' || !hostField.value.trim()) fail('SecureCRT SSH2 session has no hostname.');
  const portField = fields.get('[SSH2] Port') || fields.get('Port');
  let port = 22;
  if (portField) {
    if (portField.type === 'D') {
      if (!/^[0-9a-f]{1,8}$/iu.test(portField.value)) fail('SecureCRT port is invalid.');
      port = parseInt(portField.value, 16);
    } else port = integer(portField.value, 'SecureCRT port', 1, 65535);
  }
  const userField = fields.get('Username');
  const identityField = fields.get('Identity Filename') || fields.get('Identity file');
  if (userField && userField.type !== 'S') fail('SecureCRT username is invalid.');
  if (identityField && identityField.type !== 'S') fail('SecureCRT identity path is invalid.');
  // Password V2, login automation, scripts, tunnels and every other field are
  // deliberately excluded. This reads user-exported plain connection metadata.
  return validateSession({ name: name || hostField.value, folder: group, protocol: 'ssh', host: hostField.value, port, username: userField?.value || '', identityFile: identityField?.value || '' });
}

function freshState() {
  return { version: 1, sessions: [validateSession({ id: 'local-shell', name: 'Local shell', protocol: 'local' })], settings: { ...DEFAULT_SETTINGS }, snippets: [
    { id: 'current-directory', name: 'Current directory', command: process.platform === 'win32' ? 'cd' : 'pwd' },
    { id: 'system-name', name: process.platform === 'win32' ? 'Windows version' : 'System name (Unix)', command: process.platform === 'win32' ? 'ver' : 'uname -a' },
  ] };
}
function validateConfig(input, { imported = false } = {}) {
  object(input, 'Configuration', ['version', 'sessions', 'settings', 'snippets']);
  if ((!imported || input.version !== undefined) && input.version !== 1) fail('Unsupported configuration version. Expected version 1.');
  if (!Array.isArray(input.sessions) || input.sessions.length > 1000) fail('Configuration sessions must be an array with at most 1000 entries.');
  if (!imported && (input.settings === undefined || input.snippets === undefined)) fail('Configuration settings or snippets are missing.');
  const sessions = input.sessions.map(validateSession);
  const ids = new Set();
  for (const session of sessions) {
    if (ids.has(session.id)) fail('Session IDs must be unique.');
    ids.add(session.id);
  }
  return { version: 1, sessions, settings: input.settings === undefined ? undefined : validateSettings(input.settings), snippets: input.snippets === undefined ? undefined : validateSnippets(input.snippets) };
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function createStore(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) fail('Configuration directory must be an absolute path.');
  const filename = path.join(directory, 'config.json');
  function load() {
    let descriptor;
    try {
      descriptor = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) fail('Configuration is not a regular file or is too large.');
      const text = fs.readFileSync(descriptor, 'utf8');
      return validateConfig(JSON.parse(text));
    } catch (error) {
      if (error.code === 'ENOENT') return freshState();
      throw new Error(`Cannot read ${filename}. Your existing file was left untouched: ${error.message}`, { cause: error });
    } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
  }
  function persist(state) {
    const normalized = validateConfig(state);
    const data = `${JSON.stringify(normalized, null, 2)}\n`;
    if (Buffer.byteLength(data, 'utf8') > MAX_CONFIG_BYTES) fail('Configuration exceeds the 4 MiB limit.');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
    try { if (!fs.lstatSync(filename).isFile()) fail('Refusing to replace a non-regular configuration file.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const temporary = path.join(directory, `.config-${randomUUID()}.tmp`);
    let descriptor;
    try {
      descriptor = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(descriptor, data, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor); descriptor = undefined;
      fs.renameSync(temporary, filename);
      if (process.platform !== 'win32') {
        // Persist the directory entry as well as the file contents.
        let directoryDescriptor;
        try { directoryDescriptor = fs.openSync(directory, 'r'); fs.fsyncSync(directoryDescriptor); } finally { if (directoryDescriptor !== undefined) fs.closeSync(directoryDescriptor); }
      }
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return clone(normalized);
  }
  return {
    load,
    saveSession(input) {
      const session = validateSession(input);
      const state = load();
      const existing = state.sessions.findIndex(item => item.id === session.id);
      if (existing === -1) { if (state.sessions.length >= 1000) fail('At most 1000 sessions can be saved.'); state.sessions.push(session); }
      else state.sessions[existing] = session;
      return persist(state);
    },
    deleteSession(sessionId) {
      if (typeof sessionId !== 'string' || !sessionId) fail('Session ID is required.');
      const state = load(); state.sessions = state.sessions.filter(item => item.id !== sessionId); return persist(state);
    },
    saveSnippets(input) { const snippets = validateSnippets(input); const state = load(); state.snippets = snippets; return persist(state); },
    saveSettings(input) { object(input, 'Settings', SETTINGS_KEYS); const state = load(); state.settings = validateSettings({ ...state.settings, ...input }); return persist(state); },
    importConfig(input) {
      const imported = validateConfig(input, { imported: true });
      const state = load();
      const usedIds = new Set(state.sessions.map(item => item.id));
      for (const session of imported.sessions) {
        if (usedIds.has(session.id)) session.id = randomUUID();
        usedIds.add(session.id); state.sessions.push(session);
      }
      if (state.sessions.length > 1000) fail('Import would exceed the 1000-session limit.');
      if (imported.settings) state.settings = imported.settings;
      if (imported.snippets) state.snippets = imported.snippets;
      return persist(state);
    },
    exportConfig() { return clone(load()); },
  };
}

module.exports = { DEFAULT_SETTINGS, validateSession, validateSettings, validateSnippets, buildLaunch, parseSecureCRTIni, createStore };
