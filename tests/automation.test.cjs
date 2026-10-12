'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createAutomationManager, recordedInputToPython } = require('../app/automation.cjs');

const pythonPath = process.env.TERMFORGE_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

// Compare Python's printed lines portably without changing captured output,
// terminal writes, or JSON/RPC payloads. Windows Python prints CRLF by default.
function printedText(state, stream) { return state.text(stream).replace(/\r\n/gu, '\n'); }

async function until(check, message = 'condition', timeout = 8000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${message}.`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return check();
}

function setup(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'termforge-automation-test-'));
  const outputs = [], statuses = [], writes = [], children = [];
  const state = { directory, outputs, statuses, writes, children };
  state.manager = createAutomationManager({
    getActiveTerminalId: () => 'terminal-a',
    writeTerminal: input => writes.push(input),
    closeSession: id => state.manager.feedExit({ id }),
    emitOutput: event => outputs.push(event),
    emitStatus: event => statuses.push(event),
    spawn(file, args, options) { const child = spawn(file, args, options); children.push({ child, shimDirectory: path.dirname(args[1]), file, args, options }); return child; },
    ...overrides,
  });
  state.script = (source, name = 'script with spaces.py') => {
    const filename = path.join(directory, name);
    fs.writeFileSync(filename, source, 'utf8');
    return filename;
  };
  state.text = stream => outputs.filter(event => !stream || event.stream === stream).map(event => event.data).join('');
  state.finished = id => until(() => statuses.find(event => event.id === id && ['completed', 'failed', 'cancelled'].includes(event.state)), 'script exit');
  state.run = (source, options = {}) => state.manager.run({ filename: state.script(source), pythonPath, ...options });
  t.after(async () => {
    await state.manager.closeAll();
    assert.equal(state.manager.count, 0);
    for (const item of children) {
      assert.ok(item.child.exitCode !== null || item.child.signalCode !== null || !item.child.pid, 'Python child exited');
      assert.equal(fs.existsSync(item.shimDirectory), false, 'private shim directory removed');
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return state;
}

test('real Python print output, Unicode, partial lines and arguments stay separate from RPC frames', { timeout: 15000 }, async t => {
  const state = setup(t);
  const script = await state.run(`
import sys, crt
print('first', end='')
assert crt.Arguments.Count == 2
assert crt.Arguments.GetArg(0) == 'two words'
assert sys.argv[1:] == ['two words', 'λ']
assert crt.GetScriptTab().Screen is crt.Screen
assert crt.GetScriptTab().Session is crt.Session
assert crt.Session.Connected is True
print('λ-last')
print('stderr line', file=sys.stderr)
crt.Screen.Send('echo synthetic\\r')
`, { arguments: ['two words', 'λ'] });
  assert.equal((await state.finished(script.id)).state, 'completed');
  assert.equal(printedText(state, 'stdout'), 'firstλ-last\n');
  assert.equal(printedText(state, 'stderr'), 'stderr line\n');
  assert.deepEqual(state.writes, [{ id: 'terminal-a', data: 'echo synthetic\r' }]);
  assert.equal(state.children[0].options.shell, false);
  assert.equal(state.children[0].options.windowsHide, true);
  assert.deepEqual(state.children[0].args.slice(0, 1), ['-u']);
});

test('real Python waits handle split terminal data, preserve trailing data and bind the script tab', { timeout: 15000 }, async t => {
  let state;
  state = setup(t, { writeTerminal: input => {
    state.writes.push(input);
    if (input.data === 'probe\r') {
      state.manager.feedData({ id: 'other-terminal', data: 'prompt> wrong' });
      state.manager.feedData({ id: input.id, data: 'banner\r\npro' });
      setTimeout(() => state.manager.feedData({ id: input.id, data: 'mpt> rows λ\r\nDONEafter' }), 20);
    }
  } });
  const script = await state.run(`
import json
crt.Screen.Synchronous = True
crt.Screen.Send('probe\\r')
assert crt.Screen.WaitForString('prompt> ', 2)
text = crt.Screen.ReadString(['never', 'DONE'], 2)
assert crt.Screen.MatchIndex == 2
assert crt.Screen.WaitForStrings(['after', 'wrong'], 2) == 1
print(json.dumps({'text': text}, ensure_ascii=False))
`);
  assert.equal((await state.finished(script.id)).state, 'completed');
  assert.deepEqual(JSON.parse(state.text('stdout')), { text: 'rows λ\r\n' });
});

test('timeouts return documented results and case-insensitive matching keeps original text offsets', { timeout: 15000 }, async t => {
  let state;
  state = setup(t, { writeTerminal: input => state.manager.feedData({ id: input.id, data: 'İ prefix VALUE suffix> ' }) });
  const script = await state.run(`
import json
crt.Screen.Synchronous = True
crt.Screen.Send('probe\\r')
assert crt.Screen.ReadString('value', 1, True) == 'İ prefix '
assert crt.Screen.WaitForString('suffix> ', 1)
assert not crt.Screen.WaitForString('not here', 0.03)
assert crt.Screen.MatchIndex == 0
assert crt.Screen.WaitForStrings(['no', 'either'], 0.03) == 0
assert crt.Screen.ReadString('none', 0.03) == ''
print('timeouts-ok')
`);
  assert.equal((await state.finished(script.id)).state, 'completed');
  assert.equal(printedText(state, 'stdout'), 'timeouts-ok\n');
});

test('cancellation interrupts an indefinite terminal wait, closes Python and allows another script', { timeout: 15000 }, async t => {
  const state = setup(t);
  const first = await state.run(`
crt.Screen.Synchronous = True
print('waiting', flush=True)
crt.Screen.WaitForString('never')
`);
  await until(() => state.text().includes('waiting'), 'Python wait');
  await assert.rejects(state.manager.run({ filename: state.script("print('second')", 'second.py'), pythonPath }), /already running/);
  const stopped = await state.manager.cancel(first.id);
  assert.equal(stopped.state, 'cancelled');
  assert.equal(state.manager.count, 0);
  assert.equal((await state.manager.cancel(first.id)).state, 'stopped');
  const second = await state.run("print('next-run')");
  assert.equal((await state.finished(second.id)).state, 'completed');
  assert.match(state.text(), /next-run/);
});

test('cancellation interrupts Sleep rather than waiting for its timeout', { timeout: 15000 }, async t => {
  const state = setup(t);
  const script = await state.run("print('sleeping', flush=True)\ncrt.Sleep(60000)\n");
  await until(() => state.text().includes('sleeping'), 'Python sleep');
  assert.equal((await state.manager.cancel(script.id)).state, 'cancelled');
  assert.equal(state.manager.count, 0);
});

test('cancellation forcibly terminates a real interpreter that ignores SIGTERM', { timeout: 15000, skip: process.platform === 'win32' }, async t => {
  const state = setup(t);
  const script = await state.run(`
import signal, time
signal.signal(signal.SIGTERM, signal.SIG_IGN)
print('ignore-term', flush=True)
while True:
    time.sleep(1)
`);
  await until(() => state.text().includes('ignore-term'), 'SIGTERM handler');
  const start = Date.now();
  const result = await state.manager.cancel(script.id);
  assert.equal(result.state, 'cancelled');
  assert.equal(result.signal, 'SIGKILL');
  assert.ok(Date.now() - start >= 900, 'forced termination follows the grace period');
  assert.equal(state.manager.count, 0);
});

test('maximum-sized control-character input is supported without confusing JSON framing', { timeout: 15000 }, async t => {
  const state = setup(t);
  const script = await state.run("crt.Screen.Send('\\x00' * (256 * 1024))\nprint('large-send-ok')\n");
  assert.equal((await state.finished(script.id)).state, 'completed');
  assert.equal(state.writes.length, 1);
  assert.equal(Buffer.byteLength(state.writes[0].data), 256 * 1024);
  assert.equal(printedText(state), 'large-send-ok\n');
});

test('terminal closure rejects waits and Connected follows terminal availability', { timeout: 15000 }, async t => {
  const state = setup(t);
  const script = await state.run(`
crt.Screen.Synchronous = True
print('waiting-close', flush=True)
try:
    crt.Screen.WaitForString('never')
except RuntimeError as error:
    assert 'closed' in str(error) or 'not open' in str(error)
assert not crt.Session.Connected
print('closed-ok')
`);
  await until(() => state.text().includes('waiting-close'), 'terminal closure wait');
  state.manager.feedExit({ id: 'terminal-a' });
  assert.equal((await state.finished(script.id)).state, 'completed');
  assert.match(state.text(), /closed-ok/);
});

test('Session.Connect opens only an unambiguous saved profile and Disconnect closes that terminal', { timeout: 15000 }, async t => {
  const opened = [], closed = [];
  const profile = { id: 'profile-1', folder: 'Lab', name: 'Local shell', protocol: 'local' };
  const state = setup(t, { getSessionProfiles: () => [profile], openSession: input => { opened.push(input); return { id: 'terminal-b' }; }, closeSession: id => closed.push(id) });
  const script = await state.run(`
assert crt.Session.Connected
crt.Session.Disconnect()
assert not crt.Session.Connected
crt.Session.Connect('/S "Lab/Local shell"')
assert crt.Session.Connected
crt.Screen.Send('pwd\\r')
crt.Session.Disconnect()
try:
    crt.Session.Connect('/SSH2 example.invalid')
    raise AssertionError('Ad hoc connection should fail')
except RuntimeError:
    pass
try:
    crt.Session.Connect('missing-profile')
    raise AssertionError('Missing profile should fail')
except RuntimeError:
    pass
print('saved-profile-ok')
`);
  assert.equal((await state.finished(script.id)).state, 'completed');
  assert.deepEqual(opened, [profile]);
  assert.deepEqual(closed, ['terminal-a', 'terminal-b']);
  assert.deepEqual(state.writes, [{ id: 'terminal-b', data: 'pwd\r' }]);
  assert.equal(printedText(state), 'saved-profile-ok\n');
});

test('oversized unconsumed terminal output fails visibly and cannot leave the interpreter running', { timeout: 15000 }, async t => {
  const state = setup(t);
  const script = await state.run("crt.Screen.Synchronous = True\nprint('buffer-ready', flush=True)\ncrt.Sleep(60000)\n");
  await until(() => state.text().includes('buffer-ready'), 'synchronous buffer');
  state.manager.feedData({ id: 'terminal-a', data: 'λ'.repeat(600000) });
  const result = await state.finished(script.id);
  assert.equal(result.state, 'failed');
  assert.match(result.error, /1 MiB/);
  assert.equal(state.manager.count, 0);
});

test('real Python errors retain traceback output and unsupported screen properties raise errors', { timeout: 15000 }, async t => {
  const state = setup(t);
  const script = await state.run("crt.Screen.IgnoreEscape = True\n");
  assert.equal((await state.finished(script.id)).state, 'failed');
  assert.match(state.text('stderr'), /AttributeError/);
  assert.match(state.text('stderr'), /IgnoreEscape/);
  assert.equal(state.manager.count, 0);
});

test('invalid script/interpreter input and a missing Python executable clean up without starting automation', { timeout: 15000 }, async t => {
  const state = setup(t);
  await assert.rejects(state.manager.run({ filename: 'relative.py' }), /absolute/);
  await assert.rejects(state.manager.run({ filename: state.script('pass'), pythonPath: 'python3 --something' }), /interpreter/);
  await assert.rejects(state.manager.run({ filename: state.script('pass'), arguments: [42] }), /arguments/);
  const missing = path.join(state.directory, process.platform === 'win32' ? 'missing-python.exe' : 'missing-python');
  await assert.rejects(state.manager.run({ filename: state.script('pass'), pythonPath: missing }), /could not start/);
  assert.equal(state.manager.count, 0);
});

test('real tab collection, activation and screen coordinates use callbacks while the script stays bound', { timeout: 15000 }, async t => {
  let active = 'terminal-a', state;
  const reads = [];
  state = setup(t, {
    getTerminalIds: () => [{ id: 'terminal-a', title: 'First shell' }, { id: 'terminal-b', title: 'Second shell' }],
    getActiveTerminalId: () => active,
    activateTerminal: id => { active = id; },
    getScreen: async input => {
      reads.push(input);
      return { text: input.id === 'terminal-a' ? 'rendered first' : 'rendered second', rows: 24, columns: 80, currentRow: 3, currentColumn: 7 };
    },
    writeTerminal: input => {
      state.writes.push(input);
      state.manager.feedData({ id: input.id, data: input.id === 'terminal-a' ? 'A output A> ' : 'B output B> ' });
    },
  });
  const script = await state.run(`
assert crt.GetTabCount() == 2
first = crt.GetTab(1)
second = crt.GetTab(2)
assert first is crt.GetScriptTab()
assert first.Index == 1 and second.Index == 2
assert first.Caption == 'First shell'
assert second.Caption == 'Second shell'
assert second.Screen.Rows == 24 and second.Screen.Columns == 80
assert second.Screen.CurrentRow == 3 and second.Screen.CurrentColumn == 7
assert first.Screen.Get(1, 1, 1, 20) == 'rendered first'
assert second.Screen.Get(2, 1, 2, 20) == 'rendered second'
second.Activate()
assert crt.GetActiveTab() is second
assert crt.GetScriptTab() is first
first.Screen.Synchronous = True
second.Screen.Synchronous = True
crt.Screen.Send('bound-first\\r')
second.Screen.Send('second-command\\r')
assert second.Screen.ReadString('B> ', 1) == 'B output '
assert first.Screen.ReadString('A> ', 1) == 'A output '
print('two-tabs-ok')
`);
  assert.equal((await state.finished(script.id)).state, 'completed');
  assert.deepEqual(state.writes.map(value => value.id), ['terminal-a', 'terminal-b']);
  assert.equal(active, 'terminal-b');
  assert.ok(reads.some(input => input.id === 'terminal-b' && input.startRow === 2 && input.endColumn === 20));
  assert.equal(printedText(state), 'two-tabs-ok\n');
});

test('Clone and ConnectInTab open real profiles and reconnect keeps existing Python tab references usable', { timeout: 15000 }, async t => {
  const profile = { id: 'saved', name: 'Local shell', protocol: 'local' };
  const available = [{ id: 'terminal-a', title: 'Script shell', profileId: 'saved' }];
  const opened = [], closed = [];
  let count = 0, state;
  state = setup(t, {
    getTerminalIds: () => available,
    getSessionProfiles: () => [profile],
    getTerminalDetails: id => available.find(value => value.id === id),
    openSession: input => {
      opened.push(input);
      const terminal = { id: `opened-${++count}`, title: input.name, profileId: input.id };
      available.push(terminal); return terminal;
    },
    closeSession: id => { closed.push(id); available.splice(available.findIndex(value => value.id === id), 1); state.manager.feedExit({ id }); },
  });
  const script = await state.run(`
original = crt.GetScriptTab()
clone = original.Clone()
assert clone.Index == 2 and clone.Caption == 'Local shell'
assert crt.GetTabCount() == 2
clone.Close()
assert not clone.Session.Connected
other = crt.Session.ConnectInTab('/S saved')
assert other.Index == 2
other.Session.Disconnect()
other.Session.Connect('saved')
assert other.Session.Connected
other.Screen.Send('reconnected-tab\\r')
assert other.Index == 2
assert original.Index == 1
assert crt.GetScriptTab() is original
other.Close()
assert crt.GetTabCount() == 1
print('clone-connect-ok')
`);
  assert.equal((await state.finished(script.id)).state, 'completed');
  assert.deepEqual(opened, [profile, profile, profile]);
  assert.deepEqual(closed, ['opened-1', 'opened-2', 'opened-3']);
  assert.deepEqual(state.writes, [{ id: 'opened-3', data: 'reconnected-tab\r' }]);
  assert.equal(printedText(state), 'clone-connect-ok\n');
});

test('missing tab/screen integrations and invalid coordinate requests fail explicitly', { timeout: 15000 }, async t => {
  const state = setup(t);
  const script = await state.run(`
for action in [lambda: crt.GetTabCount(), lambda: crt.Screen.Rows,
               lambda: crt.Screen.Get(1, 1, 1, 20)]:
    try:
        action()
        raise AssertionError('Missing callback should fail')
    except RuntimeError as error:
        assert 'unavailable' in str(error)
print('unavailable-ok')
`);
  assert.equal((await state.finished(script.id)).state, 'completed');
  assert.equal(printedText(state), 'unavailable-ok\n');

  let calls = 0;
  const invalid = setup(t, { getScreen: () => { calls++; return { text: 'screen', rows: 24, columns: 80, currentRow: 25, currentColumn: 1 }; } });
  const next = await invalid.run(`
for coords in [(0, 1, 1, 2), (2, 1, 1, 2), (1, 4, 1, 3)]:
    try:
        crt.Screen.Get(*coords)
        raise AssertionError('Invalid coordinates should fail')
    except RuntimeError:
        pass
try:
    crt.Screen.Rows
    raise AssertionError('Invalid metadata should fail')
except RuntimeError as error:
    assert 'metadata' in str(error)
print('invalid-screen-ok')
`);
  assert.equal((await invalid.finished(next.id)).state, 'completed');
  assert.equal(calls, 1, 'invalid rectangles are rejected before accessing the renderer');
  assert.equal(printedText(invalid), 'invalid-screen-ok\n');
});

test('cancellation interrupts waits in a different tab without closing either terminal', { timeout: 15000 }, async t => {
  const closed = [];
  const state = setup(t, { getTerminalIds: () => ['terminal-a', 'terminal-b'], closeSession: id => closed.push(id) });
  const script = await state.run("other = crt.GetTab(2)\nother.Screen.Synchronous = True\nprint('other-wait', flush=True)\nother.Screen.WaitForString('never')\n");
  await until(() => state.text().includes('other-wait'), 'second-tab wait');
  assert.equal((await state.manager.cancel(script.id)).state, 'cancelled');
  assert.deepEqual(closed, []);
  assert.equal(state.manager.count, 0);
});

test('cancellation remains responsive while the renderer screen callback is pending', { timeout: 15000 }, async t => {
  let respond;
  const state = setup(t, { getScreen: () => new Promise(resolve => { respond = resolve; }) });
  const script = await state.run("print('screen-pending', flush=True)\nprint(crt.Screen.Rows)\n");
  await until(() => respond, 'pending renderer callback');
  assert.equal((await state.manager.cancel(script.id)).state, 'cancelled');
  respond({ text: '', rows: 24, columns: 80, currentRow: 1, currentColumn: 1 });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(state.manager.count, 0);
  assert.equal(state.statuses.filter(value => value.id === script.id && value.state === 'cancelled').length, 1);
});

test('recorded input generates executable Python without treating quoted commands as code', { timeout: 15000 }, async t => {
  const state = setup(t);
  const payload = `"\\\r\n'); raise AssertionError('injected code') # λ 😀\u0000`;
  const source = recordedInputToPython(['first\r', { data: payload, delayMs: 1 }, { data: 'last\r' }]);
  const script = await state.run(source);
  assert.equal((await state.finished(script.id)).state, 'completed');
  assert.deepEqual(state.writes.map(value => value.data), ['first\r', payload, 'last\r']);
  assert.throws(() => recordedInputToPython([{ data: 'x', delayMs: -1 }]), /delay/);
  assert.throws(() => recordedInputToPython([{ data: 'x', delayMs: 60001 }]), /delay/);
  assert.throws(() => recordedInputToPython(['x'.repeat(256 * 1024 + 1)]), /256 KiB/);
  assert.throws(() => recordedInputToPython(Array(5).fill('x'.repeat(256 * 1024))), /1 MiB/);
  assert.throws(() => recordedInputToPython(Array(10001).fill('')), /10000/);
});
