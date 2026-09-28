---
name: mcfly-openspec
description: Как команда mcfly работает с OpenSpec — команды CLI, формат дельт, флаг одобрения, параллельная работа, архивация. Читать перед созданием или изменением артефактов в openspec/.
---
# OpenSpec в mcfly

## Структура
- `openspec/specs/<область>/spec.md` — текущие требования (`### Requirement:` + `#### Scenario:`).
- `openspec/changes/<имя>/` — `proposal.md`, `specs/<область>/spec.md` (дельты), `design.md`, `tasks.md`, `.openspec.yaml` (метаданные; блок `mcfly:` — одобрение).
- `openspec/changes/archive/` — завершённые изменения. `openspec/config.yaml` — схема и правила проекта.

## Команды CLI (без интерактива)
- `openspec new change <имя> --goal "<цель>"` — создать изменение.
- `openspec status --all --json` — состояние артефактов.
- `openspec validate <имя> --strict`, `openspec validate --all --strict --json` — проверка.
- `openspec archive <имя> --yes` — архивация (только devops, строго по одному).
Слэш-команды `/opsx:*` — для интерактивных сессий; в прогонах используйте CLI и пишите артефакты по шаблонам схемы проекта (`openspec/schemas/` или встроенная spec-driven).

## Формат дельт
В `specs/<область>/spec.md` изменения: секции `## ADDED Requirements`, `## MODIFIED Requirements`, `## REMOVED Requirements`. Внутри — `### Requirement: <имя>` с формулировкой SHALL/MUST и хотя бы одним `#### Scenario:` (WHEN/THEN). MODIFIED содержит полный новый текст требования. Имена требований уникальны в области.

## Одобрение (адаптация mcfly)
Блок в `.openspec.yaml` изменения:
```yaml
mcfly:
  approval: pending | approved | rejected
  category: spec | prod
  requested_at: <ISO>
```
Ставится командой `mcfly approval request <имя>` и ответами человека. Реализовывать можно только `approved`. Отклонённое изменение — переработать proposal с учётом причины из `mcfly/answers.md` и запросить снова, либо удалить.

## Параллельная работа
- Одно изменение — один владелец на задачу; разные изменения не трогают одно и то же требование одновременно.
- Ветки `change/<имя>`, worktree на разработчика; слияние только через devops.
- Архивация последовательная; конфликт при архивации devops разрешает вручную и сообщает лиду.

## Правила
- Не больше 10 задач на изменение; задача — один проверяемый шаг.
- Дельты обязательны для любого изменения поведения; `--skip-specs` запрещён без одобрения человека.
- Перед запросом одобрения и перед архивацией — `validate --strict` без ошибок.
