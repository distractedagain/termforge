'use strict';
// Exercises only the isolated Quick Connect content in headless Chromium.
// Native window frames, traffic lights, and IPC authorization require Electron CI.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { chromium } = require('playwright');
const core = require('../app/core.cjs');

const renderer = path.resolve(__dirname, '../renderer');
const output = path.resolve(process.env.TERMFORGE_QUICK_UI_OUTPUT || path.join(os.tmpdir(), 'termforge-quick-connect-ui-check'));
const checks = [];
const errors = [];
let server, browser, page;
let complete = false;
process.on('beforeExit', () => {
  if (!complete && !process.exitCode) {
    process.stderr.write('Standalone Quick Connect checks ended before verification completed.\n');
    process.exitCode = 1;
  }
});

function installBridge(initialState) {
  let state = structuredClone(initialState);
  let submitMode = 'accept';
  let settleSubmit = null;
  let keyPath = '/synthetic/keys/lab_ed25519';
  const listeners = new Map();
  const calls = { state: 0, submit: [], close: 0, chooseIdentityFile: 0, manageCredentials: 0 };
  const subscribe = name => callback => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(callback);
    return () => listeners.get(name).delete(callback);
  };
  const emit = (name, payload) => {
    for (const callback of listeners.get(name) || []) callback(structuredClone(payload));
  };
  window.__quickQa = {
    calls,
    setSubmitMode(value) { submitMode = value; },
    settleSubmit(result = { accepted: true }) { settleSubmit?.(result); },
    setKeyPath(value) { keyPath = value; },
    credentialsChanged(credentials) { state.credentials = structuredClone(credentials); emit('credentials', credentials); },
    fileSession() { emit('file-session', true); },
    menu(action) { emit('menu', action); },
  };
  window.termforgeQuickConnect = {
    async getState() { calls.state++; return structuredClone(state); },
    async submit(input) {
      calls.submit.push(structuredClone(input));
      await window.__validateQuickProfile(input.profile);
      if (submitMode === 'reject') throw new Error('Synthetic connection request was rejected.');
      if (submitMode === 'pending') return new Promise(resolve => { settleSubmit = resolve; });
      return { accepted: true };
    },
    async close() { calls.close++; },
    async chooseIdentityFile() { calls.chooseIdentityFile++; return keyPath; },
    async manageCredentials() { calls.manageCredentials++; },
    onCredentialsChanged: subscribe('credentials'),
    onFileSession: subscribe('file-session'),
    onMenuAction: subscribe('menu'),
  };
}

async function check(name, run) {
  await run();
  checks.push(name);
  process.stdout.write(`PASS ${name}\n`);
}

async function open(overrides = {}, viewport = { width: 650, height: 610 }) {
  await page?.close();
  page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.exposeFunction('__validateQuickProfile', profile => core.validateSession(profile));
  const state = {
    platform: 'darwin',
    settings: core.validateSettings({ theme: 'light', showQuickConnectOnStartup: false }),
    credentials: [{ id: 'synthetic-credential', name: 'Lab administrator', updatedAt: '2026-01-01T00:00:00.000Z' }],
    serialPorts: [{ path: '/dev/cu.synthetic', friendlyName: 'Synthetic serial device' }],
    ...overrides,
  };
  await page.addInitScript({ content: `(${installBridge.toString()})(${JSON.stringify(state)});` });
  await page.goto(`http://127.0.0.1:${server.address().port}/quick-connect.html`);
  await page.waitForFunction(() => window.__quickQa.calls.state > 0 && document.querySelector('#quick-host') && !document.querySelector('#quick-protocol').disabled);
  await page.locator('#quick-host').waitFor({ state: 'visible' });
  // Initialization may legitimately finish with no saved credentials available.
  await page.waitForFunction(() => !document.querySelector('#quick-fields').disabled && document.activeElement === document.querySelector('#quick-host'));
}

async function submitCount(count) {
  await page.waitForFunction(expected => window.__quickQa.calls.submit.length === expected, count);
}
async function lastSubmission() { return page.evaluate(() => window.__quickQa.calls.submit.at(-1)); }
async function fillHost(value = 'lab.example.test') { await page.locator('#quick-host').fill(value); }
async function screenshot(name) { await page.screenshot({ path: path.join(output, name), animations: 'disabled' }); }
async function dimensions() {
  return page.evaluate(() => ({
    width: innerWidth, height: innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    footer: document.querySelector('#quick-submit').getBoundingClientRect().toJSON(),
    cancel: document.querySelector('#quick-cancel').getBoundingClientRect().toJSON(),
  }));
}

(async () => {
  await fs.mkdir(output, { recursive: true });
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2' };
  server = http.createServer(async (request, response) => {
    try {
      if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405).end(); return; }
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname === '/favicon.ico') { response.writeHead(204).end(); return; }
      const target = path.resolve(renderer, `.${decodeURIComponent(url.pathname)}`);
      if (!target.startsWith(renderer + path.sep) || !mime[path.extname(target)]) { response.writeHead(403).end(); return; }
      const body = await fs.readFile(target);
      response.writeHead(200, { 'Content-Type': mime[path.extname(target)], 'Cache-Control': 'no-store' });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless: true });

  await check('Standalone form starts with SSH2, managed authentication, hostname focus, and no password input', async () => {
    await open();
    assert.equal(await page.title(), 'Quick Connect');
    assert.equal(await page.locator('#quick-protocol').inputValue(), 'ssh');
    assert.equal(await page.locator('#quick-port').inputValue(), '22');
    assert.equal(await page.locator('#quick-backend').inputValue(), 'managed');
    assert.equal(await page.locator('#quick-use-username').isChecked(), true);
    assert.equal(await page.locator('#quick-credential').isDisabled(), true);
    assert.equal(await page.locator('input[type=password]').count(), 0);
    assert.equal(await page.locator('dialog[open]').count(), 0);
    assert.equal(await page.locator('#quick-host').evaluate(element => element === document.activeElement), true);
    assert.equal(await page.locator('#quick-startup').isChecked(), false);
    await screenshot('quick-connect-content-light.png');
  });

  await check('Protocol changes use appropriate ports and hide irrelevant authentication fields', async () => {
    for (const protocol of ['telnet', 'raw']) {
      await open();
      await page.locator('#quick-protocol').selectOption(protocol);
      assert.equal(await page.locator('#quick-port').inputValue(), '23');
      assert.equal(await page.locator('#quick-auth-fields').isVisible(), false);
      await fillHost(`${protocol}.example.test`);
      await page.locator('#quick-submit').click();
      await submitCount(1);
      assert.equal((await lastSubmission()).profile.protocol, protocol);
    }
    await open();
    await page.locator('#quick-protocol').selectOption('telnet');
    await page.locator('#quick-protocol').selectOption('ssh');
    assert.equal(await page.locator('#quick-port').inputValue(), '22');
    assert.equal(await page.locator('#quick-auth-fields').isVisible(), true);
  });

  await check('Serial and local protocols submit their own paths without hidden credentials', async () => {
    await open();
    await page.locator('#quick-use-credential').check();
    await page.locator('#quick-credential').selectOption('synthetic-credential');
    await page.locator('#quick-protocol').selectOption('serial');
    assert.equal(await page.locator('#quick-host').isDisabled(), true);
    await page.locator('#quick-serial').fill('/dev/cu.synthetic');
    await page.locator('#quick-submit').click();
    await submitCount(1);
    const serial = (await lastSubmission()).profile;
    assert.equal(serial.protocol, 'serial');
    assert.equal(serial.serial.path, '/dev/cu.synthetic');
    assert.equal(serial.credentialId || '', '');
    await open();
    await page.locator('#quick-protocol').selectOption('local');
    await page.locator('#quick-cwd').fill('/synthetic/workspace');
    await page.locator('#quick-submit').click();
    await submitCount(1);
    const local = (await lastSubmission()).profile;
    assert.equal(local.protocol, 'local');
    assert.equal(local.cwd, '/synthetic/workspace');
    assert.equal(local.credentialId || '', '');
  });

  await check('Saved credentials send only a credential reference and clear typed username from the submission', async () => {
    await open();
    await fillHost();
    await page.locator('#quick-user').fill('draft-username');
    await page.locator('#quick-use-credential').check();
    await page.locator('#quick-credential').selectOption('synthetic-credential');
    assert.equal(await page.locator('#quick-user').isDisabled(), true);
    await page.locator('#quick-submit').click();
    await submitCount(1);
    const input = await lastSubmission();
    assert.equal(input.profile.credentialId, 'synthetic-credential');
    assert.equal(input.profile.username, '');
    assert.equal(Object.hasOwn(input.profile, 'password'), false);
    assert.equal(await page.locator('input[type=password]').count(), 0);
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  });

  await check('Authentication selection and keyboard reordering determine the submitted order', async () => {
    await open();
    await fillHost();
    await page.locator('#quick-auth-password').focus();
    await page.keyboard.press('Alt+ArrowUp');
    await page.keyboard.press('Alt+ArrowUp');
    await page.locator('#quick-auth-keyboard-interactive').uncheck();
    await page.locator('#quick-submit').click();
    await submitCount(1);
    assert.deepEqual((await lastSubmission()).profile.ssh.authOrder, ['password', 'publickey']);
  });

  await check('Authentication arrow controls move the selected method and stop at list boundaries', async () => {
    await open();
    await page.locator('#quick-auth-password').focus();
    assert.equal(await page.locator('#quick-auth-down').isDisabled(), true);
    await page.locator('#quick-auth-up').click();
    await page.locator('#quick-auth-up').click();
    assert.equal(await page.locator('#quick-auth-up').isDisabled(), true);
    assert.deepEqual(await page.locator('#quick-auth-order [data-method]').evaluateAll(rows => rows.map(row => row.dataset.method)), ['password', 'publickey', 'keyboard-interactive']);
  });

  await check('No authentication method blocks submission with a visible error', async () => {
    await open();
    await fillHost();
    for (const method of ['publickey', 'keyboard-interactive', 'password']) await page.locator(`#quick-auth-${method}`).uncheck();
    await page.locator('#quick-submit').click();
    await page.locator('#quick-error').waitFor({ state: 'visible' });
    assert.match(await page.locator('#quick-error').textContent(), /authentication/i);
    assert.equal(await page.evaluate(() => window.__quickQa.calls.submit.length), 0);
  });

  await check('SFTP selection forces the managed backend and submits a graphical file session', async () => {
    await open();
    await fillHost();
    await page.locator('#quick-backend').selectOption('openssh');
    await page.locator('#quick-sftp').check();
    assert.equal(await page.locator('#quick-backend').inputValue(), 'managed');
    assert.equal(await page.locator('#quick-backend').isDisabled(), true);
    await page.locator('#quick-submit').click();
    await submitCount(1);
    assert.equal((await lastSubmission()).profile.protocol, 'sftp');
    await open();
    await page.locator('#quick-protocol').selectOption('sftp');
    await fillHost();
    await page.locator('#quick-submit').click();
    await submitCount(1);
    assert.equal((await lastSubmission()).profile.protocol, 'sftp');
  });

  await check('A file-session startup preset prepares SFTP without connecting before form submission', async () => {
    await open({ fileSession: true });
    assert.equal(await page.locator('#quick-protocol').inputValue(), 'ssh');
    assert.equal(await page.locator('#quick-sftp').isChecked(), true);
    assert.equal(await page.locator('#quick-backend').inputValue(), 'managed');
    assert.equal(await page.locator('#quick-backend').isDisabled(), true);
    assert.match(await page.locator('#quick-destination-note').textContent(), /file workspace/i);
    assert.equal(await page.evaluate(() => window.__quickQa.calls.submit.length), 0);
    await fillHost('files.example.test');
    await page.locator('#quick-submit').click();
    await submitCount(1);
    assert.equal((await lastSubmission()).profile.protocol, 'sftp');
    assert.equal((await lastSubmission()).profile.host, 'files.example.test');
  });

  await check('File-session requests switch every non-SSH draft to SSH port 22 while retaining hostname and save choices', async () => {
    for (const protocol of ['telnet', 'raw', 'serial', 'local']) {
      await open();
      await fillHost(`${protocol}-draft.example.test`);
      await page.locator('#quick-save').check();
      await page.locator('#quick-name').fill(`${protocol} draft`);
      await page.locator('#quick-protocol').selectOption(protocol);
      await page.evaluate(() => window.__quickQa.fileSession());
      assert.equal(await page.locator('#quick-protocol').inputValue(), 'ssh');
      assert.equal(await page.locator('#quick-sftp').isChecked(), true);
      assert.equal(await page.locator('#quick-port').inputValue(), '22');
      assert.equal(await page.locator('#quick-host').inputValue(), `${protocol}-draft.example.test`);
      assert.equal(await page.locator('#quick-host').evaluate(element => element === document.activeElement), true);
      assert.equal(await page.locator('#quick-save').isChecked(), true);
      assert.equal(await page.locator('#quick-name').inputValue(), `${protocol} draft`);
      assert.equal(await page.evaluate(() => window.__quickQa.calls.submit.length), 0);
      await page.locator('#quick-submit').click();
      await submitCount(1);
      const input = await lastSubmission();
      assert.equal(input.profile.protocol, 'sftp');
      assert.equal(input.profile.port, 22);
      assert.equal(input.saveSession, true);
    }
  });

  await check('File-session requests retain custom SSH and SFTP ports and switch OpenSSH to managed transfers', async () => {
    for (const protocol of ['ssh', 'sftp']) {
      await open();
      await page.locator('#quick-protocol').selectOption(protocol);
      await fillHost('custom-port.example.test');
      await page.locator('#quick-port').fill('2222');
      await page.locator('#quick-user').fill('draft-user');
      if (protocol === 'ssh') await page.locator('#quick-backend').selectOption('openssh');
      await page.evaluate(() => window.__quickQa.fileSession());
      assert.equal(await page.locator('#quick-port').inputValue(), '2222');
      assert.equal(await page.locator('#quick-user').inputValue(), 'draft-user');
      assert.equal(await page.locator('#quick-backend').inputValue(), 'managed');
      assert.equal(await page.locator('#quick-backend').isDisabled(), true);
      await page.locator('#quick-submit').click();
      await submitCount(1);
      const profile = (await lastSubmission()).profile;
      assert.equal(profile.protocol, 'sftp');
      assert.equal(profile.port, 2222);
      assert.equal(profile.username, 'draft-user');
    }
  });

  await check('Unavailable saved credentials show a warning while a manually entered username remains usable', async () => {
    const warning = 'Saved credentials could not be loaded. Use a username or open the credential manager to check storage.';
    await open({ credentials: [], credentialError: warning });
    assert.equal(await page.locator('#quick-error').isVisible(), true);
    assert.equal(await page.locator('#quick-error').textContent(), warning);
    assert.equal(await page.locator('#quick-credential option').count(), 1);
    assert.equal(await page.locator('#quick-use-username').isChecked(), true);
    assert.equal(await page.locator('#quick-user').isDisabled(), false);
    assert.equal(await page.locator('#quick-submit').isDisabled(), false);
    await fillHost('manual.example.test');
    await page.locator('#quick-user').fill('manual-user');
    await page.locator('#quick-submit').click();
    await submitCount(1);
    const profile = (await lastSubmission()).profile;
    assert.equal(profile.username, 'manual-user');
    assert.equal(profile.credentialId || '', '');
    assert.equal(profile.ssh.backend, 'managed');
    assert.equal(Object.hasOwn(profile, 'password'), false);
  });

  await check('System OpenSSH clears saved credential choice and does not validate hidden managed authentication', async () => {
    await open();
    await fillHost();
    await page.locator('#quick-use-credential').check();
    await page.locator('#quick-credential').selectOption('synthetic-credential');
    for (const method of ['publickey', 'keyboard-interactive', 'password']) await page.locator(`#quick-auth-${method}`).uncheck();
    await page.locator('#quick-backend').selectOption('openssh');
    assert.equal(await page.locator('#quick-use-username').isChecked(), true);
    await page.locator('#quick-user').fill('openssh-user');
    await page.locator('#quick-submit').click();
    await submitCount(1);
    const profile = (await lastSubmission()).profile;
    assert.equal(profile.ssh.backend, 'openssh');
    assert.equal(profile.username, 'openssh-user');
    assert.equal(profile.credentialId || '', '');
    assert.ok(profile.ssh.authOrder.length);
  });

  await check('Save session and startup preferences are included with the connection request', async () => {
    await open();
    await fillHost();
    await page.locator('#quick-save').check();
    await page.locator('#quick-name').fill('Saved lab session');
    await page.locator('#quick-startup').check();
    await page.locator('#quick-submit').click();
    await submitCount(1);
    const input = await lastSubmission();
    assert.equal(input.saveSession, true);
    assert.equal(input.showOnStartup, true);
    assert.equal(input.profile.name, 'Saved lab session');
    await open({ settings: core.validateSettings({ showQuickConnectOnStartup: true }) });
    assert.equal(await page.locator('#quick-startup').isChecked(), true);
  });

  await check('Required hostname, port, and saved session name prevent invalid requests', async () => {
    await open();
    await page.locator('#quick-submit').click();
    assert.equal(await page.evaluate(() => window.__quickQa.calls.submit.length), 0);
    await fillHost();
    await page.locator('#quick-port').fill('70000');
    await page.locator('#quick-submit').click();
    assert.equal(await page.evaluate(() => window.__quickQa.calls.submit.length), 0);
    await page.locator('#quick-port').fill('22');
    await page.locator('#quick-save').check();
    await page.locator('#quick-name').fill('');
    await page.locator('#quick-submit').click();
    assert.equal(await page.evaluate(() => window.__quickQa.calls.submit.length), 0);
  });

  await check('Rejected requests show an error, keep the form draft, and permit retry', async () => {
    await open();
    await fillHost();
    await page.evaluate(() => window.__quickQa.setSubmitMode('reject'));
    await page.locator('#quick-submit').click();
    await page.locator('#quick-error').waitFor({ state: 'visible' });
    assert.match(await page.locator('#quick-error').textContent(), /Synthetic connection request was rejected/);
    assert.equal(await page.locator('#quick-host').inputValue(), 'lab.example.test');
    assert.equal(await page.locator('#quick-submit').isDisabled(), false);
    assert.equal(await page.evaluate(() => window.__quickQa.calls.close), 0);
    await page.evaluate(() => window.__quickQa.setSubmitMode('accept'));
    await page.locator('#quick-submit').click();
    await submitCount(2);
  });

  await check('Pending submit disables Connect and ignores repeated submit events', async () => {
    await open();
    await fillHost();
    await page.evaluate(() => window.__quickQa.setSubmitMode('pending'));
    await page.locator('#quick-submit').click();
    await submitCount(1);
    assert.equal(await page.locator('#quick-submit').isDisabled(), true);
    await page.evaluate(() => window.__quickQa.fileSession());
    assert.equal(await page.locator('#quick-sftp').isChecked(), false, 'A file-session request cannot change an in-flight terminal request');
    assert.equal((await lastSubmission()).profile.protocol, 'ssh');
    await page.locator('#quick-connect-form').evaluate(form => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    assert.equal(await page.evaluate(() => window.__quickQa.calls.submit.length), 1);
    await page.evaluate(() => window.__quickQa.settleSubmit());
  });

  await check('Key file selection fills the identity path and cancelling the picker retains it', async () => {
    await open();
    await page.locator('#quick-choose-identity').click();
    await page.waitForFunction(() => document.querySelector('#quick-identity').value === '/synthetic/keys/lab_ed25519');
    await page.evaluate(() => window.__quickQa.setKeyPath(null));
    await page.locator('#quick-choose-identity').click();
    await page.waitForFunction(() => window.__quickQa.calls.chooseIdentityFile === 2);
    assert.equal(await page.locator('#quick-identity').inputValue(), '/synthetic/keys/lab_ed25519');
    await fillHost();
    await page.locator('#quick-submit').click();
    await submitCount(1);
    assert.equal((await lastSubmission()).profile.identityFile, '/synthetic/keys/lab_ed25519');
  });

  await check('Credential manager refreshes metadata without losing hostname, username, or authentication drafts', async () => {
    await open();
    await fillHost('draft.example.test');
    await page.locator('#quick-user').fill('draft-user');
    await page.locator('#quick-auth-password').uncheck();
    await page.locator('#quick-use-credential').check();
    await page.locator('#quick-credential').selectOption('synthetic-credential');
    await page.locator('#quick-manage-credentials').click();
    await page.waitForFunction(() => window.__quickQa.calls.manageCredentials === 1);
    await page.evaluate(() => window.__quickQa.credentialsChanged([
      { id: 'synthetic-credential', name: 'Renamed lab administrator' },
      { id: 'new-credential', name: '<img src=x onerror=alert(1)>' },
    ]));
    await page.waitForFunction(() => document.querySelector('#quick-credential option[value="new-credential"]'));
    assert.equal(await page.locator('#quick-credential').inputValue(), 'synthetic-credential');
    assert.equal(await page.locator('#quick-host').inputValue(), 'draft.example.test');
    assert.equal(await page.locator('#quick-user').inputValue(), 'draft-user');
    assert.equal(await page.locator('#quick-auth-password').isChecked(), false);
    assert.match(await page.locator('#quick-credential').textContent(), /<img src=x/);
    assert.equal(await page.locator('#quick-credential img').count(), 0);
  });

  await check('Removing a selected credential clears its reference and blocks a connection until replaced', async () => {
    await open();
    await fillHost();
    await page.locator('#quick-use-credential').check();
    await page.locator('#quick-credential').selectOption('synthetic-credential');
    await page.evaluate(() => window.__quickQa.credentialsChanged([{ id: 'replacement-credential', name: 'Replacement' }]));
    assert.equal(await page.locator('#quick-credential').inputValue(), '');
    await page.locator('#quick-submit').click();
    assert.equal(await page.evaluate(() => window.__quickQa.calls.submit.length), 0);
    await page.locator('#quick-credential').selectOption('replacement-credential');
    await page.locator('#quick-submit').click();
    await submitCount(1);
    assert.equal((await lastSubmission()).profile.credentialId, 'replacement-credential');
  });

  await check('Cancel and Escape request closure without creating connections', async () => {
    await open();
    await fillHost('discard.example.test');
    await page.locator('#quick-cancel').click();
    await page.waitForFunction(() => window.__quickQa.calls.close === 1);
    assert.equal(await page.evaluate(() => window.__quickQa.calls.submit.length), 0);
    await open();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.__quickQa.calls.close === 1);
    assert.equal(await page.evaluate(() => window.__quickQa.calls.submit.length), 0);
  });

  await check('Form controls have accessible labels and the compact layout retains reachable actions', async () => {
    await open({}, { width: 540, height: 490 });
    const unlabeled = await page.locator('input:not([type=hidden]), select, button').evaluateAll(elements => elements.filter(element => {
      if (element.getClientRects().length === 0 || element.closest('[hidden]')) return false;
      return !element.labels?.length && !element.getAttribute('aria-label') && !element.getAttribute('aria-labelledby') && !(element.tagName === 'BUTTON' && element.textContent.trim());
    }).map(element => element.id || element.tagName));
    assert.deepEqual(unlabeled, []);
    const size = await dimensions();
    assert.ok(size.scrollWidth <= size.width, 'Content must not overflow horizontally');
    for (const rect of [size.footer, size.cancel]) {
      assert.ok(rect.top >= 0 && rect.bottom <= size.height && rect.left >= 0 && rect.right <= size.width, 'Footer actions must remain inside the compact viewport');
    }
    await page.locator('#quick-save').check();
    await page.locator('#quick-name').fill('Compact session');
    await page.locator('#quick-name').evaluate(element => element.scrollIntoView({ block: 'center' }));
    assert.equal(await page.locator('#quick-name').evaluate(element => {
      const field = element.getBoundingClientRect();
      const content = element.closest('main').getBoundingClientRect();
      return field.top >= content.top && field.bottom <= content.bottom;
    }), true, 'The optional session name must scroll fully clear of the fixed footer');
    await screenshot('quick-connect-content-compact.png');
  });

  await check('System dark appearance keeps native-style content readable without drawing window chrome', async () => {
    await open();
    await page.emulateMedia({ colorScheme: 'dark' });
    await screenshot('quick-connect-content-dark.png');
    assert.equal(await page.locator('input[type=password]').count(), 0);
    assert.equal(await page.locator('dialog').count(), 0);
  });

  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({
    passed: checks.length, checks, errors,
    scope: 'Synthetic standalone Quick Connect renderer interactions in headless Chromium. No Electron app, native title bar, OS window controls, credentials, SSH, or file transfer connections are exercised.',
  }, null, 2));
  complete = true;
  process.stdout.write(`PASS ${checks.length} standalone Quick Connect UI checks; ${output}\n`);
})().catch(async error => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: checks.length, complete: false, checks, errors, failure: error.message }, null, 2)).catch(() => {});
}).finally(async () => {
  await browser?.close();
  await new Promise(resolve => server ? server.close(resolve) : resolve());
});
