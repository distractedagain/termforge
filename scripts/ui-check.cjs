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
const { COLOR_SCHEME_IDS } = require('../app/color-schemes.cjs');
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

async function pageFor(platform = 'darwin', settings = {}, sessionProfiles = profiles) {
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
  await page.addInitScript(installFixture, { platform, settings: core.validateSettings({ ...core.DEFAULT_SETTINGS, ...settings }), sessions: sessionProfiles, snippets });
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

async function expectVisibleBounds(page, selectors) {
  const result = await page.evaluate(selectors => ({
    viewport: { width: innerWidth, height: innerHeight },
    body: { width: document.body.scrollWidth, height: document.body.scrollHeight },
    controls: selectors.map(selector => {
      const element = document.querySelector(selector);
      return { selector, box: element?.getBoundingClientRect().toJSON(), hidden: !element || element.hidden || getComputedStyle(element).visibility === 'hidden' };
    }),
  }), selectors);
  assert.deepEqual(result.body, result.viewport, 'The workspace must fit without document scrolling.');
  for (const { selector, box, hidden } of result.controls) {
    assert.ok(!hidden && box?.width > 0 && box?.height > 0, `${selector} must be visible.`);
    assert.ok(box.x >= -1 && box.y >= -1 && box.right <= result.viewport.width + 1 && box.bottom <= result.viewport.height + 1, `${selector} must fit in the viewport: ${JSON.stringify(box)}`);
  }
  return result;
}

async function runModernChecks() {
  const sizes = [{ width: 1280, height: 800 }, { width: 850, height: 600 }];
  const shellControls = ['#main-toolbar', '#session-manager', '#dock-sessions', '#dock-commands', '#dock-active', '#session-search', '#local-ai-toggle', '#settings-button', '.workspace-footer'];
  for (const theme of ['dark', 'light']) {
    const page = await pageFor('darwin', { theme });
    await check(`${theme} welcome, connected tabs, and settings remain usable at desktop and compact sizes`, page, async () => {
      const evidence = [];
      for (const size of sizes) {
        await page.setViewportSize(size);
        evidence.push(await expectVisibleBounds(page, [...shellControls, '#welcome', '#welcome-new', '#welcome-local', '#welcome-import']));
        await screenshot(page, `modern-${theme}-welcome-${size.width}x${size.height}`);
      }
      const before = await calls(page); assert.equal(before.opens.length, 0); assert.equal(before.writes.length, 0); assert.equal(before.aiModels.length, 0);
      await page.setViewportSize(sizes[0]);
      const router = await openProfile(page); await openProfile(page, 'switch-01');
      await page.evaluate(id => window.__qa.emitActivated(id), router.id);
      await writeScreenFixture(page, router.id, '\x1b[2J\x1b[HDEMO SESSION — synthetic preview\r\nNo device is connected.\r\n\r\nrouter-01# show interfaces status\r\nPort    Status       VLAN  Speed\r\nGi0/1   \x1b[32mconnected\x1b[0m    10    1G\r\nGi0/2   \x1b[33mnotconnect\x1b[0m   20    auto\r\n\r\nrouter-01# ', `modern-${theme}-screen`);
      for (const size of sizes) {
        await page.setViewportSize(size);
        evidence.push(await expectVisibleBounds(page, [...shellControls, '#tab-strip', '#terminal-workspace', '.terminal-pane:has(.xterm)']));
        await screenshot(page, `modern-${theme}-connected-${size.width}x${size.height}`);
        await page.locator('#settings-button').click(); await page.locator('#settings-dialog').waitFor({ state: 'visible' });
        await page.locator('#settings-dialog .category-item[data-category="appearance"]').click();
        await page.waitForFunction(() => document.querySelector('#settings-dialog .scheme-ansi-preview .xterm-rows')?.textContent.includes('Connection ready'));
        evidence.push(await expectVisibleBounds(page, ['#settings-dialog', '#settings-dialog .category-tree', '#settings-dialog .modal-footer', '#settings-form [type="submit"]']));
        await screenshot(page, `modern-${theme}-settings-${size.width}x${size.height}`);
        await closeDialog(page, 'settings-dialog');
      }
      if (theme === 'dark') {
        await page.setViewportSize(sizes[0]); await openLocalAi(page);
        const request = await startLocalAi(page, 'Suggest a read-only command to inspect interface state.', 'command');
        await replyLocalAi(page, request, 'SYNTHETIC AI PREVIEW — no model contacted.\n\nReview current interface status before changing configuration.\n\n```sh\nshow interfaces status\n```');
        await page.locator('#local-ai-response').scrollIntoViewIfNeeded();
        await screenshot(page, 'modern-dark-ai-response-1280x800');
      }
      assert.equal((await calls(page)).writes.length, 0, 'Visual previews must never send terminal input.');
      return evidence;
    });
  }
  const keyboard = await pageFor();
  await check('Toolbar and manager controls retain accessible names, keyboard focus, and keyboard actions', keyboard, async () => {
    const named = [['#quick-connect', 'Quick Connect'], ['#local-ai-toggle', 'AI Assistant'], ['#color-schemes-button', 'Color schemes'], ['#settings-button', 'Global options'], ['#dock-sessions', 'Session Manager'], ['#dock-commands', 'Command Manager'], ['#dock-active', 'Active Sessions']];
    for (const [selector, name] of named) {
      const button = keyboard.getByRole('button', { name, exact: true });
      assert.equal(await button.count(), 1, `${selector} must have a unique accessible name.`);
      await button.focus(); assert.equal(await button.evaluate(element => document.activeElement === element), true);
      const focus = await button.evaluate(element => { const style = getComputedStyle(element); return { outline: style.outlineStyle, width: parseFloat(style.outlineWidth), shadow: style.boxShadow }; });
      assert.ok((focus.outline !== 'none' && focus.width > 0) || focus.shadow !== 'none', `${name} must show keyboard focus.`);
    }
    await keyboard.locator('#dock-commands').press('Enter'); await keyboard.locator('#command-filter').waitFor({ state: 'visible' });
    assert.equal(await keyboard.locator('#dock-commands').getAttribute('aria-pressed'), 'true');
    await keyboard.locator('#dock-sessions').press('Enter'); await keyboard.locator('#session-search').waitFor({ state: 'visible' });
    await keyboard.locator('#settings-button').press('Enter'); await keyboard.locator('#settings-dialog').waitFor({ state: 'visible' });
    await keyboard.keyboard.press('Escape'); await keyboard.locator('#settings-dialog').waitFor({ state: 'hidden' });
    const after = await calls(keyboard); assert.equal(after.opens.length, 0); assert.equal(after.writes.length, 0); assert.equal(after.aiModels.length, 0);
  });
  const layout = await pageFor();
  await check('Pane toggles and restart preserve untouched sizes and the command splitter minimum', layout, async () => {
    const measure = () => layout.evaluate(() => ({ sidebarWidth: document.getElementById('session-manager').getBoundingClientRect().width, commandHeight: document.getElementById('command-bar').getBoundingClientRect().height }));
    const reload = async () => {
      await layout.reload(); await layout.locator('#session-search').waitFor({ state: 'visible' });
      await layout.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
    };
    await action(layout, 'show-command-window'); await layout.locator('#command-bar').waitFor({ state: 'visible' });
    const original = await measure(); assert.ok(original.sidebarWidth > 0 && original.commandHeight > 0);
    await action(layout, 'show-button-bar'); await layout.locator('#button-bar').waitFor({ state: 'hidden' });
    await reload(); assert.deepEqual(await measure(), original); assert.equal(await layout.locator('#button-bar').isVisible(), false);
    await layout.locator('#command-resizer').focus();
    for (let count = 0; count < 20; count += 1) await layout.locator('#command-resizer').press('ArrowDown');
    const minimum = await layout.locator('#command-bar').evaluate(element => parseFloat(getComputedStyle(element).minHeight));
    const smallest = await measure(); assert.equal(smallest.commandHeight, minimum); assert.equal(smallest.sidebarWidth, original.sidebarWidth);
    const savedHeight = await layout.evaluate(() => JSON.parse(localStorage.getItem('termforge-classic-layout')).commandHeight);
    assert.equal(savedHeight, smallest.commandHeight, 'The saved command size must match its visible minimum.');
    await reload(); assert.deepEqual(await measure(), smallest); assert.equal(await layout.locator('#button-bar').isVisible(), false);
    await expectVisibleBounds(layout, ['#session-manager', '#command-bar', '#command-input', '#send-command']);
    assert.equal((await calls(layout)).opens.length, 0); assert.equal((await calls(layout)).writes.length, 0);
    return { original, smallest };
  });
  const matched = await pageFor('darwin', { theme: 'dark' });
  await check('Solarized dark and light keep compact navigation and welcome actions in view', matched, async () => {
    await matched.setViewportSize(sizes[1]); const evidence = [];
    for (const scheme of ['solarized-dark', 'solarized-light']) {
      await applyPalette(matched, scheme, true);
      evidence.push({ scheme, bounds: await expectVisibleBounds(matched, [...shellControls, '#welcome-new', '#welcome-local', '#welcome-import']) });
      await screenshot(matched, `modern-${scheme}-welcome-850x600`);
    }
    assert.equal((await calls(matched)).opens.length, 0); assert.equal((await calls(matched)).writes.length, 0);
    return evidence;
  });
  const reduced = await pageFor('darwin', { theme: 'dark' });
  await check('Reduced-motion preference suppresses interface motion without disabling keyboard navigation', reduced, async () => {
    await reduced.emulateMedia({ reducedMotion: 'reduce' });
    await reduced.locator('#settings-button').press('Enter'); await reduced.locator('#settings-dialog').waitFor({ state: 'visible' });
    const motion = await reduced.evaluate(() => ({
      reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
      moving: [...document.querySelectorAll('#main-toolbar, #main-toolbar *, #session-manager, #session-manager *, #welcome, #welcome *, #settings-dialog, #settings-dialog *')].filter(element => element.getBoundingClientRect().width > 0).flatMap(element => {
        const style = getComputedStyle(element);
        const seconds = value => value.split(',').map(part => parseFloat(part) * (part.trim().endsWith('ms') ? 0.001 : 1));
        return Math.max(...seconds(style.transitionDuration), ...seconds(style.animationDuration)) > 0.01 ? [{ element: element.id || element.className, transition: style.transitionDuration, animation: style.animationDuration }] : [];
      }),
    }));
    assert.equal(motion.reduced, true); assert.deepEqual(motion.moving, []);
    await reduced.keyboard.press('Escape'); await reduced.locator('#settings-dialog').waitFor({ state: 'hidden' });
    assert.equal((await calls(reduced)).opens.length, 0); assert.equal((await calls(reduced)).writes.length, 0);
    return motion;
  });
}

// These checks observe rendered elements and the existing in-memory bridge. No
// terminal internals or production-only debug API are exposed to the test page.
async function trackColorSaves(page) {
  await page.evaluate(() => {
    const save = window.termforge.saveSettings;
    window.__qa.colorSaves = [];
    window.__qa.failColorSave = false;
    window.termforge.saveSettings = async settings => {
      window.__qa.colorSaves.push(JSON.parse(JSON.stringify(settings)));
      if (window.__qa.holdColorSave) await new Promise(resolve => { window.__qa.releaseColorSave = resolve; });
      if (window.__qa.failColorSave) throw new Error('Synthetic color settings write failed.');
      return save(settings);
    };
  });
}
async function colorState(page) {
  return page.evaluate(() => ({
    settings: window.__qa.getState().settings,
    saves: JSON.parse(JSON.stringify(window.__qa.colorSaves)),
    opens: window.__qa.calls.opens.length, writes: window.__qa.calls.writes.length,
    closes: window.__qa.calls.closes.length,
    theme: document.documentElement.dataset.theme,
    body: getComputedStyle(document.body).backgroundColor,
    chrome: getComputedStyle(document.documentElement).getPropertyValue('--chrome').trim(),
  }));
}
async function selectPalette(page, id, matching) {
  await page.locator(`#color-scheme-grid input[type="radio"][value="${id}"]`).check();
  if (matching !== undefined) await page.locator('#color-scheme-match-interface').setChecked(matching);
}
async function applyPalette(page, id, matching) {
  await nativeDialog(page, 'color-schemes', 'color-scheme-dialog');
  await selectPalette(page, id, matching);
  await page.locator('#color-scheme-apply').click();
  await page.locator('#color-scheme-dialog').waitFor({ state: 'hidden' });
}
async function terminalColors(page, id) {
  return page.locator(`.terminal-pane[data-connection-id="${id}"]`).evaluate(pane => ({
    scheme: pane.dataset.colorScheme,
    variable: getComputedStyle(pane).getPropertyValue('--terminal-background').trim(),
    pane: getComputedStyle(pane).backgroundColor,
    mount: getComputedStyle(pane.querySelector('.terminal-mount')).backgroundColor,
    viewport: getComputedStyle(pane.querySelector('.xterm-viewport')).backgroundColor,
  }));
}
async function expectTerminalColor(page, id, scheme, color, rgb) {
  await page.waitForFunction(({ id, scheme, rgb }) => {
    const pane = document.querySelector(`.terminal-pane[data-connection-id="${id}"]`);
    return pane?.dataset.colorScheme === scheme && getComputedStyle(pane.querySelector('.xterm-viewport')).backgroundColor === rgb;
  }, { id, scheme, rgb });
  const actual = await terminalColors(page, id);
  assert.deepEqual(actual, { scheme, variable: color, pane: rgb, mount: rgb, viewport: rgb });
  return actual;
}
async function expectSolarizedAnsi(page, id) {
  const actual = await page.locator(`.terminal-pane[data-connection-id="${id}"]`).evaluate(pane => Object.fromEntries([['red', 1], ['green', 2], ['brightBlack', 8]].map(([name, index]) => [name, getComputedStyle(pane.querySelector(`.xterm-fg-${index}`)).color])));
  assert.deepEqual(actual, { red: 'rgb(220, 50, 47)', green: 'rgb(133, 153, 0)', brightBlack: 'rgb(0, 43, 54)' });
  return actual;
}
async function runColorChecks() {
  const colors = await pageFor('darwin', { theme: 'light' });
  await trackColorSaves(colors);
  await check('Color Schemes opens from the toolbar without an active connection and lists every preset', colors, async () => {
    await colors.locator('#color-schemes-button').click();
    await colors.locator('#color-scheme-dialog').waitFor({ state: 'visible' });
    assert.deepEqual(await colors.locator('#color-scheme-grid input[type="radio"]').evaluateAll(inputs => inputs.map(input => input.value)), COLOR_SCHEME_IDS);
    assert.equal(await colors.locator('#color-scheme-grid input:checked').inputValue(), 'traditional');
    assert.equal(await colors.locator('#color-scheme-match-interface').isChecked(), false);
    assert.equal((await calls(colors)).opens.length, 0);
    await colors.locator('#color-scheme-cancel').click();
  });
  await check('Palette preview and Cancel leave saved colors, interface, and connection activity unchanged', colors, async () => {
    const before = await colorState(colors);
    await nativeDialog(colors, 'color-schemes', 'color-scheme-dialog');
    await selectPalette(colors, 'solarized-dark', true);
    await colors.waitForFunction(() => getComputedStyle(document.getElementById('color-scheme-preview')).backgroundColor === 'rgb(0, 43, 54)');
    assert.equal(await colors.locator('#color-scheme-preview .xterm-viewport').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(0, 43, 54)');
    assert.deepEqual(await colorState(colors), before);
    await colors.locator('#color-scheme-cancel').click();
    assert.deepEqual(await colorState(colors), before);
  });
  await check('Keyboard radio selection previews a palette and Escape discards it', colors, async () => {
    const before = await colorState(colors);
    await nativeDialog(colors, 'color-schemes', 'color-scheme-dialog');
    const first = colors.locator('#color-scheme-grid input[type="radio"]').first();
    await first.focus(); await colors.keyboard.press('ArrowRight');
    assert.equal(await colors.locator('#color-scheme-grid input:checked').inputValue(), COLOR_SCHEME_IDS[1]);
    await colors.keyboard.press('Escape');
    await colors.locator('#color-scheme-dialog').waitFor({ state: 'hidden' });
    assert.deepEqual(await colorState(colors), before);
  });
  await check('Solarized can be saved without a connection and restores its preferences when reopened', colors, async () => {
    await applyPalette(colors, 'solarized-dark', true);
    const actual = await colorState(colors);
    assert.equal(actual.settings.colorScheme, 'solarized-dark'); assert.equal(actual.settings.matchColorScheme, true);
    assert.equal(actual.settings.theme, 'light'); assert.equal(actual.saves.length, 1);
    assert.equal(actual.body, 'rgb(7, 54, 66)'); assert.equal(actual.chrome, '#073642');
    assert.equal(actual.opens, 0); assert.equal(actual.writes, 0); assert.equal(actual.closes, 0);
    await nativeDialog(colors, 'color-schemes', 'color-scheme-dialog');
    assert.equal(await colors.locator('#color-scheme-grid input:checked').inputValue(), 'solarized-dark');
    assert.equal(await colors.locator('#color-scheme-match-interface').isChecked(), true);
    await colors.locator('#color-scheme-cancel').click();
    const reopened = await pageFor('darwin', actual.settings);
    await trackColorSaves(reopened);
    const restored = await colorState(reopened);
    assert.equal(restored.body, actual.body); assert.equal(restored.chrome, actual.chrome); assert.deepEqual(restored.settings, actual.settings);
    const terminal = await openProfile(reopened);
    return expectTerminalColor(reopened, terminal.id, 'solarized-dark', '#002b36', 'rgb(0, 43, 54)');
  });
  const explicitProfiles = profiles.map(profile => profile.id === 'fixture-switch' ? core.validateSession({ ...profile, terminal: { ...profile.terminal, colorScheme: 'monochrome' } }) : profile);
  const active = await pageFor('darwin', { theme: 'dark' }, explicitProfiles);
  await trackColorSaves(active);
  const originalChrome = (await colorState(active)).body;
  const inherited = await openProfile(active);
  const explicit = await openProfile(active, 'switch-01');
  await action(active, 'tile-vertical');
  await check('Applying Solarized Dark recolors existing terminals and padding while preserving explicit session colors', active, async () => {
    const before = await colorState(active);
    await applyPalette(active, 'solarized-dark', false);
    const inheritedColor = await expectTerminalColor(active, inherited.id, 'solarized-dark', '#002b36', 'rgb(0, 43, 54)');
    const explicitColor = await expectTerminalColor(active, explicit.id, 'monochrome', '#000000', 'rgb(0, 0, 0)');
    const after = await colorState(active);
    assert.equal(after.opens, before.opens); assert.equal(after.writes, before.writes); assert.equal(after.closes, before.closes); assert.equal(after.body, originalChrome);
    assert.equal(after.saves.length, before.saves.length + 1);
    return { inherited: inheritedColor, explicit: explicitColor };
  });
  await check('Solarized Dark ANSI cells render the canonical red, green, and bright-black palette', active, async () => {
    await active.evaluate(id => window.__qa.emitData(id, '\x1b[2J\x1b[H\x1b[0;31mR\x1b[32mG\x1b[90mK\x1b[0m'), inherited.id);
    await active.locator(`.terminal-pane[data-connection-id="${inherited.id}"] .xterm-fg-8`).waitFor({ state: 'attached' });
    return expectSolarizedAnsi(active, inherited.id);
  });
  await check('Applying Solarized Light switches live xterm backgrounds without reconnecting', active, async () => {
    const before = await colorState(active);
    await applyPalette(active, 'solarized-light', true);
    const inheritedColor = await expectTerminalColor(active, inherited.id, 'solarized-light', '#fdf6e3', 'rgb(253, 246, 227)');
    await expectTerminalColor(active, explicit.id, 'monochrome', '#000000', 'rgb(0, 0, 0)');
    const after = await colorState(active);
    assert.equal(after.settings.theme, 'dark'); assert.equal(after.body, 'rgb(238, 232, 213)'); assert.equal(after.chrome, '#eee8d5');
    assert.equal(after.opens, before.opens); assert.equal(after.writes, before.writes); assert.equal(after.closes, before.closes);
    return { ...inheritedColor, ansi: await expectSolarizedAnsi(active, inherited.id) };
  });
  await check('Turning interface matching off restores the original desktop theme and retains terminal colors', active, async () => {
    await applyPalette(active, 'solarized-light', false);
    const after = await colorState(active);
    assert.equal(after.settings.theme, 'dark'); assert.equal(after.theme, 'dark'); assert.equal(after.settings.matchColorScheme, false); assert.equal(after.body, originalChrome);
    await expectTerminalColor(active, inherited.id, 'solarized-light', '#fdf6e3', 'rgb(253, 246, 227)');
  });
  await check('A pending color save prevents duplicate apply or dismissal and commits only after success', active, async () => {
    const before = await colorState(active); const beforeTerminal = await terminalColors(active, inherited.id);
    await active.evaluate(() => { window.__qa.holdColorSave = true; });
    await nativeDialog(active, 'color-schemes', 'color-scheme-dialog'); await selectPalette(active, 'solarized-light', true);
    await active.locator('#color-scheme-apply').click();
    await active.waitForFunction(() => typeof window.__qa.releaseColorSave === 'function');
    for (const id of ['color-scheme-apply', 'color-scheme-cancel', 'color-scheme-match-interface']) assert.equal(await active.locator(`#${id}`).isDisabled(), true);
    assert.equal(await active.locator('#color-scheme-grid input[type="radio"]').first().isDisabled(), true);
    await active.keyboard.press('Escape'); assert.equal(await active.locator('#color-scheme-dialog').isVisible(), true);
    const pending = await colorState(active); assert.deepEqual({ ...pending, saves: before.saves }, before);
    assert.equal(pending.saves.length, before.saves.length + 1); assert.deepEqual(await terminalColors(active, inherited.id), beforeTerminal);
    await active.evaluate(() => { window.__qa.holdColorSave = false; window.__qa.releaseColorSave(); delete window.__qa.releaseColorSave; });
    await active.locator('#color-scheme-dialog').waitFor({ state: 'hidden' });
    assert.equal((await colorState(active)).settings.matchColorScheme, true);
  });
  await check('Color settings failures retain existing application and terminal colors until a successful retry', active, async () => {
    const before = await colorState(active); const beforeTerminal = await terminalColors(active, inherited.id);
    await active.evaluate(() => { window.__qa.failColorSave = true; });
    await nativeDialog(active, 'color-schemes', 'color-scheme-dialog'); await selectPalette(active, 'solarized-dark', true);
    await active.locator('#color-scheme-apply').click(); await active.locator('#color-scheme-error').waitFor({ state: 'visible' });
    assert.ok((await active.locator('#color-scheme-error').innerText()).includes('Synthetic color settings write failed'));
    const after = await colorState(active);
    assert.deepEqual({ ...after, saves: before.saves }, before); assert.equal(after.saves.length, before.saves.length + 1);
    assert.deepEqual(await terminalColors(active, inherited.id), beforeTerminal); assert.equal(await active.locator('#color-scheme-dialog').isVisible(), true);
    assert.equal(await active.locator('#color-scheme-apply').isDisabled(), false);
    await active.evaluate(() => { window.__qa.failColorSave = false; });
    await active.locator('#color-scheme-apply').click(); await active.locator('#color-scheme-dialog').waitFor({ state: 'hidden' });
    await expectTerminalColor(active, inherited.id, 'solarized-dark', '#002b36', 'rgb(0, 43, 54)');
  });
  await check('Global and per-session appearance controls expose all schemes and persist interface matching', active, async () => {
    await nativeDialog(active, 'settings', 'settings-dialog'); await active.locator('#settings-dialog .category-item[data-category="appearance"]').click();
    assert.deepEqual(await active.locator('#settings-color-scheme option').evaluateAll(options => options.map(option => option.value)), COLOR_SCHEME_IDS);
    assert.equal(await active.locator('#settings-match-colors').isChecked(), true);
    await active.locator('#settings-color-scheme').selectOption('forge-light');
    await active.waitForFunction(() => document.querySelector('#settings-dialog .scheme-ansi-preview')?.dataset.scheme === 'forge-light');
    await active.locator('#settings-match-colors').uncheck(); await active.locator('#settings-form [type="submit"]').click(); await active.locator('#settings-dialog').waitFor({ state: 'hidden' });
    const saved = (await state(active)).settings; assert.equal(saved.colorScheme, 'forge-light'); assert.equal(saved.matchColorScheme, false);
    await active.locator('#dock-sessions').click(); await active.locator('.session-main').filter({ hasText: 'switch-01' }).click();
    await nativeDialog(active, 'session-options', 'profile-dialog'); await active.locator('#profile-dialog .category-item[data-category="appearance"]').click();
    assert.deepEqual(await active.locator('#profile-color-scheme option').evaluateAll(options => options.map(option => option.value)), ['', ...COLOR_SCHEME_IDS]);
    assert.equal(await active.locator('#profile-color-scheme').inputValue(), 'monochrome');
    await active.locator('#profile-color-scheme').selectOption('solarized-dark');
    await active.waitForFunction(() => document.querySelector('#profile-dialog .scheme-ansi-preview')?.dataset.scheme === 'solarized-dark');
    await active.locator('#profile-color-scheme').selectOption('');
    await active.waitForFunction(() => document.querySelector('#profile-dialog .scheme-ansi-preview')?.dataset.scheme === 'forge-light');
    await closeDialog(active, 'profile-dialog');
    assert.equal((await state(active)).sessions.find(profile => profile.id === 'fixture-switch').terminal.colorScheme, 'monochrome');
  });
  await check('Saving a per-session scheme immediately recolors every open copy of only that profile', active, async () => {
    const anotherExplicit = await openProfile(active, 'switch-01');
    const before = await colorState(active); const beforeInherited = await terminalColors(active, inherited.id);
    await nativeDialog(active, 'session-options', 'profile-dialog'); await active.locator('#profile-dialog .category-item[data-category="appearance"]').click();
    await active.locator('#profile-color-scheme').selectOption('solarized-light'); await active.locator('#save-profile').click();
    await active.locator('#profile-dialog').waitFor({ state: 'hidden' });
    for (const connection of [explicit, anotherExplicit]) await expectTerminalColor(active, connection.id, 'solarized-light', '#fdf6e3', 'rgb(253, 246, 227)');
    assert.deepEqual(await terminalColors(active, inherited.id), beforeInherited);
    assert.deepEqual(await colorState(active), before);
    assert.equal((await state(active)).sessions.find(profile => profile.id === 'fixture-switch').terminal.colorScheme, 'solarized-light');
  });
  const unsaved = await pageFor('darwin', {}, []);
  await trackColorSaves(unsaved);
  await check('Session colors target the originating unsaved local tab without changing another unsaved tab', unsaved, async () => {
    await action(unsaved, 'local-shell'); await unsaved.waitForFunction(() => window.__qa.calls.opens.length === 1);
    const first = (await calls(unsaved)).opens[0];
    await action(unsaved, 'local-shell'); await unsaved.waitForFunction(() => window.__qa.calls.opens.length === 2);
    const second = (await calls(unsaved)).opens[1];
    const before = await colorState(unsaved); const firstColors = await terminalColors(unsaved, first.id);
    assert.equal((await state(unsaved)).sessions.length, 0);
    await nativeDialog(unsaved, 'session-options', 'profile-dialog'); await unsaved.locator('#profile-name').fill('Saved color demo shell');
    await unsaved.locator('#profile-dialog .category-item[data-category="appearance"]').click(); await unsaved.locator('#profile-color-scheme').selectOption('solarized-dark');
    await unsaved.locator('#save-profile').click(); await unsaved.locator('#profile-dialog').waitFor({ state: 'hidden' });
    await expectTerminalColor(unsaved, second.id, 'solarized-dark', '#002b36', 'rgb(0, 43, 54)');
    assert.deepEqual(await terminalColors(unsaved, first.id), firstColors); assert.deepEqual(await colorState(unsaved), before);
    const saved = (await state(unsaved)).sessions; assert.equal(saved.length, 1); assert.equal(saved[0].terminal.colorScheme, 'solarized-dark');
  });
  await check('Multiple Session Options exposes every palette and persists the chosen color only for selected profiles', active, async () => {
    const before = await state(active);
    await active.locator('#dock-sessions').click(); await active.locator('.session-main').filter({ hasText: 'router-01' }).click();
    await active.locator('.session-main').filter({ hasText: 'switch-01' }).click({ modifiers: ['Meta'] });
    await nativeDialog(active, 'session-options', 'bulk-dialog');
    assert.deepEqual(await active.locator('#bulk-color option').evaluateAll(options => options.map(option => option.value)), ['', ...COLOR_SCHEME_IDS]);
    await active.locator('#bulk-color-enable').check(); await active.locator('#bulk-color').selectOption('high-contrast'); await active.locator('#bulk-save').click();
    await active.locator('#bulk-dialog').waitFor({ state: 'hidden' });
    const after = await state(active);
    for (const id of ['fixture-router', 'fixture-switch']) assert.equal(after.sessions.find(profile => profile.id === id).terminal.colorScheme, 'high-contrast');
    assert.deepEqual(after.sessions.find(profile => profile.id === 'fixture-local'), before.sessions.find(profile => profile.id === 'fixture-local'));
  });
  await check('Color scheme picker and its Apply button fit an 850 by 600 viewport', colors, async () => {
    await colors.setViewportSize({ width: 850, height: 600 });
    await nativeDialog(colors, 'color-schemes', 'color-scheme-dialog');
    const boxes = await colors.evaluate(() => Object.fromEntries(['color-scheme-dialog', 'color-scheme-apply', 'color-scheme-cancel'].map(id => [id, document.getElementById(id).getBoundingClientRect().toJSON()])));
    assert.ok(boxes['color-scheme-dialog'].width > 0, 'The color picker must remain visible.');
    for (const box of Object.values(boxes)) { assert.ok(box.x >= 0 && box.y >= 0); assert.ok(box.right <= 850 && box.bottom <= 600); }
    assert.equal(await colors.locator('#color-scheme-apply').isVisible(), true);
    await screenshot(colors, 'macos-color-picker-850x600'); await colors.locator('#color-scheme-cancel').click();
    await colors.setViewportSize({ width: 1280, height: 800 }); return boxes;
  });
  for (const platform of ['win32', 'linux']) {
    const desktop = await pageFor(platform);
    await check(`${platform} Options menu opens color schemes without a session`, desktop, async () => {
      await desktop.locator('[data-menu="options"]').click();
      await desktop.locator('#menu-dropdown .menu-item').filter({ hasText: 'Color Schemes' }).click();
      await desktop.locator('#color-scheme-dialog').waitFor({ state: 'visible' });
      assert.equal(await desktop.locator('#color-scheme-grid input[type="radio"]').count(), COLOR_SCHEME_IDS.length);
      assert.equal((await calls(desktop)).opens.length, 0); await desktop.locator('#color-scheme-cancel').click();
    });
  }
  // Clean ANSI samples identify the scene as synthetic and make both light and
  // dark palette output visible without device data or test notifications.
  const preview = await pageFor('darwin', { theme: 'dark', fontSize: 15 });
  const terminal = await openProfile(preview);
  await preview.evaluate(id => window.__qa.emitData(id, '\x1b[2J\x1b[HDEMO SESSION — Synthetic preview; no actual device connected\r\n\r\n\x1b[1mTermForge color schemes\x1b[0m\r\n\r\nrouter-01# show interfaces status\r\n\r\nPort       Name                  Status       VLAN  Speed\r\nGi0/1      Demo workstation      \x1b[32mconnected\x1b[0m    10    1G\r\nGi0/2      Demo access point     \x1b[32mconnected\x1b[0m    20    1G\r\nGi0/3      Demo lab              \x1b[33mnotconnect\x1b[0m   30    auto\r\nGi0/4      Demo uplink           \x1b[36mconnected\x1b[0m    99    1G\r\n\r\nANSI: \x1b[31mred\x1b[0m  \x1b[32mgreen\x1b[0m  \x1b[33myellow\x1b[0m  \x1b[34mblue\x1b[0m  \x1b[35mmagenta\x1b[0m  \x1b[36mcyan\x1b[0m\r\n\r\nrouter-01# '), terminal.id);
  for (const id of ['solarized-dark', 'solarized-light']) {
    await applyPalette(preview, id, true);
    await screenshot(preview, `macos-${id}-matching-preview`);
  }
}

const terminalTab = (page, id) => page.locator(`.terminal-tab[data-connection-id="${id}"]:visible`);
async function visibleTerminalIds(page) {
  return page.locator('.terminal-pane:visible').evaluateAll(panes => panes.map(pane => pane.dataset.connectionId).sort());
}
async function groupFor(page, id) {
  return page.locator(`.terminal-pane[data-connection-id="${id}"]`).evaluate(pane => pane.closest('.tab-group')?.dataset.groupId);
}
async function workspaceView(page) {
  return page.evaluate(() => {
    const groups = [...document.querySelectorAll('.tab-group')];
    const read = element => {
      if (element.classList.contains('tab-group')) {
        const strip = groups.length === 1 ? document.getElementById('tab-strip') : element.querySelector('.tab-group-strip');
        return { groupId: element.dataset.groupId, tabs: [...strip.querySelectorAll('.terminal-tab')].map(tab => tab.dataset.connectionId), activeId: strip.querySelector('.tab-label[aria-selected="true"]')?.closest('.terminal-tab')?.dataset.connectionId };
      }
      const children = [...element.children].filter(child => child.matches('.tab-group, .tab-group-split'));
      if (children.length !== 2) throw new Error('A workspace split must have two group branches.');
      const divider = [...element.children].find(child => child.classList.contains('group-divider'));
      return { direction: element.dataset.direction, ratio: Number(divider.getAttribute('aria-valuenow')) / 100, first: read(children[0]), second: read(children[1]) };
    };
    const root = document.querySelector('#terminal-workspace > .tab-group, #terminal-workspace > .tab-group-split');
    return { groups: groups.map(read), tree: root ? read(root) : null, activeGroupId: document.querySelector('.tab-group.active-group')?.dataset.groupId };
  });
}
function filteredWorkspaceTree(tree, ids) {
  if (!tree) return null;
  if (tree.tabs) {
    const tabs = tree.tabs.filter(id => ids.has(id));
    return tabs.length ? { tabs, activeId: tabs.includes(tree.activeId) ? tree.activeId : null } : null;
  }
  const first = filteredWorkspaceTree(tree.first, ids); const second = filteredWorkspaceTree(tree.second, ids);
  return first && second ? { direction: tree.direction, ratio: tree.ratio, first, second } : first || second;
}
function expectedSnapshotTree(snapshot, opened) {
  const mapping = new Map(snapshot.instances.map((instance, index) => [instance.id, opened[index]?.id]));
  const read = node => {
    if (node.groupId) {
      const group = snapshot.layout.groups.find(group => group.id === node.groupId);
      return { tabs: group.tabs.map(id => mapping.get(id)), activeId: mapping.get(group.activeId) };
    }
    return { direction: node.direction, ratio: Math.round(node.ratio * 100) / 100, first: read(node.first), second: read(node.second) };
  };
  return read(snapshot.layout.tree);
}
async function saveWorkspaceSnapshot(page, name) {
  await nativeDialog(page, 'snapshots', 'snapshots-dialog');
  await page.locator('#snapshot-name').fill(name); await page.locator('#snapshot-save').click();
  await page.waitForFunction(name => window.__qa.getState().snapshots.some(snapshot => snapshot.name === name), name);
  return (await state(page)).snapshots.find(snapshot => snapshot.name === name);
}
async function runWorkspaceChecks() {
  const grouped = await pageFor();
  const first = await openProfile(grouped); const second = await openProfile(grouped, 'switch-01');
  let repeated;
  await check('Independent tab groups retain their own active tabs and command focus', grouped, async () => {
    await action(grouped, 'group-vertical'); await grouped.waitForFunction(() => document.querySelectorAll('.tab-group').length === 2);
    repeated = await openProfile(grouped);
    await terminalTab(grouped, second.id).locator('.tab-label').click(); await terminalTab(grouped, first.id).locator('.tab-label').click();
    assert.deepEqual(await visibleTerminalIds(grouped), [first.id, second.id].sort());
    assert.equal(await grouped.locator('.tab-group-strip .tab-label[aria-selected="true"]').count(), 2);
    assert.equal((await workspaceView(grouped)).activeGroupId, await groupFor(grouped, first.id));
    const before = (await calls(grouped)).writes.length;
    await action(grouped, 'show-command-window'); await grouped.locator('#command-input').fill('show version'); await grouped.locator('#send-command').click();
    await grouped.waitForFunction(before => window.__qa.calls.writes.length === before + 1, before);
    assert.deepEqual((await calls(grouped)).writes.at(-1), { id: first.id, data: 'show version\r' });
  });
  await check('Dragging tabs between groups and moving to the next group retain the live terminal', grouped, async () => {
    assert.ok(repeated); const before = await calls(grouped); const source = await groupFor(grouped, repeated.id); const destination = await groupFor(grouped, first.id);
    await grouped.evaluate(id => window.__qa.emitData(id, '\x1b[2J\x1b[HRETAINED GROUP OUTPUT'), repeated.id);
    await terminalTab(grouped, repeated.id).dragTo(terminalTab(grouped, first.id));
    await grouped.waitForFunction(({ id, destination }) => document.querySelector(`.terminal-pane[data-connection-id="${id}"]`)?.closest('.tab-group')?.dataset.groupId === destination, { id: repeated.id, destination });
    await terminalTab(grouped, repeated.id).locator('.tab-label').click(); await action(grouped, 'group-move-next');
    await grouped.waitForFunction(({ id, source }) => document.querySelector(`.terminal-pane[data-connection-id="${id}"]`)?.closest('.tab-group')?.dataset.groupId === source, { id: repeated.id, source });
    await grouped.evaluate(id => window.__qa.emitScreen({ requestId: 'group-retained-screen', id, startRow: 1, endRow: 1, startColumn: 1, endColumn: 30 }), repeated.id);
    await grouped.waitForFunction(() => window.__qa.calls.screens.some(screen => screen.requestId === 'group-retained-screen'));
    const after = await calls(grouped);
    assert.ok(after.screens.find(screen => screen.requestId === 'group-retained-screen').text.startsWith('RETAINED GROUP OUTPUT'));
    assert.equal(after.opens.length, before.opens.length); assert.equal(after.closes.length, before.closes.length);
    assert.equal(await grouped.locator('.terminal-pane .xterm').count(), before.opens.length);
  });
  await check('Group dividers resize with the pointer and expose keyboard range controls', grouped, async () => {
    const divider = grouped.locator('.group-divider[aria-orientation="vertical"]').first();
    const firstGroup = grouped.locator('.tab-group').first(); const original = await firstGroup.boundingBox(); const box = await divider.boundingBox();
    await grouped.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await grouped.mouse.down(); await grouped.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2, { steps: 8 }); await grouped.mouse.up();
    await grouped.waitForFunction(width => document.querySelector('.tab-group').getBoundingClientRect().width > width + 40, original.width);
    assert.equal(await divider.getAttribute('role'), 'separator'); assert.equal(await divider.getAttribute('aria-valuemin'), '10'); assert.equal(await divider.getAttribute('aria-valuemax'), '90');
    await divider.focus(); await divider.press('Home'); assert.equal(await divider.getAttribute('aria-valuenow'), '10');
    await divider.press('End'); assert.equal(await divider.getAttribute('aria-valuenow'), '90');
    await divider.press('ArrowLeft'); assert.equal(await divider.getAttribute('aria-valuenow'), '85');
    await action(grouped, 'group-move-next');
    const moved = await firstGroup.boundingBox(); const movedDivider = await divider.boundingBox();
    await grouped.mouse.move(movedDivider.x + movedDivider.width / 2, movedDivider.y + movedDivider.height / 2); await grouped.mouse.down(); await grouped.mouse.move(movedDivider.x + movedDivider.width / 2 - 80, movedDivider.y + movedDivider.height / 2, { steps: 8 }); await grouped.mouse.up();
    await grouped.waitForFunction(width => document.querySelector('.tab-group').getBoundingClientRect().width < width - 40, moved.width);
    const actualRatio = Number(await grouped.locator('.tab-group-split').first().getAttribute('data-ratio'));
    const saved = await saveWorkspaceSnapshot(grouped, 'Resized after tab movement');
    assert.ok(Math.abs(saved.layout.tree.ratio - actualRatio) < 0.000001);
    await closeDialog(grouped, 'snapshots-dialog');
    return { before: original.width, savedRatioAfterMovement: saved.layout.tree.ratio, actualRatio };
  });
  await check('Collapsing groups preserves every tab and focuses the current terminal without reopening', grouped, async () => {
    await terminalTab(grouped, repeated.id).locator('.tab-label').click();
    const order = await grouped.locator('.terminal-tab').evaluateAll(tabs => tabs.filter(tab => !tab.closest('[hidden]')).map(tab => tab.dataset.connectionId)); const before = await calls(grouped);
    await action(grouped, 'group-collapse'); await grouped.waitForFunction(() => document.querySelectorAll('.tab-group').length === 1);
    assert.deepEqual(await grouped.locator('#tab-strip .terminal-tab').evaluateAll(tabs => tabs.map(tab => tab.dataset.connectionId)), order);
    assert.deepEqual(await visibleTerminalIds(grouped), [repeated.id]); assert.equal(await grouped.locator('.group-divider').count(), 0);
    const after = await calls(grouped); assert.equal(after.opens.length, before.opens.length); assert.equal(after.closes.length, before.closes.length);
  });

  const reconnecting = await pageFor('darwin', { closeOnExit: true });
  await openProfile(reconnecting); const reconnectTarget = await openProfile(reconnecting, 'switch-01'); await action(reconnecting, 'group-vertical'); await openProfile(reconnecting, 'local-shell');
  await check('Reconnect with close-on-exit enabled replaces the original group slot after a delayed open', reconnecting, async () => {
    await terminalTab(reconnecting, reconnectTarget.id).locator('.tab-label').click();
    const before = await workspaceView(reconnecting); const callsBefore = await calls(reconnecting);
    await reconnecting.evaluate(() => {
      const open = window.termforge.terminalOpen;
      window.termforge.terminalOpen = async request => {
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return open(request);
      };
    });
    await nativeDialog(reconnecting, 'reconnect', 'confirm-dialog'); await reconnecting.locator('#confirm-accept').click();
    await reconnecting.waitForFunction(count => window.__qa.calls.opens.length === count, callsBefore.opens.length + 1);
    const callsAfter = await calls(reconnecting); const replacement = callsAfter.opens.at(-1);
    await reconnecting.locator(`.terminal-pane[data-connection-id="${replacement.id}"]`).waitFor({ state: 'visible' });
    await reconnecting.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const expected = JSON.parse(JSON.stringify(before));
    const update = node => {
      if (node.tabs) { node.tabs = node.tabs.map(id => id === reconnectTarget.id ? replacement.id : id); if (node.activeId === reconnectTarget.id) node.activeId = replacement.id; }
      else { update(node.first); update(node.second); }
    };
    expected.groups.forEach(update); update(expected.tree);
    assert.deepEqual(await workspaceView(reconnecting), expected); assert.equal(await reconnecting.locator(`.terminal-pane[data-connection-id="${reconnectTarget.id}"]`).count(), 0);
    assert.deepEqual(callsAfter.closes.slice(callsBefore.closes.length), [reconnectTarget.id]); assert.equal(callsAfter.opens.length, callsBefore.opens.length + 1);
  });

  const snapshots = await pageFor('darwin', { theme: 'dark', colorScheme: 'solarized-dark', matchColorScheme: true });
  const router = await openProfile(snapshots); const selectedSwitch = await openProfile(snapshots, 'switch-01');
  await action(snapshots, 'group-vertical'); await openProfile(snapshots);
  await terminalTab(snapshots, router.id).locator('.tab-label').click(); await openProfile(snapshots, 'local-shell'); await action(snapshots, 'group-horizontal');
  let saved;
  await check('Workspace snapshots capture repeated instances, independent selection, and nested pane sizes', snapshots, async () => {
    const vertical = snapshots.locator('.group-divider[aria-orientation="vertical"]').first(); await vertical.focus(); await vertical.press('ArrowRight'); await vertical.press('ArrowRight');
    const horizontal = snapshots.locator('.group-divider[aria-orientation="horizontal"]').first(); await horizontal.focus(); for (let i = 0; i < 3; i += 1) await horizontal.press('ArrowUp');
    await terminalTab(snapshots, selectedSwitch.id).locator('.tab-label').click();
    const before = await workspaceView(snapshots); saved = await saveWorkspaceSnapshot(snapshots, 'Nested repeated sessions');
    assert.equal(saved.instances.length, 4); assert.equal(saved.instances.filter(instance => instance.sessionId === 'fixture-router').length, 2); assert.equal(saved.sessionIds.length, 3);
    assert.equal(saved.layout.groups.length, 3); assert.ok(saved.layout.groups.every(group => group.tabs.includes(group.activeId)));
    const original = await calls(snapshots); const bySession = new Map(original.opens.map(opened => [opened.id, opened]));
    const connectionsInSavedOrder = saved.layout.groups.flatMap(group => group.tabs).map(id => saved.instances.find(instance => instance.id === id));
    assert.equal(connectionsInSavedOrder.length, 4); assert.ok(connectionsInSavedOrder.every(Boolean));
    assert.equal(saved.layout.tree.direction, before.tree.direction); assert.ok(Math.abs(saved.layout.tree.ratio - 0.6) < 0.000001);
    assert.equal(saved.layout.activeSessionId, bySession.get(selectedSwitch.id).profile.id);
    const selected = saved.layout.groups.find(group => group.id === saved.layout.activeGroupId);
    assert.equal(saved.instances.find(instance => instance.id === selected.activeId).sessionId, 'fixture-switch');
    await snapshots.locator('.snapshot-row').getByRole('button', { name: 'Select', exact: true }).click();
    assert.equal((await calls(snapshots)).opens.length, original.opens.length);
    assert.deepEqual(await workspaceView(snapshots), before);
    await closeDialog(snapshots, 'snapshots-dialog'); await screenshot(snapshots, 'macos-tab-groups-solarized-dark-preview');
  });
  await check('Restoring a snapshot recreates repeated tabs, selected tabs, and pane proportions beside existing sessions', snapshots, async () => {
    assert.ok(saved); const before = await calls(snapshots); const existing = before.opens.map(opened => opened.id);
    await nativeDialog(snapshots, 'snapshots', 'snapshots-dialog');
    await snapshots.locator('.snapshot-row').getByRole('button', { name: 'Connect…' }).click(); await snapshots.locator('#confirm-dialog').waitFor({ state: 'visible' });
    assert.equal(await snapshots.locator('.confirm-target-item').count(), saved.instances.length); assert.equal((await calls(snapshots)).opens.length, before.opens.length);
    await snapshots.locator('#confirm-accept').click();
    await snapshots.waitForFunction(count => window.__qa.calls.opens.length === count && document.querySelectorAll('.tab-group').length === 6, before.opens.length + saved.instances.length);
    const after = await calls(snapshots); const opened = after.opens.slice(before.opens.length); const restoredIds = new Set(opened.map(opened => opened.id));
    assert.deepEqual(opened.map(opened => opened.request.sessionId), saved.instances.map(instance => instance.sessionId)); assert.equal(after.closes.length, before.closes.length);
    for (const id of existing) assert.equal(await snapshots.locator(`.terminal-pane[data-connection-id="${id}"]`).count(), 1);
    const view = await workspaceView(snapshots); assert.deepEqual(filteredWorkspaceTree(view.tree, restoredIds), expectedSnapshotTree(saved, opened));
    const selected = saved.layout.groups.find(group => group.id === saved.layout.activeGroupId); const active = opened[saved.instances.findIndex(instance => instance.id === selected.activeId)].id;
    assert.equal(view.activeGroupId, await groupFor(snapshots, active));
    await screenshot(snapshots, 'macos-independent-groups-restored');
  });
  await check('A failed snapshot connection leaves successful instances usable and reports the partial restore', snapshots, async () => {
    assert.ok(saved); await snapshots.evaluate(() => {
      const open = window.termforge.terminalOpen; window.__qa.restoreAttempts = []; let failed = false;
      window.__qa.originalTerminalOpen = open;
      window.termforge.terminalOpen = async request => {
        window.__qa.restoreAttempts.push(JSON.parse(JSON.stringify(request)));
        if (!failed && request.sessionId === 'fixture-switch') { failed = true; throw new Error('Synthetic snapshot connection failure.'); }
        return open(request);
      };
    });
    const before = await calls(snapshots); await nativeDialog(snapshots, 'snapshots', 'snapshots-dialog'); await snapshots.locator('.snapshot-row').getByRole('button', { name: 'Connect…' }).click(); await snapshots.locator('#confirm-accept').click();
    await snapshots.waitForFunction(({ attempts, opens }) => window.__qa.restoreAttempts.length === attempts && window.__qa.calls.opens.length === opens, { attempts: saved.instances.length, opens: before.opens.length + saved.instances.length - 1 });
    await snapshots.waitForFunction(() => /(?:failed|could not restore)/i.test(document.getElementById('toast-stack').textContent) && !document.getElementById('workspace-status').textContent.startsWith('Opening'));
    const after = await calls(snapshots); const opened = after.opens.slice(before.opens.length);
    assert.equal(opened.length, saved.instances.length - 1); assert.deepEqual(await snapshots.evaluate(() => window.__qa.restoreAttempts.map(request => request.sessionId)), saved.instances.map(instance => instance.sessionId));
    assert.equal(after.closes.length, before.closes.length);
    const view = await workspaceView(snapshots); assert.ok(view.groups.every(group => group.tabs.length > 0 && group.tabs.includes(group.activeId)));
    assert.ok(view.groups.some(group => group.groupId === view.activeGroupId));
    const newIds = new Set(opened.map(opened => opened.id)); assert.equal(view.groups.filter(group => group.tabs.some(id => newIds.has(id))).length, 3);
    assert.ok((await visibleTerminalIds(snapshots)).some(id => newIds.has(id)));
    assert.match(await snapshots.locator('#toast-stack').innerText(), /1[^\n]*(?:failed|could not)|(?:failed|could not)[^\n]*1/i);
  });
  await check('Snapshot restore prunes a group whose only connection failed', snapshots, async () => {
    assert.ok(saved); await snapshots.evaluate(() => {
      const open = window.__qa.originalTerminalOpen; window.__qa.restoreAttempts = [];
      window.termforge.terminalOpen = async request => {
        window.__qa.restoreAttempts.push(JSON.parse(JSON.stringify(request)));
        if (request.sessionId === 'fixture-local') throw new Error('Synthetic empty group failure.');
        return open(request);
      };
    });
    const before = await calls(snapshots); const groupsBefore = (await workspaceView(snapshots)).groups.length;
    await nativeDialog(snapshots, 'snapshots', 'snapshots-dialog'); await snapshots.locator('.snapshot-row').getByRole('button', { name: 'Connect…' }).click(); await snapshots.locator('#confirm-accept').click();
    await snapshots.waitForFunction(({ attempts, opens, groups }) => window.__qa.restoreAttempts.length === attempts && window.__qa.calls.opens.length === opens && document.querySelectorAll('.tab-group').length === groups, { attempts: saved.instances.length, opens: before.opens.length + saved.instances.length - 1, groups: groupsBefore + 2 });
    const after = await calls(snapshots); const view = await workspaceView(snapshots); const newIds = new Set(after.opens.slice(before.opens.length).map(opened => opened.id));
    const restored = filteredWorkspaceTree(view.tree, newIds);
    assert.equal(restored.direction, 'vertical'); assert.equal(restored.ratio, 0.6); assert.equal(restored.first.tabs.length, 1); assert.equal(restored.second.tabs.length, 2);
    assert.ok(view.groups.every(group => group.tabs.length > 0 && group.tabs.includes(group.activeId))); assert.equal(after.closes.length, before.closes.length);
  });
}

async function openLocalAi(page) {
  await action(page, 'local-ai');
  await page.locator('#local-ai-panel').waitFor({ state: 'visible' });
  await page.locator('#local-ai-refresh').click();
  await page.waitForFunction(() => [...document.querySelectorAll('#local-ai-model option')].some(option => option.value === 'synthetic-local:4b'));
  await page.locator('#local-ai-model').selectOption('synthetic-local:4b');
}
async function startLocalAi(page, prompt = 'Explain this synthetic output', mode = 'ask') {
  const before = (await calls(page)).aiStarts.length;
  await page.locator('#local-ai-mode').selectOption(mode);
  await page.locator('#local-ai-prompt').fill(prompt);
  await page.locator('#local-ai-send').click();
  await page.waitForFunction(before => window.__qa.calls.aiStarts.length === before + 1, before);
  return (await calls(page)).aiStarts.at(-1);
}
async function replyLocalAi(page, request, text) {
  await page.evaluate(({ requestId, text }) => { window.__qa.emitAi({ requestId, type: 'delta', text }); window.__qa.emitAi({ requestId, type: 'done' }); }, { requestId: request.requestId, text });
  await page.waitForFunction(() => document.querySelector('#local-ai-cancel').disabled || document.querySelector('#local-ai-cancel').hidden);
}
async function writeScreenFixture(page, id, data, name) {
  await page.evaluate(({ id, data, name }) => { window.__qa.emitData(id, data); window.__qa.emitScreen({ requestId: name, id }); }, { id, data, name });
  await page.waitForFunction(name => window.__qa.calls.screens.some(screen => screen.requestId === name), name);
}
async function runLocalAiChecks() {
  const ai = await pageFor();
  await check('Local AI starts hidden without model discovery, inference, or terminal input', ai, async () => {
    assert.equal(await ai.locator('#local-ai-panel').isVisible(), false);
    const before = await calls(ai); assert.deepEqual(before.aiModels, []); assert.deepEqual(before.aiStarts, []); assert.deepEqual(before.aiCancels, []); assert.deepEqual(before.writes, []);
    await openLocalAi(ai);
    assert.equal(await ai.locator('#local-ai-port').inputValue(), '11434');
    assert.equal(await ai.locator('#local-ai-prompt').getAttribute('maxlength'), '8192'); assert.equal(await ai.locator('#local-ai-context').getAttribute('maxlength'), '16384');
    assert.ok((await calls(ai)).aiModels.every(request => request.port === 11434));
    assert.equal((await calls(ai)).aiStarts.length, 0); assert.equal((await calls(ai)).opens.length, 0);
  });
  const first = await openProfile(ai); const second = await openProfile(ai, 'switch-01');
  await ai.evaluate(id => window.__qa.emitActivated(id), first.id);
  await check('A typed Local AI question sends only the entered prompt and no terminal or profile context', ai, async () => {
    await writeScreenFixture(ai, first.id, '\x1b[2J\x1b[HAUTO-CONTEXT-MUST-NOT-LEAVE-TERMINAL', 'ai-private-screen');
    const request = await startLocalAi(ai, 'What does show interfaces mean?');
    assert.equal(request.prompt, 'What does show interfaces mean?'); assert.equal(request.context, ''); assert.equal(request.mode, 'ask'); assert.equal(request.port, 11434); assert.equal(request.model, 'synthetic-local:4b'); assert.ok(request.requestId);
    assert.deepEqual(Object.keys(request).sort(), ['context', 'mode', 'model', 'port', 'prompt', 'requestId']);
    assert.equal(JSON.stringify(request).includes('AUTO-CONTEXT'), false); assert.equal(JSON.stringify(request).includes('router-01'), false);
    const hostile = '<img src=x onerror="window.__qaAiInjected=true">\n<script>window.__qaAiInjected=true</script>\n日本語 🔧 café';
    await replyLocalAi(ai, request, hostile);
    assert.ok((await ai.locator('#local-ai-response').textContent()).includes(hostile));
    assert.equal(await ai.locator('#local-ai-response img, #local-ai-response script').count(), 0); assert.equal(await ai.evaluate(() => window.__qaAiInjected === true), false); assert.equal((await calls(ai)).writes.length, 0);
  });
  await check('Explicit selection attachment redacts obvious secrets and sends the editable preview exactly', ai, async () => {
    await writeScreenFixture(ai, first.id, '\x1b[3J\x1b[2J\x1b[HSELECTED-ONLY-CONTEXT\r\npassword=synthetic-password\r\nAuthorization: Bearer synthetic-bearer\r\napi_key=synthetic-api-key\r\n-----BEGIN PGP PRIVATE KEY BLOCK-----\r\nsynthetic-private-key-material\r\n-----END PGP PRIVATE KEY BLOCK-----\r\n', 'ai-selection-screen');
    await ai.locator(`.terminal-pane[data-connection-id="${first.id}"] .xterm-helper-textarea`).focus();
    await action(ai, 'select-all'); await ai.locator('#local-ai-attach-selection').click();
    const captured = await ai.locator('#local-ai-context').inputValue();
    assert.ok(captured.includes('SELECTED-ONLY-CONTEXT')); for (const secret of ['synthetic-password', 'synthetic-bearer', 'synthetic-api-key', 'synthetic-private-key-material']) assert.equal(captured.includes(secret), false);
    assert.match(await ai.locator('#local-ai-context-source').innerText(), /router-01/);
    assert.equal((await calls(ai)).aiStarts.length, 1);
    const edited = 'Only this manually reviewed context: 接続 failed.';
    await ai.locator('#local-ai-context').fill(edited);
    const request = await startLocalAi(ai, 'Explain the attached output.', 'explain');
    assert.equal(request.context, edited); assert.equal(request.mode, 'explain'); await replyLocalAi(ai, request, 'Synthetic explanation only.');
    await ai.locator('#local-ai-remove-context').click();
    const without = await startLocalAi(ai, 'What should I check next?'); assert.equal(without.context, ''); await replyLocalAi(ai, without, 'Check the interface status.');
  });
  await check('Visible-screen attachment excludes scrollback and never captures another tab implicitly', ai, async () => {
    const lines = ['OFFSCREEN-PRIVATE-SENTINEL', ...Array.from({ length: 160 }, (_, index) => `synthetic filler line ${index}`), 'VISIBLE-SCREEN-ONLY-SENTINEL'];
    await writeScreenFixture(ai, first.id, '\x1b[3J\x1b[2J\x1b[H' + lines.join('\r\n'), 'ai-visible-screen');
    await ai.locator('#local-ai-attach-screen').click();
    const context = await ai.locator('#local-ai-context').inputValue(); assert.ok(context.includes('VISIBLE-SCREEN-ONLY-SENTINEL')); assert.equal(context.includes('OFFSCREEN-PRIVATE-SENTINEL'), false);
    await ai.evaluate(id => window.__qa.emitActivated(id), second.id);
    const request = await startLocalAi(ai, 'Suggest a read-only command for this captured context.', 'command');
    assert.equal(request.context, context); assert.match(await ai.locator('#local-ai-request-target').innerText(), /router-01/);
    await replyLocalAi(ai, request, '```sh\nshow interfaces status\n```');
    await action(ai, 'show-command-window'); await ai.locator('#command-input').fill('existing draft');
    await ai.locator('.local-ai-use-command').first().click();
    assert.equal(await ai.locator('#command-input').inputValue(), 'existing draft'); assert.equal((await calls(ai)).writes.length, 0);
    assert.match(await ai.locator('#local-ai-error').innerText(), /target|active|switch|session/i);
    await ai.locator('#local-ai-remove-context').click();
  });
  await check('An AI command remains a draft, clears broadcast, and requires explicit command review', ai, async () => {
    await ai.evaluate(id => window.__qa.emitActivated(id), first.id);
    const request = await startLocalAi(ai, 'Suggest an interface status command.', 'command'); await replyLocalAi(ai, request, 'Review the output with:\n```shell\nshow interfaces status\n```');
    await ai.locator('#broadcast-mode').check(); const before = (await calls(ai)).writes.length;
    await ai.locator('.local-ai-use-command').first().click();
    assert.equal(await ai.locator('#command-input').inputValue(), 'show interfaces status'); assert.equal(await ai.locator('#broadcast-mode').isChecked(), false); assert.equal((await calls(ai)).writes.length, before);
    await ai.locator('#send-command').click(); await ai.locator('#confirm-dialog').waitFor({ state: 'visible' });
    assert.equal(await ai.locator('#confirm-preview').textContent(), 'show interfaces status'); assert.equal(await ai.locator('.confirm-target-item').count(), 1); assert.match(await ai.locator('#confirm-targets').innerText(), /router-01/);
    await ai.locator('#confirm-cancel').click(); assert.equal((await calls(ai)).writes.length, before);
    await ai.evaluate(id => window.__qa.emitActivated(id), second.id); await ai.locator('#send-command').click();
    assert.equal((await calls(ai)).writes.length, before); assert.equal(await ai.locator('#confirm-dialog').isVisible(), false);
    await ai.locator('#toast-stack .toast.error').filter({ hasText: 'AI drafts can only be sent' }).click();
    await ai.evaluate(id => window.__qa.emitActivated(id), first.id); await ai.locator('#send-command').click(); await ai.locator('#confirm-accept').click();
    await ai.waitForFunction(before => window.__qa.calls.writes.length === before + 1, before);
    assert.deepEqual((await calls(ai)).writes.at(-1), { id: first.id, data: 'show interfaces status\r' });
  });
  await check('Changing the active target while an AI command review is open prevents sending', ai, async () => {
    await ai.locator('.local-ai-use-command').first().click(); const before = (await calls(ai)).writes.length;
    await ai.locator('#send-command').click(); await ai.locator('#confirm-dialog').waitFor({ state: 'visible' });
    await ai.evaluate(id => window.__qa.emitActivated(id), second.id); await ai.locator('#confirm-accept').click();
    assert.equal((await calls(ai)).writes.length, before);
    await ai.evaluate(id => window.__qa.emitActivated(id), first.id);
  });
  await check('A completed suggestion cannot stage against a closed terminal', ai, async () => {
    const request = await startLocalAi(ai, 'Suggest a read-only status command.', 'command'); await replyLocalAi(ai, request, '```sh\nshow clock\n```');
    await ai.locator('#command-input').fill('preserve this draft');
    await ai.evaluate(id => window.__qa.emitExit(id), first.id); await action(ai, 'close-tab'); await ai.locator(`.terminal-pane[data-connection-id="${first.id}"]`).waitFor({ state: 'detached' });
    const before = (await calls(ai)).writes.length; await ai.locator('.local-ai-use-command').first().click();
    assert.equal(await ai.locator('#command-input').inputValue(), 'preserve this draft'); assert.equal((await calls(ai)).writes.length, before); assert.match(await ai.locator('#local-ai-error').innerText(), /target|closed|active|session/i);
  });
  await check('Cancel stops one request and stale streaming events cannot contaminate a new answer', ai, async () => {
    const request = await startLocalAi(ai, 'Long first question');
    await ai.evaluate(requestId => window.__qa.emitAi({ requestId, type: 'delta', text: 'First partial response' }), request.requestId);
    await ai.locator('#local-ai-cancel').click(); assert.ok((await calls(ai)).aiCancels.includes(request.requestId));
    const fresh = await startLocalAi(ai, 'Fresh second question'); assert.notEqual(fresh.requestId, request.requestId);
    await ai.evaluate(({ oldId, id }) => { window.__qa.emitAi({ requestId: oldId, type: 'delta', text: 'STALE-RESPONSE-MUST-BE-IGNORED' }); window.__qa.emitAi({ requestId: oldId, type: 'done' }); window.__qa.emitAi({ requestId: id, type: 'delta', text: 'Fresh response 日本語 🔧' }); window.__qa.emitAi({ requestId: id, type: 'done' }); }, { oldId: request.requestId, id: fresh.requestId });
    const answer = await ai.locator('#local-ai-response').textContent(); assert.ok(answer.includes('Fresh response 日本語 🔧')); assert.equal(answer.includes('STALE-RESPONSE'), false);
  });
  await check('Local AI transport and stream errors remain visible and allow a clean retry', ai, async () => {
    await ai.evaluate(() => window.__qa.setAiStartError('Synthetic local model request failed.'));
    await startLocalAi(ai, 'Trigger a synthetic failure'); await ai.locator('#local-ai-error').waitFor({ state: 'visible' }); assert.match(await ai.locator('#local-ai-error').innerText(), /Synthetic local model request failed/);
    await ai.evaluate(() => window.__qa.setAiStartError(''));
    const request = await startLocalAi(ai, 'Retry'); await ai.evaluate(requestId => window.__qa.emitAi({ requestId, type: 'error', error: 'Synthetic stream interruption.' }), request.requestId);
    assert.match(await ai.locator('#local-ai-error').innerText(), /Synthetic stream interruption/);
    const retry = await startLocalAi(ai, 'Retry again'); await replyLocalAi(ai, retry, 'Recovered.'); assert.match(await ai.locator('#local-ai-response').innerText(), /Recovered/);
  });
  await check('Closing Local AI cancels in-flight generation and retains no background inference', ai, async () => {
    const request = await startLocalAi(ai, 'Close during generation'); await ai.locator('#local-ai-close').click();
    assert.equal(await ai.locator('#local-ai-panel').isVisible(), false); assert.ok((await calls(ai)).aiCancels.includes(request.requestId));
    const before = await calls(ai); await ai.evaluate(requestId => { window.__qa.emitAi({ requestId, type: 'delta', text: 'HIDDEN-STALE-RESPONSE' }); window.__qa.emitAi({ requestId, type: 'done' }); }, request.requestId);
    assert.equal((await calls(ai)).aiStarts.length, before.aiStarts.length); assert.equal((await calls(ai)).writes.length, before.writes.length);
  });
  const setup = await pageFor();
  await check('Empty or unavailable local model servers give an inline setup hint and can be refreshed', setup, async () => {
    await setup.evaluate(() => window.__qa.setAiModels([])); await action(setup, 'local-ai'); await setup.locator('#local-ai-refresh').click();
    await setup.waitForFunction(() => !document.querySelector('#local-ai-refresh').disabled);
    assert.match(await setup.locator('#local-ai-panel').innerText(), /Ollama|model|download|install/i); assert.equal(await setup.locator('#local-ai-send').isDisabled(), true); assert.equal((await calls(setup)).aiStarts.length, 0);
    await setup.evaluate(() => window.__qa.setAiModelError('Cannot reach Ollama on 127.0.0.1:11434.'));
    await setup.locator('#local-ai-refresh').click(); await setup.locator('#local-ai-error').waitFor({ state: 'visible' }); assert.match(await setup.locator('#local-ai-error').innerText(), /Cannot reach Ollama/);
    await setup.evaluate(() => { window.__qa.setAiModelError(''); window.__qa.setAiModels([{ name: 'synthetic-local:4b', size: 2500000000, parameterSize: '4B' }]); });
    await setup.locator('#local-ai-refresh').click(); await setup.waitForFunction(() => [...document.querySelectorAll('#local-ai-model option')].some(option => option.value === 'synthetic-local:4b'));
    assert.equal((await calls(setup)).aiStarts.length, 0); assert.equal((await calls(setup)).writes.length, 0);
  });
  await check('The Local AI panel follows Solarized chrome and fits an 850 by 600 workspace', setup, async () => {
    await applyPalette(setup, 'solarized-dark', true); await setup.setViewportSize({ width: 850, height: 600 });
    const request = await startLocalAi(setup, 'Explain a network interface status.', 'ask'); await replyLocalAi(setup, request, 'SYNTHETIC LOCAL AI PREVIEW — no model or device connected.\nAn interface can be administratively enabled while its physical link is down. Check link state before changing configuration.');
    const layout = await setup.evaluate(() => {
      const panel = document.getElementById('local-ai-panel'); const rect = panel.getBoundingClientRect();
      return { body: { width: document.body.scrollWidth, height: document.body.scrollHeight }, panel: rect.toJSON(), chrome: getComputedStyle(document.documentElement).getPropertyValue('--chrome').trim(), background: getComputedStyle(panel).backgroundColor };
    });
    assert.deepEqual(layout.body, { width: 850, height: 600 }); assert.ok(layout.panel.x >= 0 && layout.panel.right <= 850 && layout.panel.bottom <= 600); assert.equal(layout.chrome, '#073642');
    await screenshot(setup, 'macos-local-ai-solarized-850x600'); return layout;
  });
  for (const platform of ['win32', 'linux']) {
    const page = await pageFor(platform);
    await check(`${platform} exposes Local AI through View without starting inference`, page, async () => {
      await page.locator('[data-menu="view"]').click(); await page.locator('#menu-dropdown [data-action="local-ai"]').click();
      await page.locator('#local-ai-panel').waitFor({ state: 'visible' }); assert.equal((await calls(page)).aiStarts.length, 0); assert.equal((await calls(page)).writes.length, 0);
    });
  }
  const cloud = await pageFor(); const cloudTarget = await openProfile(cloud);
  await check('Free online AI is an explicit choice and requires a key plus disclosure consent', cloud, async () => {
    assert.deepEqual((await calls(cloud)).aiModels, []); assert.deepEqual((await calls(cloud)).aiStarts, []);
    await openLocalAi(cloud); assert.equal(await cloud.locator('#ai-provider').inputValue(), 'ollama');
    await cloud.locator('#ai-provider').selectOption('openrouter-free');
    await cloud.waitForFunction(() => [...document.querySelectorAll('#local-ai-model option')].some(option => option.value === 'openrouter/free'));
    assert.equal(await cloud.locator('#ai-cloud-consent').isChecked(), false); assert.equal(await cloud.locator('#ai-api-key').getAttribute('type'), 'password');
    await cloud.locator('#local-ai-prompt').fill('Explain a network link state.'); assert.equal(await cloud.locator('#local-ai-send').isDisabled(), true);
    await cloud.locator('#ai-api-key').fill('synthetic-session-only-key'); assert.equal(await cloud.locator('#local-ai-send').isDisabled(), true);
    assert.equal((await calls(cloud)).aiStarts.length, 0); assert.ok((await calls(cloud)).aiModels.some(request => JSON.stringify(request) === JSON.stringify({ provider: 'openrouter-free' })));
    assert.match(await cloud.locator('#local-ai-panel').innerText(), /OpenRouter/i); assert.match(await cloud.locator('#local-ai-panel').innerText(), /sent|send|leave|online/i);
  });
  await check('Native menu Paste and Select All stay in the AI key field without terminal input', cloud, async () => {
    const before = await calls(cloud);
    await cloud.evaluate(() => window.__qa.setClipboard('synthetic-session-only-key'));
    await cloud.locator('#ai-api-key').fill(''); await cloud.locator('#ai-api-key').focus(); await action(cloud, 'paste');
    await cloud.waitForFunction(() => document.getElementById('ai-api-key').value === 'synthetic-session-only-key');
    await action(cloud, 'select-all');
    assert.deepEqual(await cloud.locator('#ai-api-key').evaluate(input => [input.selectionStart, input.selectionEnd]), [0, 'synthetic-session-only-key'.length]);
    assert.equal((await calls(cloud)).writes.length, before.writes.length); assert.equal((await calls(cloud)).aiStarts.length, before.aiStarts.length);
  });
  await check('Free online requests contain only the reviewed text and use the fixed free router', cloud, async () => {
    await writeScreenFixture(cloud, cloudTarget.id, '\x1b[3J\x1b[2J\x1b[HCLOUD-AUTO-CONTEXT-MUST-NOT-BE-SENT\r\npassword=synthetic-cloud-password\r\n', 'ai-cloud-screen');
    await cloud.locator('#ai-cloud-consent').check();
    const promptOnly = await startLocalAi(cloud, 'What does link down mean?');
    assert.deepEqual(Object.keys(promptOnly).sort(), ['apiKey', 'cloudConsent', 'context', 'mode', 'model', 'prompt', 'provider', 'requestId']);
    assert.equal(promptOnly.provider, 'openrouter-free'); assert.equal(promptOnly.model, 'openrouter/free'); assert.equal(promptOnly.cloudConsent, true); assert.equal(promptOnly.apiKey, 'synthetic-session-only-key'); assert.equal(promptOnly.context, ''); assert.equal(promptOnly.prompt, 'What does link down mean?');
    assert.equal(JSON.stringify(promptOnly).includes('router-01'), false); assert.equal(JSON.stringify(promptOnly).includes('CLOUD-AUTO-CONTEXT'), false);
    await replyLocalAi(cloud, promptOnly, 'Synthetic free online answer.');
    await cloud.locator('#local-ai-attach-screen').click();
    assert.equal((await cloud.locator('#local-ai-context').inputValue()).includes('synthetic-cloud-password'), false);
    await cloud.locator('#local-ai-context').fill('The interface is administratively up, operationally down.');
    const attached = await startLocalAi(cloud, 'Explain only this reviewed text.', 'explain');
    assert.equal(attached.context, 'The interface is administratively up, operationally down.'); assert.equal(attached.mode, 'explain'); assert.equal(attached.provider, 'openrouter-free'); assert.equal(attached.model, 'openrouter/free');
    await replyLocalAi(cloud, attached, 'Synthetic explanation.');
    const saved = JSON.stringify(await state(cloud)); assert.equal(saved.includes('synthetic-session-only-key'), false); assert.equal(saved.includes('Explain only this reviewed text'), false);
    assert.equal((await calls(cloud)).writes.length, 0); assert.deepEqual((await calls(cloud)).history, []);
  });
  await check('Free online quota errors do not retry through a paid or alternate provider', cloud, async () => {
    const request = await startLocalAi(cloud, 'Trigger a synthetic quota error'); const before = await calls(cloud);
    await cloud.evaluate(requestId => window.__qa.emitAi({ requestId, type: 'error', error: 'Free request quota exhausted. Try again later; no paid fallback is enabled.' }), request.requestId);
    await cloud.locator('#local-ai-error').waitFor({ state: 'visible' }); assert.match(await cloud.locator('#local-ai-error').innerText(), /quota exhausted/);
    const after = await calls(cloud); assert.equal(after.aiStarts.length, before.aiStarts.length); assert.equal(after.aiModels.length, before.aiModels.length); assert.equal(after.writes.length, before.writes.length);
    assert.ok(after.aiStarts.every(request => request.provider === 'openrouter-free' && request.model === 'openrouter/free'));
  });
  await check('Closing or changing the AI provider clears the session-only online key', cloud, async () => {
    await cloud.locator('#local-ai-close').click(); assert.equal(await cloud.locator('#ai-api-key').inputValue(), '');
    await action(cloud, 'local-ai'); await cloud.locator('#local-ai-panel').waitFor({ state: 'visible' });
    assert.equal(await cloud.locator('#ai-api-key').inputValue(), ''); assert.equal(await cloud.locator('#local-ai-send').isDisabled(), true);
    await cloud.locator('#ai-api-key').fill('synthetic-second-online-key');
    await cloud.locator('#ai-provider').selectOption('ollama'); assert.equal(await cloud.locator('#ai-api-key').inputValue(), '');
    await cloud.locator('#ai-provider').selectOption('openrouter-free'); assert.equal(await cloud.locator('#ai-api-key').inputValue(), ''); assert.equal(await cloud.locator('#ai-cloud-consent').isChecked(), false);
    const storage = await cloud.evaluate(() => ({ local: Object.fromEntries(Object.entries(localStorage)), session: Object.fromEntries(Object.entries(sessionStorage)) }));
    assert.ok(Object.keys(storage.local).every(key => key === 'termforge-classic-layout')); assert.deepEqual(storage.session, {});
    assert.equal(JSON.stringify(storage).includes('synthetic-second-online-key'), false); assert.equal(JSON.stringify(storage).includes('synthetic-session-only-key'), false);
    assert.equal(JSON.stringify(await state(cloud)).includes('synthetic-second-online-key'), false);
  });
  // Separate, explicitly synthetic setup/response views: the compact assistant
  // scrolls naturally, so neither preview hides controls or changes CSS for QA.
  await cloud.locator('#local-ai-new').click();
  await writeScreenFixture(cloud, cloudTarget.id, '\x1b[3J\x1b[2J\x1b[HDEMO SESSION — Synthetic preview; no device connected\r\n\r\nrouter-01# show interfaces status\r\nPort    Status          VLAN  Speed\r\nGi0/1   connected       10    1G\r\nGi0/2   administratively down 1G\r\n\r\nrouter-01# ', 'ai-online-preview-screen');
  await cloud.waitForFunction(() => [...document.querySelectorAll('#local-ai-model option')].some(option => option.value === 'openrouter/free'));
  await cloud.locator('#ai-api-key').fill('synthetic-preview-key-not-a-real-credential'); await cloud.locator('#ai-cloud-consent').check();
  const previewRequest = await startLocalAi(cloud, 'Explain administratively down and suggest a read-only check.');
  await replyLocalAi(cloud, previewRequest, 'SYNTHETIC AI PREVIEW — no AI service contacted.\n\nAdministratively down means the interface is disabled in configuration. Review the intended configuration and current interface status before making changes.\n\n```sh\nshow interfaces status\n```');
  await cloud.locator('#local-ai-resizer').focus(); await cloud.locator('#local-ai-resizer').press('End');
  await cloud.locator('.local-ai-body').evaluate(body => { body.scrollTop = 0; }); await screenshot(cloud, 'macos-ai-online-setup-1280x800');
  await cloud.locator('#local-ai-response').scrollIntoViewIfNeeded(); await screenshot(cloud, 'macos-ai-online-response-1280x800');
}

async function run() {
  const mac = await pageFor();
  await check('macOS exposes connection tools and all managers without a duplicate menu', mac, async () => {
    assert.equal(await mac.locator('#menu-bar').isVisible(), false);
    assert.equal(await mac.locator('.dock-tab').count(), 3);
    const size = await dimensions(mac); assert.ok(size.toolbar.height >= 24 && size.toolbar.bottom <= size.manager.y); assert.ok(size.manager.width >= 180 && size.manager.right < size.viewport.width);
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
  await check('Snapshots preserve cloned instances while profile selection never connects', mac, async () => {
    await nativeDialog(mac, 'snapshots', 'snapshots-dialog'); await mac.locator('#snapshot-name').fill('Synthetic workspace'); await mac.locator('#snapshot-save').click(); await mac.waitForFunction(() => window.__qa.getState().snapshots.length === 1);
    const snapshot = (await state(mac)).snapshots[0]; assert.equal(new Set(snapshot.sessionIds).size, snapshot.sessionIds.length); assert.equal(snapshot.instances.filter(instance => instance.sessionId === 'fixture-router').length, 2); assert.ok(snapshot.sessionIds.includes('fixture-local')); assert.equal(snapshot.layout.activeSessionId, 'fixture-router');
    assert.equal(snapshot.instances.length, 3); assert.equal(new Set(snapshot.instances.map(instance => instance.id)).size, snapshot.instances.length);
    const before = (await calls(mac)).opens.length; await mac.locator('.snapshot-row').getByRole('button', { name: 'Select', exact: true }).click(); assert.equal((await calls(mac)).opens.length, before);
  });
  await check('Snapshot connections require confirmation and preserve saved order', mac, async () => {
    const before = (await calls(mac)).opens.length; const snapshot = (await state(mac)).snapshots[0]; await mac.locator('.snapshot-row').getByRole('button', { name: 'Connect…' }).click(); await mac.locator('#confirm-dialog').waitFor(); assert.equal((await calls(mac)).opens.length, before); await mac.locator('#confirm-cancel').click(); assert.equal((await calls(mac)).opens.length, before);
    await mac.locator('.snapshot-row').getByRole('button', { name: 'Connect…' }).click(); await mac.locator('#confirm-accept').click(); await mac.waitForFunction(count => window.__qa.calls.opens.length === count, before + snapshot.instances.length); assert.deepEqual((await calls(mac)).opens.slice(before).map(item => item.request.sessionId), snapshot.instances.map(instance => instance.sessionId));
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
    await transfers.evaluate(() => window.__qa.setClipboard('show clock\nshow version\n')); const before = (await calls(transfers)).writes.length;
    await transfers.locator('.terminal-pane:visible .xterm-helper-textarea').first().focus(); await nativeDialog(transfers, 'paste', 'confirm-dialog'); await transfers.locator('#confirm-cancel').click(); assert.equal((await calls(transfers)).writes.length, before);
    await transfers.locator('.terminal-pane:visible .xterm-helper-textarea').first().focus(); await nativeDialog(transfers, 'paste', 'confirm-dialog'); await transfers.locator('#confirm-accept').click(); await transfers.waitForFunction(before => window.__qa.calls.writes.length > before, before); assert.ok((await calls(transfers)).writes.at(-1).data.includes('show version'));
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
  await runColorChecks();
  await runWorkspaceChecks();
  await runLocalAiChecks();
  await runModernChecks();
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
