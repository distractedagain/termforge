'use strict';

// Headless renderer checks. This bridge never opens a network connection,
// launches a shell, runs Python, writes a real log, or accesses a serial device.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const core = require('../app/core.cjs');
const { recordedInputToPython } = require('../app/automation.cjs');
const { createTftpServer } = require('../app/tftp.cjs');
const installFixture = require('./ui-fixture.cjs');

const renderer = path.resolve(__dirname, '../renderer');
const output = path.resolve(process.env.TERMFORGE_UI_OUTPUT || path.join(os.tmpdir(), 'termforge-terminal-ui-check'));
const checks = [];
const consoleErrors = [];
let browser;
const pages = new Set();
const profiles = [
  core.validateSession({ id: 'fixture-router', name: 'router-01', folder: 'Network/Core', host: 'router-01.example.test', username: 'demo', terminal: { backspaceMode: 'bs', deleteMode: 'del', emacsMode: true } }),
  core.validateSession({ id: 'fixture-switch', name: 'switch-01', folder: 'Network/Core', host: 'switch-01.example.test', username: 'demo' }),
  core.validateSession({ id: 'fixture-local', name: 'local-shell', folder: 'Labs', protocol: 'local' }),
];
const snippets = core.validateSnippets([
  { id: 'fixture-version', name: 'Version', command: 'show version', folder: 'Admin/Monitoring', color: '#00bb33', buttonBar: 'Default' },
  { id: 'fixture-interfaces', name: 'Interfaces', command: 'show interfaces status', folder: 'Admin/Network', color: '#0077dd', buttonBar: 'Network' },
]);
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = http.createServer(async (request, response) => {
  try {
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405).end(); return; }
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/favicon.ico') { response.writeHead(204).end(); return; }
    const file = path.resolve(renderer, '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
    if (!file.startsWith(renderer + path.sep)) { response.writeHead(403).end(); return; }
    const data = await fs.readFile(file);
    response.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    response.end(request.method === 'HEAD' ? undefined : data);
  } catch { response.writeHead(404).end(); }
});

async function pageFor(platform = 'darwin', settings = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  pages.add(page); page.setDefaultTimeout(10000);
  page.on('pageerror', error => consoleErrors.push({ platform, message: error.message }));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push({ platform, message: message.text() }); });
  await page.exposeFunction('__validateProfile', input => core.validateSession(input));
  await page.exposeFunction('__validateSettings', input => core.validateSettings(input));
  await page.exposeFunction('__validateSnippets', input => core.validateSnippets(input));
  await page.exposeFunction('__validateSnapshots', (input, sessions) => core.validateSnapshots(input, sessions));
  await page.exposeFunction('__validateHistory', (input, limit) => core.validateCommandHistory(input, limit));
  await page.exposeFunction('__validateRecorded', input => recordedInputToPython(input));
  // Only construct and inspect this validator. Never call server.start(): the
  // UI fixture must not bind UDP or serve any actual folder.
  await page.exposeFunction('__validateTftp', ({ clientAddress, bindAddress, port, allowWrite }) => createTftpServer({ root: path.join(output, 'synthetic-tftp-root'), clientAddress, bindAddress, port, allowWrite }).status());
  await page.addInitScript(installFixture, { platform, settings: core.validateSettings({ ...core.DEFAULT_SETTINGS, ...settings }), sessions: profiles, snippets });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(platform => document.documentElement.dataset.platform === platform, platform);
  await page.locator('#session-search').waitFor({ state: 'visible' });
  // Let the first font/layout pass finish before Playwright checks stability.
  await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
  return page;
}

async function check(name, page, run) {
  try { const evidence = await run(); checks.push({ name, passed: true, evidence: evidence ?? null }); process.stdout.write(`PASS ${name}\n`); }
  catch (error) {
    checks.push({ name, passed: false, error: error.message }); process.stdout.write(`FAIL ${name}: ${error.message}\n`);
    if (page && !page.isClosed()) {
      checks.at(-1).diagnostic = await page.evaluate(() => ({
        fonts: document.fonts.status,
        openDialogs: [...document.querySelectorAll('dialog[open]')].map(dialog => dialog.id),
        manager: document.getElementById('session-manager').hidden,
        sessionRows: [...document.querySelectorAll('.session-main')].map(button => ({ name: button.textContent, box: button.getBoundingClientRect().toJSON(), display: getComputedStyle(button).display, enabled: !button.disabled })),
        toasts: document.getElementById('toast-stack').textContent,
      })).catch(() => null);
      const filename = `failure-${checks.length}.png`;
      await page.screenshot({ path: path.join(output, filename), animations: 'disabled', timeout: 8000 }).catch(error => { checks.at(-1).screenshotError = error.message; });
      // Failed dialogs should not mask later independent controls.
      await page.evaluate(() => { for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close(); }).catch(() => {});
    }
  }
}
const calls = page => page.evaluate(() => JSON.parse(JSON.stringify(window.__qa.calls)));
const state = page => page.evaluate(() => window.__qa.getState());
async function action(page, name) { await page.evaluate(name => window.__qa.emitMenu(name), name); }
async function openProfile(page, name = 'router-01') {
  const before = (await calls(page)).opens.length;
  await page.locator('#dock-sessions').click();
  await page.locator('.session-main').filter({ hasText: name }).dblclick();
  await page.waitForFunction(before => window.__qa.calls.opens.length === before + 1, before);
  const opened = (await calls(page)).opens.at(-1);
  await page.locator(`.terminal-pane[data-connection-id="${opened.id}"]`).waitFor({ state: 'visible' });
  return opened;
}
async function closeDialog(page, id) { await page.locator(`#${id} .dialog-close`).last().click(); }
async function screenshot(page, name) {
  // Remove synthetic notifications so the preview exposes the actual layout.
  await page.evaluate(() => document.getElementById('toast-stack').replaceChildren());
  await page.screenshot({ path: path.join(output, `${name}.png`), animations: 'disabled' });
}
async function nativeDialog(page, name, id) { await action(page, name); await page.locator(`#${id}`).waitFor({ state: 'visible' }); }
async function dimensions(page) {
  return page.evaluate(() => {
    const rect = id => { const element = document.getElementById(id); const box = element.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom }; };
    return { viewport: { width: innerWidth, height: innerHeight }, body: { width: document.body.scrollWidth, height: document.body.scrollHeight }, toolbar: rect('main-toolbar'), manager: rect('session-manager'), terminal: rect('terminal-workspace'), footer: document.querySelector('.workspace-footer').getBoundingClientRect().toJSON() };
  });
}

async function run() {
  const mac = await pageFor();
  await check('macOS uses a single toolbar, vertical managers, and no duplicate menu', mac, async () => {
    assert.equal(await mac.locator('#menu-bar').isVisible(), false);
    assert.equal(await mac.locator('.dock-tab').count(), 3);
    const size = await dimensions(mac); assert.equal(size.toolbar.height, 44); assert.ok(size.manager.width >= 180 && size.manager.width <= 350);
    assert.equal((await calls(mac)).opens.length, 0); assert.equal((await calls(mac)).writes.length, 0); return size;
  });
  await check('Single-click and filter select profiles without connecting', mac, async () => {
    await mac.locator('.session-main').filter({ hasText: 'router-01' }).click(); assert.equal((await calls(mac)).opens.length, 0);
    await mac.locator('#session-search').fill('switch-01'); assert.equal(await mac.locator('.session-main').count(), 1); assert.equal((await calls(mac)).opens.length, 0);
    await mac.locator('#session-search').fill('');
  });
  await check('Session Options saves advanced SSH fields and terminal inheritance', mac, async () => {
    await mac.locator('.session-main').filter({ hasText: 'router-01' }).click(); await nativeDialog(mac, 'session-options', 'profile-dialog');
    await mac.locator('#profile-dialog .category-item[data-category="ssh"]').click();
    await mac.locator('#profile-auth').selectOption('publickey'); await mac.locator('#profile-compression').check(); await mac.locator('#profile-agent-forwarding').check(); await mac.locator('#profile-keepalive').fill('45'); await mac.locator('#profile-connect-timeout').fill('20');
    await mac.locator('#profile-ciphers').fill('chacha20-poly1305@openssh.com,aes256-gcm@openssh.com');
    await mac.locator('#profile-kex').fill('curve25519-sha256'); await mac.locator('#profile-macs').fill('hmac-sha2-256');
    await mac.locator('#profile-dialog .category-item[data-category="appearance"]').click(); await mac.locator('#profile-font-size').fill('18'); await mac.locator('#profile-cursor-blink').selectOption('false'); await mac.locator('#save-profile').click();
    await mac.locator('#profile-dialog').waitFor({ state: 'hidden' }); const saved = (await state(mac)).sessions.find(profile => profile.id === 'fixture-router');
    assert.equal(saved.ssh.authMethod, 'publickey'); assert.equal(saved.ssh.agentForwarding, true); assert.equal(saved.ssh.keepAliveInterval, 45); assert.equal(saved.ssh.connectTimeout, 20); assert.deepEqual(saved.ssh.ciphers, ['chacha20-poly1305@openssh.com', 'aes256-gcm@openssh.com']); assert.equal(saved.terminal.fontSize, 18); assert.equal(saved.terminal.cursorBlink, false); assert.equal(saved.terminal.colorScheme, ''); assert.equal((await calls(mac)).opens.length, 0);
  });
  await check('Telnet profile uses port 23 and excludes SSH authentication fields', mac, async () => {
    await nativeDialog(mac, 'new-session', 'profile-dialog'); await mac.locator('#profile-name').fill('synthetic-telnet'); await mac.locator('#profile-host').fill('telnet.example.test'); await mac.locator('#profile-protocol-select').selectOption('telnet');
    assert.equal(await mac.locator('#profile-port').inputValue(), '23'); assert.equal(await mac.locator('#profile-username').isVisible(), false);
    await mac.locator('#save-profile').click(); await mac.locator('#profile-dialog').waitFor({ state: 'hidden' }); const saved = (await state(mac)).sessions.find(profile => profile.name === 'synthetic-telnet'); assert.equal(saved.protocol, 'telnet'); assert.equal(saved.port, 23); assert.equal(saved.username, '');
  });
  await check('Serial category enumerates synthetic ports and saves device settings', mac, async () => {
    await nativeDialog(mac, 'new-session', 'profile-dialog'); await mac.locator('#profile-name').fill('synthetic-serial'); await mac.locator('#profile-protocol-select').selectOption('serial');
    await mac.locator('#refresh-serial-ports').click(); await mac.waitForFunction(() => document.querySelector('#serial-port-options option')?.value === '/dev/cu.fixture');
    await mac.locator('#profile-serial-path').fill('/dev/cu.fixture'); await mac.locator('#profile-serial-baud').selectOption('115200'); await mac.locator('#profile-serial-bits').selectOption('7'); await mac.locator('#profile-serial-parity').selectOption('even'); await mac.locator('#profile-serial-flow').selectOption('rtscts');
    await mac.locator('#save-profile').click(); await mac.locator('#profile-dialog').waitFor({ state: 'hidden' }); const saved = (await state(mac)).sessions.find(profile => profile.name === 'synthetic-serial'); assert.equal(saved.serial.path, '/dev/cu.fixture'); assert.equal(saved.serial.baudRate, 115200); assert.equal(saved.serial.dataBits, 7); assert.equal(saved.serial.parity, 'even'); assert.equal(saved.serial.flowControl, 'rtscts'); assert.equal(saved.host, '');
  });
  await check('Global Options preserve controls across categories and save literal rules', mac, async () => {
    await nativeDialog(mac, 'settings', 'settings-dialog'); await mac.locator('#settings-theme').selectOption('dark'); await mac.locator('#settings-font').fill('16');
    await mac.locator('#settings-dialog .category-item[data-category="appearance"]').click(); await mac.locator('#settings-cursor').selectOption('underline'); await mac.locator('#settings-font-family').fill('Menlo, Consolas, monospace'); await mac.locator('#settings-bell').selectOption('visual');
    await mac.locator('#settings-dialog .category-item[data-category="mouse"]').click(); await mac.locator('#settings-history-limit').fill('20');
    await mac.locator('#settings-dialog .category-item[data-category="keywords"]').click(); await mac.locator('#add-keyword').click(); await mac.locator('#keyword-editor [data-field="text"]').fill('DEMO'); await mac.locator('#settings-form [type="submit"]').click();
    await mac.locator('#settings-dialog').waitFor({ state: 'hidden' }); const saved = (await state(mac)).settings; assert.equal(saved.fontSize, 16); assert.equal(saved.cursorStyle, 'underline'); assert.equal(saved.fontFamily, 'Menlo, Consolas, monospace'); assert.equal(saved.commandHistoryLimit, 20); assert.equal(saved.confirmPaste, true); assert.equal(saved.keywords[0].text, 'DEMO');
  });
  let router;
  await check('Double-click opens one real xterm instance through the synthetic bridge', mac, async () => {
    router = await openProfile(mac); assert.equal((await calls(mac)).opens.length, 1); assert.equal(router.request.sessionId, 'fixture-router'); assert.ok((await mac.locator('#workspace-status').innerText()).includes('Terminal open')); await mac.locator('.xterm-decoration').first().waitFor();
  });
  await check('Button Bar switches named bars and previews commands without input', mac, async () => {
    const before = (await calls(mac)).writes.length; await mac.locator('#button-bar-select').selectOption('Network'); await mac.locator('#snippet-list .snippet-button').filter({ hasText: 'Interfaces' }).click();
    assert.equal(await mac.locator('#command-input').inputValue(), 'show interfaces status'); assert.equal((await calls(mac)).writes.length, before); await mac.locator('#button-bar-select').selectOption('Default');
  });
  await check('Command Manager preserves nested folders, filter, Enter-send, and history', mac, async () => {
    await action(mac, 'show-command-manager'); await mac.locator('#command-filter').fill('Version'); const text = await mac.locator('#command-manager-list').innerText(); assert.ok(text.includes('Admin') && text.includes('Monitoring') && text.includes('Version')); assert.equal(await mac.locator('.command-manager-row').count(), 1);
    const before = (await calls(mac)).writes.length; const command = mac.locator('.command-manager-row'); await command.click(); assert.equal((await calls(mac)).writes.length, before); await command.press('Enter');
    await mac.waitForFunction(before => window.__qa.calls.writes.length === before + 1, before); await mac.waitForFunction(() => window.__qa.getState().commandHistory[0] === 'show version'); assert.equal((await calls(mac)).writes.at(-1).data, 'show version\r');
    await mac.locator('#command-history').selectOption('0'); assert.equal(await mac.locator('#command-input').inputValue(), 'show version');
  });
  await check('Command editor persists command folder, color, and Button Bar name', mac, async () => {
    await nativeDialog(mac, 'snippets', 'snippets-dialog'); const row = mac.locator('.snippet-edit-row').first(); await row.locator('[data-field="folder"]').fill('Operations/Read only'); await row.locator('[data-field="buttonBar"]').fill('Operations'); await row.locator('[data-field="color"]').fill('#bb3344'); await mac.locator('#save-snippets').click();
    await mac.locator('#snippets-dialog').waitFor({ state: 'hidden' }); const command = (await state(mac)).snippets.find(item => item.id === 'fixture-version'); assert.equal(command.folder, 'Operations/Read only'); assert.equal(command.buttonBar, 'Operations'); assert.equal(command.color, '#bb3344'); await mac.locator('#button-bar-select').selectOption('Operations');
  });
  await check('Multi-selection bulk edits only chosen fields on chosen profiles', mac, async () => {
    await mac.locator('#dock-sessions').click(); await mac.locator('.session-main').filter({ hasText: 'router-01' }).click(); await mac.locator('.session-main').filter({ hasText: 'switch-01' }).click({ modifiers: ['Meta'] }); assert.ok((await mac.locator('#session-selection').innerText()).includes('2 sessions'));
    const before = await state(mac); await nativeDialog(mac, 'session-options', 'bulk-dialog'); await mac.locator('#bulk-folder-enable').check(); await mac.locator('#bulk-folder').fill('Edited'); await mac.locator('#bulk-font-enable').check(); await mac.locator('#bulk-font').fill('19'); await mac.locator('#bulk-save').click(); await mac.locator('#bulk-dialog').waitFor({ state: 'hidden' });
    const after = await state(mac); for (const id of ['fixture-router', 'fixture-switch']) { const changed = after.sessions.find(profile => profile.id === id); const previous = before.sessions.find(profile => profile.id === id); assert.equal(changed.folder, 'Edited'); assert.equal(changed.terminal.fontSize, 19); assert.equal(changed.username, previous.username); assert.deepEqual(changed.ssh, previous.ssh); } assert.deepEqual(after.sessions.find(profile => profile.id === 'fixture-local'), before.sessions.find(profile => profile.id === 'fixture-local'));
  });
  await check('Invalid bulk edit validates the entire batch before mutation', mac, async () => {
    const before = (await state(mac)).sessions; await nativeDialog(mac, 'session-options', 'bulk-dialog'); await mac.locator('#bulk-folder-enable').check(); await mac.locator('#bulk-folder').fill('../invalid'); await mac.locator('#bulk-save').click(); await mac.locator('#bulk-error').waitFor(); assert.deepEqual((await state(mac)).sessions, before); await closeDialog(mac, 'bulk-dialog');
  });
  await check('Connect Bar supports saved names and ad-hoc SSH addresses', mac, async () => {
    const before = (await calls(mac)).opens.length; await mac.locator('#connect-address').fill('ssh://tester@example.test:2200'); await mac.locator('#connect-address').press('Enter'); await mac.waitForFunction(before => window.__qa.calls.opens.length === before + 1, before); const connection = (await calls(mac)).opens.at(-1); assert.equal(connection.profile.username, 'tester'); assert.equal(connection.profile.host, 'example.test'); assert.equal(connection.profile.port, 2200);
    await mac.locator('#connect-address').fill('/S local-shell'); await mac.locator('#connect-address').press('Enter'); await mac.waitForFunction(before => window.__qa.calls.opens.length === before + 2, before); assert.equal((await calls(mac)).opens.at(-1).request.sessionId, 'fixture-local');
  });
  await check('Connect Bar refuses embedded passwords without opening a session', mac, async () => {
    const before = (await calls(mac)).opens.length; await mac.locator('#connect-address').fill('ssh://demo:secret@example.test'); await mac.locator('#connect-address').press('Enter'); await mac.locator('.toast').filter({ hasText: 'Passwords must be entered' }).waitFor(); assert.equal((await calls(mac)).opens.length, before);
  });
  await check('Quick Connect Raw TCP uses port 23 and does not save by default', mac, async () => {
    const before = await state(mac); const count = (await calls(mac)).opens.length; await nativeDialog(mac, 'quick-connect', 'quick-connect-dialog'); await mac.locator('#quick-protocol').selectOption('raw'); assert.equal(await mac.locator('#quick-port').inputValue(), '23'); await mac.locator('#quick-host').fill('raw.example.test'); await mac.locator('#quick-submit').click(); await mac.waitForFunction(count => window.__qa.calls.opens.length === count + 1, count); assert.equal((await calls(mac)).opens.at(-1).profile.protocol, 'raw'); assert.equal((await state(mac)).sessions.length, before.sessions.length);
  });
  await check('Tabs clone and reorder with real browser drag events', mac, async () => {
    await mac.locator('.tab-label').filter({ hasText: 'router-01' }).click(); const before = (await calls(mac)).opens.length; await action(mac, 'clone-session'); await mac.waitForFunction(before => window.__qa.calls.opens.length === before + 1, before); assert.equal((await calls(mac)).opens.at(-1).profile.id, 'fixture-router');
    const order = await mac.locator('.terminal-tab').evaluateAll(nodes => nodes.map(node => node.dataset.connectionId)); await mac.locator('.terminal-tab').last().dragTo(mac.locator('.terminal-tab').first()); await mac.waitForFunction(id => document.querySelector('.terminal-tab')?.dataset.connectionId === id, order.at(-1)); assert.equal(await mac.locator('.terminal-tab').first().getAttribute('data-connection-id'), order.at(-1));
    const displayed = await mac.locator('.terminal-tab').evaluateAll(nodes => nodes.map(node => node.dataset.connectionId));
    assert.deepEqual((await calls(mac)).orders.at(-1), displayed);
  });
  await check('Snapshots deduplicate cloned profiles and selecting never connects', mac, async () => {
    await nativeDialog(mac, 'snapshots', 'snapshots-dialog'); await mac.locator('#snapshot-name').fill('Synthetic workspace'); await mac.locator('#snapshot-save').click(); await mac.waitForFunction(() => window.__qa.getState().snapshots.length === 1);
    const snapshot = (await state(mac)).snapshots[0]; assert.equal(new Set(snapshot.sessionIds).size, snapshot.sessionIds.length); assert.equal(snapshot.sessionIds.filter(id => id === 'fixture-router').length, 1); assert.ok(snapshot.sessionIds.includes('fixture-local')); assert.equal(snapshot.layout.activeSessionId, 'fixture-router');
    const before = (await calls(mac)).opens.length; await mac.locator('.snapshot-row').getByRole('button', { name: 'Select', exact: true }).click(); assert.equal((await calls(mac)).opens.length, before);
  });
  await check('Snapshot connections require confirmation and preserve saved order', mac, async () => {
    const before = (await calls(mac)).opens.length; const snapshot = (await state(mac)).snapshots[0]; await mac.locator('.snapshot-row').getByRole('button', { name: 'Connect…' }).click(); await mac.locator('#confirm-dialog').waitFor(); assert.equal((await calls(mac)).opens.length, before); await mac.locator('#confirm-cancel').click(); assert.equal((await calls(mac)).opens.length, before);
    await mac.locator('.snapshot-row').getByRole('button', { name: 'Connect…' }).click(); await mac.locator('#confirm-accept').click(); await mac.waitForFunction(count => window.__qa.calls.opens.length === count, before + snapshot.sessionIds.length); assert.deepEqual((await calls(mac)).opens.slice(before).map(item => item.request.sessionId), snapshot.sessionIds);
  });
  await check('Tile orientations and Active Sessions manage all open tabs', mac, async () => {
    for (const orientation of ['horizontal', 'vertical', 'grid']) { await action(mac, `tile-${orientation}`); await mac.waitForFunction(value => document.getElementById('terminal-workspace').dataset.orientation === value, orientation); assert.equal(await mac.locator('.terminal-pane:visible').count(), (await calls(mac)).opens.length); }
    await action(mac, 'show-active-sessions'); await mac.locator('#active-filter').fill('router-01'); assert.ok(await mac.locator('.active-session-row').count() >= 2); await mac.locator('.active-session-row').first().click(); await mac.locator('#active-filter').fill('');
  });
  await check('macOS responsive chrome and panes fit 1280 and 850 pixel viewports', mac, async () => {
    await action(mac, 'tile'); await screenshot(mac, 'macos-synthetic-1280x800'); const large = await dimensions(mac); assert.equal(large.body.width, 1280); assert.equal(large.body.height, 800);
    await mac.setViewportSize({ width: 850, height: 600 }); await screenshot(mac, 'macos-synthetic-850x600'); const small = await dimensions(mac); assert.equal(small.body.width, 850); assert.equal(small.body.height, 600); assert.ok(small.toolbar.right <= 850); assert.ok(small.footer.bottom <= 600); await mac.setViewportSize({ width: 1280, height: 800 }); return { large, small };
  });

  const transfers = await pageFor(); const first = await openProfile(transfers); await openProfile(transfers, 'switch-01');
  await check('macOS Control shortcuts reach the shell while Command remains an app modifier', transfers, async () => {
    const controls = await pageFor(); const terminal = await openProfile(controls);
    await controls.locator(`.terminal-pane[data-connection-id="${terminal.id}"] .xterm-helper-textarea`).focus();
    const before = (await calls(controls)).writes.length; const opens = (await calls(controls)).opens.length;
    for (const key of ['w', 'f', 't', 'k']) await controls.keyboard.press(`Control+${key}`);
    await controls.waitForFunction(before => window.__qa.calls.writes.length === before + 4, before);
    assert.deepEqual((await calls(controls)).writes.slice(before).map(write => write.data), ['\x17', '\x06', '\x14', '\x0b']);
    assert.equal((await calls(controls)).opens.length, opens); assert.equal(await controls.locator('#confirm-dialog').isVisible(), false);
    await controls.keyboard.press('Meta+f'); await controls.locator('#terminal-search-bar').waitFor({ state: 'visible' }); await controls.locator('#close-search').click();
  });
  await check('Broadcast withholds every write until confirmation', transfers, async () => {
    await action(transfers, 'show-command-window'); await transfers.locator('#command-input').fill('show clock'); await transfers.locator('#broadcast-mode').check(); await transfers.locator('#send-command').click(); await transfers.locator('#confirm-dialog').waitFor(); assert.equal((await calls(transfers)).writes.length, 0); assert.equal(await transfers.locator('.confirm-target-item').count(), 2); await transfers.locator('#confirm-cancel').click(); assert.equal((await calls(transfers)).writes.length, 0);
    await transfers.locator('#send-command').click(); await transfers.locator('#confirm-accept').click(); await transfers.waitForFunction(() => window.__qa.calls.writes.length === 2); assert.ok((await calls(transfers)).writes.every(write => write.data === 'show clock\r')); await transfers.locator('#broadcast-mode').uncheck();
  });
  await check('ASCII text send shows exact preview; cancellation sends nothing', transfers, async () => {
    const before = (await calls(transfers)).writes.length; await nativeDialog(transfers, 'send-ascii', 'confirm-dialog'); assert.equal(await transfers.locator('#confirm-preview').textContent(), 'show clock\n'); await transfers.locator('#confirm-cancel').click(); assert.equal((await calls(transfers)).writes.length, before);
    await nativeDialog(transfers, 'send-ascii', 'confirm-dialog'); await transfers.locator('#confirm-accept').click(); await transfers.waitForFunction(before => window.__qa.calls.writes.length === before + 1, before); assert.equal((await calls(transfers)).writes.at(-1).data, 'show clock\r');
  });
  await check('Logging pauses and resumes the existing log', transfers, async () => {
    await nativeDialog(transfers, 'log', 'confirm-dialog'); await transfers.locator('#confirm-accept').click(); await transfers.waitForFunction(() => window.__qa.calls.logs.length === 1); await action(transfers, 'pause-log'); await transfers.waitForFunction(() => window.__qa.calls.logs.length === 2); assert.equal((await calls(transfers)).logs[1].paused, true); await action(transfers, 'pause-log'); await transfers.waitForFunction(() => window.__qa.calls.logs.length === 3); assert.equal((await calls(transfers)).logs[2].paused, false); assert.equal((await calls(transfers)).logs.filter(item => 'enabled' in item).length, 1);
  });
  await check('Multiline clipboard paste is reviewed and cancellation is inert', transfers, async () => {
    await transfers.evaluate(() => window.__qa.setClipboard('show clock\nshow version\n')); const before = (await calls(transfers)).writes.length; await nativeDialog(transfers, 'paste', 'confirm-dialog'); await transfers.locator('#confirm-cancel').click(); assert.equal((await calls(transfers)).writes.length, before); await nativeDialog(transfers, 'paste', 'confirm-dialog'); await transfers.locator('#confirm-accept').click(); await transfers.waitForFunction(before => window.__qa.calls.writes.length > before, before); assert.ok((await calls(transfers)).writes.at(-1).data.includes('show version'));
  });
  await check('Backspace and Delete mappings send the configured bytes', transfers, async () => {
    await transfers.locator('.tab-label').filter({ hasText: 'router-01' }).click(); await transfers.locator(`.terminal-pane[data-connection-id="${first.id}"] .xterm-helper-textarea`).focus(); const before = (await calls(transfers)).writes.length; await transfers.keyboard.press('Backspace'); await transfers.keyboard.press('Delete'); await transfers.waitForFunction(before => window.__qa.calls.writes.length === before + 2, before); assert.deepEqual((await calls(transfers)).writes.slice(before).map(write => write.data), ['\x08', '\x7f']);
  });
  await check('Rendered screen rectangle uses cells, cursor metadata, and the write barrier', transfers, async () => {
    await transfers.evaluate(id => { window.__qa.emitData(id, '\x1b[2J\x1b[HABCDE\r\nSecond line'); window.__qa.emitScreen({ requestId: 'fixture-screen-rectangle', id, startRow: 1, startColumn: 2, endRow: 2, endColumn: 4 }); }, first.id);
    await transfers.waitForFunction(() => window.__qa.calls.screens.some(item => item.requestId === 'fixture-screen-rectangle')); const screen = (await calls(transfers)).screens.find(item => item.requestId === 'fixture-screen-rectangle'); assert.equal(screen.text, 'BCD\r\neco'); assert.ok(screen.rows >= 10 && screen.columns >= 20); assert.equal(screen.currentRow, 2); assert.equal(screen.currentColumn, 12);
  });
  await check('Unavailable and out-of-range screen requests return explicit errors', transfers, async () => {
    await transfers.evaluate(id => { window.__qa.emitScreen({ requestId: 'fixture-screen-missing', id: 'missing' }); window.__qa.emitScreen({ requestId: 'fixture-screen-bounds', id, startRow: 1, startColumn: 1, endRow: 10000, endColumn: 10000 }); }, first.id); await transfers.waitForFunction(() => window.__qa.calls.screens.filter(item => ['fixture-screen-missing', 'fixture-screen-bounds'].includes(item.requestId)).length === 2);
    const screens = (await calls(transfers)).screens.filter(item => ['fixture-screen-missing', 'fixture-screen-bounds'].includes(item.requestId)); assert.ok(screens.every(screen => typeof screen.error === 'string' && screen.error.length));
  });
  await check('Literal highlighting treats terminal markup as text and decorates it safely', transfers, async () => {
    await transfers.locator('#keyword-input').fill('<img'); await transfers.evaluate(id => window.__qa.emitData(id, '\r\n<img src=x onerror="window.__qaInjected=true">\r\n'), first.id); await transfers.locator(`.terminal-pane[data-connection-id="${first.id}"] .xterm-decoration`).first().waitFor(); assert.equal(await transfers.locator('#terminal-workspace img').count(), 0); assert.equal(await transfers.evaluate(() => window.__qaInjected === true), false);
    await transfers.locator('#keyword-input').fill('['); assert.equal(await transfers.evaluate(() => window.__qaInjected === true), false);
  });
  await check('Python status/output are retained as text and cancellation reaches the bridge', transfers, async () => {
    await nativeDialog(transfers, 'script-run', 'script-output-dialog'); const id = (await calls(transfers)).scriptRuns.length && await transfers.locator('#script-list').inputValue(); assert.ok(id);
    await transfers.evaluate(id => { window.__qa.emitScript({ id, filename: 'synthetic.py', state: 'running' }); window.__qa.emitOutput({ id, stream: 'stdout', data: '<script>window.__qaInjected=true</script>\nSynthetic output\n' }); }, id); assert.ok((await transfers.locator('#script-output').innerText()).includes('Synthetic output')); assert.equal(await transfers.evaluate(() => window.__qaInjected === true), false);
    await transfers.locator('#cancel-script').click(); await transfers.waitForFunction(() => window.__qa.calls.scriptCancels.length === 1); assert.equal((await calls(transfers)).scriptCancels[0], id); assert.ok((await transfers.locator('#script-status').innerText()).includes('cancelled')); await closeDialog(transfers, 'script-output-dialog');
  });
  await check('Script-created terminal tabs activate without a duplicate terminal-open call', transfers, async () => {
    const before = (await calls(transfers)).opens.length; await transfers.evaluate(profile => window.__qa.emitOpened({ id: 'fixture-script-terminal', title: 'Script-created DEMO SESSION', protocol: profile.protocol, profile }), profiles[2]); await transfers.locator('.terminal-pane[data-connection-id="fixture-script-terminal"]').waitFor({ state: 'visible' }); assert.equal((await calls(transfers)).opens.length, before); await transfers.waitForFunction(() => window.__qa.calls.active.includes('fixture-script-terminal'));
  });
  await check('Recorder starts explicitly, captures input, reviews removal, and exports valid Python', transfers, async () => {
    await transfers.locator('.tab-label').filter({ hasText: 'router-01' }).click();
    await nativeDialog(transfers, 'script-record', 'confirm-dialog'); await transfers.locator('#confirm-cancel').click(); assert.equal((await calls(transfers)).recordedScripts.length, 0);
    await nativeDialog(transfers, 'script-record', 'confirm-dialog'); await transfers.locator('#confirm-accept').click(); await transfers.waitForFunction(() => document.getElementById('workspace-status').textContent.includes('Recording input'));
    await transfers.locator(`.terminal-pane[data-connection-id="${first.id}"] .xterm-helper-textarea`).focus(); await transfers.keyboard.type('demo'); await transfers.keyboard.press('Enter');
    await action(transfers, 'script-record'); await transfers.locator('#recorder-dialog').waitFor(); assert.ok(await transfers.locator('.recorded-event').count() >= 2); const count = await transfers.locator('.recorded-event').count(); await transfers.locator('.recorded-event .icon-button').first().click(); assert.equal(await transfers.locator('.recorded-event').count(), count - 1);
    await transfers.locator('#recorder-save').click(); await transfers.waitForFunction(() => window.__qa.calls.recordedScripts.length === 1); const recording = (await calls(transfers)).recordedScripts[0]; assert.ok(recording.events.length); assert.ok(recording.source.includes('crt.Screen.Send')); assert.ok(recording.source.includes('json.loads')); assert.equal(await transfers.locator('#recorder-dialog').isVisible(), false);
  });
  await check('Serial and Telnet Break actions target only the active synthetic connection', mac, async () => {
    await openProfile(mac, 'synthetic-serial'); const before = (await calls(mac)).breaks.length; await action(mac, 'send-break'); await mac.waitForFunction(before => window.__qa.calls.breaks.length === before + 1, before); assert.equal((await calls(mac)).breaks.at(-1), (await calls(mac)).opens.at(-1).id);
    await openProfile(mac, 'synthetic-telnet'); await action(mac, 'send-break'); await mac.waitForFunction(before => window.__qa.calls.breaks.length === before + 2, before); assert.equal((await calls(mac)).breaks.at(-1), (await calls(mac)).opens.at(-1).id);
  });
  let mapped;
  await check('Mapped-key editor persists text and menu mappings through production validation', transfers, async () => {
    await transfers.locator('#dock-sessions').click(); await transfers.locator('.session-main').filter({ hasText: 'router-01' }).click(); await nativeDialog(transfers, 'session-options', 'profile-dialog'); await transfers.locator('#profile-dialog .category-item[data-category="keyboard"]').click();
    await transfers.locator('#profile-mapped-keys').getByRole('button', { name: 'Add mapped key' }).click(); await transfers.getByLabel('Mapping 1 key combination', { exact: true }).fill('F1'); await transfers.getByLabel('Mapping 1 text to send', { exact: true }).fill('show clock\\r');
    await transfers.locator('#profile-mapped-keys').getByRole('button', { name: 'Add mapped key' }).click(); await transfers.getByLabel('Mapping 2 key combination', { exact: true }).fill('F2'); await transfers.getByLabel('Mapping 2 action', { exact: true }).selectOption('menu'); await transfers.getByLabel('Mapping 2 menu action', { exact: true }).selectOption('find'); await transfers.locator('#save-profile').click(); await transfers.locator('#profile-dialog').waitFor({ state: 'hidden' });
    const saved = (await state(transfers)).sessions.find(profile => profile.id === 'fixture-router'); assert.deepEqual(saved.terminal.mappedKeys, [{ key: 'F1', action: 'send', value: 'show clock\\r' }, { key: 'F2', action: 'menu', value: 'find' }]); mapped = await openProfile(transfers);
  });
  await check('Mapped keys override xterm text and invoke a menu without extra input', transfers, async () => {
    await transfers.locator(`.terminal-pane[data-connection-id="${mapped.id}"] .xterm-helper-textarea`).focus(); const before = (await calls(transfers)).writes.length; await transfers.keyboard.press('F1'); await transfers.waitForFunction(before => window.__qa.calls.writes.length === before + 1, before); assert.equal((await calls(transfers)).writes.at(-1).data, 'show clock\r');
    await transfers.keyboard.press('F2'); await transfers.locator('#terminal-search-bar').waitFor({ state: 'visible' }); assert.equal((await calls(transfers)).writes.length, before + 1); await transfers.locator('#close-search').click();
    assert.ok((await calls(transfers)).focus.some(event => event.id === mapped.id && event.focused));
  });
  await check('Native mapped-key and script Activate events target the requested terminal', transfers, async () => {
    const before = (await calls(transfers)).writes.length; await transfers.evaluate(({ id, oldId }) => { window.__qa.emitActivated(oldId); window.__qa.emitMapped({ id, mapping: { key: 'F1', action: 'send', value: 'native-fixture\\r' } }); }, { id: mapped.id, oldId: first.id }); await transfers.waitForFunction(before => window.__qa.calls.writes.length === before + 1, before); const write = (await calls(transfers)).writes.at(-1); assert.equal(write.id, mapped.id); assert.equal(write.data, 'native-fixture\r'); await transfers.waitForFunction(id => document.querySelector(`.terminal-tab[data-connection-id="${id}"]`)?.classList.contains('active'), first.id);
  });
  await check('TFTP UI starts nothing until a shared folder is explicitly chosen', transfers, async () => {
    assert.equal((await calls(transfers)).tftpStarts.length, 0); await nativeDialog(transfers, 'tftp-server', 'tftp-dialog'); assert.equal(await transfers.locator('#tftp-bind').inputValue(), '127.0.0.1'); assert.equal(await transfers.locator('#tftp-port').inputValue(), '6969'); assert.equal(await transfers.locator('#tftp-write').isChecked(), false); assert.equal(await transfers.locator('#tftp-root').getAttribute('readonly'), '');
    await transfers.locator('#tftp-start').click(); await transfers.locator('#tftp-error').waitFor(); assert.ok((await transfers.locator('#tftp-error').innerText()).includes('Choose')); assert.equal((await calls(transfers)).tftpStarts.length, 0);
  });
  await check('TFTP validates the chosen client, then locks controls while running', transfers, async () => {
    await transfers.locator('#tftp-browse').click(); await transfers.waitForFunction(() => document.getElementById('tftp-root').value === '/synthetic/tftp-folder'); await transfers.locator('#tftp-client').fill('invalid-client'); await transfers.locator('#tftp-start').click(); await transfers.locator('#tftp-error').waitFor(); assert.equal(await transfers.locator('#tftp-stop').isDisabled(), true);
    await transfers.locator('#tftp-client').fill('192.0.2.10'); await transfers.locator('#tftp-start').click(); await transfers.waitForFunction(() => document.getElementById('tftp-state').textContent.includes('Running on 127.0.0.1:6969')); const request = (await calls(transfers)).tftpStarts.at(-1); assert.deepEqual(request, { rootToken: 'fixture-folder-token', clientAddress: '192.0.2.10', bindAddress: '127.0.0.1', port: 6969, allowWrite: false });
    for (const id of ['browse', 'client', 'bind', 'port', 'write', 'start']) assert.equal(await transfers.locator(`#tftp-${id}`).isDisabled(), true); assert.equal(await transfers.locator('#tftp-stop').isDisabled(), false);
  });
  await check('TFTP filenames/status are plain text and Stop restores editable controls', transfers, async () => {
    await transfers.evaluate(() => { window.__qa.emitTftpTransfer({ id: 'fixture-tftp-transfer', filename: '<img src=x onerror="window.__qaInjected=true">', direction: 'read', bytes: 123, state: 'completed', message: 'Synthetic transfer only' }); window.__qa.emitTftpStatus({ running: true, completedTransfers: 1, activeTransfers: 0 }); }); assert.ok((await transfers.locator('#tftp-transfers').innerText()).includes('<img')); assert.equal(await transfers.locator('#tftp-transfers img').count(), 0); assert.equal(await transfers.evaluate(() => window.__qaInjected === true), false); assert.ok((await transfers.locator('#tftp-state').innerText()).includes('1 completed'));
    await transfers.locator('#tftp-stop').click(); await transfers.waitForFunction(() => document.getElementById('tftp-state').textContent === 'Stopped'); assert.equal((await calls(transfers)).tftpStops.length, 1); assert.equal(await transfers.locator('#tftp-browse').isDisabled(), false); assert.equal(await transfers.locator('#tftp-start').isDisabled(), false); assert.equal(await transfers.locator('#tftp-stop').isDisabled(), true); await closeDialog(transfers, 'tftp-dialog');
  });

  for (const platform of ['win32', 'linux']) {
    const page = await pageFor(platform);
    await check(`${platform} exposes nine working renderer menu groups`, page, async () => {
      assert.equal(await page.locator('#menu-bar').isVisible(), true); assert.equal(await page.locator('.menu-button').count(), 9);
      for (const name of ['file', 'edit', 'view', 'options', 'transfer', 'script', 'tools', 'window', 'help']) { await page.locator(`[data-menu="${name}"]`).click(); await page.locator('#menu-dropdown').waitFor(); assert.ok((await page.locator('#menu-dropdown').innerText()).trim()); await page.keyboard.press('Escape'); }
      assert.equal((await calls(page)).opens.length, 0);
    });
    await check(`${platform} Quick Connect saves a profile only when requested`, page, async () => {
      await nativeDialog(page, 'quick-connect', 'quick-connect-dialog'); await page.locator('#quick-host').fill('quick.example.test'); await page.locator('#quick-save').check(); await page.locator('#quick-name').fill('Saved synthetic quick connection'); await page.locator('#quick-submit').click(); await page.waitForFunction(() => window.__qa.calls.opens.length === 1); assert.ok((await state(page)).sessions.some(profile => profile.name === 'Saved synthetic quick connection')); assert.ok((await calls(page)).opens[0].request.sessionId);
    });
    await check(`${platform} responsive workspace fits the compact viewport`, page, async () => {
      await page.setViewportSize({ width: 850, height: 600 }); await screenshot(page, `${platform}-synthetic-850x600`); const size = await dimensions(page); assert.equal(size.body.width, 850); assert.equal(size.body.height, 600); assert.ok(size.terminal.right <= 850); assert.ok(size.footer.bottom <= 600); return size;
    });
  }
  // Separate, clearly labelled synthetic previews. Test notifications and
  // modified profiles from the preceding checks never appear in these images.
  const preview = await pageFor('darwin', { theme: 'dark', fontSize: 15, keywords: [{ text: 'DEMO SESSION', caseSensitive: false, foreground: '#000000', background: '#70e330' }] });
  const previewRouter = await openProfile(preview);
  await openProfile(preview, 'switch-01');
  await preview.evaluate(id => window.__qa.emitActivated(id), previewRouter.id);
  await preview.evaluate(id => window.__qa.emitData(id, '\x1b[2J\x1b[HDEMO SESSION — Synthetic preview; no actual device connected\r\n\r\nrouter-01# show interfaces status\r\n\r\nPort       Name                  Status       VLAN  Duplex  Speed\r\nGi0/1      Demo workstation       connected    10    full    1G\r\nGi0/2      Demo access point      connected    20    full    1G\r\nGi0/3      Demo lab              notconnect   30    auto    auto\r\nGi0/4      Demo uplink           connected    99    full    1G\r\n\r\nrouter-01# '), previewRouter.id);
  await action(preview, 'show-command-manager');
  await preview.locator('.xterm-decoration').first().waitFor();
  await screenshot(preview, 'macos-main-preview');
  await action(preview, 'session-options');
  await preview.locator('#profile-dialog').waitFor({ state: 'visible' });
  await preview.locator('#profile-dialog .category-item[data-category="keyboard"]').click();
  await screenshot(preview, 'macos-options-preview');
  await check('All tested renderer workflows produced no page or console errors', null, async () => assert.deepEqual(consoleErrors, []));
}

(async () => {
  await fs.mkdir(output, { recursive: true });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try { browser = await chromium.launch({ headless: true }); await run(); }
  catch (error) { checks.push({ name: 'UI runner', passed: false, error: error.stack || error.message }); }
  finally {
    for (const page of pages) await page.close().catch(() => {});
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
    const failed = checks.filter(check => !check.passed);
    const report = { fixture: 'Synthetic UI bridge with production validators; no native desktop or external-device test', passed: checks.length - failed.length, failed: failed.length, checks, consoleErrors };
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    process.stdout.write(`${report.passed}/${checks.length} UI checks passed. Evidence: ${output}\n`);
    if (failed.length) process.exitCode = 1;
  }
})().catch(error => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });
