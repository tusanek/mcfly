// Общие папки проекта в worktree команды (0.18.0): зависимости (например node_modules) ставятся один раз
// в основном каталоге, а worktree разработчика получает на них ссылки командой `mcfly worktree link`.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** Ошибки раздела worktree.shared: пути внутри проекта, относительные, без «..». */
export function sharedErrors(shared) {
  if (!Array.isArray(shared)) return ['worktree.shared: список путей, например [miniapp/node_modules]'];
  return shared.filter((s) => typeof s !== 'string' || !s.trim() || path.isAbsolute(s) || s.split(/[\\/]/).includes('..'))
    .map((s) => `worktree.shared: «${s}» — нужен путь внутри проекта, относительно его корня, без «..»`);
}

const clean = (s) => s.trim().replace(/^\.\//, '').replace(/\/+$/, '');

/**
 * Строки «/<путь>» (без косой черты в конце) в .git/info/exclude: правило `node_modules/` из .gitignore
 * ссылку на папку не скрывает — git видит её как обычный файл. Файл общий для всех worktree.
 */
export function ensureExcluded(mainDir, shared) {
  let common;
  try { common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: mainDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return []; }
  const file = path.join(path.resolve(mainDir, common), 'info', 'exclude');
  const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const have = new Set(cur.split('\n').map((l) => l.trim()));
  const missing = shared.map((s) => `/${clean(s)}`).filter((l) => !have.has(l));
  if (missing.length) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, (cur && !cur.endsWith('\n') ? '\n' : '') + '# mcfly worktree.shared\n' + missing.join('\n') + '\n');
  }
  return missing;
}

/** Ссылки на общие папки основного каталога в worktree: linked — создано, present — уже было, missing — нет в основном каталоге. */
export function linkShared({ worktreeDir, mainDir, shared }) {
  const r = { linked: [], present: [], missing: [] };
  if (!shared.length) return r;
  ensureExcluded(mainDir, shared);
  for (const s of shared.map(clean)) {
    const src = path.join(mainDir, s); const dst = path.join(worktreeDir, s);
    if (!fs.existsSync(src)) { r.missing.push(s); continue; }
    let st = null; try { st = fs.lstatSync(dst); } catch {}
    if (st) { r.present.push(s); continue; }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.symlinkSync(src, dst, 'dir');
    r.linked.push(s);
  }
  return r;
}

/** 0.19.3: папки зависимостей, которых нет в worktree (git их не отслеживает) — ищем их в основном каталоге. */
// 0.19.4: только node_modules. Виртуальное окружение Python ссылкой не подключают: с проектом, установленным для разработки
// (pip install -e), оно указывает на код основного каталога, и тесты в worktree проверяли бы не его код.
const DEP_DIRS = new Set(['node_modules']);
const SKIP_DIRS = new Set(['.git', '.claude', 'mcfly', 'openspec', 'dist', 'build']);
/**
 * Папки зависимостей основного каталога (до трёх уровней вглубь), которых нет в worktree.shared: в worktree команды их не будет,
 * и проверки, которым они нужны, там не запустить. Внутрь найденных папок не спускаемся.
 */
export function unsharedDeps(mainDir, shared, depth = 3) {
  const have = new Set((shared || []).map(clean)); const out = [];
  const walk = (rel, left) => {
    let entries = []; try { entries = fs.readdirSync(path.join(mainDir, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (DEP_DIRS.has(e.name)) { if (!have.has(r)) out.push(r); continue; }
      if (SKIP_DIRS.has(e.name) || left <= 1) continue;
      walk(r, left - 1);
    }
  };
  walk('', depth);
  return out.sort();
}
