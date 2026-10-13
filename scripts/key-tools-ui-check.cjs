'use strict';
// Isolated headless form checks. Native IPC and OpenSSH are tested separately.
const { chromium } = require('playwright');
const esbuild = require('esbuild');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const repo = path.resolve(__dirname, '..');
const output = path.resolve(process.env.TERMFORGE_KEY_TOOLS_UI_OUTPUT || path.join(os.tmpdir(), 'termforge-key-tools-ui-check'));
let complete = false;
process.on('beforeExit', () => { if (!complete && !process.exitCode) { process.stderr.write('SSH key tool UI checks did not complete.\n'); process.exitCode = 1; } });
(async () => {
  await fs.mkdir(output, { recursive: true });
  const build = await esbuild.build({ stdin: { contents: "import { initKeyTools } from './renderer/key-tools.js'; window.keyTools = initKeyTools({ api: window.keyApi });", resolveDir: repo }, bundle: true, write: false, outfile: 'fixture.js' });
  let browser; const checks = [], errors = [];
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<style>body{font-family:system-ui}.modal{width:600px}label{display:grid;gap:5px}button,input,select{font:inherit;padding:8px}.modal-header,.modal-footer{display:flex;justify-content:space-between;gap:12px}.modal-body{padding:20px}input[type=checkbox]{display:inline}pre{background:#eee}</style>');
    for (const out of build.outputFiles) if (out.path.endsWith('.css')) await page.addStyleTag({ content: out.text });
    await page.evaluate(() => {
      window.calls = []; window.pending = null;
      window.keyApi = {
        keyToolsGenerate: input => { window.calls.push(structuredClone(input)); return new Promise(resolve => window.pending = resolve); },
        keyToolsConvert: async input => { window.calls.push(structuredClone(input)); return { canceled: true }; },
        keyToolsAgentList: async () => ({ available: true, keys: [{ type: 'ED25519', bits: 256, fingerprint: 'SHA256:fixture', comment: 'Fixture public identity' }], message: 'Public fingerprints only' })
      };
    });
    await page.addScriptTag({ content: build.outputFiles.find(out => out.path.endsWith('.js')).text });
    await page.evaluate(() => window.keyTools.run('create-public-key'));
    assert.equal(await page.locator('#key-tools-passphrase').getAttribute('required'), '');
    assert.equal(await page.locator('#key-tools-unencrypted').isChecked(), false);
    checks.push('encrypted default with required passphrase');
    await page.locator('#key-tools-passphrase').fill('synthetic passphrase');
    await page.locator('#key-tools-confirm-passphrase').fill('different passphrase');
    await page.locator('#key-tools-submit').click();
    assert.match(await page.locator('#key-tools-error').textContent(), /do not match/);
    assert.equal(await page.evaluate(() => window.calls.length), 0);
    checks.push('mismatch rejected before IPC');
    await page.locator('#key-tools-confirm-passphrase').fill('synthetic passphrase');
    await page.locator('#key-tools-submit').click();
    await page.waitForFunction(() => window.calls.length === 1);
    assert.equal(await page.locator('#key-tools-passphrase').inputValue(), '');
    assert.equal(await page.locator('#key-tools-confirm-passphrase').inputValue(), '');
    assert.equal(await page.locator('#key-tools-submit').isDisabled(), true);
    await page.mouse.click(5, 5);
    assert.equal(await page.locator('#key-tools-dialog').evaluate(item => item.open), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#key-tools-dialog').evaluate(item => item.open), true);
    checks.push('cleared DOM secrets and blocked close during native operation');
    await page.evaluate(() => window.pending({ canceled: false, encrypted: true, privatePath: '/synthetic/id_ed25519', publicPath: '/synthetic/id_ed25519.pub', fingerprint: 'SHA256:fixture' }));
    await page.locator('#key-tools-result').waitFor({ state: 'visible' });
    assert.match(await page.locator('#key-tools-result').textContent(), /Encrypted OpenSSH/);
    assert.equal(await page.locator('#key-tools-submit').isDisabled(), false);
    checks.push('result only shows paths and public fingerprint');
    await page.evaluate(() => window.keyTools.run('convert-private-key'));
    assert.equal(await page.locator('#key-tools-old-passphrase').isVisible(), true);
    assert.equal(await page.locator('#key-tools-type').isVisible(), false);
    assert.match(await page.locator('#key-tools-dialog .field-note').first().textContent(), /source is unchanged/);
    checks.push('conversion scope and old passphrase shown');
    await page.evaluate(() => window.keyTools.run('create-public-key'));
    await page.locator('#key-tools-unencrypted').check();
    assert.equal(await page.locator('#key-tools-passphrase').isDisabled(), true);
    await page.locator('#key-tools-submit').click();
    await page.waitForFunction(() => window.calls.length === 2);
    assert.deepEqual(await page.evaluate(() => window.calls[1]), { type: 'ed25519', comment: '', passphrase: '', allowUnencrypted: true });
    await page.evaluate(() => window.pending({ canceled: true }));
    await page.waitForFunction(() => !document.querySelector('#key-tools-submit').disabled);
    checks.push('explicit unencrypted choice sent to native approval');
    await page.evaluate(() => window.keyTools.run('agent-keys'));
    assert.match(await page.locator('#key-tools-result').textContent(), /SHA256:fixture/);
    assert.equal(await page.locator('#key-tools-passphrase').isVisible(), false);
    await page.locator('#key-tools-submit').click();
    assert.equal(await page.locator('#key-tools-submit').isDisabled(), false);
    checks.push('agent fingerprint view refreshes without hidden required fields');
    await page.screenshot({ path: path.join(output, 'agent-view.png') });
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    assert.equal(await page.locator('#key-tools-dialog').evaluate(item => item.open), false);
    assert.deepEqual(errors, []);
    checks.push('dialog closes without page errors');
    await page.evaluate(() => window.keyTools.run('create-public-key'));
    await page.screenshot({ path: path.join(output, 'generate-view.png') });
    await page.locator('#key-tools-passphrase').fill('synthetic unsaved passphrase');
    await page.mouse.click(5, 5);
    assert.equal(await page.locator('#key-tools-dialog').evaluate(item => item.open), false);
    assert.equal(await page.locator('#key-tools-passphrase').inputValue(), '');
    checks.push('idle backdrop dismisses and clears secrets; busy backdrop cannot dismiss');
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: checks.length, checks, errors }, null, 2));
    complete = true;
    console.log(JSON.stringify({ passed: checks.length, checks, errors }, null, 2));
  } finally { await browser?.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
