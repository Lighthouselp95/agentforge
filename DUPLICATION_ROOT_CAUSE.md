# Báo cáo điều tra nguyên nhân gốc rễ — Báo cáo lặp & Thông báo Stop Agent lặp

## Tóm tắt

Tìm thấy **2 vấn đề riêng biệt** có cùng triệu chứng "lặp": (1) báo cáo worker hiển thị 2 lần trên UI, và (2) thông báo Stop Agent lặp có thể đến từ re-deliverTalk retry.

---

## Issue 1: Báo cáo bị lặp trên UI

### Luồng phát hiện

Worker hoàn thành → `dispatchUserChat()` trả về `result` → gọi `handleOrchestratorResponse(result.content, ...)` tại dòng 2943:

```typescript
// dispatchUserChat khi targetAgent = null (orchestrator)
} else {
  if (isSlashCommand) { ... }
  else {
    const commandResultsParse = await handleOrchestratorResponse(response, result.thinking || '');
    commandResults.push(...commandResultsParse);
    // === LẶP THẾ?
    const cleanResponse = stripCommandTags(response).trim();
    const aMsg: ChatMsg = { ... content: cleanResponse || response, ... };
    chatHistory.push(aMsg); storage.saveMessage(aMsg);
    broadcast('chat:message', { msg: aMsg }); // GỬI CHO USER LẦN 1 (raw orch response)
  }
}
```

Nhưng `handleOrchestratorResponse()` cũng gọi `handleAgentResponse()` — và `handleAgentResponse()` có thể gửi broadcast TỚI USER:

```typescript
// handleAgentResponse() — dòng 1897-1994
async function handleAgentResponse(content, fromAgent, defaultTo = 'orchestrator', ...) {
  const isInternal = msg.to !== 'user' && msg.to !== 'broadcast';
  // ...
  const reply: ChatMsg = { from: fromAgent.id, to: msg.to, content: outContent, ... };
  chatHistory.push(reply); storage.saveMessage(reply);
  broadcast('chat:message', { msg: reply }); // GỬI TIN NHẮN msg.to = 'orchestrator' hoặc 'user'
  // ...
}
```

**Vấn đề**: Khi worker gửi báo cáo cho Orchestrator:
- `handleOrchestratorResponse()` gọi `handleAgentResponse(content, 'orchestrator', 'user', ...)` tại dòng 2943
- Trong `handleAgentResponse()`: `parseAgentOutput()` có thể trả về message có `to: 'orchestrator'` hoặc `to: 'user'`
- Nếu worker không có `[TO: ...]` tag → `parseAgentOutput()` fallback trả về `to: defaultTo = 'orchestrator'` → broadcast `msg.to = 'orchestrator'` → **KHÔNG gửi user**
- NHƯNG nếu worker gửi cả `[TO: user]` hoặc nếu raw content được gửi ở trên → **gửi user 2 lần**

### Luồng cụ thể gây lặp

1. Worker: "Task complete. === TASK REPORT ===" → `dispatchUserChat()` → `handleOrchestratorResponse()`
2. `handleOrchestratorResponse()` gọi `handleAgentResponse(response, 'orchestrator', 'user', ...)`
3. `handleAgentResponse()`: `parseAgentOutput()` → raw content → broadcast(msg) với `msg.to = 'orchestrator'` → **KHÔNG gửi user**
4. Quay lại `dispatchUserChat()`: broadcast orch response (L2952) → **GỬI USER lần 1**

**Chưa tìm thấy duplicate broadcast rõ ràng** — mỗi message chỉ được broadcast đúng 1 lần. Cần kiểm tra thêm:

**Khả năng 1**: Worker có `[TO: orchestrator]` VÀ raw content được broadcast → orch response lặp
- Trong `handleAgentResponse()`: khi `msg.to = 'orchestrator'`, `outContent = extractCleanTaskReport(stripToolNoiseForOrchestrator(msg.message))`
- `extractCleanTaskReport()` bóc tách TASK REPORT block sạch → gửi orchestrator
- Orchestrator response gốc với `[TO: orchestrator]...TASK REPORT ===` được broadcast → **trùng nội dung** (1 lần sạch, 1 lần raw)

**Khả năng 2**: `handleAgentResponse()` gọi `triggerOrchestrator()` → orchestrator xử lý → orchestrator response gốc được broadcast → cùng nội dung task report xuất hiện 2 lần (1 từ orch response, 1 từ worker original)

---

## Issue 2: Thông báo Stop Agent lặp

### Nguyên nhân tiềm năng

**Tìm thấy**: `deliverTalk()` có cơ chế retry với exponential backoff:

```typescript
// deliverTalk() — dòng 2095 (server.ts)
setTimeout(() => 
  deliverTalk(targetAgent, fromAgent, msg, reportId).catch(() => {}), 
  2000 * rec.attempts
);
```

**Nếu `deliverTalk()` thất bại**: message được re-enqueue vào outbox với `reportId` cũ.
**Khi server restart**: `replayPendingReports()` gọi lại `deliverTalk()` với cùng `reportId`.

Nhưng `stopAgent()` KHÔNG có cơ chế retry — nó chỉ:
1. Broadcast `agent:updated` (status = stopped)
2. `console.log('[Stop] ...')`

**KHÔNG có broadcast `'chat:message'` cho Stop**.

### Luồng Stop Agent lặp có thể

1. Orchestrator gửi `[STOP AGENT target-id=xxx]` → broadcast raw orch response (L2952) chứa text STOP
2. `parseAgentCommands()` gọi `stopAgent()` 
3. `stopAgent()` KHÔNG broadcast chat message
4. UI hiển thị raw orch response chứa "Stop Agent xxx" → **lần 1**
5. Nếu `stopAgent()` được gọi lại từ đâu đó → agent:updated lại → UI hiển thị STOP notification lần 2

### Chưa xác định được path gọi lại stopAgent()

`stopAgent()` chỉ được gọi từ:
- `parseAgentCommands()` (L1100) — 1 lần cho mỗi STOP regex match
- API endpoint `/api/agents/:id/stop` (L2588) — từ UI user

**Không có vòng lặp tự gọi lại stopAgent**.

### Giả thuyết: Orchestrator gửi nhiều STOP

Orchestrator prompt có thể gửi nhiều `[STOP AGENT target-id=...]` trong cùng 1 response (ví dụ: STOP nhiều agent 1 lúc). Mỗi STOP được parse và executed riêng, nhưng tất cả nằm trong 1 orchestrator response được broadcast → **nhiều thông báo Stop cùng lúc** có thể bị nhầm thành "lặp".

---

## Tổng kết nguyên nhân

| Vấn đề | Nguyên nhân gốc rễ | Vị trí |
|---|---|---|
| Báo cáo lặp | `handleOrchestratorResponse()` gọi `handleAgentResponse()` với `defaultTo='user'`, sau đó broadcast orch response gốc. Worker TASK REPORT block xuất hiện cả ở orch response (sạch) và trong raw worker content (đầy đủ) | `dispatchUserChat()` L2943 + `handleAgentResponse()` L1897-1994 |
| Stop lặp | Orchestrator gửi nhiều STOP trong 1 response → 1 broadcast chứa nhiều dòng "Stop Agent xxx"; HOẶC `stopAgent()` được gọi từ `parseAgentCommands()` nhiều lần cho cùng 1 agent | `parseAgentCommands()` L1090-1132 |

---

## Đề xuất cần Orchestrator duyệt trước khi sửa

**Vấn đề 1 — Cần xác nhận**: Khi nào worker báo cáo được broadcast 2 lần? Chi tiết từ logs:
- Lần 1: nội dung gì?
- Lần 2: nội dung gì?
- Có phải cùng message ID không?

**Vấn đề 2 — Cần xác nhận**: "Thông báo Stop Agent lặp" — có phải là nhiều agent bị STOP cùng lúc trong 1 orch response, hay cùng 1 agent bị STOP nhiều lần?

**Hướng fix tiềm năng**:
1. Deduplicate báo cáo: thêm cơ chế hash per-worker trong `handleOrchestratorResponse()` trước khi gọi `handleAgentResponse()`
2. Stop Agent: `stopAgent()` nên broadcast `'chat:message'` chứa "Stopped [name]" để UI hiển thị rõ ràng, tránh nhầm với raw orch response
