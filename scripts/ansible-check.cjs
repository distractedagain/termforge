'use strict';
// Integration check using only a temporary localhost project. No device connections.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createProjectManager } = require('../app/projects.cjs');
const { createAnsibleManager } = require('../app/ansible.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 45000) { const deadline = Date.now() + timeout; while (!fn()) { if (Date.now() > deadline) throw new Error('Localhost integration check timed out.'); await sleep(30); } }
(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'termforge-ansible-check-'));
  const directory = path.join(root, 'project'); await fs.mkdir(directory);
  const events = []; const checks = [];
  const projects = createProjectManager({ dataDirectory: path.join(root, 'private') });
  const project = await projects.open(directory);
  const manager = createAnsibleManager({ projects, dataDirectory: path.join(root, 'private'), send: (_name, event) => events.push(event) });
  const python = process.env.TERMFORGE_TEST_PYTHON || 'python3';
  const common = { projectId: project.id, controller: 'local', python, inventory: 'inventory.yml', limit: 'localhost', trusted: true };
  const record = name => { checks.push(name); process.stdout.write(`PASS ${name}\n`); };
  try {
    const probe = await manager.probe({ python });
    assert.equal(probe.available, true, JSON.stringify(probe)); record('Real Python, Ansible Core and Runner available');
    await fs.writeFile(path.join(directory, 'inventory.yml'), 'all:\n  hosts:\n    localhost:\n      ansible_connection: local\n      ansible_python_interpreter: "{{ ansible_playbook_python }}"\n');
    // The destination is inside this temporary fixture and is removed in finally.
    const destination = path.join(directory, 'result.txt');
    await fs.writeFile(path.join(directory, 'playbook.yml'), `---\n- hosts: localhost\n  gather_facts: false\n  tasks:\n    - name: Write temporary fixture file\n      ansible.builtin.copy:\n        dest: ${JSON.stringify(destination)}\n        content: "TermForge localhost integration\\n"\n        mode: '0600'\n`);
    async function run(playbook, mode) {
      const plan = await manager.prepare({ ...common, playbook, mode });
      const job = await manager.start({ planId: plan.planId, confirmed: true });
      await until(() => events.some(e => e.id === job.id && e.type === 'status' && ['successful', 'failed', 'cancelled'].includes(e.status)) && manager.count === 0);
      const result = events.filter(e => e.id === job.id);
      return { plan, result, status: result.filter(e => e.type === 'status').at(-1).status };
    }
    const syntax = await run('playbook.yml', 'syntax'); assert.equal(syntax.status, 'successful', JSON.stringify(syntax.result)); record('Real syntax validation succeeds');
    const check = await run('playbook.yml', 'check');
    assert.equal(check.status, 'successful', JSON.stringify(check.result));
    await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
    assert.match(check.plan.command, /--check/); assert.match(check.plan.command, /--diff/);
    assert.ok(check.result.some(e => e.type === 'event' && e.host === 'localhost' && e.changed));
    assert.ok(check.result.some(e => e.diff?.includes('TermForge localhost integration')), 'Check mode must return an actual diff'); record('Check/diff reports localhost changes without writing fixture destination');
    const execute = await run('playbook.yml', 'run'); assert.equal(execute.status, 'successful', JSON.stringify(execute.result));
    assert.equal(await fs.readFile(destination, 'utf8'), 'TermForge localhost integration\n');
    assert.ok(execute.result.some(e => e.stats?.ok?.localhost > 0)); record('Explicit run writes only fixture destination and reports host statistics');
    const stale = await manager.prepare({ ...common, playbook: 'playbook.yml', mode: 'syntax' });
    await fs.appendFile(path.join(directory, 'playbook.yml'), '\n# changed after review\n');
    await assert.rejects(manager.start({ planId: stale.planId, confirmed: true }), /changed after review/); record('Changed inputs invalidate a reviewed plan');
    await fs.writeFile(path.join(directory, 'fail.yml'), '- hosts: localhost\n  gather_facts: false\n  tasks:\n    - name: Expected fixture failure\n      ansible.builtin.fail:\n        msg: Deliberate integration test failure\n');
    const failed = await run('fail.yml', 'run'); assert.equal(failed.status, 'failed'); assert.ok(failed.result.some(e => e.failed)); record('Real task failure reaches per-host results');
    await fs.writeFile(path.join(directory, 'pause.yml'), '- hosts: localhost\n  gather_facts: false\n  tasks:\n    - name: Wait for cancellation\n      ansible.builtin.pause:\n        seconds: 120\n');
    const plan = await manager.prepare({ ...common, playbook: 'pause.yml', mode: 'run' });
    const job = await manager.start({ planId: plan.planId, confirmed: true });
    await until(() => events.some(e => e.id === job.id && e.task === 'Wait for cancellation'));
    await manager.cancel(job.id);
    await until(() => manager.count === 0, 15000);
    assert.equal(events.filter(e => e.id === job.id && e.type === 'status').at(-1).status, 'cancelled'); record('Cancellation stops a real running localhost controller');
    process.stdout.write(JSON.stringify({ passed: checks.length, python: probe.pythonVersion, ansible: probe.ansibleVersion, runner: probe.runnerVersion, checks }) + '\n');
  } finally { await manager.closeAll(); projects.close(project.id); await fs.rm(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
