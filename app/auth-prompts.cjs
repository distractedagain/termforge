'use strict';
const { randomUUID } = require('node:crypto');
function createAuthPrompts({ send, timeoutMs = 120000 } = {}) {
  const pending = new Map();
  const label = (value, max) => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, '').slice(0, max) : '';
  function finish(id, answers) {
    const request = pending.get(id); if (!request) return false;
    pending.delete(id); clearTimeout(request.timer); request.signal?.removeEventListener('abort', request.abort);
    try { send('authPromptClosed', { id }); } catch { /* The renderer can disappear while a connection is closing. */ }
    finally { request.resolve(answers); }
    return true;
  }
  return {
    request(input) {
      if (input?.signal?.aborted) return Promise.resolve(null);
      if (!input || !Array.isArray(input.prompts) || input.prompts.length > 8 || pending.size >= 16) return Promise.reject(new Error('Too many authentication prompts.'));
      const id = randomUUID();
      return new Promise(resolve => {
        const abort = () => finish(id, null);
        const timer = setTimeout(abort, timeoutMs); timer.unref?.();
        pending.set(id, { resolve, timer, signal: input.signal, abort, count: input.prompts.length });
        input.signal?.addEventListener('abort', abort, { once: true });
        try { send('authPrompt', { id, host: label(input.host, 253), port: input.port, kind: label(input.kind, 32), protocol: ['ftp', 'ftps', 'ftps-implicit'].includes(input.protocol) ? input.protocol : 'ssh', username: label(input.username, 128), instructions: label(input.instructions, 2048), prompts: input.prompts.map(item => ({ prompt: label(item.prompt, 512), echo: item.echo === true })) }); }
        catch { finish(id, null); }
      });
    },
    respond(input) {
      if (!input || typeof input.id !== 'string') throw new Error('Invalid authentication response.');
      const request = pending.get(input.id); if (!request) return false;
      if (input.answers !== null && (!Array.isArray(input.answers) || input.answers.length !== request.count || input.answers.some(answer => typeof answer !== 'string' || answer.length > 4096 || answer.includes('\u0000')))) throw new Error('Invalid authentication response.');
      return finish(input.id, input.answers);
    },
    closeAll() { for (const id of pending.keys()) finish(id, null); },
  };
}
module.exports = { createAuthPrompts };
