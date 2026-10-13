'use strict';

const { createLocalAi } = require('./local-ai.cjs');
const { createFreeAi } = require('./free-ai.cjs');

// One request across both providers. Renderer-supplied provider names never
// become URLs, module names, model fallbacks, or filesystem paths.
function createAiAssistant({ emit, localFactory = createLocalAi, freeFactory = createFreeAi } = {}) {
  let active = null;
  let closed = false;
  const forward = provider => event => {
    if (closed || active?.provider !== provider || active.id !== event.requestId) return;
    if (event.type === 'done' || event.type === 'error') active = null;
    try { emit(event); } catch {}
  };
  const providers = { ollama: localFactory({ emit: forward('ollama') }), 'openrouter-free': freeFactory({ emit: forward('openrouter-free') }) };
  function route(input = {}) {
    if (closed) throw new Error('AI Assistant is closed.');
    if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new Error('AI request must be an object.');
    const { provider = 'ollama', ...request } = input;
    if (!Object.hasOwn(providers, provider) || typeof provider !== 'string') throw new Error('Choose Ollama or free online models.');
    return { provider, request };
  }
  return {
    async listModels(input) {
      const { provider, request } = route(input);
      return providers[provider].listModels(request);
    },
    async start(input) {
      const { provider, request } = route(input);
      if (active) throw new Error('An AI request is already running. Cancel it first.');
      const job = { provider, id: request.requestId };
      active = job;
      try { return await providers[provider].start(request); }
      catch (error) { if (active === job) active = null; throw error; }
    },
    cancel(id) {
      if (!active || active.id !== id) return false;
      const job = active;
      const result = providers[job.provider].cancel(id);
      if (active === job) active = null;
      return result;
    },
    close() {
      closed = true; active = null;
      try { providers.ollama.close(); } finally { providers['openrouter-free'].close(); }
    },
  };
}

module.exports = { createAiAssistant };
