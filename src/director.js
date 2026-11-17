import fs from 'node:fs';
import path from 'node:path';
import { runProcess, cleanEnv, parseResult } from './claude.js';
import { MCFLY_ROOT } from './prompt.js';
import { lastUsage } from './chain.js';
import { videoPaths, projectSlug, renderStills } from './video.js';
import { checkStoryboard, toScenes, parseRemarks, applyRemarks, sceneList } from './storyboard.js';
import { ensureDir, writeJson, pad2, readText } from './util.js';
import { parseDotenv } from './env.js';

// 0.15.0: сценарий ролика-сводки пишет роль-режиссёр, зритель один раз смотрит кадры и сверяет факты. Запускается из задания
// сводки, после отправки текста. Оба работают в своей папке вне проекта. Любой отказ — сцены из кода (запасной вариант):
// ролик приходит всегда.

const DIRECTOR = 'mcfly:director';
const VIEWER = 'mcfly:user';
const QUOTA_STOP = 0.9; // недельный лимит подписки занят на столько и больше — режиссёра не запускаем
const KEEP_WORK = 8;
const TOOLS = { [DIRECTOR]: 'Read,Write,Glob', [VIEWER]: 'Read,Glob' }; // зрителю — только смотреть

/** Один запуск роли без диалога в папке cwd. Возвращает { ok, text, reason }, не бросает. */
export async function runAgent(cfg, { agent, prompt, cwd, timeoutMs, run = runProcess, tools = 'Read,Glob', hide = [] }) {
  // Роль читает данные сводки, а в них текст из проекта и сообщений владельца — возможна подстановка указаний. Поэтому:
  // инструменты только из списка tools (без командной строки и сети), подключённые серверы не грузятся, а токен бота и
  // секреты проекта из окружения убраны. acceptEdits — чтобы режиссёр писал storyboard.json без вопроса: в -p спросить некого,
  // запись вне рабочей папки при этом отклоняется. Задание — последним аргументом и не сразу после списка инструментов.
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--strict-mcp-config', '--tools', tools, '--plugin-dir', MCFLY_ROOT, '--agent', agent, prompt];
  const env = cleanEnv(process.env);
  for (const k of [cfg.telegram?.token_env, ...hide]) if (k) delete env[k];
  const r = await run({ bin: cfg.run.claude_bin, args, cwd, env, timeoutMs });
  const parsed = parseResult(r);
  return { ok: parsed.status === 'ok', text: parsed.resultText, reason: parsed.status === 'ok' ? '' : `${parsed.status}: ${parsed.errorText.split('\n')[0].slice(0, 200)}` };
}

/** Есть ли о чём рассказывать: в пустую ночь режиссёр не нужен. */
const worthDirecting = (data, weekly) => (weekly ? (data?.features || []).length > 0 : (data?.plain || []).length > 0 || (data?.demos || []).length > 0 || (data?.done || []).length > 0);

/** Рабочая папка запуска: данные без разметки сообщений, запасные сцены, памятка. Старые папки — кроме последних восьми — удаляются. */
function prepareWork(cfg, { data, baseScenes, now, vp }) {
  const root = path.join(vp.home, 'work', projectSlug(cfg.project));
  const stamp = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
  let dir = path.join(root, stamp); for (let n = 2; fs.existsSync(dir); n += 1) dir = path.join(root, `${stamp}-${n}`);
  ensureDir(dir);
  const { html: _h, keyboard: _k, ...rest } = data;
  // Утренние данные: у завершённых изменений образец уже лежит в done, поэтому отдельным списком идут только образцы того,
  // что ещё в работе, — иначе данные раздуваются вдвое, а режиссёр путает сделанное с будущим
  if (Array.isArray(rest.done) && Array.isArray(rest.demos)) rest.demos = rest.demos.filter((d) => d.ahead);
  writeJson(path.join(dir, 'data.json'), rest);
  writeJson(path.join(dir, 'base.json'), baseScenes.map(({ key: _key, hold: _hold, ...s }) => s));
  fs.copyFileSync(path.join(MCFLY_ROOT, 'prompts', 'video-guide.md'), path.join(dir, 'GUIDE.md'));
  const old = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  for (const name of old.slice(0, Math.max(0, old.length - KEEP_WORK))) fs.rmSync(path.join(root, name), { recursive: true, force: true });
  return dir;
}

/**
 * Сцены ролика от режиссёра. mode: 'off' — сцены из кода; 'on' — режиссёр; 'review' — режиссёр, зритель и один круг правок.
 * Возвращает { scenes, source: 'director' | 'review' | 'fallback', reason, workDir }; никогда не бросает.
 * Режиссёр не справился (сбой, время, раскадровка не принята проверкой) — запасные сцены. Сбой на круге зрителя — остаётся
 * принятая раскадровка режиссёра без сцен, в которых зритель нашёл выдумку.
 */
export async function directScenes(p, cfg, { data, baseScenes, weekly = false, now = new Date(), mode = cfg.video.director, vp = videoPaths(cfg), agent = runAgent, stills = renderStills, log = () => {}, clock = Date.now } = {}) {
  let workDir = null;
  const fallback = (reason) => { if (reason) log(`Режиссёр ролика: ${reason} — ролик из запасных сцен.`); return { scenes: baseScenes, source: 'fallback', reason, workDir }; };
  if (mode === 'off') return fallback('');
  try {
    if (!worthDirecting(data, weekly)) return fallback('рассказывать нечего');
    const usage = lastUsage(p);
    if (usage && usage.seven_day >= QUOTA_STOP) return fallback('недельный лимит подписки занят на 90 % и больше');
    workDir = prepareWork(cfg, { data, baseScenes, now, vp });
    const hide = Object.keys(parseDotenv(readText(p.env, '')));
    const deadline = clock() + cfg.video.director_minutes * 60_000;
    const call = async (role, prompt) => {
      const left = deadline - clock();
      if (left <= 0) throw new Error('вышло время, отведённое режиссёру');
      const r = await agent(cfg, { agent: role, prompt, cwd: workDir, timeoutMs: left, tools: TOOLS[role], hide });
      if (!r.ok) throw new Error(r.reason || 'сбой запуска');
      return r;
    };
    const board = path.join(workDir, 'storyboard.json');
    const read = () => { try { return JSON.parse(fs.readFileSync(board, 'utf8')); } catch { return undefined; } };
    const check = (raw) => checkStoryboard(raw, data, cfg, { weekly });
    const done = (list, source) => { writeJson(board, list); return { scenes: toScenes(list, cfg), source, reason: '', workDir }; };
    const limit = weekly ? cfg.video.weekly_max_seconds : cfg.video.max_seconds;

    await call(DIRECTOR, `Напиши раскадровку ${weekly ? 'недельного ролика (итоги недели)' : 'утреннего ролика (утренняя сводка)'}, не длиннее ${limit} секунд. Порядок работы — в твоей инструкции: GUIDE.md, data.json, base.json → storyboard.json.`);
    let raw = read(); let errors = check(raw);
    if (errors.length) {
      fs.writeFileSync(path.join(workDir, 'violations.txt'), `${errors.join('\n')}\n`);
      await call(DIRECTOR, `Раскадровка не принята проверкой. Нарушения — в violations.txt:\n- ${errors.slice(0, 12).join('\n- ')}\nИсправь и запиши storyboard.json заново, целиком.`);
      raw = read(); errors = check(raw);
      if (errors.length) return fallback(`раскадровка не принята проверкой: ${errors[0]}`);
    }
    const first = sceneList(raw);
    if (mode !== 'review') return done(first, 'director');

    // Круг зрителя — строго один. Что бы на нём ни сломалось, раскадровка режиссёра уже принята.
    writeJson(path.join(workDir, 'storyboard.v1.json'), first);
    let remarks = []; let revised = null; let trouble = '';
    try {
      await stills(cfg, { scenes: toScenes(first, cfg), dir: path.join(workDir, 'stills'), weekly, now, vp, timeoutMs: Math.max(1, deadline - clock()) });
      const seen = await call(VIEWER, 'Посмотри ролик-сводку (раздел «Если тебя зовут смотреть ролик-сводку» твоей инструкции): storyboard.json, кадры stills/NN.png, данные data.json. Ответ — только массив JSON с замечаниями.');
      remarks = parseRemarks(seen.text);
      if (!remarks.length) {
        if (!/^\s*(\[\s*\])?\s*$/.test(seen.text)) { fs.writeFileSync(path.join(workDir, 'viewer.txt'), seen.text); log('Режиссёр ролика: ответ зрителя не разобран (сохранён в viewer.txt) — остаётся раскадровка без правки.'); }
        return done(first, 'director');
      }
      writeJson(path.join(workDir, 'remarks.json'), remarks);
      await call(DIRECTOR, 'Зритель посмотрел ролик и оставил замечания в remarks.json (scene — номер сцены, kind: fact — утверждение не подтверждается данными). Исправь по существу и запиши storyboard.json заново, целиком.');
      let after = read(); let bad = check(after);
      if (bad.length) { // как и первой раскадровке — одна попытка исправить нарушения, иначе работа зрителя пропадает из-за мелочи
        fs.writeFileSync(path.join(workDir, 'violations.txt'), `${bad.join('\n')}\n`);
        await call(DIRECTOR, `Исправленная раскадровка не принята проверкой. Нарушения — в violations.txt:\n- ${bad.slice(0, 12).join('\n- ')}\nИсправь и запиши storyboard.json заново, целиком.`);
        after = read(); bad = check(after);
      }
      if (bad.length === 0) revised = sceneList(after);
      else { trouble = `правка по замечаниям зрителя не принята проверкой: ${bad[0]}`; if (after !== undefined) writeJson(path.join(workDir, 'storyboard.rejected.json'), after); }
    } catch (e) { trouble = `круг зрителя не состоялся: ${String(e?.message || e).slice(0, 200)}`; }
    if (trouble) log(`Режиссёр ролика: ${trouble} — остаётся раскадровка до правки.`);
    const final = applyRemarks(first, revised, remarks);
    const left = check(final);
    if (left.length) return fallback(`после замечаний зрителя раскадровка не принята: ${left[0]}`);
    return done(final, revised ? 'review' : 'director');
  } catch (e) {
    return fallback(String(e?.message || e).replace(/\s+/g, ' ').slice(0, 300));
  }
}
