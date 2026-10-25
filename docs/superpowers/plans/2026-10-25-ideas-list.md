# Список предложений в боте — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** в боте mcfly появляется список «💡 Предложения» (бэклог владельца, его заметки-идеи и идеи команды) с кнопками «✅ Берём» / «⏸ Не сейчас»; команда без одобренной работы не простаивает, а пополняет список и планирует только взятые владельцем пункты; планы по взятым пунктам молчанием не одобряются.

**Architecture:** новый модуль `src/ideas.js` по образцу `questions.js` хранит `mcfly/ideas.yaml` и правила переходов статусов по исполнителю (бот, сессия, команда). Бот (answers.js, telegram.js, overview.js, pull.js, summary.js) читает и пишет его через этот модуль; команда — через CLI `mcfly ideas add` и `mcfly approval request --idea`; сессия владельца — через `mcfly ideas list|set`. Поведение прогона задают подстановки в `prompts/run.md` (`prompt.js`) и раздел контекста (`context.js`).

**Tech Stack:** Node 24, ES-модули, `yaml`, `node:test` (`npm test`), Telegram Bot API (HTML, inline-кнопки, `callback_data` ≤ 64 байт).

**Spec:** `docs/superpowers/specs/2026-10-25-ideas-list-design.md` (одобрен владельцем 25.10). Исполнитель читает его целиком: тексты, статусы и решения сессии — оттуда.

## Global Constraints

- Версия комплекта 0.7.0: `package.json`, `CHANGELOG.md` (заметным пунктом: «без одобренной работы и без взятых пунктов команда больше не планирует изменения сама; прежнее поведение — `ideas.enabled: false`»), README.
- Статусы пункта: `proposed`, `taken`, `planned`, `done`, `discuss`, `rejected`. Источники: `owner-backlog`, `owner-note`, `team`, `research`. Размер: `S`, `M`, `L`.
- Telegram окончательного отказа не даёт: из бота пункт уходит только в `discuss`. `rejected` ставит только сессия (`mcfly ideas set`), не команда и не бот.
- Изменение с `mcfly.idea` никогда не одобряется по сроку и не перерабатывается командой после отказа.
- Пункт без «Берём» сам ничего не запускает.
- Настройки `ideas` по умолчанию: `enabled: true`, `backlog: ''`, `per_run: 2`, `per_idle_run: 4`, `show: 7`, `research: true`.
- Потолки шага «Предложения»: 10 % времени прогона (обычный), 25 % (без работы); пропуск, если до дедлайна < 20 минут; перенос бэклога владельца в потолок пунктов не входит.
- Тексты для человека — по-русски; идентификаторы — английские; стиль кода как в соседних модулях (короткие функции, JSDoc-комментарий над экспортом по-русски).
- `npm test` зелёный после каждой задачи (сейчас 276 тестов).

## Review Focus

1. Нажатие старой кнопки «✅ Берём I7» / «⏸ Не сейчас I7», когда пункт уже `planned`, `discuss`, `rejected` или удалён, — ответ «уже …»/«не найден», файл не портится (тест в задаче 2).
2. `mcfly/ideas.yaml` с ошибкой YAML — бот применяет остальные сообщения и отвечает предупреждением про файл, «Предложения» показывают предупреждение, а не падают (урок 24.10 с `.openspec.yaml`; тесты в задачах 1 и 3).
3. «идея:» без текста или «💡» одним символом — пункт не создаётся, ответ «пустая идея — напишите текст после «идея:»» (тест в задаче 2).
4. «Отклонить» под обычным изменением (без `mcfly.idea`) — поведение 0.6.3 без изменений: `rejected`, команда перерабатывает (тест в задаче 4).
5. `ideas.enabled: false` — нет кнопки в клавиатуре и строки в «Статусе», промпт — прежний шаг 2b, «предложения» отвечает «список предложений выключен (ideas.enabled: false)» (тесты в задачах 3 и 6).

---

### Task 1: Модуль списка, путь и настройки

**Files:**
- Create: `src/ideas.js`
- Modify: `src/state.js` (`paths`: `ideas: path.join(root, 'ideas.yaml')`), `src/config.js` (`DEFAULT_CONFIG.ideas`, проверки в `validate`)
- Test: `test/ideas.test.js`, `test/config.test.js`

**Interfaces:**
- Produces:
  - `loadIdeas(p) -> { ideas: Idea[], error?: string }` — нет файла → `{ ideas: [] }`; ошибка YAML → `{ ideas: [], error: 'mcfly/ideas.yaml: <сообщение>' }` (не бросает).
  - `saveIdeas(p, data)`; `saveIdeas` при `data.error` бросает `Error` (не перезаписывать испорченный файл пустым).
  - `nextIdeaId(data) -> 'I<n>'`.
  - `addIdea(data, { title, benefit, how = '', source, ref = '', size, needsOwner = '', newArguments = '', now = new Date(), runId = '' }) -> Idea` — бросает при пустом `title`/`benefit`, неизвестных `source`/`size`, `research` без `ref` вида `http(s)://`, и при совпадении нормализованного `title` (нижний регистр, без пунктуации и лишних пробелов) с пунктом в любом статусе, кроме `rejected` с непустым `newArguments`.
  - `transitionIdea(data, id, to, { actor, note = '', change = '', now = new Date() }) -> { idea: Idea|null, error: string|null }`; `actor` ∈ `'bot' | 'session' | 'team'`. Разрешено: bot — `proposed→taken`, `proposed→discuss`, `taken→discuss`, `planned→discuss`; team — `taken→planned` (обязателен `change`), `planned→done`; session — любой статус → `proposed | taken | rejected`. Повтор в тот же статус — `error: 'уже <статус по-русски>'`. `discuss` пишет `discuss_note`, `rejected` — `reject_note`.
  - `IDEA_STATUS_RU = { proposed: 'в списке', taken: 'взято', planned: 'спланировано', done: 'сделано', discuss: 'на обсуждении в сессии', rejected: 'отклонено' }`.
  - `visibleIdeas(data, show) -> { active: Idea[], proposed: Idea[], more: number, discuss: number }` — `active` = `taken` + `planned`; `proposed` отсортированы: `owner-backlog`/`owner-note` раньше `team`/`research`; внутри группы без `needs_owner` раньше; затем `S < M < L`; затем по `id`; срез `show`, `more` — остаток.
  - `syncDoneIdeas(data, changesDir) -> Idea[]` — `planned`, чьего `change` больше нет в `changesDir` (не каталог), → `done` (actor team).
  - `DEFAULT_CONFIG.ideas` — значения из Global Constraints; `validate`: `enabled` логическое, `per_run`/`per_idle_run`/`show` целые ≥ 0 (`show` ≥ 1), `backlog` строка.

- [ ] **Step 1: Write the failing tests** — в `test/ideas.test.js`:
  - `'addIdea: нумерация I1, I2 и обязательные поля'` — `addIdea` дважды → `I1`, `I2`; без `benefit` — `throws /что даст/`; `source: 'research'` без `ref` — `throws /ссылк/`.
  - `'addIdea: дубль по названию и возврат отклонённого только с новыми доводами'` — второй «Автозапуск релизов!» при `proposed` «автозапуск  релизов» → `throws /уже есть: I1/`; после `transitionIdea(..., 'rejected', { actor: 'session' })` без `newArguments` → `throws`, с `newArguments: 'забыли /release 3 раза'` → новый `I2`.
  - `'transitionIdea: бот не отказывает окончательно, команда не берёт, повтор — «уже»'` — `actor: 'bot'` `proposed→rejected` → `error` не пустой, статус прежний; `actor: 'team'` `proposed→taken` → `error`; `actor: 'bot'` `taken→taken` → `error === 'уже взято'`; `taken→planned` командой без `change` → `error`.
  - `'visibleIdeas: ваши первыми, needs_owner в конце группы, остаток в more'` — 9 пунктов разных источников и размеров, `show: 7` → порядок `id` проверить списком, `more === 2`, `discuss` посчитан.
  - `'loadIdeas: испорченный YAML не бросает, saveIdeas его не затирает'` — файл `ideas: [oops` → `error` начинается с `'mcfly/ideas.yaml'`; `saveIdeas` → `throws`; файл не изменился.
  - `'syncDoneIdeas: архивированное изменение закрывает пункт'`.
  - в `test/config.test.js`: `'ideas: значения по умолчанию и проверки'` — `parseConfig('project: x\n').ideas` равен значениям из Global Constraints; `ideas: { show: 0 }` → `throws /ideas.show/`.
- [ ] **Step 2: Run** `node --test test/ideas.test.js test/config.test.js` — FAIL (нет модуля).
- [ ] **Step 3: Implement** `src/ideas.js`, `paths().ideas`, `DEFAULT_CONFIG.ideas` и проверки по Interfaces. Запись — как `saveQuestions` (`writeText` + `YAML.stringify`).
- [ ] **Step 4: Run** `node --test test/ideas.test.js test/config.test.js` и `npm test` — PASS.
- [ ] **Step 5: Commit** `feat(ideas): список предложений mcfly/ideas.yaml и раздел ideas в config`.

### Task 2: Сообщения и кнопки бота: «Берём», «Не сейчас», «идея:»

**Files:**
- Modify: `src/answers.js` (`parseMessage`, `applyMessages`), `src/telegram.js` (`callbackText`)
- Test: `test/answers.test.js`, `test/telegram.test.js`

**Interfaces:**
- Consumes: `loadIdeas`, `saveIdeas`, `addIdea`, `transitionIdea`, `IDEA_STATUS_RU` (задача 1).
- Produces:
  - `parseMessage` новые типы: `{ type: 'take', id }` для «берём I7» / «беру I7»; `{ type: 'defer', id, note }` для «не сейчас I7 [причина]»; `{ type: 'idea', text }` для текста, начинающегося с «идея:» / «идея -» / «💡» (регистр не важен; `text` — без префикса, обрезан). `id` — в верхнем регистре (`i7` → `I7`). Разбор `take`/`defer` — до `approve`/`reject`, `idea` — до заметки.
  - `callbackText`: `ib:I7` → `'берём I7'`, `ix:I7` → `'не сейчас I7'`, `il:2` → `'предложения 2'`.
  - `applyMessages`: `take` → `transitionIdea(..., 'taken', { actor: 'bot' })`, запись в `answers.md` «## <время> — взято I7», ответ `'✅ I7 взято — план пришлёт ближайший прогон'`; `defer` → `'discuss'`, «## … — не сейчас I7», ответ `'⏸ I7 отложено — обсудим в сессии'`; `idea` → `addIdea(source: 'owner-note', title: первая строка, benefit: остальное или 'см. название')`, «## … — идея владельца I8», ответ `'💡 I8 записал в предложения'`; пустой `text` → ответ `'⚠️ Пустая идея — напишите текст после «идея:»'`, файл не меняется; `error` перехода → ответ `'ℹ️ I7: <error>'`; неизвестный `id` → `'⚠️ I7: такого предложения нет'`. Если `loadIdeas` вернул `error` — эти сообщения не применяются, ответ `'⚠️ <error> — список предложений не изменён'`, остальные сообщения пачки применяются.
  - Ответ свайпом на сообщение с ровно одним `Iн` в статусе `discuss` (по образцу `withReplyQuestion`) → `discuss_note` этого пункта дописывается, ответ `'📝 I7: причина записана'`.

- [ ] **Step 1: Write the failing tests** — `test/answers.test.js`: `'parseMessage: берём, не сейчас, идея'` (таблица: «берём i7»→take I7; «Не сейчас I7 дорого»→defer note «дорого»; «💡 Тёмная тема сайта»→idea; «идея:»→idea с пустым text; «берём»→note); `'applyMessages: берём и не сейчас меняют список и пишут answers.md'`; `'applyMessages: старая кнопка по спланированному пункту — «уже», файл прежний'` (Review Focus 1); `'applyMessages: пустая идея не создаёт пункт'` (Review Focus 3); `'applyMessages: испорченный ideas.yaml — остальные сообщения применены'` (Review Focus 2); `'ответ свайпом на отложенный пункт записывает причину'`. `test/telegram.test.js`: `'callbackText: ib, ix, il'`.
- [ ] **Step 2: Run** `node --test test/answers.test.js test/telegram.test.js` — FAIL.
- [ ] **Step 3: Implement** по Interfaces.
- [ ] **Step 4: Run** те же файлы и `npm test` — PASS.
- [ ] **Step 5: Commit** `feat(ideas): «Берём», «Не сейчас» и «идея:» в боте`.

### Task 3: Экран «💡 Предложения», клавиатура, «Статус», сводка, справка

**Files:**
- Modify: `src/overview.js` (`VIEW_WORDS`, `viewOf`, `BOT_COMMANDS`, `mainKeyboard`, `MENU_REV`, `ideasView`, `sendView`, `statusView`, `helpView`, объявление в `ensureBotMenu`), `src/summary.js` (`nextRunText`, `summaryKeyboard`, `composeSummary`), `src/answers.js` (`parseMessage`: страница), `src/pull.js` (передать `page` в `sendView`)
- Test: `test/overview.test.js`, `test/summary.test.js`

**Interfaces:**
- Consumes: задачи 1–2.
- Produces:
  - `viewOf('предложения' | 'идеи' | '/ideas' | '💡 Предложения') === 'ideas'`; «предложения 2» → вид `ideas` со страницей 2: `parseMessage` до `viewOf` проверяет `/^(предложения|идеи|\/ideas)\s+(\d+)$/i` и даёт `{ type: 'view', view: 'ideas', page: 2 }` (без числа — `page: 1`); цикл видов в `pullAnswers` передаёт `page` в `sendView(..., { now, offers, page })`.
  - `ideasView(p, cfg, { page = 1 }) -> string[]` (куски HTML) и `ideasKeyboard(p, cfg, { page = 1 }) -> rows` — для каждого показанного `proposed`: `[{ text: '✅ Берём I7', callback_data: 'ib:I7' }, { text: '⏸ Не сейчас', callback_data: 'ix:I7' }]`; при `more > 0` — `[{ text: 'Ещё ▸', callback_data: 'il:<page+1>' }]`. Пункт выводится по образцу из спеки (заголовок `💡 I7 · ваш|команда · M`, название, «Что даст:», «Откуда:», при `needs_owner` — «🙋 От вас понадобится: …»); вверху — `active` одной строкой каждый («⏳ I4 — ждёт прогона», «📝 I4 → изменение <имя>, ждёт вашего решения в «Статусе»»); внизу — «🗣 Обсудить в сессии: N», если `N > 0`. Пусто — «Предложений пока нет: команда добавит их в следующем прогоне, или напишите «идея: …»». `enabled: false` → «Список предложений выключен (ideas.enabled: false)» (Review Focus 5). `loadIdeas().error` → строка с предупреждением (Review Focus 2).
  - `sendView` для `ideas`: куски `ideasView` с постоянной клавиатурой, затем отдельное сообщение «Выберите:» с `ideasKeyboard`, если строки есть.
  - `mainKeyboard(cfg)`: два первых ряда как сейчас; третий ряд — `💡 Предложения` (при `enabled`) и `🛠 Действия` (при действиях); пустой ряд не добавляется. `MENU_REV = '0.7.0'`; объявление упоминает «💡 Предложения».
  - `nextRunText(work, pend, progress, esc, ideas = null)`: при `work.length` — как сейчас; иначе при `ideas.taken.length` — `'план по ' + id через запятую`; иначе при `pend.length` — как сейчас; иначе при `ideas && ideas.proposed > 0` — `'работы нет — 💡 предложений N (ваших K): выберите в «Предложениях»'`; иначе как сейчас. Все три вызова (`overview.js`, `summary.js`, `runner.js`) передают `ideas` из `loadIdeas` (при `enabled`).
  - `summaryKeyboard`: для изменения с `mcfly.idea` вторая кнопка — `{ text: '⏸ Не сейчас', callback_data: 'rj:<имя>' }`; при отсутствии работы и ожидающих одобрения и `proposed > 0` — ряд `[{ text: '💡 Предложения', callback_data: 'il:1' }]`.
  - `statusView`/`changeLine`: `pending` с `mcfly.idea` — «⏳ <имя> — ждёт вашего решения, само не одобрится (по I7)».
  - `composeSummary`: новые пункты за период — строка «💡 Новые предложения: I9, I10» (по `created_at > since`).

- [ ] **Step 1: Write the failing tests** — `test/overview.test.js`: `'ideasView: ваши первыми, кнопки Берём/Не сейчас и Ещё'`; `'ideasView: пусто, выключено, испорченный файл'` (Review Focus 2, 5); `'mainKeyboard: третий ряд Предложения и Действия'`; `'viewOf: предложения, идеи, /ideas; страница 2'`; `'statusView: план по пункту не одобрится сам'`. `test/summary.test.js`: `'nextRunText: план по взятым пунктам и подсказка выбрать'`; `'summaryKeyboard: Не сейчас для изменения по пункту и кнопка Предложения без работы'`; `'composeSummary: новые предложения за период'`.
- [ ] **Step 2: Run** `node --test test/overview.test.js test/summary.test.js` — FAIL.
- [ ] **Step 3: Implement** по Interfaces; `helpView` — строки «💡 «предложения» или /ideas — …», «✅/⏸ кнопки под предложениями — взять или отложить на обсуждение в сессии», «💡 «идея: текст» — добавить свою идею в список».
- [ ] **Step 4: Run** те же файлы и `npm test` — PASS (поправить существующие ожидания клавиатуры и `MENU_REV`, не ослабляя проверок).
- [ ] **Step 5: Commit** `feat(ideas): экран «Предложения», клавиатура, «Статус» и сводка`.

### Task 4: Одобрение планов по пункту и «Запусти»

**Files:**
- Modify: `src/approvals.js` (`isAutoApprovable`, `requestApproval`), `src/answers.js` (ветка `reject`), `src/pull.js` (`onRun`), `src/cli.js` (`approval request --idea`)
- Test: `test/approvals.test.js`, `test/answers.test.js`, `test/pull.test.js`, `test/cli.test.js`

**Interfaces:**
- Consumes: `transitionIdea`, `loadIdeas`, `saveIdeas` (задача 1).
- Produces:
  - `isAutoApprovable(change, cfg)` → `false`, если `change.mcfly.idea`; иначе как сейчас. `expireApprovals` такие изменения не трогает.
  - `requestApproval(change, { category, priority, now, idea })` — при `idea` пишет `mcfly.idea`.
  - `mcfly approval request <имя> --idea I7` — пункт должен быть `taken`, иначе ошибка «I7 не взят владельцем (статус …)» и код 1; при успехе `transitionIdea(..., 'planned', { actor: 'team', change: имя })`, `mcfly.idea: I7`.
  - `applyMessages`, ветка `reject`: изменение с `mcfly.idea` → `setApproval(..., 'rejected', ..., note)` и пункт → `discuss` с `discuss_note` «план отклонён в Telegram: <имя>[, <причина>]»; ответ `'⏸ <имя>: не сейчас — пункт I7 ждёт обсуждения в сессии'`. Без `mcfly.idea` — как в 0.6.3 (Review Focus 4).
  - `onRun` в `pull.js`: отказ «работы нет, ждёт одобрения …» не срабатывает, если есть пункты `taken`.

- [ ] **Step 1: Write the failing tests** — `'isAutoApprovable: план по пункту не одобряется по сроку'` и `'expireApprovals пропускает изменение с mcfly.idea'`; `'reject плана по пункту — пункт на обсуждение, без mcfly.idea — как раньше'`; `'запусти: взятый пункт запускает прогон, хотя изменение ждёт одобрения'`; `'cli approval request --idea: только для взятого пункта'`.
- [ ] **Step 2: Run** `node --test test/approvals.test.js test/answers.test.js test/pull.test.js test/cli.test.js` — FAIL.
- [ ] **Step 3: Implement** по Interfaces.
- [ ] **Step 4: Run** те же файлы и `npm test` — PASS.
- [ ] **Step 5: Commit** `feat(ideas): планы по пунктам без авто-одобрения, отказ — на обсуждение`.

### Task 5: CLI `mcfly ideas` для сессии и команды

**Files:**
- Modify: `src/cli.js` (раздел `ideas`, `HELP`)
- Test: `test/cli.test.js`

**Interfaces:**
- Consumes: задача 1.
- Produces:
  - `mcfly ideas list [--status <статус>]` — строки «I7 [в списке] ваш · M — Автозапуск…» (+ «→ <изменение>», «— причина: …» при наличии).
  - `mcfly ideas add --title <t> --benefit <t> --source <s> --size <S|M|L> [--how <t>] [--ref <t>] [--needs-owner <t>] [--new-arguments <t>]` — для команды и сессии; `run_id` из `MCFLY_RUN_ID`; ошибки `addIdea` → stderr, код 1; успех — «I9 добавлено в предложения».
  - `mcfly ideas set <Iн> <proposed|taken|rejected> [--note <t>]` — только сессия: при `MCFLY_RUN_ID` → «Решение по предложениям принимает владелец в сессии: в прогоне команды ideas set запрещён», код 1; `actor: 'session'`.

- [ ] **Step 1: Write the failing tests** — `'cli ideas add/list'`, `'cli ideas set: в прогоне запрещено, в сессии — отказ и возврат'`.
- [ ] **Step 2: Run** `node --test test/cli.test.js` — FAIL.
- [ ] **Step 3: Implement** по образцу разделов `question` и `approval`.
- [ ] **Step 4: Run** `npm test` — PASS.
- [ ] **Step 5: Commit** `feat(ideas): mcfly ideas list|add|set`.

### Task 6: Прогон команды: шаг 2, шаг «Предложения», контекст, служебные пути

**Files:**
- Modify: `prompts/run.md`, `src/prompt.js` (`buildLeadPrompt`), `src/context.js` (`buildContext`), `src/runner.js` (`STATE_PATHS`, `syncDoneIdeas` в конце прогона), `skills/mcfly-process/SKILL.md`, `agents/analyst.md`, `agents/planner.md`
- Test: `test/prompt.test.js`, `test/context.test.js`, `test/runner.test.js`, `test/plugin.test.js` (если проверяет тексты агентов)

**Interfaces:**
- Consumes: задачи 1, 4, 5.
- Produces:
  - `buildLeadPrompt` подставляет `{{WORK_FRONT}}` (текст шага 2) и `{{IDEAS_STEP}}` (новый шаг 5a). При `ideas.enabled` — шаг 2 из спеки (ветки a, b с `mcfly approval request <имя> --idea <Iн>` и разделом «Простыми словами», c — без нового планирования, отклонённые с `mcfly.idea` не перерабатывать; план по `taken` при занятой команде — после шага 5, если до дедлайна ≥ 30 минут) и шаг 5a с потолками `{{IDEAS_PER_RUN}}`/`{{IDEAS_PER_IDLE_RUN}}`, 10 %/25 % времени, пропуск при < 20 минут, источниками по порядку (бэклог из `ideas.backlog` целиком вне потолка, затем команда, затем `research` при `ideas.research`), дублями, `needs_owner`, добавлением только через `mcfly ideas add`. При `enabled: false` — `WORK_FRONT` = нынешний текст шага 2b дословно, `IDEAS_STEP` пусто (Review Focus 5).
  - `buildContext`: раздел «Предложения (mcfly/ideas.yaml)» при `enabled` — взятые (`taken`, к планированию по порядку `id`), спланированные с изменением, число `proposed` по источникам, `discuss`/`rejected` — только `id` и название с пометкой «не трогать, решение в сессии»; бэклог владельца: «<ideas.backlog>» или «не задан».
  - `STATE_PATHS` включает `'mcfly/ideas.yaml'`; в конце прогона `syncDoneIdeas` + `saveIdeas` до коммита служебных файлов.
  - `skills/mcfly-process/SKILL.md`: правило «молчание — согласие к списку предложений не применяется; пункт без «Берём» не превращается в работу; `rejected`/`discuss` команда не трогает».
  - `agents/analyst.md`: как готовить пункт (поля, «что даст» простыми словами, ссылка для research, `needs_owner`, проверка дублей через `mcfly ideas list`). `agents/planner.md`: для изменения по пункту первый раздел `proposal.md` — «## Простыми словами» (как будет работать, что даст, что понадобится от владельца).

- [ ] **Step 1: Write the failing tests** — `'buildLeadPrompt: с ideas — шаг Предложения и план только по взятым'` (проверка подстрок: `mcfly ideas add`, `--idea`, `10 %`, `25 %`, `20 минут`, «не перерабатывай»), `'buildLeadPrompt: ideas.enabled false — прежний шаг 2b'`, `'buildContext: раздел Предложения'`, `'runner: ideas.yaml в служебных путях и закрытие сделанных пунктов'`.
- [ ] **Step 2: Run** `node --test test/prompt.test.js test/context.test.js test/runner.test.js` — FAIL.
- [ ] **Step 3: Implement** по Interfaces; тексты шагов — по спеке, разделы «Прогон команды» и «Решения сессии».
- [ ] **Step 4: Run** `npm test` — PASS (все плейсхолдеры подставлены — существующий тест `buildLeadPrompt`).
- [ ] **Step 5: Commit** `feat(ideas): прогон пополняет предложения и планирует только взятые`.

### Task 7: init, шаблоны, версия, документация

**Files:**
- Modify: `src/init.js`, `templates/config.yaml` (раздел `ideas` с комментариями), создать `templates/ideas.yaml` (`ideas: []`), `package.json` (0.7.0), `CHANGELOG.md`, `README.md` (раздел о боте: «💡 Предложения»; дорожная карта — без изменений), `docs/quickstart.md` (одна строка)
- Test: `test/init.test.js`

**Interfaces:**
- Consumes: всё выше.
- Produces: `mcfly init` создаёт `mcfly/ideas.yaml` из шаблона, если файла нет; шаблон `config.yaml` содержит раздел `ideas` со значениями по умолчанию и комментарием «backlog — где ваш бэклог, например "SHARED-UNDERSTANDING.md §4.1"».

- [ ] **Step 1: Write the failing test** — `'init создаёт ideas.yaml и раздел ideas в config'`.
- [ ] **Step 2: Run** `node --test test/init.test.js` — FAIL.
- [ ] **Step 3: Implement**; CHANGELOG 0.7.0 — пункты по задачам 1–6 и заметное предупреждение из Global Constraints.
- [ ] **Step 4: Run** `npm test` — PASS; `node bin/mcfly doctor --project ~/emmett_brown` — без новых ✗.
- [ ] **Step 5: Commit** `chore(release): mcfly 0.7.0 — список предложений`.

## После реализации (вне задач, с владельцем)

- Владелец добавляет в `~/emmett_brown/mcfly/config.yaml` раздел `ideas` с `backlog: "SHARED-UNDERSTANDING.md §4.1"` (правка config — только владелец) и, если раздел `actions` не менялся, `trust` не нужен.
- Бот подхватит код сам в течение ~10 минут (новый цикл задания answers); клавиатура обновится по `MENU_REV 0.7.0`.
- Первый прогон перенесёт бэклог владельца в список; проверить «💡 Предложения» в Telegram.
- `git push` в `tusanek/mcfly` — по слову владельца.
