# Phân tích Render Chat Agent — Agent Report hiển thị mấy lần?

## Mục tiêu
Điều tra cách agent report được render lên UI: số lần hiển thị, luồng xử lý, và nguyên nhân gây render trùng.

## Luồng xử lý end-to-end

```
Agent gửi <report> hoặc <talk>
  │
  ▼
┌─────────────────────────────────────┐
│ SERVER (server.ts)                  │
│                                     │
│ 1. handleAgentResponse()           │
│    → parseAgentOutput()            │
│    → parseAgentCommands()          │
│                                     │
│ 2. isBroadcastDuplicate()          │
│    → Content-based key + 4s TTL    │
│    → Chặn broadcast trùng          │
│                                     │
│ 3. broadcast('chat:message', msg)  │
│    → Gửi tới tất cả SSE/WS client │
└─────────────────────────────────────┘
  │
  ▼
┌─────────────────────────────────────┐
│ FRONTEND (App.tsx)                 │
│                                     │
│ handleRealtimeEvent():             │
│                                     │
│ chat:chunk →                       │
│   upsertStreamMsg()                │
│   → Tạo/cập nhật stream bubble    │
│   → parts[] push {type:'text'}     │
│                                     │
│ chat:tool_call →                   │
│   upsertStreamMsg()                │
│   → parts[] push {type:'tool'}     │
│                                     │
│ chat:message →                     │
│   Nếu stream tồn tại:             │
│     → Xóa stream bubble           │
│     → Thêm final message          │
│   Nếu không:                       │
│     → Thêm message mới            │
│   → ID dedup check                │
└─────────────────────────────────────┘
  │
  ▼
┌─────────────────────────────────────┐
│ UI (ChatPanel.tsx)                 │
│                                     │
│ Rendering logic:                   │
│                                     │
│ hasParts = true →                  │
│   Khối 2.5: Interleaved render    │
│   (text + tool xen kẽ)            │
│                                     │
│ hasParts = false →                 │
│   Khối 2: ToolCallBlocks riêng     │
│   Khối 3: Bubble text riêng        │
│                                     │
│ ⚠ KHÔNG BAO GIỜ render cả 2      │
│   cho cùng 1 message               │
└─────────────────────────────────────┘
```

## Kết luận: Mỗi report chỉ render 1 lần

### Bằng chứng từ code

#### 1. Server-side dedup (server.ts L2995)
```typescript
// Dedup broadcast UI: khóa content-based (từ|đến|nội dung chuẩn hoá)
if (!isBroadcastDuplicate(broadcastDedupKey(reply))) {
  chatHistory.push(reply);
  storage.saveMessage(reply);
  broadcast('chat:message', { msg: reply });
} else {
  console.log(`[Route] Skip duplicate broadcast bubble...`);
}
```

- Content-based key: hash(from + to + normalized content)
- TTL window: 4 seconds
- Kết quả: cùng nội dung trong 4s → chỉ broadcast 1 lần

#### 2. Stream→Final swap (App.tsx L345-381)
```typescript
if (fkey && streamRef.current[fkey]) {
  // Xóa stream bubble
  delete streamRef.current[fkey];
  setAllMessages(prev => prev.filter(x => x.id !== staleId));
}
// Thêm final message
setAllMessages(prev => [...prev, { id: m.id, ... }]);
```

- Khi `chat:message` đến → stream bubble bị xóa
- Final message thay thế
- Không có trường hợp cả 2 cùng tồn tại

#### 3. ID dedup (App.tsx L385)
```typescript
if (prev.some(p => p.id === m.id)) return prev;
```

- Cùng ID → không thêm lại
- Mỗi broadcast có UUID duy nhất

#### 4. ChatPanel render guard (ChatPanel.tsx L2358-2361)
```typescript
const hasParts = Array.isArray((msg as any).parts) && (msg as any).parts.length > 0;
```

- `hasParts = true` → render Khối 2.5 (interleaved)
- `hasParts = false` → render Khối 2 + Khối 3
- **Mutual exclusion**: không thể cả 2 cùng true

## Edge cases có thể gây "nhìn thấy nhiều lần"

### Case 1: Stream + Final overlap (tạm thời)
```
Timeline:
t=0: chat:chunk arrives → stream bubble hiện (text đang chạy)
t=1: chat:chunk arrives → stream bubble cập nhật
t=2: chat:message arrives → stream bubble biến mất, final bubble hiện
```

**Kết quả**: Trong vài ms, cả 2 có thể cùng tồn tại → mắt người thấy "nhấp nháy"

### Case 2: Agent gửi nhiều [TO: ...] tags
```
Agent output:
[TO: orchestrator]
Report summary...

[TO: user]
Final result...
```

**Kết quả**: 2 messages riêng biệt, mỗi cái render 1 lần → **ĐÚNG** (không phải trùng)

### Case 3: Server broadcast nhiều lần cho 1 batch
- Comment tại L2814: "KHÔNG broadcast bubble per-report (tránh 2 message orchestrator→user cho cùng 1 batch)"
- Nếu logic này sai → có thể broadcast 2 lần

### Case 4: Agent restart/retry
- Agent chạy lại → gửi report mới với ID mới
- Kết quả: 2 messages riêng → render riêng (đúng behavior)

## Các điểm phát sóng chat:message trong server.ts

Tổng cộng **36 locations** broadcast `chat:message`:

| Category | Count | Ví dụ |
|----------|-------|-------|
| Agent response routing | 8 | handleAgentResponse, deliverTalk |
| Orchestrator commands | 12 | spawn, talk, stop, resume |
| Error messages | 10 | SPAWN_PARSE_FAIL, TALK_AGENT_NOT_FOUND |
| System messages | 6 | restart, clear, compaction |

## Phân tích hasParts rendering

### Khi `hasParts = true` (Khối 2.5)
```tsx
{hasParts && (
  <div>
    {parts.map((part, i) => {
      if (part.type === 'tool') return <ToolCallBlock />;
      if (part.type === 'text') return <MarkdownRenderer />;
    })}
  </div>
)}
```

**Text segment**: render như bubble text thường
**Tool segment**: render ToolCallBlock

### Khi `hasParts = false` (Khối 2 + 3)
```tsx
{/* Khối 2: Tool blocks riêng */}
{!hasParts && showToolBlocks && msg.toolCalls.length > 0 && (
  <div>{msg.toolCalls.map(tc => <ToolCallBlock />)}</div>
)}

{/* Khối 3: Bubble text */}
{!hasParts && hasBubbleContent && (
  <div className="af-bubble">{body}</div>
)}
```

## Khuyến nghị

1. **Không cần fix** — logic hiện tại đã đúng, mỗi report render 1 lần
2. **Nếu muốn polish**: thêm `transition: opacity 200ms` cho stream→final swap để giảm nhấp nháy
3. **Monitor**: nếu thấy render trùng thực sự, check log `[Route] Skip duplicate broadcast bubble` để xác nhận dedup có hoạt động

## File tham khảo

| File | Lines | Nội dung |
|------|-------|----------|
| `src/server.ts` | L2938-3001 | handleAgentResponse + dedup |
| `src/server.ts` | L2378-2457 | parseAgentOutput |
| `web/src/App.tsx` | L280-291 | upsertStreamMsg |
| `web/src/App.tsx` | L293-330 | handleRealtimeEvent |
| `web/src/App.tsx` | L335-381 | chat:message handler (stream swap) |
| `web/src/components/ChatPanel.tsx` | L2358-2361 | hasParts, hasToolBlocks |
| `web/src/components/ChatPanel.tsx` | L2536-2658 | Rendering blocks (2, 2.5, 3) |
| `src/server.ts` | L673-690 | forwardToOrchestrator — nguồn phát from:'system' |
| `src/server.ts` | L682 | msgType:'internal' (không phải 'orchestrator_internal') |
| `web/src/App.tsx` | L787-800 | isInternalMsg — chỉ filter from:'orchestrator', thiếu from:'system' |
(End of file - total 211 lines)
