## mcfly: команда агентов

Проект {{PROJECT}} разрабатывает ИИ-команда mcfly. Правила процесса — скилл `mcfly-process`, работа со спецификациями — скилл `mcfly-openspec` (плагин mcfly).

- Спецификации: `openspec/specs` (правда о системе), изменения: `openspec/changes/<имя>` (proposal, дельты specs, design, tasks). Интерактивные команды OpenSpec: `/opsx:*`.
- Состояние команды: каталог `mcfly/` — `progress.md` (журнал), `questions.yaml` и `answers.md` (вопросы человеку и ответы), `runs/<id>/summary.md` (отчёты прогонов), `metrics.jsonl`.
- Эскалация человеку только через `mcfly question add --category <spec|deps|prod|budget|stuck> --text "..." --default "..."`; после регистрации продолжайте по ответу по умолчанию (кроме prod).
- Запрещено: прод-сервер и секреты, `git push --force`, правка `mcfly/config.yaml` и плагина mcfly, пропуск дельт спецификаций без одобрения человека.
