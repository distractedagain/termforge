'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writePrivateFile, resolveDataDirectory } = require('../app/files.cjs');
const { stopOwnedResources } = require('../app/lifecycle.cjs');
function temporary(t) { const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'termforge-files-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true })); return directory; }

test('export replacement makes an existing public file private without exposing partial bytes', async t => {
  const directory = temporary(t); const filename = path.join(directory, 'profiles.json');
  fs.writeFileSync(filename, 'old', { mode: 0o644 });
  await writePrivateFile(filename, '{"sessions":["sensitive metadata"]}\n');
  assert.equal(fs.readFileSync(filename, 'utf8'), '{"sessions":["sensitive metadata"]}\n');
  if (process.platform !== 'win32') assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(directory), ['profiles.json']);
});
test('exports reject links and nonregular destinations while preserving their targets', { skip: process.platform === 'win32' }, async t => {
  const directory = temporary(t); const source = path.join(directory, 'source.json'); const link = path.join(directory, 'link.json');
  fs.writeFileSync(source, 'keep original'); fs.symlinkSync(source, link);
  await assert.rejects(writePrivateFile(link, 'new'), /link/);
  await assert.rejects(writePrivateFile(directory, 'new'), /non-regular/);
  assert.equal(fs.readFileSync(source, 'utf8'), 'keep original');
});
test('TermForge reuses legacy profiles only when no new config exists, without writing during discovery', t => {
  const directory = temporary(t); const legacy = path.join(directory, 'Harbor Terminal'); const current = path.join(directory, 'TermForge');
  fs.mkdirSync(legacy); fs.writeFileSync(path.join(legacy, 'config.json'), 'legacy bytes');
  assert.equal(resolveDataDirectory(directory, current, {}), legacy);
  assert.equal(fs.existsSync(current), false); assert.equal(fs.readFileSync(path.join(legacy, 'config.json'), 'utf8'), 'legacy bytes');
  fs.mkdirSync(current); fs.writeFileSync(path.join(current, 'config.json'), 'current bytes');
  assert.equal(resolveDataDirectory(directory, current, {}), current);
  assert.equal(resolveDataDirectory(directory, current, { TERMFORGE_DATA_DIR: '/explicit/new' }), '/explicit/new');
  assert.equal(resolveDataDirectory(directory, current, { HARBOR_DATA_DIR: '/explicit/legacy' }), '/explicit/legacy');
});
test('shutdown always stops every owned service even when one close rejects', async () => {
  const calls = [];
  await assert.rejects(stopOwnedResources({ scripts: async () => { calls.push('scripts'); }, terminals: async () => { calls.push('terminals'); throw new Error('device is still open'); }, tftp: async () => { calls.push('tftp'); } }), /terminals/);
  assert.deepEqual(new Set(calls), new Set(['scripts', 'terminals', 'tftp']));
});
test('shutdown waits for in-flight cleanup and handles synchronous close failures', async () => {
  let release; let complete = false;
  const stopped = stopOwnedResources({ terminal: () => { throw new Error('failed'); }, tftp: () => new Promise(resolve => { release = resolve; }) }).catch(error => { complete = true; return error; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(complete, false);
  release(); const error = await stopped; assert(error instanceof AggregateError); assert.equal(complete, true);
});
