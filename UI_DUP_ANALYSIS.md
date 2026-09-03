# UI Duplication Analysis — 2 Tin MAIN Y Hệt

## Tóm tắt nhanh
- **Root cause chính**: Server persist CẢ opencode snapshot (msgType='opencode', content='', parts=[text+tool]) VÀ talk reply (msgType=undefined, content=stripped text) cho MỖI turn MAIN orchestrator. Cả 2 cùng `from='orchestrator'`. `applyOacDedup` BỊ THẤT BẠI gộp vì opencode snapshot có `content: ''` (rỗng) → client không detect được内容 trùng.
- **File**: server.ts L1034-1089 (snapshot persist) + L4493-4504 (aMsg persist), App.tsx L834-870 (dedup), ChatPanel.tsx L2584-2687 (render interleaved)

---

## Câu 1: ChatPanel L2525-2670 — Khối render có trùng nhau không?

**CÓ THỂ, nhưng KHÔNG phải nguyên nhân chính.**

| Khối | Điều kiện | Render khi |
|------|-----------|------------|
| Khối 1: ThinkingBlock (L2540) | `!hasThinkingInParts && msg.thinking` | thinking trong msg, KHÔNG có trong parts |
| Khối 2: ToolCallBlock (L2555) | `!hasParts && showToolBlocks && msg.toolCalls` | toolCalls nhưng KHÔNG có parts |
| Khối 2.5: Parts interleaved (L2584) | `hasParts` (parts.length > 0) | Parts array tồn tại |
| Khối 3: Bubble text (L2690) | `!hasParts && hasBubbleContent` | Không có parts, có content text |

**Kết luận**: Khối 2 + Khối 2.5 KHÔNG render cùng lúc (mutual exclusion qua `!hasParts`). Khối 1 có thể render cùng Khối 2.5 nếu thinking KHÔNG nằm trong parts (không có ở đây vì server đã push thinking vào parts). **Các khối KHÔNG nhân đôi cho 1 message.**

---

## Câu 2: App.tsx applyOacDedup L834-870 — Tại sao KHÔNG gộp opencode snapshot + talk reply?

**Đây là nguyên nhân chính.**

### Flow server persist 2 messages cho 1 turn MAIN:

```
Step 1: broadcastOACEvent (server.ts L879-1089)
  → Tạo opencode snapshot:
    {
      id: 'oac-orchestrator-...',
      from: 'orchestrator',
      to: 'orchestrator',        // ← QUAN TRỌNG: to = chính nó
      content: '',                // ← content RỖNG có chủ ý (L1038)
      msgType: 'opencode',
      parts: [{type:'text', content:'...'}, {type:'tool', ...}],  // text+tool interleaved
      thinking: '...',
    }
  → persist vào chatHistory + storage (L1088-1089)

Step 2: dispatchUserChat (server.ts L4485-4504)
  → Tạo aMsg:
    {
      id: uuidv4(),               // ← ID KHÁC
      from: 'orchestrator',
      to: 'user',                 // ← to = user (khác!)
      content: stripped,          // ← content = text thật (NOT rỗng)
      msgType: undefined,         // ← KHÔNG phải 'opencode'
    }
  → persist + broadcast chat:message (L4503-4504)
```

### applyOacDedup tại sao KHÔNG catch được:

```javascript
// Pass 1 (L842-853): scan tìm opencode snapshot
for (const m of list) {
  if (m.msgType === 'opencode' && Array.isArray(m.parts)) {
    // → TÌM THẤY snapshot → oacHasParts.set('orchestrator', true) ✓
  }
}

// Pass 2 (L856-868): filter bỏ talk reply
for (const m of list) {
  if (m.msgType !== 'opencode' && m.content && String(m.content).trim().length > 0) {
    const hasParts = oacHasParts.get(fkey) === true;  // fkey = 'orchestrator'
    // hasParts = true → DROPS aMsg ✓
  }
}
```

**ĐÚNG — applyOacDedup THỰC SỰ drop aMsg khi cả 2 có trong list.**

### VẬY TẠI SAO VẪN DUP?

**Vấn đề: Timing race between realtime and history:**

```
Timeline:
T1: User gửi message → dispatchUserChat starts
T2: Orchestrator streams → chat:chunk events → upsertStreamMsg creates stream message
T3: broadcastOACEvent → persists opencode snapshot to storage
T4: Stream done → aMsg created → broadcast chat:message
T5: Client receives chat:message → handles at App.tsx L352-449
T6: fetchHistory() called (on reconnect/refresh)

Kịch bản dup:
- T5: aMsg arrives → streamRef cleanup → aMsg added to allMessages
- T5a: applyOacDedup runs → NO opencode snapshot yet (not fetched) → aMsg KEEPS → 1 bubble
- T6: History fetched → opencode snapshot + aMsg BOTH in allMessages
- T6a: applyOacDedup runs → SHOULD drop aMsg → 1 bubble

→ KHÔNG dup trong trường hợp này.
```

**Kịch bản dup THỰC SỰ: Client-side realtime không xóa stream message đúng cách**

```
T2: chat:chunk → upsertStreamMsg('orchestrator') → creates stream-orchestrator-xxx
    stream message: {id: 'stream-orchestrator-xxx', from: 'orchestrator', content: 'Hello...'}
T5: chat:message aMsg arrives
    → L365: fkey = 'orchestrator', streamRef.current['orchestrator'] = 'stream-orchestrator-xxx'
    → L393-401: Delete stream message, add aMsg

    BUT: HOẶC chat:message arrive TRƯỚC chat:chunk cuối → streamRef chưa set!
    → L365: streamRef.current['orchestrator'] = undefined
    → L403: mergedIntoStream = false
     → L404-442: Add aMsg directly to allMessages
    → Stream message vẫn SỐNG trong allMessages
    → 2 messages: stream message + aMsg
```

**HOẶC phức tạp hơn: History fetch merge không check id cho aMsg vs opencode snapshot**

```javascript
// fetchHistory (App.tsx L267-272)
setAllMessages(prev => {
  const map = new Map<string, ChatMsg>(prev.map(m => [m.id, m]));
  for (const m of data) if (!map.has(m.id)) map.set(m.id, m);  // ← Key bằng ID
  return sorted;
});
```

**aMsg đã có trong prev (từ realtime) → KHÔNG được thêm lại từ history → KHÔNG dup theo path này.**

---

## CÂU 3: Message state — 1 turn có mấy messages?

**1 turn MAIN orchestrator sinh ra TỐI ĐA 3 messages trong allMessages:**

| # | Nguồn | ID pattern | from | to | content | MsgType |
|---|-------|-----------|------|----|---------|---------|
| 1 | Stream (chat:chunk) | `stream-orchestrator-*` | orchestrator | user | accumulated text | undefined |
| 2 | Opencode snapshot (history) | `oac-orchestrator-*` | orchestrator | orchestrator | '' (rỗng) | opencode |
| 3 | Talk reply (aMsg) | `uuid` | orchestrator | user | stripped text | undefined |

**Cái nào thành 2 bubble?**
- **Message 1** (stream) bị xóa khi message 3 arrives (L393-401) → KHÔNG dup
- **Message 2** (opencode snapshot, content rỗng) render qua Khối 2.5 (parts interleaved) → hiện text+tool
- **Message 3** (aMsg, content text) render qua Khối 3 (bubble) → hiện text

**NẾU applyOacDedup không drop aMsg → Message 2 + Message 3 = 2 bubble y hệt!**

---

## CÂU 4: upsertStreamMsg / chat:message add KHÔNG kiểm tra tồn tại?

### upsertStreamMsg (App.tsx L280-291) — CÓ KIỂM TRA
```javascript
const upsertStreamMsg = (key, mut, teamId?) => {
  setAllMessages(prev => {
    let sid = streamRef.current[key];
    if (!sid || !prev.some(p => p.id === sid)) {  // ← Check existence by streamRef ID
      sid = `stream-${key}-${Date.now()}`;
      streamRef.current[key] = sid;
      list = [...prev, { id: sid, ... }];
    }
    return list.map(m => m.id === sid ? mut(m) : m);  // ← Update existing hoặc add new
  });
};
```
**Kết luận**: CÓ kiểm tra qua streamRef. Nếu streamRef đã set → update message cũ, KHÔNG tạo mới.

### chat:message handler (App.tsx L403-443) — CÓ KIỂM TRA theo ID
```javascript
setAllMessages(prev => {
  if (prev.some(p => p.id === m.id)) return prev;  // ← Check by message ID
  // ... add new
});
```
**Kết luận**: CÓ check `p.id === m.id`. NHƯNG opencode snapshot ID (`oac-...`) KHÁC aMsg ID (`uuid`) → cả 2 đều được thêm.

---

## ROOT CAUSE CHÍNH

### Path 1 (nếu applyOacDedup hoạt động đúng): KHÔNG DUP
applyOacDedup drop aMsg khi opencode snapshot có parts → 1 bubble duy nhất (từ parts interleaved).

### Path 2 (dup thật sự): aMsg arrives TRƯỚC opencode snapshot trong allMessages

```
Kịch bản:
1. aMsg arrives realtime → added to allMessages (no opencode snapshot yet)
2. applyOacDedup runs → no opencode found → aMsg kept → bubble text
3. History fetch → adds opencode snapshot (with parts) → allMessages has BOTH
4. applyOacDedup SHOULD run again → drop aMsg → back to 1 bubble

NHƯNG: Nếu user thấy step 2 TRƯỚC step 4 hoàn tất → briefly 2 bubbles.
Nếu React render giữa step 2 và step 4 → user thấy 2 bubbles.
```

### Path 3 (dup vĩnh viễn): applyOacDedup KHÔNG được gọi lại sau history fetch

```
Nếu filteredMessages KHÔNG re-compute sau khi allMessages thay đổi
(React deps issue) → aMsg vẫn giữ → dup vĩnh viễn.
```

---

## ĐỀ XUẤT FIX (UI-side, không đụng outbox)

### Fix A: ChatPanel — Không render bubble khi msg có parts ( server-side or client-side)
**File**: ChatPanel.tsx L2690
```diff
- {!hasParts && (hasBubbleContent && (...)) && (
+ {!hasParts && !msg.parts && (hasBubbleContent && (...)) && (
```
→ Đảm bảo KHÔNG render Khối 3 khi message có parts array (dù rỗng).

### Fix B: applyOacDedup — Also drop non-opencode when opencode with SAME `from` exists (even if parts empty)
**File**: App.tsx L859-865
```diff
  if (m.msgType !== 'opencode' && m.content && String(m.content).trim().length > 0) {
    const fullText = oacFullText.get(fkey);
    const hasParts = oacHasParts.get(fkey) === true;
-   if ((fullText !== undefined && String(m.content).trim() === fullText) || hasParts) {
+   if ((fullText !== undefined && String(m.content).trim() === fullText) || hasParts || oacFullText.has(fkey)) {
      continue;
    }
  }
```
→ Drop aMsg nếu BẤT KỲ opencode snapshot nào tồn tại cho cùng `from`, kể cả khi parts rỗng.

### Fix C (recommended): Server không persist kép — chỉ persist 1 message cho MAIN turn
**File**: server.ts L4485-4504
- KHÔNG persist aMsg vào chatHistory/storage nếu opencode snapshot đã có parts cho orchestrator
- HOẶC: KHÔNG persist opencode snapshot khi content rỗng + đã có parts (chỉ giữ 1 bản)

### Fix D: Client-side prevent 2 bubbles for same content + same agent
**File**: App.tsx L403-442
```javascript
// Check duplicate by (from + content_normalized) before adding
const normalizedContent = String(m.content || '').replace(/\s+/g, ' ').trim();
const isDup = prev.some(p => 
  p.from === m.from && 
  String(p.content || '').replace(/\s+/g, ' ').trim() === normalizedContent &&
  Math.abs((p.timestamp || 0) - (m.timestamp || 0)) < 5000
);
if (isDup) return prev;
```

---

## Files liên quan
- `src/server.ts` L879-1089 (broadcastOACEvent — opencode snapshot persist)
- `src/server.ts` L4485-4504 (dispatchUserChat — aMsg persist)
- `src/server.ts` L3134-3194 (handleAgentResponse — final reply)
- `web/src/App.tsx` L280-291 (upsertStreamMsg)
- `web/src/App.tsx` L352-449 (chat:message handler)
- `web/src/App.tsx` L834-870 (applyOacDedup)
- `web/src/App.tsx` L914-948 (main view filter)
- `web/src/components/ChatPanel.tsx` L2369-2378 (hasParts/hasToolBlocks)
- `web/src/components/ChatPanel.tsx` L2584-2687 (Khối 2.5 interleaved render)
- `web/src/components/ChatPanel.tsx` L2689-2690 (Khối 3 bubble render)
