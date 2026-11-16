# Ролик-сводка с режиссёром — план реализации (0.15.0)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** сценарий ролика-сводки пишет роль-режиссёр, зритель один раз его проверяет, ролик идёт без пауз в двух новых оформлениях и приходит всегда — при сбое режиссёра собирается кодом.

**Architecture:** чистые правила раскадровки — в новом `src/storyboard.js`; запуск режиссёра и зрителя через `claude -p` в рабочей папке вне проекта — в новом `src/director.js`; `src/video.js` остаётся сборщиком (озвучка, кадры, ролик, отправка) и берёт сцены у режиссёра, а при любом отказе — свои прежние сцены. Шаблон Remotion получает две композиции: `Daily` и `Weekly`.

**Tech Stack:** Node 20+ (ESM, `node:test`), Remotion 4.0.544 (React 19), Python + Silero (озвучка), Claude Code в режиме без диалога.

**Spec:** `docs/superpowers/specs/2026-11-16-video-director-design.md` — читать вместе с планом.

## Global Constraints

- Текст сводки уходит первым; ни один сбой режиссёра, зрителя или сборки не бросает исключение наружу из `sendSummaryVideo`.
- Режиссёр и зритель работают в `~/.mcfly/video/work/<projectSlug>/<метка>/`; проект не читают и не меняют.
- В `agents/` и `skills/` — никаких команд, названий и цифр конкретного проекта. Репозиторий открытый: в коммитах, тестах, CHANGELOG — без данных из проектов владельца.
- Отклонено владельцем, проверяется кодом: номера пунктов (I22, Q4) на экране и в речи; в речи — одобрения и то, что решается кнопкой в боте; сообщения бота — только из образцов в данных.
- Значения по умолчанию: `video.director: review`, `video.director_minutes: 8`, `video.timeout_minutes: 15`, `video.voice_speed: 1.1`; запасная сборка — отдельные 5 минут; режиссёр не запускается при недельном лимите подписки ≥ 0.9.
- Темп: кадров в сцене = `ceil((duration + 0.3) * fps) + 3`.
- Недельный ролик на 120 с — не больше 20 МБ; файл больше 45 МБ пересобирается сильнее сжатым.
- Образцы из опыта лежат в рабочей копии и в git не попадают: `experiments/director/` (`build.mjs` — правила проверки, `GUIDE.md` — памятка, `app-m3/`, `app-w3/` — шаблоны монтажёров, `data-*.json`, `v2-*.json` — данные и раскадровки для проб). Данные проекта оттуда в репозиторий не копировать.
- Версия 0.15.0 в `package.json` и `.claude-plugin/plugin.json`, запись в `CHANGELOG.md`.

## Review Focus

1. `storyboard.json` — верный JSON, но не то: объект без `scenes`, сцена-строка, `lines` числом. Ожидание: `checkStoryboard` возвращает нарушения, не падает. → Задача 1.
2. Зритель ответил прозой без JSON или пустым текстом. Ожидание: замечаний нет, остаётся раскадровка режиссёра, ролик собирается. → Задачи 1 и 5.
3. Нет программы `claude`, кончился лимит, процесс превысил время. Ожидание: запасные сцены, в чат владельцу ничего, причина в журнале. → Задача 5.
4. В данных нет ни одного образца чата, а режиссёр поставил сцену `chat`. Ожидание: нарушение «строки чата не из образцов». → Задача 1.
5. Пустая ночь: нечего рассказывать. Ожидание: режиссёр не запускается (токены не тратятся), ролик из запасных сцен. → Задача 5.

---

### Task 1: Правила раскадровки (`src/storyboard.js`)

**Files:**
- Create: `src/storyboard.js`
- Test: `test/storyboard.test.js`

**Interfaces:**
- Produces:
  - `SCENE_KINDS: string[]` — `['text','chat','hook','number','compare','steps','finale']`; `SCENE_ENTER` — `['up','left','scale','fade']`.
  - `checkStoryboard(raw: unknown, data: object, cfg: object, { weekly?: boolean }): string[]` — нарушения простыми словами; пустой список — принята. `raw` — список сцен или `{ scenes }`.
  - `toScenes(raw, cfg): Scene[]` — к виду сборщика: `key: 's<i>'`, `speech` через `speakable(…, cfg.video.pronounce)`, `hold: 0`, поля оформления как есть.
  - `parseRemarks(text: string): { scene: number, kind: 'fact'|'view', problem: string, fix: string }[]` — первый массив JSON в тексте; не разобрался — `[]`.
  - `applyRemarks(before: object[], after: object[] | null, remarks): object[]` — итог после правки (см. шаг 5).

- [ ] **Step 1: Тесты на каждое правило.** Образец правил — функция `check` в `experiments/director/build.mjs`; перенести её пределы без изменений (пределы текста по видам, 3–16 сцен, чат до 520 знаков и 14 строк, кнопок до 3 рядов по 4, длина ролика с запасом 10 %). Основа теста — годная раскадровка `GOOD` из 4 сцен (`hook`, `chat` из образца, `number`, `finale`) и данные `DATA` с одним образцом. Каждый тест портит одно и ждёт своё нарушение:

```js
const bad = (patch, re, opts) => assert.match(checkStoryboard(patch(structuredClone(GOOD)), DATA, cfg, opts).join('\n'), re);
test('принята годная раскадровка', () => assert.deepEqual(checkStoryboard(GOOD, DATA, cfg), []));
test('не список, сцена-строка, lines числом — нарушения, а не исключение', () => {
  for (const raw of [null, 'x', { scenes: 5 }, ['сцена', 'сцена', 'сцена'], [{ kind: 'text', title: 'а', lines: 3, speech: 'достаточно длинная речь' }, GOOD[1], GOOD[2]]]) assert.ok(checkStoryboard(raw, DATA, cfg).length > 0);
});
test('неизвестный вид и появление', () => { bad((s) => { s[0].kind = 'zoom'; return s; }, /неизвестный вид/); bad((s) => { s[0].enter = 'spin'; return s; }, /появление/); });
test('номера пунктов — ни на экране, ни в речи', () => { bad((s) => { s[0].title = 'Пункт I22 готов'; return s; }, /номера пунктов/); bad((s) => { s[3].speech += ' Ответьте на Q4.'; return s; }, /номера пунктов/); });
test('одобрения и кнопки бота диктор не называет', () => bad((s) => { s[3].speech = 'Нажмите кнопку в боте, чтобы одобрить план.'; return s; }, /кнопк|одобр/));
test('чат — только строки и кнопки из образцов', () => { bad((s) => { s[1].chat.text = 'Выдуманный ответ бота'; return s; }, /не из образцов/); bad((s) => { s[1].chat.buttons = [['Кнопка-которой-нет']]; return s; }, /кнопка не из образцов/); });
test('в данных нет образцов — любая сцена чата отклоняется', () => assert.match(checkStoryboard(GOOD, { ...DATA, demos: [] }, cfg).join('\n'), /не из образцов/));
test('длина: речи больше лимита ролика', () => bad((s) => { s[0].speech = 'Очень длинная речь. '.repeat(60); return s; }, /лимит ролика/));
test('темп: экрана больше полутора длин речи', () => bad((s) => { s[0].lines = ['Длинная строка на экране. '.repeat(4)]; s[0].speech = 'Коротко сказал.'; return s; }, /мало речи/));
test('темп: речь к экрану чата короче 56 знаков', () => bad((s) => { s[1].speech = 'Вот пример.'; return s; }, /мало речи/));
test('темп: текст сообщения в чате в счёт экрана не идёт', () => assert.deepEqual(checkStoryboard(GOOD, DATA, cfg), [])); // у GOOD[1] длинное сообщение и речь 60 знаков
test('недельный ролик: образцы берутся из features[].sample, лимит — weekly_max_seconds', () => assert.deepEqual(checkStoryboard(GOOD, WEEKLY_DATA, cfg, { weekly: true }), []));
```

- [ ] **Step 2: Запустить `node --test test/storyboard.test.js` — падает: модуля нет.**
- [ ] **Step 3: Написать `checkStoryboard`.** Экран для правила темпа — знаки `title` + `lines` + `compare.before/after` + `number.label`; нарушение, если их больше `1.5 ×` знаков речи сцены после `speakable`. Темп диктора — 14 знаков в секунду (константа есть в `src/video.js`, вынести и экспортировать как `CHARS_PER_SECOND`), делённый на `cfg.video.voice_speed`. Допустимые значения полей оформления: `accent` — строка вида `#rrggbb`; `tag`, `icon`, `mark`, `style` — строки до 24 знаков (что с ними делать, решает шаблон).
- [ ] **Step 4: Тесты `toScenes`, `parseRemarks`:**

```js
test('toScenes: ключи, речь только русскими словами, без времени на чтение', () => {
  const s = toScenes(GOOD, cfg); assert.deepEqual(s.map((x) => x.key), ['s0', 's1', 's2', 's3']); assert.ok(s.every((x) => x.hold === 0)); assert.doesNotMatch(s.map((x) => x.speech).join(' '), /[A-Za-z]/);
});
test('parseRemarks: массив JSON внутри любого текста; проза и мусор — пусто', () => {
  assert.deepEqual(parseRemarks('Вот замечания:\n[{"scene":2,"kind":"fact","problem":"нет в данных","fix":"убрать"}]\nВсё.'), [{ scene: 2, kind: 'fact', problem: 'нет в данных', fix: 'убрать' }]);
  for (const t of ['', 'Замечаний нет.', '[1, 2', '{"scene":1}']) assert.deepEqual(parseRemarks(t), []);
  assert.deepEqual(parseRemarks('[{"scene":"x","kind":"fact"},{"scene":1,"kind":"other","problem":"п","fix":"ф"}]'), [{ scene: 1, kind: 'view', problem: 'п', fix: 'ф' }]); // без номера — отброшено; неизвестный вид — view
});
```

- [ ] **Step 5: Тесты и код `applyRemarks`.** Правило из спека: сцена с замечанием `fact` должна измениться или исчезнуть.

```js
const fact = [{ scene: 2, kind: 'fact', problem: 'п', fix: 'ф' }];
test('applyRemarks: правка принята — сцена с выдумкой, оставшаяся дословно, вырезается', () => {
  const after = structuredClone(GOOD); after[0].title = 'Новая зацепка';
  assert.deepEqual(applyRemarks(GOOD, after, fact).map((s) => s.title), [after[0].title, GOOD[2].title, GOOD[3].title]);
});
test('applyRemarks: правки нет (null) — исходная раскадровка без сцен с выдумкой', () => assert.equal(applyRemarks(GOOD, null, fact).length, 3));
test('applyRemarks: замечания только view — исходная целиком', () => assert.equal(applyRemarks(GOOD, null, [{ scene: 2, kind: 'view', problem: 'п', fix: 'ф' }]).length, 4));
```

«Дословно» — совпали `title`, `lines` и `speech`. Проверку «осталось меньше трёх сцен» делает вызывающий через `checkStoryboard`.

- [ ] **Step 6: `npm test` зелёный. Commit:** `feat(video): правила раскадровки ролика — проверка, замечания зрителя`.

### Task 2: Темп и скорость голоса

**Files:**
- Modify: `src/config.js` (раздел `video` в `DEFAULT_CONFIG` и `validate`), `templates/config.yaml`, `src/video.js` (`buildVideo`, `summaryScenes`, `weeklyScenes`, `demoScene`), `video/src/Summary.jsx` (`VOICE_DELAY`, `TAIL`, `<Audio>`)
- Test: `test/video.test.js`

**Interfaces:**
- Produces: настройка `cfg.video.voice_speed` (число 0.9–1.3, по умолчанию 1.1); в свойствах ролика у сцены `duration` (секунды показа без хвоста) и `voice` (секунды речи уже с учётом скорости), у ролика — `speed`.

- [ ] **Step 1: Тесты.**

```js
test('настройки: voice_speed по умолчанию 1.1; вне 0.9–1.3 — ошибка называет поле', () => {
  assert.equal(parseConfig('project: demo').video.voice_speed, 1.1);
  assert.throws(() => parseConfig('project: demo\nvideo:\n  voice_speed: 2'), /video\.voice_speed/);
});
test('темп: сцена режиссёра (hold 0) длится как речь; сцена из кода — не дольше речи плюс 2 с', async () => {
  // fakeRun отдаёт речь 2 с на сцену; voice_speed 1 — чтобы считать без деления
  const props = await builtProps([{ key: 's0', kind: 'text', title: 'а', lines: [], speech: 'р', hold: 0 }, { key: 's1', kind: 'chat', title: 'б', lines: [], speech: 'р', hold: 9, chat: { text: 'т', buttons: [] } }], { voice_speed: 1 });
  assert.deepEqual(props.scenes.map((s) => s.duration), [2, 4]);
});
test('скорость голоса: при 1.25 речь 2 с занимает 1.6 с, шаблон получает speed', async () => {
  const props = await builtProps([{ key: 's0', kind: 'text', title: 'а', lines: [], speech: 'р', hold: 0 }], { voice_speed: 1.25 });
  assert.equal(props.scenes[0].voice, 1.6); assert.equal(props.speed, 1.25);
});
test('запасные сцены: у образца чата речь о сути, фраз-пустышек нет', () => {
  const all = [...summaryScenes(DATA, cfg, { now: NOW }), ...weeklyScenes(WEEKLY, cfg)].filter((s) => s.kind === 'chat');
  assert.ok(all.length > 0); for (const s of all) { assert.doesNotMatch(s.speech, /Вот как это выглядит|И ещё один пример/); assert.ok(s.speech.length >= 20); }
});
```

`builtProps(scenes, video)` — помощник в тесте: `buildVideo` с `fakeHome()` и `fakeRun`, который сохраняет содержимое `props.json` из аргумента `--props=` до удаления рабочей папки.

- [ ] **Step 2: Запустить — падают.**
- [ ] **Step 3: Код.**
  - `buildVideo`: `voice = round2(durations[key] / speed)`; `duration = s.hold ? Math.min(Math.max(voice, s.hold), voice + 2) : voice`; `props.speed = cfg.video.voice_speed`; расчёт `seconds` — по формуле кадров из Global Constraints (зазор 0,4 с на сцену вместо 1,2).
  - `Summary.jsx`: `VOICE_DELAY = 3`, `TAIL = 0.3`; `<Audio … playbackRate={speed} />` (свойство `speed` пробросить из `Summary` в `Scene`).
  - `demoScene` (утро): речь — название образца плюс первое предложение «Зачем» (нет — «Что сделано») из пересказа в `data.plain`, где встречается название изменения образца; не нашлось — только название. Недельные сцены чата уже говорят название и пользу — не трогать.
  - Существующий тест «держится, пока успеешь прочитать» переписать под новое правило (не дольше речи плюс 2 с).
- [ ] **Step 4: `npm test` зелёный.**
- [ ] **Step 5: Проверка на слух и по длине.** `node bin/mcfly video build --project <любой проект с video.enabled>`; `ffprobe` показывает длину, близкую к расчётной; голос ускорен без «мультяшного» повышения тона. Если тон изменился — убрать `playbackRate` и ускорять в `video/silero.py` (шестой необязательный аргумент скорости, растяжение по времени средствами `torch`), длительности тогда отдаёт уже питон.
- [ ] **Step 6: Commit:** `feat(video): сцена длится как речь, скорость голоса video.voice_speed`.

### Task 3: Два оформления, кадры, размер файла

**Files:**
- Create: `video/src/Daily.jsx` (из `experiments/director/app-m3/src/Summary.jsx`), `video/src/Weekly.jsx` (из `experiments/director/app-w3/src/Summary.jsx`), `video/src/timing.js` (`VOICE_DELAY`, `TAIL`, `sceneFrames`, `totalFrames` — общее для обоих)
- Delete: `video/src/Summary.jsx`
- Modify: `video/src/index.jsx` (две композиции `Daily` и `Weekly`), `src/video.js` (`buildVideo`, новая `renderStills`)
- Test: `test/video.test.js`

**Interfaces:**
- Consumes: темп и `speed` из Task 2.
- Produces:
  - `buildVideo(cfg, { scenes, name, kind, now, run, vp, weekly = false, timeoutMs? })` — композиция `weekly ? 'Weekly' : 'Daily'`; возвращает `{ file, seconds, bytes }`.
  - `renderStills(cfg, { scenes, dir, weekly = false, run = runTool, vp, timeoutMs }): Promise<string[]>` — по кадру `NN.png` на сцену в `dir`, без озвучки: длительность сцены оценивается как `speech.length / CHARS_PER_SECOND / voice_speed`, в свойствах `voice: false`; кадр берётся на 70 % сцены, `--scale=0.5`.

- [ ] **Step 1: Перенести шаблоны.** Оба файла привести к общему `timing.js` (темп Task 2), оставить поддержку всех видов сцен и запасных сцен из кода (`text` с `bar`, `chat`) без полей оформления. Исправить огрехи из спека: полоски-заглушки в шапке чата → название проекта; зачёркнутое «было» — читаемый цвет; в первой сцене не повторять дату и вид сводки из шапки; `bar` с `done: 0` — без пустых полосок, одной строкой.
- [ ] **Step 2: Тесты.**

```js
test('buildVideo: утренний ролик — композиция Daily, недельный — Weekly; возвращает размер файла', async () => {
  const calls = []; const vp = fakeHome();
  const r = await buildVideo(cfg, { scenes: SCENES, name: 'a', run: fakeRun(calls), vp });
  await buildVideo(cfg, { scenes: SCENES, name: 'b', run: fakeRun(calls), vp, weekly: true });
  const comps = calls.filter((c) => c.opts.label === 'сборка ролика').map((c) => c.args[3]);
  assert.deepEqual(comps, ['Daily', 'Weekly']); assert.equal(r.bytes, 3); // fakeRun пишет 'mp4'
});
test('buildVideo: файл больше 45 МБ пересобирается сильнее сжатым', async () => { /* fakeRun первой сборкой пишет 46 МБ, второй — 1 МБ; ждём две сборки, во второй аргументы сильнее сжатия, итоговый bytes — 1 МБ */ });
test('renderStills: кадр на сцену, без озвучки', async () => {
  const calls = []; const dir = tmpDir('stills-');
  const files = await renderStills(cfg, { scenes: SCENES, dir, run: fakeRun(calls), vp: fakeHome() });
  assert.equal(files.length, SCENES.length); assert.ok(calls.every((c) => c.args.includes('still'))); assert.ok(!calls.some((c) => c.opts.label === 'озвучка'));
});
```

`fakeRun` дополнить: для команды `still` писать файл по пути из аргументов.

- [ ] **Step 3: Код `buildVideo` и `renderStills`.** Сжатие: начать с `--crf=30`; пересборка — `--crf=36 --scale=0.75`. Проверка `videoProblems` и `syncTemplate` — общие.
- [ ] **Step 4: `npm test` зелёный.**
- [ ] **Step 5: Проверка глазами и по размеру.** Собрать четыре пробных ролика из рабочей копии опыта: запасные сцены (`video build`, `video build --weekly`) и раскадровки `experiments/director/v2-morning.json`, `v2-weekly.json` (разовый скрипт в `experiments/`, вызывающий `toScenes` + `buildVideo`). Открыть кадры каждого (`renderStills`): ничего не обрезано и не наложилось в обоих оформлениях на обоих наборах сцен. Недельный ролик ≤ 20 МБ — иначе поднять `--crf` и записать подобранное значение в код.
- [ ] **Step 6: Commit:** `feat(video): оформления Daily и Weekly, кадры по сценам, сжатие`.

### Task 4: Роли и памятка

**Files:**
- Create: `agents/director.md`, `prompts/video-guide.md`
- Modify: `agents/user.md`
- Test: `test/director.test.js` (первый тест файла)

**Interfaces:**
- Produces: роль `mcfly:director` (tools: `Read, Write, Glob`; модель — как в `agents/user.md`); памятка `prompts/video-guide.md` — её код кладёт в рабочую папку как `GUIDE.md`.

- [ ] **Step 1: Тест согласованности памятки с кодом.**

```js
test('памятка режиссёру называет все виды сцен и появления из кода', () => {
  const guide = fs.readFileSync(path.join(MCFLY_ROOT, 'prompts', 'video-guide.md'), 'utf8');
  for (const k of [...SCENE_KINDS, ...SCENE_ENTER]) assert.match(guide, new RegExp('`' + k + '`'));
});
test('роль режиссёра — без цифр и названий проекта, формат сцен не дублирует', () => {
  const role = fs.readFileSync(path.join(MCFLY_ROOT, 'agents', 'director.md'), 'utf8');
  assert.match(role, /^name: director$/m); assert.doesNotMatch(role, /"kind"/);
});
```

- [ ] **Step 2: `prompts/video-guide.md`.** Основа — `experiments/director/GUIDE.md`. Изменить: файлы на входе — `data.json` и `base.json`; на выходе — `storyboard.json`; раздел «Проверка и сборка» убрать (проверяет код); добавить правило темпа («диктор говорит всё время показа: текста на экране не больше полутора длин речи; к экрану чата — не меньше четырёх секунд речи»), поля оформления (`accent`, `tag`, `icon`, `mark`, `style`) с допустимыми значениями из шаблонов Task 3, требование поля `lines` у каждой сцены (можно пустое).
- [ ] **Step 3: `agents/director.md`.** Шапка как у `agents/reporter.md`. Текст: кто зритель; порядок работы (прочитать `GUIDE.md`, `data.json`, `base.json` в текущей папке; записать `storyboard.json`; при замечаниях — прочитать `remarks.json` или список нарушений из задания и переписать `storyboard.json`); правила режиссуры из спека (зацепка, главное первым, одна мысль на сцену, разные виды сцен, речь дополняет экран, язык владельца продукта без слов команды, только факты из данных — ничего не додумывать, финал); другие файлы и папки не трогать.
- [ ] **Step 4: `agents/user.md`** — абзац в конце: «Если тебя зовут смотреть ролик-сводку»: открыть кадры `stills/NN.png` и `storyboard.json`, сверить каждое утверждение с `data.json`; ответ — только массив JSON до шести замечаний `{ "scene": номер, "kind": "fact" | "view", "problem": …, "fix": … }`, по убыванию важности; `fact` — утверждение без опоры в данных; не хвалить; файлы не менять. Worktree и ветки в этом случае не нужны.
- [ ] **Step 5: `npm test` зелёный; `claude plugin validate .` без ошибок. Commit:** `feat(agents): роль режиссёра ролика, зритель смотрит ролик`.

### Task 5: Запуск режиссёра и зрителя (`src/director.js`)

**Files:**
- Create: `src/director.js`
- Modify: `src/config.js`, `templates/config.yaml` (`video.director`, `video.director_minutes`, `video.timeout_minutes: 15`)
- Test: `test/director.test.js`

**Interfaces:**
- Consumes: `checkStoryboard`, `toScenes`, `parseRemarks`, `applyRemarks` (Task 1); `renderStills` (Task 3); `runProcess`, `cleanEnv`, `parseResult` (`src/claude.js`); `lastUsage` (`src/chain.js`); `videoPaths`, `projectSlug` (`src/video.js`); `MCFLY_ROOT` (`src/prompt.js`).
- Produces:
  - `runAgent(cfg, { agent, prompt, cwd, timeoutMs, run = runProcess }): Promise<{ ok: boolean, text: string, reason: string }>` — `claude -p --output-format stream-json --verbose --permission-mode acceptEdits --plugin-dir <MCFLY_ROOT> --agent <agent> <prompt>`, программа — `cfg.run.claude_bin`, окружение — `cleanEnv(process.env)`.
  - `directScenes(p, cfg, { data, baseScenes, weekly = false, now = new Date(), mode = cfg.video.director, vp, agent = runAgent, stills = renderStills, log = () => {} }): Promise<{ scenes: Scene[], source: 'director' | 'review' | 'fallback', reason: string, workDir: string | null }>` — никогда не бросает.

- [ ] **Step 1: Тесты настроек.** `video.director` по умолчанию `review`; значение вне `off|on|review` и `director_minutes` вне 1–30 — ошибка называет поле; `timeout_minutes` по умолчанию 15.
- [ ] **Step 2: Тесты `directScenes` с подставным `agent`.** Подставной агент — функция, которая по `agent` и номеру вызова пишет файлы в `cwd` и возвращает `{ ok, text, reason }`. Случаи (в каждом проверить `source`, `scenes` и число вызовов агента):

```js
test('mode on: раскадровка принята с первого раза — сцены режиссёра, один вызов', …);          // source 'director'
test('mode on: нарушения → один повтор со списком нарушений в задании → принята', …);         // 2 вызова; во втором prompt содержит текст нарушения
test('mode on: дважды не принята — запасные сцены, причина названа', …);                      // source 'fallback', reason /не принята/
test('mode review: кадры → зритель → правка; сцена с fact без изменений вырезана', …);        // source 'review'; вызовы: director, user, director
test('mode review: зритель ответил прозой — остаётся раскадровка режиссёра', …);               // source 'director', правки не было: 2 вызова
test('mode review: после вырезания выдумок осталось две сцены — запасные', …);                 // source 'fallback'
test('нет программы claude / лимит / время вышло (agent вернул ok: false) — запасные, без исключения', …);
test('agent бросил исключение, storyboard.json — не JSON, файла нет — запасные', …);
test('недельный лимит подписки 0.9 и больше — режиссёр не запускается', …);                   // appendMetric с usage.seven_day 0.92; 0 вызовов
test('пустая ночь: в данных нечего рассказывать — режиссёр не запускается', …);               // утро: plain пуст; неделя: features пуст
test('mode off — запасные сцены сразу, рабочая папка не создаётся', …);
test('рабочая папка: вне проекта, имя проекта из папки не выводит, данные без html и keyboard, хранится 8 последних', …);
test('общий предел director_minutes: после его истечения следующие вызовы не начинаются', …);  // подставные часы через параметр clock
```

- [ ] **Step 3: Код.** Порядок — как в спеке, раздел «Порядок сборки ролика», шаги 2–4. Рабочая папка: `path.join(vp.home, 'work', projectSlug(cfg.project), <ГГГГММДД-ЧЧММСС>)`; в неё: `data.json`, `base.json`, `GUIDE.md` (копия `prompts/video-guide.md`), позже `stills/`, `remarks.json`, `storyboard.v1.json` (раскадровка до правки). Задания агентам — короткие строки: что прочитать, что записать, для повтора — список нарушений. Зрителю — что лежит в папке; его ответ разбирает `parseRemarks`, результат пишется в `remarks.json` для режиссёра. Замечаний нет — правка не запускается.
- [ ] **Step 4: `npm test` зелёный. Commit:** `feat(video): режиссёр и зритель через claude -p, запасной путь при любом сбое`.

### Task 6: Встройка в сводку и команду

**Files:**
- Modify: `src/video.js` (`sendSummaryVideo`), `src/cli.js` (ветка `video build`, справка), `src/CLAUDE.md`
- Test: `test/video.test.js`, `test/cli.test.js`

**Interfaces:**
- Consumes: `directScenes` (Task 5), `buildVideo` (Task 3).
- Produces: `sendSummaryVideo(p, cfg, { data, tg, now, replyTo, log, build = buildVideo, direct = directScenes, weekly })` — возвращает `{ sent, file?, source?, error? }`; команда `mcfly video build [--weekly] [--director off|on|review]`.

- [ ] **Step 1: Тесты.**

```js
test('sendSummaryVideo: сцены режиссёра уходят в сборку; в журнале — источник сцен', …);
test('sendSummaryVideo: сборка сцен режиссёра упала — вторая сборка из запасных сцен со своим пределом 5 минут, ролик отправлен', …); // build вызван дважды, во втором timeoutMs === 5 * 60_000 и сцены === запасные
test('sendSummaryVideo: упала и запасная сборка — одна строка в чат, как раньше', …);
test('sendSummaryVideo: время режиссёра вычитается из video.timeout_minutes первой сборки', …);
test('video build --director off: печатает путь, длину, размер в МБ и источник сцен; в Telegram ничего не уходит', …);
test('video build --director с неизвестным значением — ошибка и код 1', …);
```

- [ ] **Step 2: Код.** `sendSummaryVideo`: запасные сцены собрать первыми; `direct(…)`; сборка; при сбое сборки и `source !== 'fallback'` — вторая сборка запасных с `timeoutMs: 5 * 60_000`. Подпись ролика в чате не меняется. `src/CLAUDE.md` — строки про `storyboard.js` и `director.js`.
- [ ] **Step 3: `npm test` зелёный. Commit:** `feat(video): ролик сводки берёт сцены у режиссёра, проба video build --director`.

### Task 7: Проба на настоящих данных, сверка модели, выпуск

**Files:**
- Modify: `package.json`, `.claude-plugin/plugin.json`, `CHANGELOG.md`, `README.md`, `docs/quickstart.md` (если упоминает ролик), `docs/BACKLOG.md`, `docs/README.md` (список документов)

- [ ] **Step 1: Пробные ролики.** В проекте владельца с `video.enabled` (только чтение проекта, без отправки): `mcfly video build --director review` и `mcfly video build --weekly --director review`. Записать: время, источник сцен, размер, длину. Критерии спека: уложились в `video.timeout_minutes`; по файлу сведений о сценах — тишина после речи не дольше 0,5 с; недельный ≤ 20 МБ. Открыть кадры обоих роликов.
- [ ] **Step 2: Проверка запасного пути вживую.** `video build --director review` с `run.claude_bin`, указывающим на несуществующий файл (временная копия настроек вне проекта): ролик собран из запасных сцен, тишина не дольше 2 с.
- [ ] **Step 3: Сверка модели.** Судья-ИИ (свежий субагент, задание — как в опыте: пять критериев по 10, вслепую, по кадрам и тексту диктора) сравнивает ролики шага 1 с роликами опыта `experiments/director/out/mix-*.mp4` (их кадры и сведения). Отставание больше 4 баллов из 50 — поставить в `agents/director.md` более сильную модель, повторить шаг 1 и сверку один раз.
- [ ] **Step 4: Показ владельцу.** Отдать два пробных ролика и итог сверки; владелец смотрит и слушает скорость голоса. Его правки (скорость, цифры правила темпа, оформление) внести до выпуска.
- [ ] **Step 5: Документы.** CHANGELOG 0.15.0 — что изменилось для владельца, цена (около 230 тыс. токенов на ролик в режиме `review`, ролик приходит на несколько минут позже текста), настройки. README — раздел про ролик. BACKLOG — добавить: музыка и звуковые эффекты; снять: «вид образца для изменений без чата». Версия в двух файлах.
- [ ] **Step 6: `npm test` зелёный. Commit:** `docs: 0.15.0 — ролик-сводка с режиссёром`. Отправку ветки делает владелец; запрос на слияние открыть и влить после неё.
