'use strict';
// A real headless renderer with synthetic IPC. No Electron, SSH connections,
// clipboard access, key generation, scripts, printers or log files are used.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const core = require('../app/core.cjs');
const { recordedInputToPython } = require('../app/automation.cjs');
const installFixture = require('./ui-fixture.cjs');
const { version } = require('../package.json');
const renderer = path.resolve(__dirname, '../renderer');
const output = path.resolve(process.env.TERMFORGE_MENU_UI_OUTPUT || path.join(os.tmpdir(), 'termforge-menu-ui-check'));
const checks = [], errors = [], pages = new Set();
let browser;
const profiles = [
  core.validateSession({ id:'menu-router', name:'router-01', host:'router.example.test', folder:'Lab', ssh:{ backend:'managed' } }),
  core.validateSession({ id:'menu-switch', name:'switch-01', host:'switch.example.test', folder:'Lab', ssh:{ backend:'managed' } }),
  core.validateSession({ id:'menu-local', name:'local-fixture', protocol:'local', folder:'Lab' })
];
const mime = { '.html':'text/html; charset=utf-8', '.js':'application/javascript', '.css':'text/css', '.png':'image/png', '.woff2':'font/woff2' };
const server = http.createServer(async (request, response) => {
  try {
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405).end(); return; }
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/favicon.ico') { response.writeHead(204).end(); return; }
    const file = path.resolve(renderer, '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
    if (!file.startsWith(renderer + path.sep)) { response.writeHead(403).end(); return; }
    const data = await fs.readFile(file); response.writeHead(200, { 'Content-Type':mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control':'no-store' }); response.end(data);
  } catch { response.writeHead(404).end(); }
});
async function pageFor(platform = 'win32', theme = 'light', settings = {}) {
  const page = await browser.newPage({ viewport:{ width:1280,height:860 }, deviceScaleFactor:1 }); pages.add(page); page.setDefaultTimeout(7000);
  page.on('pageerror', error => errors.push({ platform, message:error.message }));
  page.on('console', message => { if (message.type() === 'error') errors.push({ platform, message:message.text() }); });
  await page.exposeFunction('__validateProfile', core.validateSession);
  await page.exposeFunction('__validateSettings', core.validateSettings);
  await page.exposeFunction('__validateSnippets', core.validateSnippets);
  await page.exposeFunction('__validateSnapshots', core.validateSnapshots);
  await page.exposeFunction('__validateHistory', core.validateCommandHistory);
  await page.exposeFunction('__validateRecorded', recordedInputToPython);
  await page.addInitScript(installFixture, { platform, version, settings:core.validateSettings({ ...core.DEFAULT_SETTINGS,theme,showQuickConnectOnStartup:false,...settings }), sessions:profiles, snippets:[] });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.locator('#session-search').waitFor();
  await page.waitForFunction(() => window.__qa.calls.menuStates.some(state => state.ready));
  await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
  return page;
}
const calls = page => page.evaluate(() => structuredClone(window.__qa.calls));
async function menu(page, name) {
  for (let depth=0; depth<4 && await page.locator('#menu-dropdown').isVisible(); depth++) await page.keyboard.press('Escape');
  await page.locator(`[data-menu="${name}"]`).click();
  await page.locator('#menu-dropdown').waitFor();
}
const leaf = (page, action) => page.locator(`.menu-dropdown:visible [data-action="${action}"]`);
async function click(page, name, action) { await menu(page, name); await leaf(page, action).click(); }
async function submenu(page, name, label) {
  await menu(page, name);
  const item = page.locator('#menu-dropdown .menu-item').filter({ has:page.locator('.menu-label', { hasText:new RegExp(`^${label}$`) }) });
  await item.click();
}
async function dismiss(page, id) { await page.locator(`#${id} .dialog-close`).first().click(); await page.locator(`#${id}`).waitFor({ state:'hidden' }); }
async function open(page, name = 'router-01') {
  const before = (await calls(page)).opens.length;
  await page.locator('#dock-sessions').click(); await page.locator('.session-main').filter({ hasText:name }).dblclick();
  await page.waitForFunction(before => window.__qa.calls.opens.length === before + 1, before);
  const result = (await calls(page)).opens.at(-1);
  await page.waitForFunction(id => window.__qa.calls.menuStates.at(-1)?.current?.id === id, result.id);
  return result;
}
async function focusTerminal(page, id) { await page.locator(`.terminal-pane[data-connection-id="${id}"] .xterm-helper-textarea`).focus(); }
async function closeOpenDialogs(page) { await page.evaluate(() => { for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close(); }); }
async function expandedContrast(page) {
  const trigger = page.locator('#menu-dropdown .menu-item[aria-expanded="true"]');
  await trigger.hover();
  await trigger.evaluate(async el => { await Promise.allSettled(el.getAnimations({subtree:true}).map(animation=>animation.finished)); });
  return trigger.evaluate(el => {
    const style = getComputedStyle(el), foreground = getComputedStyle(el.querySelector('.menu-label')).color, background = style.backgroundColor;
    const luminance = color => { const channels = color.match(/[\d.]+/g).slice(0,3).map(Number).map(value => {const n=value/255;return n<=0.04045?n/12.92:((n+0.055)/1.055)**2.4;}); return channels[0]*0.2126+channels[1]*0.7152+channels[2]*0.0722; };
    const a=luminance(foreground),b=luminance(background); return { foreground,background,contrast:(Math.max(a,b)+0.05)/(Math.min(a,b)+0.05) };
  });
}
async function check(name, page, fn) {
  try { const evidence = await fn(); checks.push({ name, passed:true, evidence:evidence ?? null }); process.stdout.write(`PASS ${name}\n`); }
  catch (error) {
    checks.push({ name, passed:false, error:error.message }); process.stdout.write(`FAIL ${name}: ${error.message}\n`);
    if (page && !page.isClosed()) { checks.at(-1).diagnostic = await page.evaluate(() => ({ dialogs:[...document.querySelectorAll('dialog[open]')].map(el => el.id), menu:document.querySelector('#menu-dropdown')?.innerText, toasts:document.querySelector('#toast-stack')?.innerText, state:window.__qa.calls.menuStates.at(-1) })); await page.screenshot({ path:path.join(output,`failure-${checks.length}.png`), animations:'disabled' }).catch(() => {}); await closeOpenDialogs(page); }
  }
}
async function run() {
  const order = ['File','Edit','View','Options','Transfer','Script','Tools','Window','Help'];
  for (const platform of ['darwin','win32','linux']) {
    const page = await pageFor(platform);
    await check(`${platform}: menu order, disabled prerequisites, and browsing have no terminal effects`, page, async () => {
      assert.deepEqual(await page.locator('.menu-button').allTextContents(), order);
      if (platform === 'darwin') {
        assert.equal(await page.locator('#menu-bar').isVisible(),false,'macOS uses the native menubar, without a duplicate HTML menubar.');
        const native = (await calls(page)).menuStates.at(-1); assert.equal(native.ready,true); assert.equal(native.current,null);
        assert.equal((await calls(page)).opens.length,0); assert.equal((await calls(page)).writes.length,0); return { nativeMenuState:true, duplicateHtmlMenu:false };
      }
      const before = await calls(page);
      for (const label of order) { await menu(page, label.toLowerCase()); assert.ok((await page.locator('#menu-dropdown').innerText()).trim()); }
      await menu(page, 'file'); assert.equal(await leaf(page,'disconnect').isDisabled(),true); assert.equal(await leaf(page,'reconnect').isDisabled(),true); assert.equal(await leaf(page,'log').isDisabled(),true);
      await menu(page, 'transfer'); for (const action of ['send-ascii','send-binary','send-kermit','receive-xmodem','zmodem-upload']) assert.equal(await leaf(page,action).isDisabled(),true);
      assert.match(await leaf(page,'send-kermit').getAttribute('title'), /not implemented/i);
      await menu(page,'script'); for (const action of ['script-cancel','script-record-start','script-record-stop']) assert.equal(await leaf(page,action).isDisabled(),true);
      await page.keyboard.press('Escape'); const after = await calls(page);
      for (const key of ['opens','writes','closes','scriptRuns','desktopActions','keyGenerates','binarySends']) assert.deepEqual(after[key],before[key],key);
    });
    await check(`${platform}: reference connection shortcuts target the right workflows`,page,async () => {
      const mod = platform === 'darwin' ? 'Meta' : 'Control';
      await page.locator('#dock-sessions').focus(); await page.keyboard.press(`${mod}+k`); await page.waitForFunction(() => window.__qa.calls.quickConnectOpens.length === 1);
      await page.locator('#dock-sessions').focus(); await page.keyboard.press(`${mod}+t`); await page.waitForFunction(() => window.__qa.calls.quickConnectOpens.length === 2);
      assert.equal((await calls(page)).opens.length,0);
      await page.locator('#dock-sessions').focus(); await page.keyboard.press(`${mod}+e`); assert.equal(await page.locator('#session-search').evaluate(el => document.activeElement === el),true);
      await page.locator('#dock-sessions').focus(); await page.keyboard.press(`${mod}+l`); await page.waitForFunction(() => window.__qa.calls.opens.length === 1);
      assert.equal((await calls(page)).opens[0].profile.protocol,'local'); assert.equal((await calls(page)).writes.length,0);
    });
    await page.close(); pages.delete(page);
  }
  const page = await pageFor();
  await check('Nested menus support keyboard open, return, Escape, and viewport bounds',page,async () => {
    await page.locator('[data-menu="options"]').focus(); await page.keyboard.press('ArrowDown');
    const configure = page.locator('#menu-dropdown .menu-item').filter({hasText:'Configure'}); await configure.focus(); await page.keyboard.press('ArrowRight');
    await leaf(page,'snippets').waitFor(); assert.equal(await configure.getAttribute('aria-expanded'),'true');
    assert.equal(await leaf(page,'snippets').evaluate(el => document.activeElement === el),true);
    await page.keyboard.press('ArrowLeft'); assert.equal(await configure.evaluate(el => document.activeElement === el),true); assert.equal(await configure.getAttribute('aria-expanded'),'false');
    await page.keyboard.press('Escape'); assert.equal(await page.locator('#menu-dropdown').isVisible(),false); assert.equal(await page.locator('[data-menu="options"]').evaluate(el => document.activeElement === el),true);
    await page.setViewportSize({width:800,height:600}); await submenu(page,'options','Configure');
    const boxes = await page.locator('.menu-dropdown:visible').evaluateAll(nodes => nodes.map(el => {const b=el.getBoundingClientRect();return {x:b.x,y:b.y,right:b.right,bottom:b.bottom};}));
    for (const box of boxes) assert.ok(box.x >= 0 && box.y >= 0 && box.right <= 801 && box.bottom <= 601, JSON.stringify(box));
    await page.keyboard.press('Escape'); await page.setViewportSize({width:1280,height:860});
    assert.equal((await calls(page)).writes.length,0); return boxes;
  });
  const first = await open(page); const second = await open(page,'switch-01');
  await check('Native state updates follow connection, view, and modal state without leaking terminal text',page,async () => {
    const before = await calls(page); assert.equal(before.menuStates.at(-1).current.id,second.id);
    if (await page.locator('#command-bar').isVisible()) { await click(page,'view','show-command-window'); await page.locator('#command-bar').waitFor({state:'hidden'}); }
    await click(page,'view','show-command-window'); await page.locator('#command-bar').waitFor();
    await page.waitForFunction(() => window.__qa.calls.menuStates.at(-1)?.panes.commandWindow === true);
    await menu(page,'view'); assert.equal(await leaf(page,'show-command-window').getAttribute('aria-checked'),'true');
    await click(page,'options','settings'); await page.locator('#settings-dialog').waitFor();
    await page.waitForFunction(() => window.__qa.calls.menuStates.at(-1)?.dialogOpen === true);
    const native = (await calls(page)).menuStates.at(-1); assert.equal(JSON.stringify(native).includes('DEMO SESSION'),false); assert.equal(Object.hasOwn(native.current,'profile'),false);
    await dismiss(page,'settings-dialog'); await page.waitForFunction(() => window.__qa.calls.menuStates.at(-1)?.dialogOpen === false);
    assert.equal((await calls(page)).writes.length,before.writes.length);
  });
  await check('Disconnect All and Reconnect All show exact targets; cancellation changes no connections',page,async () => {
    const before = await calls(page);
    for (const action of ['disconnect-all','reconnect-all']) { await click(page,'file',action); await page.locator('#confirm-dialog').waitFor(); assert.equal(await page.locator('.confirm-target-item').count(),2); await page.locator('#confirm-cancel').click(); }
    const after = await calls(page); assert.deepEqual(after.opens,before.opens); assert.deepEqual(after.closes,before.closes); assert.deepEqual(after.writes,before.writes);
  });
  await check('Tabs and tiles change layout, and next tab can leave the current tile',page,async () => {
    await click(page,'window','tile-vertical'); await page.waitForFunction(() => document.querySelector('#terminal-workspace').dataset.orientation === 'vertical');
    await menu(page,'window'); assert.equal(await leaf(page,'tile-vertical').getAttribute('aria-checked'),'true'); await leaf(page,'next-tab').click();
    await page.waitForFunction(id => window.__qa.calls.menuStates.at(-1)?.current?.id === id,first.id);
    await click(page,'window','tabbed'); assert.equal(await page.locator('.terminal-pane:visible').count(),1);
    await menu(page,'window'); assert.equal(await leaf(page,'tabbed').getAttribute('aria-checked'),'true'); await page.keyboard.press('Escape');
  });
  await check('Toolbar and Status Bar toggles persist and remain available from the menu',page,async () => {
    for (const [action,selector] of [['show-toolbar','#main-toolbar'],['show-status-bar','.workspace-footer']]) {
      await click(page,'view',action); await page.locator(selector).waitFor({state:'hidden'});
      await menu(page,'view'); assert.equal(await leaf(page,action).getAttribute('aria-checked'),'false'); await leaf(page,action).click(); await page.locator(selector).waitFor();
    }
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('termforge-classic-layout')));
    assert.equal(stored.panes.toolbar,true); assert.equal(stored.panes.statusBar,true);
  });
  await check('Print screen and selection require review; cancel avoids printer IPC',page,async () => {
    const before = (await calls(page)).prints.length;
    await submenu(page,'file','Print'); await leaf(page,'print-screen').click(); await page.locator('#confirm-dialog').waitFor(); assert.match(await page.locator('#confirm-preview').innerText(),/DEMO SESSION/); await page.locator('#confirm-cancel').click(); assert.equal((await calls(page)).prints.length,before);
    await submenu(page,'file','Print'); await leaf(page,'print-screen').click(); await page.locator('#confirm-accept').click(); await page.waitForFunction(before => window.__qa.calls.prints.length === before+1,before); assert.match((await calls(page)).prints.at(-1).text,/DEMO SESSION/);
    await click(page,'edit','select-all'); await click(page,'edit','print-selection'); await page.locator('#confirm-dialog').waitFor(); await page.locator('#confirm-cancel').click(); assert.equal((await calls(page)).prints.length,before+1);
  });
  await check('Page Setup settings reach only the reviewed print request',page,async () => {
    await click(page,'file','page-setup'); await page.locator('#print-paper').selectOption('A4'); await page.locator('#print-landscape').check(); await page.locator('#page-setup-save').click();
    await submenu(page,'file','Print'); await leaf(page,'print-scrollback').click(); await page.locator('#confirm-accept').click(); await page.waitForFunction(() => window.__qa.calls.prints.at(-1)?.pageSize === 'A4');
    assert.equal((await calls(page)).prints.at(-1).landscape,true);
  });
  await check('Read-only edit targets cannot receive paste or redirect clipboard data to a terminal',page,async () => {
    await page.locator('#command-input').evaluate(el => {el.readOnly=true;}); await page.locator('#command-input').focus();
    const before = (await calls(page)).writes.length; await menu(page,'edit'); assert.equal(await leaf(page,'paste').isDisabled(),true); assert.equal(await leaf(page,'cut').isDisabled(),true); assert.equal(await leaf(page,'copy').isDisabled(),false);
    await page.keyboard.press('Escape'); await page.locator('#command-input').evaluate(el => {el.readOnly=false;}); assert.equal((await calls(page)).writes.length,before);
  });
  await check('Snapshot submenu opens a reviewed workspace; recent sessions select the saved target',page,async () => {
    await submenu(page,'file','Save Snapshot'); await leaf(page,'snapshot-save').click(); await page.locator('#snapshot-name').fill('Synthetic menu workspace'); await page.locator('#snapshot-save').click();
    await page.waitForFunction(() => window.__qa.getState().snapshots.length===1); const snapshot = await page.evaluate(() => window.__qa.getState().snapshots[0]); await dismiss(page,'snapshots-dialog');
    const before = (await calls(page)).opens.length; await submenu(page,'file','Open Snapshot'); await leaf(page,`snapshot-open:${encodeURIComponent(snapshot.id)}`).click(); await page.locator('#confirm-dialog').waitFor(); assert.equal(await page.locator('.confirm-target-item').count(),2); await page.locator('#confirm-cancel').click(); assert.equal((await calls(page)).opens.length,before);
    await closeOpenDialogs(page); await submenu(page,'file','Recent Session'); await leaf(page,'recent-session:menu-switch').click(); await page.waitForFunction(before => window.__qa.calls.opens.length===before+1,before); assert.equal((await calls(page)).opens.at(-1).profile.id,'menu-switch');
  });
  const recording = await pageFor(); const recordingTerminal = await open(recording);
  await check('Recording menus start after approval, stop for review, and discard stopped input',recording,async () => {
    await click(recording,'script','script-record-start'); await recording.locator('#confirm-dialog').waitFor(); await recording.locator('#confirm-cancel').click(); assert.equal((await calls(recording)).recordedScripts.length,0);
    await click(recording,'script','script-record-start'); await recording.locator('#confirm-accept').click(); await recording.waitForFunction(() => window.__qa.calls.menuStates.at(-1)?.recording===true);
    await menu(recording,'script'); assert.equal(await leaf(recording,'script-record-start').isDisabled(),true); assert.equal(await leaf(recording,'script-record-stop').isDisabled(),false); await recording.keyboard.press('Escape');
    await focusTerminal(recording,recordingTerminal.id); await recording.keyboard.type('synthetic');
    await click(recording,'script','script-record-stop'); await recording.locator('#recorder-dialog').waitFor(); assert.ok(await recording.locator('.recorded-event').count()>0);
    await recording.locator('#recorder-dialog .modal-header .icon-button').click(); await click(recording,'script','script-record-cancel'); await recording.locator('#confirm-dialog').waitFor(); await recording.locator('#confirm-accept').click();
    await recording.waitForFunction(() => window.__qa.calls.menuStates.at(-1)?.hasRecording===false); assert.equal((await calls(recording)).recordedScripts.length,0);
    await menu(recording,'script'); assert.equal(await leaf(recording,'script-record-cancel').isDisabled(),true); await recording.keyboard.press('Escape');
  });
  await check('Run, cancel and recent-script menus preserve the isolated script target',recording,async () => {
    await click(recording,'script','script-run'); await recording.locator('#script-output-dialog').waitFor(); await dismiss(recording,'script-output-dialog');
    await menu(recording,'script'); assert.equal(await leaf(recording,'script-cancel').isDisabled(),false); await leaf(recording,'script-cancel').click(); await recording.waitForFunction(() => window.__qa.calls.scriptCancels.length===1);
    await submenu(recording,'script','Recent Script'); await leaf(recording,'recent-script:fixture-recent-script').click(); await recording.locator('#script-output-dialog').waitFor();
    assert.equal((await calls(recording)).scriptRuns.at(-1).recentId,'fixture-recent-script'); assert.equal((await calls(recording)).scriptRuns.at(-1).terminalId,recordingTerminal.id); await dismiss(recording,'script-output-dialog');
  });
  await check('Raw logging, ASCII capture and Hex View follow transport capabilities and explicit review',recording,async () => {
    await click(recording,'file','raw-log'); await recording.locator('#confirm-dialog').waitFor(); await recording.locator('#confirm-cancel').click(); assert.equal((await calls(recording)).logs.length,0);
    await click(recording,'file','raw-log'); await recording.locator('#confirm-accept').click(); await recording.waitForFunction(() => window.__qa.calls.logs.length===1); assert.equal((await calls(recording)).logs[0].mode,'raw');
    await menu(recording,'file'); assert.equal(await leaf(recording,'raw-log').getAttribute('aria-checked'),'true'); await leaf(recording,'raw-log').click();
    await click(recording,'transfer','receive-ascii'); await recording.locator('#confirm-cancel').click(); assert.equal((await calls(recording)).captures.length,0);
    await click(recording,'transfer','receive-ascii'); await recording.locator('#confirm-accept').click(); await recording.waitForFunction(() => window.__qa.calls.captures.length===1);
    await menu(recording,'transfer'); assert.match(await leaf(recording,'receive-ascii').innerText(),/Stop Receiving/); await leaf(recording,'receive-ascii').click(); assert.equal((await calls(recording)).captures.at(-1).enabled,false);
    await click(recording,'view','hex-view'); await recording.locator('#hex-dialog').waitFor(); assert.match(await recording.locator('#hex-data').innerText(),/53 59 4e 54 48 45 54 49 43/); await dismiss(recording,'hex-dialog');
    await open(recording,'local-fixture'); await menu(recording,'transfer'); assert.equal(await leaf(recording,'send-binary').isDisabled(),true); await menu(recording,'view'); assert.equal(await leaf(recording,'hex-view').isDisabled(),true); await recording.keyboard.press('Escape');
  });
  await check('SSH key tools and settings import/export menu routes invoke only explicit operations',recording,async () => {
    for (const action of ['create-public-key','convert-private-key']) { await click(recording,'tools',action); await recording.locator('#key-tools-dialog').waitFor(); await recording.getByRole('button',{name:'Close SSH key tools'}).click(); }
    assert.equal((await calls(recording)).keyGenerates.length,0); assert.equal((await calls(recording)).keyConverts.length,0);
    await click(recording,'tools','agent-keys'); await recording.locator('#key-tools-result').waitFor(); assert.match(await recording.locator('#key-tools-result').innerText(),/synthetic key/); await recording.getByRole('button',{name:'Close SSH key tools'}).click();
    await click(recording,'tools','export-settings'); await recording.waitForFunction(() => window.__qa.calls.exports.length===1); await click(recording,'tools','import-json'); await click(recording,'tools','import-securecrt'); assert.deepEqual((await calls(recording)).imports,['json','securecrt']);
  });
  await check('Help and operating-system commands route fixed actions; unsupported entries explain their limits',recording,async () => {
    for (const [menuName,action] of [['help','help-web'],['help','help-support'],['window','minimize-window'],['window','zoom-window']]) await click(recording,menuName,action);
    assert.deepEqual((await calls(recording)).desktopActions.map(item=>item.action),['help-web','help-support','minimize-window','zoom-window']);
    await click(recording,'help','feature-availability'); await recording.locator('#menu-availability-dialog').waitFor(); assert.match(await recording.locator('#menu-availability-dialog').innerText(),/Still unavailable/); await dismiss(recording,'menu-availability-dialog');
  });
  const logRegression = await pageFor();
  await open(logRegression);
  await check('Canceling either log-mode picker preserves the existing paused log and Resume action',logRegression,async () => {
    const evidence=[];
    for (const [original,other] of [['log','raw-log'],['raw-log','log']]) {
      await click(logRegression,'file',original); await logRegression.locator('#confirm-dialog').waitFor(); await logRegression.locator('#confirm-accept').click();
      await logRegression.waitForFunction(() => window.__qa.calls.menuStates.at(-1)?.current?.logging === true);
      await click(logRegression,'file','pause-log'); await logRegression.waitForFunction(() => window.__qa.calls.menuStates.at(-1)?.current?.logPaused === true);
      const before=await calls(logRegression);
      await logRegression.evaluate(() => window.__qa.cancelNextLogChooser());
      await click(logRegression,'file',other); await logRegression.locator('#confirm-dialog').waitFor(); await logRegression.locator('#confirm-accept').click();
      await logRegression.waitForFunction(count => window.__qa.calls.logs.length === count+1,before.logs.length);
      await menu(logRegression,'file');
      assert.equal(await leaf(logRegression,original).getAttribute('aria-checked'),'true');
      assert.equal(await leaf(logRegression,other).getAttribute('aria-checked'),'false');
      assert.equal(await leaf(logRegression,'pause-log').getAttribute('aria-checked'),'true');
      const state=(await calls(logRegression)).menuStates.at(-1); assert.equal(state.current.logPaused,true); assert.equal(state.current.logging,true);
      await leaf(logRegression,'pause-log').click(); await logRegression.waitForFunction(() => window.__qa.calls.logs.at(-1)?.paused === false);
      assert.equal((await calls(logRegression)).logs.at(-1).paused,false,'The next pause command must resume, not pause the already-paused backend again.');
      evidence.push({original,pausedAfterCancel:state.current.logPaused,resumePaused:false});
      await click(logRegression,'file',original); await logRegression.waitForFunction(() => window.__qa.calls.menuStates.at(-1)?.current?.logging === false);
    }
    assert.equal((await calls(logRegression)).writes.length,0); return evidence;
  });
  await logRegression.close();pages.delete(logRegression);
  const reconnectRegression = await pageFor('win32','light',{closeOnExit:true});
  const reconnectFirst=await open(reconnectRegression), reconnectSecond=await open(reconnectRegression,'switch-01');
  await click(reconnectRegression,'window','tile-vertical');
  const groups = () => reconnectRegression.locator('.tab-group').evaluateAll(nodes => nodes.map(group=>({id:group.dataset.groupId,tabs:[...group.querySelectorAll('.terminal-pane')].map(pane=>pane.dataset.connectionId)})));
  await check('Reconnect All retains original tile positions with close-on-exit while replacements wait',reconnectRegression,async () => {
    const before=await calls(reconnectRegression), originalGroups=await groups(); assert.equal(originalGroups.length,2);
    await reconnectRegression.evaluate(() => window.__qa.holdTerminalOpens(true));
    await click(reconnectRegression,'file','reconnect-all'); await reconnectRegression.locator('#confirm-dialog').waitFor(); await reconnectRegression.locator('#confirm-accept').click();
    await reconnectRegression.waitForFunction(() => window.__qa.pendingTerminalOpens()===1);
    await reconnectRegression.evaluate(() => new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.deepEqual(await groups(),originalGroups,'An exit must not remove the original tab or its group while reopening is pending.');
    await reconnectRegression.waitForFunction(() => window.__qa.calls.menuStates.at(-1)?.connections.length===2 && window.__qa.calls.menuStates.at(-1).connections.every(row=>row.reconnecting));
    await menu(reconnectRegression,'file'); assert.equal(await leaf(reconnectRegression,'reconnect-all').isDisabled(),true); await reconnectRegression.keyboard.press('Escape');
    await reconnectRegression.evaluate(() => window.__qa.releaseNextTerminalOpen());
    await reconnectRegression.waitForFunction(count => window.__qa.calls.opens.length===count+1 && window.__qa.pendingTerminalOpens()===1,before.opens.length);
    const firstReplacement=(await calls(reconnectRegression)).opens.at(-1);
    await reconnectRegression.evaluate(() => new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const intermediate=await groups();
    assert.equal(intermediate.find(group=>group.tabs.includes(firstReplacement.id))?.id,originalGroups.find(group=>group.tabs.includes(reconnectFirst.id)).id);
    assert.equal(intermediate.find(group=>group.tabs.includes(reconnectSecond.id))?.id,originalGroups.find(group=>group.tabs.includes(reconnectSecond.id)).id);
    await reconnectRegression.evaluate(() => {window.__qa.holdTerminalOpens(false);window.__qa.releaseNextTerminalOpen();});
    await reconnectRegression.waitForFunction(count => window.__qa.calls.opens.length===count+2 && window.__qa.calls.menuStates.at(-1)?.connections.length===2 && window.__qa.calls.menuStates.at(-1).connections.every(row=>!row.reconnecting),before.opens.length);
    const after=await calls(reconnectRegression), replacements=after.opens.slice(before.opens.length), finalGroups=await groups();
    assert.deepEqual(replacements.map(item=>item.profile.id),[reconnectFirst.profile.id,reconnectSecond.profile.id]);
    assert.deepEqual(finalGroups,originalGroups.map(group=>({id:group.id,tabs:group.tabs.map(id=>id===reconnectFirst.id?replacements[0].id:replacements[1].id)})));
    assert.deepEqual(after.closes,[reconnectFirst.id,reconnectSecond.id]); assert.deepEqual(after.writes,before.writes);
    return {originalGroups,finalGroups};
  });
  await reconnectRegression.close();pages.delete(reconnectRegression);
  await check('Light and dark menu previews retain readable submenu and disabled states',page,async () => {
    await page.evaluate(() => document.getElementById('toast-stack').replaceChildren()); await submenu(page,'file','Print'); const lightContrast = await expandedContrast(page); assert.ok(lightContrast.contrast>=4.5,JSON.stringify(lightContrast)); await page.screenshot({path:path.join(output,'menus-light-print.png'),animations:'disabled'}); await page.keyboard.press('Escape');
    const dark = await pageFor('win32','dark'); await open(dark); await submenu(dark,'options','Configure'); const darkContrast = await expandedContrast(dark); assert.ok(darkContrast.contrast>=4.5,JSON.stringify(darkContrast)); await menu(dark,'tools'); await dark.screenshot({path:path.join(output,'menus-dark-tools.png'),animations:'disabled'}); await dark.close(); pages.delete(dark); return {lightContrast,darkContrast};
  });
  await check('Menu checks produced no renderer or console errors',null,async()=>assert.deepEqual(errors,[]));
}
(async () => {
  await fs.mkdir(output,{recursive:true}); await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  try { browser=await chromium.launch({headless:true}); await run(); } catch(error) {checks.push({name:'Menu UI runner',passed:false,error:error.stack||error.message});}
  finally { for(const page of pages) await page.close().catch(()=>{}); if(browser) await browser.close(); await new Promise(resolve=>server.close(resolve)); const failed=checks.filter(check=>!check.passed); const report={fixture:'Headless Chromium with synthetic IPC; no native OS or external-device operations',passed:checks.length-failed.length,failed:failed.length,checks,errors}; await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n'); process.stdout.write(`${report.passed}/${checks.length} menu UI checks passed. Evidence: ${output}\n`); if(failed.length) process.exitCode=1; }
})().catch(error=>{process.stderr.write(`${error.stack||error.message}\n`);process.exitCode=1;});
