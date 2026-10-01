import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { spawnSync } from 'node:child_process';
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
export function git(dir, ...args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
/** Git-репозиторий с первым коммитом на main и локальным автором (не зависит от глобальной настройки). */
export function gitRepo(dir = tmpDir()) {
  git(dir, 'init', '-q', '-b', 'main');
  for (const [k, v] of [['user.email', 't@t'], ['user.name', 't'], ['commit.gpgsign', 'false']]) git(dir, 'config', k, v);
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
  return dir;
}
/** Ветка change/<имя> с tasks.md изменения; рабочее дерево возвращается на main. */
export function changeBranch(dir, name, tasks) {
  git(dir, 'checkout', '-q', '-b', `change/${name}`);
  fs.mkdirSync(path.join(dir, 'openspec', 'changes', name), { recursive: true });
  fs.writeFileSync(path.join(dir, 'openspec', 'changes', name, 'tasks.md'), tasks);
  git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', `feat(${name}): задачи`); git(dir, 'checkout', '-q', 'main');
}
/**
 * Подставной claude для run() проекта dir: печатает события stream-json и stderr, своё окружение пишет в envFile.
 * Файлы подставного claude лежат вне проекта, чтобы не попадать в git status.
 */
export function fakeClaude(dir, { lines = [], stderr = '', exitCode = 0 } = {}) {
  const bin = tmpDir('fake-claude-');
  const out = path.join(bin, 'out.jsonl'); const envFile = path.join(bin, 'env.txt'); const script = path.join(bin, 'claude.sh');
  fs.writeFileSync(out, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const err = stderr ? `printf '%s\\n' ${JSON.stringify(stderr)} >&2\n` : '';
  fs.writeFileSync(script, `#!/bin/sh\nenv > "${envFile}"\ncat "${out}"\n${err}exit ${exitCode}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'mcfly', 'config.yaml'), `project: demo\nrun:\n  claude_bin: ${script}\n  max_minutes: 1\n`);
  return { script, envFile };
}
/** Поддельный claude, который на каждой следующей попытке отвечает по-своему: attempts — [{ lines, stderr, exitCode }]. */
export function fakeClaudeSeq(dir, attempts, { config = '' } = {}) {
  const bin = tmpDir('fake-claude-seq-');
  const counter = path.join(bin, 'n'); const script = path.join(bin, 'claude.sh');
  let body = `#!/bin/sh\nn=$(cat "${counter}" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${counter}"\n`;
  attempts.forEach((a, i) => {
    const out = path.join(bin, `out${i + 1}.jsonl`);
    fs.writeFileSync(out, (a.lines || []).map((l) => JSON.stringify(l)).join('\n') + '\n');
    const err = a.stderr ? `printf '%s\\n' ${JSON.stringify(a.stderr)} >&2; ` : '';
    body += `if [ $n -eq ${i + 1} ]; then cat "${out}"; ${err}exit ${a.exitCode ?? 0}; fi\n`;
  });
  body += 'exit 0\n';
  fs.writeFileSync(script, body, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'mcfly', 'config.yaml'), `project: demo\nrun:\n  claude_bin: ${script}\n  max_minutes: 120\n${config}`);
  return { script, calls: () => Number(fs.readFileSync(counter, 'utf8').trim() || 0) };
}
export function addChange(dir, name, { tasks = '- [ ] первая\n- [x] нулевая\n', proposal = '# Proposal\n\nЗачем: тест.\n', meta = { schema: 'spec-driven' } } = {}) {
  const cdir = path.join(dir, 'openspec', 'changes', name);
  fs.mkdirSync(cdir, { recursive: true });
  fs.writeFileSync(path.join(cdir, 'tasks.md'), tasks);
  fs.writeFileSync(path.join(cdir, 'proposal.md'), proposal);
  fs.writeFileSync(path.join(cdir, '.openspec.yaml'), YAML.stringify(meta));
  return cdir;
}

/** Поддельный scutil: сервис service в состоянии state; start переводит в Connected (stuck — не переводит). Вызовы — в calls.log. */
export function fakeScutil({ service = 'Test VPN', state = 'Connected', stuck = false } = {}) {
  const bin = tmpDir('fake-scutil-');
  const stateFile = path.join(bin, 'state'); const calls = path.join(bin, 'calls.log'); const script = path.join(bin, 'scutil.sh');
  fs.writeFileSync(stateFile, state + '\n');
  fs.writeFileSync(script, `#!/bin/sh
echo "$2 $3" >> "${calls}"
[ "$3" = ${JSON.stringify(service)} ] || { echo "No service"; exit 1; }
case "$2" in
  status) cat "${stateFile}" ;;
  start) ${stuck ? 'true' : `echo Connected > "${stateFile}"`} ;;
esac
`, { mode: 0o755 });
  return { script, service, calls: () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : []), setState: (st) => fs.writeFileSync(stateFile, st + '\n') };
}

/** Образец передачи смены «день → ночь» со всеми обязательными разделами. */
export const HANDOFF = `# Смена: день → ночь, 2026-10-01 18:30 (источник: человек)
## Изменения
### llm-adaptation — ветка change/llm-adaptation @ 1a2b3c4, задач 4/10
- Где остановились: 2.3 наполовину
- Дальше: 2.3 → 2.4
## Порядок
1. llm-adaptation
2. page-map-seed
## Нужны решения человека
- нет
## Заметки
- нет
`;
