import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path';
import { buildContext, hasProduct } from '../src/context.js';
import { buildLeadPrompt, MCFLY_ROOT } from '../src/prompt.js';
import { parseConfig } from '../src/config.js';
import { doctor } from '../src/doctor.js';
import { init } from '../src/init.js';
import { paths } from '../src/state.js';
import { listChanges, requestApproval, proposalSamples } from '../src/approvals.js';
import { summaryKeyboard } from '../src/summary.js';
import { sendSamples, ideasView, statsView, helpView } from '../src/overview.js';
import { callbackText } from '../src/telegram.js';
import { parseMessage, applyMessages } from '../src/answers.js';
import { loadIdeas, saveIdeas, addIdea, transitionIdea } from '../src/ideas.js';
import { cfg, bareProject, addChange, tmpDir } from './helpers.js';

const PROPOSAL = `# Proposal

## Простыми словами
Вечером бот спрашивает про дела на завтра.

## Как это будет выглядеть

### Вечером, в 22:30
\`\`\`
Что добавить на завтра?
Можно голосом.
[Готово] [Ничего не добавлять]
[Позже]
\`\`\`

Пояснение между образцами в образцы не попадает.

### Утром
\`\`\`
План на понедельник
1. Взвеситься
\`\`\`

## Why
Потому что.
`;
const fakeTg = () => { const sent = []; return { sent, async sendMessage(chatId, text, o = {}) { sent.push({ chatId, text, ...o }); return [{ message_id: sent.length }]; } }; };
const product = (dir, text) => fs.writeFileSync(path.join(dir, 'mcfly', 'product.md'), text);

test('0.10.0: описание продукта и цели попадают в контекст; шаблон из одних подсказок — нет', () => {
  const dir = bareProject(); const p = paths(dir);
  assert.equal(hasProduct(p), false);
  assert.doesNotMatch(buildContext(p, cfg), /Описание продукта|Цели проекта|Навыки дизайна/);
  product(dir, fs.readFileSync(path.join(MCFLY_ROOT, 'templates', 'product.md'), 'utf8'));
  assert.equal(hasProduct(p), false, 'шаблон — только подсказка в комментарии');
  assert.doesNotMatch(buildContext(p, cfg), /Описание продукта/);
  product(dir, '<!-- подсказка -->\n## Что это\nЛичный ассистент.\n## Правила\nНичего с потолка.\n');
  fs.writeFileSync(path.join(dir, 'mcfly', 'goals.md'), '## Цель\nПлан с утра.\n- [ ] Приём дел голосом\n');
  const ctx = buildContext(p, { ...cfg, design: { skills: ['impeccable'] } });
  assert.equal(hasProduct(p), true);
  assert.match(ctx, /## Описание продукта \(mcfly\/product\.md\)[^\n]*\n## Что это\nЛичный ассистент\.\n## Правила\nНичего с потолка\./);
  assert.doesNotMatch(ctx, /подсказка/);
  assert.match(ctx, /## Цели проекта \(mcfly\/goals\.md\)[^\n]*\n## Цель\nПлан с утра\.\n- \[ \] Приём дел голосом/);
  assert.match(ctx, /Навыки дизайна \(design\.skills\): impeccable — /);
  product(dir, `## Что это\n${'я'.repeat(16000)}`);
  const long = buildContext(p, cfg);
  assert.match(long, /…обрезано, полный текст — в файле/); assert.ok(long.length < 17000 + buildContext(paths(bareProject()), cfg).length);
});

test('0.10.0: шаг «Глазами пользователя» в задании прогона — только при описании продукта', () => {
  const dir = bareProject(); const p = paths(dir);
  const prompt = () => buildLeadPrompt({ cfg, p, runId: 'r1', mode: 'day', deadline: new Date(2026, 10, 15, 12), context: 'ctx' });
  assert.doesNotMatch(prompt(), /4a\.|mcfly:user|\{\{UX_STEP\}\}/);
  product(dir, '## Что это\nАссистент.\n');
  assert.match(prompt(), /4a\. Глазами пользователя\.[^\n]*mcfly:user[^\n]*«мешает пользоваться»[^\n]*двух кругов/);
  assert.ok(prompt().indexOf('4a. Глазами пользователя') > prompt().indexOf('4. Проверка.') && prompt().indexOf('4a. Глазами пользователя') < prompt().indexOf('5. Интеграция.'));
});

test('0.10.0: proposalSamples — подзаголовок, блок, ряды кнопок; без блоков и без раздела — пусто', () => {
  assert.deepEqual(proposalSamples({ proposal: PROPOSAL }), [
    { title: 'Вечером, в 22:30', text: 'Что добавить на завтра?\nМожно голосом.', buttons: [['Готово', 'Ничего не добавлять'], ['Позже']] },
    { title: 'Утром', text: 'План на понедельник\n1. Взвеситься', buttons: [] },
  ]);
  assert.deepEqual(proposalSamples({ proposal: '# P\n## Как это будет выглядеть\nСнаружи ничего не меняется.\n## Why\nx\n' }), []);
  assert.deepEqual(proposalSamples({ proposal: '# P\n## Why\n```\nкод не образец\n```\n' }), [], 'блок вне раздела — не образец');
  assert.deepEqual(proposalSamples({ proposal: '## Как это будет выглядеть\n```\nтекст со [ссылкой] внутри строки\n[Да]\n```\n' }),
    [{ title: '', text: 'текст со [ссылкой] внутри строки', buttons: [['Да']] }], 'кнопки — только строка целиком из скобок');
  assert.deepEqual(proposalSamples({}), []);
});

test('0.10.0: кнопка «Как будет выглядеть» под планом — только если в плане есть образцы', () => {
  const dir = bareProject(); const p = paths(dir);
  addChange(dir, 'evening-talk', { proposal: PROPOSAL }); addChange(dir, 'plain-fix');
  for (const c of listChanges(p.openspecChanges)) requestApproval(c);
  const rows = summaryKeyboard(p, cfg).map((r) => r.map((b) => b.callback_data));
  assert.deepEqual(rows, [['ap:evening-talk', 'rj:evening-talk'], ['sh:evening-talk'], ['ap:plain-fix', 'rj:plain-fix'], ['qu:1']]);
  const show = summaryKeyboard(p, cfg).flat().find((b) => b.callback_data === 'sh:evening-talk');
  assert.equal(show.text, '👀 Как будет выглядеть: план 1', 'та же подпись, что на кнопке одобрения');
  assert.equal(callbackText('sh:evening-talk'), 'образец evening-talk');
  assert.deepEqual(parseMessage('образец evening-talk'), { type: 'sample', change: 'evening-talk' });
  assert.deepEqual(parseMessage(callbackText('sm:0.0.1')), { type: 'sampleTap' });
});

test('0.10.0: образцы приходят отдельными сообщениями с ненастоящими кнопками; нет образцов — понятный ответ', async () => {
  const dir = bareProject(); const p = paths(dir);
  addChange(dir, 'evening-talk', { proposal: PROPOSAL }); addChange(dir, 'plain-fix');
  const tg = fakeTg();
  assert.equal(await sendSamples(tg, '42', p, cfg, 'evening-talk'), 2);
  assert.deepEqual(tg.sent.map((m) => m.text), [
    '👀 <b>Как будет выглядеть: «Вечером бот спрашивает про дела на завтра»</b>\n<i>Ниже образцы — так это увидит пользователь. Кнопки под ними ненастоящие.</i>',
    '<i>1. Вечером, в 22:30</i>\n\nЧто добавить на завтра?\nМожно голосом.',
    '<i>2. Утром</i>\n\nПлан на понедельник\n1. Взвеситься',
  ], '0.11.0: заголовок и образец — одним сообщением');
  assert.deepEqual(tg.sent[1].keyboard.map((r) => r.map((b) => b.text)), [['Готово', 'Ничего не добавлять'], ['Позже']]);
  assert.ok(tg.sent[1].keyboard.flat().every((b) => /^sm:/.test(b.callback_data)), 'кнопки образца ничего не делают');
  assert.equal(tg.sent[2].keyboard, null);
  const none = fakeTg();
  assert.equal(await sendSamples(none, '42', p, cfg, 'plain-fix'), 0); assert.match(none.sent[0].text, /нет образцов: снаружи ничего не меняется/);
  const gone = fakeTg();
  assert.equal(await sendSamples(gone, '42', p, cfg, 'no-such'), 0); assert.match(gone.sent[0].text, /Такого плана уже нет/);
  // нажатие ненастоящей кнопки и просьба образца не становятся заметкой для команды
  const before = fs.readFileSync(p.answers, 'utf8');
  assert.deepEqual(applyMessages(p, [{ text: 'образец кнопка' }, { text: 'образец evening-talk' }]), []);
  assert.equal(fs.readFileSync(p.answers, 'utf8'), before);
});

test('0.10.0: «неудобно: …» — пункт сразу взят, помечен и стоит первым среди взятых', () => {
  const dir = bareProject(); const p = paths(dir);
  const data = loadIdeas(p);
  const old = addIdea(data, { title: 'Поиск по заметкам', benefit: 'находить', source: 'team', size: 'M' });
  transitionIdea(data, old.id, 'taken', { actor: 'bot' }); saveIdeas(p, data);
  assert.deepEqual(parseMessage('Неудобно: слишком длинный план\nне дочитываю до конца'), { type: 'ux', text: 'слишком длинный план\nне дочитываю до конца' });
  assert.equal(parseMessage('неудобно получилось вчера').type, 'note', 'без двоеточия — обычная заметка');
  const acks = applyMessages(p, [{ text: 'неудобно: слишком длинный план\nне дочитываю до конца' }, { text: 'неудобно:' }]);
  assert.match(acks[0], /^😖 I2 принял — команда займётся этим первым делом/); assert.match(acks[1], /Напишите после «неудобно:»/);
  const idea = loadIdeas(p).ideas.find((x) => x.id === 'I2');
  assert.equal(idea.status, 'taken'); assert.equal(idea.ux, true); assert.equal(idea.title, 'слишком длинный план'); assert.equal(idea.benefit, 'не дочитываю до конца');
  assert.equal(idea.source, 'owner-note');
  assert.match(fs.readFileSync(p.answers, 'utf8'), /— неудобно I2\nслишком длинный план/);
  const ctx = buildContext(p, cfg);
  assert.match(ctx, /Взятые владельцем — спланируй по порядку: I2 «слишком длинный план», I1 «Поиск по заметкам» \(I2 — жалобы «неудобно», планируй и делай их первыми\)/);
  assert.match(ideasView(p, cfg).join('\n'), /😖 I2 — неудобно, команда займётся первым делом: слишком длинный план\n⏳ I1 — ждёт прогона: Поиск по заметкам|⏳ I1 — ждёт прогона: Поиск по заметкам\n😖 I2 — неудобно/);
  assert.match(helpView(p, cfg).join('\n'), /😖 «неудобно: текст»/);
});

test('0.10.0: находки «пользователя» видны в статистике, только когда они есть', () => {
  const dir = bareProject(); const p = paths(dir);
  assert.doesNotMatch(statsView(p, cfg).join('\n'), /удобств/);
  fs.writeFileSync(p.metrics, `${JSON.stringify({ type: 'event', at: new Date().toISOString(), key: 'ux_issues', value: 3 })}\n`);
  assert.match(statsView(p, cfg).join('\n'), /😖 находок по удобству: 3/);
});

test('0.10.0: design.skills — список названий; doctor проверяет, что навык установлен', () => {
  assert.deepEqual(parseConfig('project: demo\n').design.skills, []);
  assert.deepEqual(parseConfig('project: demo\ndesign:\n  skills: [impeccable, "frontend-design:frontend-design"]\n').design.skills, ['impeccable', 'frontend-design:frontend-design']);
  assert.throws(() => parseConfig('project: demo\ndesign:\n  skills: impeccable\n'), /design\.skills/);
  assert.throws(() => parseConfig('project: demo\ndesign:\n  skills: ["rm -rf"]\n'), /design\.skills/);
  const dir = bareProject();
  const claude = path.join(tmpDir('ux-claude-'), 'claude.sh');
  fs.writeFileSync(claude, '#!/bin/sh\ncase "$1" in --version) echo 9.9.9 ;; auth) echo \'{"loggedIn": true}\' ;; esac\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'mcfly', 'config.yaml'), `project: demo\nrun:\n  claude_bin: ${claude}\ndesign:\n  skills: [no-such-skill-xyz, local-skill, "plug:skill"]\n`);
  fs.mkdirSync(path.join(dir, '.claude', 'skills', 'local-skill'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'skills', 'local-skill', 'SKILL.md'), '---\nname: local-skill\n---\n');
  const checks = doctor({ projectDir: dir, log: () => {} });
  const find = (re) => checks.find((c) => re.test(c.label));
  assert.equal(find(/навык дизайна no-such-skill-xyz/).ok, false); assert.match(find(/навык дизайна no-such-skill-xyz/).hint, /установите навык/);
  assert.equal(find(/навык дизайна local-skill \(в проекте\)/).ok, true);
  assert.ok(find(/навык дизайна plug:skill: из дополнения/));
});

test('0.10.0: mcfly init кладёт шаблон описания продукта и не затирает готовое', () => {
  const dir = tmpDir();
  init({ projectDir: dir, name: 'demo', skipOpenspec: true, log: () => {} });
  const file = path.join(dir, 'mcfly', 'product.md');
  assert.match(fs.readFileSync(file, 'utf8'), /^<!--\nОписание продукта для команды mcfly/);
  assert.equal(hasProduct(paths(dir)), false);
  fs.writeFileSync(file, '## Что это\nМоё.\n');
  init({ projectDir: dir, name: 'demo', skipOpenspec: true, log: () => {} });
  assert.equal(fs.readFileSync(file, 'utf8'), '## Что это\nМоё.\n');
});

test('0.10.0: роли знают про образцы и удобство', () => {
  const read = (...f) => fs.readFileSync(path.join(MCFLY_ROOT, ...f), 'utf8');
  assert.match(read('agents', 'user.md'), /^---\nname: user\n/); assert.match(read('agents', 'user.md'), /«Мешает пользоваться»[\s\S]*«Можно лучше»/);
  assert.match(read('agents', 'user.md'), /mcfly metric add --key ux_issues/);
  assert.doesNotMatch(/^tools: (.+)$/m.exec(read('agents', 'user.md'))[1], /\b(Write|Edit)\b/, '«пользователь» ничего не правит');
  assert.match(read('agents', 'designer.md'), /## Как это будет выглядеть/); assert.match(read('agents', 'designer.md'), /design\.skills/);
  assert.match(read('agents', 'planner.md'), /`## Как это будет выглядеть`[\s\S]*mcfly:designer|mcfly:designer[\s\S]*`## Как это будет выглядеть`/);
  assert.match(read('skills', 'mcfly-process', 'SKILL.md'), /## Удобство \(0\.10\.0\)/);
  assert.match(read('prompts', 'run.md'), /\{\{UX_STEP\}\}/);
});
