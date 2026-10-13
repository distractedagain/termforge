'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { claimApplicationInstance } = require('../app/single-instance.cjs');

function application(acquired) {
  const app = new EventEmitter();
  app.claims = 0; app.quits = 0;
  app.requestSingleInstanceLock = (...args) => { assert.deepEqual(args, []); app.claims++; return acquired; };
  app.quit = () => { app.quits++; };
  return app;
}
function mainWindow({ destroyed = false, minimized = false } = {}) {
  const actions = [];
  return { actions, destroyed, minimized,
    isDestroyed() { return this.destroyed; }, isMinimized() { return this.minimized; },
    restore() { this.minimized = false; actions.push('restore'); },
    show() { actions.push('show'); }, focus() { actions.push('focus'); } };
}

test('a denied application lock quits and prevents the caller from booting', () => {
  const app = application(false); let booted = false;
  if (claimApplicationInstance(app, () => { throw new Error('Rejected process must not access windows'); })) booted = true;
  assert.equal(booted, false); assert.equal(app.claims, 1); assert.equal(app.quits, 1);
  assert.deepEqual(app.eventNames(), []);
});

test('a secondary launch restores and focuses only the main window without reading forwarded data', () => {
  const app = application(true), window = mainWindow({ minimized: true });
  assert.equal(claimApplicationInstance(app, () => window), true);
  const unreadable = new Proxy({}, { get() { throw new Error('Forwarded commands must never be read'); } });
  app.emit('second-instance', unreadable, unreadable, unreadable, unreadable);
  assert.deepEqual(window.actions, ['restore', 'show', 'focus']);
  assert.equal(app.quits, 0); assert.equal(app.claims, 1);
  app.emit('second-instance');
  assert.deepEqual(window.actions.slice(3), ['show', 'focus']);
});

test('a launch during startup waits for the assigned main window and ignores unrelated child windows', async () => {
  const app = application(true); let window; const child = mainWindow();
  claimApplicationInstance(app, () => window);
  app.emit('second-instance'); app.emit('second-instance');
  app.emit('browser-window-created', {}, child);
  await Promise.resolve(); assert.deepEqual(child.actions, []);
  const main = mainWindow();
  app.emit('browser-window-created', {}, main); window = main;
  await Promise.resolve();
  assert.deepEqual(main.actions, ['show', 'focus']);
  app.emit('browser-window-created', {}, child); await Promise.resolve();
  assert.deepEqual(main.actions, ['show', 'focus']); assert.deepEqual(child.actions, []);
});

test('a destroyed main window is ignored until a replacement is created', async () => {
  const app = application(true), closed = mainWindow({ destroyed: true }); let window = closed;
  claimApplicationInstance(app, () => window); app.emit('second-instance');
  assert.deepEqual(closed.actions, []);
  window = mainWindow({ minimized: true }); app.emit('browser-window-created', {}, window);
  await Promise.resolve(); assert.deepEqual(window.actions, ['restore', 'show', 'focus']);
});
