# Báo cáo điều tra luồng Queue UI - AgentForge

## Tóm tắt

**Câu trả lời ngắn: CÓ, server broadcast đầy đủ; UI fetch history đúng cách nhưng có 1 lỗ hổng race condition nhỏ.**

## 1) Server có broadcast('chat:message', ...) không?

**CÓ - broadcast được gọi đầy đủ trong cả 3 luồng:**

### a) replayPendingReports (Outbox)
- File: `src/server.ts:3760-3782`
- Khi replay, gọi `triggerOrchestrator()` hoặc `deliverTalk()`
- `triggerOrchestrator()` → `processOrchestratorTriggerQueue()` → sau khi có result từ LLM, **broadcast('chat:message', { msg: orchMsg })** tại dòng 1876
- `deliverTalk()` → sau khi agent trả lời, **broadcast('chat:message', { msg: reply })** tại dòng 1973 (trong `handleAgentResponse`)

### b) processChatRetryQueue (Chat Queue)
- File: `src/server.ts:3016-3087`
- Khi retry thành công: **broadcast('chat:message', { msg: okMsg })** tại dòng 3055
- Khi retry thất bại vĩnh viễn: **broadcast('chat:message', { msg: errMsg })** tại dòng 3076
- Khi agent đích không tồn tại: **broadcast('chat:message', { msg: errMsg })** tại dòng 3038

### c) dispatchUserChat (API /api/chat)
- File: `src/server.ts:3095-3237`
- User message: **broadcast('chat:message', { msg: userMsg })** tại dòng 3113
- System messages (restart, compact): broadcast tại dòng 3130, 3165
- Error messages: broadcast tại dòng 3216
- Queue notification: broadcast tại dòng 3196

### d) Hàm broadcast
- File: `src/server.ts:447-464`
- Gửi qua cả **WebSocket** và **SSE** đồng thời:
```typescript
function broadcast(type: string, data: any) {
  const payload = { type, ...data };
  const msg = JSON.stringify(payload);
  
  // WebSocket broadcast
  wsClients.forEach(ws => { if (ws.readyState === 1) ws.send(msg); });

  // SSE broadcast
  const sseData = `data: ${msg}\n\n`;
  sseClients.forEach(res => {
    try {
      res.write(sseData);
      if (typeof (res as any).flush === 'function') (res as any).flush();
    } catch {
      sseClients.delete(res);
    }
  });
}
```

## 2) UI frontend có hiển thị đầy đủ không?

### a) Kết nối lại / fetch ban đầu
- File: `web/src/App.tsx:216-232`
```typescript
const fetchHistory = async () => {
  const res = await fetch(`${API}/api/history?limit=${HISTORY_FETCH_LIMIT}`);
  const data: ChatMsg[] = await res.json();
  setAllMessages(prev => {
    if (prev.length === 0) return data.slice(-MAX_DISPLAY_MESSAGES);
    const map = new Map<string, ChatMsg>(prev.map(m => [m.id, m]));
    for (const m of data) if (!map.has(m.id)) map.set(m.id, m);
    const sorted = Array.from(map.values()).sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    return sorted.slice(-MAX_DISPLAY_MESSAGES);
  });
};
```
- **Merge (không overwrite)**: UI merge tin nhắn mới từ server với state hiện tại, tránh mất tin nhắn đang stream
- **Limit**: `MAX_DISPLAY_MESSAGES = 1000`, `HISTORY_FETCH_LIMIT = 500`

### b) Realtime events
- File: `web/src/App.tsx:362-419`
- UI dùng **WebSocket primary**, **SSE fallback**
- Khi reconnect (onopen): tự động gọi `fetchAgents()`, `fetchHistory()`, `fetchSettings()`
- Handle `chat:message` event: thêm tin nhắn mới vào state

### c) ChatPanel hiển thị
- File: `web/src/components/ChatPanel.tsx`
- Nhận prop `messages` từ App
- Render theo `from`, `to`, `msgType`
- Có xử lý `stripTalkTags()` để lọc tag TALK khỏi content hiển thị

## 3) Vấn đề phát hiện

### Race Condition nhỏ
**File**: `web/src/App.tsx:222-228`
```typescript
setAllMessages(prev => {
  if (prev.length === 0) return data.slice(-MAX_DISPLAY_MESSAGES);
  const map = new Map<string, ChatMsg>(prev.map(m => [m.id, m]));
  for (const m of data) if (!map.has(m.id)) map.set(m.id, m);
  ...
});
```

**Vấn đề**: Nếu trong lúc fetch history, có realtime message đến qua WS/SSE, `prev` sẽ chứa tin nhắn đó. Khi merge, tin nhắn từ history có cùng id sẽ bị skip (`!map.has(m.id)`). Điều này đúng cho id duy nhất, nhưng nếu server tạo message mới với id mới trong lúc fetch, UI có thể thiếu tin nhắn nếu history trả về không bao gồm tin nhắn mới nhất.

**Tuy nhiên**: `fetchHistory` được gọi trong `onopen` của WS/SSE (khi vừa connect), lúc này chưa có realtime message nào nên race condition này hiếm khi xảy ra.

### Không có vấn đề lớn
- ✅ Server broadcast đầy đủ qua WS + SSE
- ✅ UI fetch history và merge đúng cách
- ✅ Khi reconnect, UI tự fetch lại history
- ✅ Tin nhắn từ queue (retry/replay) đều được broadcast

## 4) Kết luận

Luồng Queue UI **hoạt động đúng**:
1. Server restart → `replayPendingReports()` + `processChatRetryQueue()` chạy
2. Các tin nhắn từ queue được xử lý → `broadcast('chat:message', ...)` 
3. UI connect/reconnect → `fetchHistory()` lấy toàn bộ history
4. UI nhận realtime events qua WS/SSE → cập nhật state

**Không có lỗi nghiêm trọng** trong luồng này. Race condition nhỏ ở merge history không ảnh hưởng thực tế.
