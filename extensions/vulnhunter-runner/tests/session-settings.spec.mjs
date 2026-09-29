import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionSettings } from '../.dist/src/session-settings.js';

test('child model choices stay in memory without losing Pi global/project settings semantics', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vh-session-settings-'));
  try {
    const engine = join(root, 'engine');
    const cwd = join(root, 'project');
    mkdirSync(engine); mkdirSync(join(cwd, '.pi'), { recursive: true });
    const globalPath = join(engine, 'settings.json');
    const projectPath = join(cwd, '.pi', 'settings.json');
    const global = JSON.stringify({ retry: { enabled: true, maxRetries: 3 }, defaultModel: 'old' });
    const project = JSON.stringify({ retry: { maxRetries: 7 } });
    writeFileSync(globalPath, global); writeFileSync(projectPath, project);
    const first = sessionSettings(cwd, engine);
    const second = sessionSettings(cwd, engine);
    first.setDefaultModelAndProvider('instance', 'selected');
    await first.flush();
    assert.equal(first.getDefaultModel(), 'selected');
    assert.equal(first.getRetrySettings().maxRetries, 7);
    assert.equal(first.getRetrySettings().enabled, true);
    assert.equal(second.getDefaultModel(), 'old');
    assert.equal(readFileSync(globalPath, 'utf8'), global);
    assert.equal(readFileSync(projectPath, 'utf8'), project);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
