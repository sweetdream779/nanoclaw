# How NanoClaw Works — Full Technical Documentation

## Overview

NanoClaw is a single Node.js process that bridges messaging platforms (Telegram, WhatsApp, Slack, Discord, Gmail) with Claude via the Anthropic Agent SDK. Each conversation runs inside an isolated Docker container with its own filesystem, session, and IPC namespace.

---

## 1. System Startup

Entry point: `src/index.ts`, function `main()`.

Startup sequence:

1. **Docker check** — `ensureContainerRuntimeRunning()` runs `docker info`. `cleanupOrphans()` kills any `nanoclaw-*` containers left over from a previous crash.

2. **Database initialization** — `initDatabase()` opens or creates `store/messages.db` (SQLite), runs `CREATE TABLE IF NOT EXISTS` for all tables, and applies migrations.

3. **State loading** — `loadState()` reads from SQLite: message cursors (`last_timestamp`, `last_agent_timestamp`), sessions (`sessions`), registered groups (`registeredGroups`).

4. **Credential Proxy** — HTTP proxy on port 3001. Containers route all API requests through it. The proxy injects real credentials (OAuth token or API key) in place of the `placeholder` that containers see.

5. **Channels** — each channel (Telegram, WhatsApp, etc.) self-registers on import via `registerChannel()`. `main()` calls each channel's factory and `channel.connect()`. If credentials are missing, the channel is skipped.

6. **Subsystems** — started in parallel:
   - **Scheduler** — checks scheduled tasks every 60 seconds
   - **IPC Watcher** — scans `data/ipc/` for container files every second
   - **Message Loop** — polls the database for new messages every 2 seconds
   - **Recovery** — checks for unprocessed messages after a crash

---

## 2. Message Lifecycle

### Step 1: Receiving (channel)

User sends a message in Telegram → grammY receives the update via long-polling:
- `chatJid = "tg:{chat_id}"` is formed
- `@bot_username` is translated to `@AssistantName` to match the trigger pattern
- Chat metadata is stored (`chats` table)
- If the chat is not registered, the message is discarded
- `onMessage(chatJid, msg)` → `storeMessage(msg)` — INSERT into `messages` table

### Step 2: Detection (message loop)

Every 2 seconds `getNewMessages()` looks for messages with `timestamp > lastTimestamp`:
- The `lastTimestamp` cursor is advanced immediately
- Messages are grouped by `chatJid`
- For non-main groups, the trigger is checked (`@Andy`)
- If a container is already running and waiting, the message is delivered via IPC (stdin piping)
- If no active container exists, a new one is created

### Step 3: Processing (`processGroupMessages`)

- All messages since the last agent response are loaded
- Formatted as XML: `<messages><message sender="User" time="...">text</message></messages>`
- A status message "⏳ Starting..." is sent to Telegram
- `runAgent()` is called

### Step 4: Container launch (`runContainerAgent`)

- Volume mounts are assembled (project, group, session, IPC, external directories)
- Container name is generated: `nanoclaw-telegram-main-{timestamp}`
- Launched: `docker run -i --rm --name ... nanoclaw-agent:latest`
- JSON with the prompt is written to `stdin`, then `stdin.end()`

### Step 5: Inside the container

Entrypoint (`container/Dockerfile`):
```bash
cd /app && npx tsc --outDir /tmp/dist   # Compile TypeScript
cat > /tmp/input.json                    # Read stdin
node /tmp/dist/index.js < /tmp/input.json # Run agent-runner
```

Agent-runner (`container/agent-runner/src/index.ts`):
- Parses JSON from stdin
- Creates a `MessageStream` — push-based async iterable
- Starts IPC polling (500ms) for follow-up messages
- Calls `query()` from the Agent SDK

### Step 6: Agent SDK

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

The SDK emits messages:
- `system/init` — session initialization
- `assistant` — model response with content blocks (text + tool_use)
- `result` — final result

### Step 7: Streaming output

On each `assistant` message with `tool_use`:
```
---NANOCLAW_OUTPUT_START---
{"status":"success","result":null,"thinking":"Read:/workspace/group/src/main.ts"}
---NANOCLAW_OUTPUT_END---
```

On `result`:
```
---NANOCLAW_OUTPUT_START---
{"status":"success","result":"Here is the file content...","newSessionId":"abc-123"}
---NANOCLAW_OUTPUT_END---
```

### Step 8: Host-side processing

`container.stdout` parses `OUTPUT_START/END` markers:
- **Thinking** → `updateStatus()` → `channel.editMessage()` — updates the status message in Telegram
- **Result** → `clearStatus()` → `channel.sendMessage()` — deletes the status, sends the response
- Session is saved to SQLite for the next invocation

---

## 3. Container System

### Image (`container/Dockerfile`)

Base image: `node:22-slim`. Contains:
- Chromium + dependencies (for browser automation)
- `@anthropic-ai/claude-code` (global)
- `agent-runner` — TypeScript application, bridge between stdin/stdout and Agent SDK

### Recompilation at startup

Agent-runner source files are mounted from `data/sessions/{folder}/agent-runner-src/` → `/app/src`. Each run recompiles TypeScript. This allows:
- The agent to modify its own runner
- Per-group behavior customization
- Applying updates without rebuilding the image

### Container reuse

The container is not killed after responding. It waits for new messages via IPC polling:
1. Host writes a file to `data/ipc/{folder}/input/`
2. Container picks it up within 500ms
3. Pushes into `MessageStream` → SDK starts a new turn
4. All within the same process and session

### Idle timeout

After `IDLE_TIMEOUT` (30 min by default) without messages:
- Host writes a `_close` file to IPC input
- Container detects the sentinel, exits the loop
- Docker `--rm` automatically removes the container

---

## 4. Channels

### Self-registration architecture

```
src/channels/index.ts  ←  barrel import (triggers registration)
src/channels/telegram.ts  →  registerChannel('telegram', factory)
src/channels/registry.ts  →  Map<string, ChannelFactory>
```

Each channel is a separate file that calls `registerChannel()` on import. `main()` iterates over all registered channels and creates instances.

### Channel interface

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

### JID convention

| Channel | JID Format |
|---------|-----------|
| Telegram | `tg:{chat_id}` |
| WhatsApp | `{number}@g.us` / `{number}@s.whatsapp.net` |
| Discord | `dc:{channel_id}` |

---

## 5. IPC System

Bidirectional file-based IPC between the host and containers.

### Host → Container (input pipe)

Directory: `data/ipc/{groupFolder}/input/`
- Message files: `{timestamp}-{random}.json` with `{type: "message", text: "..."}`
- Close sentinel: `_close` (empty file)

### Container → Host (commands)

Via MCP server `ipc-mcp-stdio.ts`, available to the agent as tools:

| Tool | Purpose |
|------|---------|
| `send_message` | Send a message to the user immediately |
| `schedule_task` | Create a scheduled task (cron/interval/once) |
| `list_tasks` | View current tasks |
| `pause_task` / `resume_task` / `cancel_task` | Task management |
| `register_group` | Register a new chat (main only) |

Files are written to `data/ipc/{folder}/messages/` and `data/ipc/{folder}/tasks/`. The host IPC Watcher picks them up every second.

---

## 6. Credential Proxy

Containers never see real credentials. Instead:

1. Container receives `ANTHROPIC_BASE_URL=http://host.docker.internal:3001`
2. Container receives `CLAUDE_CODE_OAUTH_TOKEN=placeholder`
3. All API requests go through the proxy
4. Proxy reads the `.env` file (via `readEnvFile()`, without loading into `process.env`)
5. Proxy injects the real token into the `Authorization` header
6. Request goes to the Anthropic API

This prevents credential leaks through child processes or agent tools.

---

## 7. Queue and Concurrency

`GroupQueue` in `src/group-queue.ts` manages containers.

### Group state

```typescript
interface GroupState {
  active: boolean;           // Container is running
  idleWaiting: boolean;      // Waiting for new messages
  isTaskContainer: boolean;  // Scheduled task
  pendingMessages: boolean;  // Has unprocessed messages
  pendingTasks: QueuedTask[];
  retryCount: number;
}
```

### Concurrency

`MAX_CONCURRENT_CONTAINERS = 5`. If the limit is reached, the JID is added to the `waitingGroups` FIFO queue. When a container finishes, the next one from the queue starts.

### Retry

On error: `retryCount++`, delay `5000 * 2^(retryCount-1)`, maximum 5 attempts.

---

## 8. Database

File: `store/messages.db` (SQLite via `better-sqlite3`).

| Table | Contents |
|-------|----------|
| `chats` | All seen chats (JID, name, channel, group/private) |
| `messages` | Full message content for registered groups |
| `registered_groups` | Active groups (JID, name, folder, trigger, container config) |
| `sessions` | Claude session ID per group |
| `router_state` | Key/value cursors (last_timestamp, last_agent_timestamp) |
| `scheduled_tasks` | Scheduled tasks (cron/interval/once) |
| `task_run_logs` | Task execution history |

---

## 9. Task Scheduler

`src/task-scheduler.ts` — checks `getDueTasks()` every 60 seconds.

Schedule types:
- **cron** — standard format (parsed by `cron-parser` with timezone support)
- **interval** — repeat every N milliseconds (anchored to scheduled time, not actual — prevents drift accumulation)
- **once** — single execution

Tasks run in separate containers. `context_mode` determines whether to use the group's existing session or create an isolated context.

---

## 10. Mount System

### Standard mounts (always)

| Host | Container | Access |
|------|-----------|--------|
| Project root | `/workspace/project` | Read-only (main only) |
| `/dev/null` | `/workspace/project/.env` | Shadow mount (protects secrets) |
| `groups/{folder}` | `/workspace/group` | Read/write |
| `groups/global` | `/workspace/global` | Read-only |
| `data/sessions/{folder}/.claude` | `/home/node/.claude` | Read/write |
| `data/ipc/{folder}` | `/workspace/ipc` | Read/write |
| `data/sessions/{folder}/agent-runner-src` | `/app/src` | Read/write |

### Additional mounts

Configured in the group's `containerConfig.additionalMounts`. Validated against the allowlist at `~/.config/nanoclaw/mount-allowlist.json`:
- Path must exist
- Must be under one of the `allowedRoots`
- Must not match `blockedPatterns` (`.ssh`, `.gnupg`, `.aws`, `.env`, ...)
- Non-main groups can only have read-only access

Mounts appear at `/workspace/extra/{containerPath}/`.

---

## 11. Thinking Status

Implemented to show real-time agent progress in Telegram.

### Data flow

1. **Agent-runner** (in container): on each `tool_use` in an SDK `assistant` message, extracts the tool name and key argument → emits `writeOutput({ thinking: "Read:/path/to/file" })`

2. **Container-runner** (on host): parses OUTPUT markers, calls `onOutput()`

3. **processGroupMessages**: on receiving a thinking event:
   - Parses `"ToolName:detail"` → emoji + verb + shortened path
   - Accumulates lines (last 4 shown)
   - `channel.editMessage()` updates the status message

4. On receiving a result — `channel.deleteMessage()` removes the status

### Display example

```
⏳ Starting...
```
→
```
📖 Reading `src/main.ts`
🔍 Searching `*.cs`
💻 Running `find . -name "*.cs" | head -20`
```
→ (deleted, response arrives)

---

## 12. Configuration

### `.env` — secrets

| Variable | Purpose |
|----------|---------|
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude OAuth token (Pro/Max subscription) |
| `ANTHROPIC_API_KEY` | Alternative — API key |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token |
| `ASSISTANT_NAME` | Assistant name (default: `Andy`) |

### `src/config.ts` — constants

| Parameter | Value | Description |
|-----------|-------|-------------|
| `POLL_INTERVAL` | 2000 ms | Message check interval |
| `IDLE_TIMEOUT` | 30 min | Time before closing idle container |
| `CONTAINER_TIMEOUT` | 30 min | Maximum container lifetime |
| `MAX_CONCURRENT_CONTAINERS` | 5 | Concurrent container limit |
| `CREDENTIAL_PROXY_PORT` | 3001 | Credential proxy port |

### Per-group `CLAUDE.md`

The file `groups/{folder}/CLAUDE.md` is the agent's personal memory. The SDK loads it automatically since the working directory is set to `/workspace/group`. CLAUDE.md files from additional mounts are also loaded via `additionalDirectories`.

---

## 13. Key Files

| File | Role |
|------|------|
| `src/index.ts` | Orchestrator: startup, message loop, message processing, thinking status |
| `src/config.ts` | All settings (non-secret) |
| `src/types.ts` | Interfaces: Channel, RegisteredGroup, NewMessage, ScheduledTask |
| `src/channels/registry.ts` | Channel registry (Map + self-registration) |
| `src/channels/telegram.ts` | Telegram channel (grammY) |
| `src/container-runner.ts` | Docker launch, mounts, OUTPUT marker parsing |
| `src/container-runtime.ts` | Runtime abstraction: Docker/Apple Container |
| `src/group-queue.ts` | Container management, concurrency, retry |
| `src/ipc.ts` | IPC watcher: processing files from containers |
| `src/credential-proxy.ts` | HTTP proxy for credential injection |
| `src/db.ts` | SQLite: schema, queries, migrations |
| `src/task-scheduler.ts` | Task scheduler |
| `src/mount-security.ts` | Mount validation, allowlist |
| `src/router.ts` | XML formatting, channel lookup |
| `src/env.ts` | Safe `.env` reading (without `process.env`) |
| `container/Dockerfile` | Image: node:22-slim + Chromium + claude-code |
| `container/agent-runner/src/index.ts` | Bridge stdin/stdout ↔ Agent SDK |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | MCP server: send_message, schedule_task, etc. |

---

## Architecture Diagram

```
┌──────────────┐     long-polling      ┌──────────────────┐
│   Telegram   │ ◄──────────────────► │  NanoClaw (host)  │
│   (grammY)   │                       │                   │
└──────────────┘                       │  ┌─────────────┐  │
                                       │  │ Message Loop │  │ ← 2s SQLite polling
                                       │  └──────┬──────┘  │
                                       │         │         │
                                       │  ┌──────▼──────┐  │
                                       │  │ GroupQueue   │  │ ← max 5 containers
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
                              │  /workspace/group    ← group data  │
                              │  /workspace/extra/*  ← mounts     │
                              │  /workspace/ipc      ← IPC        │
                              └─────────────────────────────────────┘
```
