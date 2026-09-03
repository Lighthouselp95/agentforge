# Agent Message Format

Standardized format for all inter-agent communication in AgentForge.

## Message Structure

```
=== AGENT MESSAGE ===
FROM: <agent-id>
TO: <target-id>           # orchestrator | agent-id | broadcast
TYPE: task_report | status | question | handoff | error
TASK_ID: <correlation-id>  # Links related messages across agents
CONTENT: <structured payload>
=== END MESSAGE ===
```

## Field Definitions

| Field | Required | Description |
|-------|----------|-------------|
| FROM | Yes | Sender's agent ID |
| TO | Yes | Recipient: `orchestrator`, specific `agent-id`, or `broadcast` |
| TYPE | Yes | Message type (see below) |
| TASK_ID | No | Correlation ID for tracking related messages |
| CONTENT | Yes | Payload (text or JSON) |

## TYPE Values

| Type | Use Case | Content Format |
|------|----------|----------------|
| `task_report` | Final completion report | JSON (see task-report.md) |
| `status` | Progress update | Text: "Still working on X" |
| `question` | Need clarification | Text: "What is the expected behavior for X?" |
| `handoff` | Pass work to another agent | JSON with context |
| `error` | Something went wrong | Text or JSON with error details |

## Handoff Payload
```json
{
  "from_agent": "agent-123",
  "to_agent": "agent-456",
  "context": "Completed X, need you to do Y",
  "files": ["src/x.ts"],
  "key_decisions": ["Decision 1"],
  "blockers": []
}
```

## Error Payload
```json
{
  "error": "Description of error",
  "severity": "high|medium|low",
  "context": "What was happening when error occurred",
  "suggested_action": "What to do next"
}
```

## Examples

### Status Update
```
=== AGENT MESSAGE ===
FROM: agent-123
TO: orchestrator
TYPE: status
TASK_ID: task-456
CONTENT: Still working on implementing the authentication module. Completed login, working on token refresh.
=== END MESSAGE ===
```

### Question
```
=== AGENT MESSAGE ===
FROM: agent-123
TO: orchestrator
TYPE: question
TASK_ID: task-456
CONTENT: The spec says "handle errors gracefully" but doesn't specify which errors. Should I handle network timeouts, validation errors, or both?
=== END MESSAGE ===
```

### Handoff (Coder → Tester)
```
=== AGENT MESSAGE ===
FROM: agent-123
TO: agent-456
TYPE: handoff
TASK_ID: task-456
CONTENT: {
  "from_agent": "agent-123",
  "to_agent": "agent-456",
  "context": "Implemented user authentication in src/auth.ts. Ready for testing.",
  "files": ["src/auth.ts", "src/types.ts"],
  "key_decisions": ["Used JWT with 1h expiry", "Refresh token stored in httpOnly cookie"],
  "blockers": []
}
=== END MESSAGE ===
```

### Error
```
=== AGENT MESSAGE ===
FROM: agent-123
TO: orchestrator
TYPE: error
TASK_ID: task-456
CONTENT: {
  "error": "Cannot import 'crypto' module - not available in this environment",
  "severity": "high",
  "context": "Trying to implement token signing in src/auth.ts",
  "suggested_action": "Use Web Crypto API instead or add polyfill"
}
=== END MESSAGE ===
```

## Routing Rules

1. **Worker → Orchestrator**: Always use `TO: orchestrator` for task reports, questions, errors
2. **Worker → Worker**: Use `TO: <agent-id>` for handoffs, coordination
3. **Orchestrator → Worker**: Uses `<spawn>`, `<talk>` (hoặc `[SPAWN]`, `[TALK]`) commands (not this format)
4. **Broadcast**: Use `TO: broadcast` for announcements to all agents
5. SINGLE REPORT RULE: Mỗi agent chỉ báo cáo kết quả đúng 1 lần duy nhất; nếu nội dung đã báo cáo y nguyên rồi thì tuyệt đối không báo cáo lại để tránh spam heartbeat/incoming loop.
6. NO SOCIAL CHAT: Tuyệt đối không gửi tin nhắn cảm ơn, chào hỏi, chúc mừng xã giao ("Cảm ơn bạn", "Chúc mừng"). Chỉ gửi payload khi có dữ liệu kỹ thuật cần xử lý.

## Parsing

The server parses these messages and routes them appropriately. Agents should include this format when sending structured messages, but the legacy `[TO: <target-id>] <message>` format is still supported for backward compatibility.