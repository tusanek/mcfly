import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import YAML from 'yaml';
import { DEFAULT_CONFIG } from '../src/config.js';
export const cfg = { ...DEFAULT_CONFIG, project: 'demo' };
export function tmpDir(prefix = 'mcfly-test-') { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
/** Пустой проект mcfly без вызова init (init тестируется отдельно). */
export function bareProject() {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'mcfly', 'runs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'mcfly', 'config.yaml'), 'project: demo\n');
  fs.writeFileSync(path.join(dir, 'mcfly', 'questions.yaml'), 'questions: []\n');
  fs.writeFileSync(path.join(dir, 'mcfly', 'answers.md'), '# Ответы\n');
  fs.writeFileSync(path.join(dir, 'mcfly', 'progress.md'), '# Журнал\n');
  return dir;
}
/** Подставной claude для run(): пишет своё окружение в <dir>/claude-env.txt, печатает события stream-json и stderr. */
export function fakeClaude(dir, { lines = [], stderr = '', exitCode = 0 } = {}) {
  const out = path.join(dir, 'fake-claude.out');
  fs.writeFileSync(out, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const script = path.join(dir, 'fake-claude.sh');
  const err = stderr ? `printf '%s\\n' ${JSON.stringify(stderr)} >&2\n` : '';
  fs.writeFileSync(script, `#!/bin/sh\nenv > "${path.join(dir, 'claude-env.txt')}"\ncat "${out}"\n${err}exit ${exitCode}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'mcfly', 'config.yaml'), `project: demo\nrun:\n  claude_bin: ${script}\n  max_minutes: 1\n`);
  return script;
}
export function addChange(dir, name, { tasks = '- [ ] первая\n- [x] нулевая\n', proposal = '# Proposal\n\nЗачем: тест.\n', meta = { schema: 'spec-driven' } } = {}) {
  const cdir = path.join(dir, 'openspec', 'changes', name);
  fs.mkdirSync(cdir, { recursive: true });
  fs.writeFileSync(path.join(cdir, 'tasks.md'), tasks);
  fs.writeFileSync(path.join(cdir, 'proposal.md'), proposal);
  fs.writeFileSync(path.join(cdir, '.openspec.yaml'), YAML.stringify(meta));
  return cdir;
}
