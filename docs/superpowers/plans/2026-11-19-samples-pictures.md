# Образцы картинками — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** кнопка «👀 Как будет выглядеть» присылает образцы плана картинками (альбомом), а дизайнер готовит картинку к каждому образцу, для сообщений бота — по шаблону «чат Telegram».

**Architecture:** строки `Картинка: <путь>` под подзаголовком образца разбирает `proposalSamples` (поле `images`), `sendSamples` шлёт их через новый `tg.sendPhotos` (sendMediaGroup) с запасным текстом. Шаблон чата — статичный HTML в `templates/design/`, копируется в проект командой `mcfly samples template`. Правила — у дизайнера и в скилле.

**Tech Stack:** Node 20 (ESM, встроенные `FormData`/`Blob`/`fetch`), node:test, Telegram Bot API `sendMediaGroup`.

**Spec:** `docs/superpowers/specs/2026-11-19-samples-pictures-design.md`

## Global Constraints

- Строка картинки: `Картинка: <путь от корня проекта>`, PNG или JPG; несколько строк — несколько картинок одного образца.
- Альбом — до 10 фото (предел Telegram); подпись у первого: `N. <заголовок>`.
- Строки «Картинка:» не входят в отпечаток плана (`planHash`) и в разбор кнопок.
- Без картинок, файл не найден или ошибка Telegram на фото — образец текстом, как сейчас; ненайденный файл — курсивом «картинка <путь> не найдена».
- Шаблон: `templates/design/telegram-chat.html`, ширина 390 px, светлая и тёмная тема (`?theme=dark`); копия в проекте — `design/samples/telegram-chat.html`; картинки — `design/samples/<изменение>/NN-light.png` и `-dark.png`.
- `mcfly approval request` у плана с образцами без единой картинки — предупреждение, не отказ.
- Новая версия: `package.json`, `.claude-plugin/plugin.json`, запись в `CHANGELOG.md`. В agents/ и skills/ — без подробностей конкретного проекта.

## Review Focus

- Путь картинки с `..` или абсолютный (выход за проект) — не отправлять, образец текстом с пометкой «не найдена» (тест в задаче 1).
- Картинка больше 10 МБ — Telegram отказывает; ожидаем запасной текст, а не падение кнопки (тест в задаче 2: ошибка `sendPhotos` → текст).
- Больше 10 картинок у образца — отправить первые 10 (тест в задаче 2).
- Строка «Картинка:» внутри текстового блока (в ```) — это текст образца, не картинка (тест в задаче 1).
- Дизайнер добавил картинки после быстрого одобрения — план не возвращается владельцу (тест в задаче 1: `planHash` не меняется).

---

### Task 1: Разбор строк «Картинка:» в образцах

**Files:**
- Modify: `src/approvals.js` (`proposalSamples` ~253, `planHash` ~160)
- Test: `test/ux.test.js`

**Interfaces:**
- Produces: `proposalSamples(change)` → элементы `{ title, text, buttons, images: string[] }` (пути как в строке, без проверки); `sampleImage(projectDir, rel) -> string | null` — абсолютный путь, если файл есть внутри проекта и расширение `.png|.jpg|.jpeg`, иначе null. Экспорт из `src/approvals.js`.

- [ ] **Step 1: тесты** `'образцы: строки «Картинка:» под подзаголовком — images; внутри блока — текст; отпечаток плана их не учитывает'`:
  - proposal с `### Экран` + блок + `Картинка: design/samples/x/01-light.png` + `Картинка: design/samples/x/01-dark.png` → `images` = оба пути, `text` без них;
  - строка `Картинка: …` внутри ``` → в `text`, `images` пустой;
  - `planHash` у плана до и после добавления строк «Картинка:» одинаковый;
  - `sampleImage(dir, '../x.png')`, `sampleImage(dir, '/etc/x.png')`, `sampleImage(dir, 'a.gif')`, несуществующий файл → `null`; существующий `design/samples/x/01-light.png` → абсолютный путь.
- [ ] **Step 2:** `node --test test/ux.test.js` — падают.
- [ ] **Step 3:** в `proposalSamples` вне блока строка `/^Картинка\s*:\s*(\S.*)$/` добавляет путь к текущему образцу (по последнему подзаголовку); в `planHash` такие строки вырезаются из proposal перед хешем; `sampleImage` — `path.resolve` + проверка, что результат внутри `projectDir`.
- [ ] **Step 4:** `node --test test/ux.test.js test/small.test.js` — проходят.
- [ ] **Step 5:** коммит `feat(samples): строки «Картинка:» в образцах плана`.

### Task 2: Отправка картинок альбомом

**Files:**
- Modify: `src/telegram.js` (рядом с `sendVideo`), `src/overview.js` (`sendSamples` ~394)
- Test: `test/ux.test.js`

**Interfaces:**
- Consumes: `proposalSamples`, `sampleImage` (задача 1).
- Produces: `tg.sendPhotos(chatId, files: string[], { caption = '' }) -> result` — `sendMediaGroup` с `attach://p0…`, при одной картинке — `sendPhoto`; таймаут загрузки 60 с, ошибки как у `sendVideo` («Telegram sendMediaGroup: …»).

- [ ] **Step 1: тесты** в `test/ux.test.js` с поддельным `tg` (`sendMessage`, `sendPhotos` пишут в `sent`):
  - образец с двумя картинками (файлы созданы в проекте) → один вызов `sendPhotos` с двумя абсолютными путями и подписью `'1. Экран'`, текстом этот образец не отправлен;
  - образец без картинок → текст, как раньше (старые тесты `sendSamples` не меняются);
  - картинка не найдена → текст, в нём `картинка design/samples/x/nope.png не найдена`;
  - `sendPhotos` бросает `Telegram sendMediaGroup: Bad Request` → образец текстом, `sendSamples` не бросает;
  - 12 картинок → в `sendPhotos` первые 10.
- [ ] **Step 2:** `node --test test/ux.test.js` — падают.
- [ ] **Step 3:** `sendPhotos` в `src/telegram.js` по образцу `sendVideo` (FormData, `media` — JSON со списком `{ type: 'photo', media: 'attach://pN', caption? }`); в `sendSamples` — для образца с `images`: найденные через `sampleImage(p.projectDir, …)` → `sendPhotos` (до 10), ошибка → прежний текст; ненайденные пути — строкой в тексте.
- [ ] **Step 4:** `node --test test/ux.test.js test/findings.test.js test/telegram*.test.js` — проходят.
- [ ] **Step 5:** коммит `feat(samples): «Как будет выглядеть» присылает картинки альбомом`.

### Task 3: Шаблон «чат Telegram» и `mcfly samples template`

**Files:**
- Create: `templates/design/telegram-chat.html`
- Modify: `src/cli.js` (новая команда, строка в HELP), `test/cli.test.js`

**Interfaces:**
- Produces: `mcfly samples template` → копирует шаблон в `<проект>/design/samples/telegram-chat.html`, если файла нет («Шаблон: …»), иначе «Уже есть: …»; код 0; печатает 2–3 строки, как пользоваться (вписать текст и кнопки, снять Playwright в обеих темах, `?theme=dark`, путь картинок).

- [ ] **Step 1: тест** `'samples template: кладёт шаблон чата в проект, повтор не перезаписывает'` — файл создан, содержит обработку `theme=dark` и ширину `390px`; второй вызов — «Уже есть», содержимое не тронуто.
- [ ] **Step 2:** `node --test test/cli.test.js` — падает.
- [ ] **Step 3:** шаблон — одна страница без внешних ресурсов: фон чата, пузырь бота (текст с переносами), ряды кнопок под пузырём, время; цвета светлой и тёмной темы Telegram; места для правки помечены комментариями `<!-- ТЕКСТ -->`, `<!-- КНОПКИ -->`. Команда в `src/cli.js` по образцу других без проекта-состояния.
- [ ] **Step 4:** `node --test test/cli.test.js` — проходит; открыть шаблон в браузере (светлая и `?theme=dark`) и снять картинку — выглядит как сообщение Telegram.
- [ ] **Step 5:** коммит `feat(samples): шаблон чата Telegram для образцов сообщений бота`.

### Task 4: Правила дизайнера, предупреждение, версия

**Files:**
- Modify: `agents/designer.md`, `skills/mcfly-process/SKILL.md` (раздел про образцы), `src/cli.js` (approval request), `README.md`, `CHANGELOG.md`, `package.json`, `.claude-plugin/plugin.json`
- Test: `test/ux.test.js` или `test/cli.test.js`

- [ ] **Step 1: тест** — `approval request` плана с образцами без «Картинка:» → код 0 и в выводе `⚠ У образцов нет картинок`; с картинкой — без предупреждения.
- [ ] **Step 2:** запустить — падает.
- [ ] **Step 3:** предупреждение в `src/cli.js` после проверки раздела «Как это будет выглядеть». Дизайнеру: у каждого образца строки «Картинка:»; экран — своими средствами, сообщение бота — по шаблону (`mcfly samples template`), снимок Playwright в `design/samples/<изменение>/NN-light.png` и `-dark.png` (обе темы, если они есть у продукта), коммит вместе с планом; текстовый блок остаётся. То же коротко в скилле и README. Версия 0.19.0 и запись в CHANGELOG.
- [ ] **Step 4:** `npm test` — всё зелёное.
- [ ] **Step 5:** коммит `feat(samples): образцы картинками (0.19.0)`.
