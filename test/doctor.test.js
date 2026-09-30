import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path';
import { doctor } from '../src/doctor.js';
import { bareProject, tmpDir } from './helpers.js';

/** Проект, у которого в конфигурации свой claude и свой агент лида. */
function projectWithOwnClaude() {
  const dir = bareProject();
  const script = path.join(tmpDir('doctor-claude-'), 'claude.sh');
  fs.writeFileSync(script, `#!/bin/sh
case "$1" in
  --version) echo "9.9.9 (Fake Claude)" ;;
  auth) echo '{"loggedIn": true}' ;;
  *) echo '{"type":"result","is_error":false,"result":"ок"}' ;;
esac
`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'mcfly', 'config.yaml'), `project: demo\nrun:\n  claude_bin: ${script}\n  lead_agent: team:boss\n`);
  return dir;
}
test('doctor проверяет claude из run.claude_bin и агента из run.lead_agent', () => {
  const checks = doctor({ projectDir: projectWithOwnClaude(), probe: true, log: () => {} });
  const ok = (label) => checks.some((c) => c.ok && c.label.startsWith(label));
  assert.ok(ok('claude 9.9.9 (Fake Claude)'), JSON.stringify(checks.map((c) => c.label)));
  assert.ok(ok('claude CLI авторизован'));
  assert.ok(ok('пробный запуск claude -p с агентом team:boss'));
});
