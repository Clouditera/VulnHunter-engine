import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentModelRegistry } from '../.dist/src/agent-model.js';
import { auditModelSnapshots } from '../.dist/src/extension-models.js';
import runnerExtension from '../.dist/index.js';
import { workflows } from '../.dist/src/workflows/registry.js';

const parentSnapshot = () => ({
  version: 7, source: 'inline', selection: { providerId: 'work', modelId: 'shared', thinking: 'low' },
  providers: ['work', 'personal'].map(id => ({ id, providerType: "zai", name: id, api: 'openai-completions', baseUrl: 'https://example.invalid/v1',
    models: [{ id: 'shared', reasoning: true, headers: { 'x-literal': '${HOME}' } }] })),
  credentials: ['work', 'personal'].map(providerId => ({ providerId, type: 'api_key', apiKey: `fake-${providerId}-key` })),
});

test('child pools capture independent provider/key snapshots, preserving inherited and explicit choices', async () => {
  const parent = parentSnapshot();
  const snapshots = auditModelSnapshots(parent, { hunt: 'personal/shared:high', verify: 'work/shared:off' });
  assert.equal(snapshots.init.selection.thinking, 'low');
  assert.equal(snapshots.hunt.selection.providerId, 'personal');
  assert.equal(snapshots.hunt.selection.thinking, 'high');
  assert.equal(snapshots.verify.selection.thinking, 'off');
  const registry = await AgentModelRegistry.create(snapshots, { engineDir: '/unused-no-file-source', agentKey: '' });
  parent.credentials[0].apiKey = 'changed-parent-key';
  for (const pool of ['init', 'hunt', 'verify']) {
    const { runtime, model, selection } = registry.current(pool);
    const auth = await runtime.getAuth(model);
    assert.equal(model.provider, "zai");
    assert.notEqual(model.provider, selection.providerId);
    assert.equal(auth.auth.apiKey, `fake-${selection.providerId}-key`);
    assert.equal(auth.auth.headers['x-literal'], '${HOME}');
  }
});

test('platform runner injection and task model changes never reopen provider/auth files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vh-memory-runner-'));
  const workflow = workflows.get('audit-lite');
  const original = workflow.run;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let context;
  workflow.run = async ctx => { context = ctx; await gate; };
  const tools = new Map();
  const parent = parentSnapshot();
  runnerExtension({ registerTool: tool => tools.set(tool.name, tool), registerShortcut() {} }, { getModelSnapshot: () => structuredClone(parent) });
  const invoke = args => tools.get('vulnhunter').execute('fixture-call', args, undefined, undefined, { cwd: root });
  try {
    await invoke({ op: 'run', workflow: 'audit-lite' });
    assert.ok(context.modelRegistry);
    assert.equal(context.modelRegistry.current('hunt').selection.thinking, 'low');
    parent.selection = { providerId: 'personal', modelId: 'shared', thinking: 'high' };
    await invoke({ op: 'model', pool: 'hunt', model: 'work/shared:off' });
    assert.equal(context.modelRegistry.current('hunt').selection.thinking, 'off');
    assert.equal(context.modelRegistry.current('init').selection.providerId, 'work');
    await assert.rejects(invoke({ op: 'model', pool: 'hunt', model: 'work/shared:max' }), /不支持思考档/);
    assert.equal(context.modelRegistry.current('hunt').selection.thinking, 'off');
    const metadata = readFileSync(join(root, '.vulnforge/system/model.json'), 'utf8');
    assert.equal(JSON.parse(metadata).hunt, 'work/shared:off');
    assert.equal(metadata.includes('fake-work-key'), false);
  } finally {
    release(); await new Promise(resolve => setImmediate(resolve));
    workflow.run = original; rmSync(root, { recursive: true, force: true });
  }
});
