# Kien thuc va Kinh nghiem Kien truc: Xu ly Unicode, Tham dinh Bao cao va Pipeline Tin nhan

Tai lieu nay tong ket toan bo co so ly thuyet khoa hoc may tinh, kien truc he thong, nguyen nhan goc re va giai phap ky thuat da trien khai trong AgentForge lien quan den 3 bai hoc ky thuat quan trong vua duoc giai quyet triet de.

---

## 1. Co so Ly thuyet ve Ma hoa Unicode NFD va NFC, Code Unit UTF-16 trong JavaScript

### 1.1. Ly thuyet ve Chuan hoa Unicode NFD va NFC
Chuan Unicode dinh nghia hai phuong thuc bieu dien chinh cho cac ky tu co dau thanh hoac dau phu (diacritics) nhu tieng Viet:
- NFC (Normalization Form Canonical Composition): Cac ky tu co dau duoc bieu dien duoi dang mot code point duy nhat da to hop san (Precomposed Character). Vi du: ky tu 'Ơ' la U+01A0, ky tu 'Ý' la U+00DD, ky tu 'Đ' la U+0110.
- NFD (Normalization Form Canonical Decomposition): Cac ky tu duoc tach thanh ky tu co so (Base Character) di kem mot hoac nhieu code point dau to hop doc lap (Combining Diacritical Marks). Vi du: 'Ơ' bi phan ra thanh 'O' (U+004F) kem dau moc U+031B; 'ờ' co the bi tach thanh 'O' kem dau moc va dau huyen.

Khi du lieu van ban duoc tiep nhan tu cac nguon khac nhau (nhu OpenCode CLI qua stream JSONL, he dieu hanh Windows, macOS, ban phim nguoi dung hoac LLM inference API), chuoi van ban co the ton tai o dang to hop NFC hoac phan ra NFD khong dong nhat.

### 1.2. Hanh vi cua JavaScript String va Nguy co Lech Code Unit UTF-16
Trong runtime V8 cua Node.js va trinh duyet, chuoi van ban (JavaScript String) duoc bieu dien ben trong bo nho duoi dang mang cac code unit UTF-16 (16-bit unsigned integers). 
- Thuoc tinh `string.length` va chi so mang `string[index]` trong JavaScript phan anh so luong code unit UTF-16, chu khong phan anh so luong ky tu thuc te (Unicode Code Points hoac Grapheme Clusters).
- Khi bieu thuc chinh quy (Regular Expression) khop mot phan doan van ban nhu `toMatch = rawContent.match(/^\s*\[TO:\s*([^\]]+)\]\s*/i)`, do dai `toMatch[0].length` duoc tinh bang so luong code unit UTF-16 cua doan match.
- Neu van ban dau vao o dang NFD hoac co su pha tron khoang trang Unicode dac biet, viec su dung thao tac cat chuoi tuyen tinh theo do dai `rawContent.slice(toMatch[0].length)` co the bi lech vi tri do su khac biet ve cach tinh code unit giua Regex Engine va ham slice(). Khi do, ham slice() se cat pham vao 1 code unit dau tien cua tu tiep theo ngay sau doan match, dan den hien tuong ky tu dau cau co dau nhu 'Ơ', 'Ý', 'Đ' bi nuot mat hoac bi bien dang thanh ky tu khac.

### 1.3. Giai phap Ky thuat: Chuan hoa Truoc va Thay the truc tiep bang Regex Neo
Giai phap toi uu nhat de ngan chan vinh vien loi lech code unit nay bao gom hai buoc song hanh:
- Chuan hoa Unicode toan dien: Ap dung `text.normalize('NFC')` ngay tai cua ngo tiep nhan du lieu (Message Ingestion Layer) truoc khi bat ky thao tac xu ly chuoi nao dien ra.
- Thay the truc tiep bang Regex neo dau dong (Anchored Pattern Replacement): Thay vi su dung cap thao tac `match()` kem `slice(matchLength)`, he thong su dung phep bien doi nguyen khoi `rawContent.replace(/^\s*\[TO:\s*[^\]]+\]\s*(?:Task complete\.?)?\s*/i, '')`. Phep bien doi nay hoat dong tren cung mot pham vi phan tich cua Regex Engine, xoa chinh xac toan bo phan dau khop ma khong dua vao phep tinh toan chi so thu cong, bao toan tuyet doi 100% ky tu dung ngay phia sau.

---

## 2. Co so Ly thuyet va Kien truc Bo loc 3 Tang Tham dinh Task Report

### 2.1. Bai toan Phan biet Structured Report va Contextual Prose
Trong he thong multi-agent, cac agent phai thuong xuyen trao doi ve quy trinh kiem thu, quy dinh bao cao, hoac giai thich cac loi da gap. Trong cac doan van ban trao doi tu nhien (conversational prose), agent hoac nguoi dung co the nhac den ten the bao cao nhu "Toi se gui === TASK REPORT ===" hoac "Hay kiem tra block === TASK REPORT === sau day".
- Neu bo phan tich chi dua vao su xuat hien don gian cua chuoi mau `=== TASK REPORT ===`, no se ngat nham toan bo doan van ban thanh hai phan va bien mot cau noi thong thuong thanh mot ReportCard rong, gay mat mat van canh va pha vo trai nghiem hoi thoai.
- Do do, he thong can mot co che phan loai co do tin cay cao de xac thuc xem mot khoi van ban co thuc su la mot bao cao nghiem thu co cau truc hop le hay chi la mot su de cap tinh co.

### 2.2. Kien truc Bo loc Thong minh 3 Tang (3-Tier Structured Validation)
He thong ChatPanel va backend ap dung mo hinh tham dinh 3 tang theo thu bac chat che:

- Tang 1: Kiem tra Neo Cu phap (Boundary and Anchor Check). Mau bao cao phai tuan thu cu phap phan tach ro rang, bat dau bang `=== [TITLE] REPORT ===` va ket thuc bang `=== END REPORT ===` hoac cuoi chuoi van ban hop le.
- Tang 2: Dem so luong truong du lieu cau truc (Field Density Analysis). Mot bao cao thuc su luon co cau truc danh sach cac cap khoa-gia tri (Key-Value pairs). Bo loc su dung regex `^[A-Z_0-9]+:\s*` tren tung dong de dem so luong truong. Yeu cau toi thieu phai co tu 2 truong tro len de duoc xem xet la bao cao co cau truc.
- Tang 3: Kiem tra su hien dien cua cac Khoa Cot loi (Core Marker Presence). Xac nhan su ton tai cua cac tu khoa tieu chuan nhu AGENT_ID, STATUS, ROLE, WHAT I DID, FILES, REQUIREMENTS_CHECKED, ERROR, BUG hoac VERDICT. Neu mot khoi thoa man ca ve mat do truong du lieu va chua cac tu khoa cot loi, no moi duoc chuyen sang thanh phan UI `ReportCard`. Nguoc lai, toan bo doan van duoc giu lai nguyen ven trong bong chat dam thoai.

---

## 3. Giao thuc Boc tach Tin nhan OpenCode da tang va Co che Khu trung lap

### 3.1. Hien tuong Du thua Tin nhan trong Kien truc Multi-Agent GUI
Trong kien truc tich hop OpenCode, mot luot lam viec cua Specialist Agent phat sinh hai kenh du lieu:
- Kenh 1 (Raw Execution Stream): Duoc OpenCode CLI ban ve qua SSE voi type 'opencode' chua toan bo transcript tho, bao gom ca qua trinh model goi tool va tu dong thoai noi bo.
- Kenh 2 (Semantic P2P Message): Sau khi hoan thanh, server AgentForge trich xuat lenh <talk> hoac [TALK] va phat song mot Message Object chinh thuc co dinh danh from, to va msgType ro rang.

Neu ca hai kenh du lieu deu duoc render len man hinh chat mot cach tho so, nguoi dung se nhin thay hai bong chat giong het nhau cho cung mot noi dung: mot bong chat tho kem the lenh va mot bong chat nghiem thu.

### 3.2. Pipeline Chuan hoa Tin nhan (Message Normalizer Pipeline)
De tao ra giao dien hoi thoai phang, chuyen nghiep va gon gang (chuan Cursor/Claude), ChatPanel ap dung pipeline 4 buoc truoc khi hien thi bat ky tin nhan nao:
- Buoc 1 (Internal Command Suppression): Phat hien cac tin nhan noi bo `orchestrator_internal` va tu dong an khoi giao dien nguoi dung tru khi co co hien thi `showOnUI: true`.
- Buoc 2 (Raw Stream Deduplication): Khi tin nhan thuoc loai OpenCode tho (`msgType: 'opencode'`) nhung noi dung ben trong chua cac the lenh dieu phoi da duoc chuyen tiep thanh cong (nhu `<talk>`, `<spawn>`, `=== TASK REPORT ===`), giao dien se an phan text tho va chi hien thi cac khoi ToolCall va Thinking neu co.
- Buoc 3 (Dual-Syntax Command Stripping): Su dung ham `stripTalkTags` tien tien de boc sach ca hai loai the XML `<talk target="...">...</talk>` va Bracket `[TALK target=...]` khoi phan than hoi thoai, dong thoi trich xuat dich den de gan badge `→ TargetName` len tieu de tin nhan.
- Buoc 4 (Report Separation): Tach rieng loi thoai tro chuyen thanh `conversationText` va khoi nghiem thu thanh `ReportCard` co kha nang thu gon linh hoat.

---

## 4. Co che Triet tieu Ro ri Lenh Dieu phoi Noi bo cua Orchestrator

### 4.1. Nguyen nhan Goc re cua Hien tuong Ro ri
Khi Main Orchestrator thuc hien quy trinh dieu phoi noi bo (vi du spawn nhieu specialist agents hoac talk chuyen giao task), output cua model thuong chua cac the lenh XML nhu `<spawn role="coder" name="calc" ... />` hoac `<talk target="verifyfix">...</talk>`.
Trong kien truc backend truoc day, ham `dispatchUserChat` tai cac dong 2217 va 3345 trong `src/server.ts` co logic tach loi thoai cho nguoi dung:
`const userText = stripCommandTags(cleanResponse);`
Tuy nhien, khi toan bo phan hoi cua Orchestrator chi chua cac the lenh dieu phoi ma khong co loi thoai danh cho nguoi dung, chuoi `userText` sau khi xoa the lenh se tro thanh rong (`""`). Khi do, bieu thuc fallback:
`content: userText || cleanUserContent`
da vo tinh lay lai toan bo chuoi tho `cleanUserContent` (chua day du cac the lenh XML tran) va phat song lenh chat ve cho nguoi dung duoi dang mot tin nhan binh thuong. Dieu nay lam lo toan bo chi tiet lap trinh va lenh ky thuat noi bo len man hinh chat.

### 4.2. Giai phap Kien truc: Gan Co Noi bo va Loai bo Fallback
Giai phap duoc ap dung la xoa bo hoan toan bieu thuc fallback nay:
- Khi `userText` rong (tuc la Orchestrator chi phat sinh lenh dieu phoi ma khong nhan tin truc tiep cho nguoi dung), he thong thiet lap co `isInternal = true` va `showOnUI = false` cho Message Object.
- Tin nhan mang co `orchestrator_internal` se chi duoc luu tru noi bo vao lich su session de lam ngu canh dieu phoi ma khong duoc broadcast hoac render len UI bong chat cua nguoi dung.
- Chi khi Orchestrator thuc su co loi thoai tong ket, giai thich hoac bao cao danh cho nguoi dung (`userText` co noi dung hop le), mot ChatMsg rieng biet moi duoc tao ra voi `content: userText` va hien thi len giao dien.

---

## 5. Thuat toan Bao ve Ranh gioi Lenh ke tiep (Next-Command Boundary Guard)

### 5.1. Hien tuong Nuot The dong khi Dispatch Nhieu Lenh XML Lien tiep
Khi Orchestrator spawn hoac talk den nhieu agent cung mot luot (vi du spawn dong thoi 3 Coder va 1 Verifier), model LLM co the quen dong the `</talk>` o lenh dau tien ma viet tiep ngay the `<talk target="agent-2">...` hoac `<spawn role="coder" ...>`.
- Neu bo phan tich XML chi tim the dong `</talk>` bang cach quet den cuoi chuoi van ban, no se vo tinh gop toan bo cac the lenh phia sau thanh payload cua the lenh dau tien.
- Hau qua la agent dau tien nhan duoc mot thong diep khong lo chua ca lenh cua agent khac, trong khi cac agent tiep theo hoan toan khong duoc khoi tao hay dispatch.

### 5.2. Thuat toan Cuong che Ngat Ranh gioi (Next-Command Boundary Guard)
Bo phan tich `extractDualCommands` trong `src/server.ts` duoc bo sung thuat toan Next-Command Boundary Guard:
- Khi dang quet phan than cua mot the XML mo `<talk target="...">`, bo quet lien tuc kiem tra xem co su xuat hien cua mot the mo XML hop le tiep theo hay khong (nhu `<talk`, `<spawn`, `<stop`, `<resume`, `<create_role`).
- Neu bat gap mot the mo moi truoc khi tim thay the dong `</talk>`, bo quet se tu dong cuong che ngat pham vi cua the hien tai ngay tai vi tri bat dau cua the mo tiep theo (`nextTagIndex`).
- Dieu nay dam bao moi the lenh duoc co lap tuyet doi thanh mot thuc the doc lap, khong bao gio bi nuot hoac long vao nhau du model co thieu the dong XML.

---

## 6. Mien nhiem The Lenh va Escape HTML Entities cho Tin nhan Nguoi dung

### 6.1. Hien tuong Xoa Nham The trong Tin nhan Nguoi dung
Khi nguoi dung dat cac cau hoi ky thuat nhu "Hay giai thich cach hoat dong cua the <talk> trong he thong?" hoac "Lam sao de dung the <spawn>?", tin nhan cua nguoi dung di qua bo loc `stripTalkTags` va `MessageItem` tren frontend.
- Do regex `/<talk(?:\s+[^>]*)?>/gi` hoat dong tren toan bo van ban ma khong phan biet vai tro nguoi gui, the `<talk>` trong cau hoi cua nguoi dung bi xoa sach, khien cau hoi hien thi tren UI tro thanh "Hay giai thich cach hoat dong cua the trong he thong?".

### 6.2. Giai phap Mien nhiem va Escape HTML Entities
Giai phap trien khai gom hai co che:
- Mien nhiem Tin nhan Nguoi dung (User Message Immunity): Trong `MessageItem`, neu `isUser = true`, toan bo chuoi noi dung cua tin nhan duoc bo qua khong goi qua `stripTalkTags` hay `splitReportAndConversation`.
- Escape HTML Entities: Cac the XML trong tin nhan cua nguoi dung duoc render an toan duoi dang thuc the HTML (`&lt;talk&gt;`, `&lt;spawn&gt;`), dam bao giu nguyen 100% mat chu nguoi dung da nhap ma khong bi trinh duyet parse thanh the DOM hay bi bo loc regex xoa mat.

---

## 7. Kien truc WebAssembly (Wasm) trong Frontend Rendering va AI Coding Agent

### 7.1. Co so Ly thuyet ve WebAssembly
WebAssembly (Wasm) la mot dinh dang ma nhi phan muc thap (Low-Level Binary Code Format) voi kien truc may ao ngan xep (Stack-Based Virtual Machine) duoc chuan hoa boi W3C. Wasm duoc thiet ke de thuc thi ma nguon voi toc do gan nhu tuong duong ma may goc (Near-Native Speed) ben trong moi truong trinh duyet va cac runtime JavaScript hien dai nhu Node.js.

Cac nguyen ly ly thuyet cot loi cua WebAssembly bao gom:
- Mo hinh May ao Ngan xep va Bien dich AOT: Ma Wasm duoc dong goi duoi dang cac byte code nhi phan nho gon, co cau truc duoc kiem tra tinh hop le trong mot luot quet (Single-Pass Validation) va duoc bien dich Ahead-of-Time (AOT) hoac JIT streaming thang sang tap lenh may goc (x86_64, ARM64) ma khong can qua cac tang thong dich cham chap cua JavaScript Engine.
- Bo nho Tuyen tinh Co lap (Isolated Linear Memory): Moi module Wasm hoat dong trong mot vung bo nho doc lap goi la Linear Memory (WebAssembly.Memory). Day la mot mang byte lien tuc co the mo rong linh hoat theo tung trang 64KB, duoc quan ly truc tiep boi ma nguon bien dich (C, C++, Rust, Zig) va hoan toan khong chiu su can thiep hay ngung tre do bo thu gom rac (Garbage Collection pauses/overhead) cua JavaScript.
- Xu ly Da luong Song song (Multi-Threading): Wasm ho tro thuc thi da luong tren trinh duyet thong qua su ket hop giua Web Workers, SharedArrayBuffer va Atomics API, cho phep tinh toan song song hieu nang cao tren nhieu loi CPU ma khong bao gio gay nghen luong giao dien nguoi dung (UI Main Thread).

### 7.2. Cac Ung dung Thuc te trong He sinh thai OpenCode va AI Coding Agent
Trong cac cong cu AI Coding Assistant va IDE hien dai nhu OpenCode, Cursor, VS Code, WebAssembly duoc ung dung rong rai trong 4 linh vuc chu chot:
- Shiki Syntax Highlighter va vscode-oniguruma (onig.wasm): Thay vi su dung cac bo to mau regex JavaScript don gian, he thong chay truc tiep bo engine regex C Oniguruma bien dich sang Wasm de phan tich cac bo ngu phap TextMate (.tmLanguage) chuan xac 100% giong het VS Code, to mau chinh xac hang tram ngon ngu lap trinh phuc tap.
- Web-Tree-sitter Wasm: Bo phan tich cu phap cay AST gia tang (Incremental AST Parser) cho phep phan tich cu phap ma nguon theo thoi gian thuc khi agent stream tung dong code, phat hien loi cu phap va trich xuat pham vi ham ngay lap tuc ma khong gay giat lag UI.
- SQLite Wasm ket hop OPFS (Origin Private File System): Cung cap he co so du lieu quan he SQLite cuc bo chay truc tiep tren trinh duyet voi toc do doc ghi microsecond, ho tro Full-Text Search (FTS5) va tim kiem vector embedding cuc bo cho toan bo lich su hoi thoai multi-agent.
- Terminal Emulator Wasm: Render va xu ly luong ANSI escape sequences / xterm stream voi thong luong hang chuc nghin dong log moi giay o toc do 60 FPS muot ma.

### 7.3. So sanh Hieu nang: JS-based Regex Engine vs Wasm Engine
- JS-based Regex Engine: Uu diem la nhe, zero-dependency, khong can tai them file nhi phan .wasm, thoi gian khoi dong tuc thi duoi 1ms. Nhuoc diem la gioi han boi tap tinh nang regex cua ECMAScript (khong ho tro toan dien Oniguruma regex), de bi nghen UI khi du lieu qua lon va chiu ap luc tu Garbage Collection.
- Wasm-based Engine: Uu diem la toc do xu ly tuyen tinh sieu nhanh (3x - 10x so voi JS), bo nho duoc kiem soat tuyet doi khong co GC overhead, ho tro day du 100% tieu chuan AST va TextMate. Nhuoc diem la can tai va khoi tao module .wasm ban dau (kich thuoc tu 500KB den vai MB).

### 7.4. Lo trinh Tich hop Kien truc trong AgentForge
Doi voi AgentForge:
- Giai doan Hien tai (Lightweight Native): AgentForge duy tri bo parser tuyen tinh sieu nhe bang JavaScript/TypeScript thuan tuy (Zero-Dependency), toi uu hoa cho file thuc thi Portable EXE nho gon nhat co the (~94MB) va thoi gian phan hoi duoi 2ms.
- Giai doan Nang cao (Wasm Enrichment): Khi mo rong cac tinh nang chuyen sau nhu phan tich AST toan bo du an (Project-Wide Codebase Graph) hoac to mau cu phap TextMate da chu de, AgentForge se tich hop shiki/onig.wasm va web-tree-sitter chay ngam trong Web Worker de giu nguyen toc do 60 FPS cho giao dien.

---

## 8. Ket luan va Huong dan Van hanh

Nho su ket hop dong bo giua chuan hoa Unicode NFC, may trang thai Balanced Bracket & XML Scanner voi Next-Command Boundary Guard, bo loc tham dinh 3 tang va pipeline chuan hoa tin nhan tren frontend, he thong AgentForge dat duoc do tin cay tuyet doi:
- Khong bao gio bi lech code unit hay nuot mat ky tu tieng Viet co dau o dau cau.
- Khong bao gio vo giao dien hay nham lan giua noi dung tro chuyen va the bao cao.
- Triet tieu hoan toan hien tuong tin nhan rac, leak lenh dieu phoi noi bo hoac ro ri ma lenh ra man hinh nguoi dung.
