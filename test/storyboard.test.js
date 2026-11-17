import test from 'node:test';
import assert from 'node:assert/strict';
import { checkStoryboard, toScenes, parseRemarks, applyRemarks, SCENE_KINDS, SCENE_ENTER } from '../src/storyboard.js';
import { cfg } from './helpers.js';

const SAMPLE = { change: 'repeat', title: 'Повторы', text: 'Твои повторы:\n1. Зарядка — каждый день\n2. Таблетка — по вторникам\nЧто убрать? Напиши номер или нажми кнопку ниже.', buttons: [['Убрать 1', 'Вернуть']] };
const DATA = { plain: [{ slot: '00:00', text: 'Что сделано: повторы.\nЗачем: удобно.' }], demos: [SAMPLE], work: [], runStats: { ok: 2 } };
const WEEKLY_DATA = { features: [{ title: 'Повторы', benefit: 'Дела появляются сами', weight: 2, sample: { text: SAMPLE.text, buttons: SAMPLE.buttons } }], goals: { done: 3, total: 5 } };
const GOOD = [
  { kind: 'hook', title: 'Повторы больше не теряются', lines: ['Два новых умения'], speech: 'За ночь бот научился сам вести повторяющиеся дела, и это ещё не всё.' },
  { kind: 'chat', title: 'Повторы', lines: ['Список одним сообщением'], speech: 'Все повторяющиеся дела теперь видны списком, лишнее убирается одним касанием.', chat: { text: SAMPLE.text, buttons: [['Убрать 1', 'Вернуть']] } },
  { kind: 'number', title: 'Ночь без сбоев', lines: [], number: { value: 2, label: 'запуска команды' }, speech: 'Команда отработала дважды, и оба раза без сбоев.' },
  { kind: 'finale', title: 'Хорошего дня', lines: [], speech: 'На сегодня это всё. Хорошего дня.' },
];
const bad = (patch, re, opts) => assert.match(checkStoryboard(patch(structuredClone(GOOD)), DATA, cfg, opts).join('\n'), re);

test('принята годная раскадровка — списком и в виде { scenes }', () => {
  assert.deepEqual(checkStoryboard(GOOD, DATA, cfg), []);
  assert.deepEqual(checkStoryboard({ scenes: GOOD }, DATA, cfg), []);
});
test('не список, сцена-строка, lines числом — нарушения, а не исключение', () => {
  for (const raw of [null, undefined, 'x', 7, { scenes: 5 }, ['сцена', 'сцена', 'сцена'], [null, null, null], [{ kind: 'text', title: 'а', lines: 3, speech: 'достаточно длинная речь' }, GOOD[1], GOOD[2]], [{ kind: 'chat', title: 'а', lines: [], speech: 'достаточно длинная речь для экрана чата, больше пятидесяти шести знаков', chat: 'нет' }, GOOD[2], GOOD[3]]]) {
    assert.ok(checkStoryboard(raw, DATA, cfg).length > 0, JSON.stringify(raw)?.slice(0, 40));
  }
  assert.ok(checkStoryboard(GOOD, null, cfg).length > 0); // данных нет — образцов нет
});
test('меньше трёх и больше шестнадцати сцен', () => {
  assert.match(checkStoryboard(GOOD.slice(0, 2), DATA, cfg).join('\n'), /трёх сцен/);
  assert.match(checkStoryboard(Array.from({ length: 17 }, () => GOOD[3]), DATA, cfg).join('\n'), /больше 16/);
});
test('неизвестный вид и появление; все виды из списка известны', () => {
  bad((s) => { s[0].kind = 'zoom'; return s; }, /неизвестный вид/);
  bad((s) => { s[0].enter = 'spin'; return s; }, /появление/);
  assert.deepEqual(SCENE_KINDS, ['text', 'chat', 'hook', 'number', 'compare', 'steps', 'finale']); assert.deepEqual(SCENE_ENTER, ['up', 'left', 'scale', 'fade']);
});
test('обязательные поля видов', () => {
  bad((s) => { delete s[2].number; return s; }, /number/);
  bad((s) => { s[2] = { kind: 'compare', title: 'Было и стало', lines: [], speech: 'Раньше было так, а теперь стало иначе.' }; return s; }, /compare/);
  bad((s) => { s[2] = { kind: 'steps', title: 'Шаги', lines: ['один'], speech: 'Шагов тут всего один, так нельзя.' }; return s; }, /от 2 до 6/);
  bad((s) => { s[0].title = ''; return s; }, /нет заголовка/);
  bad((s) => { s[0].speech = 'Ой'; return s; }, /нет текста диктора/);
  bad((s) => { s[0].bar = { done: 1, total: 0 }; return s; }, /bar/);
});
test('поля оформления: цвет — имя или #rrggbb, значок и стиль — из списка, ярлык — короткая строка', () => {
  bad((s) => { s[0].accent = 'red'; return s; }, /accent/);
  bad((s) => { s[0].tag = 'x'.repeat(25); return s; }, /tag/);
  bad((s) => { s[0].icon = 'rocket'; return s; }, /icon/);
  bad((s) => { s[0].style = 'neon'; return s; }, /style/);
  assert.deepEqual(checkStoryboard(GOOD.map((s, i) => ({ ...s, accent: i ? 'mint' : '#ffb648', tag: 'Новое', icon: 'spark', mark: 'Повторы', style: 'note' })), DATA, cfg), []);
});
test('номера пунктов — ни на экране, ни в речи', () => {
  bad((s) => { s[0].title = 'Пункт I22 готов'; return s; }, /номера пунктов/);
  bad((s) => { s[3].speech += ' Ответьте на Q4.'; return s; }, /номера пунктов/);
  bad((s) => { s[0].lines = ['см. I7']; return s; }, /номера пунктов/);
});
test('одобрения и кнопки бота диктор не называет', () => {
  bad((s) => { s[3].speech = 'Нажмите кнопку в боте, чтобы одобрить план.'; return s; }, /кнопк|одобр/);
});
test('чат — только строки и кнопки из образцов', () => {
  bad((s) => { s[1].chat.text = 'Выдуманный ответ бота'; return s; }, /не из образцов/);
  bad((s) => { s[1].chat.buttons = [['Кнопка-которой-нет']]; return s; }, /кнопка не из образцов/);
  bad((s) => { s[1].chat.buttons = [['Вернуть'], ['Вернуть'], ['Вернуть'], ['Вернуть']]; return s; }, /до 3 рядов/);
  assert.deepEqual(checkStoryboard(GOOD.map((s, i) => (i === 1 ? { ...s, chat: { text: 'Твои повторы:\n1. Зарядка — каждый день', buttons: [] } } : s)), DATA, cfg), []); // часть строк — можно
});
test('в данных нет образцов — любая сцена чата отклоняется', () => {
  assert.match(checkStoryboard(GOOD, { ...DATA, demos: [] }, cfg).join('\n'), /не из образцов/);
});
test('длина: речи больше лимита ролика', () => {
  bad((s) => { s[0].speech = 'Очень длинная речь диктора. '.repeat(40); return s; }, /лимит ролика/);
});
test('темп: экрана больше полутора длин речи', () => {
  bad((s) => { s[0].lines = ['Длинная строка на экране, которую не успеть прочитать.']; s[0].speech = 'Коротко сказал.'; return s; }, /мало речи/);
});
test('темп: речь к экрану чата короче 56 знаков', () => {
  bad((s) => { s[1].speech = 'Вот так выглядит список.'; return s; }, /мало речи/);
});
test('недельный ролик: образцы из features[].sample, лимит — weekly_max_seconds', () => {
  assert.deepEqual(checkStoryboard(GOOD, WEEKLY_DATA, cfg, { weekly: true }), []);
  const long = [...GOOD.slice(0, 3), ...Array.from({ length: 8 }, () => ({ kind: 'text', title: 'Ещё', lines: [], speech: 'Довольно длинная фраза диктора про ещё одну новую возможность продукта, которую сделали за неделю.' })), GOOD[3]];
  assert.match(checkStoryboard(long, DATA, cfg).join('\n'), /лимит ролика/); // утром не влезает
  assert.deepEqual(checkStoryboard(long, WEEKLY_DATA, cfg, { weekly: true }), []);
});

test('toScenes: ключи, речь только русскими словами, без времени на чтение, оформление как есть', () => {
  const s = toScenes({ scenes: GOOD.map((x, i) => (i ? x : { ...x, accent: '#ffb648', speech: 'Бот научился работать с Google календарём.' })) }, cfg);
  assert.deepEqual(s.map((x) => x.key), ['s0', 's1', 's2', 's3']); assert.ok(s.every((x) => x.hold === 0));
  assert.doesNotMatch(s.map((x) => x.speech).join(' '), /[A-Za-z]/); assert.equal(s[0].accent, '#ffb648'); assert.deepEqual(s[1].chat, GOOD[1].chat);
});
test('parseRemarks: массив JSON внутри любого текста; проза и мусор — пусто', () => {
  assert.deepEqual(parseRemarks('Вот замечания:\n[{"scene":2,"kind":"fact","problem":"нет в данных","fix":"убрать"}]\nВсё.'), [{ scene: 2, kind: 'fact', problem: 'нет в данных', fix: 'убрать' }]);
  for (const t of ['', null, 'Замечаний нет.', '[1, 2', '{"scene":1}', '[]']) assert.deepEqual(parseRemarks(t), []);
  assert.deepEqual(parseRemarks('[{"scene":"x","kind":"fact"},{"scene":1,"kind":"other","problem":"п","fix":"ф"}]'), [{ scene: 1, kind: 'view', problem: 'п', fix: 'ф' }]);
  assert.equal(parseRemarks(JSON.stringify(Array.from({ length: 9 }, (_, i) => ({ scene: i + 1, kind: 'view', problem: 'п', fix: 'ф' })))).length, 6); // не больше шести
});

const fact = [{ scene: 2, kind: 'fact', problem: 'п', fix: 'ф' }];
test('applyRemarks: правка принята — сцена с выдумкой, оставшаяся дословно, вырезается', () => {
  const after = structuredClone(GOOD); after[0].title = 'Новая зацепка';
  assert.deepEqual(applyRemarks(GOOD, after, fact).map((s) => s.title), [after[0].title, GOOD[2].title, GOOD[3].title]);
  const fixed = structuredClone(GOOD); fixed[1].speech = 'Список повторяющихся дел теперь приходит одним сообщением, и лишнее легко убрать.';
  assert.equal(applyRemarks(GOOD, fixed, fact).length, 4); // сцена изменилась — остаётся
});
test('applyRemarks: правки нет (null) — исходная раскадровка без сцен с выдумкой', () => {
  assert.deepEqual(applyRemarks(GOOD, null, fact).map((s) => s.title), [GOOD[0].title, GOOD[2].title, GOOD[3].title]);
});
test('applyRemarks: замечания только view или номер вне списка — исходная целиком', () => {
  assert.equal(applyRemarks(GOOD, null, [{ scene: 2, kind: 'view', problem: 'п', fix: 'ф' }]).length, 4);
  assert.equal(applyRemarks(GOOD, null, [{ scene: 40, kind: 'fact', problem: 'п', fix: 'ф' }]).length, 4);
});

// --- по итогам проверки ветки ---
test('applyRemarks: исправленное «было — стало» или цифра — сцена изменилась и остаётся', () => {
  const before = [GOOD[0], { kind: 'compare', title: 'Повторы', lines: [], compare: { before: 'Вписывали каждый день', after: 'Появляются сами' }, speech: 'Повторяющиеся дела теперь появляются сами.' }, GOOD[2], GOOD[3]];
  const after = structuredClone(before); after[1].compare.before = 'Вписывали вручную'; after[2].number.value = 3;
  const remarks = [{ scene: 2, kind: 'fact', problem: 'п', fix: 'ф' }, { scene: 3, kind: 'fact', problem: 'п', fix: 'ф' }];
  assert.equal(applyRemarks(before, after, remarks).length, 4);
  assert.equal(applyRemarks(before, structuredClone(before), remarks).length, 2); // ничего не исправлено — обе вырезаны
});
test('пустое сообщение в чате и нецелая или пустая цифра — нарушения', () => {
  bad((s) => { s[1].chat = { text: '  ', buttons: [] }; return s; }, /chat/);
  for (const value of [null, '', 2.5, -1]) bad((s) => { s[2].number.value = value; return s; }, /number/);
});
