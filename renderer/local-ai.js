import './local-ai.css';

const PROMPT_LIMIT = 8192;
const CONTEXT_LIMIT = 16384;
const REPLY_LIMIT = 65536;
const COMMAND_LIMIT = 16384;
const COMMAND_LANGUAGES = new Set(['', 'sh', 'bash', 'zsh', 'fish', 'shell', 'powershell', 'pwsh', 'ps1', 'cmd', 'bat', 'batch', 'cli', 'cisco', 'ios', 'iosxe', 'nxos', 'junos', 'eos', 'routeros', 'fortios']);
const make = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

// Redaction is deliberately visible and editable. It reduces obvious leaks, but
// cannot identify every secret in arbitrary terminal output.
function redactContext(text) {
  return text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)/g, '[PRIVATE KEY REDACTED]')
    .replace(/(authorization\s*:\s*(?:bearer|basic)\s+)[^\s]+/gi, '$1[REDACTED]')
    .replace(/((?:["']?\b(?:password|passwd|passphrase|token|access_token|refresh_token|api[_-]?key|secret|client_secret)\b["']?)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, '$1[REDACTED]');
}

function connectionLabel(connection) {
  return connection?.title || connection?.profile?.name || 'Terminal';
}

function messageOf(error) {
  return String(error?.message || error || 'The local model request failed.').slice(0, 2000);
}

function parseReply(text) {
  const parts = [];
  let lines = [];
  let fence = null;
  let language = '';
  const flushText = () => {
    if (lines.length) parts.push({ type: 'text', text: lines.join('\n') });
    lines = [];
  };
  for (const line of text.split('\n')) {
    const match = line.match(/^\s{0,3}(`{3,}|~{3,})([^\r\n]*)\r?$/);
    if (!fence && match) {
      flushText(); fence = match[1]; language = match[2].trim().toLowerCase();
    } else if (fence && match && match[1][0] === fence[0] && match[1].length >= fence.length && !match[2].trim()) {
      parts.push({ type: 'code', text: lines.join('\n'), language, complete: true });
      lines = []; fence = null; language = '';
    } else lines.push(line);
  }
  if (fence) parts.push({ type: 'code', text: lines.join('\n'), language, complete: false });
  else flushText();
  return parts;
}

export function createLocalAiUi({ api, getConnection, stageCommand, reviewFileEdit, toast, onLayout = () => {} }) {
  let installed = false;
  let panel;
  let resizer;
  let body;
  let provider;
  let providerBadge;
  let intro;
  let endpoint;
  let onlineSettings;
  let apiKey;
  let cloudConsent;
  let clearKey;
  let port;
  let model;
  let refresh;
  let modelStatus;
  let mode;
  let prompt;
  let contextBox;
  let context;
  let contextSource;
  let contextCount;
  let attachSelection;
  let attachScreen;
  let removeContext;
  let send;
  let cancel;
  let newRequest;
  let status;
  let error;
  let response;
  let requestTarget;
  let source = null;
  let request = null;
  let busy = false;
  let loading = false;
  let modelsPort = null;
  let refreshEpoch = 0;
  let opener = null;
  let renderFrame = null;

  const isOnline = () => provider.value === 'openrouter-free';

  function updateControls() {
    const online = isOnline();
    provider.disabled = busy || loading;
    port.disabled = busy || loading;
    model.disabled = busy || loading || !model.options.length;
    refresh.disabled = busy || loading;
    mode.disabled = busy;
    prompt.disabled = busy;
    context.disabled = busy;
    attachSelection.disabled = busy;
    attachScreen.disabled = busy;
    removeContext.disabled = busy;
    apiKey.disabled = busy;
    cloudConsent.disabled = busy;
    clearKey.disabled = busy || !apiKey.value;
    send.disabled = busy || loading || !model.value || !prompt.value.trim() || (online ? !apiKey.value.trim() || !cloudConsent.checked : modelsPort !== Number(port.value));
    cancel.hidden = !busy;
    newRequest.disabled = !busy && !prompt.value && !source && !request;
    panel.setAttribute('aria-busy', String(busy));
  }

  function setError(text = '') {
    error.textContent = text;
    error.hidden = !text;
  }

  function validPort() {
    const value = Number(port.value);
    if (!Number.isInteger(value) || value < 1 || value > 65535 || !/^\d+$/.test(port.value)) {
      setError('Enter an Ollama port from 1 to 65535.');
      port.setAttribute('aria-invalid', 'true');
      port.focus();
      return null;
    }
    port.removeAttribute('aria-invalid');
    return value;
  }

  async function refreshModels() {
    if (busy || loading) return;
    const online = isOnline();
    const value = online ? 'openrouter-free' : validPort();
    if (!value) return;
    const epoch = ++refreshEpoch;
    const previous = model.value;
    loading = true;
    model.replaceChildren();
    modelsPort = null;
    setError();
    modelStatus.textContent = online ? 'Preparing the free online model route…' : 'Looking for installed local models…';
    updateControls();
    try {
      const result = await api.aiModels(online ? { provider: 'openrouter-free' } : { port: value });
      if (epoch !== refreshEpoch) return;
      const models = Array.isArray(result.models) ? result.models : [];
      for (const item of models) {
        const option = make('option', '', item.parameterSize ? `${item.name} · ${item.parameterSize}` : item.name);
        option.value = item.name;
        model.append(option);
      }
      if (models.some((item) => item.name === previous)) model.value = previous;
      modelsPort = value;
      const excluded = Number(result.excluded) || 0;
      modelStatus.textContent = online ? 'OpenRouter chooses an available free model. Free quota limits stop the request; TermForge never falls back to paid models.' : models.length
        ? `${models.length} installed local model${models.length === 1 ? '' : 's'}${excluded ? ` · ${excluded} unsupported or nonlocal model${excluded === 1 ? '' : 's'} hidden` : ''}.`
        : 'No local models installed. Install a model in Ollama, then choose Refresh models. TermForge does not download models.';
    } catch (failure) {
      if (epoch !== refreshEpoch) return;
      modelStatus.textContent = online ? 'The free model route is unavailable. Choose Refresh models to try again.' : 'Start Ollama on this computer, then choose Refresh models. Models stay on this computer.';
      setError(messageOf(failure));
    } finally {
      if (epoch === refreshEpoch) { loading = false; updateControls(); }
    }
  }

  function privacyStatus() {
    return isOnline()
      ? 'Only your prompt and explicitly attached text are sent online after you allow it.'
      : 'Only your prompt and explicitly attached text are sent to the local model.';
  }

  function clearOnlineKey() {
    apiKey.value = '';
    cloudConsent.checked = false;
    updateControls();
  }

  function changeProvider() {
    if (busy) return;
    clearOnlineKey();
    modelsPort = null;
    model.replaceChildren();
    const online = isOnline();
    endpoint.querySelector('label').hidden = online;
    onlineSettings.hidden = !online;
    providerBadge.textContent = online ? 'ONLINE · FREE' : 'ON DEVICE';
    intro.textContent = online
      ? 'Investigate network issues using a free online model. Nothing runs automatically.'
      : 'Investigate network issues with a local model. Attach the output you want it to inspect. Nothing runs automatically.';
    send.textContent = online ? 'Send online' : 'Send';
    status.textContent = privacyStatus();
    setError();
    updateControls();
    refreshModels();
  }

  function attach(kind) {
    if (busy) return;
    const connection = getConnection();
    if (!connection?.term) { setError('Open a terminal before attaching its text.'); return; }
    let raw = '';
    if (kind === 'selection') raw = connection.term.getSelection();
    else {
      const buffer = connection.term.buffer.active;
      const lines = [];
      for (let row = 0; row < connection.term.rows; row += 1) {
        const line = buffer.getLine(buffer.viewportY + row);
        if (line) lines.push(line.translateToString(true));
      }
      raw = lines.join('\n').trimEnd();
    }
    if (!raw.trim()) { setError(kind === 'selection' ? 'Select terminal text first, then choose Attach selection.' : 'The visible terminal screen is empty.'); return; }
    const cleaned = redactContext(raw);
    const truncated = cleaned.length > CONTEXT_LIMIT;
    context.value = cleaned.slice(0, CONTEXT_LIMIT);
    source = { targetId: connection.id, label: connectionLabel(connection), protocol: connection.profile?.protocol || '', kind };
    contextSource.textContent = `${kind === 'selection' ? 'Selection' : 'Visible screen'} from ${source.label}${source.protocol ? ` (${source.protocol.toUpperCase()})` : ''}`;
    contextBox.hidden = false;
    updateContextCount(truncated);
    setError();
    updateControls();
    context.focus();
  }

  function updateContextCount(truncated = false) {
    contextCount.textContent = `${context.value.length.toLocaleString()} / ${CONTEXT_LIMIT.toLocaleString()} characters${truncated ? ' · truncated' : ''}. Review text; other secrets may remain.`;
  }

  function attachFile(snapshot) {
    show('edit');
    if (busy) { setError('Finish or cancel the current request before attaching a project file.'); return false; }
    if (!snapshot || typeof snapshot.text !== 'string' || snapshot.text.length > CONTEXT_LIMIT) {
      setError(`AI file editing supports complete files up to ${CONTEXT_LIMIT.toLocaleString()} characters. Shorten this file before requesting an edit.`);
      return false;
    }
    const cleaned = redactContext(snapshot.text);
    freshRequest();
    mode.value = 'edit';
    source = { kind: 'file', label: snapshot.path, file: { ...snapshot, baseText: snapshot.text }, editable: cleaned === snapshot.text };
    context.value = cleaned;
    contextSource.textContent = `Project file: ${snapshot.path}`;
    contextBox.hidden = false;
    context.setAttribute('aria-label', 'Attached project file to send');
    prompt.value = 'Improve this file. Explain your changes and return the complete updated file in one fenced code block.';
    prompt.placeholder = 'Describe the change you want in this file.';
    updateContextCount();
    if (!source.editable) setError('Possible secrets were masked. You can ask for advice, but applying a whole-file replacement is disabled to preserve those values.');
    updateControls();
    prompt.focus(); prompt.select();
    return true;
  }

  function clearContext() {
    source = null;
    context.value = '';
    contextBox.hidden = true;
    contextSource.textContent = '';
    updateControls();
  }

  function cancelRequest(label = 'Request cancelled. You can edit and send again.') {
    const cancelled = request;
    if (!cancelled || !busy) return;
    busy = false;
    cancelled.cancelled = true;
    cancelled.complete = false;
    status.textContent = label;
    updateControls();
    renderReply();
    Promise.resolve(api.aiCancel(cancelled.id)).catch(() => {});
  }

  function freshRequest() {
    cancelRequest();
    request = null;
    prompt.value = '';
    clearContext();
    response.replaceChildren(make('p', 'local-ai-empty', 'Investigate a network issue, explain selected output, or draft a command.'));
    requestTarget.textContent = '';
    requestTarget.hidden = true;
    status.textContent = privacyStatus();
    setError();
    updateControls();
    prompt.focus();
  }

  async function submit() {
    if (busy || loading) return;
    const online = isOnline();
    const value = online ? 'openrouter-free' : validPort();
    if (!value) return;
    if (!model.value || modelsPort !== value) { setError(online ? 'Refresh models to select the free online model route.' : 'Refresh models and select an installed local model.'); return; }
    if (online && !apiKey.value.trim()) { setError('Enter your OpenRouter API key to use free online models.'); apiKey.focus(); return; }
    if (online && !cloudConsent.checked) { setError('Allow sending your prompt and attached text to the online provider first.'); cloudConsent.focus(); return; }
    if (!prompt.value.trim()) { setError('Enter a question or describe the command you need.'); prompt.focus(); return; }
    if (prompt.value.length > PROMPT_LIMIT || context.value.length > CONTEXT_LIMIT) { setError('Shorten the prompt or attached text before sending.'); return; }
    const connection = getConnection();
    const targetId = source ? source.targetId : connection?.id || null;
    const targetLabel = source ? source.label : connection ? connectionLabel(connection) : null;
    const current = { id: crypto.randomUUID(), text: '', targetId, targetLabel, file: source?.kind === 'file' ? { ...source.file } : null, fileEditable: source?.editable === true, online, complete: false, cancelled: false };
    request = current;
    busy = true;
    response.replaceChildren(make('p', 'local-ai-empty', online ? 'Waiting for the free online model…' : 'Waiting for the local model…'));
    requestTarget.textContent = current.file ? `File proposal: ${current.file.path}. Review the diff before applying to the editor; saving is a separate step.` : targetLabel ? `Command target: ${targetLabel}. Return to this tab to use a command.` : 'No terminal target. Open a terminal and send a new request to stage a command.';
    requestTarget.hidden = false;
    status.textContent = online ? 'Generating with a free online model…' : 'Generating locally…';
    setError();
    updateControls();
    try {
      const payload = { requestId: current.id, model: model.value, prompt: prompt.value, context: source ? context.value : '', mode: mode.value };
      if (online) Object.assign(payload, { provider: 'openrouter-free', apiKey: apiKey.value.trim(), cloudConsent: true });
      else payload.port = value;
      await api.aiStart(payload);
      // The stream may finish before the IPC acknowledgement arrives.
    } catch (failure) {
      if (request !== current || current.cancelled || !busy) return;
      busy = false;
      status.textContent = 'Request failed. Edit the prompt or choose Send to retry.';
      setError(messageOf(failure));
      updateControls();
      renderReply();
    }
  }

  function onEvent(event) {
    if (!request || event.requestId !== request.id || request.cancelled || !busy) return;
    if (event.type === 'delta' && typeof event.text === 'string') {
      if (request.text.length + event.text.length > REPLY_LIMIT) {
        request.text = (request.text + event.text).slice(0, REPLY_LIMIT);
        cancelRequest('Response reached the display limit. Shorten the request and try again.');
        return;
      }
      request.text += event.text;
      scheduleReply();
    } else if (event.type === 'done') {
      busy = false;
      request.complete = true;
      status.textContent = request.text.trim() ? request.file ? 'Complete. Review the proposed file diff before applying edits.' : 'Complete. Review any suggested command before sending it.' : 'The model returned an empty response. Try another prompt or model.';
      updateControls();
      renderReply();
    } else if (event.type === 'error') {
      busy = false;
      status.textContent = 'Request failed. Choose Send to retry.';
      setError(messageOf(event.error));
      updateControls();
      renderReply();
    }
  }

  function scheduleReply() {
    if (renderFrame !== null) return;
    renderFrame = requestAnimationFrame(() => { renderFrame = null; renderReply(); });
  }

  function renderReply() {
    if (!request) return;
    const current = request;
    const keepAtEnd = body.scrollHeight - body.scrollTop - body.clientHeight < 70;
    const content = document.createDocumentFragment();
    if (!current.text) content.append(make('p', 'local-ai-empty', busy ? current.online ? 'Waiting for the free online model…' : 'Waiting for the local model…' : 'No response text.'));
    for (const part of parseReply(current.text)) {
      if (part.type === 'text') {
        content.append(make('p', 'local-ai-prose', part.text));
        continue;
      }
      const block = make('section', 'local-ai-code-block');
      const heading = make('div', 'local-ai-code-heading');
      heading.append(make('span', '', part.language || 'Code'));
      const code = make('pre', 'local-ai-code', part.text);
      code.tabIndex = 0;
      const isCommand = COMMAND_LANGUAGES.has(part.language) && part.text.trim() && part.text.length <= COMMAND_LIMIT;
      if (current.file && reviewFileEdit) {
        const review = make('button', 'local-ai-review-file', 'Review file edit');
        review.type = 'button';
        review.disabled = !current.complete || !part.complete || !current.fileEditable;
        review.title = current.fileEditable ? 'Compare the complete proposed file with the original editor buffer' : 'Whole-file replacement is disabled because attached secrets were masked';
        review.addEventListener('click', async () => {
          if (request !== current || !current.complete || !current.fileEditable) return;
          review.disabled = true;
          try { await reviewFileEdit({ ...current.file, text: part.text }); }
          catch (failure) { setError(messageOf(failure)); }
          finally { if (request === current) review.disabled = false; }
        });
        heading.append(review);
      } else if (isCommand) {
        const use = make('button', 'local-ai-use-command', 'Use command');
        use.type = 'button';
        use.disabled = !current.complete || !part.complete || !current.targetId;
        use.title = current.targetId ? 'Place this block in the Command Window for review' : 'Send a new request with an active terminal first';
        use.addEventListener('click', async () => {
          if (request !== current || !current.complete) return;
          const target = getConnection();
          if (!target || target.id !== current.targetId || target.exited) {
            setError(`Return to the original target terminal (${current.targetLabel}) before using this command. If it has closed, send a new request from another terminal.`);
            return;
          }
          use.disabled = true;
          try {
            const staged = await stageCommand(part.text, current.targetId);
            if (staged === false) return;
            setError();
            toast?.('Command placed in the Command Window for review.');
          } catch (failure) { setError(messageOf(failure)); }
          finally { if (request === current) use.disabled = false; }
        });
        heading.append(use);
      }
      block.append(heading, code);
      content.append(block);
    }
    response.replaceChildren(content);
    if (keepAtEnd) body.scrollTop = body.scrollHeight;
  }

  function applyWidth(value) {
    const max = Math.max(300, Math.min(520, window.innerWidth - 340));
    const width = Math.max(300, Math.min(max, value));
    panel.parentElement.style.setProperty('--local-ai-width', `${width}px`);
    resizer.setAttribute('aria-valuenow', String(Math.round(width)));
    resizer.setAttribute('aria-valuemax', String(max));
    onLayout();
  }

  function installResize() {
    resizer.addEventListener('keydown', (event) => {
      const width = panel.getBoundingClientRect().width;
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      applyWidth(event.key === 'Home' ? 300 : event.key === 'End' ? 520 : width + (event.key === 'ArrowLeft' ? 20 : -20));
    });
    resizer.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const startX = event.clientX;
      const width = panel.getBoundingClientRect().width;
      const app = document.getElementById('app');
      app?.classList.add('resizing');
      resizer.setPointerCapture(event.pointerId);
      const move = (next) => { if (next.pointerId === event.pointerId) applyWidth(width + startX - next.clientX); };
      const finish = (next) => {
        if (next.pointerId !== event.pointerId) return;
        resizer.removeEventListener('pointermove', move);
        resizer.removeEventListener('pointerup', finish);
        resizer.removeEventListener('pointercancel', finish);
        resizer.removeEventListener('lostpointercapture', finish);
        app?.classList.remove('resizing');
        if (resizer.hasPointerCapture(event.pointerId)) resizer.releasePointerCapture(event.pointerId);
      };
      resizer.addEventListener('pointermove', move);
      resizer.addEventListener('pointerup', finish);
      resizer.addEventListener('pointercancel', finish);
      resizer.addEventListener('lostpointercapture', finish);
    });
    window.addEventListener('resize', () => { if (!panel.hidden) applyWidth(panel.getBoundingClientRect().width); });
  }

  function install() {
    if (installed) return;
    installed = true;
    const host = document.querySelector('.desktop-content');
    panel = make('aside', 'local-ai-panel'); panel.id = 'local-ai-panel'; panel.hidden = true; panel.setAttribute('aria-label', 'AI Assistant');
    const header = make('div', 'pane-caption local-ai-header');
    providerBadge = make('span', 'local-ai-badge', 'ON DEVICE');
    header.append(make('span', '', 'AI Assistant'), providerBadge);
    const closeButton = make('button', 'caption-button', '×'); closeButton.id = 'local-ai-close'; closeButton.type = 'button'; closeButton.setAttribute('aria-label', 'Close AI Assistant'); closeButton.title = 'Close AI Assistant'; closeButton.addEventListener('click', close);
    header.append(closeButton);
    body = make('div', 'local-ai-body');
    intro = make('p', 'local-ai-note', 'Investigate network issues with a local model. Attach the output you want it to inspect. Nothing runs automatically.');
    const providerLabel = make('label', 'local-ai-field', 'Model connection');
    provider = make('select'); provider.id = 'ai-provider';
    for (const [value, label] of [['ollama', 'Ollama (local)'], ['openrouter-free', 'Free online models (OpenRouter)']]) { const option = make('option', '', label); option.value = value; provider.append(option); }
    providerLabel.append(provider);
    provider.addEventListener('change', changeProvider);
    endpoint = make('div', 'local-ai-endpoint');
    const portLabel = make('label', '', 'Ollama port');
    port = make('input'); port.id = 'local-ai-port'; port.type = 'number'; port.min = '1'; port.max = '65535'; port.step = '1'; port.value = '11434'; port.inputMode = 'numeric';
    portLabel.append(port);
    refresh = make('button', 'secondary-button', 'Refresh models'); refresh.id = 'local-ai-refresh'; refresh.type = 'button'; refresh.addEventListener('click', refreshModels);
    endpoint.append(portLabel, refresh);
    onlineSettings = make('section', 'local-ai-online-settings'); onlineSettings.hidden = true;
    const keyLabel = make('label', 'local-ai-field', 'OpenRouter API key');
    const keyRow = make('div', 'local-ai-key-row');
    apiKey = make('input'); apiKey.id = 'ai-api-key'; apiKey.type = 'password'; apiKey.autocomplete = 'off'; apiKey.spellcheck = false; apiKey.maxLength = 4096; apiKey.placeholder = 'Paste your free account API key'; apiKey.addEventListener('input', updateControls);
    clearKey = make('button', '', 'Clear'); clearKey.id = 'ai-clear-key'; clearKey.type = 'button'; clearKey.setAttribute('aria-label', 'Clear OpenRouter API key'); clearKey.addEventListener('click', () => { clearOnlineKey(); apiKey.focus(); });
    keyRow.append(apiKey, clearKey); keyLabel.append(keyRow);
    const keyNote = make('p', 'local-ai-note', 'Create a free account and API key at openrouter.ai. The key is kept only while this panel is open and is cleared when closed or switched. ChatGPT and Claude subscriptions do not include this API.');
    const disclosure = make('p', 'local-ai-note', 'OpenRouter and its model provider may retain your text. Review attached output before sending. Free quotas apply; there is no paid fallback.');
    const consentLabel = make('label', 'local-ai-consent');
    cloudConsent = make('input'); cloudConsent.id = 'ai-cloud-consent'; cloudConsent.type = 'checkbox'; cloudConsent.addEventListener('change', updateControls);
    consentLabel.append(cloudConsent, make('span', '', 'Send my prompt and attached text to OpenRouter and its model provider.'));
    onlineSettings.append(keyLabel, keyNote, disclosure, consentLabel);
    const modelLabel = make('label', 'local-ai-field', 'Model');
    model = make('select'); model.id = 'local-ai-model'; modelLabel.append(model);
    modelStatus = make('p', 'local-ai-note local-ai-model-status', 'Choose Refresh models to find installed models.'); modelStatus.id = 'local-ai-model-status'; modelStatus.setAttribute('aria-live', 'polite');
    const modeLabel = make('label', 'local-ai-field local-ai-mode-field', 'Task');
    mode = make('select'); mode.id = 'local-ai-mode';
    for (const [value, label] of [['ask', 'Investigate'], ['explain', 'Explain output'], ['command', 'Draft a command'], ['edit', 'Propose a file edit']]) { const option = make('option', '', label); option.value = value; mode.append(option); }
    modeLabel.append(mode);
    const promptLabel = make('label', 'local-ai-field', 'Your request');
    prompt = make('textarea'); prompt.id = 'local-ai-prompt'; prompt.rows = 4; prompt.maxLength = PROMPT_LIMIT; prompt.placeholder = 'For example: Why is this BGP neighbor down? What should I check next?'; prompt.spellcheck = false; promptLabel.append(prompt);
    const attachments = make('div', 'local-ai-attachments');
    attachSelection = make('button', '', 'Attach selection'); attachSelection.id = 'local-ai-attach-selection'; attachSelection.type = 'button'; attachSelection.addEventListener('click', () => attach('selection'));
    attachScreen = make('button', '', 'Attach visible screen'); attachScreen.id = 'local-ai-attach-screen'; attachScreen.type = 'button'; attachScreen.addEventListener('click', () => attach('screen'));
    attachments.append(attachSelection, attachScreen);
    contextBox = make('section', 'local-ai-context-box'); contextBox.hidden = true;
    const contextHeading = make('div', 'local-ai-context-heading');
    contextSource = make('span'); contextSource.id = 'local-ai-context-source';
    removeContext = make('button', 'caption-button', '×'); removeContext.id = 'local-ai-remove-context'; removeContext.type = 'button'; removeContext.setAttribute('aria-label', 'Remove attached context'); removeContext.title = 'Remove attached context'; removeContext.addEventListener('click', clearContext);
    contextHeading.append(contextSource, removeContext);
    context = make('textarea'); context.id = 'local-ai-context'; context.rows = 4; context.maxLength = CONTEXT_LIMIT; context.spellcheck = false; context.setAttribute('aria-label', 'Attached terminal text to send');
    contextCount = make('p', 'local-ai-note'); contextCount.id = 'local-ai-context-count'; context.addEventListener('input', () => updateContextCount());
    contextBox.append(contextHeading, context, contextCount);
    const controls = make('div', 'local-ai-controls');
    send = make('button', 'primary-button', 'Send'); send.id = 'local-ai-send'; send.type = 'button'; send.addEventListener('click', submit);
    cancel = make('button', 'secondary-button', 'Cancel'); cancel.id = 'local-ai-cancel'; cancel.type = 'button'; cancel.hidden = true; cancel.addEventListener('click', () => cancelRequest());
    newRequest = make('button', 'quiet-button', 'New request'); newRequest.id = 'local-ai-new'; newRequest.type = 'button'; newRequest.addEventListener('click', freshRequest);
    controls.append(send, cancel, newRequest);
    status = make('p', 'local-ai-note', 'Only your prompt and explicitly attached text are sent to the local model.'); status.id = 'local-ai-status'; status.setAttribute('role', 'status');
    error = make('p', 'local-ai-error'); error.id = 'local-ai-error'; error.hidden = true; error.setAttribute('role', 'alert');
    requestTarget = make('p', 'local-ai-note local-ai-request-target'); requestTarget.id = 'local-ai-request-target'; requestTarget.hidden = true;
    const responseHeading = make('h3', 'local-ai-response-heading', 'Response');
    response = make('div', 'local-ai-response'); response.id = 'local-ai-response'; response.setAttribute('aria-label', 'AI model response'); response.append(make('p', 'local-ai-empty', 'Investigate a network issue, explain selected output, or draft a command.'));
    body.append(intro, providerLabel, endpoint, onlineSettings, modelLabel, modelStatus, modeLabel, promptLabel, attachments, contextBox, controls, status, error, requestTarget, responseHeading, response);
    panel.append(header, body);
    resizer = make('div', 'local-ai-resizer'); resizer.id = 'local-ai-resizer'; resizer.hidden = true; resizer.tabIndex = 0; resizer.setAttribute('role', 'separator'); resizer.setAttribute('aria-label', 'Resize AI Assistant'); resizer.setAttribute('aria-orientation', 'vertical'); resizer.setAttribute('aria-controls', panel.id); resizer.setAttribute('aria-valuemin', '300'); resizer.setAttribute('aria-valuemax', '520'); resizer.setAttribute('aria-valuenow', '360');
    host.append(resizer, panel);
    prompt.addEventListener('input', updateControls);
    prompt.addEventListener('keydown', (event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); submit(); } });
    mode.addEventListener('change', () => {
      prompt.placeholder = mode.value === 'explain' ? 'Explain these interface errors and suggest what to check.' : mode.value === 'command' ? 'Describe the diagnostic command you need and the device OS or shell.' : 'For example: Why is this BGP neighbor down? What should I check next?';
    });
    model.addEventListener('change', updateControls);
    port.addEventListener('input', () => { modelsPort = null; model.replaceChildren(); modelStatus.textContent = 'Choose Refresh models for this Ollama port.'; setError(); updateControls(); });
    panel.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); close(); } });
    api.onAiEvent(onEvent);
    installResize();
    updateControls();
  }

  function show(task) {
    install();
    if (panel.hidden) opener = document.activeElement;
    panel.hidden = false;
    resizer.hidden = false;
    panel.parentElement.classList.add('local-ai-open');
    if (['ask', 'explain', 'command', 'edit'].includes(task)) { mode.value = task; mode.dispatchEvent(new Event('change')); }
    onLayout();
    prompt.focus();
    if (modelsPort === null && !loading) refreshModels();
    document.getElementById('local-ai-toggle')?.setAttribute('aria-pressed', 'true');
  }

  function close() {
    if (!installed) return;
    cancelRequest('Request cancelled when AI Assistant was closed.');
    clearOnlineKey();
    panel.hidden = true;
    resizer.hidden = true;
    panel.parentElement.classList.remove('local-ai-open');
    onLayout();
    document.getElementById('local-ai-toggle')?.setAttribute('aria-pressed', 'false');
    if (opener?.isConnected && typeof opener.focus === 'function') opener.focus();
  }

  return { install, show, close, attachFile, toggle: () => installed && !panel.hidden ? close() : show(), isVisible: () => installed && !panel.hidden };
}
