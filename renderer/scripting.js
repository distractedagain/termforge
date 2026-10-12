const $ = (id) => document.getElementById(id);

export function createScriptUi({ api, getActiveId, toast }) {
  const runs = new Map();
  let selectedId = null;
  const running = (run) => ['starting', 'running'].includes(run?.state);
  function render() {
    $('script-list').replaceChildren();
    for (const run of runs.values()) {
      const option = document.createElement('option'); option.value = run.id; option.textContent = `${run.filename || run.id} · ${run.state || 'starting'}`; $('script-list').append(option);
    }
    $('script-list').value = selectedId || '';
    const run = runs.get(selectedId);
    $('script-status').textContent = run ? `${run.filename || 'Python script'} · ${run.state || 'starting'}${run.exitCode !== undefined ? ` · exit ${run.exitCode}` : ''}${run.error ? ` · ${run.error}` : ''}` : 'No scripts run.';
    $('script-output').textContent = run?.output || '';
    $('cancel-script').disabled = !running(run);
  }
  function show() { render(); if (!$('script-output-dialog').open) $('script-output-dialog').showModal(); }
  async function cancel() {
    const selected = runs.get(selectedId);
    const run = running(selected) ? selected : [...runs.values()].reverse().find(running);
    if (run) { selectedId = run.id; await api.scriptCancel(run.id); }
  }
  function status(event) {
    const previous = runs.get(event.id) || { output: '' };
    runs.set(event.id, { ...previous, ...event });
    if (!selectedId || event.state === 'starting') selectedId = event.id;
    if (runs.size > 50) { const removable = [...runs.values()].find((run) => !running(run) && run.id !== selectedId); if (removable) runs.delete(removable.id); }
    render();
    if (event.state === 'failed') toast(`Script failed: ${event.error || event.filename || 'Python script'}`, true);
  }
  function output(event) {
    const run = runs.get(event.id) || { id: event.id, terminalId: event.terminalId, output: '', state: 'running' };
    run.output = (run.output + String(event.data || '')).slice(-1024 * 1024); runs.set(event.id, run);
    if (!selectedId) selectedId = event.id;
    if (event.id === selectedId && $('script-output-dialog').open) render();
  }
  async function perform(action) {
    switch (action) {
      case 'script-run': {
        const result = await api.scriptRun({ terminalId: getActiveId() || undefined, arguments: [] });
        if (result) { selectedId = result.id; if (!runs.has(result.id)) runs.set(result.id, { ...result, state: 'starting', output: '' }); show(); }
        return true;
      }
      case 'script-cancel': await cancel(); return true;
      case 'script-output': show(); return true;
      default: return false;
    }
  }
  function install() {
    $('script-list').addEventListener('change', () => { selectedId = $('script-list').value; render(); });
    $('cancel-script').addEventListener('click', () => Promise.resolve(cancel()).catch((error) => toast(error.message || String(error), true)));
    if (typeof api?.onScriptStatus === 'function') api.onScriptStatus(status);
    if (typeof api?.onScriptOutput === 'function') api.onScriptOutput(output);
  }
  return { install, perform, hasRunning: () => [...runs.values()].some(running) };
}
