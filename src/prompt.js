import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readText, fmtLocal } from './util.js';

export const MCFLY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function renderTemplate(tpl, vars) { return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] === undefined ? '' : String(vars[k]))); }
/** Шаг 2 прогона до 0.7.0 (ideas.enabled: false): без одобренной работы планировщик создаёт изменения сам. */
const LEGACY_FRONT = `   a. Есть одобренные изменения с открытыми задачами → реализуй их (шаги 3–5) в порядке из контекста, не больше {{MAX_CHANGES}} за прогон.
   b. Нет → планирование: субагент mcfly:planner (при необходимости mcfly:analyst и mcfly:architect) создаёт 1–2 новых изменения по правилам скилла mcfly-openspec, проверяет \`openspec validate <имя> --strict\` и запрашивает одобрение \`mcfly approval request <имя> --category spec\` (или \`--category prod\`, если изменение затрагивает прод-сервер, секреты или доступы). Затем переходи к шагу 6: реализация начнётся после одобрения.`;
/** Шаг 2 со списком предложений (0.7.0): новые изменения — только по пунктам, которые взял владелец. */
const IDEAS_FRONT = `   a. Есть одобренные изменения с открытыми задачами → реализуй их (шаги 3–5) в порядке из контекста, не больше {{MAX_CHANGES}} за прогон. Если при этом есть взятые владельцем пункты списка предложений, после шага 5 при запасе не меньше 30 минут до дедлайна спланируй по одному из них (как в b); это планирование не входит в лимит изменений.
   b. Нет одобренных, но есть взятые владельцем пункты («Взятые владельцем» в контексте) → субагент mcfly:planner (при необходимости mcfly:analyst и mcfly:architect) создаёт изменение по самому старому взятому пункту, не больше {{MAX_CHANGES}} за прогон, по правилам скилла mcfly-openspec. Первый раздел proposal.md — «## Простыми словами»: как будет работать, что даст, что понадобится от владельца. Проверь \`openspec validate <имя> --strict\` и запроси одобрение \`mcfly approval request <имя> --category spec --idea <Iн>\` (\`--category prod\`, если изменение затрагивает прод-сервер, секреты или доступы). Такой план молчанием не одобряется — ждёт кнопки владельца. Затем шаги 5a и 6.
   c. Нет ни одобренных изменений, ни взятых пунктов → новые изменения сами не планируй: только шаг 5a (с потолком прогона без работы) и шаг 6. Отклонённые изменения с \`mcfly.idea\` не перерабатывай — решение по ним владелец принимает в сессии; обычные отклонённые, как и раньше, перерабатывает планировщик.`;
/** Шаг 5a «Предложения» (0.7.0): пополнение списка по потолкам из ideas. */
function ideasStep(ideas) {
  const research = ideas.research
    ? 'похожие системы (\`--source research\`, \`--ref\` — ссылка на страницу): как похожие продукты решают то же; поиск в интернете — только внутри доли времени шага.'
    : 'поиск похожих систем выключен (ideas.research: false).';
  return `5a. Предложения (список mcfly/ideas.yaml, кнопка «💡 Предложения» в боте). Пропусти шаг, если до дедлайна меньше 20 минут. Потолок: обычный прогон — до ${ideas.per_run} новых пунктов и до 10 % времени прогона; прогон без работы (ветка 2c) — до ${ideas.per_idle_run} пунктов и до 25 % времени. Работу делает субагент mcfly:analyst; пункты добавляй только командой \`mcfly ideas add\` (ideas.yaml руками не правь). Источники по порядку:
   - бэклог владельца (${ideas.backlog || 'не задан — пропусти'}): перенеси в список все ещё не перенесённые пункты как есть, \`--source owner-backlog\`, \`--ref\` — место в бэклоге, без пересказа смысла; перенос бэклога идёт вне потолка пунктов; пункты, которые бэклог помечает сделанными или запрещёнными к планированию, не переноси;
   - идеи команды (\`--source team\`): по коду, отчётам прогонов и eval, повторяющимся замечаниям ревью;
   - ${research}
   Каждый пункт: \`--title\` (что предлагается, простыми словами), \`--benefit\` (что даст владельцу или пользователям), \`--size S|M|L\`, \`--how\` (как примерно), \`--needs-owner\` (что понадобится от владельца сверх «Берём», если понадобится; предпочитай то, что делается без владельца). Перед добавлением сверь с \`mcfly ideas list\`, бэклогом и архивом изменений; отклонённое без новых доводов (\`--new-arguments\`) не добавляй, пункты на обсуждении в сессии не трогай и не дублируй. Пункт без «Берём» никогда не превращается в работу. В отчёте перечисли новые пункты: «Новые предложения: I…».`;
}
export function buildLeadPrompt({ cfg, p, runId, mode, deadline, context, nightHandoff = '' }) {
  const tpl = readText(path.join(MCFLY_ROOT, 'prompts', 'run.md'));
  const ideasOn = !!cfg.ideas?.enabled;
  // Шаг 2 — сначала его плейсхолдеры ({{MAX_CHANGES}}), потом весь шаблон.
  const front = renderTemplate(ideasOn ? IDEAS_FRONT : LEGACY_FRONT, { MAX_CHANGES: cfg.limits.max_changes_per_run });
  return renderTemplate(tpl, {
    WORK_FRONT: front, IDEAS_STEP: ideasOn ? ideasStep(cfg.ideas) : '',
    RUN_ID: runId, MODE: mode, PROJECT: cfg.project, PROJECT_DIR: p.projectDir, MAX_MINUTES: cfg.run.max_minutes, DEADLINE: fmtLocal(deadline),
    MAX_CHANGES: cfg.limits.max_changes_per_run, MAX_TASKS: cfg.limits.max_tasks_per_change, CONTEXT: context, RUN_DIR: `mcfly/runs/${runId}`, NIGHT_HANDOFF: nightHandoff,
  });
}
