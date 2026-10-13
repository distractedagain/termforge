'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { validateSession } = require('./core.cjs');
const MAX_BYTES = 2 * 1024 * 1024, MAX_ROWS = 2001, MAX_COLUMNS = 32, MAX_CELL = 8192, TTL = 15 * 60 * 1000;
const FIELDS = ['name', 'host', 'protocol', 'port', 'username', 'folder', 'description'];
const DELIMITERS = { comma: ',', tab: '\t', semicolon: ';' };
const aliases = { name: ['name', 'session', 'sessionname'], host: ['host', 'hostname', 'address', 'ip', 'ipaddress'], protocol: ['protocol'], port: ['port'], username: ['username', 'user'], folder: ['folder', 'group'], description: ['description', 'comment'] };
const normalized = value => String(value).normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/gu, '');
const secretHeader = value => /password|passphrase|secret|token|credential|privatekey|identityfile|keyfile/u.test(normalized(value));
const fingerprint = sessions => createHash('sha256').update(JSON.stringify(sessions)).digest('hex');
function object(value, keys) { if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.keys(value).some(key => !keys.includes(key))) throw new Error('Invalid session import request.'); }
function parseDelimited(text, delimiter = 'comma') {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_BYTES || !Object.hasOwn(DELIMITERS, delimiter)) throw new Error('Choose a CSV, TSV or semicolon file of at most 2 MiB.');
  text = text.replace(/^\uFEFF/u, '');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) throw new Error('The import file contains unsupported control characters.');
  const separator = DELIMITERS[delimiter], records = [];
  let cells = [], cell = '', quoted = false, closed = false, line = 1, start = 1, error = '', touched = false;
  function finishCell() { if (cells.length >= MAX_COLUMNS) throw new Error('Import files may have at most 32 columns.'); cells.push(cell); cell = ''; closed = false; }
  function finishRow() { finishCell(); if (touched || cells.some(value => value !== '')) { records.push({ cells, row: start, error }); if (records.length > MAX_ROWS) throw new Error('Import files may have at most 2,000 data rows plus a header.'); } cells = []; error = ''; touched = false; start = line + 1; }
  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (quoted) {
      if (character === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; closed = true; } }
      else { cell += character; if (character === '\n') line++; else if (character === '\r' && text[i + 1] !== '\n') line++; }
    } else if (character === separator) { touched = true; finishCell(); }
    else if (character === '\n' || character === '\r') { finishRow(); if (character === '\r' && text[i + 1] === '\n') i++; line++; start = line; }
    else if (character === '"' && !cell && !closed) { quoted = true; touched = true; }
    else { touched = true; if (closed || character === '"') error = 'Malformed quoting; quotes must enclose the entire field.'; cell += character; }
    if (cell.length > MAX_CELL) throw new Error(`A field on line ${start} exceeds 8,192 characters.`);
  }
  if (quoted) error = 'Unclosed quoted field.';
  if (touched || cells.length || cell.length) finishRow();
  return records;
}
function detectDelimiter(text) {
  let best = 'comma', score = -1;
  for (const candidate of Object.keys(DELIMITERS)) {
    try { const records = parseDelimited(text, candidate); const first = records[0]?.cells.length || 0; const same = records.slice(0, 20).filter(row => row.cells.length === first && !row.error).length; const next = first > 1 ? same * 10 + first : 0; if (next > score) { best = candidate; score = next; } } catch { /* The selected format will produce its bounded diagnostic. */ }
  }
  return best;
}
function describe(text, delimiter, header) {
  const records = parseDelimited(text, delimiter);
  if (!records.length) throw new Error('The selected file has no session rows.');
  if (header && records[0].error) throw new Error(`Header line ${records[0].row}: ${records[0].error}`);
  if (records.length - Number(header) > 2000) throw new Error('Import files may have at most 2,000 data rows.');
  const columns = records[0].cells.map((value, index) => ({ index, label: header ? value.trim().slice(0, 80) || `Column ${index + 1}` : `Column ${index + 1}`, sensitive: header && secretHeader(value) }));
  const suggestedMapping = {};
  if (header) for (const field of FIELDS) { const column = columns.find(item => !item.sensitive && aliases[field].includes(normalized(item.label))); if (column) suggestedMapping[field] = column.index; }
  return { records: header ? records.slice(1) : records, columns, suggestedMapping, rowCount: records.length - Number(header), delimiter, header };
}
async function readChosen(filename) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename) || /[\u0000\r\n]/u.test(filename)) throw new Error('Choose a regular local import file.');
  const before = await fsp.lstat(filename);
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_BYTES) throw new Error('Choose a regular file of at most 2 MiB; links are not imported.');
  const handle = await fsp.open(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > MAX_BYTES) throw new Error('The import file changed while opening it.');
    const bytes = Buffer.alloc(MAX_BYTES + 1); let count = 0;
    while (count < bytes.length) { const read = await handle.read(bytes, count, bytes.length - count, count); if (!read.bytesRead) break; count += read.bytesRead; }
    const after = await handle.stat();
    if (count > MAX_BYTES || opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs || count !== after.size) throw new Error('The import file changed while reading it.');
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count)); } catch { throw new Error('The import file must use UTF-8 encoding.'); }
  } finally { await handle.close(); }
}
function createSessionImport({ chooseFile, loadConfig, commitSessions, approveApply = async () => true, now = Date.now } = {}) {
  if (![chooseFile, loadConfig, commitSessions, approveApply].every(value => typeof value === 'function')) throw new Error('Session import callbacks are required.');
  const files = new Map(), plans = new Map(); let applying = false, generation = 0;
  function expire() { for (const [id, file] of files) if (now() - file.created > TTL) discard({ fileId: id }); }
  function discard({ fileId } = {}) { files.delete(fileId); for (const [id, plan] of plans) if (plan.fileId === fileId) plans.delete(id); return { discarded: true }; }
  function fileFor(fileId) { expire(); const file = files.get(fileId); if (!file) throw new Error('The import expired or was canceled. Choose the file again.'); return file; }
  async function choose() {
    const ticket = ++generation;
    const chosen = await chooseFile(); if (!chosen || chosen.canceled || ticket !== generation) return { canceled: true };
    const text = await readChosen(chosen.path); if (ticket !== generation) return { canceled: true };
    const delimiter = detectDelimiter(text); const first = parseDelimited(text, delimiter)[0];
    const header = Boolean(first?.cells.some(value => Object.values(aliases).flat().includes(normalized(value)) || secretHeader(value)));
    const info = describe(text, delimiter, header), fileId = randomUUID();
    files.clear(); plans.clear(); files.set(fileId, { text, name: path.basename(chosen.path), created: now(), revision: 0 });
    const { records, ...metadata } = info; return { fileId, name: path.basename(chosen.path), ...metadata };
  }
  async function preview(request) {
    object(request, ['fileId', 'delimiter', 'header', 'mapping', 'collision', 'selectedRows']);
    const file = fileFor(request.fileId); const revision = ++file.revision;
    for (const [id, plan] of plans) if (plan.fileId === request.fileId) plans.delete(id);
    if (typeof request.header !== 'boolean' || !Object.hasOwn(DELIMITERS, request.delimiter) || !['skip', 'rename', 'replace'].includes(request.collision)) throw new Error('Choose a delimiter, header option and collision policy.');
    const info = describe(file.text, request.delimiter, request.header);
    const mapping = request.mapping || {}; object(mapping, FIELDS);
    const used = new Set();
    for (const [field, column] of Object.entries(mapping)) {
      if (!Number.isInteger(column) || column < 0 || column >= info.columns.length || used.has(column)) throw new Error('Map each imported field to a different valid column.');
      if (info.columns[column].sensitive) throw new Error('Password, key, token and credential columns cannot be imported.');
      used.add(column);
    }
    const selections = request.selectedRows;
    if (selections !== undefined && (!Array.isArray(selections) || selections.length > MAX_ROWS || selections.some(row => !Number.isInteger(row) || !info.records.some(record => record.row === row)) || new Set(selections).size !== selections.length)) throw new Error('Choose valid, unique rows to import.');
    const selected = selections === undefined ? null : new Set(selections);
    const loaded = await loadConfig();
    if (fileFor(request.fileId) !== file || revision !== file.revision) throw new Error('Import options changed. Preview again.');
    const expectedSessions = structuredClone(loaded.sessions);
    if (!Array.isArray(expectedSessions) || expectedSessions.length > 1000) throw new Error('Saved sessions could not be loaded.');
    const nextSessions = structuredClone(expectedSessions), rows = [], importedKeys = new Set(); let added = 0, replaced = 0, skipped = 0, errors = 0;
    const identity = profile => `${profile.folder.normalize('NFKC').toLowerCase()}\u0000${profile.name.normalize('NFKC').toLowerCase()}`;
    for (const record of info.records) {
      const included = !selected || selected.has(record.row);
      const view = { row: record.row, selected: included, name: '', host: '', protocol: '', port: '', username: '', folder: '', description: '', status: included ? 'add' : 'excluded', message: '' };
      try {
        if (record.error) throw new Error(record.error);
        if (record.cells.length !== info.columns.length) throw new Error(`Expected ${info.columns.length} columns; found ${record.cells.length}.`);
        if (!Object.hasOwn(mapping, 'host')) throw new Error('Map a Host column before importing.');
        const input = {}; for (const [field, column] of Object.entries(mapping)) input[field] = field === 'description' ? record.cells[column] : record.cells[column].trim();
        const protocol = (input.protocol || 'ssh').toLowerCase(); input.protocol = protocol === 'ssh2' ? 'ssh' : protocol;
        if (!['ssh', 'sftp', 'telnet', 'raw'].includes(input.protocol)) throw new Error('Only SSH2, SSH, SFTP, Telnet and Raw sessions can be imported.');
        if (!input.name) delete input.name;
        const profile = validateSession(input); Object.assign(view, { name: profile.name, host: profile.host, protocol: profile.protocol, port: profile.port, username: profile.username, folder: profile.folder, description: profile.description });
        if (included) {
          const key = identity(profile), matches = nextSessions.filter(existing => identity(existing) === key);
          if (matches.length && request.collision === 'skip') { view.status = 'skip'; view.message = 'An existing or earlier imported session has this folder and name.'; skipped++; }
          else if (matches.length && request.collision === 'replace') {
            if (matches.length > 1 || importedKeys.has(key)) throw new Error('Replacement is ambiguous: duplicate folder/name. Rename or skip this row.');
            profile.id = matches[0].id; nextSessions[nextSessions.findIndex(existing => existing.id === profile.id)] = profile;
            view.status = 'replace'; view.message = 'Replace all settings; keep the saved session ID. Credential references are cleared.'; replaced++; importedKeys.add(key);
          } else {
            if (matches.length) { const name = profile.name; let number = 2; do { const suffix = ` (${number++})`; profile.name = name.slice(0, 120 - suffix.length) + suffix; } while (nextSessions.some(existing => identity(existing) === identity(profile))); view.name = profile.name; view.status = 'rename'; view.message = 'Import with a unique session name.'; }
            nextSessions.push(profile); importedKeys.add(identity(profile)); added++;
          }
        }
      } catch (error) { view.status = 'error'; view.message = error.message; if (included) errors++; }
      rows.push(view);
    }
    if (nextSessions.length > 1000) errors++;
    const counts = { added, replaced, skipped, excluded: rows.filter(row => !row.selected).length, errors, total: nextSessions.length };
    const canApply = errors === 0 && added + replaced > 0;
    const planId = canApply ? randomUUID() : null;
    if (planId) plans.set(planId, { fileId: request.fileId, expectedSessions, nextSessions, digest: fingerprint(expectedSessions), counts, created: now() });
    const { records, ...metadata } = info;
    return { ...metadata, rows, counts, planId, canApply, message: nextSessions.length > 1000 ? 'Import would exceed the 1,000 saved-session limit.' : '' };
  }
  async function apply(request) {
    object(request, ['planId']); expire();
    const plan = plans.get(request.planId);
    if (!plan || now() - plan.created > TTL) throw new Error('Preview the import again before saving.');
    if (applying) throw new Error('An import is already being saved.');
    fileFor(plan.fileId); plans.delete(request.planId); applying = true;
    try {
      const fresh = async () => { fileFor(plan.fileId); const loaded = await loadConfig(); fileFor(plan.fileId); if (fingerprint(loaded.sessions) !== plan.digest) throw new Error('Saved sessions changed after preview. Preview the import again.'); };
      await fresh();
      if (!await approveApply({ ...plan.counts, name: fileFor(plan.fileId).name })) return { canceled: true };
      await fresh();
      await commitSessions(structuredClone(plan.nextSessions), { expectedSessions: structuredClone(plan.expectedSessions) });
      discard({ fileId: plan.fileId }); return { canceled: false, ...plan.counts };
    } finally { applying = false; }
  }
  return { choose, preview, apply, discard, close() { generation++; files.clear(); plans.clear(); } };
}
module.exports = { createSessionImport, parseDelimited, detectDelimiter, MAX_BYTES, MAX_ROWS, MAX_COLUMNS };
