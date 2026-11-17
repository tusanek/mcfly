import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { MCFLY_ROOT } from './prompt.js';
import { paths } from './state.js';
import { ensureDir, exists, readText, writeText, appendText } from './util.js';
import { loadConfig } from './config.js';

const MARK_START = '<!-- mcfly:start -->', MARK_END = '<!-- mcfly:end -->';

export function upsertSection(existing, section) {
  const block = `${MARK_START}\n${section.trim()}\n${MARK_END}`;
  if (existing.includes(MARK_START) && existing.includes(MARK_END)) return existing.replace(new RegExp(`${MARK_START}[\\s\\S]*?${MARK_END}`), block);
  return (existing.trim() ? existing.trimEnd() + '\n\n' : '') + block + '\n';
}
export function mergeSettings(existing, template) {
  const out = { ...template, ...existing, permissions: { ...(existing.permissions || {}) } }; // значения пользователя главнее шаблона
  const deny = [...new Set([...(existing.permissions?.deny || []), ...(template.permissions?.deny || [])])];
  const allow = [...new Set([...(existing.permissions?.allow || []), ...(template.permissions?.allow || [])])];
  out.permissions.deny = deny; if (allow.length) out.permissions.allow = allow;
  return out;
}
/** Файлы mcfly вне git: секреты, локальное состояние, лок прогона, логи launchd, сырой вывод claude. */
export const GITIGNORE_ENTRIES = ['mcfly/.env', 'mcfly/state.json', 'mcfly/.lock', 'mcfly/logs/', 'mcfly/runs/*/stdout.log', '.DS_Store'];
export function ensureGitignore(projectDir, entries) {
  const file = path.join(projectDir, '.gitignore');
  const cur = readText(file, '');
  const have = new Set(cur.split('\n').map((l) => l.trim()));
  const missing = entries.filter((e) => !have.has(e));
  if (missing.length) appendText(file, (cur && !cur.endsWith('\n') ? '\n' : '') + '# mcfly\n' + missing.join('\n') + '\n');
  return missing;
}

/**
 * Чего не хватает, чтобы в проекте была ветка main (0.11.0): строка для владельца или '' — всё в порядке либо это не git.
 * Команда создаёт ветки изменений от main и сливает в неё; с master прогоны шли на допущении «master вместо main».
 */
export function mainBranchIssue(projectDir) {
  const git = (args) => spawnSync('git', args, { cwd: projectDir, encoding: 'utf8' });
  if (git(['rev-parse', '--is-inside-work-tree']).status !== 0) return '';
  if (git(['rev-parse', '--verify', '-q', 'refs/heads/main']).status === 0) return '';
  const cur = String(git(['symbolic-ref', '--short', '-q', 'HEAD']).stdout || '').trim();
  if (cur === 'main') return ''; // репозиторий без коммитов, ветка уже называется main
  return `В проекте нет ветки main — команда работает от неё. ${cur ? `Сейчас ветка «${cur}»: переименуйте её командой git branch -m ${cur} main` : 'Создайте её: git branch main'}`;
}

export function init({ projectDir, name, withTracker = false, skipOpenspec = false, log = console.log }) {
  const p = paths(projectDir);
  const tpl = (f) => readText(path.join(MCFLY_ROOT, 'templates', f));
  // 0.15.7: повторный init без --name берёт имя из настроек проекта — раньше подставлял название папки в блок CLAUDE.md
  let configured = '';
  if (exists(p.config)) { try { configured = String(loadConfig(p.config).project || ''); } catch { configured = ''; } }
  const project = name || configured || path.basename(projectDir);
  const firstTime = !exists(p.env); // секреты ещё не вписаны — владельцу нужна полная подсказка
  const created = [];
  const put = (file, content) => { if (exists(file)) return; writeText(file, content); created.push(path.relative(projectDir, file)); };
  ensureDir(p.runs); ensureDir(p.logs); ensureDir(p.shifts);
  // 0.11.0: пустой каталог git не видит — `git add mcfly/shifts` падал, и файлы первого прогона оставались незакоммиченными
  put(path.join(p.shifts, '.gitkeep'), '');
  put(p.config, tpl('config.yaml').replaceAll('{{PROJECT}}', project));
  put(p.progress, tpl('progress.md'));
  put(p.questions, 'questions: []\n');
  put(p.ideas, tpl('ideas.yaml'));
  put(p.answers, tpl('answers.md'));
  put(path.join(p.root, 'product.md'), tpl('product.md'));
  put(p.metrics, '');
  put(path.join(p.root, '.env.example'), tpl('env.example'));
  const settingsPath = path.join(projectDir, '.claude', 'settings.json');
  const existing = exists(settingsPath) ? (JSON.parse(readText(settingsPath, '{}') || '{}')) : {};
  // 0.15.7: файл попадает в список, только если его содержимое изменилось
  const update = (file, content) => { if (readText(file, null) === content) return; writeText(file, content); created.push(path.relative(projectDir, file)); };
  update(settingsPath, JSON.stringify(mergeSettings(existing, JSON.parse(tpl('settings.json'))), null, 2) + '\n');
  const claudeMd = path.join(projectDir, 'CLAUDE.md');
  update(claudeMd, upsertSection(readText(claudeMd, ''), tpl('CLAUDE.snippet.md').replaceAll('{{PROJECT}}', project)));
  if (withTracker) put(path.join(projectDir, '.mcp.json'), tpl('mcp.tracker.json'));
  ensureGitignore(projectDir, GITIGNORE_ENTRIES);
  let openspec = 'пропущено';
  if (!skipOpenspec) {
    const which = spawnSync('which', ['openspec'], { encoding: 'utf8' });
    if (which.status !== 0) openspec = 'не установлен: npm install -g @fission-ai/openspec@latest && openspec init --tools claude';
    else { const r = spawnSync('openspec', ['init', '--tools', 'claude'], { cwd: projectDir, encoding: 'utf8' }); openspec = r.status === 0 ? 'инициализирован' : `ошибка init: ${String(r.stderr || r.stdout).trim().slice(0, 300)}`; }
  }
  log(`mcfly инициализирован в ${projectDir} (проект ${project}).`);
  for (const f of created) log(`  + ${f}`);
  if (!created.length) log('  файлы без изменений');
  log(`OpenSpec: ${openspec}`);
  // 0.11.0: процесс команды ждёт ветку main (ветки изменений создаются от неё) — `git init` мог создать master
  const branch = mainBranchIssue(projectDir);
  if (branch) log(`⚠ ${branch}`);
  // schedule install — сразу после привязки чата: без задания answers бот не отвечает на кнопки и сообщения
  log(!firstTime ? 'Дальше: mcfly doctor — проверить, что всё на месте' : 'Дальше: cp mcfly/.env.example mcfly/.env (впишите токен бота) → mcfly telegram pair → mcfly schedule install (без него бот не отвечает на кнопки) → mcfly doctor');
  return { created, openspec, branch };
}
