# Phân tích & Fix — Outbox Delivery "Gửi thành công mới done" (ACK-based)

> Mục tiêu: report/báo cáo của agent phải được gửi NGAY sau khi có mạng/khởi động/gửi được,
> không tích trữ, không "done ảo" (đánh dấu delivered trước khi gửi thực sự thành công).

## Vấn đề ban đầu

Người dùng phản ánh: **báo cáo bị delay/trễ, gửi về ồ ạt 1 lúc thay vì ngay khi hoàn thành**.
Yêu cầu: "báo cáo cần phải gửi lại ngay sau khi có mạng/khởi động/gửi được, chứ không phải tích trữ lại bug".

## Cơ chế hiện tại (trước fix)

| Điểm | Trạng thái trước fix |
|------|---------------------|
| `triggerOrchestrator` (L2656) | enqueue outbox (persist pending) + push `pendingOrchTriggers` + debounce 1.5s |
| `processOrchestratorTriggerQueue` (L2729) | `client.enqueue(prompt)` → resolve thì `markOutboxDelivered` (L2783), throw thì `markOutboxFailed` (L2849) + retry ≤ `ORCH_MAX_RETRY=5` |
| `deliverTalk` (L3085) | `tc.enqueue()` → resolve thì markDelivered, throw thì markFailed + retry in-session |
| `replayPendingReports` (L5330) | **markOutboxDelivered TRƯỚC khi giao tin (L5357)** — "done ảo" |
| Khởi động (L5453-5459) | replayPendingReports gọi **1 lần duy nhất** — không có vòng retry định kỳ |

**2 lỗi gốc:**
1. `replayPendingReports` mark delivered TRƯỚC khi giao → nếu enqueue fail giữa chừng, report mất hút (DB đã done).
2. Không có retry định kỳ → report `failed`/`in_flight treo` nằm im trong outbox DB, chỉ được replay khi restart server (không phải khi mạng khôi phục).

## Khái niệm "gửi thành công" = ACK tự nhiên của `client.enqueue()`

`client.enqueue(prompt)` trả về một **Promise** (acp-client.ts L488):
- `runQueued()` → `chat()` → `chatWithRetry()` → **spawn subprocess `opencode run --auto --format json`**
- `proc.on('close')` (L741): `code === 0` → **resolve(stdoutStr)**; `code !== 0` → **reject(e)**
- `parseJsonlEvents(stdout)` → trả `AgentMessage` (content, sessionId, tokenUsage, thinking...)

**`await enqueue()` resolve = opencode đã chạy XONG cả lượt (exit 0) + parse JSONL thành công.**
Không chỉ "tin đã gửi đi" — mà là **agent/orchestrator đã nhận, xử lý, trả lời xong**. Đây là ACK cấp cao nhất, tự nhiên có sẵn — không cần invent cơ chế ACK mới.

## Fix áp dụng (ACK-based state machine)

### State machine 4 trạng thái
```
pending ──► in_flight ──(enqueue resolve)──► delivered ✅ (CHỈ lúc này mới mark done)
   │            │
   │         (enqueue throw)
   │            ▼
   └─────◄── failed ──(nextAttemptAt backoff)──► retry qua vòng quét ──► in_flight
```

### server.ts
1. **`processOrchestratorTriggerQueue` (L2781-2786):**
   - `markOutboxInFlight(item.reportId)` TRƯỚC `client.enqueue` (L2783)
   - `markOutboxDelivered(item.reportId)` SAU enqueue resolve (L2786)
2. **`deliverTalk` (L3144-3169):** `markOutboxInFlight` trước `tc.enqueue` (L3145), `markOutboxDelivered` sau thành công (L3169)
3. **`replayPendingReports` (L5361-5404):** bỏ markDelivered trước await; `markOutboxInFlight(r.id)` (L5394); delivered do triggerOrchestrator/deliverTalk set sau ACK
4. **`processOutboxRetryQueue` (L4355) + `scheduleOutboxRetry` (L4366):** `setInterval(15000)` + `unref()` — quét `getOutboxForRetry()` → `replayPendingReports()`
5. **Khởi động (L5491-5498):** gọi `scheduleOutboxRetry()` cạnh `scheduleChatRetry()`

### storage.ts
1. **`markOutboxInFlight(id)` (L476):** set `status='in_flight'` + `outboxInFlightAt.set(id, now)` — không tăng attempts
2. **`markOutboxFailed(id, err)` (L485):** set `status='failed'` (KHÔNG phải pending) + `nextAttemptAt = now + min(5000*2^attempts, 10ph)` backoff
3. **`getOutboxForRetry()` (L509):** trả record `pending` (luôn) / `failed` (đã tới hạn nextAttemptAt) / `in_flight` (quá `OUTBOX_IN_FLIGHT_TIMEOUT_MS` hoặc mất stamp sau restart → đưa về pending retry)
4. **`getOutboxRecord(id)` (L503):** tra cứu bất kể trạng thái (dùng trong catch path)

## VERIFY (thực chứng trên đĩa — orchestrator đọc trực tiếp)

- [x] server.ts L2783: `markOutboxInFlight` trước enqueue; L2786: `markOutboxDelivered` sau resolve
- [x] server.ts L3145: `markOutboxInFlight` trước `tc.enqueue`; L3169: `markOutboxDelivered` sau thành công
- [x] server.ts L5394: `markOutboxInFlight(r.id)` trong replayPendingReports — KHÔNG còn markDelivered trước await
- [x] server.ts L4355-4370: `processOutboxRetryQueue` + `scheduleOutboxRetry` (interval 15000, unref)
- [x] server.ts L5497: `scheduleOutboxRetry()` gọi trong setTimeout khởi động
- [x] storage.ts L476: `markOutboxInFlight`; L485-496: `markOutboxFailed` set 'failed' + backoff; L509: `getOutboxForRetry`

## Kết quả mong đợi

- Tin gửi thành công (enqueue ACK) → mới `delivered` → DB không còn "done ảo"
- Tin fail / in_flight treo → vòng quét 15s tự nhặt lại khi mạng/khởi động khôi phục (không chờ restart server)
- Báo cáo không tích trữ trễ hàng giờ nữa

---

## ✅ ĐÃ SỬA XONG — Regression: Retry Loop Log Spam (v6.31.1)

### Vấn đề
Sau khi thêm vòng retry 15s, xuất hiện log `[Outbox] Retry queue: 1 ... record(s) to retry` lặp vô hạn.
Nguyên nhân: record fail bị `deliveredReportIds` chặn re-delivery (vì `add` ở TRƯỚC khi giao) → `replayPendingReports`
lọc qua `deliveredReportIds.has(r.id)` và skip → record không bao giờ resolve, cứ bị `getOutboxForRetry()` trả → spam log.

### Fix (server.ts)
1. **`replayPendingReports` (L5394-5429):** `deliveredReportIds.add(r.id)` chuyển xuống SAU khi giao —
   CHỈ add khi `storage.getOutboxRecord(r.id).status === 'delivered'` (L5420-5424).
   Giao thất bại (catch L5425-5428) KHÔNG add → vòng quét retry nhặt lại được.
2. **Bọc try/catch quanh `triggerOrchestrator`/`deliverTalk` (L5407-5419);** target không tồn tại → `markOutboxDelivered` tránh kẹt vĩnh viễn (L5414-5418).
3. **`processOutboxRetryQueue` (L4354-4372):** anti-spam log bằng `outboxLastLoggedSignature` (L4356) —
   chỉ log khi signature `id:status:attempts` THAY ĐỔI (L4365-4369).

### Trả lời thiết kế (at-least-once, không dồn dập)
- Record `in_flight` (đang resolve, <30s timeout) KHÔNG bị retry dồn dập: `client.isBusy()` (L2738) chặn enqueue khi turn còn chạy.
- Record `failed` retry theo exponential backoff (`5000*2^attempts`, cap 10min) — không gửi ồ ạt.
- Gửi lại sau fail mạng/kill process là HÀNH VI ĐÚNG & BẮT BUỘC chấp nhận (at-least-once) — không thể tránh mà không mất tin.

### VERIFY (thực chứng trên đĩa)
- [x] server.ts L5420-5424: `deliveredReportIds.add` CHỈ sau `status==='delivered'`
- [x] server.ts L5425-5428: catch KHÔNG add deliveredReportIds → retry queue nhặt lại
- [x] server.ts L4356 + L4365-4369: anti-spam signature log
- [x] `npx tsc --noEmit` clean
- [x] stream-verify PASS 3/3
