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
export function addChange(dir, name, { tasks = '- [ ] первая\n- [x] нулевая\n', proposal = '# Proposal\n\nЗачем: тест.\n', meta = { schema: 'spec-driven' } } = {}) {
  const cdir = path.join(dir, 'openspec', 'changes', name);
  fs.mkdirSync(cdir, { recursive: true });
  fs.writeFileSync(path.join(cdir, 'tasks.md'), tasks);
  fs.writeFileSync(path.join(cdir, 'proposal.md'), proposal);
  fs.writeFileSync(path.join(cdir, '.openspec.yaml'), YAML.stringify(meta));
  return cdir;
}
