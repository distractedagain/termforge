import { createIcon } from './icons.js';
const $ = id => document.getElementById(id);
const node = (tag, className, text) => { const element = document.createElement(tag); if (className) element.className = className; if (text !== undefined) element.textContent = text; return element; };
const busy = status => ['queued', 'running'].includes(status);
const bytes = value => { const size = Number(value) || 0; if (size < 1024) return `${size} B`; if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`; if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MB`; return `${(size / 1024 ** 3).toFixed(1)} GB`; };
function appendPath(parent, name, remote) { const separator = remote || !parent.includes('\\') ? '/' : '\\'; return parent.replace(/[\\/]+$/, '') + separator + name; }
function parentPath(path, remote) { const separator = remote || !path.includes('\\') ? '/' : '\\'; const parts = path.replace(/[\\/]+$/, '').split(separator); parts.pop(); const result = parts.join(separator); if (separator === '\\' && /^[A-Za-z]:$/.test(result)) return `${result}\\`; if (separator === '\\' && path.startsWith('\\\\') && parts.length < 4) return path; return result || (separator === '/' ? '/' : path.slice(0, 3)); }
export function createSecureTransferUi({ api, toast, confirmAction }) {
  let session = null; let connecting = false; let closing = false; let selected = {local:new Set(), remote:new Set()}; const anchors = {local:null,remote:null}; let pendingStart = false; let profileKey = ''; let paths = {local:'', remote:'.'}; let listings = {local:[], remote:[]}; const revisions = {local:0, remote:0}; const loading = {local:false,remote:false}; const jobs = new Map(); let remoteOperation = null; let folderOperation = null;
  const report = exception => { $('file-transfer-error').textContent = exception?.message || String(exception); $('file-transfer-error').hidden = false; };
  const attempt = callback => Promise.resolve().then(callback).catch(report);
  const selectedEntries = side => listings[side].filter(entry => selected[side].has(entry.name));
  const operationPending = () => remoteOperation && ['preparing','applying','discarding'].includes(remoteOperation.phase);
  const folderPending = () => folderOperation && ['preparing','starting','discarding'].includes(folderOperation.phase);
  const reviewOpen = () => Boolean(remoteOperation || folderOperation);
  const supportsFolders = () => typeof api?.transferPrepareFolder === 'function' && typeof api?.transferStartFolder === 'function' && typeof api?.transferDiscardFolder === 'function';
  const activeTransfers = () => [...jobs.values()].some(job => job.id === session?.id && busy(job.status));
  function updateButtons() {
    for (const [side, id, label] of [['local','file-upload','Upload →'],['remote','file-download','← Download']]) {
      const entries = selectedEntries(side); const folder = entries.length === 1 && entries[0].type === 'directory';
      const supported = folder ? supportsFolders() && $('file-transfer-protocol').value === 'sftp' && !activeTransfers() && !loading.local && !loading.remote : entries.length && entries.every(entry => entry.type === 'file');
      $(id).disabled = !session || !supported || connecting || closing || pendingStart || reviewOpen() || loading[side];
      $(id).textContent = folder ? `${side === 'local' ? 'Upload folder →' : '← Download folder'}` : entries.length > 1 ? `${side === 'local' ? 'Upload' : 'Download'} ${entries.length} files ${side === 'local' ? '→' : '←'}` : label;
      $(id).title = folder && $('file-transfer-protocol').value !== 'sftp' ? 'Choose SFTP to copy a folder.' : folder ? 'Review this folder and its contents before copying.' : '';
    }
    $('file-transfer-disconnect').disabled = !session || closing || reviewOpen();
    const remoteSelection = selectedEntries('remote');
    const operationsDisabled = !session || connecting || closing || pendingStart || loading.remote || reviewOpen() || activeTransfers();
    const singleTarget = remoteSelection.length === 1 && ['file','directory'].includes(remoteSelection[0].type);
    for (const operation of ['mkdir','rename','delete','chmod']) $(`file-remote-${operation}`).disabled = operationsDisabled || (operation !== 'mkdir' && !singleTarget);
    for (const side of ['local','remote']) for (const control of $(`file-${side}-form`).querySelectorAll('input,button')) control.disabled = reviewOpen() || closing || side === 'remote' && !session;
    for (const control of document.querySelectorAll('#file-transfer-jobs button')) control.disabled = reviewOpen();
    $('file-transfer-protocol').disabled = reviewOpen() || pendingStart;
    for (const id of ['file-transfer-hide','file-transfer-done']) $(id).disabled = reviewOpen();
    $('file-clear-jobs').disabled = reviewOpen() || ![...jobs.values()].some(job => !busy(job.status));
    $('file-transfer-status').textContent = connecting ? 'Connecting securely…' : session ? `${session.host}:${session.port} · encrypted SSH connection` : 'Disconnected';
  }
  function render(side) {
    const body = $(`file-${side}-entries`); body.replaceChildren();
    for (const entry of listings[side]) {
      const row = node('button', `file-entry${selected[side].has(entry.name) ? ' selected' : ''}`); row.type = 'button'; row.setAttribute('role', 'row'); row.setAttribute('aria-selected', String(selected[side].has(entry.name))); row.dataset.name = entry.name;
      const name = node('span', 'file-entry-name'); name.append(createIcon(entry.type === 'directory' ? 'folder' : 'file'), node('span', '', entry.name)); name.setAttribute('role', 'cell');
      const size = node('span', '', entry.type === 'file' ? bytes(entry.size) : entry.type === 'directory' ? 'Folder' : entry.type === 'symlink' ? 'Link' : 'Other'); size.setAttribute('role', 'cell');
      row.append(name, size);
      if (side === 'remote') { const permissions = node('span', 'file-entry-permissions', /^[0-7]{3}$/.test(entry.permissions) ? entry.permissions : '—'); permissions.setAttribute('role','cell'); permissions.setAttribute('aria-label', `Permissions ${permissions.textContent}`); row.append(permissions); }
      row.title = entry.name;
      row.addEventListener('click', event => {
        if (reviewOpen()) return;
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
  async function navigate(side, requested, operationRefresh = false) {
    if (reviewOpen() && !operationRefresh) return;
    if (side === 'remote' && !session) return;
    const revision = ++revisions[side]; const connection = session;
    loading[side] = true; updateButtons();
    $(`file-${side}-count`).textContent = 'Loading…'; $('file-transfer-error').hidden = true;
    try {
      const result = side === 'local' ? await api.transferListLocal({path:requested}) : await api.transferListRemote({id:connection.id,path:requested});
      if (revision !== revisions[side] || side === 'remote' && connection !== session) return;
      paths[side] = result.path; listings[side] = [...result.entries].sort((a,b) => Number(b.type === 'directory') - Number(a.type === 'directory') || a.name.localeCompare(b.name)); selected[side] = new Set(); anchors[side] = null; $(`file-${side}-path`).value = result.path; render(side); updateButtons();
    } catch (exception) { if (revision === revisions[side] && (side !== 'remote' || connection === session)) { $(`file-${side}-count`).textContent = 'Could not read folder'; $(`file-${side}-path`).value = paths[side]; throw exception; } }
    finally { if (revision === revisions[side]) { loading[side] = false; updateButtons(); } }
  }
  function renderJobs() {
    const root = $('file-transfer-jobs'); root.replaceChildren();
    for (const job of [...jobs.values()].reverse()) {
      const row = node('div', 'transfer-job'); row.dataset.transferId = job.transferId;
      const detail = node('div', 'transfer-job-detail'); const filename = (job.direction === 'upload' ? job.localPath : job.remotePath).split(/[\\/]/).pop();
      detail.append(node('strong', '', `${job.direction === 'upload' ? '↑' : '↓'} ${filename}`), node('small', '', `${String(job.protocol).toUpperCase()} · ${job.status}${job.error ? ` · ${job.error}` : ''}`));
      if (job.kind === 'folder') {
        detail.append(node('small','transfer-folder-destination',`Destination: ${job.direction === 'upload' ? job.remotePath : job.localPath}`));
        detail.append(node('small','transfer-folder-progress',`${Number(job.filesCompleted) || 0} / ${Number(job.filesTotal) || 0} files · ${Number(job.directoriesCreated) || 0} / ${Number(job.directoriesTotal) || 0} folders`));
        if (job.currentPath) detail.append(node('small','transfer-current-path',job.currentPath));
        if (['failed','cancelled'].includes(job.status)) detail.append(node('small','transfer-job-warning','Files and folders already created remain at the destination. Inspect them before starting a new copy.'));
      }
      if (job.warning) detail.append(node('small', 'transfer-job-warning', job.warning));
      const progress = node('progress'); progress.max = Number(job.total) || 1; progress.value = job.status === 'completed' ? progress.max : Number(job.bytes) || 0; progress.setAttribute('aria-label', `Transfer progress for ${filename}`); detail.append(progress);
      row.append(detail, node('span', 'transfer-job-size', `${bytes(job.bytes)}${job.total ? ` / ${bytes(job.total)}` : ''}`));
      if (busy(job.status)) { const cancel = node('button', 'quiet-button', 'Cancel'); cancel.type = 'button'; cancel.disabled = reviewOpen(); cancel.setAttribute('aria-label', `Cancel transfer ${filename}`); cancel.addEventListener('click', () => { if (reviewOpen()) return; cancel.disabled = true; attempt(() => api.transferCancel(job.transferId)).finally(updateButtons); }); row.append(cancel); }
      root.append(row);
    }
    if (!jobs.size) root.append(node('p', 'field-note', 'Select files or one folder, then choose Upload or Download. Folder copies use SFTP and open a review first. Use Command / Ctrl-click to select multiple files.'));
    $('file-clear-jobs').disabled = reviewOpen() || ![...jobs.values()].some(job => !busy(job.status));
  }
  async function start(direction) {
    const source = direction === 'upload' ? 'local' : 'remote'; const entries = selectedEntries(source); const connection = session;
    if (!connection || reviewOpen() || pendingStart || loading[source] || !entries.length) return;
    if (entries.length === 1 && entries[0].type === 'directory') { await beginFolderTransfer(direction); return; }
    if (entries.some(entry => entry.type !== 'file')) return;
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
  function folderMessage(message, error = false) {
    $('folder-transfer-status').textContent = error ? '' : message;
    $('folder-transfer-error').textContent = error ? message : ''; $('folder-transfer-error').hidden = !error;
  }
  function updateFolderTransfer() {
    const operation = folderOperation; if (!operation) return;
    const pending = Boolean(folderPending());
    $('folder-transfer-start').disabled = pending || operation.phase !== 'review' || Boolean(operation.invalidated);
    $('folder-transfer-start').textContent = operation.phase === 'starting' ? 'Waiting for confirmation…' : operation.direction === 'upload' ? 'Upload folder' : 'Download folder';
    $('folder-transfer-cancel').disabled = pending;
    $('folder-transfer-cancel').textContent = operation.invalidated || operation.phase === 'finished' ? 'Close' : 'Cancel';
    $('folder-transfer-dialog').setAttribute('aria-busy', String(pending)); updateButtons();
  }
  async function discardFolderPlan(operation) {
    clearTimeout(operation.expiryTimer); operation.expiryTimer = null;
    const planId = operation.plan?.planId; operation.plan = null;
    if (planId) { try { await api.transferDiscardFolder({planId}); } catch { /* Main-process plans also expire and release their reservation. */ } }
  }
  async function cancelFolderTransfer() {
    const operation = folderOperation; if (!operation || folderPending()) return false;
    operation.phase = 'discarding'; updateFolderTransfer(); await discardFolderPlan(operation);
    if (folderOperation !== operation) return true;
    folderOperation = null; $('folder-transfer-dialog').close(); updateButtons(); operation.trigger?.focus(); return true;
  }
  const folderStillCurrent = operation => operation.connection === session && operation.localDirectory === paths.local && operation.remoteDirectory === paths.remote && operation.localRevision === revisions.local && operation.remoteRevision === revisions.remote && !operation.invalidated;
  function showFolderReview(operation) {
    const plan = operation.plan; const fields = $('folder-transfer-fields'); fields.replaceChildren();
    const add = (label,value) => fields.append(node('dt','',label),node('dd','',String(value)));
    add('Server',`${plan.host}:${plan.port}`); add('Direction',plan.direction === 'upload' ? 'This computer → Remote server' : 'Remote server → This computer');
    add('Source folder',plan.sourceRoot); add('New destination',plan.destinationRoot);
    add('Contents',`${plan.files} files · ${plan.directories} folders (including the root) · ${bytes(plan.totalBytes)} (${Number(plan.totalBytes).toLocaleString()} bytes)`);
    const expiration = typeof plan.expiresAt === 'number' ? plan.expiresAt : Date.parse(plan.expiresAt);
    if (Number.isFinite(expiration)) add('Review expires',new Date(expiration).toLocaleTimeString());
    const tree = $('folder-transfer-entries'); tree.replaceChildren();
    for (const entry of plan.entries) {
      const row = node('li','folder-transfer-entry');
      row.append(createIcon(entry.type === 'directory' ? 'folder' : 'file'),node('span','folder-transfer-path',entry.relativePath || '(root folder)'),node('span','folder-transfer-size',entry.type === 'directory' ? 'Folder' : bytes(entry.size)));
      tree.append(row);
    }
    $('folder-transfer-review').hidden = false;
    folderMessage('Review the complete tree. The next step asks for confirmation before creating anything.');
    if (Number.isFinite(expiration)) {
      operation.expiryTimer = setTimeout(() => {
        if (folderOperation !== operation || operation.phase !== 'review') return;
        operation.invalidated = true; folderMessage('This review expired. Close it and select the folder again to inspect a fresh copy plan.',true); updateFolderTransfer(); attempt(() => discardFolderPlan(operation));
      },Math.max(0,Math.min(2147483647,expiration-Date.now())));
    }
  }
  async function beginFolderTransfer(direction) {
    const source = direction === 'upload' ? 'local' : 'remote'; const entries = selectedEntries(source);
    if (!session || reviewOpen() || pendingStart || loading.local || loading.remote || activeTransfers() || !supportsFolders() || $('file-transfer-protocol').value !== 'sftp' || entries.length !== 1 || entries[0].type !== 'directory') return;
    const operation = {connection:session,direction,localDirectory:paths.local,remoteDirectory:paths.remote,localRevision:revisions.local,remoteRevision:revisions.remote,phase:'preparing',plan:null,trigger:$(direction === 'upload' ? 'file-upload' : 'file-download')};
    folderOperation = operation;
    operation.request = {id:session.id,direction,localPath:appendPath(paths.local,entries[0].name,false),remotePath:appendPath(paths.remote,entries[0].name,true)};
    $('folder-transfer-title').textContent = direction === 'upload' ? 'Review folder upload' : 'Review folder download';
    $('folder-transfer-review').hidden = true; $('folder-transfer-fields').replaceChildren(); $('folder-transfer-entries').replaceChildren();
    folderMessage('Inspecting the folder tree and checking the destination…'); updateFolderTransfer(); $('folder-transfer-dialog').showModal();
    try {
      operation.plan = await api.transferPrepareFolder(operation.request);
      if (folderOperation !== operation || !folderStillCurrent(operation)) { await discardFolderPlan(operation); if (folderOperation === operation) { operation.invalidated = true; folderMessage('The connection or folder changed during inspection. Close this review and reconnect before copying.',true); } return; }
      operation.phase = 'review'; showFolderReview(operation);
    } catch (exception) { await discardFolderPlan(operation); if (folderOperation === operation) { operation.phase = 'finished'; folderMessage(exception?.message || String(exception),true); } }
    finally { if (folderOperation === operation) { if (operation.phase === 'preparing') operation.phase = 'finished'; updateFolderTransfer(); (operation.phase === 'review' ? $('folder-transfer-start') : $('folder-transfer-cancel')).focus(); } }
  }
  async function startFolderTransfer() {
    const operation = folderOperation;
    if (!operation || folderPending() || operation.invalidated || operation.phase !== 'review' || !operation.plan?.planId) return;
    if (!folderStillCurrent(operation)) { operation.invalidated = true; folderMessage('The connection or folder changed. Close this review and select the folder again.',true); await discardFolderPlan(operation); updateFolderTransfer(); return; }
    const plan = operation.plan; clearTimeout(operation.expiryTimer); operation.expiryTimer = null;
    operation.phase = 'starting'; folderMessage('Confirm this exact folder copy in the application dialog.'); updateFolderTransfer();
    try {
      const result = await api.transferStartFolder({planId:plan.planId}); operation.plan = null;
      if (folderOperation !== operation) return;
      if (result?.transferId && !jobs.has(result.transferId)) { jobs.set(result.transferId,{...operation.request,protocol:'sftp',kind:'folder',status:'queued',bytes:0,total:plan.totalBytes,filesTotal:plan.files,filesCompleted:0,directoriesTotal:plan.directories,directoriesCreated:0,...result}); renderJobs(); }
      if (!folderStillCurrent(operation)) { operation.invalidated = true; folderMessage(result?.transferId ? 'The copy was queued, but this connection closed. Inspect its transfer status and destination before retrying.' : 'The connection closed before copying started. Close this review and reconnect.',true); return; }
      if (result?.cancelled || result?.canceled) { operation.phase = 'finished'; folderMessage('Folder copy cancelled. No files or folders were created.'); return; }
      if (!result?.transferId) throw new Error('The folder copy did not return a transfer job. Inspect the destination before retrying.');
      renderJobs(); folderOperation = null; $('folder-transfer-dialog').close(); updateButtons(); operation.trigger?.focus(); toast('Folder copy added to Transfers.');
      // A very small or empty tree can finish before the invoke result arrives.
      if (jobs.get(result.transferId)?.status === 'completed') { const side = operation.direction === 'upload' ? 'remote' : 'local'; attempt(() => navigate(side,paths[side])); }
    } catch (exception) { await discardFolderPlan(operation); if (folderOperation === operation) { operation.phase = 'finished'; folderMessage(exception?.message || String(exception),true); } }
    finally { if (folderOperation === operation) { if (operation.phase === 'starting') operation.phase = 'finished'; updateFolderTransfer(); } updateButtons(); }
  }
  const operationTitles = {mkdir:'New remote folder',rename:'Rename remote item',delete:'Delete remote item',chmod:'Remote permissions'};
  const operationActions = {mkdir:'Create folder',rename:'Rename',delete:'Delete',chmod:'Change permissions'};
  function operationMessage(message, error = false) {
    $('remote-operation-error').hidden = !error; $('remote-operation-error').textContent = error ? message : '';
    $('remote-operation-status').textContent = error ? '' : message;
  }
  function permissionDescription() {
    const value = $('remote-operation-permissions').value;
    $('remote-permissions-preview').textContent = /^[0-7]{3}$/.test(value) ? [...value].map((digit,index) => `${['Owner','Group','Other'][index]}: ${[['read',4],['write',2],['execute',1]].filter(([,bit]) => Number(digit) & bit).map(([name]) => name).join(', ') || 'none'}`).join(' · ') : 'Enter three octal digits, for example 640.';
  }
  function updateOperation() {
    const operation = remoteOperation; if (!operation) return;
    const pending = operationPending(); const review = operation.phase === 'review';
    for (const field of ['name','permissions']) $(`remote-operation-${field}`).disabled = pending || review || Boolean(operation.invalidated);
    $('remote-operation-submit').disabled = pending || Boolean(operation.invalidated);
    $('remote-operation-submit').textContent = pending ? operation.phase === 'preparing' ? 'Inspecting…' : operation.phase === 'discarding' ? 'Releasing review…' : 'Waiting for confirmation…' : review ? operationActions[operation.operation] : 'Review';
    $('remote-operation-cancel').disabled = pending;
    $('remote-operation-cancel').textContent = operation.invalidated ? 'Close' : 'Cancel';
    $('remote-operation-edit').hidden = !review;
    $('remote-operation-edit').disabled = pending || Boolean(operation.invalidated);
    $('remote-operation-dialog').setAttribute('aria-busy', String(Boolean(pending)));
    updateButtons();
  }
  async function discardPlan(operation) {
    const planId = operation.plan?.planId; operation.plan = null;
    if (planId) { try { await api.transferDiscardRemoteOperation({planId}); } catch { /* The plan also expires in the main process. */ } }
  }
  async function cancelRemoteOperation() {
    const operation = remoteOperation; if (!operation || operationPending()) return false;
    operation.phase = 'discarding'; updateOperation(); await discardPlan(operation);
    if (remoteOperation !== operation) return true;
    remoteOperation = null; $('remote-operation-dialog').close(); updateButtons();
    operation.trigger?.focus(); return true;
  }
  function beginRemoteOperation(kind) {
    const entries = selectedEntries('remote'); const trigger = $(`file-remote-${kind}`);
    if (trigger.disabled || reviewOpen() || !session || (kind !== 'mkdir' && entries.length !== 1)) return;
    const entry = kind === 'mkdir' ? null : {...entries[0]};
    remoteOperation = {operation:kind,connection:session,directory:paths.remote,revision:revisions.remote,entry,phase:'edit',trigger,plan:null};
    $('remote-operation-title').textContent = operationTitles[kind];
    $('remote-operation-target').textContent = `${session.host}:${session.port} · ${kind === 'mkdir' ? paths.remote : appendPath(paths.remote,entry.name,true)}`;
    $('remote-operation-name-row').hidden = !['mkdir','rename'].includes(kind);
    $('remote-operation-name-label').textContent = kind === 'mkdir' ? 'Folder name' : 'New name';
    $('remote-operation-name').value = kind === 'rename' ? entry.name : '';
    $('remote-operation-permissions-row').hidden = kind !== 'chmod';
    $('remote-operation-permissions').value = kind === 'chmod' && /^[0-7]{3}$/.test(entry.permissions) ? entry.permissions : '';
    $('remote-operation-note').textContent = kind === 'delete' ? 'Delete one regular file or empty folder. This cannot be undone; links and recursive deletion are not supported.' : kind === 'chmod' ? 'Set read, write and execute permissions using three octal digits. Special permission bits are not supported.' : 'Use a single name in this folder. Existing items will not be replaced, and links cannot be changed.';
    $('remote-operation-review').hidden = true; $('remote-operation-review-fields').replaceChildren();
    operationMessage('Review inspects the server before you approve a change.'); permissionDescription(); updateOperation();
    $('remote-operation-dialog').showModal();
    (kind === 'delete' ? $('remote-operation-submit') : kind === 'chmod' ? $('remote-operation-permissions') : $('remote-operation-name')).focus();
    if (kind === 'rename') $('remote-operation-name').select();
  }
  function showOperationReview(operation) {
    const plan = operation.plan; const fields = $('remote-operation-review-fields'); fields.replaceChildren();
    const add = (label,value) => { if (value !== undefined) fields.append(node('dt','',label),node('dd','',String(value))); };
    add('Server',`${operation.connection.host}:${operation.connection.port}`);
    add('Action',operationActions[operation.operation]); add('Target',plan.path); add('Type',plan.type === 'directory' ? 'Folder' : 'Regular file');
    add('New path',plan.destination);
    if (operation.operation === 'chmod') { add('Current permissions',/^[0-7]{3}$/.test(plan.currentPermissions) ? plan.currentPermissions : 'Not available'); add('New permissions',plan.permissions); }
    $('remote-operation-review').hidden = false;
    operationMessage('Review expires after 60 seconds. The next step opens a separate confirmation before any change.');
  }
  async function submitRemoteOperation() {
    const operation = remoteOperation;
    if (!operation || operationPending() || operation.invalidated) return;
    if (operation.connection !== session || operation.directory !== paths.remote || operation.revision !== revisions.remote) { operation.invalidated = true; operationMessage('The connection or folder changed. Close this dialog and select the item again.',true); await discardPlan(operation); updateOperation(); return; }
    if (operation.phase === 'review') {
      const planId = operation.plan?.planId; if (!planId) return;
      operation.phase = 'applying'; operationMessage('Confirm this exact change in the application dialog.'); updateOperation();
      try {
        const result = await api.transferApplyRemoteOperation({planId}); operation.plan = null;
        if (remoteOperation !== operation) return;
        if (operation.connection !== session || operation.invalidated) { operation.invalidated = true; operationMessage(result?.applied ? 'The server reported the change, but this connection has closed. Reconnect to inspect its current state.' : 'The connection closed before the operation completed. Reconnect and inspect the folder before retrying.',true); return; }
        if (!result?.applied) { operation.phase = 'edit'; $('remote-operation-review').hidden = true; operationMessage('Change cancelled. No change was applied.'); return; }
        // Do not apply an old listing response to another connection or a newly selected folder.
        if (operation.directory === paths.remote && operation.revision === revisions.remote) { try { await navigate('remote',operation.directory,true); } catch (exception) { report(new Error(`Change applied, but the folder could not be refreshed: ${exception?.message || exception}`)); } }
        if (remoteOperation === operation) { remoteOperation = null; $('remote-operation-dialog').close(); toast(`${operationActions[operation.operation]} completed.`); operation.trigger?.focus(); }
      } catch (exception) {
        await discardPlan(operation);
        if (remoteOperation === operation) { operation.phase = 'edit'; $('remote-operation-review').hidden = true; operationMessage(exception?.message || String(exception),true); }
      } finally { if (remoteOperation === operation) { if (operation.phase === 'applying') operation.phase = 'edit'; updateOperation(); } updateButtons(); }
      return;
    }
    const input = {id:operation.connection.id,operation:operation.operation,path:operation.operation === 'mkdir' ? operation.directory : appendPath(operation.directory,operation.entry.name,true)};
    if (['mkdir','rename'].includes(operation.operation)) {
      const name = $('remote-operation-name').value;
      if (!name || name === '.' || name === '..' || /[\\/\x00-\x1f\x7f]/.test(name)) { operationMessage('Enter a single file or folder name without slashes or control characters.',true); $('remote-operation-name').focus(); return; }
      if (operation.operation === 'rename' && name === operation.entry.name) { operationMessage('Enter a different name.',true); $('remote-operation-name').focus(); return; }
      input.name = name;
    }
    if (operation.operation === 'chmod') {
      const permissions = $('remote-operation-permissions').value;
      if (!/^[0-7]{3}$/.test(permissions)) { operationMessage('Permissions must contain exactly three octal digits (0–7), such as 640.',true); $('remote-operation-permissions').focus(); return; }
      input.permissions = permissions;
    }
    operation.phase = 'preparing'; operationMessage('Inspecting the remote target…'); updateOperation();
    try {
      const plan = await api.transferPrepareRemoteOperation(input); operation.plan = plan;
      if (remoteOperation !== operation || operation.connection !== session || operation.invalidated) { await discardPlan(operation); if (remoteOperation === operation) { operation.invalidated = true; operationMessage('The connection closed during review. Close this dialog and reconnect.',true); } return; }
      operation.phase = 'review'; showOperationReview(operation);
    } catch (exception) { if (remoteOperation === operation) { operation.phase = 'edit'; operationMessage(exception?.message || String(exception),true); } }
    finally { if (remoteOperation === operation) { if (operation.phase === 'preparing') operation.phase = 'edit'; updateOperation(); if (operation.phase === 'review') $('remote-operation-submit').focus(); } }
  }
  async function disconnect(confirm = true) {
    if (reviewOpen()) return false;
    if (!session || closing) return true;
    const active = [...jobs.values()].filter(job => job.id === session.id && busy(job.status));
    if (confirm && active.length && !await confirmAction({title:'Stop file transfers?',message:`Disconnecting will cancel ${active.length} active transfer${active.length === 1 ? '' : 's'}. Completed files remain available.`,accept:'Stop and disconnect'})) return false;
    closing = true; updateButtons(); const connection = session;
    try { await api.transferClose(connection.id); if (session === connection) { session = null; revisions.remote++; loading.remote = false; listings.remote = []; selected.remote = new Set(); anchors.remote = null; profileKey = ''; $('file-remote-entries').replaceChildren(node('p','file-empty','Connect to a server to browse files.')); } return true; }
    finally { closing = false; updateButtons(); }
  }
  async function open(profile) {
    if (connecting || operationPending() || folderPending()) return;
    if (remoteOperation) await cancelRemoteOperation();
    if (folderOperation) await cancelFolderTransfer();
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
    const wrapper = node('div'); wrapper.innerHTML = `<dialog id="file-transfer-dialog" class="modal file-transfer-modal"><header class="modal-header"><div><span class="secure-eyebrow">FILES</span><h2 id="file-transfer-title">File transfer</h2></div><button id="file-transfer-hide" class="icon-button" type="button" aria-label="Hide file transfers">×</button></header><div class="file-transfer-toolbar"><span id="file-transfer-status" role="status">Disconnected</span><label>Copy protocol<select id="file-transfer-protocol"><option value="sftp">SFTP</option><option value="scp">SCP</option></select></label><button type="button" id="file-transfer-disconnect" class="quiet-button">Disconnect</button></div><div id="file-transfer-error" class="form-error" role="alert" hidden></div><div class="file-panes">${['local','remote'].map(side => `<section class="file-pane" aria-label="${side === 'local' ? 'Local files' : 'Remote files'}"><header><h3>${side === 'local' ? 'This computer' : 'Remote server'}</h3><span id="file-${side}-count"></span></header><form id="file-${side}-form" class="file-path-bar"><button type="button" id="file-${side}-up" class="icon-button" aria-label="${side === 'local' ? 'Local' : 'Remote'} parent folder">↑</button><input id="file-${side}-path" aria-label="${side === 'local' ? 'Local' : 'Remote'} folder path" autocomplete="off" spellcheck="false"><button type="submit" class="icon-button" aria-label="Refresh ${side} folder">↻</button>${side === 'local' ? '<button type="button" id="file-choose-local" class="quiet-button">Browse…</button>' : ''}</form><div class="file-table" role="table" aria-label="${side === 'local' ? 'Local' : 'Remote'} file list"><div class="file-table-heading" role="row"><span role="columnheader">Name</span><span role="columnheader">Size / type</span></div><div id="file-${side}-entries" role="rowgroup"></div></div><footer><button type="button" id="${side === 'local' ? 'file-upload' : 'file-download'}" class="primary-button" disabled>${side === 'local' ? 'Upload →' : '← Download'}</button></footer></section>`).join('')}</div><section class="transfer-queue"><header><h3>Transfers</h3><button type="button" id="file-clear-jobs" class="quiet-button">Clear finished</button></header><div id="file-transfer-jobs"></div></section><footer class="modal-footer"><p class="field-note">Copy selected files with SFTP or SCP, or select one folder for a reviewed SFTP copy. Folder destinations must be new; links, merging and resuming are not supported.</p><button type="button" id="file-transfer-done" class="secondary-button">Hide</button></footer></dialog>`; document.body.append(wrapper);
    const remoteToolbar = node('div','remote-file-actions'); remoteToolbar.setAttribute('role','group'); remoteToolbar.setAttribute('aria-label','Remote file actions');
    for (const [kind,label] of [['mkdir','New folder'],['rename','Rename'],['delete','Delete'],['chmod','Permissions']]) { const button = node('button','quiet-button',label); button.id = `file-remote-${kind}`; button.type = 'button'; button.disabled = true; button.addEventListener('click',() => beginRemoteOperation(kind)); remoteToolbar.append(button); }
    $('file-remote-form').after(remoteToolbar);
    const permissionsHeading = node('span','','Permissions'); permissionsHeading.setAttribute('role','columnheader'); $('file-remote-entries').previousElementSibling.append(permissionsHeading); $('file-remote-entries').parentElement.classList.add('remote-file-table');
    const operationDialog = node('dialog','modal remote-operation-modal'); operationDialog.id = 'remote-operation-dialog'; operationDialog.setAttribute('aria-labelledby','remote-operation-title'); operationDialog.setAttribute('aria-describedby','remote-operation-note');
    operationDialog.innerHTML = `<form id="remote-operation-form"><header class="modal-header"><h2 id="remote-operation-title">Remote file operation</h2></header><div class="modal-body remote-operation-body"><p id="remote-operation-target" class="remote-operation-target"></p><p id="remote-operation-note" class="field-note"></p><label id="remote-operation-name-row"><span id="remote-operation-name-label">Name</span><input id="remote-operation-name" autocomplete="off" spellcheck="false" maxlength="255"></label><label id="remote-operation-permissions-row">Permissions (octal)<input id="remote-operation-permissions" inputmode="numeric" autocomplete="off" spellcheck="false" maxlength="3" aria-describedby="remote-permissions-preview"><span id="remote-permissions-preview" class="field-note"></span></label><section id="remote-operation-review" class="remote-operation-review" aria-label="Review remote change" hidden><h3>Review change</h3><dl id="remote-operation-review-fields"></dl></section><p id="remote-operation-status" class="field-note" role="status" aria-live="polite"></p><div id="remote-operation-error" class="form-error" role="alert" hidden></div></div><footer class="modal-footer"><button id="remote-operation-edit" type="button" class="quiet-button" hidden>Edit</button><span class="remote-operation-spacer"></span><button id="remote-operation-cancel" type="button" class="secondary-button">Cancel</button><button id="remote-operation-submit" type="submit" class="primary-button">Review</button></footer></form>`;
    document.body.append(operationDialog);
    const folderDialog = node('dialog','modal folder-transfer-modal'); folderDialog.id = 'folder-transfer-dialog'; folderDialog.setAttribute('aria-labelledby','folder-transfer-title'); folderDialog.setAttribute('aria-describedby','folder-transfer-note');
    folderDialog.innerHTML = `<form id="folder-transfer-form"><header class="modal-header"><h2 id="folder-transfer-title">Review folder copy</h2></header><div class="modal-body folder-transfer-body"><p id="folder-transfer-note" class="secure-notice">The destination folder must be new. Existing folders are never merged or replaced. If copying fails or is cancelled, files and folders already created remain at the destination.</p><section id="folder-transfer-review" hidden><dl id="folder-transfer-fields"></dl><h3>Folder contents</h3><ul id="folder-transfer-entries" aria-label="Planned folder contents"></ul></section><p class="field-note">SFTP only · Up to 2,000 entries, 32 levels and 1 TiB per folder copy. Links and special files are refused. Copying does not delete the source.</p><p id="folder-transfer-status" class="field-note" role="status" aria-live="polite"></p><div id="folder-transfer-error" class="form-error" role="alert" hidden></div></div><footer class="modal-footer"><button id="folder-transfer-cancel" type="button" class="secondary-button">Cancel</button><button id="folder-transfer-start" type="submit" class="primary-button" disabled>Start copy</button></footer></form>`;
    document.body.append(folderDialog);
    $('folder-transfer-form').addEventListener('submit',event => { event.preventDefault(); attempt(startFolderTransfer); });
    $('folder-transfer-cancel').addEventListener('click',() => attempt(cancelFolderTransfer));
    folderDialog.addEventListener('cancel',event => { event.preventDefault(); attempt(cancelFolderTransfer); });
    folderDialog.addEventListener('click',event => { if (event.target !== folderDialog) return; const rect = folderDialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) { event.stopImmediatePropagation(); attempt(cancelFolderTransfer); } });
    folderDialog.addEventListener('keydown',event => { if (event.key !== 'Tab') return; const controls = [...folderDialog.querySelectorAll('button')].filter(element => !element.disabled && !element.closest('[hidden]')); const first = controls[0]; const last = controls.at(-1); if (!first) { event.preventDefault(); return; } if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); } });
    $('remote-operation-form').addEventListener('submit',event => { event.preventDefault(); attempt(submitRemoteOperation); });
    $('remote-operation-permissions').addEventListener('input',permissionDescription);
    $('remote-operation-cancel').addEventListener('click',() => attempt(cancelRemoteOperation));
    $('remote-operation-edit').addEventListener('click',() => attempt(async () => { const operation = remoteOperation; if (!operation || operationPending() || operation.invalidated) return; operation.phase = 'discarding'; updateOperation(); await discardPlan(operation); if (remoteOperation !== operation) return; operation.phase = 'edit'; $('remote-operation-review').hidden = true; operationMessage('Edit the values, then review the target again.'); updateOperation(); (operation.operation === 'chmod' ? $('remote-operation-permissions') : operation.operation === 'delete' ? $('remote-operation-submit') : $('remote-operation-name')).focus(); }));
    operationDialog.addEventListener('cancel',event => { event.preventDefault(); attempt(cancelRemoteOperation); });
    operationDialog.addEventListener('keydown',event => { if (event.key !== 'Tab') return; const controls = [...operationDialog.querySelectorAll('button,input')].filter(element => !element.disabled && !element.closest('[hidden]')); const first = controls[0]; const last = controls.at(-1); if (!first) { event.preventDefault(); return; } if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); } });
    operationDialog.addEventListener('click',event => { if (event.target !== operationDialog) return; const rect = operationDialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) { event.stopImmediatePropagation(); attempt(cancelRemoteOperation); } });
    $('file-transfer-dialog').addEventListener('cancel',event => { if (reviewOpen()) event.preventDefault(); });
    $('file-transfer-dialog').addEventListener('click',event => { if (reviewOpen() && event.target === $('file-transfer-dialog')) event.stopImmediatePropagation(); });
    for (const side of ['local','remote']) { $(`file-${side}-form`).addEventListener('submit', event => { event.preventDefault(); attempt(() => navigate(side, $(`file-${side}-path`).value)); }); $(`file-${side}-up`).addEventListener('click', () => attempt(() => navigate(side,parentPath(paths[side],side === 'remote')))); }
    $('file-choose-local').addEventListener('click', () => attempt(async () => { const chosen = await api.transferChooseLocal(); if (chosen?.path) await navigate('local',chosen.path); }));
    $('file-upload').addEventListener('click', () => attempt(() => start('upload'))); $('file-download').addEventListener('click', () => attempt(() => start('download')));
    $('file-transfer-protocol').addEventListener('change', updateButtons);
    $('file-transfer-disconnect').addEventListener('click', () => attempt(() => disconnect()));
    for (const id of ['file-transfer-hide','file-transfer-done']) $(id).addEventListener('click', () => { if (!reviewOpen()) $('file-transfer-dialog').close(); });
    $('file-clear-jobs').addEventListener('click', () => { if (reviewOpen()) return; for (const [id, job] of jobs) if (!busy(job.status)) jobs.delete(id); renderJobs(); });
    api?.onTransferEvent?.(event => {
      if (event?.type === 'connection' && event.status === 'closed') {
        if (session?.id === event.id) {
          session = null; profileKey = ''; revisions.remote++; loading.remote = false; selected.remote = new Set(); anchors.remote = null; listings.remote = [];
          if (remoteOperation) { const operation = remoteOperation; operation.invalidated = true; operationMessage('The connection closed. Close this dialog and reconnect before making a change.',true); if (!operationPending()) attempt(() => discardPlan(operation)); updateOperation(); }
          if (folderOperation) { const operation = folderOperation; operation.invalidated = true; folderMessage('The connection closed. Close this review and reconnect before copying.',true); if (!folderPending()) attempt(() => discardFolderPlan(operation)); updateFolderTransfer(); }
          $('file-remote-entries').replaceChildren(node('p', 'file-empty', 'Connection closed. Reconnect to browse remote files.'));
          $('file-remote-count').textContent = 'Disconnected'; updateButtons();
        }
        return;
      }
      if (!event?.transferId) return;
      const previous = jobs.get(event.transferId); jobs.set(event.transferId, {...previous,...event}); renderJobs(); updateButtons();
      if (event.status === 'completed' && previous?.status !== 'completed' && session?.id === event.id) attempt(() => navigate(event.direction === 'upload' ? 'remote' : 'local',paths[event.direction === 'upload' ? 'remote' : 'local']));
    });
    renderJobs(); updateButtons();
  }
  return { install, open, show() { if (!$('file-transfer-dialog').open) $('file-transfer-dialog').showModal(); }, connected: () => Boolean(session) };
}
