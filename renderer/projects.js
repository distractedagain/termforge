import './projects.css';
import { monaco, editorOptions, documentLanguage, watchYaml, applyEditorTheme } from './project-editor.js';

const TEXT_LIMIT = 2 * 1024 * 1024;
const make = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const messageOf = (error) => String(error?.message || error || 'The project operation failed.').slice(0, 2000);
const button = (label, action, className = 'secondary-button') => {
  const node = make('button', className, label);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
};

export function createProjectUi({ api, toast, confirmAction, getSettings = () => ({}), onLayout = () => {}, requestAiEdit }) {
  let installed = false;
  let panel, workspace, desktop, editor, diffEditor;
  let project = null;
  let epoch = 0;
  let activePath = null;
  let review = null;
  let choosing = false;
  let preparing = false;
  let run = null;
  let starting = false;
  let pendingEvents = [];
  let feedCount = 0;
  let outputCount = 0;
  let dirtyReported = null;
  let platformConfigured = false;
  let lastDiffSide = 'modified';
  let treeEpoch = 0;
  let inspectorEpoch = 0;
  const documents = new Map();
  const expanded = new Set(['']);
  const tree = new Map();
  const refs = {};
  const get = (id) => refs[id] || (refs[id] = document.getElementById(id));
  const activeDocument = () => documents.get(activePath) || null;
  const hasDirty = () => [...documents.values()].some((doc) => doc.dirty);
  const hasPendingSave = () => [...documents.values()].some((doc) => doc.saving);
  const sameProject = (id, atEpoch) => project?.id === id && epoch === atEpoch;
  const running = () => run && !['successful', 'failed', 'cancelled'].includes(run.status);

  function reportError(error) {
    get('project-error-text').textContent = messageOf(error);
    get('project-error').hidden = false;
  }
  function clearError() { get('project-error').hidden = true; }

  function notifyDirty() {
    if (!project) return;
    const dirty = hasDirty();
    if (dirtyReported === dirty) return;
    dirtyReported = dirty;
    Promise.resolve(api.projectSetDirty?.({ projectId: project.id, dirty })).catch((error) => {
      dirtyReported = null;
      toast(`Could not update the unsaved-file warning: ${messageOf(error)}`, true);
    });
  }

  function updateControls() {
    if (!installed) return;
    const doc = activeDocument();
    get('project-name').textContent = project?.name || 'Project workspace';
    get('project-name').title = project?.root || '';
    get('project-root-label').textContent = project?.root || 'Open a folder to edit configuration and automation files.';
    get('project-open-folder').disabled = choosing || hasPendingSave() || Boolean(running()) || preparing;
    get('project-close-folder').disabled = !project || choosing || hasPendingSave() || Boolean(running()) || preparing;
    get('project-new-file').disabled = !project || preparing;
    get('project-save').disabled = !doc || !doc.dirty || doc.saving || Boolean(review) || preparing || Boolean(running());
    get('project-ai-edit').disabled = !doc || !requestAiEdit || Boolean(review);
    get('project-history').disabled = !doc || doc.revision === null || Boolean(review);
    get('project-git').disabled = !project;
    get('project-refresh').disabled = !project;
    get('project-reload').disabled = !doc || doc.revision === null || doc.saving;
    get('project-empty').hidden = Boolean(doc);
    get('project-editor').hidden = !doc || Boolean(review);
    get('project-review').hidden = !review;
    get('project-review-apply').disabled = Boolean(doc?.saving) || Boolean(review?.kind === 'backup' && (preparing || running()));
    get('project-document-path').textContent = doc?.path || 'No file open';
    get('project-language').textContent = doc ? `${documentLanguage(doc.path).toUpperCase()} · ${doc.saving ? 'Saving…' : doc.dirty ? 'Unsaved changes' : 'Saved'}` : 'Local files';
    get('project-diagnostics').textContent = doc?.diagnostics || 'No code runs when you open a project.';
    get('ansible-prepare').disabled = !project || preparing || Boolean(running());
    get('ansible-probe').disabled = preparing || Boolean(running());
    get('ansible-cancel').hidden = !running();
    get('ansible-cancel').disabled = Boolean(run?.cancelling);
    for (const id of ['ansible-controller', 'ansible-python', 'ansible-playbook', 'ansible-inventory', 'ansible-limit', 'ansible-mode', 'ansible-trust']) get(id).disabled = preparing || Boolean(running());
    notifyDirty();
  }

  function renderTabs() {
    const tabs = get('project-tabs');
    tabs.replaceChildren();
    for (const doc of documents.values()) {
      const tab = make('div', `project-file-tab${doc.path === activePath ? ' selected' : ''}`);
      const select = button(`${doc.path.split('/').pop()}${doc.dirty ? ' ●' : ''}`, () => selectDocument(doc.path), 'project-tab-select');
      select.setAttribute('role', 'tab');
      select.setAttribute('aria-selected', String(doc.path === activePath));
      select.setAttribute('aria-label', `${doc.path}${doc.dirty ? ', unsaved changes' : ''}`);
      select.title = doc.path;
      select.dataset.path = doc.path;
      const close = button('×', () => void closeDocument(doc.path), 'project-tab-close');
      close.setAttribute('aria-label', `Close ${doc.path}`);
      tab.append(select, close);
      tabs.append(tab);
    }
    updateControls();
  }

  function disposeReview() {
    if (!review) return;
    diffEditor?.setModel(null);
    review.original.dispose();
    review.modified.dispose();
    review = null;
    updateControls();
  }

  function selectDocument(path) {
    const doc = documents.get(path);
    if (!doc) return;
    const current = activeDocument();
    if (current && editor) current.viewState = editor.saveViewState();
    disposeReview();
    activePath = path;
    ensureEditor();
    editor.setModel(doc.model);
    if (doc.viewState) editor.restoreViewState(doc.viewState);
    renderTabs();
    renderTree();
    requestAnimationFrame(() => { editor.layout(); editor.focus(); });
  }

  function addDocument(path, text, revision) {
    const model = monaco.editor.createModel(text, documentLanguage(path), monaco.Uri.from({ scheme: 'termforge-project', authority: project.id, path: `/${path}` }));
    const doc = { path, model, revision, savedText: text, dirty: revision === null, saving: false, diagnostics: '' };
    doc.listener = model.onDidChangeContent(() => {
      doc.dirty = doc.revision === null || model.getValue() !== doc.savedText;
      renderTabs();
    });
    doc.validator = watchYaml(model, (message) => { doc.diagnostics = message; if (activePath === path) updateControls(); });
    documents.set(path, doc);
    selectDocument(path);
    return doc;
  }

  async function readFile(path) {
    if (!project) return;
    if (documents.has(path)) { selectDocument(path); return; }
    const id = project.id, atEpoch = epoch;
    clearError();
    try {
      const result = await api.projectRead({ projectId: id, path });
      if (!sameProject(id, atEpoch)) return;
      if (documents.has(path)) { selectDocument(path); return; }
      addDocument(result.path || path, result.text, result.revision);
    } catch (error) { if (sameProject(id, atEpoch)) reportError(error); }
  }

  async function loadDirectory(path = '') {
    if (!project) return;
    const id = project.id, atEpoch = epoch;
    const requestEpoch = treeEpoch;
    try {
      const result = await api.projectList({ projectId: id, path });
      if (!sameProject(id, atEpoch) || requestEpoch !== treeEpoch) return;
      tree.set(path, Array.isArray(result) ? result : result.entries || []);
      renderTree();
    } catch (error) { if (sameProject(id, atEpoch) && requestEpoch === treeEpoch) reportError(error); }
  }

  function renderTree() {
    const host = get('project-files');
    host.replaceChildren();
    if (!project) { host.append(make('p', 'project-explorer-empty', 'Your folder stays on this computer.')); return; }
    function append(path, depth) {
      for (const entry of tree.get(path) || []) {
        const directory = entry.type === 'directory';
        const row = button('', async () => {
          if (!directory) { await readFile(entry.path); return; }
          if (expanded.has(entry.path)) expanded.delete(entry.path);
          else { expanded.add(entry.path); if (!tree.has(entry.path)) await loadDirectory(entry.path); }
          renderTree();
        }, `project-tree-row${entry.path === activePath ? ' selected' : ''}`);
        row.style.paddingLeft = `${10 + depth * 14}px`;
        row.setAttribute('role', 'treeitem');
        row.setAttribute('aria-level', String(depth + 1));
        row.setAttribute('aria-label', entry.path);
        row.dataset.path = entry.path;
        if (directory) row.setAttribute('aria-expanded', String(expanded.has(entry.path)));
        else row.setAttribute('aria-selected', String(entry.path === activePath));
        row.append(make('span', 'project-file-glyph', directory ? expanded.has(entry.path) ? '▾' : '▸' : '◇'), make('span', 'project-file-name', entry.name));
        row.title = entry.path;
        host.append(row);
        if (directory && expanded.has(entry.path)) append(entry.path, depth + 1);
      }
    }
    append('', 0);
    if (!host.children.length) host.append(make('p', 'project-explorer-empty', 'No visible files. Use New file to begin.'));
  }

  async function refreshFiles() {
    ++treeEpoch;
    tree.clear();
    await loadDirectory('');
    for (const path of [...expanded].filter(Boolean)) await loadDirectory(path);
  }

  async function canDiscard(title) {
    if (hasPendingSave()) { reportError('Wait for the current save before changing projects.'); return false; }
    if (!hasDirty()) return true;
    return confirmAction({ title, message: 'These editor buffers have unsaved changes. Save them first, or discard the changes to continue.', targets: [...documents.values()].filter((doc) => doc.dirty).map((doc) => doc.path), accept: 'Discard changes' });
  }

  async function releaseProject() {
    if (!project) return;
    const old = project;
    ++epoch; ++treeEpoch; ++inspectorEpoch;
    disposeReview();
    editor?.setModel(null);
    for (const doc of documents.values()) { doc.listener.dispose(); doc.validator.dispose(); doc.model.dispose(); }
    documents.clear(); tree.clear(); expanded.clear(); expanded.add('');
    activePath = null;
    project = null;
    dirtyReported = null;
    get('ansible-trust').checked = false;
    get('ansible-playbook').value = '';
    get('ansible-inventory').value = '';
    for (const id of ['project-new-dialog', 'project-inspector-dialog']) if (get(id).open) get(id).close();
    renderTabs(); renderTree();
    await api.projectSetDirty?.({ projectId: old.id, dirty: false });
    await api.projectClose({ projectId: old.id });
  }

  async function chooseProject() {
    install(); open();
    if (choosing || preparing || running() || hasPendingSave()) return;
    choosing = true;
    updateControls();
    try {
      const selected = await api.projectOpen();
      if (!selected) return;
      if (selected.id === project?.id) return;
      // Recheck after the native chooser; editing may have continued meanwhile.
      if (hasDirty() && !await canDiscard('Open another project?')) { await api.projectClose({ projectId: selected.id }); return; }
      await releaseProject();
      project = selected;
      ++epoch;
      get('ansible-status').textContent = 'Ready. Review and trust this project before running Ansible.';
      clearError(); renderTabs(); renderTree();
      await loadDirectory('');
    } catch (error) { reportError(error); }
    finally { choosing = false; updateControls(); }
  }

  async function closeProject() {
    if (!project || choosing || running() || preparing) return false;
    if (!await canDiscard('Close project?')) return false;
    try { await releaseProject(); clearError(); return true; }
    catch (error) { reportError(error); return false; }
  }

  async function saveDocument(doc = activeDocument()) {
    if (!doc || !project || doc.saving || !doc.dirty) return false;
    if (preparing || running()) { reportError('Wait for the Ansible review or run to finish before saving. Your editor changes are retained.'); return false; }
    const id = project.id, atEpoch = epoch, text = doc.model.getValue(), revision = doc.revision;
    doc.saving = true;
    clearError(); updateControls();
    try {
      const result = await api.projectSave({ projectId: id, path: doc.path, text, revision });
      if (!sameProject(id, atEpoch) || documents.get(doc.path) !== doc) return false;
      doc.revision = result.revision;
      doc.savedText = text;
      doc.dirty = doc.model.getValue() !== text;
      toast(`Saved ${doc.path}`);
      await loadDirectory(doc.path.includes('/') ? doc.path.slice(0, doc.path.lastIndexOf('/')) : '');
      return true;
    } catch (error) {
      if (sameProject(id, atEpoch)) reportError(`${messageOf(error)} Your editor text is still here. Reload from disk to review or discard it; existing files are never silently overwritten.`);
      return false;
    } finally {
      doc.saving = false;
      if (sameProject(id, atEpoch)) renderTabs();
    }
  }

  async function reloadDocument() {
    const doc = activeDocument();
    if (!doc || !project || doc.revision === null || doc.saving) return;
    const id = project.id, atEpoch = epoch, before = doc.model.getValue();
    try {
      const result = await api.projectRead({ projectId: id, path: doc.path });
      if (!sameProject(id, atEpoch) || activeDocument() !== doc || doc.model.getValue() !== before) return;
      showReview({ title: 'Review disk version', description: 'Review changes from your editor buffer to the current file on disk. Reload replaces this buffer and its undo history.', text: result.text, baseText: before, revision: doc.revision, projectId: id, path: doc.path, kind: 'reload', diskRevision: result.revision });
    } catch (error) { if (sameProject(id, atEpoch)) reportError(error); }
  }

  async function closeDocument(path) {
    const doc = documents.get(path);
    if (!doc || doc.saving) return false;
    const id = project?.id, atEpoch = epoch;
    if (doc.dirty && !await confirmAction({ title: 'Discard unsaved changes?', message: `Close ${path} and discard its editor changes? Use Save first to keep them.`, accept: 'Discard changes' })) return false;
    if (!sameProject(id, atEpoch) || documents.get(path) !== doc) return false;
    if (activePath === path) { disposeReview(); editor?.setModel(null); activePath = null; }
    doc.listener.dispose(); doc.validator.dispose(); doc.model.dispose(); documents.delete(path);
    if (!activePath && documents.size) selectDocument([...documents.keys()].at(-1));
    renderTabs(); renderTree();
    return true;
  }

  function showNewFile() {
    if (!project) return;
    get('project-new-path').value = '';
    get('project-new-error').textContent = '';
    get('project-new-dialog').showModal();
    get('project-new-path').focus();
  }

  function newFile(event) {
    event.preventDefault();
    const path = get('project-new-path').value.trim();
    if (!project || !path || path.startsWith('/') || path.includes('\\') || path.split('/').some((part) => !part || part === '.' || part === '..' || part === '.git') || /[\x00-\x1f]/.test(path)) {
      get('project-new-error').textContent = 'Enter a relative file path inside this folder, without . or .. segments.'; return;
    }
    if (documents.has(path)) { get('project-new-error').textContent = 'That file is already open.'; return; }
    get('project-new-dialog').close();
    addDocument(path, '', null);
  }

  function getActiveDocument() {
    const doc = activeDocument();
    if (!doc || !project) return null;
    const text = doc.model.getValue();
    return { projectId: project.id, path: doc.path, text, baseText: text, revision: doc.revision, language: documentLanguage(doc.path) };
  }

  function showReview(candidate) {
    const current = getActiveDocument();
    if (!current || current.projectId !== candidate.projectId || current.path !== candidate.path || current.text !== candidate.baseText || current.revision !== candidate.revision) throw new Error('The target file changed. Capture it again before reviewing this edit.');
    if (typeof candidate.text !== 'string' || candidate.text.length > TEXT_LIMIT || candidate.text.includes('\0')) throw new Error('The proposed file must be text no larger than 2 MiB.');
    disposeReview();
    review = { ...candidate, original: monaco.editor.createModel(current.text, current.language), modified: monaco.editor.createModel(candidate.text, current.language) };
    if (!diffEditor) {
      diffEditor = monaco.editor.createDiffEditor(get('project-diff-editor'), { ...editorOptions, readOnly: true, originalEditable: false, renderSideBySide: window.innerWidth > 1000, enableSplitViewResizing: true, ariaLabel: 'Review file changes' });
      diffEditor.getOriginalEditor().onDidFocusEditorText(() => { lastDiffSide = 'original'; });
      diffEditor.getModifiedEditor().onDidFocusEditorText(() => { lastDiffSide = 'modified'; });
    }
    diffEditor.setModel({ original: review.original, modified: review.modified });
    get('project-review-title').textContent = candidate.title || `Review AI edit · ${current.path}`;
    get('project-review').dataset.path = current.path;
    get('project-review-description').textContent = candidate.description || 'Review the proposed changes to your current buffer. Apply them to the editor, then save when ready.';
    get('project-review-apply').textContent = candidate.kind === 'backup' ? 'Restore and save' : candidate.kind === 'reload' ? 'Reload from disk' : 'Apply to editor';
    updateControls();
    requestAnimationFrame(() => diffEditor.layout());
  }

  function reviewAiEdit(candidate) {
    open();
    showReview({ ...candidate, kind: 'ai' });
    return true;
  }

  async function applyReview() {
    const candidate = review, doc = activeDocument(), current = getActiveDocument();
    if (!candidate || !doc || !current) return;
    if (candidate.kind === 'backup' && (preparing || running())) { reportError('Wait for the Ansible review or run to finish before restoring a backup.'); return; }
    if (current.projectId !== candidate.projectId || current.path !== candidate.path || current.text !== candidate.baseText || current.revision !== candidate.revision || doc.saving) {
      reportError('The file changed while this review was open. Dismiss it and create a fresh review.'); return;
    }
    const text = candidate.text;
    if (candidate.kind === 'reload') {
      doc.model.setValue(text); doc.savedText = text; doc.revision = candidate.diskRevision; doc.dirty = false;
    } else {
      editor.pushUndoStop();
      editor.executeEdits('termforge-reviewed-edit', [{ range: doc.model.getFullModelRange(), text, forceMoveMarkers: true }]);
      editor.pushUndoStop();
    }
    disposeReview(); renderTabs(); editor.focus();
    if (candidate.kind === 'backup') await saveDocument(doc);
  }

  function openInspector(title) {
    const dialog = get('project-inspector-dialog');
    get('project-inspector-title').textContent = title;
    get('project-inspector-list').replaceChildren();
    get('project-inspector-detail').textContent = 'Loading…';
    if (!dialog.open) dialog.showModal();
  }

  async function showGit() {
    if (!project) return;
    const id = project.id, atEpoch = epoch, ticket = ++inspectorEpoch;
    openInspector('Git changes');
    try {
      const result = await api.projectGitStatus({ projectId: id });
      if (!sameProject(id, atEpoch) || ticket !== inspectorEpoch) return;
      get('project-inspector-title').textContent = result.available ? `Git changes · ${result.branch || 'detached HEAD'}` : 'Git unavailable';
      get('project-inspector-detail').textContent = result.available ? result.entries?.length ? 'Choose a changed file to view its diff. Git commands are read-only; no commit, checkout or repository hooks run here.' : 'Working tree is clean.' : result.reason || 'This folder is not an available Git repository.';
      for (const entry of result.entries || []) {
        const row = button(`${entry.status}  ${entry.path}`, async () => {
          const rowTicket = ++inspectorEpoch;
          get('project-inspector-detail').textContent = 'Loading diff…';
          try {
            const diff = await api.projectGitDiff({ projectId: id, path: entry.path });
            if (sameProject(id, atEpoch) && rowTicket === inspectorEpoch) get('project-inspector-detail').textContent = diff.diff || 'No textual diff available for this file.';
          } catch (error) { if (sameProject(id, atEpoch) && rowTicket === inspectorEpoch) get('project-inspector-detail').textContent = messageOf(error); }
        }, 'project-inspector-item');
        get('project-inspector-list').append(row);
      }
    } catch (error) { if (sameProject(id, atEpoch) && ticket === inspectorEpoch) get('project-inspector-detail').textContent = messageOf(error); }
  }

  async function showBackups() {
    const doc = activeDocument();
    if (!project || !doc) return;
    const id = project.id, atEpoch = epoch, ticket = ++inspectorEpoch;
    openInspector(`History · ${doc.path}`);
    try {
      const result = await api.projectListBackups({ projectId: id, path: doc.path });
      if (!sameProject(id, atEpoch) || ticket !== inspectorEpoch) return;
      const backups = Array.isArray(result) ? result : result.backups || [];
      get('project-inspector-detail').textContent = backups.length ? 'Choose a backup to compare with your editor. Restoring requires a diff review and an ordinary conflict-checked save.' : 'No backups yet. Saving an existing file creates a backup of its previous contents.';
      for (const backup of backups) {
        const date = new Date(backup.createdAt);
        const row = button(Number.isNaN(date.getTime()) ? String(backup.createdAt || backup.id) : date.toLocaleString(), async () => {
          const snapshot = getActiveDocument();
          if (!snapshot || snapshot.projectId !== id || snapshot.path !== doc.path) return;
          const rowTicket = ++inspectorEpoch;
          try {
            const result = await api.projectReadBackup({ projectId: id, path: doc.path, backupId: backup.id });
            if (!sameProject(id, atEpoch) || rowTicket !== inspectorEpoch) return;
            showReview({ ...snapshot, text: result.text, kind: 'backup', title: `Restore backup · ${doc.path}`, description: 'Review changes from your current buffer to the saved backup. Restore and save stops if the file changed externally.' });
            get('project-inspector-dialog').close();
          } catch (error) { if (sameProject(id, atEpoch)) get('project-inspector-detail').textContent = messageOf(error); }
        }, 'project-inspector-item');
        get('project-inspector-list').append(row);
      }
    } catch (error) { if (sameProject(id, atEpoch) && ticket === inspectorEpoch) get('project-inspector-detail').textContent = messageOf(error); }
  }

  function controllerFields() {
    return { controller: get('ansible-controller').value, python: get('ansible-python').value.trim() || undefined };
  }

  async function probeAnsible() {
    const fields = controllerFields();
    get('ansible-probe').disabled = true;
    get('ansible-status').textContent = 'Checking the selected controller…';
    try {
      const result = await api.ansibleProbe(fields);
      if (JSON.stringify(fields) !== JSON.stringify(controllerFields())) return;
      get('ansible-status').textContent = result.available ? `Ready · Ansible ${result.ansibleVersion || ''} · runner ${result.runnerVersion || ''} · ${result.python || fields.controller}` : `${result.error || 'Ansible Runner is not available.'} ${result.hint || 'Install Ansible and ansible-runner in the selected controller environment.'}`;
    } catch (error) { get('ansible-status').textContent = messageOf(error); }
    finally { updateControls(); }
  }

  function ansibleFields() {
    return { projectId: project?.id, ...controllerFields(), playbook: get('ansible-playbook').value.trim(), inventory: get('ansible-inventory').value.trim(), limit: get('ansible-limit').value.trim(), mode: get('ansible-mode').value, trusted: get('ansible-trust').checked };
  }

  async function prepareAnsible() {
    if (!project || preparing || running()) return;
    if (hasDirty() || hasPendingSave()) { reportError('Save all open files before preparing an Ansible run. The runner uses files on disk.'); return; }
    const fields = ansibleFields(), id = project.id, atEpoch = epoch;
    if (!fields.trusted) { get('ansible-status').textContent = 'Review the project and enable the trust checkbox before preparing any Ansible operation.'; get('ansible-trust').focus(); return; }
    if (!fields.playbook || !fields.inventory) { get('ansible-status').textContent = 'Enter project-relative playbook and inventory paths.'; return; }
    preparing = true; updateControls(); clearError();
    get('ansible-status').textContent = 'Preparing a review of the saved project…';
    try {
      const plan = await api.ansiblePrepare(fields);
      if (!sameProject(id, atEpoch)) return;
      const accepted = await confirmAction({
        title: fields.mode === 'run' ? 'Run Ansible playbook?' : fields.mode === 'check' ? 'Run Ansible in check mode?' : 'Check Ansible syntax?',
        message: `${plan.summary || 'Review this Ansible operation.'}\n${(plan.warnings || []).join('\n')}\nCheck mode is not a guarantee of no changes. Cancellation stops the controller; it does not roll back changes.`,
        preview: plan.command,
        targets: [`Project: ${project.name}`, `Controller: ${fields.controller}`, `Playbook: ${fields.playbook}`, `Inventory: ${fields.inventory}`, `Limit: ${fields.limit || '(all matched hosts)'}`],
        accept: fields.mode === 'run' ? 'Run playbook' : 'Run check', eyebrow: 'ANSIBLE EXECUTION REVIEW'
      });
      if (!accepted) { get('ansible-status').textContent = 'Run review cancelled. Nothing was started.'; return; }
      if (!sameProject(id, atEpoch) || hasDirty() || hasPendingSave() || JSON.stringify(fields) !== JSON.stringify(ansibleFields())) throw new Error('The project or run inputs changed during review. Prepare a fresh run.');
      get('ansible-events').replaceChildren(); feedCount = 0; outputCount = 0;
      pendingEvents = []; starting = true; run = null;
      const result = await api.ansibleStart({ planId: plan.planId, confirmed: true });
      run = { id: result.id, status: 'starting', cancelling: false };
      get('ansible-status').textContent = 'Ansible is starting…';
      const queued = pendingEvents; pendingEvents = []; starting = false;
      for (const event of queued) receiveAnsibleEvent(event);
    } catch (error) { get('ansible-status').textContent = messageOf(error); }
    finally { starting = false; preparing = false; updateControls(); }
  }

  function receiveAnsibleEvent(event) {
    if (!run || event.id !== run.id) {
      if (starting && pendingEvents.length < 200) pendingEvents.push(event);
      return;
    }
    if (event.type === 'status') {
      run.status = event.status;
      get('ansible-status').textContent = `Ansible ${event.status}${event.rc != null ? ` · exit ${event.rc}` : ''}${event.status === 'cancelled' ? ' · changes were not rolled back' : ''}`;
    } else if (event.type === 'error') {
      run.status = 'failed';
      get('ansible-status').textContent = messageOf(event.error);
    }
    if (event.type === 'event' || event.type === 'output') {
      if (feedCount >= 500 || outputCount >= 131072) {
        if (!run.truncated) { get('ansible-events').append(make('p', 'project-run-note', 'Additional output hidden to keep this view responsive.')); run.truncated = true; }
      } else {
        const row = make('div', `project-run-event${event.failed ? ' failed' : event.changed ? ' changed' : ''}`);
        if (event.type === 'event') {
          row.append(make('span', 'project-run-kind', event.event || 'event'));
          if (event.host) row.append(make('strong', '', event.host));
          if (event.task) row.append(make('span', '', event.task));
          if (event.message) row.append(make('pre', '', String(event.message).slice(0, 8192)));
          if (event.diff) row.append(make('pre', 'project-run-diff', String(event.diff).slice(0, 16384)));
          if (event.stats) row.append(make('pre', '', JSON.stringify(event.stats, null, 2).slice(0, 8192)));
        } else row.append(make('pre', '', String(event.text || '').slice(0, Math.min(8192, 131072 - outputCount))));
        outputCount += row.textContent.length; feedCount += 1;
        get('ansible-events').append(row);
        row.scrollIntoView({ block: 'nearest' });
      }
    }
    updateControls();
  }

  async function cancelAnsible() {
    if (!running() || run.cancelling) return;
    const id = run.id;
    run.cancelling = true; updateControls();
    try { await api.ansibleCancel(id); if (run?.id === id && running()) get('ansible-status').textContent = 'Cancelling the controller… Changes are not rolled back.'; }
    catch (error) { if (run?.id === id && running()) { run.cancelling = false; get('ansible-status').textContent = messageOf(error); updateControls(); } }
  }

  function ensureEditor() {
    if (editor) return;
    applyEditorTheme();
    editor = monaco.editor.create(get('project-editor'), { ...editorOptions, model: null, ariaLabel: 'Project file editor' });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void saveDocument());
    editor.onDidChangeCursorPosition((event) => { get('project-cursor').textContent = `Ln ${event.position.lineNumber}, Col ${event.position.column}`; });
  }

  function install() {
    if (installed) return;
    workspace = document.querySelector('.workspace');
    desktop = document.querySelector('.desktop-content');
    panel = make('section', 'project-workspace');
    panel.id = 'project-workspace';
    panel.setAttribute('aria-label', 'Project workspace');
    panel.hidden = true;
    // This template is static application markup. File names and all provider or
    // runner output are added separately with textContent.
    panel.innerHTML = `
      <header class="project-header"><div class="project-heading"><span class="project-eyebrow">PROJECT</span><strong id="project-name">Project workspace</strong></div><div class="project-header-actions"><button id="project-open-folder" class="secondary-button">Open folder</button><button id="project-toggle-terminal" class="quiet-button" aria-pressed="false">Show terminal</button><button id="project-hide" class="quiet-button">Terminal workspace</button></div></header>
      <div class="project-toolbar" role="toolbar" aria-label="Project actions"><button id="project-toggle-files" class="quiet-button" aria-pressed="false">Files</button><button id="project-new-file" class="quiet-button">+ New file</button><button id="project-save" class="primary-button">Save</button><button id="project-ai-edit" class="quiet-button">Ask AI to edit</button><span class="project-toolbar-divider"></span><button id="project-git" class="quiet-button">Git changes</button><button id="project-history" class="quiet-button">History</button><button id="project-reload" class="quiet-button">Reload from disk</button><button id="project-close-folder" class="quiet-button project-close-folder">Close folder</button></div>
      <div id="project-error" class="project-error" role="alert" hidden><span id="project-error-text"></span><button id="project-dismiss-error" aria-label="Dismiss project error">×</button></div>
      <div class="project-main"><aside class="project-explorer" aria-label="Project files"><div class="project-explorer-heading"><span>FILES</span><button id="project-refresh" class="quiet-button" aria-label="Refresh project files">↻</button></div><p id="project-root-label" class="project-root-label"></p><div id="project-files" role="tree" aria-label="Project file tree"></div></aside><div class="project-editor-stack"><div id="project-tabs" class="project-tabs" role="tablist" aria-label="Open project files"></div><div class="project-document-bar"><span id="project-document-path">No file open</span><span id="project-language">Local files</span></div><div id="project-empty" class="project-empty"><span class="project-empty-mark">{ }</span><h2>A workspace for your automation.</h2><p>Open a local folder to edit playbooks, inventories, scripts and templates. Changes stay in the editor until you save.</p><button id="project-empty-open" class="primary-button">Open project folder</button></div><div id="project-editor" class="project-editor" hidden></div><section id="project-review" class="project-review" aria-label="Review proposed file changes" hidden><header><div><strong id="project-review-title"></strong><p id="project-review-description"></p></div><div class="project-review-actions"><button id="project-review-cancel" class="quiet-button">Dismiss</button><button id="project-review-apply" class="primary-button">Apply to editor</button></div></header><div id="project-diff-editor" class="project-diff-editor"></div></section><footer class="project-editor-status"><span id="project-diagnostics">No code runs when you open a project.</span><span id="project-cursor"></span></footer></div></div>
      <details id="ansible-panel" class="project-ansible"><summary><strong>Ansible Runner</strong><span id="ansible-status" role="status">Saved files · explicit run review</span></summary><div class="project-ansible-body"><div class="project-run-form"><label>Controller<select id="ansible-controller"><option value="local">Local</option><option value="wsl">WSL</option></select></label><label>Python (optional)<input id="ansible-python" placeholder="python3" spellcheck="false" autocomplete="off"></label><button id="ansible-probe" class="secondary-button">Check setup</button><label>Playbook<input id="ansible-playbook" placeholder="playbooks/site.yml" spellcheck="false" autocomplete="off"></label><label>Inventory<input id="ansible-inventory" placeholder="inventory/hosts.yml" spellcheck="false" autocomplete="off"></label><label>Limit (optional)<input id="ansible-limit" placeholder="host or group" spellcheck="false" autocomplete="off"></label><label>Mode<select id="ansible-mode"><option value="syntax">Syntax check</option><option value="check">Check / dry run</option><option value="run">Run playbook</option></select></label></div><div class="project-run-consent"><label><input id="ansible-trust" type="checkbox">I trust this project's playbooks, inventory, plugins and controller code.</label><p>Ansible can execute local code and change managed hosts, including some tasks in check mode. Nothing runs until you review and confirm.</p><div><button id="ansible-prepare" class="primary-button">Review run</button><button id="ansible-cancel" class="secondary-button" hidden>Cancel run</button></div></div><div id="ansible-events" class="project-run-events" role="log" aria-label="Ansible host and task results" aria-live="polite"></div></div></details>`;
    workspace.prepend(panel);
    const newDialog = make('dialog', 'modal project-new-dialog'); newDialog.id = 'project-new-dialog';
    newDialog.innerHTML = '<form id="project-new-form"><header class="modal-header"><h2>New project file</h2></header><div class="modal-body"><label>File path<input id="project-new-path" required maxlength="1024" placeholder="playbooks/site.yml" autocomplete="off" spellcheck="false"></label><p class="field-note">Use a path inside this project. Parent folders must already exist. A new file is created only when you save; existing files are never replaced.</p><p id="project-new-error" class="project-form-error" role="alert"></p></div><footer class="modal-footer"><button id="project-new-cancel" type="button" class="quiet-button">Cancel</button><button type="submit" class="primary-button">Create editor buffer</button></footer></form>';
    document.body.append(newDialog);
    const inspector = make('dialog', 'modal project-inspector-dialog'); inspector.id = 'project-inspector-dialog';
    inspector.innerHTML = '<header class="modal-header"><h2 id="project-inspector-title"></h2><button id="project-inspector-close" class="icon-button" aria-label="Close project inspector">×</button></header><div class="project-inspector-body"><nav id="project-inspector-list" aria-label="Files or backups"></nav><pre id="project-inspector-detail" tabindex="0"></pre></div>';
    document.body.append(inspector);
    installed = true;
    const actions = {
      'project-open-folder': chooseProject, 'project-empty-open': chooseProject,
      'project-close-folder': closeProject, 'project-new-file': showNewFile,
      'project-save': () => saveDocument(), 'project-refresh': refreshFiles,
      'project-git': showGit, 'project-history': showBackups, 'project-reload': reloadDocument,
      'project-hide': close, 'project-dismiss-error': clearError,
      'project-toggle-files': () => { const shown = panel.classList.toggle('project-files-visible'); get('project-toggle-files').setAttribute('aria-pressed', String(shown)); },
      'project-review-cancel': () => { disposeReview(); editor?.focus(); }, 'project-review-apply': applyReview,
      'project-new-cancel': () => newDialog.close(), 'project-inspector-close': () => inspector.close(),
      'ansible-probe': probeAnsible, 'ansible-prepare': prepareAnsible, 'ansible-cancel': cancelAnsible,
      'project-ai-edit': () => { const doc = getActiveDocument(); if (doc) return requestAiEdit?.(doc); },
      'project-toggle-terminal': () => {
        const shown = workspace.classList.toggle('project-terminal-visible');
        get('project-toggle-terminal').textContent = shown ? 'Hide terminal' : 'Show terminal';
        get('project-toggle-terminal').setAttribute('aria-pressed', String(shown));
        onLayout();
      }
    };
    for (const [id, action] of Object.entries(actions)) get(id).addEventListener('click', () => { Promise.resolve().then(action).catch(reportError); });
    get('project-new-form').addEventListener('submit', newFile);
    inspector.addEventListener('close', () => { ++inspectorEpoch; });
    get('ansible-panel').addEventListener('toggle', () => { editor?.layout(); diffEditor?.layout(); onLayout(); });
    api.onAnsibleEvent?.(receiveAnsibleEvent);
    new MutationObserver(() => { if (editor) applyEditorTheme(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-match-colors', 'style'] });
    renderTree(); updateControls();
  }

  function open() {
    install();
    if (!platformConfigured && document.documentElement.dataset.platform) {
      platformConfigured = true;
      const windows = document.documentElement.dataset.platform === 'win32';
      get('ansible-controller').querySelector('[value="wsl"]').disabled = !windows;
      if (windows) get('ansible-controller').value = 'wsl';
    }
    panel.hidden = false;
    workspace.classList.add('project-mode'); desktop.classList.add('project-mode');
    document.getElementById('project-toggle')?.setAttribute('aria-pressed', 'true');
    ensureEditor();
    requestAnimationFrame(() => { editor.layout(); diffEditor?.layout(); onLayout(); });
  }

  function close() {
    if (!installed) return;
    panel.hidden = true;
    workspace.classList.remove('project-mode'); desktop.classList.remove('project-mode');
    document.getElementById('project-toggle')?.setAttribute('aria-pressed', 'false');
    onLayout();
  }

  function showTerminal() {
    if (!installed || panel.hidden) return;
    workspace.classList.add('project-terminal-visible');
    get('project-toggle-terminal').textContent = 'Hide terminal';
    get('project-toggle-terminal').setAttribute('aria-pressed', 'true');
    onLayout();
  }

  function diffControl(target) {
    if (!diffEditor) return null;
    if (diffEditor.getOriginalEditor().getDomNode()?.contains(target)) return diffEditor.getOriginalEditor();
    if (diffEditor.getModifiedEditor().getDomNode()?.contains(target)) return diffEditor.getModifiedEditor();
    return lastDiffSide === 'original' ? diffEditor.getOriginalEditor() : diffEditor.getModifiedEditor();
  }

  function find(target = document.activeElement) {
    if (!editor || panel.hidden) return false;
    const control = review ? diffControl(target) : editor;
    control?.focus(); control?.getAction('actions.find')?.run();
    return true;
  }

  function handlesEditTarget(target) {
    if (!installed || panel.hidden || !target?.closest?.('#project-editor, #project-diff-editor')) return false;
    // Find/Replace widgets use ordinary fields. Let the app's focused-field
    // clipboard path edit those, rather than changing the document selection.
    const field = target.closest('input, textarea');
    if (field && !field.classList.contains('inputarea')) return false;
    return true;
  }

  async function editAction(action, target = document.activeElement) {
    if (!handlesEditTarget(target)) return false;
    const inDiff = Boolean(target.closest('#project-diff-editor'));
    const control = inDiff ? diffControl(target) : editor;
    control?.focus();
    const model = control?.getModel(), selection = control?.getSelection();
    if (!model || !selection) return true;
    if (action === 'select-all') { control.setSelection(model.getFullModelRange()); control.focus(); return true; }
    const version = model.getVersionId();
    const stillCurrent = () => !panel.hidden && !model.isDisposed() && control.hasTextFocus() && control.getModel() === model && model.getVersionId() === version && control.getSelection()?.equalsSelection(selection) && (inDiff || activeDocument()?.model === model);
    if (action === 'copy' || action === 'cut') {
      if (selection.isEmpty()) return true;
      await api.clipboardWrite(model.getValueInRange(selection));
      if (action === 'cut' && !inDiff && stillCurrent()) { control.pushUndoStop(); control.executeEdits('termforge-cut', [{ range: selection, text: '' }]); control.pushUndoStop(); }
      return true;
    }
    if (action === 'paste') {
      if (inDiff || review) return true;
      const text = await api.clipboardRead();
      if (!stillCurrent()) { toast('The editor changed while reading the clipboard. Paste again.', true); return true; }
      if (typeof text !== 'string' || text.includes('\0') || model.getValueLength() - model.getValueLengthInRange(selection) + text.length > TEXT_LIMIT) throw new Error('Pasted text must fit the 2 MiB project file limit.');
      control.pushUndoStop(); control.executeEdits('termforge-paste', [{ range: selection, text }]); control.pushUndoStop(); control.focus();
      return true;
    }
    if (action === 'undo' || action === 'redo') { if (!inDiff && !review) control.trigger('termforge', action, null); return true; }
    return true;
  }

  return {
    install, open, close, chooseProject, closeProject, showTerminal,
    toggle: () => { if (!installed || panel.hidden) open(); else close(); },
    isOpen: () => installed && !panel.hidden,
    getActiveDocument, prepareAiContext: getActiveDocument, reviewAiEdit,
    saveActive: () => saveDocument(), closeActive: () => activePath ? closeDocument(activePath) : false,
    applyTheme: () => { if (editor) applyEditorTheme(); }, find, handlesEditTarget, editAction,
    focus: () => { if (editor && !panel.hidden) editor.focus(); },
    layout: () => { editor?.layout(); diffEditor?.layout(); }
  };
}
