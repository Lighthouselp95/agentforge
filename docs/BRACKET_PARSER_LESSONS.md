# Kien thuc va Kinh nghiem Kien truc Bo Parser Lenh Bracket trong He thong Multi-Agent

Tai lieu nay ghi lai toan bo co so ly thuyet, nguyen nhan goc re, giai phap ky thuat va bai hoc kinh nghiem rut ra tu qua trinh toi uu hoa bo phan tich cu phap lenh dang ngoac vuong (Bracket Command Parser) va co che phan luong hien thi hoi thoai trong AgentForge.

---

## 1. Co so Ly thuyet ve Phan tich Cu phap Chuoi va Ngon ngu Phi ngu canh

### 1.1. Gioi han cua Bieu thuc Chinh quy trong Xu ly Cau truc Long nhau
Trong khoa hoc may tinh va ly thuyet ngon ngu hinh thuc, bieu thuc chinh quy (Regular Expressions) thuoc cap do ngon ngu chinh quy (Chomsky Type-3), chi co kha nang nhan dien cac mau chuoi tuyen tinh su dung may trang thai huu han khong bo nho ngan xep (Finite State Automaton). Trong khi do, cac cau truc chua cac cap ngoac long nhau nhu ngoac vuong, ngoac tron hoac the HTML/XML thuoc cap do ngon ngu phi ngu canh (Chomsky Type-2, Context-Free Grammar), doi hoi bo nho ngan xep (Pushdown Automaton) hoac co che dem do sau de theo doi so luong cap ngoac mo va dong tuong ung.

Khi ap dung bieu thuc chinh quy de trich xuat cac the lenh nhu `[TALK ...]` hoac `[SPAWN ...]`, cac cong cu regex trong JavaScript khong ho tro de quy (khong co tinh nang recursive patterns nhu trong PCRE). Do do, regex chi co the hoat dong theo hai che do: tham lam (greedy) hoac khong tham lam (lazy/non-greedy). Che do tham lam se quet qua toan bo chuoi cho den dau ngoac dong cuoi cung cua van ban, dan den viec nuot tron tat ca cac the lenh dung sau thanh mot the duy nhat. Nguoc lai, che do khong tham lam se dung lai ngay o dau ngoac dong dau tien bat gap, khien cho bat ky noi dung nao chua dau ngoac vuong ben trong (nhu chi so mang `array[0]` hoac the lenh vi du) bi cat ngang giua chung, gay hong toan bo cu phap cua tin nhan.

### 1.2. Nguyen ly May trang thai Tuyen tinh va Can bang Ngoac
Giai phap toi uu va chuan xac nhat ve mat ly thuyet cho bai toan nay la xay dung mot bo phan tich tuyen tinh dua tren may trang thai (Linear State Machine Scanner) voi do phuc tap thoi gian O(N), trong do N la chieu dai cua chuoi van ban can phan tich. Bo quet nay duy tri mot bien dem do sau (depth counter) cung voi cac co trang thai ngu canh (context flags) de theo doi vi tri hien tai cua con tro:
- Trang thai chuoi trich dan (Quoted String State): Khi con tro di vao ben trong mot chuoi trich dan bang dau nhay kep, nhay don hoac nhay cong, bo quet se tam thoi vo hieu hoa viec dem cac dau ngoac vuong cho den khi gap dau nhay dong tuong ung khong bi escape.
- Trang thai khoi ma nguon (Code Block State): Khi con tro di vao ben trong khoi ma nguon markdown ba dau backtick, toan bo noi dung ben trong phai duoc xem la van ban thuong, khong duoc phep kich hoat bat ky hanh vi phan tich lenh nao.
- Trang thai can bang ngoac cap ngoai cung (Top-Level Balanced State): Bien dem do sau khoi tao bang 0, tang len 1 khi bat gap dau mo ngoac cua the lenh, va chi giam xuong khi gap dau dong ngoac tuong ung o cung cap do. Khi bien dem tro ve 0, diem ket thuc cua the lenh ngoai cung duoc xac dinh mot cach tuyet doi chinh xac.

### 1.3. Nguyen ly Con tro Tuan tu va Tranh Thuc thi De quy
Trong kien truc he thong multi-agent, mot the lenh dieu phoi nhu `[TALK target=coder message="..."]` chua tham so noi dung mang thong diep truyen dat cho agent khac. Thong diep nay co the chua cac vi du ve the lenh, huong dan lap trinh hoac cac doan ma gia lap. Neu bo phan tich sau khi trich xuat the lenh ngoai cung lai tiep tuc quet de quy vao ben trong noi dung tin nhan, he thong se vo tinh thuc thi cac the lenh vi du nhu the chung la cac chi thi thuc te, gay ra hien tuong loan luong dieu phoi (accidental command execution).

Nguyen ly con tro tuan tu (Sequential Cursor Jump) quy dinh rang sau khi mot the lenh cap ngoai cung duoc phan tich thanh cong tai vi tri ket thuc `closeIndex`, con tro phan tich tiep theo phai lap tuc nhay coc den vi tri `closeIndex + 1`. Dieu nay dam bao vung van ban nam ben trong the lenh duoc bao ve nguyen ven, chi duoc xem la du lieu tai trong (payload) va khong bao gio bi quet lai lan thu hai o tang he thong.

---

## 2. Phan tich Cac Van de Thuc te va Nguyen nhan Goc re trong Codebase

### 2.1. Van de Nuot Text va Cat xen Noi dung khi The Lenh bi Loi
- Hien tuong: Khi agent hoac nguoi dung gui mot tin nhan chua the lenh khong hoan chinh (vi du thieu dau ngoac dong `]`, hoac thieu dau nhay dong trong thuoc tinh), bo phan tich cu co mot doan ma fallback co gang tim dau `]` tiep theo hoac lay den het chuoi. Hau qua la ham xoa the `stripCommandTags` da xoa sach toan bo noi dung hop le phia sau, khien giao dien chat hien thi trang tinh hoac mat mat du lieu.
- Nguyen nhan: Ham `extractBracketCommand` truoc day khi bien dem do sau khac 0 o cuoi chuoi van tra ve mot doi tuong the lenh thay vi tra ve null. Dieu nay vi pham nguyen tac an toan: mot the lenh chi duoc xem la hop le khi no duoc dong day du va can bang; moi truong hop loi phai duoc giu nguyen duoi dang van ban thuan tuy de nguoi dung nhin thay.

### 2.2. Van de Thuc thi Lenh Long nhau va Duplicate Execution
- Hien tuong: Khi Orchestrator gui huong dan cho Coder co kem vi du nhu `[TALK target=tester message=...]`, he thong backend vo tinh trich xuat ca the lenh vi du ben trong va tao ra mot tien trinh goi den tester, gay ra loi `Agent not found` hoac kich hoat cac tac vu sai lech.
- Nguyen nhan: Bo phan tich truoc day chua co co che nhay con tro tuyen tinh va chua tich hop bo loc bao ve cac gia tri thuoc tinh nam trong dau nhay kep ben trong the lenh.

### 2.3. Van de An Nham Tin nhan Tong ket va Bao cao cua Orchestrator
- Hien tuong: Sau khi sua logic xoa the lenh, nguoi dung phan anh rang toan bo tin nhan tra loi, bao cao tong ket va loi thoai cua Orchestrator deu bien mat khoi giao dien web chat, chi con lai cac bong chat cua nguoi dung.
- Nguyen nhan: Khi trien khai co `msgType: 'orchestrator_internal'`, backend da gan co nay mot cach cung nhac (hardcoded) cho moi tin nhan duoc sinh ra boi Orchestrator tai `synthesizeResults`, `processOrchestratorTriggerQueue` va `dispatchUserChat`. Dong thoi, tai frontend `App.tsx`, ham loc `isSystemMsg` da chan toan bo tin nhan mang co `orchestrator_internal`. Do do, ca tin nhan lenh noi bo lan tin nhan tong ket danh cho nguoi dung deu bi an 100%.

---

## 3. Kien truc Giai phap va Cac Cai tien Ky thuat da Trien khai

### 3.1. Ham Loi Dung chung `findBalancedBracketRange`
He thong da duoc tai cau truc de su dung mot ham duy nhat chiu trach nhiem xac dinh ranh gioi the lenh, loai bo su bat dong bo giua bo phan thuc thi va bo phan hien thi:
- Nhan dien the lenh: Ho tro ca the lenh mot tu (`TALK`, `SPAWN`, `STOP`, `RESUME`) va the lenh nhieu tu (`CREATE ROLE`, `STOP AGENT`, `RESUME AGENT`, `DELETE AGENT`).
- Bo qua cac ngu canh dac biet: Su dung may trang thai de bo qua toan bo dau ngoac vuong nam trong chuoi nhay kep `"..."`, nhay don `'...'`, inline backtick, va nhay cong `“...”`.
- Bo qua khoi code block: Tu dong dao trang thai `inCodeBlock` khi gap chuoi ba dau backtick va bo qua moi ky tu ben trong.
- Tra ve ket qua ro rang: Chi tra ve doi tuong chua `startIndex`, `closeIndex`, `endIndex`, `raw` va `content` khi tim thay dau dong hop le; tra ve `null` neu the lenh bi loi hoac khong dong ngoac.

### 3.2. Sequential Cursor Jump trong `extractBracketCommands`
Trong vong lap quet the lenh:
- Khi tim thay mot the lenh hop le tai vi tri `earliestIdx`, ham goi `findBalancedBracketRange`.
- Sau khi them the lenh vao danh sach thuc thi, con tro quet `pos` lap tuc duoc gan bang `cmd.endIndex`.
- Toan bo phan than cua the lenh duoc bo qua, ngan chan tuyet doi viec thuc thi bat ky the lenh con nao ben trong.
- Neu the lenh khong hop le, con tro chi tien len mot khoang nho de tiep tuc tim kiem cac the lenh hop le tiep theo ma khong lam hong chuoi van ban.

### 3.3. Nang cap `getCodeSpanRanges` de Bao ve Gia tri Thuoc tinh
Ham `getCodeSpanRanges` duoc nang cap de su dung chinh `findBalancedBracketRange` thay vi dung `indexOf(']')` don gian. Khi phat hien the `[TALK` hoac `[SPAWN`, he thong xac dinh chinh xac pham vi cua the, sau do trich xuat cac gia tri thuoc tinh `message=...`, `msg=...`, `content=...` va dua toan bo pham vi nay vao danh sach vung duoc bao ve. Nho do, moi the lenh nam ben trong gia tri thuoc tinh deu duoc coi nhu nam trong code block va bi bo qua boi bo quet.

### 3.4. Co che Bao ve Hien thi Hai lop (Dual-Layer UI Visibility Protection)
De giai quyet triet de van de an nham tin nhan tong ket cua Orchestrator:
- Lop 1 (Phan loai tai Backend):
  + Khi Orchestrator sinh phan hoi, backend su dung `stripCommandTags` de bóc tach noi dung danh cho nguoi dung.
  + Neu sau khi bóc the lenh ma van con van ban (user-facing text): tin nhan duoc xac dinh la tin tong ket/tra loi, duoc gan `showOnUI: true` va giu `msgType: undefined`.
  + Neu sau khi bóc the lenh ma chuoi tro nen rong (chi chua lenh dieu phoi noi bo): tin nhan duoc gan `msgType: 'orchestrator_internal'` va `showOnUI: false`.
- Lop 2 (Bo loc tai Frontend):
  + Bo sung truong `showOnUI?: boolean` vao giao dien `ChatMsg` tren ca backend va frontend.
  + Trong `web/src/App.tsx`, cac ham loc `isSystemMsg` va `isInternalMsg` deu kiem tra dieu kien uu tien: neu `m.showOnUI === true` thi lap tuc tra ve `false` (khong bi coi la tin he thong hay tin noi bo).
  + Trong `web/src/components/ChatPanel.tsx`, thanh phan `MessageItem` chi an tin nhan khi `isOrchestratorInternal && !msg.showOnUI`.

---

## 4. Bai hoc Kinh nghiem va Huong dan Bao tri

### 4.1. Nguyen tac Single Source of Truth cho Parser
Khong bao gio viet hai ham phan tich cu phap rieng biet cho viec thuc thi lenh va viec xoa the lenh tren giao dien. Neu bo phan thuc thi nhan dien mot the lenh ma bo phan xoa the khong nhan dien duoc (hoac nguoc lai), he thong se roi vao trang thai bat nhat: lenh bi thuc thi nhung van hien thi tren man hinh, hoac van ban cua nguoi dung bi xoa mat ma khong co lenh nao duoc chay. Luon su dung chung mot ham goc nhu `findBalancedBracketRange`.

### 4.2. Khong bao gio gia dinh cu phap LLM luon hoan hao
Mo hinh ngon ngu lon co the sinh ra cu phap khong hoan chinh do bi ngat token, loi mang hoac suy nghi do dang. Bo phan tich cu phap phai duoc thiet ke theo nguyen tac phong thu:
- Neu cu phap the lenh khong hoan chinh, coi do la van ban thuan tuy va giu nguyen tren giao dien de nguoi dung va he thong quan sat duoc loi.
- Tuyet doi khong su dung cac co che fallback tham lam de doan dau dong ngoac khi chua can bang do sau.

### 4.3. Phan dinh ro rang giua Kenh Thuc thi va Kenh Giao tiep
Trong he thong multi-agent, Orchestrator vua dong vai tro nguoi dieu phoi (phat lenh cho worker) vua dong vai tro nguoi tro chuyen (tra loi nguoi dung). Khi thiet ke kien truc thong diep:
- Cac chi thi dieu phoi can duoc tach biet khoi noi dung hoi thoai.
- Cac co loc giao dien nhu `msgType` phai duoc gan dua tren ban chat noi dung thuc te (co chua van ban huong toi nguoi dung hay khong), thay vi gan dong loat dua tren vai tro cua agent.
- Luon co co che ghi de ro rang nhu `showOnUI` de tranh viec cac bo loc o nhieu tang khac nhau vo tinh chong cheo va triet tieu lan nhau.
