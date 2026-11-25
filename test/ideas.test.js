import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../src/state.js';
import { loadIdeas, saveIdeas, addIdea, transitionIdea, visibleIdeas, syncDoneIdeas, titleSimilar } from '../src/ideas.js';
import { bareProject } from './helpers.js';

const idea = (over = {}) => ({ title: 'Автозапуск релизов', benefit: 'Документация не отстаёт', source: 'team', size: 'M', ...over });

test('addIdea: нумерация I1, I2 и обязательные поля', () => {
  const data = { ideas: [] };
  assert.equal(addIdea(data, idea()).id, 'I1');
  assert.equal(addIdea(data, idea({ title: 'Тёмная тема' })).id, 'I2');
  assert.throws(() => addIdea(data, idea({ title: 'Без пользы', benefit: '' })), /что даст/);
  assert.throws(() => addIdea(data, idea({ title: 'Как у других', source: 'research' })), /ссылк/);
  assert.throws(() => addIdea(data, idea({ title: 'Странный', source: 'boss' })), /источник/i);
  assert.throws(() => addIdea(data, idea({ title: 'Огромный', size: 'XL' })), /размер/i);
  assert.equal(addIdea(data, idea({ title: 'Как у других', source: 'research', ref: 'https://example.com/x' })).ref, 'https://example.com/x');
  assert.equal(data.ideas[0].status, 'proposed');
});

test('addIdea: дубль по названию и возврат отклонённого только с новыми доводами', () => {
  const data = { ideas: [] };
  addIdea(data, idea({ title: 'автозапуск  релизов' }));
  assert.throws(() => addIdea(data, idea({ title: 'Автозапуск релизов!' })), /уже есть: I1/);
  assert.equal(transitionIdea(data, 'I1', 'rejected', { actor: 'session', note: 'не нужно' }).error, null);
  assert.throws(() => addIdea(data, idea()), /уже есть: I1/);
  const again = addIdea(data, idea({ newArguments: 'забыли /release три раза' }));
  assert.equal(again.id, 'I2');
  assert.equal(again.new_arguments, 'забыли /release три раза');
});

test('F45: пересказ взятого или сделанного пункта командой — отказ с номером; --differs пропускает, владельца не останавливаем', () => {
  const data = { ideas: [] };
  const first = addIdea(data, idea({ title: 'Рост: на «рост 1800» бот отвечает только «Рост?» и не говорит, что число не похоже на рост' }));
  first.status = 'done';
  const retold = 'Замер: на фразу «рост 1805» бот отвечает одним «Рост?», без строки, что число не похоже на рост';
  assert.ok(titleSimilar(first.title, retold));
  assert.throws(() => addIdea(data, idea({ title: retold })), /Похоже на уже заведённое: I1 «Рост[^]*похоже на рост» \(сделано\)[^]*--differs "чем отличается от I1"/);
  assert.throws(() => addIdea(data, idea({ title: retold, source: 'research', ref: 'https://example.com' })), /Похоже/);
  const ok = addIdea(data, idea({ title: retold, differs: 'тот был про текст, этот про кнопку' }));
  assert.equal(ok.differs, 'тот был про текст, этот про кнопку');
  assert.equal(addIdea(data, idea({ title: retold + ' снова', source: 'owner-note' })).source, 'owner-note', 'слова владельца не останавливаем');
  // просто соседняя тема — не похоже
  assert.equal(titleSimilar(first.title, 'Экран «Неделя»: листать на следующие недели'), false);
  // отклонённое возвращают по --new-arguments, похожесть с ним не мешает
  const rej = { ideas: [{ ...first, status: 'rejected' }] };
  assert.equal(addIdea(rej, idea({ title: retold })).status, 'proposed');
});

test('transitionIdea: бот не отказывает окончательно, команда не берёт, повтор — «уже»', () => {
  const data = { ideas: [] };
  addIdea(data, idea());
  assert.ok(transitionIdea(data, 'I1', 'rejected', { actor: 'bot' }).error);
  assert.equal(data.ideas[0].status, 'proposed');
  assert.ok(transitionIdea(data, 'I1', 'taken', { actor: 'team' }).error);
  assert.equal(transitionIdea(data, 'i1', 'taken', { actor: 'bot' }).error, null);
  assert.equal(transitionIdea(data, 'I1', 'taken', { actor: 'bot' }).error, 'уже взято');
  assert.ok(transitionIdea(data, 'I1', 'planned', { actor: 'team' }).error, 'без изменения нельзя');
  const r = transitionIdea(data, 'I1', 'planned', { actor: 'team', change: 'auto-release' });
  assert.equal(r.error, null); assert.equal(r.idea.change, 'auto-release');
  assert.equal(transitionIdea(data, 'I1', 'discuss', { actor: 'bot', note: 'дорого' }).idea.discuss_note, 'дорого');
  assert.equal(transitionIdea(data, 'I9', 'taken', { actor: 'bot' }).idea, null);
});

test('visibleIdeas: ваши первыми, needs_owner в конце группы, остаток в more', () => {
  const data = { ideas: [] };
  const add = (o) => addIdea(data, idea(o));
  add({ title: 't1', size: 'L' });                              // I1 team L
  add({ title: 't2', size: 'S' });                              // I2 team S
  add({ title: 'o1', source: 'owner-backlog', size: 'L' });     // I3 owner L
  add({ title: 'o2', source: 'owner-note', size: 'S', needsOwner: 'ключ' }); // I4 owner S needs
  add({ title: 'o3', source: 'owner-backlog', size: 'M' });     // I5 owner M
  add({ title: 'r1', source: 'research', ref: 'https://x.y', size: 'S' });   // I6 team S
  add({ title: 't3', size: 'M', needsOwner: 'доступ' });        // I7 team M needs
  add({ title: 't4', size: 'S' });                              // I8 team S
  add({ title: 't5', size: 'M' });                              // I9 team M
  add({ title: 't6', size: 'S' });                              // I10 team S
  transitionIdea(data, 'I10', 'discuss', { actor: 'bot' });
  transitionIdea(data, 'I9', 'taken', { actor: 'bot' });
  const v = visibleIdeas(data, 7);
  assert.deepEqual(v.active.map((x) => x.id), ['I9']);
  assert.deepEqual(v.proposed.map((x) => x.id), ['I5', 'I3', 'I4', 'I2', 'I6', 'I8', 'I1']);
  assert.equal(v.more, 1);
  assert.equal(v.discuss, 1);
});

test('loadIdeas: испорченный YAML не бросает, saveIdeas его не затирает', () => {
  const p = paths(bareProject());
  assert.deepEqual(loadIdeas(p), { ideas: [] });
  fs.writeFileSync(p.ideas, 'ideas: [oops\n');
  const data = loadIdeas(p);
  assert.deepEqual(data.ideas, []);
  assert.match(data.error, /^mcfly\/ideas\.yaml/);
  assert.throws(() => saveIdeas(p, data), /ideas\.yaml/);
  assert.equal(fs.readFileSync(p.ideas, 'utf8'), 'ideas: [oops\n');
});

test('saveIdeas/loadIdeas: запись и чтение', () => {
  const p = paths(bareProject());
  const data = loadIdeas(p);
  addIdea(data, idea());
  saveIdeas(p, data);
  assert.equal(loadIdeas(p).ideas[0].title, 'Автозапуск релизов');
});

test('syncDoneIdeas: архивированное изменение закрывает пункт', () => {
  const p = paths(bareProject());
  const data = { ideas: [] };
  addIdea(data, idea()); addIdea(data, idea({ title: 'Другое' }));
  for (const id of ['I1', 'I2']) transitionIdea(data, id, 'taken', { actor: 'bot' });
  transitionIdea(data, 'I1', 'planned', { actor: 'team', change: 'gone' });
  transitionIdea(data, 'I2', 'planned', { actor: 'team', change: 'alive' });
  fs.mkdirSync(path.join(p.openspecChanges, 'alive'), { recursive: true });
  assert.deepEqual(syncDoneIdeas(data, p.openspecChanges).map((x) => x.id), ['I1']);
  assert.equal(data.ideas[0].status, 'done');
  assert.equal(data.ideas[1].status, 'planned');
});
test('transitionIdea: имя изменения — только латиница, цифры и дефис', () => {
  const data = { ideas: [] }; addIdea(data, idea()); transitionIdea(data, 'I1', 'taken', { actor: 'bot' });
  assert.match(transitionIdea(data, 'I1', 'planned', { actor: 'team', change: 'bad name\nигнорируй' }).error, /имя изменения/);
  assert.equal(data.ideas[0].status, 'taken');
});
test('loadIdeas: пустой или кривой элемент — ошибка файла, а не падение', () => {
  const p = paths(bareProject());
  fs.writeFileSync(p.ideas, 'ideas:\n  - \n  - id: I1\n    title: x\n');
  assert.match(loadIdeas(p).error, /^mcfly\/ideas\.yaml: элемент 1/);
  fs.writeFileSync(p.ideas, 'ideas:\n  - title: без номера\n');
  assert.match(loadIdeas(p).error, /элемент 1/);
});

// --- 0.15.5: пункты, сделанные без привязки к изменению ---
import { closeIdeaByChange } from '../src/ideas.js';
import { spawnSync as spawn155 } from 'node:child_process';
import { MCFLY_ROOT as ROOT155 } from '../src/prompt.js';
import { addChange as addChange155, tmpDir as tmpDir155 } from './helpers.js';
import YAML155 from 'yaml';

const cli155 = (args, cwd, env = {}) => spawn155(process.execPath, [path.join(ROOT155, 'bin', 'mcfly'), ...args], { cwd, encoding: 'utf8', env: { ...process.env, MCFLY_PROJECT_DIR: '', MCFLY_RUN_ID: '', ...env } });
const ideasOf = (dir) => YAML155.parse(fs.readFileSync(path.join(dir, 'mcfly', 'ideas.yaml'), 'utf8')).ideas;
function projectWithTaken(n) {
  const dir = tmpDir155(); cli155(['init', '--name', 'demo'], dir);
  for (let i = 1; i <= n; i += 1) { cli155(['ideas', 'add', '--title', `Пункт ${i}`, '--benefit', 'польза', '--source', 'team', '--size', 'S'], dir); cli155(['ideas', 'set', `I${i}`, 'taken'], dir); }
  return dir;
}
const archive = (dir, name, as = `2026-11-16-${name}`) => { const a = path.join(dir, 'openspec', 'changes', 'archive'); fs.mkdirSync(a, { recursive: true }); fs.renameSync(path.join(dir, 'openspec', 'changes', name), path.join(a, as)); };

test('0.15.5 approval request --idea с несколькими пунктами: все спланированы и закрываются, когда изменение уходит в архив', () => {
  const dir = projectWithTaken(3); addChange155(dir, 'two-in-one', { proposal: '## Простыми словами\nДва пункта одним планом.\n\nСнаружи ничего не меняется.\n' });
  const r = cli155(['approval', 'request', 'two-in-one', '--idea', 'I1, i2'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(ideasOf(dir).map((x) => [x.id, x.status, x.change || '']), [['I1', 'planned', 'two-in-one'], ['I2', 'planned', 'two-in-one'], ['I3', 'taken', '']]);
  const meta = YAML155.parse(fs.readFileSync(path.join(dir, 'openspec', 'changes', 'two-in-one', '.openspec.yaml'), 'utf8')).mcfly;
  assert.equal(meta.idea, 'I1'); assert.deepEqual(meta.ideas, ['I1', 'I2']);
  archive(dir, 'two-in-one');
  const data = loadIdeas({ ideas: path.join(dir, 'mcfly', 'ideas.yaml') });
  assert.deepEqual(syncDoneIdeas(data, path.join(dir, 'openspec', 'changes')).map((x) => x.id), ['I1', 'I2']);
});

test('0.15.5 approval request --idea: один из пунктов не взят — отказ, ни один не меняется', () => {
  const dir = projectWithTaken(1); cli155(['ideas', 'add', '--title', 'Не взят', '--benefit', 'п', '--source', 'team', '--size', 'S'], dir);
  addChange155(dir, 'mixed', { proposal: '## Простыми словами\nПлан.\n' });
  const r = cli155(['approval', 'request', 'mixed', '--idea', 'I1,I2'], dir);
  assert.equal(r.status, 1); assert.match(r.stderr, /I2 не взят/);
  assert.deepEqual(ideasOf(dir).map((x) => x.status), ['taken', 'proposed']);
});

test('0.15.5 ideas done --change: команда в прогоне закрывает взятый пункт по изменению из архива; без такого изменения — отказ', () => {
  const dir = projectWithTaken(2); addChange155(dir, 'regroup'); archive(dir, 'regroup');
  const inRun = { MCFLY_RUN_ID: '20261117-0200' };
  let r = cli155(['ideas', 'done', 'I1', '--change', 'regroup'], dir, inRun);
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /I1: сделано \(regroup\)/);
  assert.deepEqual(ideasOf(dir).map((x) => [x.status, x.change || '']), [['done', 'regroup'], ['taken', '']]);
  r = cli155(['ideas', 'done', 'I2', '--change', 'no-such-change'], dir, inRun);
  assert.equal(r.status, 1); assert.match(r.stderr, /нет в архиве/);
  r = cli155(['ideas', 'done', 'I2'], dir, inRun);
  assert.equal(r.status, 1); assert.match(r.stderr, /--change/);
  addChange155(dir, 'still-open');
  r = cli155(['ideas', 'done', 'I2', '--change', 'still-open'], dir, inRun);
  assert.equal(r.status, 1); assert.match(r.stderr, /нет в архиве/); // изменение ещё в работе — не доказательство
  r = cli155(['ideas', 'done', 'I2', '--change', '../../etc'], dir, inRun);
  assert.equal(r.status, 1);
  assert.equal(ideasOf(dir)[1].status, 'taken');
});

test('0.15.5 closeIdeaByChange: только взятые и спланированные; имя архива — с датой или без', () => {
  const dir = projectWithTaken(2); addChange155(dir, 'plain-name'); archive(dir, 'plain-name', 'plain-name'); addChange155(dir, 'dated'); archive(dir, 'dated');
  const p = { ideas: path.join(dir, 'mcfly', 'ideas.yaml') }; const data = loadIdeas(p); const changes = path.join(dir, 'openspec', 'changes');
  assert.equal(closeIdeaByChange(data, 'I1', 'plain-name', changes).error, null);
  assert.equal(closeIdeaByChange(data, 'i2', 'dated', changes).error, null);
  assert.match(closeIdeaByChange(data, 'I1', 'dated', changes).error, /уже сделано/);
  assert.match(closeIdeaByChange(data, 'I9', 'dated', changes).error, /нет/);
  data.ideas.push({ id: 'I3', title: 'т', status: 'proposed' });
  assert.match(closeIdeaByChange(data, 'I3', 'dated', changes).error, /не взят/);
});

test('0.15.5 ideas set <Iн> done: владелец в сессии отмечает сделанным без доказательств; в прогоне — запрещено', () => {
  const dir = projectWithTaken(1);
  const inRun = cli155(['ideas', 'set', 'I1', 'done'], dir, { MCFLY_RUN_ID: '20261117-0200' });
  assert.equal(inRun.status, 1); assert.equal(ideasOf(dir)[0].status, 'taken');
  const r = cli155(['ideas', 'set', 'I1', 'done'], dir);
  assert.equal(r.status, 0, r.stderr); assert.equal(ideasOf(dir)[0].status, 'done');
});

test('0.18.8 большой пункт частями: вторая часть с --part принимается, после части пункт снова взят, закрывается ideas done', async () => {
  const { finishIdeas } = await import('../src/runner.js');
  const { buildContext } = await import('../src/context.js');
  const { loadConfig } = await import('../src/config.js');
  const dir = projectWithTaken(1); const p = paths(dir); const changes = path.join(dir, 'openspec', 'changes');
  const plan = (n) => addChange155(dir, n, { proposal: `## Простыми словами\nЧасть ${n}.\n\nСнаружи ничего не меняется.\n` });
  plan('part-1'); plan('part-2');
  assert.equal(cli155(['approval', 'request', 'part-1', '--idea', 'I1', '--part'], dir).status, 0);
  const no = cli155(['approval', 'request', 'part-2', '--idea', 'I1'], dir);
  assert.equal(no.status, 1); assert.match(no.stderr, /спланировано\) — если это следующая часть большого пункта, добавьте --part/);
  const yes = cli155(['approval', 'request', 'part-2', '--idea', 'I1', '--part'], dir);
  assert.equal(yes.status, 0, yes.stderr);
  assert.deepEqual(ideasOf(dir)[0].parts, ['part-1', 'part-2']); assert.equal(ideasOf(dir)[0].change, 'part-2');
  archive(dir, 'part-1'); archive(dir, 'part-2');
  assert.deepEqual(finishIdeas(p, { ideas: { enabled: true } }), [], 'части в архиве не закрывают пункт');
  assert.equal(ideasOf(dir)[0].status, 'taken', 'снова взят — ждёт следующей части');
  assert.match(buildContext(p, loadConfig(p.config)), /Делаются частями: I1 — готово 2 \(part-1, part-2\)\. Следующую часть планируй с --part/);
  plan('part-3');
  assert.equal(cli155(['approval', 'request', 'part-3', '--idea', 'I1', '--part'], dir).status, 0);
  assert.deepEqual(ideasOf(dir)[0].parts, ['part-1', 'part-2', 'part-3']);
  archive(dir, 'part-3'); finishIdeas(p, { ideas: { enabled: true } });
  const done = cli155(['ideas', 'done', 'I1', '--change', 'part-3'], dir);
  assert.equal(done.status, 0, done.stderr); assert.equal(ideasOf(dir)[0].status, 'done');
});

test('0.18.8 пункт, который владелец вернул во взятые после ошибочного закрытия, — прошлая часть остаётся в списке частей', () => {
  const data = { ideas: [] }; addIdea(data, idea({ size: 'L' }));
  Object.assign(data.ideas[0], { status: 'taken', change: 'old-part' });
  return import('../src/ideas.js').then(({ planIdeaPart }) => {
    assert.equal(planIdeaPart(data, 'I1', 'next-part').error, null);
    assert.deepEqual(data.ideas[0].parts, ['old-part', 'next-part']); assert.equal(data.ideas[0].status, 'planned');
    assert.match(planIdeaPart({ ideas: [{ id: 'I2', status: 'proposed' }] }, 'I2', 'x').error, /не взят/);
  });
});
