# Новый проект с mcfly за 30 минут

0. Установите инструменты: Claude Code CLI с подпиской, `npm install -g @fission-ai/openspec@latest`, комплект `git clone … ~/mcfly && cd ~/mcfly && npm install && npm link`.
1. В каталоге проекта: `git init` (если ещё нет) и `mcfly init --name <проект> [--with-tracker]`. Появятся `mcfly/`, правила в `.claude/settings.json`, раздел в CLAUDE.md, `openspec/` с командами `/opsx:*`.
2. Создайте бота в BotFather, скопируйте токен: `cp mcfly/.env.example mcfly/.env` и впишите `MCFLY_TELEGRAM_TOKEN=…`.
3. `mcfly telegram pair`, затем отправьте боту любое сообщение — chat_id сохранится в `mcfly/config.yaml`.
4. `mcfly doctor` — все пункты должны быть ✓.
5. Первые спецификации. Либо дайте команде сформулировать их самой (первый прогон создаст изменения и запросит одобрение), либо создайте стартовое изменение вручную: `openspec new change bootstrap --goal "…"`, заполните proposal, дельты specs, design и tasks (в интерактивной сессии удобно `/opsx:propose`), проверьте `openspec validate bootstrap --strict` и одобрите: `mcfly approval set bootstrap approved --note "стартовое"`.
6. Пробный прогон: `mcfly run --mode day --dry-run` покажет команду и сохранит промпт в `mcfly/runs/<id>/prompt.md`; затем `mcfly run --mode day` запустит команду по-настоящему.
7. Расписание: `mcfly schedule install` (прогоны 00:00 и 04:00, сводка 08:00; меняется в `mcfly/config.yaml`, после правки повторите install). Ноутбук на ночь оставьте на зарядке.
8. Утром: читайте сводку в Telegram, отвечайте `Q1: …`, `approve <имя>`, `reject <имя> причина`. Ответы попадут в `mcfly/answers.md` перед следующим прогоном (или сразу: `mcfly answers`).
