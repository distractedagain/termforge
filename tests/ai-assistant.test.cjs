'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAiAssistant } = require('../app/ai-assistant.cjs');

function fixture() {
  const calls = [], events = [], emitters = {};
  const factory = name => ({ emit }) => {
    emitters[name] = emit;
    return {
      listModels: async input => { calls.push([name, 'models', input]); return { models: [] }; },
      start: async input => { calls.push([name, 'start', input]); if (input.reject) throw new Error('Invalid request'); return { requestId: input.requestId }; },
      cancel: id => { calls.push([name, 'cancel', id]); emit({ requestId: id, type: 'error', error: 'Canceled' }); return true; },
      close: () => calls.push([name, 'close']),
    };
  };
  return { calls, events, emitters, ai: createAiAssistant({ emit: event => events.push(event), localFactory: factory('local'), freeFactory: factory('free') }) };
}

test('AI router defaults local and explicitly selects free provider without forwarding routing data', async () => {
  const f = fixture();
  await f.ai.listModels({ port: 11434 });
  await f.ai.listModels({ provider: 'openrouter-free' });
  await f.ai.start({ provider: 'openrouter-free', requestId: 'a', apiKey: 'synthetic', cloudConsent: true });
  assert.deepEqual(f.calls, [['local', 'models', { port: 11434 }], ['free', 'models', {}], ['free', 'start', { requestId: 'a', apiKey: 'synthetic', cloudConsent: true }]]);
  f.ai.close();
});

test('AI router refuses unknown providers and overlapping jobs; canceled provider cannot affect next request', async () => {
  const f = fixture();
  for (const provider of ['https://example.com', 'openai', 'claude', '__proto__', 'constructor']) await assert.rejects(f.ai.start({ provider, requestId: 'x' }), /Choose/);
  assert.equal(f.calls.length, 0);
  await f.ai.start({ requestId: 'a' });
  await assert.rejects(f.ai.start({ provider: 'openrouter-free', requestId: 'b' }), /already running/);
  assert.equal(f.ai.cancel('other'), false);
  assert.equal(f.ai.cancel('a'), true);
  await f.ai.start({ provider: 'openrouter-free', requestId: 'b' });
  f.emitters.local({ requestId: 'a', type: 'done' });
  f.emitters.free({ requestId: 'a', type: 'delta', text: 'stale' });
  f.emitters.free({ requestId: 'b', type: 'done' });
  assert.deepEqual(f.events.map(event => event.type), ['error', 'done']);
  await f.ai.start({ requestId: 'c' });
  f.ai.close();
  f.emitters.local({ requestId: 'c', type: 'done' });
  assert.equal(f.events.length, 2);
  await assert.rejects(f.ai.listModels(), /closed/);
  assert.equal(f.calls.filter(call => call[1] === 'close').length, 2);
});

test('AI router releases failed starts for a corrected request', async () => {
  const f = fixture();
  await assert.rejects(f.ai.start({ requestId: 'invalid', reject: true }), /Invalid/);
  await f.ai.start({ requestId: 'good' });
  f.ai.close();
});
