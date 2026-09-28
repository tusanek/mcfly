import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { MCFLY_ROOT } from './prompt.js';
import { paths } from './state.js';
import { ensureDir, exists, readText, writeText, appendText } from './util.js';

const MARK_START = '<!-- mcfly:start -->', MARK_END = '<!-- mcfly:end -->';

export function upsertSection(existing, section) {
  const block = `${MARK_START}\n${section.trim()}\n${MARK_END}`;
  if (existing.includes(MARK_START) && existing.includes(MARK_END)) return existing.replace(new RegExp(`${MARK_START}[\\s\\S]*?${MARK_END}`), block);
  return (existing.trim() ? existing.trimEnd() + '\n\n' : '') + block + '\n';
}
export function mergeSettings(existing, template) {
  const out = { ...existing, ...template, permissions: { ...(existing.permissions || {}) } };
  const deny = [...new Set([...(existing.permissions?.deny || []), ...(template.permissions?.deny || [])])];
  const allow = [...new Set([...(existing.permissions?.allow || []), ...(template.permissions?.allow || [])])];
  out.permissions.deny = deny; if (allow.length) out.permissions.allow = allow;
  return out;
}
export function ensureGitignore(projectDir, entries) {
  const file = path.join(projectDir, '.gitignore');
  const cur = readText(file, '');
  const have = new Set(cur.split('\n').map((l) => l.trim()));
  const missing = entries.filter((e) => !have.has(e));
  if (missing.length) appendText(file, (cur && !cur.endsWith('\n') ? '\n' : '') + '# mcfly\n' + missing.join('\n') + '\n');
  return missing;
}

export function init({ projectDir, name, withTracker = false, skipOpenspec = false, log = console.log }) {
  const p = paths(projectDir);
  const tpl = (f) => readText(path.join(MCFLY_ROOT, 'templates', f));
  const project = name || path.basename(projectDir);
  const created = [];
  const put = (file, content) => { if (exists(file)) return; writeText(file, content); created.push(path.relative(projectDir, file)); };
  ensureDir(p.runs); ensureDir(p.logs);
  put(p.config, tpl('config.yaml').replaceAll('{{PROJECT}}', project));
  put(p.progress, tpl('progress.md'));
  put(p.questions, 'questions: []\n');
  put(p.answers, tpl('answers.md'));
  put(p.metrics, '');
  put(path.join(p.root, '.env.example'), tpl('env.example'));
  const settingsPath = path.join(projectDir, '.claude', 'settings.json');
  const existing = exists(settingsPath) ? (JSON.parse(readText(settingsPath, '{}') || '{}')) : {};
  writeText(settingsPath, JSON.stringify(mergeSettings(existing, JSON.parse(tpl('settings.json'))), null, 2) + '\n');
  created.push('.claude/settings.json');
  const claudeMd = path.join(projectDir, 'CLAUDE.md');
  writeText(claudeMd, upsertSection(readText(claudeMd, ''), tpl('CLAUDE.snippet.md').replaceAll('{{PROJECT}}', project)));
  created.push('CLAUDE.md');
  if (withTracker) put(path.join(projectDir, '.mcp.json'), tpl('mcp.tracker.json'));
  ensureGitignore(projectDir, ['mcfly/.env', 'mcfly/state.json', 'mcfly/.lock', 'mcfly/logs/', 'mcfly/runs/*/stdout.log']);
  let openspec = 'пропущено';
  if (!skipOpenspec) {
    const which = spawnSync('which', ['openspec'], { encoding: 'utf8' });
    if (which.status !== 0) openspec = 'не установлен: npm install -g @fission-ai/openspec@latest && openspec init --tools claude';
    else { const r = spawnSync('openspec', ['init', '--tools', 'claude'], { cwd: projectDir, encoding: 'utf8' }); openspec = r.status === 0 ? 'инициализирован' : `ошибка init: ${String(r.stderr || r.stdout).trim().slice(0, 300)}`; }
  }
  log(`mcfly инициализирован в ${projectDir} (проект ${project}).`);
  for (const f of created) log(`  + ${f}`);
  log(`OpenSpec: ${openspec}`);
  log('Дальше: cp mcfly/.env.example mcfly/.env (впишите токен бота) → mcfly telegram pair → mcfly doctor → mcfly schedule install');
  return { created, openspec };
}
