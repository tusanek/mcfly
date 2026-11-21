# Снимки образцов командой mcfly — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `mcfly samples shoot <изменение>` снимает картинки HTML-образцов сам, без Playwright MCP и без http-сервера.

**Architecture:** Новый модуль `src/shoot.js`: поиск браузера, список образцов, съёмка через канал отладки Chrome по трубам (`--remote-debugging-pipe`, дескрипторы 3/4, сообщения JSON с `\0` в конце). cli.js вызывает его из `samples shoot` и из `approval request` (только недостающие картинки); doctor проверяет браузер.

**Tech Stack:** Node 20+ (ESM, `node:child_process`), Chrome/Chromium headless, `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-21-samples-shoot-design.md`; проверка подхода — прототип в scratchpad (Target.createTarget → Target.attachToTarget `flatten: true` → Emulation.setDeviceMetricsOverride → Page.enable → Page.navigate `file://` → ждать Page.loadEventFired → Runtime.evaluate прямоугольника → Page.captureScreenshot `clip`).

## Global Constraints

- Без новых npm-зависимостей.
- Ширина окна 390, `deviceScaleFactor: 2`; элемент `#shot`, без него — `document.documentElement`.
- Образец — файл `design/samples/<изменение>/NN.html`, NN — только цифры; картинки `NN-light.png`, `NN-dark.png` рядом.
- Тёмная тема — страница с `?theme=dark`, только если в HTML есть `theme=dark` или `.dark`.
- Предел времени на страницу — 20 секунд.
- Браузер: `samples.browser` из config.yaml → `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` → новейший `~/Library/Caches/ms-playwright/chromium-*/chrome-mac*/Chromium.app/Contents/MacOS/Chromium` (поиск по шаблону, без жёсткой версии).
- Профиль браузера — временный каталог в `os.tmpdir()`, удаляется после `Browser.close` и выхода процесса (`rmSync` с `maxRetries: 5`), ошибка удаления не роняет команду.
- Тексты для людей — по-русски, без названий личных проектов.

## Review Focus

- Имя изменения с `..` или `/` — отказ до любых действий с файлами (`/^[a-z0-9][a-z0-9-]*$/`).
- Нет каталога `design/samples/<изменение>` или в нём нет NN.html — понятное сообщение, код 1 у `samples shoot`; `approval request` молчит.
- Страница не загрузилась за 20 с или браузер упал — сообщение с именем файла, остальные образцы снимаются, браузер закрыт, код 1.
- Вызов из worktree разработчика — картинки ложатся в этот worktree, не в основной каталог.
- Повторный `approval request` не переснимает готовые картинки.

---

### Task 1: модуль съёмки `src/shoot.js`

**Files:**
- Create: `src/shoot.js`
- Test: `test/shoot.test.js`

**Interfaces:**
- Produces:
  - `findBrowser({ configured = '', exists = fs.existsSync, home = os.homedir(), list = (dir) => fs.readdirSync(dir) } = {}) -> string | null`
  - `sampleFiles(baseDir: string, change: string) -> { error?: string, files: { html: string, light: string, dark: string|null }[] }` — пути абсолютные; `dark` — null, если тёмной темы нет.
  - `async shootFiles(files, { browser: string, timeoutMs = 20000, onlyMissing = false }) -> { shot: string[], skipped: string[], failed: { file: string, error: string }[] }` — параметр `onlyMissing`: снимать только отсутствующие png.

- [ ] **Step 1: тесты**

```js
test('findBrowser: настройка, затем Chrome, затем новейший Chromium Playwright', () => {
  const have = new Set(['/x/chrome', CHROME, '/h/Library/Caches/ms-playwright/chromium-1200/chrome-mac/Chromium.app/Contents/MacOS/Chromium', '/h/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium']);
  const list = () => ['chromium-1200', 'chromium-1217', 'chromium_headless_shell-1217', 'ffmpeg-1011'];
  const subs = (d) => (d.endsWith('1200') ? ['chrome-mac'] : ['chrome-mac-arm64']);
  assert.equal(findBrowser({ configured: '/x/chrome', exists: (p) => have.has(p), home: '/h', list }), '/x/chrome');
  assert.equal(findBrowser({ exists: (p) => have.has(p), home: '/h', list }), CHROME);
  // без Chrome — новейший chromium-*, не headless_shell
  ...ожидание '/h/.../chromium-1217/chrome-mac-arm64/...'
  assert.equal(findBrowser({ exists: () => false, home: '/h', list: () => [] }), null);
});
test('sampleFiles: NN.html по порядку, тёмная — только с theme=dark или .dark; плохое имя и пустой каталог — ошибка', ...)
  // 01.html с «:root.dark», 02.html без тёмной, telegram-chat.html и 1a.html — не образцы
  // assert.equal(sampleFiles(dir, '../x').error, ...), sampleFiles(dir, 'нет').error матчит /нет образцов/
test('shootFiles: настоящий браузер снимает #shot в 780 точек шириной; onlyMissing не трогает готовые', { skip: !findBrowser() && 'нет браузера' }, ...)
  // ширину PNG читать из заголовка: buf.readUInt32BE(16) === 780; второй вызов с onlyMissing → shot пуст, skipped = 2
test('shootFiles: страница, которая не грузится за timeoutMs, — failed, остальные сняты', { skip: ... })
  // 02.html с <script>while(true){}</script>, timeoutMs: 3000
```

(`CHROME` — экспортируемая константа пути Chrome из `src/shoot.js`; поиск подкаталога Chromium — через `list` второго уровня.)

- [ ] **Step 2: `node --test test/shoot.test.js` — FAIL (нет модуля)**
- [ ] **Step 3: реализация** — протокол как в прототипе; один процесс браузера на все файлы, новая вкладка (`Target.createTarget`) на каждую страницу и тему, `Target.closeTarget` после; предел — `Promise.race` с таймером на каждую страницу; закрытие — `Browser.close`, ожидание `exit` (не дольше 5 с, затем `kill`).
- [ ] **Step 4: `node --test test/shoot.test.js` — PASS**
- [ ] **Step 5: коммит** `feat(samples): съёмка образцов через канал отладки Chrome`

### Task 2: команда, approval request, doctor, настройки

**Files:**
- Modify: `src/cli.js` (case 'samples', блок картинок в approval request, справка), `src/doctor.js`, `src/config.js` (умолчание `samples: { browser: '' }`, проверка — строка), `templates/settings.json` (allow `Bash(mcfly samples shoot *)`), `templates/config.yaml` (раздел samples закомментирован)
- Test: `test/shoot.test.js`, `test/doctor.test.js`, `test/init.test.js`

**Interfaces:**
- Consumes: всё из Task 1.

- [ ] **Step 1: тесты**
  - `mcfly samples shoot` без имени — код 1, «mcfly samples shoot <изменение>»; с `../x` — код 1.
  - `mcfly samples shoot demo --project <worktree>` (worktree от `git worktree add`) с настоящим браузером — png в worktree, не в основном каталоге; вывод «Снято: 01-light.png, 01-dark.png» и напоминание про строки «Картинка:». Пропуск, если браузера нет.
  - `samples.browser: /нет/такого` → `samples shoot` — код 1, «браузер не найден»; doctor — ✗ «браузер для снимков образцов» с подсказкой `samples.browser`.
  - init: `settings.permissions.allow` содержит `Bash(mcfly samples shoot *)`.
  - approval request: у изменения есть `design/samples/<имя>/01.html` без png → после запроса есть `01-light.png` (настоящий браузер; пропуск без него); при `samples.browser: /нет/такого` запрос всё равно код 0 и строка «⚠ Картинки не сняты: …».
- [ ] **Step 2: запустить — FAIL**
- [ ] **Step 3: реализация.** Каталог съёмки для `samples shoot` — как у `worktree link`: `--project` или текущий каталог (не `MCFLY_PROJECT_DIR`), его git-корень. В approval request — до блока «⚠ У образцов нет картинок», `onlyMissing: true`, база — `projectDir`; ошибки — одной строкой ⚠, не отказ.
- [ ] **Step 4: `npm test` — PASS**
- [ ] **Step 5: коммит** `feat(samples): mcfly samples shoot, съёмка при запросе одобрения, проверка браузера`

### Task 3: тексты, версия, журнал

**Files:** `agents/designer.md`, `templates/design/telegram-chat.html` (п. 3), подсказка `samples template` в `src/cli.js`, README (раздел образцов и таблица команд), `CHANGELOG.md` (0.20.0), `package.json` и `.claude-plugin/plugin.json` → 0.20.0, `~/mcfly-inbox.md` (F15 → `[x] (0.20.0)`).

- [ ] **Step 1:** заменить «сними Playwright …» на «выполни `mcfly samples shoot <изменение>`»; в designer.md — что команда снимает и что строки «Картинка:» дописывает дизайнер.
- [ ] **Step 2:** `grep -rn "Playwright" agents templates/design src/cli.js` — про съёмку образцов упоминаний нет.
- [ ] **Step 3:** `npm test` — PASS; коммит `docs(samples): дизайнер снимает образцы командой mcfly (0.20.0)`.
