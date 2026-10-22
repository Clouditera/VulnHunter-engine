import assert from 'node:assert/strict';
import { test } from 'node:test';
import { branchSummarize } from '../.dist/src/branch-summary.js';

function fixture(response, thinkingLevel = 'off') {
  const calls = [], changes = [];
  const session = {
    model: { provider: 'instance', id: 'model' }, thinkingLevel,
    modelRuntime: { completeSimple: async (...args) => { calls.push(args); return response; } },
    sessionManager: {
      getEntries: () => [
        { id: 'root', parentId: null, type: 'message', message: { role: 'user', content: 'excluded prefix' } },
        { id: 'start', parentId: 'root', type: 'message', message: { role: 'user', content: 'task definition' } },
        { id: 'leaf', parentId: 'start', type: 'message', message: { role: 'assistant', content: 'completed facts' } },
      ],
      getLeafId: () => 'leaf', getLabel: id => id === 'start' ? 'task-start' : undefined,
      branchWithSummary: (...args) => { changes.push(args); return 'summary'; },
      appendLabelChange: (...args) => changes.push(args),
    },
    refreshContext: () => changes.push('refresh'),
  };
  return { session, calls, changes };
}

test('summary uses the session SDK scope and off, preserving inclusive range and budget', async () => {
  const usage = { input: 10, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 13, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const f = fixture({ content: [{ type: 'text', text: 'summary' }], stopReason: 'stop', usage });
  const result = await branchSummarize(f.session, 'task-start', { summaryLabel: 'Σtask', guide: 'keep evidence' });
  assert.equal(f.calls.length, 1); assert.strictEqual(f.calls[0][0], f.session.model);
  assert.equal(f.calls[0][2].reasoning, undefined); assert.equal(f.calls[0][2].maxTokens, 32768);
  const input = f.calls[0][1].messages[0].content;
  assert.match(input, /task definition/); assert.match(input, /completed facts/); assert.doesNotMatch(input, /excluded prefix/);
  assert.deepEqual(result.coveredIds, ['start', 'leaf']); assert.equal(result.attachId, 'root');
  assert.strictEqual(f.changes[0][4], usage); assert.equal(f.changes.at(-1), 'refresh');
});

test('model failures and empty summaries do not modify the canonical session tree', async () => {
  for (const response of [{ content: [], stopReason: 'error', errorMessage: 'fixture failure' }, { content: [], stopReason: 'stop' }, { content: [], stopReason: 'aborted' }]) {
    const f = fixture(response, 'low');
    await assert.rejects(branchSummarize(f.session, 'task-start', { summaryLabel: 'Σtask' }));
    assert.equal(f.calls[0][2].reasoning, 'low'); assert.deepEqual(f.changes, []);
  }
});
