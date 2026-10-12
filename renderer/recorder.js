// Recording is explicit and stays in memory until the reviewed script is saved.
export function createRecorder({ api, getConnection, confirmAction, toast, changed = () => {} }) {
  const dialog = document.createElement('dialog'); dialog.className = 'modal script-output-modal'; dialog.id = 'recorder-dialog';
  const heading = document.createElement('header'); heading.className = 'modal-header';
  const title = document.createElement('h2'); title.textContent = 'Script Recorder'; heading.append(title);
  const close = document.createElement('button'); close.type = 'button'; close.className = 'icon-button'; close.textContent = '×'; close.setAttribute('aria-label', 'Close'); close.addEventListener('click', () => dialog.close()); heading.append(close);
  const body = document.createElement('div'); body.className = 'modal-body';
  const description = document.createElement('p'); description.className = 'field-note'; description.textContent = 'Review recorded input before exporting. Remove any passwords or sensitive input. The generated Python script sends these bytes with recorded delays; it does not infer prompts.';
  const status = document.createElement('p'); status.id = 'recorder-status'; status.setAttribute('role', 'status');
  const eventsList = document.createElement('div'); eventsList.id = 'recorded-events';
  const footer = document.createElement('footer'); footer.className = 'modal-footer';
  const stop = document.createElement('button'); stop.id = 'recorder-stop'; stop.className = 'secondary-button'; stop.textContent = 'Stop recording';
  const save = document.createElement('button'); save.id = 'recorder-save'; save.className = 'primary-button'; save.textContent = 'Save Python script…';
  body.append(description, status, eventsList); footer.append(stop, save); dialog.append(heading, body, footer); document.body.append(dialog);
  let target = null, events = [], bytes = 0, previousTime = 0;
  const encodedSize = value => new TextEncoder().encode(value).length;
  function render() {
    status.textContent = `${target ? `Recording ${target.title}` : 'Recording stopped'} · ${events.length} sends · ${bytes} bytes`;
    stop.disabled = !target; save.disabled = Boolean(target) || events.length === 0;
    eventsList.replaceChildren();
    events.forEach((event, index) => {
      const row = document.createElement('div'); row.className = 'recorded-event';
      const text = document.createElement('code'); text.textContent = `${event.delayMs} ms  ${JSON.stringify(event.data)}`;
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'icon-button'; remove.textContent = '×'; remove.setAttribute('aria-label', `Remove recorded send ${index + 1}`); remove.disabled = Boolean(target);
      remove.addEventListener('click', () => { bytes -= encodedSize(events[index].data); events.splice(index, 1); render(); }); row.append(text, remove); eventsList.append(row);
    });
  }
  function stopRecording() { target = null; render(); changed(); }
  stop.addEventListener('click', stopRecording);
  save.addEventListener('click', async () => {
    save.disabled = true;
    try { const result = await api.saveRecordedScript(events); if (result) { toast('Recorded script saved.', false, result.path); dialog.close(); } }
    catch (error) { toast(error.message || String(error), true); }
    finally { render(); }
  });
  async function perform(action) {
    if (action !== 'script-record') return false;
    if (target) { stopRecording(); if (!dialog.open) dialog.showModal(); return true; }
    const connection = getConnection();
    if (!connection || connection.exited) { toast('Open a terminal before recording.', true); return true; }
    const accepted = await confirmAction({ title: 'Record terminal input?', message: `Record input sent to “${connection.title}”. Start after authentication; any password typed while recording will be captured. Review and remove sensitive entries before saving.`, accept: 'Start recording' });
    if (!accepted) return true;
    events = []; bytes = 0; previousTime = 0; target = { id: connection.id, title: connection.title }; render();
    changed();
    toast(`Recording input for ${connection.title}. Choose Script → Record Input again to stop.`);
    return true;
  }
  function input(connection, data) {
    if (!target || connection.id !== target.id || !data) return;
    const size = encodedSize(data);
    if (events.length >= 10000 || bytes + size > 1024 * 1024) { stopRecording(); toast('Recording stopped at its size limit. Review and export the captured input.', true); if (!dialog.open) dialog.showModal(); return; }
    const now = Date.now(); const delayMs = previousTime ? Math.min(60000, Math.max(0, now - previousTime)) : 0;
    events.push({ data, delayMs }); bytes += size; previousTime = now;
  }
  function exited(id) { if (target?.id === id) { stopRecording(); toast('Recording stopped because its terminal closed.'); } }
  return { perform, input, exited, isRecording: () => Boolean(target) };
}
