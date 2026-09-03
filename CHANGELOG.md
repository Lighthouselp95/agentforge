# Changelog

## v6.31.3 (2026-09-02)

### Option A — thinking hiển thị xen kẽ trong parts (thứ tự realtime) (FIXED ✅)

> Mục tiêu: trước đây thinking là block cố định trên cùng (Khối 1), tách khỏi mảng parts (chỉ text/tool) → position realtime của thinking không giữ với text/tool, gây "thinking sau content" khi thinking tới muộn. Đưa thinking vào parts để render in-order với text/tool.

- **server.ts** (L868): type union parts thêm `'thinking'` (`type: 'text' | 'tool' | 'thinking'`).
- **server.ts** (L945): `parts.push({ type: 'thinking', content: rt })` ngay sau khi tích lũy `evThinking` → broadcast realtime msg.parts giữ thinking parts; persisted snapshot (L1061-1062) vẫn filter tool/text (thinking lưu qua `msg.thinking` cho rehydrate, không regression).
- **web/src/App.tsx** (L311-334): handler `chat:thinking` PUSH `{type:'thinking', content}` vào msg.parts + gộp consecutive thinking (concat `\n`), giữ `msg.thinking` accumulation.
- **web/src/components/ChatPanel.tsx**: L29 union thêm `'thinking'`; L2609-2618 case `part.type === 'thinking'` render ThinkingBlock inline đúng vị trí; L2539 Khối 1 fixed-top chỉ render khi `!hasThinkingInParts` (helper L2374) → không in trùng.
- Verifier stream-verify PASS (3 file + build pass).

### Outbox — content-dedup worker↔worker: hết báo cáo lặp 3-4 lần (FIXED ✅)

> Root cause: outbox delivery worker↔worker KHÔNG content-dedup. 7 call-site nest route cùng nội dung → enqueue uuidv4 MỚI nhiều lần → target nhận cùng talk 3-4 lần → trả lời lặp. Bằng chứng: outbox burst 4×/115ms + 3×/47ms byte-identical, uuid khác nhau.

- **server.ts** (L762-763): module-level `OUTBOX_DELIVER_TALK_DEDUP_MS=2000` + `deliverTalkDedup: Map`.
- **server.ts** (L3271-3297): guard đầu `deliverTalk` — `applyDedup = !existingReportId && msg.to khác orchestrator/user/broadcast && cả 2 role không phải orchestrator`; dedupKey = `${fromAgent.id}->${targetAgent.id}::${normCmdSigPart(msg.message)}`; skip enqueue nếu trong cửa sổ 2s; cleanup khi map >1000. KHÔNG chặn replay hợp lệ (applyDedup=false khi existingReportId).

### Outbox — synthesisTriggered.delete: hết vòng lặp retry 15s (FIXED ✅)

> Root cause: `synthesisTriggered.add(batchKey)` không xóa khi synthesis xong → agent hoàn thành turn MỚI vẫn bị `has(batchKey)` chặn → "[Synthesize] Already triggered" lặp vô hạn → không tổng hợp → outbox report ứ → "[Outbox] Replaying N" retry 15s vô hạn.

- **server.ts** (L1718-1726): sau khi `handleOrchestratorResponse` hoàn tất, gọi `synthesisPendingBatches.delete(batchKey)` + `synthesisTriggered.delete(batchKey)` — turn mới tổng hợp bình thường, hết ứ/replay.

### Fix mất talk/spawn dài — chỉ dispatch khi talk XML hoàn chỉnh (FIXED ✅)

> Root cause (trace-dispatch, reconstruct faithful): nhánh "Unclosed XML tag fallback" trong `extractXmlCommand` (L2198-2214) khiến `scanStreamForDispatch` dispatch talk PARTIAL sớm (message cụt) + `split(fullMatch).join('')` xóa SẠCH buffer → nuốt talk thứ 2 trong cùng response. LONG talk mất, SHORT talk nhận.

- **server.ts** (L812-821): guard trong `scanStreamForDispatch` — chỉ dispatch talk XML khi hoàn chỉnh: self-closing (`/>`) HOẶC có closing tag (`</talk>`); unclosed partial → SKIP, chờ buffer đủ (không dispatch vội, không nuốt talk kế).
- **server.ts** (L857-861): buffer removal dùng `remaining.replace(cmd.fullMatch, '')` (xóa 1 occurrence đầu) thay `split().join('')` toàn cục → không xóa sạch buffer khi fullMatch partial/trùng.

### Fix UX path file mobile — kéo ngang đọc đầy đủ (FIXED ✅)

> Path file dài bị cắt trên mobile → thêm overflow-x scroll để kéo ngang đọc đầy đủ.

- **web/src/components/ChatPanel.tsx** renderToolBadge (L1622-1766) + pathStyle (L1632-1634).
- final-verify nghiệm thu PASS 6/6 + build pass.

### Build & Release
- Version bumped 6.31.2 → 6.31.3.
- Gộp toàn bộ fix: Option A + outbox content-dedup + synthesisTriggered.delete + fix mất talk + fix mobile UX.
- Build exe: `agentforge-web-v6.31.3.exe` (kích thước/MD5 theo srv-fix + verifier).
- Git commit + push lên repo private agentforge-v6.27.

---

## v6.31.2 (2026-09-02)

### Dispatch sớm trong stream — parse lệnh <talk> ngay khi streaming (FIXED ✅)

> Mục tiêu: dispatch `<talk>`/`<spawn>` NGAY TRONG STREAM thay vì chờ process close, giảm độ trễ. User chốt "đưa luồng dispatch vào trong stream luôn".

- **server.ts** module state (L738-844): `dispatchTextBuf: Record<string,string>` (buffer text raw theo agent), `dispatchedCmdSigs: Map<string,Set<string>>` (signature talk đã dispatch, KEYED theo fromAgentId — không global Set tránh chặn nhầm turn sau), `MAX_DISPATCH_BUF=200_000`, `normCmdSigPart()`, `talkDispatchSig()`, `scanStreamForDispatch()`, `drainDispatchState()`.
- **server.ts** `broadcastOACEvent` (L894-900): hook text event — append raw part vào `dispatchTextBuf[agentId]` (ghép `\n` giống parseJsonlEvents), giới hạn MAX, sau mỗi batch gọi scanStreamForDispatch (L962-968).
- **server.ts** `scanStreamForDispatch`: dùng `extractDualCommands(['TALK'])` — CHỈ dispatch talk HOÀN CHỈNH (đủ cặp thẻ/balanced bracket); partial command ở cuối buffer giữ lại chờ batch sau; dispatch sớm CHỈ target là agent KHÁC (non-orchestrator/non-user); SPAWN/STOP/RESUME/DELETE không dispatch sớm (giữ final pass vì role-limit/reuse).
- **server.ts** dedup final pass: agent path (L3183-3188) + orchestrator path (L3666-3670) — trước deliverTalk/loop talk, check signature trong `dispatchedCmdSigs[fromAgent.id]` → skip double delivery, vẫn giữ UI bubble.
- **server.ts** drain buffer: `handleAgentResponse` (L3223) + `handleOrchestratorResponse` call site (L4400).
- Verifier stream-verify PASS 9/9; `tsc --noEmit` clean; KHÔNG đụng acp-client L495.

### Fix mất tin do parser — validate [TO:] target (FIXED ✅)

> Tin CÓ bị mất thật: `[TO:]` parser dùng `([^\]]+)` bắt mọi thứ KHÔNG quote-aware → bắt nhầm regex-fragment `'\s*([^'` làm target → TALK_AGENT_NOT_FOUND → định tuyến sai, nội dung dispatch không tới agent đích. Đã tái hiện bằng node.

- **server.ts** `parseAgentOutput` (L2560-2571): thêm STRICT VALIDATION target `[TO:]` — phải match `^[A-Za-z0-9_-]+$` (agent-id hợp lệ), giữ special route (orchestrator/user/main/all/broadcast). Regex-fragment bị SKIP → hết TALK_AGENT_NOT_FOUND sai, hết mất tin. Validate trên `cleanCandidate` (sau cleanTargetIdentifier) để không regress `[TO: <orchestrator>]`. Test node 10 case → 10/10 PASS.

### Fix mất tin do parser — dedup spawn signature + chặn spawn trong thinking (FIXED ✅)

> 2 vấn đề phụ gây lỗi lặp: (1) SPAWN_ROLE_LIMIT bắn lặp vì spawn parse qua nhiều call site không dedup + thinking tái kích hoạt lệnh cũ; (2) WARN ">20 từ" do task dài.

- **server.ts** `handleOrchestratorResponse`: thêm `handledSpawnSigs: Set<string>` + `spawnDispatchSig(role,name,task)` (L766-769), `clear()` đầu mỗi response (L3395), filter dedup lệnh trùng signature → `effectiveSpawns` dùng cho guardrail (L3456) + main spawn loop (L3468) → SPAWN_ROLE_LIMIT không bắn lặp.
- **server.ts** (L3413): đổi `scanText = response` (KHÔNG gộp `extraScanText`/thinking) → spawn tag trong reasoning không kích hoạt lại.
- Verifier stream-verify PASS; `tsc --noEmit` clean.

### Build
- Version bumped 6.31.1 → 6.31.2
- Build exe: `agentforge-web-v6.31.2.exe` — 105,939,456 bytes (≈101 MB), MD5 `98B97AC2B8A2E27A31431CE439B415CC` (tại root `C:\Users\Hai Dang\test-agentforge thoi\`)
- Gộp đầy đủ 11 fix (7 fix cũ + dispatch stream + fix mất tin [TO:]/spawn/thinking).

---

## v6.31.1 (2026-09-02)

### Outbox — Fix Retry Loop Log Spam + ACK Retry đúng (FIXED ✅)

> Regression từ v6.30.1: log `[Outbox] Retry queue: N pending/failed/in_flight record(s) to retry` lặp vô hạn mỗi 15s — record fail bị `deliveredReportIds` chặn re-delivery nên không bao giờ resolve.

- **server.ts** `replayPendingReports` (L5394-5429): chuyển `deliveredReportIds.add(r.id)` xuống SAU khi giao — CHỈ add khi `storage.getOutboxRecord(r.id).status === 'delivered'` (L5420-5424). Giao thất bại (catch L5425-5428) KHÔNG add → vòng quét retry nhặt lại được.
- **server.ts** `replayPendingReports`: bọc try/catch quanh `triggerOrchestrator`/`deliverTalk`; target không tồn tại → `markOutboxDelivered` tránh kẹt vĩnh viễn (L5414-5418).
- **server.ts** `processOutboxRetryQueue` (L4354-4372): anti-spam log bằng `outboxLastLoggedSignature` (L4356) — chỉ log khi signature `id:status:attempts` THAY ĐỔI (L4365-4369). Record kẹt log 1 lần rồi im.
- **Trả lời thiết kế (at-least-once):** record `in_flight` (đang resolve, <30s timeout) KHÔNG bị retry dồn dập — `client.isBusy()` chặn enqueue khi turn còn chạy; record `failed` retry theo exponential backoff (`5000*2^attempts`, cap 10min). Gửi lại sau fail mạng/kill process là chấp nhận được.
- Verifier stream-verify PASS 3/3 trên disk; `npx tsc --noEmit` clean.

### Ghi chú
- Không gửi trùng dồn dập cho tin đang resolve (3 lớp bảo vệ: `client.isBusy()` L2738, `enqueue()` gom batch + MAX_PENDING, `deliveredReportIds` chống trùng reportId).
- Bản v6.31.0 exe build TRƯỚC khi fix này → cần build lại để gộp (mục Build v6.31.1 bên dưới).

### Race double-process — RESUME WORK/talk không spawn process thứ 2 (FIXED ✅)

> Regression: khi subprocess opencode (`opencode run`) đang chạy mà có `RESUME WORK`/`talk` tới, `enqueue()` spawn process mới → 2 process song song ghi cùng session SQLite DB → race/overwrite tin DB cũ.

- **acp-client.ts** `enqueue` (L489-496): đổi gate từ `!this.busy` sang `this.proc === null && !this.busy && pending.length === 0`. `this.proc` là indicator authoritative (chỉ null khi `proc.on('close'/'error')`), chặn race window khi `busy=false` nhưng process cũ chưa tắt. Giữ `!this.busy` chặn cửa sổ ngược (`busy=true` nhưng `proc=null`: fetchSessions/abort/retry).
- Root cause (server): 8/9 điểm gọi `enqueue()` KHÔNG có gate `isBusy()` — chỉ `processOrchestratorTriggerQueue` (L2738) có. Fix tại chokepoint `enqueue()` đóng được cho mọi caller (deliverTalk, resumeAgentWork, autoResume, synthesis, spawn, reuse, talk).
- Verifier stream-verify PASS; `tsc --noEmit` clean.

### RESUME WORK khi busy → FAIL thay vì queue (FIXED ✅)

> User đề xuất: đã có process chạy = agent không bị kẹt = không cần resume. Queue resume outdated chỉ tạo lệnh stale.

- **acp-client.ts** `enqueue` (L498-504): khi `(this.proc !== null || this.busy)` mà prompt chứa `=== RESUME WORK ===` → `reject('Agent is busy — RESUME WORK skipped')` NGAY, KHÔNG push pending.
- Talk thường khi busy vẫn queue như cũ (chỉ RESUME WORK bị fail).
- Caller `resumeAgentWork` (server.ts L1271) có `.catch()` → rejection graceful, không crash.
- Verifier stream-verify PASS; `tsc --noEmit` clean.

### UI render tin 2 lần — tin thứ 2 kèm thinking (FIXED ✅)

> User thấy 1 tin hiện 2 lần, tin 2 có `thinking` (nội dung giống nhau). Root cause: server PERSIST + broadcast CẢ opencode snapshot (content rỗng, có thinking/parts) LẪN talk reply (content đầy đủ, có thinking) cho cùng 1 turn; client `applyOacDedup` không loại được vì content không khớp chính xác; sau restart loadState load CẢ 2 → 2 bubble.

- **web/src/App.tsx** `applyOacDedup` (L808-850): refactor 2-pass (pre-scan + filter) — pre-scan ghi `oacHasParts`/`oacFullText` theo `from`; filter drop talk reply không-opencode khi `from` có snapshot opencode parts non-empty (canonical snapshot giữ nguyên). Dedup không phụ thuộc thứ tự snapshot/reply trong mảng.
- An toàn: chỉ drop theo `from` trùng snapshot parts → tin user (`from='user'`), agent khác, orchestrator-feedback không bị ảnh hưởng.
- Caveat (stream-verify ghi nhận, mức medium): nhánh `hasParts` drop mọi non-opencode reply cùng `from` có snapshot — chấp nhận vì snapshot là canonical (render đủ text+tool+thinking); nếu sau này server gửi reply riêng biệt từ agent interleaved cần xem lại.
- `tsc --noEmit` clean + `vite build` pass (40 modules).

### Build
- Version bumped 6.31.0 → 6.31.1
- Build exe: `agentforge-web-v6.31.1.exe` — 105,934,336 bytes (101.03 MB), MD5 `2F021FF5F29A34577DFF4F54CF713D9B` (tại root `C:\Users\Hai Dang\test-agentforge thoi\`)
- Gộp đầy đủ 7 fix: (1) outbox retry loop log spam, (2) race double-process, (3) RESUME WORK fail khi busy, (4) UI "System" đỏ, (5) task cắt sau restart, (6) outbox ACK, (7) UI dup tin.
- Build: `npx tsc --noEmit` clean → `npm run build:exe` (tsc + vite 40 modules + SEA bundle 23 assets + postject) — SUCCESS.

---

## v6.31.0 (2026-09-02)

### Build (gộp 3 fix: System đỏ, Task cắt, Outbox ACK)
- Version bumped 6.30.0 → 6.31.0
- Build exe: `agentforge-web-v6.31.exe` (105,933,312 bytes, MD5 `05AF1C188DF2C1213DD5F3D03162D394`)
- Lưu ý: bản này build TRƯỚC khi có fix retry loop log spam (xem v6.31.1).

---

## v6.30.1 (2026-09-02)

> Phiên bản tạm theo dõi các fix chưa build lại exe (code đã thay đổi trên đĩa). Xem mục 6.30.0 cho bản đã build.

### UI — Cục "System" đỏ (FIXED ✅)
- **App.tsx** `isSystemMsg` L775: thêm guard ẩn tin `from:'system'` nội bộ cho orchestrator (`to:'orchestrator'`, `msgType:'internal'`), GIỮ tin error/`to:'user'` hiển thị.
- **App.tsx** `isInternalMsg` ~L801: thêm `if (m.from === 'system' && m.to === 'orchestrator') return true;`
- **ChatPanel.tsx** L2369-2372: mở rộng điều kiện ẩn `(msg.from === 'system' && msg.to === 'orchestrator' && !msg.showOnUI)`.
- Verifier stream-verify PASS 3/3 trên disk; build frontend PASS.

### Data — Task bị "cắt" sau restart (FIXED ✅)
- **storage.ts** `updateAgent` (L377-391): signature thêm `task?`/`tasks?` + `task: 'task' in updates ? updates.task : existing.task` + `tasks: 'tasks' in updates ? updates.tasks : existing.tasks`. Runtime task additions (server.ts L3125/L3311/L3537/L1690/L1757/L3881) nay persist đúng, không mất sau restart.

### Outbox — Báo cáo trễ / "done ảo" khi gửi thất bại (FIXED ✅)
- **server.ts** `replayPendingReports` (L5361-5404): bỏ `markOutboxDelivered` trước await — chuyển sang `markOutboxInFlight` trước khi giao; delivered chỉ do `triggerOrchestrator`/`deliverTalk` đặt sau khi `client.enqueue()` resolve (ACK thật).
- **server.ts** `processOrchestratorTriggerQueue` (L2781-2786) + `deliverTalk` (L3144-3169): `markOutboxInFlight` TRƯỚC enqueue, `markOutboxDelivered` SAU enqueue thành công.
- **server.ts** `processOutboxRetryQueue` (L4355) + `scheduleOutboxRetry` (L4366): vòng quét 15s (`OUTBOX_RETRY_INTERVAL`) retry các record pending/failed/in_flight treo khi mạng/khởi động khôi phục — gọi ở L5497.
- **storage.ts**: `markOutboxInFlight` (L476), `markOutboxFailed` set `status='failed'` + `nextAttemptAt` backoff (L485-496), `getOutboxForRetry` (L509) trả pending/failed-tới-hạn/in_flight-timeout.

### Ghi chú
- Giữ nguyên guard `'task' in updates` / `'tasks' in updates` — không vô tình đè/clear task khi call khác không truyền.
- Cơ chế ACK: "gửi thành công" = `client.enqueue()` promise resolve (subprocess `opencode run` exit 0 + parse JSONL OK) — không tự invent ACK mới.

---

## v6.30.0 (2026-09-02)

### Orchestrator Prompt & Parser
- **orchestrator.md**: Refactor mô hình `task=` = title only, nội dung chi tiết trong `message=`/body. Section 2b "PHONG CÁCH GIAO TASK CHI TIẾT"; Rule 0/3/7 cập nhật.
- **server.ts** `parseSpawnCommand` (L2543-2558): nối `task= — ${body}` khi cả 2 có; dùng body khi task rỗng; xử lý `<task></task>` trong body.
- **server.ts** `parseTalkCommand`: tách `task=`(title) khỏi `message=`/body (content), không overwrite.

### Build
- Version bumped 6.29.0 → 6.30.0
- Build exe: `agentforge-web-v6.30.exe` (105,930,752 bytes, MD5 `0BF9F2217DC4A3941081798C038E7FC5`)

---

## v6.29.0 (2026-09-02)

### Orchestrator Prompt Improvement
- **orchestrator.md**: Added WARNING section at top — "DISPATCH SYNTAX: `<spawn>`, `<talk>` must be TEXT, NOT tool_calls"
- **orchestrator.md**: Added explicit tool list reminder: "Only read, edit, write, glob, grep, webfetch, websearch"
- **orchestrator.md**: Added correct vs incorrect examples for dispatch syntax

### Build
- Version bumped to 6.29.0
- Build exe: `agentforge-web-v6.29.exe` (~101MB SEA bundle)

---

## v6.28.0 (2026-09-02)

### Streaming Interleaved Fix
- **server.ts**: Broadcast `chat:tool_call` realtime events after `chat:chunk` (L858-866)
- **server.ts**: Relaxed parts condition to `parts.length > 0` for rendering (L884)
- **App.tsx**: `chat:handler` now pushes `{type:'text', content}` into `parts` array (L301-305)
- **App.tsx**: `chat:tool_call` now pushes `{type:'tool', tool, input, output}` into `parts` array (L325-328)

### XML Parser Fix
- **server.ts** L1991: Fixed `extractXmlCommand` regex to handle `>` inside quoted attributes. Changed `[^>]*` to `(?:[^>"']|"[^"]*"|'[^']*')*` for proper quoted attribute matching.

### Task Length Guardrail
- **server.ts** L3256: Added empty task rejection — spawns with no task are removed and error reported via `SPAWN_EMPTY_TASK`
- **server.ts** L3263: Added task length warning — tasks exceeding 20 words trigger `SPAWN_TASK_LONG` warning

### Build & Deploy
- Version bumped to 6.28.0
- Build exe: `agentforge-web-v6.28.exe` (~101MB SEA bundle)
- Git repo: https://github.com/Lighthouselp95/agentforge-v6.27 (private)

### Build Note
- `-serve` exe naming convention is for a separate repo — not needed in this project's build process

---

## v6.27.0

- Initial version tracked in this changelog
