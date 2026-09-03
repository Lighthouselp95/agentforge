# Phân tích `from:'system'` — Bản chất và có cần render lên UI không?

## `from:'system'` là gì?

Là các message do **server tự sinh ra** (không phải từ agent/user), ví dụ:

- **`forwardToOrchestrator()` (L673-690)**: thông báo hệ thống → Orchestrator, `msgType:'internal'`, `to:'orchestrator'` (VD: SPAWN_PARSE_FAIL, TASK_LONG, TALK_PARSE_FAIL). Mục đích: đưa vào vòng unread injection để Orchestrator xử lý, **KHÔNG phải để hiển thị cho user**.
- **Cảnh báo hệ thống (L1603)**: VD `[SYSTEM WARNING] ... deleted disabled`.
- **Tin lỗi (L5474)**: `msgType:'error'`, `to:'user'` — **CÁI NÀY NÊN hiển thị cho user**.

## Vấn đề duplicate render — SAI DOAN ở đâu?

- **ChatPanel L2194**: `isOrchestratorInternal = msg.msgType === 'orchestrator_internal'`
- **forwardToOrchestrator L682**: `msgType: 'internal'` (KHÔNG phải `'orchestrator_internal'`)

→ Tin `from:'system'` của `forwardToOrchestrator` **không bị `isOrchestratorInternal` bắt**, và ở **App.tsx L787-800** `isInternalMsg` cũng chỉ ẩn `from:'orchestrator'` + `msgType:'orchestrator_internal'`, **không ẩn `from:'system'`**.

→ Kết quả: tin `from:'system'` bị broadcast (L687) và **KHÔNG bị ẩn** → rò vào main chat → hiển thị cục "System" đỏ → **chính là duplicate/nhiễu mà bạn thấy**.

## Có cần render `from:'system'` lên UI không?

**KHÔNG, trừ tin lỗi.**

1. **Tin `forwardToOrchestrator` (msgType:'internal', to:'orchestrator')** → KHÔNG cần render lên UI user. Chỉ cần Orchestrator nhận. **Nên ẩn.**
2. **Tin `msgType:'error'` (to:'user')** → CẦN render để user thấy lỗi (VD: SPAWN fail).
3. **Cảnh báo `[SYSTEM WARNING]`** → có thể hiện nếu liên quan user quyền.

## Kết luận đề xuất fix

ChatPanel nên thêm điều kiện ẩn: **tin `from:'system'` có `to:'orchestrator'`** (nội bộ cho orchestrator) không hiển thị, trong khi vẫn giữ tin `msgType:'error'`/`to:'user'` hiển thị.

## Các nguồn `from:'system'` trong server.ts

| Nguồn | `to:` | `msgType:` | Bản chất | Cần render UI user? |
|-------|-------|-----------|----------|---------------------|
| `forwardToOrchestrator()` (L676) | `orchestrator` | `internal` | Thông báo nội bộ cho Orchestrator (SPAWN_ROLE_LIMIT, SPAWN_PARSE_FAIL...) | ❌ KHÔNG |
| Role limit user (L3406) | `user` | (none) | Lỗi role limit hiển thị cho user | ✅ CÓ |
| DELETE warning (L1603) | `all` | (none) | Cảnh báo ai đó cố xóa agent | ✅ CÓ |
| `emitRuntimeError()` (L5472) | `user` | `error` | Lỗi runtime nghiêm trọng | ✅ CÓ |

## Fix áp dụng

**App.tsx — hàm `isSystemMsg` (L769-785) là NƠI TRỐNG CHÍNH:**
Hàm này được gọi ở ĐẦU cả 2 filter (khung agent chat L839 và main L877), nhưng **KHÔNG kiểm tra `m.from === 'system'`**. Đây là root cause khiến cục "System" đỏ hiện trong khung chat:

```typescript
const isSystemMsg = (m: ChatMsg) => {
  if (!m) return true;
  if (m.showOnUI) return false;
  const content = (m.content || '').trim();
  return (
    m.msgType === 'transcript' ||
    m.msgType === 'heartbeat' ||
    m.msgType === 'ping' ||
    m.msgType === 'opencode_input' ||
    m.msgType === 'internal_prompt' ||
    content.startsWith('▶ INPUT (gửi opencode)') ||
    content.startsWith('=== TURN TRANSCRIPT') ||
    content.startsWith('=== SYSTEM STATUS CHECK') ||
    content.startsWith('=== SYSTEM CHECK') ||
    content.startsWith('=== RECOVERY ATTEMPT')
  );
};
```

**Cần bổ sung**: ẩn `from:'system'` nội bộ cho orchestrator (`to:'orchestrator'`, `msgType:'internal'`), GIỮ tin system hướng user (`to:'user'`, `msgType:'error'`):

```typescript
// Thêm vào isSystemMsg (ẩn tin hệ thống nội bộ forwardToOrchestrator: to='orchestrator')
m.from === 'system' && m.to === 'orchestrator'
```

**ChatPanel.tsx** (dòng 2366-2368): thêm điều kiện ẩn tin `from:'system' && to:'orchestrator'`:

```typescript
// Ẩn tin nội bộ: (1) orchestrator gửi lệnh nội bộ, (2) system broadcast nội bộ cho orchestrator
// (from:'system' + to:'orchestrator' + msgType:'internal' do forwardToOrchestrator tạo).
// GIỮ tin system hướng tới user (to:'user', msgType:'error', to:'all') — user cần thấy.
if ((isOrchestratorInternal && msg.from === 'orchestrator' && !msg.showOnUI) ||
    (msg.from === 'system' && msg.to === 'orchestrator' && !msg.showOnUI)) {
  return null;
}
```

**App.tsx** (hàm `isInternalMsg`, dòng ~787-800): thêm filter tin `from:'system'` nội bộ:

```typescript
// Tin hệ thống NỘI BỘ hướng tới orchestrator (forwardToOrchestrator: to='orchestrator', msgType='internal')
// → không hiển thị trong main chat. Tin system hướng tới user (to:'user', msgType:'error') vẫn hiện.
if (m.from === 'system' && m.to === 'orchestrator') return true;
```

---

## UPDATE — Nguyên nhân THẬT của cục "System" đỏ (dated)

**Điểm mấu chốt:** Cục "System" đỏ thực ra được render trong `ChatPanel.tsx` (dòng 2219-2221: `sender = 'System'`, màu `#f87171`) — nhưng vì sao tin `from:'system'` tới được ChatPanel để render?

**Root cause nằm ở `App.tsx` hàm `isSystemMsg` (dòng 769-785):**

```typescript
const isSystemMsg = (m: ChatMsg) => {
  if (!m) return true;
  if (m.showOnUI) return false;
  const content = (m.content || '').trim();
  return (
    m.msgType === 'transcript' ||
    m.msgType === 'heartbeat' ||
    m.msgType === 'ping' ||
    ...
  );
};
```

Hàm này được gọi ở **CẢ 2 khung chat**:
- Agent chat (dòng 839): `if (isSystemMsg(m)) return false;`
- Main chat (dòng 877): `if (isSystemMsg(m)) return false;`

**Nhưng `isSystemMsg` KHÔNG kiểm tra `m.from === 'system'`!** Nó chỉ check các `msgType` (transcript/heartbeat/ping/...) và một số prefix content. Do đó tin `from:'system'` (`msgType:'internal'` từ `forwardToOrchestrator`, hoặc role limit không msgType) **KHÔNG bị `isSystemMsg` bắt** → LỌT vào `filteredMessages` → render thành cục "System" đỏ ở khung chat agent.

**Fix chính xác (App.tsx `isSystemMsg`):** thêm ẩn `from:'system'` nội bộ nhưng GIỮ tin error hướng user:

```typescript
// Tin hệ thống NỘI BỘ (from:'system') chỉ phục vụ orchestrator (to:'orchestrator', msgType:'internal') —
// Ẩn khỏi UI. NHƯNG giữ tin lỗi hệ thống hướng tới user (msgType:'error' / to:'user') để user thấy.
if (m.from === 'system' && !(m.msgType === 'error') && m.to !== 'user') return true;
```

**Kết luận:** `isSystemMsg` ở App.tsx là nút chặn trung tâm cho cả 2 khung chat. Fix nó là đủ để hết cục "System" đỏ ở khung agent -- không cần đụng tới ChatPanel filter riêng (ChatPanel vẫn giữ render System nếu tin lọt tới, nhưng giờ đã bị chặn ở nguồn App.tsx).

---

## ✅ ĐÃ SỬA XONG (Completed Fixes — cập nhật theo phiên làm việc)

> Mục này ghi nhận các fix đã được áp dụng THẬT trên đĩa cứng và đã thực chứng (verify trên disk + build PASS). Dùng để theo dõi sau này.

### 1. Cục "System" đỏ ở khung AGENT chat & MAIN chat — ĐÃ SỬA ✅

**Vấn đề:** Tin `from:'system'` rò vào `filteredMessages` → render cục "System" đỏ (#f87171) trong khung chat agent.

**Root cause:** `isSystemMsg()` (App.tsx) không check `m.from === 'system'`.

**Fix áp dụng (2 lớp phòng thủ):**

| File | Vị trí | Nội dung sửa |
|------|--------|--------------|
| `web/src/App.tsx` | hàm `isSystemMsg` L775 | Thêm guard `if (m.from === 'system' && !(m.msgType === 'error') && m.to !== 'user') return true;` — ẩn tin system nội bộ cho orchestrator, GIỮ tin error/to:user |
| `web/src/components/ChatPanel.tsx` | L2369-2372 | Mở rộng điều kiện hidden: `(msg.from === 'system' && msg.to === 'orchestrator' && !msg.showOnUI)` |
| `web/src/App.tsx` | hàm `isInternalMsg` ~L801 | Thêm `if (m.from === 'system' && m.to === 'orchestrator') return true;` |

**Thực chứng:** srv-fix + frontend-fix áp dụng; stream-verify PASS trên disk (3/3 tiêu chí); `npm run build` 12.37s không lỗi; tôi (orchestrator) đã đọc đĩa xác nhận L775 App.tsx + L2369-2372 ChatPanel.

### 2. Task bị "cắt" sau restart — ĐÃ SỬA ✅

**Vấn đề:** Task mới thêm ở runtime biến mất sau khi restart server (UI thấy task list ngắn lại).

**Root cause:** `storage.updateAgent()` chỉ destructure 6 field (status, session_id, session_title, model, working_since, token_usage, context_length) — **KHÔNG nhận `task`/`tasks`**. Các call runtime thêm task ở server.ts (L3125, L3311, L3537, L1690, L1757, L3881) gọi `updateAgent(id, {task, tasks})` nhưng field bị bỏ qua im lặng → DB tasks STALE → restart đọc storage → mất task mới. Path tạo agent dùng `saveAgent` (full replace, L621/L3427/L3746) thì persist đúng.

**Fix áp dụng:** `src/storage.ts` hàm `updateAgent` (L371-387):
```typescript
updateAgent(id: string, updates: { status?: string; ...; task?: string; tasks?: any[] }) {
  ...
  task: 'task' in updates ? updates.task : existing.task,
  tasks: 'tasks' in updates ? updates.tasks : existing.tasks
  ...
}
```
Dùng `'task' in updates` / `'tasks' in updates` guard → KHÔNG đè/clear task khi call khác không truyền. Field cũ giữ nguyên byte-identical.

**Thực chứng:** srv-fix áp dụng L382-383 assessed trên disk; `npx tsc --noEmit` BUILD OK; round-trip `writeStateSync` (L266 serializes full object) → `loadState()` đọc `row.task`/`row.tasks` hoàn chỉnh.

### 3. Outbox — Báo cáo trễ / "done ảo" khi gửi thất bại — ĐÃ SỬA ✅

Toàn bộ phân tích + fix + thực chứng được ghi **tập trung tại `docs/outbox-ack-delivery.md`** (gồm ACK state machine, per-line fix, verify checklist, và mục "Retry Loop Log Spam — v6.31.1").

Tóm tắt: "gửi thành công" = `client.enqueue()` Promise resolve (acp-client.ts L488 → spawn `opencode run`, `proc.on('close')` code 0). Fix: `markOutboxInFlight` trước enqueue, `markOutboxDelivered` sau resolve; `markOutboxFailed` set backoff; `processOutboxRetryQueue` + `scheduleOutboxRetry` quét 15s; `replayPendingReports` không mark delivered sớm; anti-spam log signature. → Xem file chính.