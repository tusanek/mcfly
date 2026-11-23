# mcfly

Комплект ИИ-команды разработки: плагин Claude Code + CLI `mcfly` (Node 20+, ESM). Описание для людей: README.md, быстрый старт: docs/quickstart.md, история: CHANGELOG.md.

## Где что
- agents/ - роли-субагенты (lead, planner, developer, user, dweller...). Поле model: задаёт модель роли.
- skills/ - навыки: mcfly-process (правила процесса), mcfly-openspec, take-shift, hand-shift.
- prompts/run.md - промпт ночного прогона для лида.
- commands/, hooks/hooks.json, .claude-plugin/ - слэш-команды, хук SessionStart, описание плагина.
- src/ - код CLI (вход src/cli.js, прогон src/runner.js, Telegram src/telegram.js и src/pull.js). Карта модулей: src/CLAUDE.md.
- test/ - тесты: `npm test`.
- video/ - шаблон ролика-сводки (Remotion) и скрипт озвучки (Silero); `mcfly video setup` ставит их в ~/.mcfly/video.
- templates/ - что `mcfly init` кладёт в чужой проект (config.yaml, CLAUDE.snippet.md, settings.json).
- docs/superpowers/ - планы и проекты (specs) крупных доработок. Список документов: docs/README.md.
- Долги и отложенное: docs/BACKLOG.md.

## Правила
- Новая версия: поднять version в package.json и .claude-plugin/plugin.json, запись в CHANGELOG.md.
- Комплект ставится на любой проект: в agents/ и skills/ не писать команды и цифры конкретного проекта.
