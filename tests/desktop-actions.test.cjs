'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createDesktopActions, printDocument } = require('../app/desktop-actions.cjs');
test('print output escapes terminal content and rejects empty or oversized input', () => {
  const output = printDocument({ text: '<script>evil()</script>&', title: '<img src=x>', pageSize: 'A4', landscape: true });
  assert.ok(output.html.includes('&lt;script&gt;evil()&lt;/script&gt;&amp;'));
  assert.ok(!output.html.includes('<img'));
  assert.equal(output.options.silent, false);
  assert.equal(output.options.pageSize, 'A4');
  assert.throws(() => printDocument({ text: '' }));
  assert.throws(() => printDocument({ text: 'é'.repeat(1048577) }));
});
test('desktop commands allow only fixed help links and bounded supported opacity', async () => {
  const calls = [];
  const window = { isDestroyed: () => false, setOpacity: v => calls.push(v), isFullScreen: () => false, getOpacity: () => 1 };
  const actions = createDesktopActions({ BrowserWindow: {}, shell: { openExternal: url => calls.push(url) }, getWindow: () => window, platform: 'darwin' });
  await actions.perform('help-updates');
  assert.equal(calls[0], 'https://github.com/distractedagain/termforge/releases');
  await assert.rejects(actions.perform('https://attacker.test'));
  await assert.rejects(actions.perform('window-transparency', 0));
  await assert.rejects(actions.perform('window-transparency', NaN));
  await actions.perform('window-transparency', 0.75);
  assert.equal(calls.at(-1), 0.75);
});
test('print cancellation cleans up sandboxed hidden window and never prints silently', async () => {
  let created;
  class Window extends EventEmitter {
    constructor(options) { super(); this.options = options; created = this; this.webContents = new EventEmitter(); this.webContents.setWindowOpenHandler = () => {}; this.webContents.print = (options, callback) => { assert.equal(options.silent, false); callback(false, 'Print job canceled'); }; }
    async loadURL(url) { assert.ok(url.startsWith('data:text/html;')); }
    isDestroyed() { return !!this.destroyed; }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const actions = createDesktopActions({ BrowserWindow: Window, shell: {}, getWindow: () => ({}) });
  assert.deepEqual(await actions.print({ text: 'sample' }), { printed: false, canceled: true });
  assert.equal(created.options.webPreferences.javascript, false);
  assert.equal(created.options.webPreferences.sandbox, true);
  assert.equal(created.destroyed, true);
});
test('window commands use the focused trusted child rather than closing its parent', async () => {
  let parentClosed = false, childClosed = false;
  const parent = { close: () => { parentClosed = true; } };
  const child = { isDestroyed: () => false, close: () => { childClosed = true; }, isFullScreen: () => false, getOpacity: () => 1 };
  const actions = createDesktopActions({ BrowserWindow: {}, shell: {}, getWindow: () => parent, getActionWindow: () => child });
  await actions.perform('close-window');
  assert.equal(childClosed, true); assert.equal(parentClosed, false);
});
