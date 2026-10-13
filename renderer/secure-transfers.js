import { createIcon } from './icons.js';
const $ = id => document.getElementById(id);
const node = (tag, className, text) => { const element = document.createElement(tag); if (className) element.className = className; if (text !== undefined) element.textContent = text; return element; };
const busy = status => ['queued', 'running'].includes(status);
const bytes = value => { const size = Number(value) || 0; if (size < 1024) return `${size} B`; if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`; if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MB`; return `${(size / 1024 ** 3).toFixed(1)} GB`; };
function appendPath(parent, name, remote) { const separator = remote || !parent.includes('\\') ? '/' : '\\'; return parent.replace(/[\\/]+$/, '') + separator + name; }
function parentPath(path, remote) { const separator = remote || !path.includes('\\') ? '/' : '\\'; const parts = path.replace(/[\\/]+$/, '').split(separator); parts.pop(); const result = parts.join(separator); if (separator === '\\' && /^[A-Za-z]:$/.test(result)) return `${result}\\`; if (separator === '\\' && path.startsWith('\\\\') && parts.length < 4) return path; return result || (separator === '/' ? '/' : path.slice(0, 3)); }
export function createSecureTransferUi({ api, toast, confirmAction }) {
  let session = null; let connecting = false; let closing = false; let selected = {local:new Set(), remote:new Set()}; const anchors = {local:null,remote:null}; let pendingStart = false; let profileKey = ''; let paths = {local:'', remote:'.'}; let listings = {local:[], remote:[]}; const revisions = {local:0, remote:0}; const jobs = new Map();
  const report = exception => { $('file-transfer-error').textContent = exception?.message || String(exception); $('file-transfer-error').hidden = false; };
  const attempt = callback => Promise.resolve().then(callback).catch(report);
  const selectedEntries = side => listings[side].filter(entry => selected[side].has(entry.name));
  function updateButtons() {
    for (const [side, id, label] of [['local','file-upload','Upload →'],['remote','file-download','← Download']]) {
      const entries = selectedEntries(side); $(id).disabled = !session || !entries.length || entries.some(entry => entry.type !== 'file') || connecting || closing || pendingStart;
      $(id).textContent = entries.length > 1 ? `${side === 'local' ? 'Upload' : 'Download'} ${entries.length} files ${side === 'local' ? '→' : '←'}` : label;
    }
    $('file-transfer-disconnect').disabled = !session || closing;
    $('file-transfer-status').textContent = connecting ? 'Connecting securely…' : session ? `${session.host}:${session.port} · encrypted SSH connection` : 'Disconnected';
  }
  function render(side) {
    const body = $(`file-${side}-entries`); body.replaceChildren();
    for (const entry of listings[side]) {
      const row = node('button', `file-entry${selected[side].has(entry.name) ? ' selected' : ''}`); row.type = 'button'; row.setAttribute('role', 'row'); row.setAttribute('aria-selected', String(selected[side].has(entry.name))); row.dataset.name = entry.name;
      const name = node('span', 'file-entry-name'); name.append(createIcon(entry.type === 'directory' ? 'folder' : 'file'), node('span', '', entry.name)); name.setAttribute('role', 'cell');
      const size = node('span', '', entry.type === 'file' ? bytes(entry.size) : entry.type === 'directory' ? 'Folder' : entry.type === 'symlink' ? 'Link' : 'Other'); size.setAttribute('role', 'cell');
      row.append(name, size); row.title = entry.name;
      row.addEventListener('click', event => {
        if (event.shiftKey && anchors[side] !== null) {
          const from = listings[side].findIndex(item => item.name === anchors[side]); const to = listings[side].indexOf(entry);
          selected[side] = new Set(listings[side].slice(Math.min(from < 0 ? to : from,to), Math.max(from,to)+1).map(item => item.name));
        } else if (event.metaKey || event.ctrlKey) { if (selected[side].has(entry.name)) selected[side].delete(entry.name); else selected[side].add(entry.name); anchors[side] = entry.name; }
        else { selected[side] = new Set([entry.name]); anchors[side] = entry.name; }
        render(side); body.querySelector(`[data-name="${CSS.escape(entry.name)}"]`)?.focus(); updateButtons(); });
      row.addEventListener('dblclick', () => { if (entry.type === 'directory') attempt(() => navigate(side, appendPath(paths[side], entry.name, side === 'remote'))); });
      row.addEventListener('keydown', event => { if (event.key === 'Enter' && entry.type === 'directory') { event.preventDefault(); attempt(() => navigate(side, appendPath(paths[side], entry.name, side === 'remote'))); } });
      body.append(row);
    }
    if (!listings[side].length) body.append(node('p', 'file-empty', 'This folder is empty.'));
    $(`file-${side}-count`).textContent = `${listings[side].length} items`;
  }
  async function navigate(side, requested) {
    if (side === 'remote' && !session) return;
    const revision = ++revisions[side]; const connection = session;
    $(`file-${side}-count`).textContent = 'Loading…'; $('file-transfer-error').hidden = true;
    try {
      const result = side === 'local' ? await api.transferListLocal({path:requested}) : await api.transferListRemote({id:connection.id,path:requested});
      if (revision !== revisions[side] || side === 'remote' && connection !== session) return;
      paths[side] = result.path; listings[side] = [...result.entries].sort((a,b) => Number(b.type === 'directory') - Number(a.type === 'directory') || a.name.localeCompare(b.name)); selected[side] = new Set(); anchors[side] = null; $(`file-${side}-path`).value = result.path; render(side); updateButtons();
    } catch (exception) { if (revision === revisions[side]) { $(`file-${side}-count`).textContent = 'Could not read folder'; $(`file-${side}-path`).value = paths[side]; } throw exception; }
  }
  function renderJobs() {
    const root = $('file-transfer-jobs'); root.replaceChildren();
    for (const job of [...jobs.values()].reverse()) {
      const row = node('div', 'transfer-job'); row.dataset.transferId = job.transferId;
      const detail = node('div', 'transfer-job-detail'); const filename = (job.direction === 'upload' ? job.localPath : job.remotePath).split(/[\\/]/).pop();
      detail.append(node('strong', '', `${job.direction === 'upload' ? '↑' : '↓'} ${filename}`), node('small', '', `${String(job.protocol).toUpperCase()} · ${job.status}${job.error ? ` · ${job.error}` : ''}`));
      if (job.warning) detail.append(node('small', 'transfer-job-warning', job.warning));
      const progress = node('progress'); progress.max = Number(job.total) || 1; progress.value = job.status === 'completed' ? progress.max : Number(job.bytes) || 0; progress.setAttribute('aria-label', `Transfer progress for ${filename}`); detail.append(progress);
      row.append(detail, node('span', 'transfer-job-size', `${bytes(job.bytes)}${job.total ? ` / ${bytes(job.total)}` : ''}`));
      if (busy(job.status)) { const cancel = node('button', 'quiet-button', 'Cancel'); cancel.type = 'button'; cancel.setAttribute('aria-label', `Cancel transfer ${filename}`); cancel.addEventListener('click', () => { cancel.disabled = true; attempt(() => api.transferCancel(job.transferId)).finally(() => { cancel.disabled = false; }); }); row.append(cancel); }
      root.append(row);
    }
    if (!jobs.size) root.append(node('p', 'field-note', 'Select files, then choose Upload or Download. Use Command / Ctrl-click to select more than one. Transfer progress appears here.'));
    $('file-clear-jobs').disabled = ![...jobs.values()].some(job => !busy(job.status));
  }
  async function start(direction) {
    const source = direction === 'upload' ? 'local' : 'remote'; const entries = selectedEntries(source); const connection = session;
    if (!connection || pendingStart || !entries.length || entries.some(entry => entry.type !== 'file')) return;
    const localDirectory = paths.local; const remoteDirectory = paths.remote; const protocol = $('file-transfer-protocol').value;
    $('file-transfer-error').hidden = true; pendingStart = true; updateButtons();
    try {
      for (const entry of entries) {
        if (session !== connection) break;
        const request = {id:connection.id,direction,protocol,localPath:appendPath(localDirectory,entry.name,false),remotePath:appendPath(remoteDirectory,entry.name,true)};
        const result = await api.transferStart(request);
        if (!jobs.has(result.transferId)) jobs.set(result.transferId, {...request,transferId:result.transferId,status:'queued',bytes:0,total:entry.size});
        renderJobs();
      }
    } finally { pendingStart = false; updateButtons(); }
  }
  async function disconnect(confirm = true) {
    if (!session || closing) return true;
    const active = [...jobs.values()].filter(job => job.id === session.id && busy(job.status));
    if (confirm && active.length && !await confirmAction({title:'Stop file transfers?',message:`Disconnecting will cancel ${active.length} active transfer${active.length === 1 ? '' : 's'}. Completed files remain available.`,accept:'Stop and disconnect'})) return false;
    closing = true; updateButtons(); const connection = session;
    try { await api.transferClose(connection.id); if (session === connection) { session = null; revisions.remote++; listings.remote = []; selected.remote = new Set(); anchors.remote = null; profileKey = ''; $('file-remote-entries').replaceChildren(node('p','file-empty','Connect to a server to browse files.')); } return true; }
    finally { closing = false; updateButtons(); }
  }
  async function open(profile) {
    if (connecting) return;
    const key = JSON.stringify([profile.id || '',profile.host,profile.port || 22,profile.username || '',profile.credentialId || '',profile.identityFile || '']);
    if (session && profileKey === key) { if (!$('file-transfer-dialog').open) $('file-transfer-dialog').showModal(); return; }
    if (session && !await disconnect()) return;
    connecting = true; $('file-transfer-error').hidden = true; $('file-transfer-title').textContent = `File transfer — ${profile.name || profile.host}`;
    if (!$('file-transfer-dialog').open) $('file-transfer-dialog').showModal(); updateButtons();
    try {
      // Stored profiles are resolved in the main process, including their credential reference.
      session = await api.transferOpen(profile.id ? {sessionId:profile.id} : {profile}); profileKey = key;
      await Promise.all([navigate('local', paths.local), navigate('remote', session.remotePath || '.')]);
    } catch (exception) { report(exception); }
    finally { connecting = false; updateButtons(); }
  }
  function install() {
    const wrapper = node('div'); wrapper.innerHTML = `<dialog id="file-transfer-dialog" class="modal file-transfer-modal"><header class="modal-header"><div><span class="secure-eyebrow">FILES</span><h2 id="file-transfer-title">File transfer</h2></div><button id="file-transfer-hide" class="icon-button" type="button" aria-label="Hide file transfers">×</button></header><div class="file-transfer-toolbar"><span id="file-transfer-status" role="status">Disconnected</span><label>Copy protocol<select id="file-transfer-protocol"><option value="sftp">SFTP</option><option value="scp">SCP</option></select></label><button type="button" id="file-transfer-disconnect" class="quiet-button">Disconnect</button></div><div id="file-transfer-error" class="form-error" role="alert" hidden></div><div class="file-panes">${['local','remote'].map(side => `<section class="file-pane" aria-label="${side === 'local' ? 'Local files' : 'Remote files'}"><header><h3>${side === 'local' ? 'This computer' : 'Remote server'}</h3><span id="file-${side}-count"></span></header><form id="file-${side}-form" class="file-path-bar"><button type="button" id="file-${side}-up" class="icon-button" aria-label="${side === 'local' ? 'Local' : 'Remote'} parent folder">↑</button><input id="file-${side}-path" aria-label="${side === 'local' ? 'Local' : 'Remote'} folder path" autocomplete="off" spellcheck="false"><button type="submit" class="icon-button" aria-label="Refresh ${side} folder">↻</button>${side === 'local' ? '<button type="button" id="file-choose-local" class="quiet-button">Browse…</button>' : ''}</form><div class="file-table" role="table" aria-label="${side === 'local' ? 'Local' : 'Remote'} file list"><div class="file-table-heading" role="row"><span role="columnheader">Name</span><span role="columnheader">Size / type</span></div><div id="file-${side}-entries" role="rowgroup"></div></div><footer><button type="button" id="${side === 'local' ? 'file-upload' : 'file-download'}" class="primary-button" disabled>${side === 'local' ? 'Upload →' : '← Download'}</button></footer></section>`).join('')}</div><section class="transfer-queue"><header><h3>Transfers</h3><button type="button" id="file-clear-jobs" class="quiet-button">Clear finished</button></header><div id="file-transfer-jobs"></div></section><footer class="modal-footer"><p class="field-note">Browse with SFTP; copy selected regular files with SFTP or SCP. Folders and links are not copied recursively. Existing destinations require confirmation.</p><button type="button" id="file-transfer-done" class="secondary-button">Hide</button></footer></dialog>`; document.body.append(wrapper);
    for (const side of ['local','remote']) { $(`file-${side}-form`).addEventListener('submit', event => { event.preventDefault(); attempt(() => navigate(side, $(`file-${side}-path`).value)); }); $(`file-${side}-up`).addEventListener('click', () => attempt(() => navigate(side,parentPath(paths[side],side === 'remote')))); }
    $('file-choose-local').addEventListener('click', () => attempt(async () => { const chosen = await api.transferChooseLocal(); if (chosen?.path) await navigate('local',chosen.path); }));
    $('file-upload').addEventListener('click', () => attempt(() => start('upload'))); $('file-download').addEventListener('click', () => attempt(() => start('download')));
    $('file-transfer-disconnect').addEventListener('click', () => attempt(() => disconnect()));
    for (const id of ['file-transfer-hide','file-transfer-done']) $(id).addEventListener('click', () => $('file-transfer-dialog').close());
    $('file-clear-jobs').addEventListener('click', () => { for (const [id, job] of jobs) if (!busy(job.status)) jobs.delete(id); renderJobs(); });
    api?.onTransferEvent?.(event => {
      if (event?.type === 'connection' && event.status === 'closed') {
        if (session?.id === event.id) {
          session = null; profileKey = ''; revisions.remote++; selected.remote = new Set(); anchors.remote = null; listings.remote = [];
          $('file-remote-entries').replaceChildren(node('p', 'file-empty', 'Connection closed. Reconnect to browse remote files.'));
          $('file-remote-count').textContent = 'Disconnected'; updateButtons();
        }
        return;
      }
      if (!event?.transferId) return;
      const previous = jobs.get(event.transferId); jobs.set(event.transferId, {...previous,...event}); renderJobs();
      if (event.status === 'completed' && previous?.status !== 'completed' && session?.id === event.id) attempt(() => navigate(event.direction === 'upload' ? 'remote' : 'local',paths[event.direction === 'upload' ? 'remote' : 'local']));
    });
    renderJobs(); updateButtons();
  }
  return { install, open, show() { if (!$('file-transfer-dialog').open) $('file-transfer-dialog').showModal(); }, connected: () => Boolean(session) };
}
