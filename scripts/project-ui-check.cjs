'use strict';
// Real temporary project files + synthetic Ansible/AI events, in headless Chromium.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const { createProjectManager } = require('../app/projects.cjs');
const core = require('../app/core.cjs');
const installFixture = require('./ui-fixture.cjs');
const renderer = path.resolve(__dirname, '../renderer');
const output = path.resolve(process.env.TERMFORGE_PROJECT_UI_OUTPUT || path.join(os.tmpdir(), 'termforge-project-ui-check'));
const checks = []; const errors = [];
let browser, page, server, root, projectRoot, project, manager;
const original = '---\n- name: Local workspace example\n  hosts: localhost\n  gather_facts: false\n  tasks:\n    - name: Report readiness\n      ansible.builtin.debug:\n        msg: Ready\n';
function projectBridge() {
  const listeners = new Set();
  const calls = { dirty: [], probe: [], prepare: [], start: [], cancel: [] };
  window.__projectqa = { calls, emit: e => { for (const cb of listeners) cb(e); } };
  for (const [name, method] of Object.entries({projectOpen: 'open', projectClose: 'close', projectList: 'list', projectRead: 'read', projectSave: 'save', projectListBackups: 'listBackups', projectReadBackup: 'readBackup', projectGitStatus: 'gitStatus', projectGitDiff: 'gitDiff'})) window.termforge[name] = input => window.__projectCall(method, input);
  Object.assign(window.termforge, {
    projectSetDirty: async input => { calls.dirty.push(input); return true; },
    ansibleProbe: async input => { calls.probe.push(input); return { available: true, pythonVersion: 'synthetic', ansibleVersion: 'synthetic', runnerVersion: 'synthetic' }; },
    ansiblePrepare: async input => {
      if (!input.trusted) throw new Error('Trust required'); calls.prepare.push(input);
      return { ...input, planId: 'fixture-plan', command: 'ansible-playbook -i inventory.yml --check --diff playbook.yml', summary: 'Synthetic Ansible plan', files: [{path: input.playbook, revision: 'fixture'}], warnings: ['Synthetic controller; no device connections.'] };
    },
    ansibleStart: async input => { if (input.confirmed !== true) throw new Error('Review required'); calls.start.push(input); return { id: 'fixture-run' }; },
    ansibleCancel: async id => { calls.cancel.push(id); return { id, cancelling: true }; },
    onAnsibleEvent: cb => { listeners.add(cb); return () => listeners.delete(cb); }
  });
}
async function check(name, callback) {
  await callback(); checks.push(name); process.stdout.write(`PASS ${name}\n`);
}
async function setEditor(text) {
  await page.locator('#project-editor .monaco-editor').first().click();
  await page.evaluate(() => window.__qa.emitMenu('select-all'));
  await page.evaluate(text => { window.__qa.setClipboard(text); window.__qa.emitMenu('paste'); }, text);
  await page.waitForFunction(() => !document.querySelector('#project-save').disabled);
}
async function waitSaved() {
  await page.waitForFunction(() => document.querySelector('#project-language').textContent.includes('Saved'));
}
async function screenshot(name) {
  await page.waitForFunction(() => !document.querySelector('.toast'), { timeout: 12000 });
  await page.screenshot({path:path.join(output,name),animations:'disabled'});
}

(async () => {
  await fs.mkdir(output, { recursive: true });
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'termforge-project-ui-')); projectRoot = path.join(root, 'project'); await fs.mkdir(projectRoot);
  await fs.writeFile(path.join(projectRoot, 'playbook.yml'), original);
  await fs.writeFile(path.join(projectRoot, 'inventory.yml'), 'all:\n  hosts:\n    localhost:\n      ansible_connection: local\n');
  await fs.writeFile(path.join(projectRoot, 'settings.json'), '{"name":"demo"}\n');
  execFileSync('git', ['init', '-q', projectRoot]);
  execFileSync('git', ['-C', projectRoot, 'add', '.']);
  execFileSync('git', ['-C', projectRoot, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Fixture']);
  manager = createProjectManager({ dataDirectory: path.join(root, 'private') });
  const mime = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.ttf':'font/ttf', '.woff':'font/woff', '.woff2':'font/woff2' };
  server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/favicon.ico') { res.writeHead(204).end(); return; }
      const target = path.resolve(renderer, '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
      if (!target.startsWith(renderer + path.sep) || !mime[path.extname(target)]) { res.writeHead(403).end(); return; }
      res.writeHead(200, { 'Content-Type': mime[path.extname(target)], 'Cache-Control':'no-store' }); res.end(await fs.readFile(target));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 }); page.setDefaultTimeout(10000);
  page.on('pageerror', e => errors.push(e.message)); page.on('console', e => { if (e.type() === 'error') errors.push(e.text()); });
  await page.exposeFunction('__projectCall', async (method, input) => {
    if (method === 'open') { project = await manager.open(projectRoot); return project; }
    if (method === 'close') return manager.close(input.projectId);
    return manager[method](input);
  });
  await page.exposeFunction('__validateSettings', s => core.validateSettings(s));
  await page.exposeFunction('__validateProfile', s => core.validateSession(s));
  const fixture = { platform: 'darwin', settings: core.validateSettings({ theme:'dark' }), sessions:[], snippets:[] };
  await page.addInitScript({ content: `(${installFixture.toString()})(${JSON.stringify(fixture)}); (${projectBridge.toString()})();` });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.locator('#project-toggle').waitFor();
  await check('Opening the workspace performs no Ansible or AI requests', async () => {
    await page.locator('#project-toggle').click(); await page.locator('#project-open-folder').click();
    await page.getByRole('treeitem', {name:'playbook.yml', exact:true}).click();
    await page.locator('#project-editor .monaco-editor').waitFor();
    assert.deepEqual(await page.evaluate(() => window.__projectqa.calls.start), []);
    assert.deepEqual(await page.evaluate(() => window.__qa.calls.aiStarts), []);
  });
  await check('Monaco edits save real files and create private backup history', async () => {
    await setEditor(original.replace('msg: Ready', 'msg: Edited'));
    await page.locator('#project-save').click();
    await waitSaved();
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.match(await fs.readFile(path.join(projectRoot, 'playbook.yml'), 'utf8'), /msg: Edited/);
    assert.equal((await manager.listBackups({projectId:project.id,path:'playbook.yml'})).length, 1);
  });
  await screenshot('project-dark.png');

  await check('Reopening the same project preserves dirty buffers and a valid project handle', async () => {
    await setEditor(original.replace('msg: Ready', 'msg: Same folder'));
    await page.locator('#project-open-folder').click();
    assert.equal(await page.locator('#confirm-dialog').isVisible(), false);
    await page.locator('#project-save').click();
    await waitSaved();
    assert.match(await fs.readFile(path.join(projectRoot, 'playbook.yml'), 'utf8'), /Same folder/);
  });
  await check('Git review renders a real working-tree diff', async () => {
    await page.locator('#project-git').click();
    await page.locator('#project-inspector-list button').filter({hasText:'playbook.yml'}).click();
    await page.waitForFunction(() => document.querySelector('#project-inspector-detail').textContent.includes('+'));
    assert.match(await page.locator('#project-inspector-detail').textContent(), /Same folder/);
    await page.locator('#project-inspector-close').click();
  });
  await check('History previews a backup before an explicit restore and save', async () => {
    await page.locator('#project-history').click();
    await page.locator('#project-inspector-list button').last().click();
    await page.locator('#project-review').waitFor({state:'visible'});
    assert.match(await fs.readFile(path.join(projectRoot, 'playbook.yml'), 'utf8'), /Same folder/);
    await page.locator('#project-review-apply').click();
    await waitSaved();
    assert.equal(await fs.readFile(path.join(projectRoot, 'playbook.yml'), 'utf8'), original);
  });
  await check('External edits stop saving and can be reconciled through a diff', async () => {
    const external = original.replace('msg: Ready','msg: External');
    await fs.writeFile(path.join(projectRoot, 'playbook.yml'), external);
    await setEditor(original.replace('msg: Ready','msg: Unsaved'));
    await page.locator('#project-save').click();
    await page.waitForFunction(() => document.querySelector('#project-error-text').textContent.includes('changed on disk'));
    assert.equal(await fs.readFile(path.join(projectRoot,'playbook.yml'),'utf8'), external);
    await page.locator('#project-reload').click();
    await page.locator('#project-review').waitFor({state:'visible'});
    await page.locator('#project-review-apply').click();
    await waitSaved();
    await page.locator('#project-dismiss-error').click();
  });
  await check('Native menu clipboard actions operate on the whole editor model', async () => {
    await page.locator('#project-editor .monaco-editor').click();
    await page.evaluate(() => window.__qa.emitMenu('select-all'));
    await page.evaluate(() => window.__qa.emitMenu('copy'));
    await page.waitForFunction(() => window.__qa.calls.clipboard.length > 0);
    assert.equal(await page.evaluate(() => window.__qa.calls.clipboard.at(-1)), original.replace('msg: Ready','msg: External'));
    await page.evaluate(text => { window.__qa.setClipboard(text); window.__qa.emitMenu('paste'); }, original);
    await page.waitForFunction(() => !document.querySelector('#project-save').disabled);
    await page.locator('#project-save').click();
    await waitSaved();
    assert.equal(await fs.readFile(path.join(projectRoot,'playbook.yml'),'utf8'), original);
    assert.deepEqual(await page.evaluate(() => window.__qa.calls.writes), []);
  });
  await check('AI file proposals require a completed response, diff review, apply and separate save', async () => {
    await page.locator('#project-ai-edit').click();
    assert.equal(await page.locator('#local-ai-context').inputValue(), original);
    assert.equal(await page.evaluate(() => window.__qa.calls.aiStarts.length), 0);
    await page.locator('#local-ai-prompt').fill('Change the debug message to AI proposed.');
    await page.locator('#local-ai-send').click();
    const request = await page.evaluate(() => window.__qa.calls.aiStarts.at(-1));
    assert.equal(request.mode,'edit');
    const proposed = original.replace('msg: Ready','msg: AI proposed');
    await page.evaluate(({id,text}) => window.__qa.emitAi({requestId:id,type:'delta',text}), {id:request.requestId,text:'```yaml\n'+proposed+'```'});
    assert.equal(await page.locator('.local-ai-review-file').isDisabled(), true);
    await page.evaluate(id => window.__qa.emitAi({requestId:id,type:'done'}),request.requestId);
    await page.locator('.local-ai-review-file').click();
    await page.locator('#project-review').waitFor({state:'visible'});
    assert.equal(await fs.readFile(path.join(projectRoot,'playbook.yml'),'utf8'), original);
    await screenshot('project-ai-review.png');
    await page.locator('#project-review-apply').click();
    assert.equal(await fs.readFile(path.join(projectRoot,'playbook.yml'),'utf8'), original);
    await page.locator('#project-save').click();
    await waitSaved();
    assert.match(await fs.readFile(path.join(projectRoot,'playbook.yml'),'utf8'), /AI proposed/);
    assert.equal(await page.evaluate(() => window.__projectqa.calls.start.length),0);
    await page.locator('.local-ai-review-file').click();
    await page.waitForFunction(() => document.querySelector('#local-ai-error').textContent.includes('target file changed'));
    assert.equal(await page.locator('#project-review').isVisible(), false);
    await page.locator('#local-ai-toggle').click();
  });
  await check('New buffers create a file only after an explicit save', async () => {
    await page.locator('#project-new-file').click();
    await page.locator('#project-new-path').fill('new-playbook.yml');
    await page.locator('#project-new-form button[type=submit]').click();
    await assert.rejects(fs.stat(path.join(projectRoot,'new-playbook.yml')), {code:'ENOENT'});
    await setEditor(original);
    await page.locator('#project-save').click();
    await waitSaved();
    assert.equal(await fs.readFile(path.join(projectRoot,'new-playbook.yml'),'utf8'), original);
    await page.getByRole('button',{name:'Close new-playbook.yml',exact:true}).click();
  });
  await check('Ansible trust and review gates prevent implicit runs; results and cancellation are visible', async () => {
    await page.locator('#ansible-panel summary').click();
    await page.locator('#ansible-playbook').fill('playbook.yml');
    await page.locator('#ansible-inventory').fill('inventory.yml');
    await page.locator('#ansible-limit').fill('localhost');
    await page.locator('#ansible-mode').selectOption('check');
    await page.locator('#ansible-prepare').click();
    assert.equal(await page.evaluate(() => window.__projectqa.calls.prepare.length),0);
    await page.locator('#ansible-trust').check();
    await page.locator('#ansible-prepare').click();
    await page.locator('#confirm-dialog').waitFor({state:'visible'});
    assert.equal(await page.evaluate(() => window.__projectqa.calls.start.length),0);
    await page.locator('#confirm-cancel').click();
    assert.equal(await page.evaluate(() => window.__projectqa.calls.start.length),0);
    await page.locator('#ansible-prepare').click();
    await page.locator('#confirm-accept').click();
    await page.waitForFunction(() => window.__projectqa.calls.start.length === 1);
    await page.evaluate(() => {window.__projectqa.emit({id:'fixture-run',type:'status',status:'running'});window.__projectqa.emit({id:'fixture-run',type:'event',event:'runner_on_ok',host:'localhost',task:'Synthetic task',changed:true,message:'Synthetic result; no device connected.',diff:'- old value\n+ new value'});});
    await page.waitForFunction(() => document.querySelector('#ansible-events').textContent.includes('new value'));
    await screenshot('project-ansible.png');
    await page.locator('#ansible-cancel').click();
    assert.equal(await page.evaluate(() => window.__projectqa.calls.cancel.length),1);
    await page.evaluate(() => window.__projectqa.emit({id:'fixture-run',type:'status',status:'cancelled'}));
    await page.waitForFunction(() => document.querySelector('#ansible-status').textContent.includes('cancelled'));
    await page.locator('#ansible-panel summary').click();
  });
  await check('A real JSON language worker validates malformed JSON locally', async () => {
    await page.getByRole('treeitem',{name:'settings.json',exact:true}).click();
    await setEditor('{ "bad": }');
    await page.waitForFunction(() => /[1-9]/.test(document.querySelector('#project-diagnostics').textContent));
    await page.getByRole('button',{name:'Close settings.json',exact:true}).click();
    await page.locator('#confirm-cancel').click();
    assert.equal(await page.getByRole('tab',{name:'settings.json, unsaved changes',exact:true}).count(),1);
    await page.getByRole('button',{name:'Close settings.json',exact:true}).click();
    await page.locator('#confirm-accept').click();
  });
  await check('Project view remains usable with the AI panel at 850px and respects light theme', async () => {
    await page.setViewportSize({width:850,height:650});
    await page.locator('#local-ai-toggle').click();
    await screenshot('project-compact.png');
    const bounds = await page.locator('#project-workspace').boundingBox(); assert.ok(bounds.width >= 300 && bounds.height > 300);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),false);
    await page.locator('#local-ai-toggle').click();
    await page.setViewportSize({width:1280,height:850});
    await page.evaluate(() => window.__qa.emitMenu('settings'));
    await page.locator('#settings-theme').selectOption('light');
    await page.locator('#settings-dialog button[type=submit]').click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    await screenshot('project-light.png');
  });

  await check('Editor and locally bundled workers produce no browser errors', async () => { assert.deepEqual(errors, []); });
  process.stdout.write(`${checks.length} project UI checks passed. Evidence: ${output}\n`);
})().catch(async error => {
  errors.push(error.stack || error.message); console.error(error);
  await page?.screenshot({path:path.join(output,'failure.png'),animations:'disabled'}).catch(() => {});
  process.exitCode = 1;
}).finally(async () => {
  await fs.writeFile(path.join(output,'report.json'), JSON.stringify({fixture:'Headless Chromium, real temporary files/Git and synthetic Ansible/AI',passed:checks.length,checks,errors},null,2)+'\n').catch(() => {});
  await browser?.close(); if(server) await new Promise(resolve=>server.close(resolve)); if(root) await fs.rm(root,{recursive:true,force:true});
});
