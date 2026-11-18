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
