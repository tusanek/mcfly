import { spawnSync } from 'node:child_process';
import { listChanges, approvedWithWork, expireApprovals } from './approvals.js';
import { readMetrics } from './metrics.js';
import { appendText, fmtLocal } from './util.js';

const pct = (x) => `${Math.round((x || 0) * 100)} %`;

/** Последние известные доли лимитов подписки ({ five_hour, seven_day } от 0 до 1) из записей прогонов; null — данных нет. */
export function lastUsage(p) {
  const runs = readMetrics(p).filter((r) => r.type === 'run' && r.usage && r.usage.seven_day != null);
  return runs.length ? runs.at(-1).usage : null;
}

/** Коммиты команды за прогон (на всех ветках), кроме служебных коммитов runner'а: признак, что прогон продвинул работу. */
export function teamCommitsSince(projectDir, since) {
  const r = spawnSync('git', ['log', '--all', `--since=${since.toISOString()}`, '--format=%s'], { cwd: projectDir, encoding: 'utf8' });
  return String(r.stdout || '').split('\n').filter((s) => s.trim() && !/^chore\(mcfly\):/.test(s)).length;
}

/** Сколько прогонов цепочки было за последние 24 часа. */
export function chainedRunsLastDay(p, now = new Date()) {
  return readMetrics(p).filter((r) => r.type === 'run' && r.chained && now - new Date(r.started_at) < 24 * 3600_000).length;
}

/** Хватает ли лимитов подписки для следующего прогона: { ok, reason }. */
export function quotaAllows(cfg, usage) {
  if (!(cfg.run.chain_max_weekly > 0)) return { ok: false, reason: 'цепочка выключена (run.chain_max_weekly: 0)' };
  if (!usage) return { ok: false, reason: 'нет данных о лимите подписки' };
  if (usage.seven_day >= cfg.run.chain_max_weekly) return { ok: false, reason: `недельный лимит ${pct(usage.seven_day)} (порог ${pct(cfg.run.chain_max_weekly)})` };
  if (usage.five_hour != null && usage.five_hour >= cfg.run.chain_max_five_hour) return { ok: false, reason: `пятичасовой лимит ${pct(usage.five_hour)}` };
  return { ok: true, reason: `неделя ${pct(usage.seven_day)}` };
}

/**
 * Цепочка прогонов: после прогона запускать следующий, если осталась одобренная работа, лимиты позволяют,
 * прогон продвинул работу (иначе следующий упрётся в то же) и цепочка за сутки не длиннее run.chain_max_runs.
 * Возвращает { chain, reason } — причина пишется в итог прогона.
 */
export function chainDecision({ cfg, p, record, projectDir, started, now = new Date() }) {
  if (!(cfg.run.chain_max_weekly > 0)) return { chain: false, reason: '' };
  if (record.status !== 'ok') return { chain: false, reason: 'прогон завершился не «ок»' };
  if (!approvedWithWork(listChanges(p.openspecChanges)).length) return { chain: false, reason: '' };
  const q = quotaAllows(cfg, record.usage);
  if (!q.ok) return { chain: false, reason: q.reason };
  if (teamCommitsSince(projectDir, started) === 0) return { chain: false, reason: 'прогон не продвинул работу — нужен взгляд человека' };
  if (chainedRunsLastDay(p, now) >= cfg.run.chain_max_runs) return { chain: false, reason: `за сутки уже ${cfg.run.chain_max_runs} прогонов цепочки` };
  return { chain: true, reason: q.reason };
}

/**
 * Для задания answers (раз в цикл): авто-одобрить изменения с истёкшим сроком (мелкие — через small_approval_deadline_hours)
 * и, если прогон не идёт и лимиты позволяют, запустить прогон. Возвращает строки для Telegram (пусто — ничего не произошло).
 */
export function autoApproveAndStart({ cfg, p, now = new Date(), isRunning, startRun }) {
  if (isRunning()) return [];
  const approved = expireApprovals(listChanges(p.openspecChanges), cfg, now);
  if (!approved.length) return [];
  for (const c of approved) appendText(p.answers, `\n## ${fmtLocal(now)} — ${c.name} одобрено автоматически (срок истёк)\n`);
  const lines = approved.map((c) => `⏱ Одобрено автоматически (срок истёк): ${c.name}`);
  const q = quotaAllows(cfg, lastUsage(p));
  if (q.ok && cfg.run.telegram_start !== false) { startRun(); lines.push(`▶️ Запускаю прогон (${q.reason})`); }
  else lines.push(`Прогон не запущен: ${q.reason}. Возьмёт ближайший прогон по расписанию или «запусти».`);
  return lines;
}
