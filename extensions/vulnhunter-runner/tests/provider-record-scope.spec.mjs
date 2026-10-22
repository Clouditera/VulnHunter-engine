import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentModelRuntime } from '../.dist/src/agent-model.js';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';

const work = '24f0c7a3-1375-4c07-8fa5-45ebc2d4bad1';
const personal = 'd1ee345b-aa77-4a48-a0c0-99437927dd72';
function snapshot(providerId = work, version = 1, providerType = 'zai') {
  return {
    version, source: 'inline', selection: { providerId, modelId: 'shared', thinking: 'low' },
    providers: [work, personal].map(id => ({ id, providerType, name: id,
      api: 'openai-completions', baseUrl: `https://${id}.example.invalid/v1`,
      models: [{ id: 'shared', reasoning: true, headers: { 'x-account': id } }],
    })),
    credentials: [work, personal].map(providerId => ({ providerId, type: 'api_key', apiKey: `fake-${providerId}` })),
  };
}
const options = agentKey => ({ agentKey, engineDir: '/unused-no-file-source' });
const auth = async slot => (await slot.runtime.getAuth(slot.current().model)).auth;

test('record UUID stays in platform selection; canonical SDK type and same-type accounts are independent', async () => {
  const a = await AgentModelRuntime.create(snapshot(), options('main'));
  const b = await AgentModelRuntime.create(snapshot(personal), options('child'));
  for (const slot of [a, b]) {
    assert.equal(slot.current().model.provider, 'zai');
    assert.equal(slot.runtime.getModel(slot.current().selection.providerId, 'shared'), undefined);
    assert.ok(slot.runtime.getRegisteredNativeProvider('zai'));
  }
  assert.notEqual(a.runtime, b.runtime);
  assert.equal((await auth(a)).apiKey, `fake-${work}`);
  assert.equal((await auth(b)).apiKey, `fake-${personal}`);
  assert.equal((await auth(a)).headers['x-account'], work);
  assert.equal((await auth(b)).headers['x-account'], personal);

  const applied = [];
  a.register({ id: 'fixture', async setResolvedModel(model, thinking) {
    applied.push({ provider: model.provider, id: model.id, thinking, baseUrl: model.baseUrl });
  } });
  const runtime = a.runtime;
  await a.replace(snapshot(personal, 2));
  assert.equal(a.runtime, runtime);
  assert.equal(a.current().selection.providerId, personal);
  assert.equal(a.current().model.provider, 'zai');
  assert.equal((await auth(a)).apiKey, `fake-${personal}`);
  assert.equal((await auth(a)).headers['x-account'], personal);
  assert.deepEqual(applied, [{ provider: 'zai', id: 'shared', thinking: 'low', baseUrl: `https://${personal}.example.invalid/v1` }]);
  const changed = snapshot(work, 3, 'openai');
  await a.replace(changed);
  assert.equal(a.runtime.getRegisteredNativeProvider('zai'), undefined);
  assert.notEqual((await a.runtime.getAuth('zai'))?.auth.apiKey, `fake-${personal}`);
  assert.equal(a.current().model.provider, 'openai');
  assert.equal((await auth(a)).apiKey, `fake-${work}`);
  assert.equal(b.current().model.provider, 'zai');
  assert.equal((await auth(b)).apiKey, `fake-${personal}`);
});

test('absent record/type/key/model and unsupported thinking never select another same-type record', async () => {
  const slot = await AgentModelRuntime.create(snapshot(), options('main'));
  for (const change of [
    value => { value.selection.providerId = 'deleted-record'; },
    value => { delete value.providers[0].providerType; },
    value => { value.credentials = value.credentials.filter(entry => entry.providerId !== work); },
    value => { value.selection.modelId = 'missing-model'; },
    value => { value.selection.thinking = 'max'; },
  ]) {
    const invalid = snapshot(work, 2); change(invalid);
    await assert.rejects(slot.replace(invalid), /不存在|providerType|未配置凭证|不支持思考档/);
    assert.equal(slot.snapshot().version, 1);
    assert.equal(slot.current().selection.providerId, work);
    assert.equal((await auth(slot)).apiKey, `fake-${work}`);
  }
});

test('failed live application restores the record, native model and credential together', async () => {
  const slot = await AgentModelRuntime.create(snapshot(), options('main'));
  let fail = true;
  slot.register({ id: 'fixture', async setResolvedModel() {
    if (fail) { fail = false; throw new Error('fixture setModel rejected'); }
  } });
  await assert.rejects(slot.replace(snapshot(personal, 2)), /fixture setModel rejected/);
  assert.equal(slot.snapshot().version, 1);
  assert.equal(slot.current().selection.providerId, work);
  assert.equal(slot.current().model.baseUrl, `https://${work}.example.invalid/v1`);
  assert.equal((await auth(slot)).apiKey, `fake-${work}`);
});

// onPayload stops native request building before networking. These regressions
// specifically fail if the database UUID is put back in Model.provider.
async function requestPayload(providerType, definition, context) {
  const { provider: _provider, ...model } = definition;
  const slot = await AgentModelRuntime.create({
    version: 1, source: 'inline', selection: { providerId: work, modelId: model.id, thinking: 'off' },
    providers: [{ id: work, providerType, api: model.api, baseUrl: model.baseUrl, models: [model] }],
    credentials: [{ providerId: work, type: 'api_key', apiKey: 'fake-payload-key' }],
  }, options('payload'));
  let payload; let networkCalls = 0;
  const result = await slot.runtime.completeSimple(slot.current().model, context, {
    transport: 'sse', fetch: async () => { networkCalls++; throw new Error('network forbidden'); },
    onPayload(value) { payload = structuredClone(value); throw new Error('stopped before network'); },
  });
  assert.equal(result.stopReason, 'error'); assert.equal(networkCalls, 0); assert.ok(payload);
  return payload;
}

test('xAI off preserves native encrypted-reasoning request handling', async () => {
  const model = builtinProviders().find(provider => provider.id === 'xai').getModels().find(model => model.id === 'grok-4.3');
  const payload = await requestPayload('xai', model, { messages: [{ role: 'user', content: 'fixture', timestamp: 0 }] });
  assert.deepEqual(payload.include, ['reasoning.encrypted_content']);
});

test('OpenAI cross-model tool IDs preserve native length normalization', async () => {
  const id = 'c'.repeat(60);
  const model = { id: 'fixture', name: 'Fixture', api: 'openai-completions', baseUrl: 'https://api.openai.com/v1', reasoning: false };
  const payload = await requestPayload('openai', model, { messages: [
    { role: 'assistant', api: 'anthropic-messages', provider: 'previous', model: 'previous', timestamp: 0, stopReason: 'toolUse',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      content: [{ type: 'toolCall', id, name: 'fixture_tool', arguments: {} }] },
    { role: 'toolResult', toolCallId: id, toolName: 'fixture_tool', content: [{ type: 'text', text: 'fixture' }], isError: false, timestamp: 1 },
  ] });
  assert.equal(payload.messages.find(message => message.tool_calls).tool_calls[0].id.length, 40);
  assert.equal(payload.messages.find(message => message.role === 'tool').tool_call_id.length, 40);
});
