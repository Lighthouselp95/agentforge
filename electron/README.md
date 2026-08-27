# AgentForge Desktop (Electron Portable)

## Mục tiêu
Đóng gói toàn bộ hệ thống AgentForge (Backend Express/WebSocket, Frontend React Slate Dark Mode, cơ sở dữ liệu JSON state và SSoT Agent Prompts) thành một ứng dụng Desktop chạy trên Windows. Người dùng chỉ cần nhấp đúp vào 1 file `.exe` duy nhất là toàn bộ server, giao diện và các AI Agent tự động khởi chạy đồng bộ mà không cần cài đặt Node.js hay môi trường phụ trợ.

## Kiến trúc
- **Main Process** (`electron/main.cjs`): Khởi chạy ngầm backend Express/WS (port 3001) thông qua `spawn('npx tsx src/server.ts')`, tạo cửa sổ `BrowserWindow` (1280x800, nền Slate-900 `#0f172a`), tự động load `dist/index.html` (production) hoặc dev server, và dọn dẹp tiến trình con khi đóng app (`before-quit`, `window-all-closed`).
- **Preload** (`electron/preload.cjs`): Context bridge an toàn cung cấp `electronAPI.getPort()` và `electronAPI.isElectron`.
- **Renderer**: Giao diện Web UI đã build sẵn trong `web/dist/`.
- **Backend**: `src/server.ts` (Express + WebSocket), `src/agents/acp-client.ts` (giao tiếp OpenCode CLI), `src/storage.ts` (JSON state tại `data/agentforge-state.json`).
- **Dữ liệu bền vững**: Khi chạy bản Portable, dữ liệu JSON state được trỏ sang `app.getPath('userData')` để không bị mất khi Windows dọn thư mục Temp giải nén.

## Cài đặt môi trường Dev
```bash
npm install
npm install -D electron electron-builder cross-env wait-on
npm run build
```

## Các lệnh chính
- `npm run dev` hoặc `npm run dev:watch`: Chạy server và web dev thông thường (không qua Electron).
- `npm run electron:dev`: Chạy ứng dụng Electron ở chế độ phát triển (tự động chờ backend sẵn sàng rồi mở cửa sổ Desktop).
- `npm run build:electron`: Biên dịch toàn bộ Frontend/Backend và đóng gói ra **1 file EXE Portable duy nhất** (`AgentForge-Portable.exe`).

## Đóng gói (Packaging)
Cấu hình nằm trong `package.json` (trường `"build"`):
- `appId`: `com.agentforge.app`
- `productName`: `AgentForge`
- `win.target`: `["portable"]`
- `portable.artifactName`: `AgentForge-Portable.exe`
- Output: thư mục `dist-electron/` (hoặc `release/` tùy cấu hình `directories.output`)

Lưu ý: OpenCode CLI phải có sẵn trong PATH (hoặc được bundle qua `extraResources` khi đóng gói máy khác).

## Lưu ý vận hành
- Bản Portable giải nén tạm vào `%TEMP%` mỗi lần chạy; dữ liệu state và lịch sử được lưu tại `userData` để duy trì qua các lần khởi động.
- Nếu chưa code-sign, Windows SmartScreen có thể hiện cảnh báo nhưng không chặn chạy.
- Khi thoát ứng dụng, tiến trình con backend và cổng 3001 được giải phóng tự động.

## Cấu trúc thư mục đóng gói (Bundled Layout)
Khi chạy `npm run build:electron`, `electron-builder` đóng gói các thành phần sau vào 1 file exe:
- `electron/main.cjs`, `electron/preload.cjs` — Main process & bridge.
- `web/dist/` — Frontend React đã build (Vite bundle).
- `src/prompts/` & `.opencode/agents/` — SSoT Agent Prompts (đồng bộ khi khởi động).
- `dist-electron/` — Backend đã biên dịch (nếu tách riêng) hoặc chạy qua `tsx` trong dev.
- `data/` — Chỉ là template; dữ liệu thực chạy được trỏ sang `userData`.

## Kiến thức vận hành & Bài học kỹ thuật (Operational Gotchas)
- **Điểm nghẽn OpenCode CLI**: Binary `opencode.exe` (Go binary) PHẢI được đóng gói kèm qua `extraResources` (cấu hình: `from: bin/opencode.exe` -> `to: opencode.exe`) và `src/agents/acp-client.ts` phải gọi đường dẫn tuyệt đối `path.join(process.resourcesPath,'opencode.exe')` thay vì依赖 PATH. Nếu thiếu, agent không chạy được trong bản portable.
- **Quản lý đường dẫn (Path Handling)**: `server.ts` và `storage.ts` phải thay `process.cwd()` bằng `appRoot` (cho prompts/agents) và `userData` (cho data JSON state) khi ở chế độ packaged. Lý do: portable giải nén vào `%TEMP%` mỗi lần chạy → data PHẢI nằm ở `userData` để lưu trữ lâu dài qua các lần khởi động.
- **asar & asarUnpack**: Nếu OpenCode cần đọc file prompts bằng path thật (không qua virtual fs), dùng `asarUnpack` cho thư mục `src/prompts` khi đóng gói.
- **Endpoint /restart trong portable**: Vô hiệu hóa `start.bat`, thay bằng `app.relaunch()` qua IPC (gửi sự kiện main process khởi động lại ứng dụng).
- **Build Script**: `npm run build:electron` = `npm run build && electron-builder --win portable`; artifact xuất ra `dist-electron/AgentForge-Portable.exe`.
- **Chưa code-sign**: SmartScreen có thể cảnh báo nhưng không chặn chạy; có thể bổ sung chứng chỉ số sau này để trải nghiệm mượt mà hơn.
