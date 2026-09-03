# SpotlightCard — Glassmorphism Card with Spotlight Effect

> Thẻ glassmorphism tinh tế với hiệu ứng spotlight bám theo con trỏ — xây dựng bằng Tailwind CSS và Framer Motion.

---

## Tổng quan

SpotlightCard là một React component dạng card với hai lớp hiệu ứng chính:

* Lớp nền glassmorphism: `backdrop-blur` + `bg-white` bán trong suốt + viền `border-white/10` tạo cảm giác kính mờ hiện đại.
* Lớp spotlight: gradient tròn theo vị trí con trỏ, được render bằng `framer-motion` với `useMotionValue` và `useMotionTemplate`, chỉ hiện khi hover.

Kết quả là một card nhẹ, mượt, phù hợp cho landing page, dashboard, pricing section, hoặc gallery.

```
┌─────────────────────────────────────┐
│  ╱ Spotlight theo chuột ─────╮      │
│  ╱  (radial-gradient 400px)  │      │
│ ┌───────────────────────────┐ │      │
│ │  Glass Card               │ │      │
│ │  backdrop-blur-xl         │ │      │
│ │  bg-white/[0.05]          │ │      │
│ │  border-white/10          │ │      │
│ └───────────────────────────┘ │      │
└─────────────────────────────────────┘
```

---

## Preview

| Trạng thái | Mô tả |
| --- | --- |
| Idle | Nền tối, card mờ nhẹ, viền mảnh `rgba(255,255,255,0.08)` |
| Hover | Spotlight sáng dần với `opacity: 0 -> 1`, viền sáng nhẹ ở tâm spotlight |
| Active / Focus | Giữ hiệu ứng spotlight, thêm `ring` nếu cần cho accessibility |

Gợi ý nền để card nổi rõ nhất:

```css
body {
  background: radial-gradient(1200px 600px at 50% -10%, #1e293b 0%, #090d14 60%);
  min-height: 100vh;
}
```

---

## Tính năng

* Glassmorphism chuẩn: `backdrop-blur-xl`, `bg-white/[0.05]`, `border-white/10`, `shadow-2xl`
* Spotlight bám theo chuột mượt 60fps nhờ `motion` values (không re-render React)
* Tự động ẩn khi rời chuột, hỗ trợ touch device (fallback tắt spotlight)
* Tương thích Tailwind CSS, không cần CSS file riêng
* TypeScript đầy đủ, props mở rộng từ `div`
* Hỗ trợ tuỳ biến màu spotlight, bán kính, độ mờ

---

## Công nghệ

| Thư viện | Phiên bản gợi ý | Mục đích |
| --- | --- | --- |
| react | ^18.2.0 | Render component |
| tailwindcss | ^3.4.0 | Styling glassmorphism |
| framer-motion | ^10.16.0 | Motion values và spotlight animation |
| typescript | ^5.4.0 | Type safety |

---

## Cài đặt

1. Cài dependencies nếu chưa có:

```bash
npm install framer-motion
# tailwindcss đã có sẵn trong dự án Vite/React
```

2. Đảm bảo Tailwind đã cấu hình `content` bao phủ `src/**/*.{ts,tsx}`:

```js
// tailwind.config.js
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: { extend: {} },
  plugins: [],
}
```

3. Copy file component vào `src/components/SpotlightCard.tsx`.

---

## Mã nguồn đầy đủ — SpotlightCard.tsx

```tsx
import { useRef, useState } from "react";
import { motion, useMotionTemplate, useMotionValue } from "framer-motion";

type SpotlightCardProps = React.PropsWithChildren<{
  className?: string;
  spotlightColor?: string;
  spotlightRadius?: number;
  spotlightOpacity?: number;
  glassOpacity?: string;
  borderOpacity?: string;
}>;

export default function SpotlightCard({
  children,
  className = "",
  spotlightColor = "rgba(56, 189, 248, 0.18)",
  spotlightRadius = 350,
  spotlightOpacity = 1,
  glassOpacity = "bg-white/[0.06]",
  borderOpacity = "border-white/10",
}: SpotlightCardProps) {
  const divRef = useRef<HTMLDivElement>(null);
  const mouseX = useMotionValue(-spotlightRadius);
  const mouseY = useMotionValue(-spotlightRadius);
  const [isHovered, setIsHovered] = useState(false);

  function handleMouseMove(e: React.MouseEvent<HTMLDivElement>) {
    if (!divRef.current) return;
    const rect = divRef.current.getBoundingClientRect();
    mouseX.set(e.clientX - rect.left);
    mouseY.set(e.clientY - rect.top);
  }

  function handleMouseEnter() {
    setIsHovered(true);
  }

  function handleMouseLeave() {
    setIsHovered(false);
    // Đẩy spotlight ra ngoài để ẩn mượt
    mouseX.set(-spotlightRadius);
    mouseY.set(-spotlightRadius);
  }

  const spotlightBg = useMotionTemplate`radial-gradient(${spotlightRadius}px circle at ${mouseX}px ${mouseY}px, ${spotlightColor}, transparent 70%)`;
  const borderSpotlight = useMotionTemplate`radial-gradient(${spotlightRadius}px circle at ${mouseX}px ${mouseY}px, rgba(255,255,255,0.18), transparent 55%)`;

  return (
    <div
      ref={divRef}
      onMouseMove={handleMouseMove}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      className={[
        "group relative overflow-hidden rounded-2xl",
        "border backdrop-blur-xl",
        "bg-gradient-to-b from-white/[0.08] to-white/[0.02]",
        glassOpacity,
        borderOpacity,
        "shadow-[0_8px_32px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.08)]",
        "transition-colors duration-300",
        className,
      ].join(" ")}
    >
      {/* Spotlight nền — chỉ hiện khi hover */}
      <motion.div
        className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
        style={{
          background: spotlightBg,
          opacity: isHovered ? spotlightOpacity : 0,
        }}
        aria-hidden
      />

      {/* Viền spotlight — tạo hiệu ứng viền sáng theo chuột */}
      <motion.div
        className="pointer-events-none absolute inset-0 rounded-2xl opacity-0 group-hover:opacity-100"
        style={{
          background: borderSpotlight,
          // Dùng mask để chỉ hiện viền
          WebkitMask: "linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)",
          WebkitMaskComposite: "xor",
          maskComposite: "exclude",
          padding: "1px",
        }}
        aria-hidden
      />

      {/* Lớp glass highlight trên cùng */}
      <div className="pointer-events-none absolute inset-0 rounded-2xl bg-gradient-to-b from-white/[0.07] to-transparent opacity-60" />

      {/* Nội dung */}
      <div className="relative z-10 p-6 md:p-7">
        {children}
      </div>
    </div>
  );
}
```

Giải thích nhanh các lớp:

* `backdrop-blur-xl` + `from-white/[0.08] to-white/[0.02]` tạo kính mờ.
* `motion.div` thứ nhất vẽ `radial-gradient` bám theo `mouseX/mouseY`.
* `motion.div` thứ hai chỉ vẽ viền sáng (dùng mask để không lấp nền).
* Lớp `bg-gradient-to-b from-white/[0.07]` ở trên cùng tạo highlight kính.

---

## Hướng dẫn sử dụng

### 1. Cơ bản

```tsx
import SpotlightCard from "@/components/SpotlightCard";

export function DemoBasic() {
  return (
    <div className="min-h-screen bg-[#090d14] p-8">
      <SpotlightCard className="max-w-md">
        <h3 className="text-lg font-semibold text-white">Spotlight Card</h3>
        <p className="mt-2 text-sm leading-relaxed text-slate-300">
          Di chuột quanh card để thấy hiệu ứng spotlight mượt mà. Glassmorphism giữ card nổi trên nền tối.
        </p>
        <button className="mt-4 rounded-full bg-white px-5 py-2 text-sm font-medium text-slate-900 transition hover:bg-slate-100">
          Khám phá ngay
        </button>
      </SpotlightCard>
    </div>
  );
}
```

### 2. Lưới nhiều card

```tsx
import SpotlightCard from "@/components/SpotlightCard";
import { Sparkles, Shield, Zap } from "lucide-react";

const items = [
  { icon: Sparkles, title: "Thiết kế tinh tế", desc: "Glassmorphism + blur cho cảm giác cao cấp." },
  { icon: Shield, title: "Hiệu năng mượt", desc: "Motion values, không trigger re-render thừa." },
  { icon: Zap, title: "Tuỳ biến nhanh", desc: "Đổi màu spotlight chỉ bằng một prop." },
];

export function DemoGrid() {
  return (
    <div className="grid gap-6 md:grid-cols-3 bg-[#090d14] p-8">
      {items.map((it) => (
        <SpotlightCard key={it.title} spotlightColor="rgba(99,102,241,0.20)">
          <it.icon className="h-5 w-5 text-indigo-300" />
          <h4 className="mt-4 text-base font-semibold text-white">{it.title}</h4>
          <p className="mt-1.5 text-sm text-slate-400">{it.desc}</p>
        </SpotlightCard>
      ))}
    </div>
  );
}
```

### 3. Tuỳ biến màu và bán kính

```tsx
<SpotlightCard
  spotlightColor="rgba(244,114,182,0.22)" // hồng neon
  spotlightRadius={500}                  // vùng sáng rộng hơn
  spotlightOpacity={0.9}
  className="max-w-sm"
>
  <p className="text-white">Màu hồng cho vibe retro-futurism</p>
</SpotlightCard>

<SpotlightCard
  spotlightColor="rgba(52,211,153,0.18)" // xanh ngọc
  spotlightRadius={280}                  // vùng sáng gọn, tập trung
>
  <p className="text-white">Màu xanh ngọc cho cảm giác fresh</p>
</SpotlightCard>
```

### 4. Card tương tác (clickable)

```tsx
<SpotlightCard className="cursor-pointer transition hover:scale-[1.01] hover:shadow-[0_12px_40px_rgba(0,0,0,0.45)]">
  <a href="/pricing" className="block">
    <h3 className="text-white font-semibold">Gói Pro — $29/tháng</h3>
    <p className="text-slate-400 text-sm mt-1">Không giới hạn agents, hỗ trợ ưu tiên.</p>
  </a>
</SpotlightCard>
```

---

## API Props

| Prop | Kiểu | Mặc định | Mô tả |
| --- | --- | --- | --- |
| children | ReactNode | — | Nội dung bên trong card |
| className | string | "" | Thêm class Tailwind cho container |
| spotlightColor | string | rgba(56,189,248,0.18) | Màu tâm spotlight (dạng rgba/hsla) |
| spotlightRadius | number | 350 | Bán kính gradient spotlight (px) |
| spotlightOpacity | number | 1 | Độ mờ spotlight khi hover (0-1) |
| glassOpacity | string | bg-white/[0.06] | Class Tailwind điều chỉnh độ mờ kính |
| borderOpacity | string | border-white/10 | Class Tailwind điều chỉnh độ mờ viền |

Tất cả props còn lại của `div` đều được hỗ trợ nếu bạn mở rộng type thành `React.HTMLAttributes<HTMLDivElement>`.

---

## Tuỳ biến nâng cao

* Đổi tone tối hơn: `glassOpacity="bg-white/[0.03]"` + `borderOpacity="border-white/[0.06]"`
* Spotlight ấm: `spotlightColor="rgba(251,146,60,0.20)"`
* Tắt spotlight trên mobile: bọc component trong `hidden md:block` cho spotlight, fallback card thường trên mobile.
* Thêm `rounded-3xl` thay vì `rounded-2xl` nếu muốn bo góc lớn hơn — nhớ đồng bộ `rounded-2xl` trong 2 `motion.div` viền.

Ví dụ theme sáng (light mode) với cùng component:

```tsx
<SpotlightCard
  spotlightColor="rgba(59,130,246,0.12)"
  className="bg-white/70 border-slate-200/60 shadow-[0_8px_30px_rgba(15,23,42,0.08)]"
>
  <h3 className="text-slate-900">Light glass</h3>
  <p className="text-slate-600">Hoạt động tốt trên nền sáng khi đổi glassOpacity.</p>
</SpotlightCard>
```

---

## Nguyên lý hoạt động

1. `useMotionValue` lưu toạ độ chuột `mouseX/mouseY` mà không gây re-render.
2. `useMotionTemplate` tạo chuỗi `radial-gradient(... at ${mouseX}px ${mouseY}px, ...)` phản ứng trực tiếp với motion values.
3. `onMouseMove` cập nhật toạ độ tương đối với card (`getBoundingClientRect`).
4. `opacity` chuyển từ 0 sang 1 khi `group-hover`, tạo fade mượt.
5. Khi `mouseLeave`, đẩy toạ độ ra ngoài (`-radius`) để gradient biến mất tự nhiên.

Lợi ích: không dùng `useState` cho mỗi pixel di chuyển, tránh hàng trăm re-render mỗi giây — giữ 60fps ngay cả với lưới 12 card.

---

## Lưu ý vận hành

* Yêu cầu Tailwind JIT để xử lý `bg-white/[0.06]` và arbitrary values.
* Framer Motion cần `motion` context — không cần `MotionConfig` thêm.
* Trên thiết bị cảm ứng, spotlight không có ý nghĩa — component tự fallback thành card glass thuần (không lỗi).
* Nếu đặt nhiều card trong `grid`, tránh đặt `overflow-hidden` ở container cha làm cắt `backdrop-blur`.
* Kiểm tra `prefers-reduced-motion`: có thể bọc `motion.div` trong `motion` với `initial/animate` tôn trọng reduced motion nếu dự án yêu cầu a11y nghiêm ngặt.

---

## Kiểm tra hiển thị markdown

Sau khi tạo file, verify:

```bash
# Kiểm tra file tồn tại
Test-Path -LiteralPath "./demo/SpotlightCard.md"

# Xem trước bằng VS Code hoặc markdown preview
code ./demo/SpotlightCard.md
```

File hợp lệ khi:

* VS Code preview render đúng heading, bảng, code block.
* Các khối TSX có highlight `tsx`.
* Không lỗi cú pháp markdown (thiếu dấu đóng code block).

---

## Giấy phép và tham khảo

* Tailwind CSS — https://tailwindcss.com/docs/backdrop-blur
* Framer Motion — https://www.framer.com/motion/
* Glassmorphism — https://ui.glass/generator/

---

*File được tạo tại `./demo/SpotlightCard.md` — sẵn sàng import vào Storybook, Docusaurus hoặc bất kỳ markdown preview nào.*
