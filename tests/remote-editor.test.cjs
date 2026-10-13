'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRemoteEditor } = require('../app/remote-editor.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function fixture(t, options = {}) {
  const entries = new Map(); const mutations = []; const hooks = {}; let stamp = 10; let session;
  const put = (name, text, mode = 0o100640, mtime = ++stamp) => entries.set(name, { data: Buffer.isBuffer(text) ? Buffer.from(text) : Buffer.from(text), mode, mtime });
  put('/', '', 0o040755); put('/home', '', 0o040700); put('/home/config.txt', 'original\n');
  const attrs = item => ({ size: item.data.length, mode: item.mode, uid: 1, gid: 2, mtime: item.mtime,
    isSymbolicLink: () => (item.mode & 0o170000) === 0o120000, isDirectory: () => (item.mode & 0o170000) === 0o040000, isFile: () => (item.mode & 0o170000) === 0o100000 });
  const lookup = name => { const item = entries.get(name); if (!item) throw Object.assign(new Error('Missing'), { code: 2 }); return item; };
  const call = async (_sftp, method, args, signal) => {
    if (signal?.aborted) throw new Error('cancelled');
    if (hooks[method]) await hooks[method](...args);
    if (signal?.aborted) throw new Error('cancelled');
    if (method === 'realpath') return args[0];
    if (method === 'open') { const [name, flags, meta] = args; if (flags === 'wx' || flags === 'wx+') { if (entries.has(name)) throw new Error('Exists'); put(name, '', 0o100000 | meta.mode); mutations.push(['create', name]); } return { name, item: lookup(name) }; }
    if (method === 'close') return;
    if (method === 'fstat') return attrs(args[0].item);
    if (method === 'fchmod') { args[0].item.mode = (args[0].item.mode & ~0o7777) | args[1]; return; }
    if (method === 'read') { const [handle, buffer, offset, length, position] = args; const part = handle.item.data.subarray(position, position + length); part.copy(buffer, offset); return part.length; }
    if (method === 'write') { const [handle, buffer, offset, length, position] = args; const data = Buffer.alloc(Math.max(handle.item.data.length, position + length)); handle.item.data.copy(data); buffer.copy(data, position, offset, offset + length); handle.item.data = data; return; }
    throw new Error('Unexpected method: ' + method);
  };
  const remoteStat = async (_sftp, name, signal) => { if (signal?.aborted) throw new Error('cancelled'); return entries.has(name) ? attrs(lookup(name)) : null; };
  const editor = createRemoteEditor({ call, remoteStat,
    getSession: id => { if (id !== 'session' || session.closed) throw new Error('Connection closed'); return session; },
    assertAvailable: () => { if (options.busy?.()) throw new Error('Transfer busy'); },
    confirm: options.confirm === undefined ? async () => true : options.confirm,
    planLifetimeMs: options.lifetime || 300000,
    commitRemote: async (_sftp, stage, target, expected, job) => {
      if (job.controller.signal.aborted) throw new Error('cancelled');
      assert.equal(lookup(target).data.length, expected.size); assert.equal(lookup(target).mtime * 1000, expected.mtime);
      job.commitStarted = true; await options.commit?.(stage, target, job);
      entries.set(target, lookup(stage)); entries.delete(stage); mutations.push(['commit', target]);
    } });
  session = { host: 'fixture.test', port: 22, sftp: {}, closed: false, client: { end() { session.closed = true; editor.disconnected('session'); } } };
  t.after(() => editor.closeAll());
  const open = () => editor.open({ id: 'session', path: '/home/config.txt' });
  const prepare = (doc, text = 'changed\n') => editor.prepareSave({ documentId: doc.documentId, revision: doc.revision, text });
  return { editor, open, prepare, put, entries, hooks, mutations, session };
}

test('remote text review is one-use, preserves BOM/UTF8 and requested permissions', async t => {
  const f = fixture(t); f.put('/home/config.txt', '\ufeffhello 🌍\n'); const doc = await f.open();
  assert.equal(doc.text, '\ufeffhello 🌍\n'); assert.equal(f.editor.count, 1); assert.equal(f.editor.busy, false);
  const plan = await f.prepare(doc, '\ufeffedited 🌍\n'); assert.equal(plan.before, doc.text); assert.equal(plan.after, '\ufeffedited 🌍\n'); assert.equal(f.editor.busy, true);
  assert.deepEqual(f.mutations, []); const saved = await f.editor.save({ planId: plan.planId });
  assert.equal(saved.saved, true); assert.notEqual(saved.revision, doc.revision); assert.equal(saved.text, '\ufeffedited 🌍\n');
  assert.equal(f.entries.get('/home/config.txt').data.toString(), saved.text); assert.equal(f.entries.get('/home/config.txt').mode, 0o100640);
  await assert.rejects(f.editor.save({ planId: plan.planId }), /missing|used/);
});
test('native decline consumes review and keeps original and editable document', async t => {
  const f = fixture(t, { confirm: async () => false }); const doc = await f.open(); const plan = await f.prepare(doc);
  assert.deepEqual(await f.editor.save({ planId: plan.planId }), { cancelled: true }); assert.deepEqual(f.mutations, []);
  assert.equal(f.editor.count, 1); await f.prepare(doc);
});
test('same-size same-time server content change refuses save without mutations', async t => {
  const f = fixture(t); const doc = await f.open(); const entry = f.entries.get('/home/config.txt'); entry.data = Buffer.from('different');
  assert.equal(entry.data.length, Buffer.byteLength(doc.text)); await assert.rejects(f.prepare(doc), /changed on the server/); assert.deepEqual(f.mutations, []);
});
test('change during native confirmation refuses overwrite and preserves proposed text capability', async t => {
  let f; f = fixture(t, { confirm: async () => { f.put('/home/config.txt', 'elsewhere'); return true; } });
  const plan = await f.prepare(await f.open()); await assert.rejects(f.editor.save({ planId: plan.planId }), /changed on the server/); assert.deepEqual(f.mutations, []);
});
test('change during staging refuses final commit and reports retained staging path', async t => {
  const f = fixture(t); const plan = await f.prepare(await f.open()); f.hooks.write = () => f.put('/home/config.txt', 'external');
  await assert.rejects(f.editor.save({ planId: plan.planId }), /staging file may remain/);
  assert.equal(f.entries.get('/home/config.txt').data.toString(), 'external'); assert.equal(f.mutations.filter(x => x[0] === 'commit').length, 0);
});
test('unsafe paths, symlinks, binary text, oversize and special permissions are refused', async t => {
  const f = fixture(t);
  for (const name of ['/home/../config', '/home/a\0', '/home/a\\b', 'relative']) await assert.rejects(f.editor.open({ id: 'session', path: name }), /absolute remote/);
  f.put('/home/config.txt', 'link', 0o120777); await assert.rejects(f.open(), /symbolic/);
  f.put('/home/config.txt', Buffer.from([255])); await assert.rejects(f.open(), /UTF-8/);
  f.put('/home/config.txt', 'a\0b'); await assert.rejects(f.open(), /NUL/);
  f.put('/home/config.txt', Buffer.alloc(1024 * 1024 + 1)); await assert.rejects(f.open(), /1 MiB/);
  f.put('/home/config.txt', 'secret', 0o104700); const doc = await f.open(); await assert.rejects(f.prepare(doc), /special permission/);
  f.put('/home', '', 0o120777); await assert.rejects(f.open(), /symbolic/);
});
test('discard, expiry, revision mismatch, and duplicate operations cannot reuse save plans', async t => {
  const f = fixture(t, { lifetime: 25 }); const doc = await f.open();
  await assert.rejects(f.editor.prepareSave({ documentId: doc.documentId, revision: 'wrong', text: '' }), /revision changed/);
  let plan = await f.prepare(doc); await assert.rejects(f.open(), /Finish or discard/);
  assert.equal(f.editor.discardSave({ planId: plan.planId }), true); assert.equal(f.editor.discardSave({ planId: plan.planId }), false);
  plan = await f.prepare(doc); await pause(40); await assert.rejects(f.editor.save({ planId: plan.planId }), /expired/); assert.equal(f.editor.busy, false);
  assert.equal(await f.editor.close({ documentId: doc.documentId }), true); await assert.rejects(f.prepare(doc), /closed/);
});
test('disconnect aborts pending native approval and shutdown settles owned work', async t => {
  let reached; const seen = new Promise(resolve => { reached = resolve; });
  const f = fixture(t, { confirm: async (_review, { signal }) => { reached(signal); return new Promise(() => {}); } });
  const plan = await f.prepare(await f.open()); const pending = f.editor.save({ planId: plan.planId }); const outcome = assert.rejects(pending, /cancelled/); const signal = await seen;
  await f.editor.closeConnection('session'); await outcome; assert.equal(signal.aborted, true); assert.deepEqual(f.mutations, []);
  await f.editor.closeAll(); assert.equal(f.editor.count, 0);
});
test('save permits empty files and rejects invalid surrogate text without writing', async t => {
  const f = fixture(t); const doc = await f.open(); await assert.rejects(f.prepare(doc, '\ud800'), /valid UTF-8/);
  const result = await f.editor.save({ planId: (await f.prepare(doc, '')).planId }); assert.equal(result.saved, true); assert.equal(f.entries.get('/home/config.txt').data.length, 0);
});
test('unknown commit outcome closes connection and never removes staging data', async t => {
  const f = fixture(t, { commit: () => { throw Object.assign(new Error('Remote commit outcome unknown'), { indeterminate: true, preserveStage: true }); } });
  const plan = await f.prepare(await f.open()); await assert.rejects(f.editor.save({ planId: plan.planId }), /unknown.*staging/s);
  assert.equal(f.session.closed, true); assert.equal(f.entries.get('/home/config.txt').data.toString(), 'original\n'); assert.equal([...f.entries.keys()].filter(x => x.endsWith('.part')).length, 1);
});


test('remote save expires after native approval while rechecking content and performs no writes', async t => {
  let approved = false; const f = fixture(t, { lifetime: 30, confirm: async () => { approved = true; return true; } });
  const plan = await f.prepare(await f.open()); f.hooks.read = async () => { if (approved) await pause(50); };
  await assert.rejects(f.editor.save({ planId: plan.planId }), /expired/); assert.deepEqual(f.mutations, []);
});

test('lost staging open acknowledgment reports the possible owned path', async t => {
  const f = fixture(t); const plan = await f.prepare(await f.open());
  f.hooks.open = (_name, flags) => { if (flags === 'wx+') throw new Error('Open response timed out'); };
  await assert.rejects(f.editor.save({ planId: plan.planId }), /staging file may remain at .*\.part/);
  assert.equal(f.entries.get('/home/config.txt').data.toString(), 'original\n');
});

test('acknowledged save with failed revision refresh returns saved and closed with retained buffer', async t => {
  let committed = false; const f = fixture(t, { commit: async () => { committed = true; } });
  const plan = await f.prepare(await f.open(), 'saved replacement\n');
  f.hooks.realpath = () => { if (committed) throw new Error('Refresh connection lost'); };
  const result = await f.editor.save({ planId: plan.planId });
  assert.equal(result.saved, true); assert.equal(result.closed, true); assert.equal(result.text, 'saved replacement\n');
  assert.match(result.warning, /save was acknowledged/); assert.equal(f.editor.count, 0);
  assert.equal(f.entries.get('/home/config.txt').data.toString(), result.text);
});

test('remote staging content mismatch refuses the reviewed replacement', async t => {
  const f = fixture(t); const plan = await f.prepare(await f.open());
  f.hooks.read = handle => { if (handle.name.endsWith('.part')) handle.item.data[0] ^= 1; };
  await assert.rejects(f.editor.save({ planId: plan.planId }), /staging content differs/);
  assert.equal(f.entries.get('/home/config.txt').data.toString(), 'original\n');
});
