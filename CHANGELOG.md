# Changelog

## v7.0.30 (2026-09-05)

### Giới Hạn Độ Dài Tiêu Đề Task 30 Từ & Hot Reload Trực Tuyến Quota/Model
- **Task Length Limit 30 Từ (`src/server.ts`, `src/relay/router.ts`)**:
  - Chuẩn hóa giới hạn độ dài task giao việc tối đa 30 từ, tự động cắt tỉa gọn gàng kèm cảnh báo phản hồi nếu vượt quá giới hạn.
- **Hot Reload Trực Tuyến Quota & Cấu Hình Model**:
  - Hỗ trợ hot reload live tức thời cho các thiết lập quota giới hạn role, kích thước team và cấu hình model mà không cần khởi động lại máy chủ.

## v7.0.29 (2026-09-05)

### Triệt Để Xóa Fallback TeamId & Cơ Chế Lỗi TEAM_ORCH_NOT_FOUND
- **Backend (`src/server.ts`, `src/storage/team-resolver.ts`)**:
  - Loại bỏ hoàn toàn việc bịa ID `team-${row.id.slice(-8)}` và gán fallback `return 'default'` tùy tiện khi giải quyết `teamId`.
  - `team-resolver.ts` ném lỗi chuẩn mực `TEAM_ORCH_NOT_FOUND` khi không xác định được team context của tin nhắn.
  - `getAgentTeamId` ném lỗi `TEAM_ORCH_NOT_FOUND` nếu agentId không tồn tại hoặc agent không có `teamId` hợp lệ.
  - Bắt lỗi `TEAM_ORCH_NOT_FOUND` trong luồng xử lý OAC Stream, tự động tạo và phát broadcast bong bóng `chat:message` `msgType: 'error'` lên UI, đồng thời gửi `deliverTalk` phản hồi về `issuerAgent`.
  - `findAgentByIdNameOrRole` so khớp chính xác `agent.teamId === preferredTeamId` thay vì fallback `default`.

### Task Lifecycle: Xóa Ngay Lập Tức Task Completed
- **`src/server.ts` & `src/storage/agent-storage.ts`**:
  - `countRealTasks` loại bỏ task đã completed, chỉ đếm task active đang thực thi.
  - `<task_update>` khi chuyển sang trạng thái `completed` sẽ xóa bỏ ngay lập tức task khỏi danh sách `agent.tasks`, tự động re-index lại 1..N và chuyển status agent sang `idle` khi hết task.

### Frontend (`web/src/components/Dashboard.tsx` & `web/src/components/TeamSettingsDialog.tsx`)**:
  - `Dashboard.tsx`: Bỏ toàn bộ chuỗi cắt `slice(-8)` khi tính toán `orchTeamId` và `orphanTeams`.
  - `TeamSettingsDialog.tsx`: Thiết kế độc lập theo từng team, loại bỏ cảnh báo vàng, cho phép linh hoạt cấu hình per-team.

## v7.0.22 (2026-09-05)

### Multi-Team Isolation: Triệt Để Khắc Phục Rò Rỉ Tin Nhắn Giữa Các Team (5 Chains)
- **Chain 1 & 5 (Broadcast & History Isolation - `src/server.ts`)**:
  - Gắn chặt teamId khi broadcast realtime events (`chat:message`, `chat:chunk`, `chat:thinking`, `chat:tool_call`, `chat:queue:dispatched`).
  - Phân lập lịch sử chat (`getChatHistory`) theo đúng workspace team, không rò rỉ tin giữa các team khác nhau.
- **Chain 2, 3 & 4 (Lookup, Routing & Outbox Isolation - `src/storage/`)**:
  - `agentLookup` và agent resolution giới hạn trong phạm vi team tương ứng.
  - Hàng đợi outbox và queue storage phân lập theo `teamId`, ngăn chặn việc gửi nhầm chỉ đạo hoặc nhận nhầm báo cáo giữa các team độc lập.

### Fix Queue Main UI Kẹt Tin (ID Temp vs UUID & Target Key Normalization)
- **`src/server.ts` & `web/src/App.tsx`**:
  - Server ưu tiên nhận `req.body.messageId` do client gửi lên làm `userMsg.id`, loại bỏ hoàn toàn hiện tượng lệch ID giữa tempId của frontend và UUID của backend.
  - Client tự động đồng bộ `finalId` nếu server phản hồi ID khác.
  - Chuẩn hóa target keys trong `chat:queue:dispatched`, tự động dọn dẹp đồng thời cả alias `orchestrator` và ID cụ thể.
  - Bổ sung fallback xóa hàng đợi theo đối chiếu `idMatch` lẫn `contentMatch` trong `chat:message`.
  - Tự động làm sạch toàn diện hàng đợi, streamRef và inflightTargetRef khi Orchestrator chuyển trạng thái không còn `working`.

## v7.0.21 (2026-09-05)

### Fix UI: Tránh Lỗi TDZ, Sửa Mất Căn Phải & Gom Container Directive ChatPanel
- **`web/src/components/ChatPanel.tsx`**:
  - Di chuyển khai báo `isEligibleOrchSender`, `selAgentObj`, `isSelectedOrch`, `isSubOrchView`, `isFromCurrentSubOrch` lên trước `contentDirectives` để loại bỏ dứt điểm runtime TDZ `ReferenceError`.
  - Sửa lỗi mất căn phải (ép bubble sang trái): Gỡ bỏ triệt để điều kiện phủ định `!isOrchestratorTask` tại `className`, `borderRadius`, `alignSelf`, `marginLeft`, `marginRight`.
  - Gom toàn bộ các Directive Cards và bong bóng hội thoại (`conversationText` / `body`) vào cùng một wrapper container `flex-direction: column` thống nhất, giúp hiển thị thẳng hàng, liền mạch và tránh vỡ layout.
  - Sửa điều kiện hiển thị bubble đối thoại thành `(conversationText || body)` để không nuốt lời thoại của Main Orchestrator khi có task.

## v7.0.20 (2026-09-05)

### Stream-First: Loại Bỏ Hoàn Toàn Snapshot Trọn Gói OpenCode Cuối Lượt
- **Backend (`src/server.ts`, `src/storage/message-storage.ts`, `src/storage/index.ts`)**:
  - Xóa triệt để phương thức `saveOpenCodeSnapshot` và delegate tương ứng — không còn mã nào tạo/lưu snapshot tổng `msgType: 'opencode'` rỗng cuối lượt.
  - Giữ nguyên 100% kênh stream realtime (`broadcastOACEvent`: `chat:chunk`, `chat:thinking`, `chat:tool_call`).
  - Giữ tin canonical `chat:message` cuối lượt cho mục đích chốt `isStreaming = false` và gán ID chính thức.
  - `saveTranscript` giữ nguyên (chỉ ghi storage audit, không broadcast UI).
- **Frontend (`web/src/App.tsx`)**:
  - Xóa nhánh merge snapshot rỗng `isOpenEmptySnapshot && m.msgType === 'opencode'`.
  - Giữ Stream-First Finalization: khi nhận canonical cuối lượt, cập nhật tại chỗ bubble stream (chốt isStreaming, gán ID, giữ nguyên mảng parts xen kẽ toolCall/thinking).
  - Đơn giản hóa `applyOacDedup`: chỉ dedup theo `m.id` + hash nội dung 5s, bỏ mốc snapshot `opencode`.

### Fix UI: Render Nhiều Directive Card (`<talk>`/`<spawn>`) Trong Một Message
- **`web/src/components/ChatPanel.tsx`**:
  - Thêm tokenizer `extractAllDirectivesAndText` (L1876-1957): quét toàn chuỗi, tách N directive xen kẽ text (`<talk>`, `<spawn>`, `[TALK]`, `[SPAWN]`), áp dụng cho cả render `msg.parts` (L2834-2984) lẫn single bubble.
  - `hasDuplicateIndependentTalk` (L2169-2209): đánh giá trùng lặp theo TỪNG directive con (`duplicateDirectivesSet`, `activeDirectives`) thay vì cờ toàn cục — hết cảnh "1 thẻ trùng làm mất toàn bộ card".
  - Xóa fallback nuốt text toàn message (`talkTaskDesc = rawTrimmed`) — card chỉ nhận task thực sự.
  - Chuẩn hóa strip tag khỏi `body`/`conversationText` (L2411-2420, 3072, 3236-3266): khung chat trái chỉ còn lời đối thoại, không dính body directive đã dispatch.

### Fix Server: Parse & Dispatch Multiple `<talk>`/`<spawn>` Chính Xác
- **`src/server.ts`, `src/core/command-parser.ts`, `src/parser/xml-parser.ts`**:
  - `extractXmlCommand`: `<spawn>` bắt buộc self-closing hoặc có thẻ đóng; tuyệt đối không fallback nuốt text tới EOF (L2824-2826, xml-parser L68-70).
  - `scanStreamForDispatch`: cắt chuỗi theo index-based substring (indexOf + substring) thay vì `replace(fullMatch)` — bảo toàn các talk phía sau (L1069-1078).
  - `talkDispatchSig` + `occurrenceIndex`: 2 talk cùng target khác message/khác lượt không bị skip (L969-971, L1023, L4589-4600).
  - `parseAgentOutput`: chỉ gộp khi `unclosed === true`, không gộp tuỳ tiện 2 talk hoàn chỉnh (command-parser L742-752).
  - `streamMaskingBuf`: giữ token dở của tag điều phối (`<ta`, `lk ...`) không rò rỉ ra UI stream; chỉ broadcast safePrefix (L1288-1315).
  - `stripCommandTags` với `ignoreMarkdownDoc: true`: gọt sạch tag điều phối khỏi bubble text trái kể cả cạnh markdown list/blockquote (L3020).

### Fix Queue: Không Mất Tin Khi STOP Agent + Auto-Drain
- **`src/server.ts`**:
  - `stopAgent()` (~L1646-1680) và `/api/agents/:id/abort` (~L4998-5030): thêm block auto-drain `backendUserQueues` — gom messageIds, lưu `saveUnprocessedMessage` xuống đĩa, broadcast `chat:queue:dispatched` kèm đầy đủ messageIds, ghi tin vào chatHistory.
- **`web/src/App.tsx`**:
  - Handler `agent:updated`: khi `status !== 'working'` xóa sạch `agentQueues[ag.id]` (L660-667).
  - Handler `chat:message`: safety fallback xóa queue theo messageId trùng (L342-359).
  - Handler `chat:queue:dispatched`: xóa đúng messageIds khỏi khay (L310-340).
  - Optimistic Queue UI trong `sendMessage`: hiển thị tin queue ngay khi agent busy (L874-882).

### Nghiệm Thu
- `verifier-audit` đã thực chứng trên đĩa cứng cả 4 nhóm thay đổi (stream-first, UI multiple-talk, server parse, queue STOP+auto-drain) — tất cả PASS.
- `npx tsc --noEmit` backend & web: 0 lỗi. `npm --prefix web run build` (Vite): 0 lỗi (1.67s-3.32s).

## v7.0.28 (2026-09-05)

### Fix Runtime TDZ: Cannot access 'storage' before initialization

- **Root cause**: `src/storage/index.ts` `export const storage = new AppStorage()` chạy EAGER trong ESM module evaluation. `StorageEngine` constructor gọi `console.warn/log` (khi state file invalid/empty) → `console.log` bị override tại `src/server.ts` L50/55/60 thành `pushLogLine` → `storage.saveLog()` → `storage` vẫn trong TDZ → V8 ném `ReferenceError`.
- **`src/storage/index.ts`**: Thay `export const storage = new AppStorage()` bằng `new Proxy({} as AppStorage)` + `getStorageInstance()` lazy singleton — `AppStorage()` chỉ gọi khi property đầu tiên được truy xuất.
- **`src/server.ts`**: `pushLogLine` dùng `let storageRef` + `if (stor) { stor.saveLog(...) }` guard + `storageRef = storage` SAU console override (L76).
- **`src/core/logger.ts`**: Xóa `import { storage}` direct, thêm `let _storageRef` + `getStorage()` lazy + `require('../storage.js').storage` end module; guard `if (stor)` trước saveLog.
- **`src/logger/ring-buffer.ts`**: Thêm `let storageRef` + `getStorage()` lazy + `require('../storage.js').storage` end module; guard `if (stor)` trước saveLog.
- Build: `npx tsc --noEmit` 0 errors, `npm run build` pass.

### Nghiệm Thu
- `coder-core` áp dụng 4 fix + build PASS. `verifier-audit` nghiệm thu trên đĩa xác nhận Proxy lazy init + guard `if (stor)` ở 3 file pushLogLine.

## v7.0.26 (2026-09-05)

### Tách Biệt Độc Lập Hàng Đợi & Đồng Bộ Render Hoàn Toàn Cho Sub-Orchestrator
- **Cô Lập Tuyệt Đối Hàng Đợi & Trạng Thái Bận Của Sub-Orchestrator (`src/server.ts`)**:
  - Tại endpoint `POST /api/chat`: Định danh hàng đợi `targetIdKey` của Sub-Orchestrator được giữ nguyên theo ID riêng biệt của nó (dạng `agent-xxxx`), không bị gộp sai về Root Orchestrator.
  - Kiểm tra trạng thái bận độc lập: `targetClient = getOrchClient(targetIdKey)` chỉ kiểm tra `isBusy()` của chính Sub-Orchestrator tương ứng. Khi Sub-Orchestrator đang rảnh (`idle`), tin nhắn được thực thi tức thì mà không bị nghẽn oan do Root Orchestrator đang bận.
  - Chuẩn hóa `normalizeQueueKey(targetId)`: Chỉ ánh xạ về `'orchestrator'` khi targetId rỗng hoặc chính xác là `'orchestrator'`, bảo toàn key riêng cho mọi Sub-Orchestrator.
- **Đồng Bộ Hoàn Toàn Giao Diện Giữa Root Orchestrator và Sub-Orchestrator (`ChatPanel.tsx`, `App.tsx`)**:
  - Nhận diện chính xác báo cáo đến (`isIncomingToOrch`) trên mọi Orchestrator, ẩn các toolcall phụ từ worker để giữ khung chat luôn gọn gàng.
  - Khôi phục trọn vẹn thanh định danh capsule pill `👑 Tên Orchestrator · main ➜ 👤 You` trên mọi tab.
- **Nghiệm Thu Toàn Diện**:
  - `verifier-audit` đã nghiệm thu thực chứng trực tiếp mã nguồn trên đĩa (VERDICT: PASS 100%).
  - Biên dịch hệ thống: `npx tsc --noEmit` đạt 0 lỗi, Vite production build hoàn tất trong 6.03s.

## v7.0.25 (2026-09-05)

### Đồng Bộ Render Hoàn Toàn Giữa Orchestrator 1 (Root) Và Orchestrator Thứ 2 (Sub-Orchestrator)
- **Đồng Bộ Hóa Nhận Diện Tin Báo Cáo Đến (`isIncomingToOrch`) Trong `ChatPanel.tsx`**:
  - Khắc phục lỗi so sánh cứng `msg.to === 'orchestrator'` khiến các báo cáo gửi về Orchestrator thứ 2 (ID dạng `agent-xxxx`) không được nhận diện đúng.
  - Cập nhật điều kiện linh hoạt cho cả Sub-Orchestrator: `isSubOrchView ? (msg.to === selectedAgentId && !isUser && !isFromCurrentSubOrch) : (msg.to === 'orchestrator' && !isOrchestrator && !isUser)`.
  - Nhờ đó, quy tắc ẩn toolcall phụ từ báo cáo của worker khi gửi về Orchestrator hoạt động nhất quán 100% trên tất cả các tab Orchestrator, giữ khung chat luôn gọn gàng, sạch sẽ.
- **Chuẩn Hóa Header Capsule Pill Người Nhận (`displayTo`)**:
  - Bổ sung fallback tự động `displayTo = 'You'` khi Sub-Orchestrator trả lời người dùng mà không có trường `msg.to` tường minh.
  - Đảm bảo thanh điều hướng ở header tin nhắn luôn hiển thị đầy đủ icon vương miện 👑, tên Sub-Orchestrator, mũi tên ➜ và capsule người nhận 👤 You, chấm dứt tình trạng header bị cụt hoặc khuyết thông tin.
- **Nghiệm Thu Toàn Diện**:
  - Backend TypeScript: `npx tsc --noEmit` đạt 0 lỗi biên dịch.
  - Frontend Vite: `npm --prefix web run build` thành công xuất sắc (317 kB bundle).

## v7.0.24 (2026-09-05)

### Khắc Phục Dứt Điểm Kẹt Hàng Đợi Queue UI & Cố Định Kích Thước Khối Tool Call
- **Triệt Tiêu Hoàn Toàn Lỗi Sót Tin Hàng Đợi (Queue Desync) (`src/server.ts`, `web/src/App.tsx`)**:
  - `src/server.ts`: Bổ sung phát sự kiện `chat:queue:dispatched` kèm danh sách toàn bộ `messageIds` tại cả 2 luồng xả hàng đợi:
    + Luồng xả tuần tự của Worker (`processNextBackendUserQueue`).
    + Luồng gom hàng đợi vào đợt dispatch báo cáo của Orchestrator (`processOrchestratorTriggerQueue`).
    Đồng thời lặp qua từng tin nhắn để lưu DB và broadcast bong bóng chat độc lập với đúng ID và timestamp thực tế.
  - `web/src/App.tsx`: Loại bỏ hoàn toàn đoạn logic cũ `q.slice(1)` trong listener sự kiện `chat:chunk` (vốn gây xung đột và làm kẹt tin khi người dùng gửi nhiều tin liên tiếp được gom thành 1 lượt dispatch). Việc giải phóng hàng đợi UI nay được quy về duy nhất sự kiện chính thức `chat:queue:dispatched`.
- **Cố Định Độ Rộng Khối Tool Call Đồng Nhất Khi Expand & Collapse (`web/src/components/ChatPanel.tsx`)**:
  - Chuẩn hóa kích thước khung chứa Tool Call: thiết lập cố định `width: 75vw` và `minWidth: 55vw` (chiếm hơn nửa màn hình, tối đa 95% trên desktop và 100% trên mobile).
  - Loại bỏ hoàn toàn thuộc tính co nhỏ `isAlignRight ? 'auto'` khi ở trạng thái thu gọn (Collapse).
  - Đảm bảo khối Tool Call luôn giữ nguyên kích thước ổn định, rộng rãi và không bị giật giao diện hay co rút chiều ngang khi người dùng đóng/mở khối xem diff/code.
- **Nghiệm Thu Toàn Diện**:
  - Backend TypeScript: `npx tsc --noEmit` đạt 0 lỗi biên dịch.
  - Frontend Vite: `npm --prefix web run build` thành công xuất sắc trong 1.67s.

## v7.0.23 (2026-09-05)

### Khắc Phục Triệt Để Lệch Pha Race Condition Giữa Worker Reports & Main Orchestrator
- **Kích Hoạt Tức Thì Khi Orchestrator Rảnh (`src/server.ts`)**:
  - Tại `triggerOrchestrator`, bổ sung kiểm tra trạng thái của Orchestrator mục tiêu (`isOrchIdle = !client.isBusy() && orchAgent.status !== 'working'`).
  - Nếu Orchestrator đang rảnh rỗi, hệ thống xóa bỏ toàn bộ timer hoãn và lập tức dispatch thông qua `setImmediate(processOrchestratorTriggerQueue)` thay vì bắt buộc chờ debounce 1500ms như trước.
- **Tự Động Xả Hàng Đợi Báo Cáo Chờ Khi Orchestrator Vừa Hoàn Tất Lượt (`src/server.ts`)**:
  - Tích hợp cơ chế auto-drain trực tiếp trong khối `finally` của cả `processOrchestratorTriggerQueue` và `dispatchUserChat`.
  - Ngay khi tiến trình cũ của Orchestrator kết thúc và chuyển trạng thái về `idle`, server tự động kiểm tra `pendingOrchTriggers`. Nếu có báo cáo của Worker nộp về trong lúc Orchestrator đang bận, hệ thống kích hoạt ngay lượt xử lý kế tiếp để Orchestrator lập tức tiếp nhận thông tin mới nhất mà không bị rơi rớt ngữ cảnh.
- **Tối Ưu Hóa Cửa Sổ Khử Trùng Lặp Báo Cáo (`src/server.ts`)**:
  - Rút ngắn `ORCH_TRIGGER_DEDUP_MS` từ 5000ms xuống còn 2000ms, vừa ngăn chặn spam báo cáo trùng lặp vừa đảm bảo không nuốt nhầm các báo cáo tiến độ mới liên tiếp từ các worker song song.
- **Nghiệm Thu Toàn Diện**:
  - `verifier-audit` đã nghiệm thu thực chứng trực tiếp mã nguồn trên đĩa (VERDICT: PASS 100%).
  - Kiểm tra hệ thống: `npx tsc --noEmit` đạt 0 lỗi biên dịch, `npm run build --prefix web` hoàn tất thành công.

## v7.0.22 (2026-09-05)

### Chuẩn Hóa Hàng Đợi Đơn Tuyến (Server-Side Queue), Timing Tuyệt Đối & Fix Race Force-Send
- **Chuẩn Hóa Key Hàng Đợi Đơn Tuyến Của Orchestrator (`src/server.ts`)**:
  - Tích hợp helper `normalizeQueueKey(targetId)` quy toàn bộ hàng đợi của Orchestrator 1 về duy nhất một key `'orchestrator'`, triệt tiêu phân mảnh dữ liệu giữa dynamic ID và root key.
  - Mỗi Agent duy trì hàng đợi `backendUserQueues[targetIdKey]` độc lập 100%, không bị dính chéo hoặc rò rỉ sang agent khác.
- **Đồng Bộ Dòng Thời Gian (Timing) Tuyệt Đối Giữa Tin User Và Worker Report (`src/server.ts`)**:
  - Gán nhãn thời gian thực `timestamp: Date.now()` cho tin nhắn người dùng ngay khi nhận vào queue và lưu trực tiếp vào SQLite/ChatHistory.
  - Trong `processOrchestratorTriggerQueue`, kết hợp các tin nhắn đang xếp hàng của người dùng với các báo cáo từ Worker thành mảng `TimelineEntry` thống nhất, sắp xếp theo thứ tự thời gian tăng dần (`timestamp`), đảm bảo Orchestrator tiếp nhận diễn biến chính xác theo trình tự thực tế.
- **Tự Động Xả Hàng Đợi Liên Hoàn Khi Process Đóng (`src/server.ts`)**:
  - Cập nhật `processNextBackendUserQueue`: Khi tiến trình OpenCode kết thúc bình thường và agent chuyển về trạng thái `idle`, server tự động gom toàn bộ các tin nhắn đang chờ trong hàng đợi thành một khối liên hoàn (`messagesToDispatch`) theo đúng thứ tự thời gian gốc để nạp vào lượt tiếp theo, bảo toàn trọn vẹn ngữ cảnh của người dùng mà không bị phân mảnh nhiều turn.
- **Nâng Cấp Cơ Chế Gửi Ngay (Force-Send) & Chống Race Condition (`src/server.ts`)**:
  - Hỗ trợ hoàn chỉnh cả 2 chế độ tại `/api/chat/force-send`:
    + `single`: Bốc đúng tin nhắn được chọn ra khỏi hàng đợi.
    + `all`: Bốc toàn bộ hàng đợi của target tương ứng để thực thi ngay.
  - Ngắt tiến trình bằng `client.abort()` kết hợp vòng lặp polling an toàn `while (client.isBusy() && Date.now() - abortStart < 2500)` để đảm bảo tiến trình OpenCode cũ đã thoát hoàn toàn và nhả lock SQLite trên Windows trước khi spawn tiến trình mới.
  - Dọn sạch bộ đệm rác cũ qua `storage.clearUnprocessedMessages(targetIdKey)` và `client.clearUnprocessedPrompts()`, loại bỏ nguy cơ hồi sinh prompt cũ hay xung đột trạng thái.
  - Sửa lỗi duplicate catch block trong handler `/api/chat/force-send`, bảo đảm biên dịch TypeScript sạch sẽ 0 lỗi (`npx tsc --noEmit` pass 100%).

## v7.0.21 (2026-09-04)

### Đồng Bộ Single Stream Flow, Cô Lập Tuyệt Đối Orchestrator Tool Calls & Sắp Xếp Tuyến Tính Timeline
- **Cô Lập Triệt Để Tool Calls & Snapshot Stream Giữa Orchestrator 1 và 2 (`web/src/App.tsx`)**:
  - Gỡ bỏ toàn bộ điều kiện lọc chung `m.agentRole === 'orchestrator'` trong bộ lọc Main view và tab Root Orchestrator.
  - Khóa chặt logic hiển thị: Main view và Root Orchestrator tab chỉ chấp nhận snapshots/stream khi `m.from === orchId || m.from === 'orchestrator'`.
  - Ẩn triệt để toàn bộ snapshot `opencode`, thinking và tool calls của Sub-Orchestrator 2 khỏi Orchestrator 1 / Main view, đảm bảo tool calls của Sub-Orch 2 chỉ hiển thị độc quyền trên tab của chính nó.
- **Triệt Tiêu Lỗi Dồn Log Stream Vào Thẻ Directive Card (`web/src/components/ChatPanel.tsx`, `web/src/App.tsx`)**:
  - `ChatPanel.tsx`: Sửa fallback trích xuất của `spawnTaskDesc` về `cleanTaskTitle || 'Khởi tạo agent'`, loại bỏ hoàn toàn việc nuốt chuỗi `msg.content` thô vào khung thẻ Spawn Card khi không bóc tách được directive.
  - `App.tsx`: Tự động giải phóng và dọn dẹp `streamRef.current` theo từng lượt tương tác độc lập, ngăn ngừa việc tích lũy dồn log từ các tác vụ cũ vào cùng một bubble stream.
  - Chặn triệt để hiện tượng nhân đôi nội dung (`conversationText`) bên dưới Directive Card khi nội dung đó đã được render bên trong Card.
- **Tái Cấu Trúc Broadcast WebSocket FIFO 100% & Sắp Xếp Timeline Tuyến Tính (`src/server.ts`, `web/src/components/ChatPanel.tsx`)**:
  - `src/server.ts`: Tái cấu trúc `broadcastOACEvent` sang cơ chế Realtime In-place FIFO, phát trực tiếp tức thì từng sự kiện (`chat:chunk`, `chat:thinking`, `chat:tool_call`) kèm `timestamp` gốc do OpenCode sinh ra.
  - `ChatPanel.tsx`: Áp dụng sắp xếp danh sách tin nhắn theo `timestamp` tuyến tính bằng `useMemo` trước khi tail-window slice, đảm bảo tin nhắn luôn hiển thị chuẩn xác theo thứ tự thời gian phát sinh thực tế.
- **Đồng Bộ Vòng Đời Hàng Đợi Tin Nhắn UI (`web/src/App.tsx`)**:
  - Giữ lại tin nhắn trong `queuedMessages` trên giao diện và chỉ giải phóng khỏi hàng đợi khi nhận được event thực thi thực tế đầu tiên từ OpenCode (`chat:chunk` hoặc `chat:thinking`).

## v7.0.20 (2026-09-04)

### Chuẩn Hóa Thứ Tự Hiển Thị Stream Thuần OpenCode & Hoàn Thiện Trải Nghiệm Giao Diện
- **Hiển Thị Tuần Tự 100% Theo Mảng `parts` của OpenCode (`web/src/components/ChatPanel.tsx`)**:
  - Loại bỏ hoàn toàn cơ chế gom nhóm cứng (không ép toàn bộ thinking lên đầu, không dồn toolcall vào giữa).
  - Mọi khối (`Thinking`, `ToolCall`, `Directive Card`, `Text`) đều được xem là bình đẳng và hiển thị tuần tự theo đúng thời gian thực mà OpenCode trả về qua luồng `parts`.
  - Khi xuất hiện thẻ điều phối (`<talk>` hoặc `<spawn>`) trong luồng text, hệ thống tự động bóc tách và render thành **Directive Card** ngay tại vị trí xuất hiện trong dòng chảy, không để thẻ nhảy sai vị trí.
- **Kích Hoạt Hiển Thị ToolCalls Trên Main View (`web/src/App.tsx`)**:
  - Thiết lập `showToolBlocks={true}` trên Main View kết hợp với bộ lọc ngăn rò rỉ tool call từ Worker, giúp người dùng theo dõi trực tiếp các thao tác gọi công cụ của Orchestrator realtime.
- **Gộp Consecutive Text Chunks Trong Realtime Stream (`web/src/App.tsx`)**:
  - Tự động cộng dồn các `delta` text liên tiếp trong sự kiện `chat:chunk` vào cùng một part thay vì tạo các mảnh vỡ vụn.
- **Căn Phải Tuyệt Đối Bong Bóng Tin Nhắn Người Dùng (`web/src/components/ChatPanel.tsx`, `web/src/index.css`)**:
  - Chuẩn hóa điều kiện `isUser = msg.from === 'user' || msg.role === 'user'`, căn phải 100% qua JSX (`alignSelf: flex-end`, `marginLeft: auto`) và CSS `.af-bubble-user` ở cả Dark và Light theme.
  - Phục hồi thẻ Directive Card cho Orchestrator, loại bỏ điều kiện chặn sai `msg.to !== 'user'`.
- **Đóng Gói Standalone Binary Release**:
  - Nâng phiên bản hệ thống lên `v7.0.20` đồng bộ trong `package.json`, `web/package.json` và `src/server.ts`.
  - Đóng gói hoàn chỉnh tệp thực thi nhị phân `release/agentforge-web-v7.0.20.exe` (106,029,056 bytes).

## v7.0.19 (2026-09-04)

### Khắc Phục Triệt Để Hiện Tượng Sub-Orchestrator Trả Lời Xen Lẫn Tin Nhắn Cũ & Cô Lập Session Hoàn Toàn
- **Chặn Auto-Merge Tin Cũ Chưa Xử Lý Vào Prompt Mới (`src/server.ts`)**:
  - Tại `dispatchUserChat`, chỉ kích hoạt cơ chế gộp `[Tin chưa xử lý trước đó]` khi đây là lượt retry tự động do lỗi mạng/sập (`isRetry === true`).
  - Đối với lượt chat mới của người dùng (`!isRetry`), dọn sạch toàn bộ bộ đệm `storage.clearUnprocessedMessages(targetKey)` và `client.clearUnprocessedPrompts()`, chấm dứt hiện tượng câu hỏi mới bị gắn kèm các prompt/yêu cầu cũ từ các turn trước.
- **Cô Lập Unread Messages Giữa Root Orchestrator và Sub-Orchestrator (`src/server.ts`)**:
  - Khi gom `consumeUnreadForOrchestrator(orchId)`, bổ sung bộ lọc nghiêm ngặt theo `m.to === orchId` hoặc `m.teamId === orchTeam`.
  - Ngăn chặn triệt để việc các thông điệp chưa đọc (unread reports/notifications) của Root Orchestrator hoặc team khác bị inject nhầm vào prompt của Sub-Orchestrator.
- **Cô Lập Tuyệt Đối Session ID Tránh Ghi Đè Chéo (`src/server.ts`)**:
  - Sửa lỗi fallback `findExistingOrchestrator()` tại dòng gán Session ID trong `dispatchUserChat`. Khi `orchId !== 'orchestrator'`, hệ thống không fallback về Root Orchestrator mà luôn gắn chặt session theo `teamId` và ID riêng của Sub-Orchestrator. Chấm dứt nguy cơ Sub-Orchestrator bị dùng chung Session ID với Root Orchestrator trong OpenCode.
- **Chuẩn Hóa Nhận Diện Sub-Orchestrator Trong Endpoint `/api/chat` (`src/server.ts`)**:
  - Bổ sung kiểm tra `isOrchestratorLike(targetAgent)` để nhận diện chính xác Sub-Orchestrator, đảm bảo client và hàng đợi `backendUserQueues` hoạt động đồng nhất với kiến trúc Orchestrator.

### Khắc Phục Lỗi Rò Rỉ Prompt Đầu Vào & Phân Định Chuẩn Xác Tin Nhắn Đến Cho Sub-Orchestrator
- **Chặn Rò Rỉ Prompt Stdin Trong WebSocket Stream (`src/server.ts`)**:
  - Khi OpenCode CLI chạy một turn cho Sub-Orchestrator, tiến trình OpenCode thường phát ra event stdout JSONL loại `user`, `init`, `session`, `system` phản chiếu lại prompt nhận được từ stdin.
  - Loại bỏ hoàn toàn các event này khỏi `textLines` stream trong `broadcastOACEvent` (bỏ qua bằng `continue`). Chấm dứt hiện tượng các khối dữ liệu nội bộ (`=== INCOMING MESSAGE ===`, `[TEAM]...[/TEAM]`, `=== MESSAGE ===`) bị stream trực tiếp lên bong bóng chat UI.
- **Chuẩn Hóa Phân Bổ `teamId` Cho Sub-Orchestrator (`src/server.ts`)**:
  - Thêm helper `getAgentTeamId(agentId)` đảm bảo mọi event stream (`chat:chunk`, `chat:thinking`, `chat:tool_call`) phát ra từ Sub-Orchestrator mang đúng định danh `team-${agentId.slice(-8)}` thay vì bị fallback cứng về `'default'`.
- **Tách Biệt Nguồn Gửi & Sửa Lỗi Hiển Thị Cho Sub-Orchestrator (`web/src/App.tsx`)**:
  - Trong `filteredMessages`, định nghĩa rõ `isFromRootOrch` để phân biệt Root Orchestrator và các Worker thông thường.
  - Phân luồng chính xác: Tin chỉ đạo từ Root Orchestrator gửi đến Sub-Orchestrator (`isFromRootOrch && isToSelf`) được tiếp nhận đầy đủ nhưng không bị gộp chung vào danh mục báo cáo của Worker.
- **Căn Lề Hai Chiều Chuẩn Xác Cho Sub-Orchestrator (`web/src/components/ChatPanel.tsx`)**:
  - Khi xem tab của Sub-Orchestrator (`selectedAgentId !== 'orchestrator'`), chỉ những tin nhắn do CHÍNH Sub-Orch đó phát ra (`isFromCurrentSubOrch`) mới được tạo **Directive Card** và **CĂN PHẢI** (`isAlignRight = true`).
  - Toàn bộ tin nhắn do Root Orchestrator hoặc bên ngoài gửi đến Sub-Orch được nhận diện chính xác là **INCOMING MESSAGE** và được **CĂN TRÁI** (`isAlignRight = false`), chấm dứt hiện tượng Sub-Orch bị ngộ nhận là tự ra lệnh cho chính mình.

## v7.0.18 (2026-09-04)

### Khắc Phục Triệt Để Lỗi Rụng Ký Tự Tiếng Việt In Hoa (Unikey/EVKey) & Tối Ưu Native Input
- **Chuyển Textarea Sang Native Uncontrolled Ref Input (`web/src/components/ChatPanel.tsx`)**:
  - Loại bỏ hoàn toàn việc đồng bộ state `input` trên từng phím bấm (`onChange => setInput(e.target.value)`). Trước đây, mỗi phím bấm làm React re-render liên tục, ngắt quãng chuỗi phím ảo `[Backspace]` của Unikey/EVKey khi ghép dấu chữ in hoa đầu câu (như `Đ`, `Â`, `Ê`, `Ô`, `Ư`).
  - Sử dụng cờ boolean nhẹ `hasText` chỉ cập nhật state khi trạng thái thay đổi giữa *rỗng* và *có chữ* để quản lý UI nút Gửi. Khi đang soạn thảo, DOM textarea tự do nhận phím 100% như Notepad / Chrome native.
- **Bảo Vệ IME Windows (`keyCode === 229`)**:
  - Bổ sung guard `e.keyCode === 229` (mã trạng thái IME Pending trên Windows) trong `handleKeyDown`, ngăn chặn việc bấm Enter gửi nhầm khi bộ gõ tiếng Việt đang trong nhịp ghép ký tự.
- **Đọc Dữ Liệu Trực Tiếp Khi Gửi**:
  - Hàm `handleSend` đọc trực tiếp từ `textareaRef.current.value`, chuẩn hóa `normalize('NFC')` và reset về rỗng mượt mà.

## v7.0.17 (2026-09-04)

### Chuyển 100% Hàng Đợi (Queue) Về Server-Side FIFO, Triệt Tiêu Duplicate Directive Card & Khắc Phục Leak Tin Sub-Orchestrator
- **Triển Khai Server-Side FIFO Message Queue (`src/server.ts`)**:
  - **Hàng đợi bộ nhớ Node.js**: Xây dựng `backendUserQueues: Record<string, Array<{ targetId, rawMsg, isSlash }>>` quản lý thứ tự tin nhắn chuẩn FIFO.
  - **Phản hồi không nghẽn HTTP**: Khi Agent hoặc Orchestrator đang bận (`working` hoặc `client.isBusy()`), `POST /api/chat` lập tức lưu tin vào SQLite DB & `chatHistory`, phát WebSocket ra UI và trả về `{ ok: true, queued: true }` ngay lập tức mà không giữ socket connection.
  - **Xả hàng đợi tự động tức thì ($t=0ms$)**: Tại mọi điểm chuyển trạng thái rảnh (`updateOrchStateSafe` về `idle`, `drainDispatchState`, worker kết thúc turn, `deliverTalk`), server tự động gọi `processNextBackendUserQueue` bằng `setImmediate()`, đưa prompt tiếp theo vào `dispatchUserChat` ngay lập tức mà không cần phụ thuộc vào trình duyệt hay vòng lặp mạng.
- **Client Streamline Queue (`web/src/App.tsx`)**:
  - Gỡ bỏ hoàn toàn logic chặn gửi tin từ React state (`isTargetBusy`, `hasPendingQueue`, `inflightTargetRef`) và vòng lặp `useEffect` auto-drain thủ công.
  - Cho phép người dùng gửi tin nhắn liên tiếp dồn dập, tự động gán cờ `isQueued: true` và huy hiệu `[QUEUED]` trực quan trên giao diện khi nhận phản hồi từ server.
- **Triệt Tiêu Duplicate Directive Card (`web/src/components/ChatPanel.tsx`)**:
  - Đối chiếu tin nhắn canonical với danh sách tin nhắn độc lập đã có.
  - Khi đã có Directive Card độc lập sinh ra từ scanner realtime ($t=0s$), tin nhắn canonical tự động được gọt sạch 100% các khối thẻ `<talk>...</talk>` (`stripTalkTags`), đảm bảo chỉ hiển thị đúng 1 Directive Card duy nhất kèm bubble phân tích của Orchestrator.
- **Khắc Phục Rò Rỉ Tin Nhắn Sub-Orchestrator (`web/src/App.tsx`)**:
  - Gán `teamId` chính xác cho tin nhắn người dùng và gửi kèm trong payload `/api/chat`.
  - Tách riêng luồng lọc tin cho Sub-Orchestrator (`selectedAgentId !== 'orchestrator'`), loại bỏ toàn bộ fallback trùng lặp với `orchestrator` gốc.
- **Sửa Lỗi Nút Gửi Ngay (Force-Send) (`src/server.ts`)**:
  - Thêm khoảng nghỉ an toàn 350ms sau `client.abort()` để Windows giải phóng sạch tiến trình con và file lock của SQLite.
  - Bọc bộ lọc nuốt ngoại lệ `Agent operation aborted by user.`, chấm dứt hiện tượng hiện bong bóng lỗi đỏ giả khi người dùng chủ động bấm Gửi ngay.

## v7.0.16 (2026-09-04)

### Khắc Phục Triệt Để Sự Cố Ngâm Tin Nhắn, Câm Phản Hồi & Mất Tin Khi Focus Tab — Triển Khai Tính Năng Nút Gửi Ngay (Interrupt & Force Dispatch) & Timeline Tuyệt Đối
- **Triển Khai Hoàn Tất Tính Năng Nút "Gửi Ngay" (Interrupt & Force Dispatch)**:
  - **Backend (`src/server.ts`)**:
    + Thêm endpoint `POST /api/chat/force-send`: Tiếp nhận yêu cầu can thiệp từ người dùng với chế độ `'single'` (tin nhắn đơn lẻ) hoặc `'all'` (gộp toàn bộ hàng đợi).
    + Can thiệp ngắt tiến trình tức thì: Gọi `client.abort()` để tiêu diệt chính xác cây tiến trình PID cũ bằng `taskkill /pid [PID] /T /F` (Windows) hoặc `SIGKILL` (Linux/Mac).
    + Dọn dẹp dispatch buffers (`drainDispatchState`), đưa trạng thái sang `working`, phát thông báo hệ thống `⚡ Đã ngắt lượt trước của [Agent] theo lệnh "Gửi ngay" và bắt đầu thực thi ngay.`, lưu tin nhắn người dùng và trả HTTP JSON ngay lập tức.
    + Khởi chạy pipeline `dispatchUserChat` nền, thực thi prompt mới ngay lập tức mà không bị ngâm trong hàng đợi.
  - **Frontend (`web/src/App.tsx` & `web/src/components/ChatPanel.tsx`)**:
    + `web/src/App.tsx`: Triển khai 2 hàm callback `handleForceSendSingle` và `handleForceSendAll`, đồng bộ dọn sạch hàng đợi client và bắn payload tới `/api/chat/force-send`.
    + `web/src/components/ChatPanel.tsx`:
      * Nâng cấp Floating Queue Bar với nút nổi bật: **"⚡ Gửi ngay toàn bộ (Ngắt lượt cũ)"**.
      * Thêm nút **"⚡ Gửi ngay"** bên cạnh từng tin nhắn trong danh sách hàng đợi nổi.
      * Hiển thị badge trạng thái **`⏳ Đang trong hàng đợi`** kèm nút **"⚡ Gửi ngay"** trực tiếp trên header bubble tin nhắn chính (`MessageItem`) đang chờ xử lý.
- **Khắc Phục Lỗi Ngâm Tin Nhắn User & Orchestrator Thứ 2 Không Xuất Tin Ngay**:
  - **Nguyên nhân gốc rễ**: Tại `src/server.ts` (dòng 4800–4831), khi agent/Orchestrator đang bận (`client.isBusy() === true`), hàm `dispatchUserChat` kích hoạt nhánh `client.injectPromptAsync(finalPrompt)`. Nhánh này spawn một subprocess detached nạp ngầm prompt vào session database của OpenCode và lập tức trả về `{ response: '' }` (rỗng). Hệ quả: không có event stream, không có bubble trả lời ra UI, và trạng thái agent bị khóa ở `'working'`. Phía Web UI (`web/src/App.tsx`) thấy Orchestrator `working` liền giam lỏng toàn bộ các tin nhắn tiếp theo của User vào `agentQueues`, gây hiện tượng ngâm tin nhắn vĩnh viễn.
  - **Giải pháp**: Gỡ bỏ hoàn toàn nhánh `injectPromptAsync` trong `dispatchUserChat`. Toàn bộ các lượt chat từ người dùng giờ đây đi thẳng vào `client.enqueue(finalPrompt)`, được đưa vào FIFO queue chuẩn của `ACPClient`. Mỗi lượt đều được mở luồng stream realtime, sinh câu trả lời đầy đủ ra UI và giải phóng trạng thái về `idle` an toàn sau khi hoàn tất.
- **Khắc Phục Lỗi Mất Tích Tin Nhắn Khi Ra Ngoài Vào Lại (Focus Window Drop Message)**:
  - **Nguyên nhân gốc rễ**: Khi User chuyển cửa sổ hoặc đổi tab rồi quay lại, sự kiện `window.addEventListener('focus')` kích hoạt `fetchHistory()` kéo dữ liệu từ SQLite DB về. Trong `web/src/App.tsx` (dòng 961–968), bộ lọc `applyOacDedup` chứa điều kiện: `if ((fullText !== undefined && trimmedContent === fullText) || (hasParts && fullText !== undefined)) { continue; }`. Nhánh `|| (hasParts && fullText !== undefined)` bị lỗi quét toàn cục theo `from`: chỉ cần trong lịch sử có 1 snapshot OpenCode cũ của Orchestrator, điều kiện này luôn là `true` cho toàn bộ các tin nhắn sau đó. Toàn bộ câu trả lời hoàn chỉnh kéo về từ DB bị vứt bỏ sạch khỏi UI!
  - **Giải pháp**: Xóa bỏ vĩnh viễn nhánh `|| (hasParts && fullText !== undefined)`. Chỉ dedup khi nội dung văn bản trùng khớp 100% với snapshot của chính nó (`trimmedContent === fullText`). Toàn bộ lịch sử từ database kéo về được bảo toàn nguyên vẹn 100%.
- **Nâng Cấp Hiển Thị Tức Thì 0ms (Optimistic UI)**:
  - Trong `sendMessage` (`web/src/App.tsx`), tin nhắn của người dùng luôn được đưa ngay vào `allMessages` ở $t=0ms$, loại bỏ hoàn toàn cảm giác bấm gửi bị đơ hoặc mất hút tin nhắn.
- **Tài Liệu Đặc Tả Kiến Trúc Mới**:
  - Soạn thảo và lưu trữ tài liệu đặc tả: `docs/live-stream-and-timeline-order-architecture.md` (4 Quy luật Bất biến cho Deterministic Causal Timeline & Zero-Delay Streaming: Bộ đếm đơn điệu `seq`, Turn-ID Binding, Neo timestamp khởi phát, Pipeline Zero-Delay).
  - Soạn thảo tài liệu thiết kế tính năng: `docs/force-send-and-queue-interrupt-specification.md` (Chuyển đổi hàm inject thành tính năng Nút Gửi Ngay can thiệp chủ động: Single Force Send ngắt lượt cũ và Batch Queue Flush gửi ngay toàn bộ hàng đợi).

---

## v7.0.14 (2026-09-04)

### Bản Phát Hành Standalone Binary v7.0.14 (Cục Bộ) — Hoàn Tất Khắc Phục Lỗi Font Chữ Monospace, Nuốt Thẻ TALK & Dedup Orchestrator
- **Khắc Phục Lỗi Nuốt Nội Dung Card Giao Việc Hiển Thị Cụt Lủn `{segConvText`**:
  - **Nguyên nhân gốc rễ**: Tại dòng 2302-2310 của `web/src/components/ChatPanel.tsx`, bộ bóc tách `talkTaskDesc` chạy regex `\b(?:message|msg|content)\s*=\s*([^\s>]+)` trên toàn bộ nội dung văn bản unboxed `rawContentStr` mà không kiểm tra xem có thẻ mở `<talk>` hay không. Khi nội dung nhiệm vụ có chứa mã JSX/HTML (như `content={segConvText || segText}`), regex nuốt nhầm chuỗi `{segConvText` gán vào `mAttr`, biến `talkTaskDesc` thành `{segConvText` và vứt bỏ toàn bộ nội dung hướng dẫn chi tiết thực sự của task.
  - **Giải pháp**: Bổ sung cờ `hasTalkTag` và chỉ bóc tách thuộc tính bên trong phạm vi thẻ mở `<\s*talk\b([^>]*)>`. Nếu là văn bản unboxed thuần túy không có thẻ `<talk>`, bảo toàn nguyên vẹn 100% `msg.content`.
- **Khắc Phục Lỗi Lệch Font Chữ & Text Thô (Monospace Thay Vì Markdown)**:
  - **Nguyên nhân**: Trong `web/src/components/ChatPanel.tsx` (dòng 2806-2826, 2865-2866, 3014-3049), khi tin nhắn mang cờ `isOpenCode` (`msgType === 'opencode'`), giao diện bị ép cứng thuộc tính `fontFamily: 'monospace'` và đưa text vào thẻ `<div>` thô, bỏ qua bộ phân tích `<MarkdownRenderer />`. Khiến tin nhắn phản hồi của Orchestrator bị biến thành font máy đánh chữ monospace, mất định dạng tiêu đề, danh sách và tương phản hoàn toàn với tin nhắn thông thường.
  - **Giải pháp**:
    + Chuyển đổi toàn bộ style bong bóng từ `fontFamily: isOpenCode ? 'monospace' : 'inherit'` thành `fontFamily: 'inherit'` và `whiteSpace: 'normal'`.
    + Đưa toàn bộ nội dung văn bản (`segText`, `segConvText`, `body`, `conversationText`) qua `<MarkdownRenderer />` bất kể tin nhắn là `opencode` hay `chat`.
- **Khắc Phục Lỗi Nhân Đôi Bong Bóng Orchestrator Realtime (Stream Bubble Trùng Canonical)**:
  - **Nguyên nhân**: `web/src/App.tsx` xóa sớm `streamRef.current['orchestrator']` trong `handleSend` và loại trừ Orchestrator trong `applyOacDedup` (`m.from !== 'orchestrator'`), dẫn đến khi tin canonical từ server đến, bubble tạm thời `stream-orchestrator-*` không được thay thế in-place hoặc gộp sạch.
  - **Giải pháp**: Giữ nguyên neo tham chiếu stream, thay thế trực tiếp bubble tạm bằng tin canonical và hoàn thiện dedup time-bucket 5s trong `applyOacDedup`.
- **Đóng Gói Node SEA Standalone Binary v7.0.14**:
  - Tạo file nhị phân `release/agentforge-web.exe` và `release/agentforge-web-v7.0.14.exe` (106,009,600 bytes) nhúng toàn bộ production bundle Vite (`web/dist`).
- **Tuân Thủ Quy Tắc An Toàn**: Toàn bộ thao tác đóng gói và vận hành thực hiện cục bộ, tuyệt đối không tự ý `git push`.
- **Tài liệu đặc tả**: Lưu trữ chi tiết tại `docs/ui-font-rendering-and-dedup-fix.md`.

---

## v7.0.12 (2026-09-04)

### Bản Phát Hành Standalone Binary v7.0.12 (Cục Bộ) — Hoàn Tất Khắc Phục Nhân Đôi ToolCall Realtime
- **Nâng Cấp Phiên Bản Hệ Thống lên v7.0.12**:
  - Đồng bộ số hiệu phiên bản `7.0.12` tại `package.json`, `web/package.json` và hằng số `APP_VERSION = '7.0.12'` trong `src/server.ts`.
- **Khắc Phục Lỗi Nhân Đôi ToolCall Realtime (4 ToolCall Khi Chạy, Quay Lại Còn 2)**:
  - **Phía Backend (`src/server.ts`)**:
    + Trích xuất `callId` từ các thuộc tính `callID`/`call_id`/`id` trong event part/state và gắn vào `toolCalls` và `parts`.
    + Khử trùng lặp và cập nhật in-place theo `callId` (kèm fallback theo tên tool đang chờ output) ngay trong vòng lặp sự kiện `broadcastOACEvent`, triệt tiêu việc sinh thêm entry thừa khi nhận sự kiện `tool_result`.
    + Gộp tích luỹ `toolCalls` và `parts` theo `callId` trong snapshot OpenCode `mergedMsg` thay vì ghi đè mất các toolcall từ batch trước.
  - **Phía Frontend (`web/src/App.tsx`)**:
    + Nâng cấp handler `chat:tool_call`: So khớp `callId` hoặc `toolName && !x.output && output` để cập nhật in-place `input` và `output` cho cả `toolCalls` và `parts` của tin nhắn stream.
    + Cập nhật in-place khi nhận snapshot `chat:message` thay vì nối mảng đơn thuần.
- **Đóng Gói Node SEA Standalone Binary v7.0.12**:
  - Tạo file nhị phân `release/agentforge-web.exe` và `release/agentforge-web-v7.0.12.exe` (106,009,600 bytes) nhúng toàn bộ production bundle Vite (`web/dist`).
  - Khởi chạy và vận hành trực tiếp binary `release/agentforge-web-v7.0.12.exe` trên cổng 4001.
- **Tuân Thủ Quy Tắc An Toàn**: Toàn bộ thao tác đóng gói và vận hành thực hiện cục bộ, tuyệt đối không tự ý `git push`.

---

## v7.0.10 (2026-09-04)

### Bản Phát Hành Standalone Binary v7.0.10 (Cục Bộ) & Tích Hợp Toàn Diện Bản Vá Card Giao Việc TALK & Deduplicate ToolCalls
- **Khắc Phục Lỗi Nhân Đôi ToolCall Realtime (4 ToolCall Khi Chạy, Quay Lại Còn 2)**:
  - **Nguyên nhân gốc rễ**: Khi OpenCode thực thi công cụ, nó phát ra 2 sự kiện: `tool_use` (bắt đầu, chỉ có input) và `tool_result` (kết thúc, có output). Backend `broadcastOACEvent` trước đây bắt cả 2 sự kiện và đẩy riêng rẽ vào mảng `toolCalls` cũng như broadcast WebSocket `chat:tool_call`. Frontend `App.tsx` trước đây chỉ thực hiện append mà không kiểm tra trùng lặp, khiến 2 toolcall thực tế bị nhân đôi thành 4 thẻ trên UI. Khi chuyển tab và quay lại, `fetchHistory` kéo canonical history từ database (nơi chỉ ghi nhận 2 toolcall hoàn thành thực tế) nên chỉ còn hiển thị 2.
  - **Khắc phục ở Backend (`src/server.ts`)**:
    + Trích xuất `callId` từ các thuộc tính `callID`/`call_id`/`id` trong event part/state và gắn vào `toolCalls` và `parts`.
    + Khử trùng lặp và cập nhật in-place theo `callId` (hoặc fallback so khớp tên tool đang chờ output) ngay trong vòng lặp sự kiện `broadcastOACEvent`, không tạo thêm entry thừa khi nhận sự kiện `tool_result`.
    + Gộp tích luỹ `toolCalls` và `parts` theo `callId` trong snapshot OpenCode `mergedMsg` thay vì ghi đè mất các toolcall từ batch trước.
  - **Khắc phục ở Frontend (`web/src/App.tsx`)**:
    + Nâng cấp handler `chat:tool_call`: So khớp `callId` hoặc `toolName && !x.output && output` để cập nhật in-place `input` và `output` cho cả `toolCalls` và `parts` của tin nhắn stream.
    + Cập nhật in-place khi nhận snapshot `chat:message` thay vì nối mảng đơn thuần.
- **Nâng Cấp Phiên Bản Hệ Thống lên v7.0.10**:
  - Đồng bộ số hiệu phiên bản `7.0.10` tại `package.json`, `web/package.json` và hằng số `APP_VERSION = '7.0.10'` trong `src/server.ts`.
- **Tích Hợp Toàn Bộ Bản Vá Frontend Mới Nhất Vào SEA Binary**:
  - Khắc phục triệt để lỗi mất nội dung trong Card Giao Việc (TALK) trên cả Main view và Agent view với bộ bóc tách `talkTaskDesc` 4 tầng đa định dạng (Bracket, XML, Self-closing `<talk ... />` và unboxed raw payload từ server).
  - Khử trùng lặp tiêu đề task giữa Header và Body của Card Giao Việc.
  - Quét tự động thuộc tính `task` từ XML vào `rawTaskStr` và bảo vệ thẻ hiển thị an toàn qua các guards `hasBubbleContent`, `hasAnyText`.
  - Tích hợp bản vá gõ tiếng Việt Unikey/EVKey không mất ký tự đầu dòng và mô hình căn lề 2 chiều Chỉ Đạo (Phải) ⇄ Báo Cáo (Trái).
- **Đóng Gói Binary Node SEA Standalone**:
  - Đóng gói file nhị phân `release/agentforge-web.exe` và `release/agentforge-web-v7.0.10.exe` nhúng toàn bộ web production bundle.
- **Khởi Chạy Tiến Trình v7.0.10 Mới**:
  - Giải phóng cổng 4001 từ các tiến trình cũ và khởi chạy trực tiếp bản phát hành độc lập `release/agentforge-web-v7.0.10.exe`.
- **Tuân Thủ Quy Tắc An Toàn**: Toàn bộ thao tác đóng gói và vận hành thực hiện cục bộ, tuyệt đối không tự ý `git push`.

---

## v7.0.8 (2026-09-04)

### Bản Vá Khẩn Cấp UI Runtime Crash, Căn Lề Hai Chiều Cân Bằng & Khắc Phục Mất Thẻ Chỉ Đạo (Talk & Spawn)
- **Khắc phục lỗi runtime `ReferenceError: isDirectDirective is not defined`**:
  - Khai báo rõ ràng biến `isDirectDirective` trong phạm vi component `MessageItem` (`web/src/components/ChatPanel.tsx`):
    `const isDirectDirective = Boolean((msg as any).isDirective || msg.msgType === 'talk' || hasDirectiveInContent);`
  - Triệt tiêu hoàn toàn lỗi crash trình duyệt `UI Error Encountered` khi render bong bóng chat chỉ thị và giao việc.
- **Khắc Phục Lỗi Mất Nội Dung Trong Card Giao Việc (Thẻ TALK) Trên Web UI**:
  - **Nguyên nhân gốc rễ**: Các hàm `stripTalkTags`, `splitReportAndConversation` và regex làm sạch trong `web/src/components/ChatPanel.tsx` chạy các biểu thức chính quy nuốt trọn cả cặp thẻ `<talk>...</talk>` và `[TALK ...]`, khiến `body` và `conversationText` bị làm rỗng hoàn toàn trước khi đưa vào render Card Giao Việc. Ngoài ra, trường hợp backend gửi unboxed plain-text payload (`msg.content` chứa message và `msg.task` chứa task title) bị fallback gán nhầm bằng tiêu đề ngắn, làm mất toàn bộ nội dung hướng dẫn chi tiết.
  - **Cơ chế bóc tách `talkTaskDesc` đa định dạng**:
    + Bóc tách sớm trước các bước strip regex từ `rawContentStr`: hỗ trợ định dạng Bracket `[TALK target=... task=... message=...]`, thẻ XML `<talk target="..." task="...">body</talk>` và cả thẻ tự đóng `<talk ... message="..." />`.
    + Bảo toàn trọn vẹn văn bản unboxed từ server payload (`msg.content`) khi không chứa các tag bao quanh, không để bị ghi đè bởi tiêu đề task ngắn.
    + Khử trùng lặp tiêu đề: Header card hiển thị `cleanTaskTitle`, phần body hiển thị chi tiết nội dung nhiệm vụ (`talkTaskDesc`).
    + Bổ sung trích xuất `rawTaskStr` từ thuộc tính `task="..."` trong `msg.content` và cập nhật guard `hasBubbleContent` / `hasAnyText`.
  - **Kiểm chứng thực nghiệm**: Typecheck `npx tsc --noEmit` đạt 0 lỗi; biên dịch production bundle Vite trong `web/` thành công 100% (`dist/assets/index-peKzIQxs.js`).
- **Hoàn Thiện Mô Hình Căn Lề Hai Chiều Cân Bằng (Balanced Two-Way Alignment)**:
  - Khắc phục lỗi 100% tin nhắn bị dồn sang bên phải do gộp nhầm cờ `isFromOrchestrator`.
  - Phân tách mạch lạc:
    + **Bên PHẢI**: Tin nhắn User ra lệnh (`isUser`) + Thẻ Chỉ Đạo / Giao Việc / Spawn từ Orchestrator gửi Worker (`isDirectiveToWorker`).
    + **Bên TRÁI**: Câu trả lời của Orchestrator gửi User + Toàn bộ tin nhắn Báo Cáo từ Worker gửi về Orchestrator + Khối công cụ ToolCalls tra cứu + Khối Thinking.
  - Trên Agent View: Lệnh nhận vào từ Orchestrator căn Phải; Tiến trình thực thi của worker căn Trái.
- **Khắc Phục Triệt Để Lỗi Mất Tin Nhắn Chỉ Đạo (Talk & Spawn) Trên UI**:
  - **Bảo vệ luồng WebSocket trong `web/src/App.tsx`**: Nhận diện `isDirectiveMessage`, ngăn không cho tin nhắn directive (talk / spawn / task) bị gộp nhầm vào `streamRef` của caller (trước đây bị ngộ nhận là bản chốt sổ stream, nuốt chửng tin nhắn). Mọi directive message được append độc lập vào `allMessages` để tạo Workflow Card Giao Việc riêng biệt.
  - **Dual-Matching ID & Name trong Agent View (`web/src/App.tsx`)**: Mở rộng bộ lọc tin nhắn theo cả `sel.id` và `sel.name`, bảo đảm tab của Agent hiển thị đầy đủ tin nhắn giao việc dù Orchestrator gửi đích danh theo ID hay Name.
  - **Chống nuốt thẻ giao việc trong `web/src/components/ChatPanel.tsx`**:
    + Nâng cấp `hasBubbleContent`: `(!!body && String(body).trim().length > 0) || isOrchestratorTask || (!!conversationText && conversationText.trim().length > 0);`
    + Đưa `isOrchestratorTask` trực tiếp vào điều kiện render Khối 3 Bubble, đảm bảo thẻ Giao Việc không bao giờ bị bỏ qua khi `body` đã được làm sạch.
    + Bổ sung bộ phân tích XML cho `<spawn>` trích xuất đầy đủ `role`, `name`, `task` và phần `body`.
- **Hoàn Nguyên Kho Lưu Trữ GitHub Public Về v7.0.6**:
  - Reset cứng `git reset --hard d9dc839` đưa nhánh `main` repo public `C:\Users\Hai Dang\agentforge\` về đúng bản v7.0.6.
  - Xóa tag `v7.0.8` ở local và remote GitHub public, force push đồng bộ chuẩn xác nguyên trạng v7.0.6.
- **Khắc Phục Lỗi Xung Đột Bộ Gõ IME Unikey / EVKey Trên Windows (Mất Ký Tự Đầu Dòng)**:
  - Chuyển đổi `<textarea>` trong `web/src/components/ChatPanel.tsx` từ controlled (`value={input}`) sang uncontrolled component với `ref={textareaRef}` và `defaultValue=""`.
  - Loại bỏ hoàn toàn sự can thiệp của React VDOM state batching vào sự kiện `VK_BACK` của Unikey/EVKey, giúp gõ mượt mà các ký tự viết hoa có dấu đầu dòng (như "À", "Ý", "Ô", "Ă").
  - Tích hợp chuẩn hóa Unicode NFC tại `handleSend` (`ChatPanel.tsx`) cùng hai hàm gửi tin `sendMessage` và `sendQueuedMessage` (`App.tsx`), đảm bảo dữ liệu gửi lên backend luôn là dạng dựng sẵn tiêu chuẩn.
- **Bản Vá Cơ Chế Relay Báo Lỗi Lệnh & Tự Động Kích Hoạt Turn Mới (Zero Dead-Lock Relay)**:
  - Bổ sung hàm `relayErrorToIssuer` (`src/server.ts`) chuyển tiếp toàn bộ các lỗi thực thi lệnh (`SPAWN_ROLE_LIMIT`, `SPAWN_PARSE_FAIL`, `TASK_BARRIER_VIOLATION`, `CREATE_ROLE_LIMIT`) về chính xác thực thể phát lệnh (`issuerId`).
  - Cung cấp ngữ cảnh lỗi trực quan: vị trí file phát hiện, snippet lệnh, lý do từ chối, thống kê chi tiết danh sách agent trong team theo hai nhóm `[IDLE]` (sẵn sàng tái sử dụng) và `[WORKING]`, kèm gợi ý cú pháp `<talk target="...">` cụ thể.
  - Tự động gọi `triggerOrchestrator` (nếu issuer là Orchestrator) hoặc `deliverTalk` (nếu issuer là Worker), giúp kích hoạt lượt chat mới ngay lập tức để agent nhận lỗi và tự giác điều chỉnh mà không bị kẹt im lặng trong hàng đợi unread.
  - Tạm thời vô hiệu hóa cơ chế Outbox Retry (`DISABLE_OUTBOX_RETRY = true`) theo yêu cầu người dùng để triệt tiêu hiện tượng trùng lặp tin nhắn Main Orchestrator.
- **Bổ Sung Tài Liệu Toàn Diện API Endpoints & Cơ Chế Khởi Động Lại (/restart)**:
  - Tạo tài liệu đặc tả chi tiết [`docs/API_ENDPOINTS.md`](docs/API_ENDPOINTS.md) bao quát toàn bộ các HTTP REST endpoints:
    + Điều khiển vòng đời máy chủ: `POST /api/restart` (spawn detached tiến trình con, gọi `start.bat`/`npm start` và giải phóng socket tự động sau 500ms) và lệnh Slash Command `/restart` trực tiếp trong chat.
    + Nhóm API Chat & Lịch sử: `POST /api/chat` (kèm slash command `/restart`, `/compact`, chuẩn hóa NFC), `GET /api/history`, `GET /api/messages`.
    + Nhóm API Quản lý Vòng đời Agent: `GET /api/agents`, `POST /api/agents`, `:id/start`, `:id/stop`, `:id/resume`, `:id/abort`, `DELETE :id`, `PATCH :id`, `POST :id/model`, `:id/clear`, `orchestrator/clear`.
    + Nhóm Giám sát & Logs: `GET /logs` (Ring buffer 2000 dòng), `GET /terminal` (Web Terminal UI realtime qua SSE), `GET /api/events` (SSE streaming chunks, thinking, tool_calls).
  - Cập nhật tài liệu kiến trúc tổng thể [`ARCHITECTURE.md`](ARCHITECTURE.md) bổ sung Mục 7 đặc tả hệ thống REST Endpoints & Lifecycle Control.
- **Biên dịch & Kiểm chứng**:
  - `npx tsc --noEmit` đạt 0 lỗi.
  - Build production bundle `dist/assets/index-CfeO2yBn.js` (309.48 kB).
- **Đóng gói Binary SEA v7.0.8 Cục Bộ (Local Only)**:
  - Phát hành bản nhị phân standalone `release/agentforge-web-v7.0.8.exe` và `release/agentforge-web.exe` (106,002,944 bytes). Tuân thủ nguyên tắc không push GitHub khi chưa có lệnh.

---

## v7.0.6 (2026-09-04)

### Bản Phát Hành Đóng Gói Nhị Phân Binary Standalone Release v7.0.6
- **Cập nhật Version v7.0.6**: Đồng bộ toàn bộ phiên bản trong `package.json`, `web/package.json` và hằng số `APP_VERSION` trong `src/server.ts` lên `7.0.6`.
- **Hàng Rào Task Barrier Backend (`task` <= 25 từ)**:
  - Tích hợp đồng bộ trên `src/server.ts`, `src/parser/command-parser.ts`, `src/core/command-parser.ts`.
  - Tự động chặn và từ chối các lệnh `<talk>` / `<spawn>` có thuộc tính `task="..."` dài hơn 25 từ, gửi phản hồi `TASK_BARRIER_VIOLATION` (`[BARRIER REJECT]`) về cho Orchestrator, ép buộc đưa mô tả chi tiết vào thẻ body.
- **Frontend Stream-First Finalization & Thứ Tự Bubble (`web/src/App.tsx`)**:
  - Triển khai cập nhật in-place trực tiếp tại chỗ cho bản stream khi nhận canonical final message, loại bỏ hoàn toàn cơ chế xoá bằng `filter` giúp triệt tiêu hiện tượng giật màn hình (flicker).
  - Bảo toàn 100% mảng `parts` xen kẽ (`thinking`, `tool`, `text`) theo đúng thứ tự emit thực tế từ OpenCode.
  - Sửa dứt điểm lỗi bubble User bị tụt xuống dưới ToolCall bằng cách reset stream ref, chuẩn hoá văn bản và so khớp chính xác `tempIdx` ở đỉnh lượt chat.
- **Mô Hình Đối Thoại Hai Chiều & Tối Ưu Độ Rộng ToolCall (`web/src/components/ChatPanel.tsx`)**:
  - Main Orchestrator View: Luồng Chỉ Đạo (User, Orchestrator directives, Orchestrator replies) căn Phải; Luồng Báo Cáo (Worker chat, `ReportCard`, ToolCalls tra cứu) căn Trái. Ẩn toàn bộ toolcalls nội bộ của worker trên màn hình Main.
  - Agent View: Luồng incoming directives căn Phải; Tiến trình thực thi của worker (thinking, toolcalls, terminal, code diff) căn Trái.
  - Kích thước ToolCall: Căn trái, `minWidth: 480px`, `maxWidth: 85%`, chừa 15% khoảng trống với lề phải.
- **Tối Ưu Độ Tương Phản Tên Agent Trên Nền Sáng (Light Theme Contrast)**:
  - Bổ sung CSS tokens và class chuyên biệt (`.af-sender-pill`, `.af-receiver-pill`, `.af-tab-name`, `.af-card-agent-name`, `.af-directive-header-orch`, `.af-directive-header-target`, `.af-spawn-target-name`).
  - Đổi màu tên tất cả Agent sang font màu tối sẫm (`#0f172a`, `#1e293b`, `#1e3a8a`), độ đậm `font-weight: 700`, triệt tiêu hoàn toàn tình trạng chữ trắng hoặc màu pastel nhạt trên nền sáng trong ChatPanel, Dashboard và TabBar.
- **Dọn Dẹp & Đồng Bộ Repo Public (`C:\Users\Hai Dang\agentforge\`)**:
  - Loại bỏ toàn bộ file markdown ngoài luồng, file log, database và file test tạm, chỉ giữ lại mã nguồn sạch và thư mục `release/` chứa standalone binary `agentforge-web.exe`.
  - Đã commit và push đồng bộ lên cả hai remote repository Private (`9b69585`) và Public (`d9dc839`).
- **Packaging Binary SEA v7.0.6**:
  - Đóng gói và phát hành thành công binary standalone `release/agentforge-web-v7.0.6.exe` và `release/agentforge-web.exe` (105,998,848 bytes).

---

## v7.0.4 (2026-09-04)

### Khắc Phục Lỗi Gộp Bubble Giao Việc & Hoàn Thiện Tách Riêng Directive Card Trên UI Main
- **Backend Parser (`src/server.ts`, `src/parser/command-parser.ts`, `src/core/command-parser.ts`)**:
  - **Sửa dứt điểm lỗi nuốt text trong `getCodeSpanRanges`**: Xóa bỏ hoàn toàn cơ chế fallback gán `endIdx = text.length` khi thẻ `=== TASK REPORT ===` hoặc `<report>` thiếu thẻ đóng `=== END REPORT ===` / `</report>`.
  - **Ngăn chặn triệt để vô hiệu hóa tag điều phối**: Khi người dùng hoặc agent đề cập đến tên report trong câu đàm thoại, parser không còn nuốt toàn bộ phần còn lại của tin nhắn vào code span được bảo vệ, giúp `extractDualCommands` và `stripCommandTags` quét và tách sạch 100% các lệnh `<talk>` và `<spawn>` phía sau.
  - **Tách tin giao việc thành bubble riêng biệt**: Đảm bảo toàn bộ lệnh điều phối phát sinh từ Orchestrator được dispatch qua `deliverTalk` và lưu thành `ChatMsg` riêng (`msgType: 'talk'`), loại bỏ triệt để hiện tượng lệnh giao việc bị dính chùm vào bubble đàm thoại chính gửi User.

- **Frontend Chat UI (`web/src/components/ChatPanel.tsx`, `web/src/App.tsx`)**:
  - **Làm sạch tag điều phối ở mọi tầng (Multi-layer sanitization)**: Bổ sung bộ lọc `stripTalkTags` trực tiếp vào từng text segment trong Khối 2.5 (`hasParts` interleaved streaming), ngăn chặn hoàn toàn tag `<talk>` / `<spawn>` thô hiển thị trong bong bóng live stream.
  - **Nâng cấp bộ lọc Regex toàn diện**: Mở rộng regex trong `stripTalkTags` để nhận diện và gọt sạch cả các biến thể command block đa dòng, self-closing tag và các thẻ unclosed còn sót lại trên giao diện.
  - **Tương thích Sub-Orchestrator toàn diện**: Mở rộng `isOrchView` và `isAlignRight` để nhận diện tất cả Sub-Orchestrator theo `role` hoặc `type`, hỗ trợ tên động `👑 {srcAgent?.name}` trên header Card Giao Việc.
  - **Mở khóa hiển thị `ReportCard` cho `isOpenCode`**: Bóc tách chính xác báo cáo task ngay cả khi có tiền tố `Task complete. === TASK REPORT ===` và render component `ReportCard` trực quan thay vì in text monospace thô.

- **Packaging Binary SEA**:
  - Đóng gói và phát hành thành công binary executable độc lập `release/agentforge-web-v7.0.4.exe` và `release/agentforge-web.exe` đi kèm production frontend bundle sạch (`dist/assets/index-Lvp4n13Q.js` 307.49 kB).

---

## v7.0.1 (2026-09-03)

### Tối Ưu Hóa & Vá Dứt Điểm Hiển Thị Directives và Packaging
- **web/src/App.tsx**:
  - Bảo vệ 100% tin giao việc (`isDirective`, `isDirectiveMsg`): Không bao giờ bị lọc mất bởi `isInternalMsg` hoặc bị nuốt bởi logic deduplication `applyOacDedup`.
  - Tách biệt hiển thị: Ẩn toàn bộ `ToolCallBlock` của worker trên màn hình Main Orchestrator, giữ màn hình sạch sẽ.
- **web/src/components/ChatPanel.tsx**:
  - Căn phải linh hoạt cho các tin nhắn giao việc và báo cáo gửi về Orchestrator.
  - Sửa dứt điểm hàm `stripTalkTags()` bằng cơ chế unwrap regex `$1`, bảo tồn trọn vẹn nội dung payload tin nhắn.
  - Đồng bộ tone màu Dark Slate / Deep Midnight Blue sang trọng.
- **src/agents/acp-client.ts**:
  - Chuyển đổi sang Zero-latency immediate streaming: Bỏ timer trễ 250ms, phát trực tiếp tức thì từng JSON event sang WebSocket broadcast cho UI lively realtime.
- **Tài liệu hóa**:
  - Bổ sung sơ đồ cây thư mục chi tiết vào `ARCHITECTURE.md` và `docs/ARCHITECTURE.md`.
- **Packaging SEA Binary**:
  - Đóng gói thành công bản phát hành nhị phân độc lập `release/agentforge-web.exe` và `release/agentforge-web-v7.0.1.exe` (105,996,800 bytes) nhúng kèm 27 static assets.

---

## v7.0.0 (2026-09-03)

### Kiến Trúc Backend Hạt Mịn (Granular Micro-Modules) & Tách Nhóm Độc Lập
- **src/storage/**: Tách nhỏ toàn bộ hệ thống lưu trữ phân tán theo từng domain:
  - `types.ts`, `constants.ts`, `paths.ts`, `file-utils.ts`, `atomic-disk.ts`: Cung cấp tầng I/O an toàn ghi đĩa nguyên tử (atomic write).
  - `message-storage.ts`, `chat-store.ts`: Lưu trữ lịch sử tin nhắn tách biệt theo `teamId`, hỗ trợ định tuyến 3 chiều (User ↔ Orchestrator ↔ Members).
  - `queue-storage.ts`, `outbox-store.ts`, `chat-queue-store.ts`: Quản lý hàng đợi tin nhắn và cơ chế outbox retry với timeout tự phục hồi 30 giây (`OUTBOX_IN_FLIGHT_TIMEOUT_MS = 30000`).
  - `agent-store.ts`, `logs-store.ts`, `settings-store.ts`, `state-loader.ts`, `persistence-scheduler.ts`, `team-resolver.ts`: Quản lý state agent, cấu hình hệ thống và tự động lưu nền.
- **src/relay/**: Phân rã hệ thống relay tin nhắn thành 11 module chuyên trách:
  - `router.ts`, `team-router.ts`: Điều hướng tin nhắn User ↔ Orchestrator ↔ Agent theo ngữ cảnh team.
  - `outbox-engine.ts`, `outbox-dispatcher.ts`: Vòng lặp quét outbox, thực hiện retry exponential backoff và giải phóng tin nhắn `in_flight` bị kẹt.
  - `dedup.ts`, `broadcast-bus.ts`, `report-parser.ts`, `stream-scanner.ts`, `orchestrator-queue.ts`.
- **src/routes/** & **src/ws/**: Tách nhỏ REST routes (`system.ts`, `settings.ts`, `models.ts`, `terminal.ts`, `agents.ts`, `chat.ts`) và WebSocket service (`ws-service.ts`), tinh gọn `src/server.ts` đóng vai trò bootstrap sạch sẽ.

### Trải Nghiệm Giao Diện Người Dùng (Modern High-Tech Chat UI) (FIXED ✅)
- **web/src/components/ChatPanel.tsx**:
  - **Bóc tách triệt để tag thô**: Tách hoàn toàn các chuỗi lệnh `<talk>`, `<spawn>`, `[SPAWN]`, `[TALK]` khỏi dòng văn bản thông thường, sử dụng cơ chế unwrap `$1` giữ lại 100% nội dung hội thoại, không còn lỗi nuốt nội dung thẻ.
  - **Card Giao Việc (Directive Card)**: Render thành thẻ chỉ thị chuyên biệt với icon 🎯, định tuyến rõ nét `👑 Orchestrator ➔ 🤖 Target Agent` kèm Role Badge (`coder`, `tester`, `verifier`...), tiêu đề nhiệm vụ `📌 Task Title` và phần body Markdown trực quan.
  - **Card Khởi Tạo (Spawn Card)**: Render thẻ tạo agent với icon 🚀, role badge và khung tóm tắt mô tả công việc trên nền gradient phát sáng nhẹ.
  - **Căn phải (Right-Aligned) tin nhắn chỉ thị**: Toàn bộ bubble lệnh điều phối do Orchestrator phát tới Worker agent được chuyển lề sang bên phải (`alignItems: 'flex-end'`, `flexDirection: 'row-reverse'`), đồng bộ chuẩn mực với các tin nhắn gửi đi (outgoing), tạo tương phản sắc nét với báo cáo từ Worker ở lề trái.
  - **Hiển thị danh tính thực tế**: Gỡ bỏ hoàn toàn nhãn "⚡ OpenCode" chung chung; tự động tra cứu và hiển thị danh tính thực tế của từng Agent (`coder-server`, `coder-relay`, `verifier-audit`...) kèm role badge hoặc `👑 Orchestrator`.
  - **Màu sắc Dark Slate / Deep Midnight Blue**: Chuyển toàn bộ nền bubble và `ReportCard` sang tone màu công nghệ cao (`rgba(30, 41, 59, 0.75)` -> `rgba(15, 23, 42, 0.75)`), loại bỏ triệt để nền xám đục cũ.
- **web/src/App.tsx**:
  - **Bảo vệ toàn diện Tin Giao Việc trên Main View**: Bổ sung cờ `isDirective` và `isDirectiveMsg` vào cả bộ lọc Main (`filteredMessages`) và hàm khử trùng lặp (`applyOacDedup`), loại bỏ hoàn toàn edge cases khiến tin giao việc bị nuốt chửng bởi snapshot OpenCode stream hoặc bị cờ `isInternalMsg` ẩn nhầm.
  - **Tách bạch ToolCall Worker khỏi Main**: Chỉ hiển thị `ToolCallBlock` khi đang xem tab chi tiết của Agent (`showToolBlocks = !!selectedAgentId`), giữ cho màn hình Main Orchestrator luôn tinh gọn, sạch sẽ.

---

## v6.32.1 (2026-09-03)

### Chống Sinh Phantom Orchestrator & Cách Ly Team Tuyệt Đối (Strict Isolation) (FIXED ✅)
- **src/server.ts**: Khi xảy ra lỗi `TALK_AGENT_NOT_FOUND`, hệ thống tự động sinh tin nhắn lỗi trực tiếp về `fromAgent` (với `msgType: 'error'`, lưu database và broadcast qua WebSocket), giúp agent nguồn nhận biết target sai ngay trên khung chat của mình thay vì chuyển tiếp âm thầm.
- **src/server.ts**: Chuẩn hóa hàm `findExistingOrchestrator(teamId)` — khi có `teamId` truyền vào, chỉ tìm kiếm duy nhất trong team đó và trả về `undefined` nếu không tìm thấy; tuyệt đối không tự ý fallback sang defaultOrch hoặc Orchestrator của team khác, ngăn chặn triệt để nguy cơ rò rỉ dữ liệu (data leak) giữa các team.
- **src/server.ts**: Loại bỏ triệt để việc tự động gán `agents.set(orchId, ...)` sinh instance ma `Orchestrator-${orchId.slice(-4)}` trong `processOrchestratorTriggerQueue`, `getOrchClient` và `dispatchUserChat`. Tái sử dụng Orchestrator hiện có của hệ thống/team, chấm dứt hoàn toàn hiện tượng sinh thêm Main 2 khi chat với Main 1.

## v6.32.0 (2026-09-03)

### Kiến trúc Đa Team & Tách biệt Hoạt động Độc lập (FIXED ✅)
- **src/server.ts**: Chuyển đổi hàng đợi tin nhắn chưa đọc `unreadForOrchestrator` từ mảng toàn cục sang `Map<string, ChatMsg[]>` tách biệt theo từng `orchId`/`teamId`.
- **src/server.ts**: Cập nhật hàm `forwardToOrchestrator` nhận `targetOrchId` và `teamId`, đảm bảo các thông báo hệ thống và lỗi runtime của agent được định tuyến chính xác về Orchestrator chỉ huy mà không rò rỉ chéo team.
- **src/server.ts**: Gán `teamId` trực tiếp cho mọi `userMsg` trong route `/api/chat`.
- **web/src/components/ChatPanel.tsx**: Chuẩn hóa nhận diện Orchestrator cho toàn bộ Sub-Orchestrators (màu sắc `#a5b4fc`, badge 'main', icon vương miện 👑, và thẻ Task Card khi giao nhiệm vụ).

### Bảo toàn Khối Suy luận (Thinking Parts) và Chống Nuốt Tin UI (FIXED ✅)
- **src/server.ts** (L1121 & L5186): Bổ sung `p.type === 'thinking'` vào bộ lọc parts của snapshot opencode và endpoint API history (`p.type === 'tool' || p.type === 'text' || p.type === 'thinking'`), giữ trọn vẹn suy luận reasoning của model sau khi restart/reconnect.
- **web/src/App.tsx**: Tinh chỉnh bộ lọc tin nhắn `filteredMessages`:
  - Giữ lại 100% tin nhắn User gửi vào Main / Sub-Orchestrator.
  - Khôi phục hiển thị các thẻ giao việc (`talk`/`spawn`) và báo cáo kết quả của Worker gửi về Orchestrator trên UI.
  - Tối ưu hóa hàm `applyOacDedup` khử trùng lặp theo `id` và content/timestamp key, loại bỏ triệt để hiện tượng tin nhắn lặp lại nhiều lần.

### Quản lý Vòng đời Tiến trình: Inlet Pipe & Chống Orphan Process (FIXED ✅)
- **src/agents/acp-client.ts**: Cấu hình `stdio: ['pipe', 'pipe', 'pipe']` khi spawn tiến trình con PowerShell/OpenCode. Khi Node.js tắt đột ngột, inlet pipe stdin bị đứt kết nối, tiến trình con tự động nhận tín hiệu và kết thúc sạch sẽ.
- Tích hợp theo dõi `ACPClient.activeChildPids` và kích hoạt `taskkill /pid ${pid} /T /F` (Windows) / `SIGKILL` (Linux) dọn dẹp triệt để cây tiến trình con trên hệ thống khi có tín hiệu exit/SIGINT/SIGTERM.

---

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
