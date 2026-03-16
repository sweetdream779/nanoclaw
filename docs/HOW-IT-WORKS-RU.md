# Как работает NanoClaw — полная техническая документация

## Обзор

NanoClaw — это один Node.js процесс, который связывает мессенджеры (Telegram, WhatsApp, Slack, Discord, Gmail) с Claude через Anthropic Agent SDK. Каждый диалог выполняется внутри изолированного Docker-контейнера с собственной файловой системой, сессией и IPC-пространством.

---

## 1. Запуск системы

Точка входа: `src/index.ts`, функция `main()`.

Последовательность запуска:

1. **Проверка Docker** — `ensureContainerRuntimeRunning()` запускает `docker info`. `cleanupOrphans()` убивает контейнеры `nanoclaw-*`, оставшиеся от предыдущего падения.

2. **Инициализация БД** — `initDatabase()` открывает или создаёт `store/messages.db` (SQLite), выполняет `CREATE TABLE IF NOT EXISTS` для всех таблиц и запускает миграции.

3. **Загрузка состояния** — `loadState()` читает из SQLite: курсоры сообщений (`last_timestamp`, `last_agent_timestamp`), сессии (`sessions`), зарегистрированные группы (`registeredGroups`).

4. **Credential Proxy** — HTTP-прокси на порту 3001. Контейнеры направляют все API-запросы через него. Прокси подставляет реальные креды (OAuth-токен или API-ключ) вместо `placeholder`, который видят контейнеры.

5. **Каналы** — каждый канал (Telegram, WhatsApp и т.д.) регистрирует себя при импорте через `registerChannel()`. `main()` вызывает фабрику каждого канала и `channel.connect()`. Если креды не заданы — канал пропускается.

6. **Подсистемы** — запускаются параллельно:
   - **Scheduler** — каждые 60 секунд проверяет запланированные задачи
   - **IPC Watcher** — каждую секунду сканирует `data/ipc/` на файлы от контейнеров
   - **Message Loop** — каждые 2 секунды опрашивает БД на новые сообщения
   - **Recovery** — проверяет необработанные сообщения после падения

---

## 2. Жизненный цикл сообщения

### Шаг 1: Получение (канал)

Пользователь отправляет сообщение в Telegram → grammY получает update через long-polling:
- Формируется `chatJid = "tg:{chat_id}"`
- `@bot_username` транслируется в `@AssistantName` для совпадения с триггером
- Метаданные чата сохраняются (`chats` таблица)
- Если чат не зарегистрирован — сообщение отбрасывается
- Вызывается `onMessage(chatJid, msg)` → `storeMessage(msg)` — INSERT в таблицу `messages`

### Шаг 2: Обнаружение (message loop)

Каждые 2 секунды `getNewMessages()` ищет сообщения с `timestamp > lastTimestamp`:
- Курсор `lastTimestamp` продвигается сразу
- Сообщения группируются по `chatJid`
- Для не-main групп проверяется триггер (`@Andy`)
- Если контейнер уже запущен и ждёт — сообщение передаётся через IPC (stdin piping)
- Если нет активного контейнера — создаётся новый

### Шаг 3: Обработка (`processGroupMessages`)

- Загружаются все сообщения с момента последнего ответа агента
- Форматируются в XML: `<messages><message sender="Влад" time="...">текст</message></messages>`
- Отправляется статус "⏳ Starting..." в Telegram
- Вызывается `runAgent()`

### Шаг 4: Запуск контейнера (`runContainerAgent`)

- Формируются volume mounts (проект, группа, сессия, IPC, внешние папки)
- Генерируется имя: `nanoclaw-telegram-main-{timestamp}`
- Запускается: `docker run -i --rm --name ... nanoclaw-agent:latest`
- JSON с промптом пишется в `stdin`, затем `stdin.end()`

### Шаг 5: Внутри контейнера

Entrypoint (`container/Dockerfile`):
```bash
cd /app && npx tsc --outDir /tmp/dist   # Компиляция TypeScript
cat > /tmp/input.json                    # Чтение stdin
node /tmp/dist/index.js < /tmp/input.json # Запуск agent-runner
```

Agent-runner (`container/agent-runner/src/index.ts`):
- Парсит JSON из stdin
- Создаёт `MessageStream` — push-based async iterable
- Запускает IPC-поллинг (500мс) для follow-up сообщений
- Вызывает `query()` из Agent SDK

### Шаг 6: Agent SDK

```typescript
for await (const message of query({
  prompt: stream,
  options: {
    cwd: '/workspace/group',
    resume: sessionId,
    allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', ...],
    permissionMode: 'bypassPermissions',
    mcpServers: { nanoclaw: { command: 'node', args: ['ipc-mcp-stdio.js'] } },
  }
})) { ... }
```

SDK эмитит сообщения:
- `system/init` — инициализация сессии
- `assistant` — ответ модели с content blocks (текст + tool_use)
- `result` — финальный результат

### Шаг 7: Потоковый вывод

При каждом `assistant` сообщении с `tool_use`:
```
---NANOCLAW_OUTPUT_START---
{"status":"success","result":null,"thinking":"Read:/workspace/extra/CleaveStudio/file.txt"}
---NANOCLAW_OUTPUT_END---
```

При `result`:
```
---NANOCLAW_OUTPUT_START---
{"status":"success","result":"Вот содержимое файла...","newSessionId":"abc-123"}
---NANOCLAW_OUTPUT_END---
```

### Шаг 8: Обработка на хосте

`container.stdout` парсит маркеры `OUTPUT_START/END`:
- **Thinking** → `updateStatus()` → `channel.editMessage()` — обновляет статус в Telegram
- **Result** → `clearStatus()` → `channel.sendMessage()` — удаляет статус, отправляет ответ
- Сессия сохраняется в SQLite для следующего вызова

---

## 3. Система контейнеров

### Образ (`container/Dockerfile`)

Базовый образ: `node:22-slim`. Содержит:
- Chromium + зависимости (для браузерной автоматизации)
- `@anthropic-ai/claude-code` (глобально)
- `agent-runner` — TypeScript приложение, мост между stdin/stdout и Agent SDK

### Перекомпиляция при запуске

Исходники agent-runner монтируются из `data/sessions/{folder}/agent-runner-src/` → `/app/src`. Каждый запуск перекомпилирует TypeScript. Это позволяет:
- Агенту модифицировать свой собственный runner
- Кастомизировать поведение per-group
- Применять обновления без пересборки образа

### Переиспользование контейнера

Контейнер не убивается после ответа. Он ждёт новых сообщений через IPC-поллинг:
1. Хост пишет файл в `data/ipc/{folder}/input/`
2. Контейнер подхватывает его за 500мс
3. Пушит в `MessageStream` → SDK начинает новый turn
4. Всё в рамках одного процесса, одной сессии

### Idle timeout

После `IDLE_TIMEOUT` (30 мин по умолчанию) без сообщений:
- Хост пишет файл `_close` в IPC input
- Контейнер обнаруживает sentinel, выходит из цикла
- Docker `--rm` автоматически удаляет контейнер

---

## 4. Каналы

### Архитектура саморегистрации

```
src/channels/index.ts  ←  barrel import (триггерит регистрацию)
src/channels/telegram.ts  →  registerChannel('telegram', factory)
src/channels/registry.ts  →  Map<string, ChannelFactory>
```

Каждый канал — отдельный файл, который при импорте вызывает `registerChannel()`. `main()` проходит по всем зарегистрированным каналам и создаёт инстансы.

### Интерфейс Channel

```typescript
interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;         // tg: → Telegram, dc: → Discord
  disconnect(): Promise<void>;
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  sendTrackedMessage?(jid, text): Promise<number | string | null>;
  editMessage?(jid, messageId, text): Promise<void>;
  deleteMessage?(jid, messageId): Promise<void>;
}
```

### JID конвенция

| Канал | Формат JID |
|-------|-----------|
| Telegram | `tg:{chat_id}` |
| WhatsApp | `{number}@g.us` / `{number}@s.whatsapp.net` |
| Discord | `dc:{channel_id}` |

---

## 5. IPC система

Двунаправленная файловая IPC между хостом и контейнерами.

### Хост → Контейнер (input pipe)

Директория: `data/ipc/{groupFolder}/input/`
- Файлы сообщений: `{timestamp}-{random}.json` с `{type: "message", text: "..."}`
- Sentinel закрытия: `_close` (пустой файл)

### Контейнер → Хост (команды)

Через MCP-сервер `ipc-mcp-stdio.ts`, доступный агенту как инструменты:

| Инструмент | Назначение |
|-----------|-----------|
| `send_message` | Отправить сообщение пользователю прямо сейчас |
| `schedule_task` | Создать запланированную задачу (cron/interval/once) |
| `list_tasks` | Просмотреть текущие задачи |
| `pause_task` / `resume_task` / `cancel_task` | Управление задачами |
| `register_group` | Зарегистрировать новый чат (только main) |

Файлы пишутся в `data/ipc/{folder}/messages/` и `data/ipc/{folder}/tasks/`. Хостовый IPC Watcher подхватывает их каждую секунду.

---

## 6. Credential Proxy

Контейнеры никогда не видят реальные креды. Вместо этого:

1. Контейнер получает `ANTHROPIC_BASE_URL=http://host.docker.internal:3001`
2. Контейнер получает `CLAUDE_CODE_OAUTH_TOKEN=placeholder`
3. Все API-запросы идут через прокси
4. Прокси читает `.env` файл (через `readEnvFile()`, без загрузки в `process.env`)
5. Прокси подставляет реальный токен в заголовок `Authorization`
6. Запрос уходит в Anthropic API

Это предотвращает утечку секретов через дочерние процессы или агентские инструменты.

---

## 7. Очередь и конкурентность

`GroupQueue` в `src/group-queue.ts` управляет контейнерами.

### Состояние группы

```typescript
interface GroupState {
  active: boolean;           // Контейнер запущен
  idleWaiting: boolean;      // Ждёт новых сообщений
  isTaskContainer: boolean;  // Запланированная задача
  pendingMessages: boolean;  // Есть необработанные сообщения
  pendingTasks: QueuedTask[];
  retryCount: number;
}
```

### Конкурентность

`MAX_CONCURRENT_CONTAINERS = 5`. Если лимит достигнут — JID добавляется в FIFO-очередь `waitingGroups`. Когда контейнер завершается — запускается следующий из очереди.

### Retry

При ошибке: `retryCount++`, задержка `5000 * 2^(retryCount-1)`, максимум 5 попыток.

---

## 8. База данных

Файл: `store/messages.db` (SQLite через `better-sqlite3`).

| Таблица | Содержимое |
|---------|-----------|
| `chats` | Все виденные чаты (JID, имя, канал, группа/личный) |
| `messages` | Полный контент сообщений зарег. групп |
| `registered_groups` | Активные группы (JID, имя, папка, триггер, конфиг контейнера) |
| `sessions` | Claude session ID per group |
| `router_state` | Key/value курсоры (last_timestamp, last_agent_timestamp) |
| `scheduled_tasks` | Запланированные задачи (cron/interval/once) |
| `task_run_logs` | История выполнения задач |

---

## 9. Планировщик задач

`src/task-scheduler.ts` — каждые 60 секунд проверяет `getDueTasks()`.

Типы расписания:
- **cron** — стандартный формат (парсится `cron-parser` с учётом таймзоны)
- **interval** — повтор через N миллисекунд (привязан к запланированному времени, не к фактическому — предотвращает накопление сдвига)
- **once** — однократное выполнение

Задачи запускаются в отдельных контейнерах. `context_mode` определяет, использовать ли существующую сессию группы или создать изолированный контекст.

---

## 10. Система маунтов

### Стандартные маунты (всегда)

| Хост | Контейнер | Доступ |
|------|----------|--------|
| Корень проекта | `/workspace/project` | Только чтение (только main) |
| `/dev/null` | `/workspace/project/.env` | Теневой маунт (защита секретов) |
| `groups/{folder}` | `/workspace/group` | Чтение/запись |
| `groups/global` | `/workspace/global` | Только чтение |
| `data/sessions/{folder}/.claude` | `/home/node/.claude` | Чтение/запись |
| `data/ipc/{folder}` | `/workspace/ipc` | Чтение/запись |
| `data/sessions/{folder}/agent-runner-src` | `/app/src` | Чтение/запись |

### Дополнительные маунты

Настраиваются в `containerConfig.additionalMounts` группы. Валидируются по allowlist из `~/.config/nanoclaw/mount-allowlist.json`:
- Путь должен существовать
- Должен быть под одним из `allowedRoots`
- Не должен совпадать с `blockedPatterns` (`.ssh`, `.gnupg`, `.aws`, `.env`, ...)
- Non-main группы могут иметь только read-only доступ

Маунты появляются в `/workspace/extra/{containerPath}/`.

---

## 11. Статус "Thinking"

Реализован для отображения прогресса работы агента в Telegram.

### Поток данных

1. **Agent-runner** (в контейнере): при каждом `tool_use` в `assistant` сообщении SDK извлекает имя инструмента и ключевой аргумент → эмитит `writeOutput({ thinking: "Read:/path/to/file" })`

2. **Container-runner** (на хосте): парсит OUTPUT маркеры, вызывает `onOutput()`

3. **processGroupMessages**: при получении thinking-события:
   - Парсит `"ToolName:detail"` → emoji + verb + сокращённый путь
   - Накапливает строки (последние 4)
   - `channel.editMessage()` обновляет статус-сообщение

4. При получении результата — `channel.deleteMessage()` удаляет статус

### Пример отображения

```
⏳ Starting...
```
→
```
📖 Reading `CleaveStudio/LowFuelRoot/README.md`
🔍 Searching `*.cs`
💻 Running `find . -name "*.cs" | head -20`
```
→ (удаляется, приходит ответ)

---

## 12. Конфигурация

### `.env` — секреты

| Переменная | Назначение |
|-----------|-----------|
| `CLAUDE_CODE_OAUTH_TOKEN` | OAuth-токен Claude (Pro/Max подписка) |
| `ANTHROPIC_API_KEY` | Альтернатива — API-ключ |
| `TELEGRAM_BOT_TOKEN` | Токен Telegram бота |
| `ASSISTANT_NAME` | Имя ассистента (по умолчанию `Andy`) |

### `src/config.ts` — константы

| Параметр | Значение | Описание |
|---------|---------|----------|
| `POLL_INTERVAL` | 2000 мс | Интервал проверки сообщений |
| `IDLE_TIMEOUT` | 30 мин | Время ожидания до закрытия контейнера |
| `CONTAINER_TIMEOUT` | 30 мин | Максимальное время жизни контейнера |
| `MAX_CONCURRENT_CONTAINERS` | 5 | Лимит одновременных контейнеров |
| `CREDENTIAL_PROXY_PORT` | 3001 | Порт credential proxy |

### Per-group `CLAUDE.md`

Файл `groups/{folder}/CLAUDE.md` — персональная память агента. SDK автоматически загружает его, т.к. рабочая директория установлена в `/workspace/group`. Файлы CLAUDE.md из дополнительных маунтов тоже загружаются через `additionalDirectories`.

---

## 13. Ключевые файлы

| Файл | Роль |
|------|------|
| `src/index.ts` | Оркестратор: запуск, message loop, обработка сообщений, thinking статус |
| `src/config.ts` | Все настройки (не-секретные) |
| `src/types.ts` | Интерфейсы: Channel, RegisteredGroup, NewMessage, ScheduledTask |
| `src/channels/registry.ts` | Реестр каналов (Map + саморегистрация) |
| `src/channels/telegram.ts` | Telegram канал (grammY) |
| `src/container-runner.ts` | Запуск Docker, маунты, парсинг OUTPUT маркеров |
| `src/container-runtime.ts` | Абстракция рантайма: Docker/Apple Container |
| `src/group-queue.ts` | Управление контейнерами, конкурентность, retry |
| `src/ipc.ts` | IPC watcher: обработка файлов от контейнеров |
| `src/credential-proxy.ts` | HTTP прокси для подстановки кредов |
| `src/db.ts` | SQLite: схема, запросы, миграции |
| `src/task-scheduler.ts` | Планировщик задач |
| `src/mount-security.ts` | Валидация маунтов, allowlist |
| `src/router.ts` | XML-форматирование, поиск канала |
| `src/env.ts` | Безопасное чтение `.env` (без `process.env`) |
| `container/Dockerfile` | Образ: node:22-slim + Chromium + claude-code |
| `container/agent-runner/src/index.ts` | Мост stdin/stdout ↔ Agent SDK |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | MCP-сервер: send_message, schedule_task и др. |

---

## Диаграмма архитектуры

```
┌──────────────┐     long-polling      ┌──────────────────┐
│   Telegram   │ ◄──────────────────► │  NanoClaw (host)  │
│   (grammY)   │                       │                   │
└──────────────┘                       │  ┌─────────────┐  │
                                       │  │ Message Loop │  │ ← 2с поллинг SQLite
                                       │  └──────┬──────┘  │
                                       │         │         │
                                       │  ┌──────▼──────┐  │
                                       │  │ GroupQueue   │  │ ← макс 5 контейнеров
                                       │  └──────┬──────┘  │
                                       │         │         │
                                       │  ┌──────▼──────┐  │
                                       │  │ Container   │  │
                                       │  │ Runner      │──┼──► docker run -i --rm
                                       │  └──────┬──────┘  │
                                       │         │         │
                                       │  ┌──────▼──────┐  │
                                       │  │ Credential  │  │ ← :3001
                                       │  │ Proxy       │  │
                                       │  └──────┬──────┘  │
                                       └─────────┼─────────┘
                                                 │
                              ┌──────────────────▼──────────────────┐
                              │         Docker Container            │
                              │                                     │
                              │  ┌─────────────────────────────┐    │
                              │  │  agent-runner (Node.js)     │    │
                              │  │                             │    │
                              │  │  ┌───────────────────────┐  │    │
                              │  │  │  Claude Agent SDK     │  │    │
                              │  │  │  query() → messages   │  │    │
                              │  │  └───────────┬───────────┘  │    │
                              │  │              │              │    │
                              │  │  ┌───────────▼───────────┐  │    │
                              │  │  │  MCP Server (IPC)     │  │    │
                              │  │  │  send_message         │  │    │
                              │  │  │  schedule_task         │  │    │
                              │  │  └───────────────────────┘  │    │
                              │  └─────────────────────────────┘    │
                              │                                     │
                              │  /workspace/group    ← группа      │
                              │  /workspace/extra/*  ← маунты     │
                              │  /workspace/ipc      ← IPC        │
                              └─────────────────────────────────────┘
```
