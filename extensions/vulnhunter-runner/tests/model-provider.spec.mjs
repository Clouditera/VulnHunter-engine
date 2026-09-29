import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createModelRuntime, registerModelProvider } from '../.dist/src/model-provider.js';

const definition = (id, models = [{ id: 'shared-model', reasoning: true }]) => ({
  id, name: id, api: 'openai-completions', baseUrl: 'https://example.invalid/v1', models,
});

test('native SDK providers isolate instances and use memory-only credentials', async () => {
  const runtime = await createModelRuntime();
  registerModelProvider(runtime, definition('work'));
  registerModelProvider(runtime, definition('personal'));
  await runtime.setRuntimeApiKey('work', 'fake-work-key');
  await runtime.setRuntimeApiKey('personal', 'fake-personal-key');
  assert.equal((await runtime.getAuth(runtime.getModel('work', 'shared-model'))).auth.apiKey, 'fake-work-key');
  assert.equal((await runtime.getAuth(runtime.getModel('personal', 'shared-model'))).auth.apiKey, 'fake-personal-key');
  assert.equal(runtime.getModel('work', 'shared-model').provider, 'work');
  assert.equal(runtime.getRegisteredProviderConfig('work'), undefined);
  assert.ok(runtime.getRegisteredNativeProvider('work'));
});

test('native SDK key and headers are literal values, without a custom escaping/filtering layer', async () => {
  const runtime = await createModelRuntime();
  const key = '!echo do-not-execute';
  const header = '${HOME}';
  registerModelProvider(runtime, {
    ...definition('literal', [{ id: 'model', headers: { 'x-model': '!echo also-literal' } }]),
    headers: { 'x-provider': header },
  });
  await runtime.setRuntimeApiKey('literal', key);
  const resolved = await runtime.getAuth(runtime.getModel('literal', 'model'));
  assert.equal(resolved.auth.apiKey, key);
  assert.equal(resolved.auth.headers['x-provider'], header);
  assert.equal(resolved.auth.headers['x-model'], '!echo also-literal');
});

test('native replacement removes old models and headers instead of merging omitted configuration', async () => {
  const runtime = await createModelRuntime();
  registerModelProvider(runtime, { ...definition('replace', [{ id: 'before' }]), headers: { 'x-old': 'old' } });
  await runtime.setRuntimeApiKey('replace', 'fake-key');
  registerModelProvider(runtime, definition('replace', [{ id: 'after', reasoning: false }]));
  assert.equal(runtime.getModel('replace', 'before'), undefined);
  const current = runtime.getModel('replace', 'after');
  assert.equal(current.reasoning, false);
  assert.equal((await runtime.getAuth(current)).auth.headers?.['x-old'], undefined);
});

test('native provider preserves explicit model overrides and bearer authHeader behavior', async () => {
  const runtime = await createModelRuntime();
  registerModelProvider(runtime, { ...definition('override', [{
    id: 'custom', api: 'openai-responses', baseUrl: 'https://other.example.invalid/v2',
    input: ['text', 'image'], inputLimits: { maxRequestBytes: 1024 },
  }]), authHeader: true });
  await runtime.setRuntimeApiKey('override', 'fake-key');
  const model = runtime.getModel('override', 'custom');
  assert.equal(model.api, 'openai-responses');
  assert.equal(model.baseUrl, 'https://other.example.invalid/v2');
  assert.equal(model.inputLimits.maxRequestBytes, 1024);
  assert.equal((await runtime.getAuth(model)).auth.headers.Authorization, 'Bearer fake-key');
});

test('model-level header secrets do not leak through engine status snapshots', async () => {
  const { redactAgentSnapshot } = await import('../.dist/src/agent-model.js');
  const snapshot = {
    version: 1, source: 'inline', selection: { providerId: 'private', modelId: 'model' },
    providers: [{ ...definition('private', [{ id: 'model', headers: { 'x-secret': 'private-header-value' } }]), headers: { Authorization: 'private-provider-value' } }],
    credentials: [{ providerId: 'private', type: 'api_key', apiKey: 'private-credential-value' }],
  };
  const output = JSON.stringify(redactAgentSnapshot(snapshot));
  for (const secret of ['private-header-value', 'private-provider-value', 'private-credential-value']) assert.equal(output.includes(secret), false);
  assert.equal(snapshot.providers[0].models[0].headers['x-secret'], 'private-header-value');
});

test('a selected provider without credentials fails before a session can select an unrelated model', async () => {
  const { AgentModelRuntime } = await import('../.dist/src/agent-model.js');
  await assert.rejects(AgentModelRuntime.create({
    version: 1, source: 'inline', selection: { providerId: 'missing-key', modelId: 'shared-model', thinking: 'low' },
    providers: [definition('missing-key')], credentials: [],
  }, { engineDir: '/unused', agentKey: 'conversation' }), /未配置凭证/);
});
