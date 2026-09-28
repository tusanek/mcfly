# Changelog

## 0.2.0 — 2026-09-28

- Runner: очистка переменных вложенной сессии Claude Code перед `claude -p`; поддержка `CLAUDE_CODE_OAUTH_TOKEN` из `mcfly/.env` (перекрывает окружение, отключает `ANTHROPIC_*`); статус `quota` для лимитов сессии и недели; потоковый вывод `stream-json` и журнал событий `runs/<id>/events.log`; служебные файлы прогона коммитятся автоматически; пропущенный прогон тоже коммитит состояние; `--dry-run` не оставляет следов в `runs/`.
- Лид: шаг 0 «подхватить незавершённую работу прошлого прогона» (worktree и ветки `change/*`).
- Приоритет изменений (`mcfly approval … --priority`), порядок в контексте и сводке.
- Модели ролей: developer, tester, devops, reporter, designer закреплены за `claude-sonnet-5-5`; остальные наследуют модель лида.
- `mcfly doctor`: проверка авторизации CLI, диагностика токена и окружения, `--probe` с реальным пробным запуском.
- Шаблон settings запрещает Edit и Write для `mcfly/config.yaml` и `mcfly/.env`; `.DS_Store` в .gitignore.
- Репортёру запрещено писать в `metrics.jsonl` напрямую.

## 0.1.0 — 2026-09-28

Первая версия комплекта: плагин Claude Code (десять ролей, два скилла, команды, хук), CLI `mcfly` (init, doctor, run, summary, answers, context, status, question, approval, metric, telegram pair, schedule), адаптации OpenSpec (флаг одобрения), Telegram в обе стороны, расписание launchd, метрики.
