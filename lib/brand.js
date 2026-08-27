// 统一品牌蓝：三界面（popup / panel / dashboard）的 accent 与品牌 SVG / 图标共用的唯一取值。
// 白字置于其上对比度 ≈5.17:1（>=4.5:1），亮暗模式一致。
export const ACCENT = '#2563eb';

// 自绘 Kimi 风格 logo（原创设计，非官方图形）：深蓝渐变圆角方块 + 白色月牙（开口朝右上）+ 右上浅蓝星点。
// 内联 SVG，亮暗主题均可读；content-script 经动态 import 复用同一份定义。
export const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="1em" height="1em" aria-label="Kimi">
  <defs>
    <linearGradient id="kg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#1D4ED8"/>
      <stop offset="1" stop-color="#0B1220"/>
    </linearGradient>
  </defs>
  <rect x="4" y="4" width="120" height="120" rx="30" fill="url(#kg)"/>
  <path d="M 76 30 A 40 40 0 1 0 76 98 A 31 31 0 1 1 76 30 Z" fill="#F8FAFF"/>
  <circle cx="87" cy="40" r="7" fill="#93C5FD"/>
</svg>`;
