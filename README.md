# AgentForge — ACP Multi-Agent Orchestrator

A GUI application that manages multiple coding agents via ACP (Agent Client Protocol), spawns them, and allows agents to communicate with each other.

## Features

- **OpenCode Integration**: Spawn OpenCode agents via `opencode run --format json` (one-shot per turn, JSONL events)
- **Multi-Agent**: Run multiple agents in parallel (up to 3 agents per role)
- **Orchestrator**: Automatically decompose tasks and route to appropriate agents
- **Real-time GUI**: WebSocket-based dashboard with live updates
- **Agent-to-Agent**: Relay messages between agents via orchestrator hub
- **Transcript**: Full turn transcript (tool calls + text) saved per conversation, shown live
- **Queue**: Messages to a busy agent are queued, sent automatically when the current turn finishes
- **Self-heal**: Dead opencode sessions auto-recover with a new session
- **Session title**: Chat panel title taken from the opencode session title

## Architecture

```
┌─────────────────────────────────────────┐
│           AgentForge GUI (React)         │
├─────────────────────────────────────────┤
│           WebSocket Server              │
│          (Express + ws, port 3001)      │
├─────────────────────────────────────────┤
│           Orchestrator Core             │
│  • Task decomposition                   │
│  • Agent routing (SPAWN/TALK/STOP...)  │
│  • Result synthesis                     │
│  • Max 3 agents per role                │
├─────────────────────────────────────────┤
│      OpenCode CLI (run --format json)   │
│   one ACPClient per agent, session-based │
└─────────────────────────────────────────┘
```

## 📋 Prerequisites (Yêu cầu cài đặt trước)

Để các Agent có thể thực thi viết code và gọi mô hình AI, máy tính cần cài đặt **OpenCode CLI**:

### 1. Cài đặt OpenCode CLI:
- **Windows (PowerShell)** — cần Node.js:
  ```powershell
  npm install -g opencode-ai
  ```
  *(hoặc `scoop install opencode` nếu dùng Scoop)*

- **macOS / Linux**:
  ```bash
  curl -fsSL https://opencode.ai/install | bash
  ```

### 2. Cấu hình API Key / Model:
- Sau khi cài đặt, tạo hoặc kiểm tra file cấu hình tại:
  `~/.config/opencode/opencode.jsonc`
- Cấu hình API Key của bạn (OpenAI, Anthropic, OpenRouter, Google...) để bắt đầu sử dụng.

## Quick Start

```bash
# Install dependencies
npm install
cd web && npm install && cd ..

# Start server (port 3001, hot-reload)
npm run dev

# Open browser
open http://localhost:3001/v2
```
Oneshot run at: Agentforge-web.exe release

## Usage

0. **UI routes**:
   - `http://localhost:3001/v2` — React UI đầy đủ (task card, tin giao việc, ThinkingBlock, transcript)
   - `http://localhost:3001/` — legacy UI đơn giản (dist/index.html)
1. **Chat**: Type a message → Orchestrator decomposes, spawns specialist agents, routes tasks
2. **Spawn limits**: Max 3 agents per role (coder/tester/...). Exceeding → error with active agent list
3. **Click an agent** (left sidebar) → view only that agent's conversation; title = opencode session title
4. **Chat panel** shows raw conversation verbatim: `[TO: id]` badge, agent replies, `=== TURN TRANSCRIPT ===` (tool calls + assistant text), ping/heartbeat are filtered out
5. **Monitor**: Watch real-time agent status on dashboard (idle/working/error/stopped)

## Tech Stack

- **Backend**: Node.js + TypeScript + Express + WebSocket
- **Frontend**: React + Vite (`web/`), served at `/`
- **OpenCode**: `opencode run --auto --format json` (per-agent session)
- **Storage**: SQLite (`data/agentforge.db`, better-sqlite3)

## Documentation

- [Agent Lifecycle & Injection Protocol](docs/AGENT_LIFECYCLE.md): Chi tiết về vòng đời agent, luồng dừng/hủy tiến trình và thông điệp hệ thống `[STOPPED]`.

## Agent Prompts

Agent system prompts live in `.opencode/agents/*.md` (coder, tester, reviewer, docs, planner, researcher, verifier, debugger, searcher, orchestrator). Loaded by OpenCode via `--agent <role>` at spawn time. Orchestrator must NOT use OpenCode's native subagent/task system — it only outputs text commands (`[SPAWN]`, `[TALK]`, `[STOP]`, `[DELETE]`, `[CREATE ROLE]`).
