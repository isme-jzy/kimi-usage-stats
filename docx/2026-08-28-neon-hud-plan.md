# 霓虹 HUD 改造 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 kimi-usage-stats 扩展的暗色主题替换为霓虹 HUD 风（深海军蓝玻璃 + 全息网格 + 青色光晕），并为 panel/dashboard 增加全套图形化（面积趋势图、命中率圆环、tps 迷你柱状图）。

**Architecture:** 纯 CSS 变量换肤 + JS 生成内联 SVG。图形生成的纯函数集中在新增的 `lib/charts.js`，dashboard 与 panel 各自调用；样式全部走既有 `data-theme` 三态 token 机制。规格见 `docx/2026-08-28-neon-hud-design.md`。

**Tech Stack:** Chrome MV3 扩展，原生 ESM，无构建工具，无第三方依赖；测试为 node:test（`test/*.test.mjs`）。

## Global Constraints

- 不引入任何第三方依赖；不修改 `manifest.json`（CSP 保持默认，禁止远程脚本）。
- 亮色主题（月之亮面）视觉保持不变；仅为其补充新增图形所需的 CSS 变量。
- `[data-theme="dark"]` 与 `@media (prefers-color-scheme: dark)` 下 `system` 分支必须保持同一套色板（现有结构，两处同步改）。
- 代码注释用简体中文，风格与周边一致；禁止绝对路径导入。
- 测试命令：`node --test test/`（Node ≥ 20 会匹配 `test/*.test.mjs`）。
- 所有 `git commit` 步骤需用户确认后执行（项目 AGENTS.md 规范），执行者不得擅自提交。
- panel 侧已是 HUD 雏形（玻璃/网格/圆环/渐变条已存在），只做补齐，不得回退其现有效果。

---

### Task 1: `lib/charts.js` 纯函数模块 + 单测

**Files:**
- Create: `lib/charts.js`
- Test: `test/charts.test.mjs`

**Interfaces:**
- Produces（后续任务全部依赖此处签名）:
  - `ringDash(rate, r = 7.5)` → `{ c: number, off: number }`；`rate` 为 `number|null`（null → `off = c`，空态）；结果四舍五入保留 2 位小数；`rate`  clamp 到 `[0, 1]`。
  - `sparkHeights(values, maxH = 14, max = null)` → `number[]`；`max` 缺省取 `Math.max(...values)`；`max <= 0` → 全 0；`v > 0` 时最小高度 2px。
  - `dailyBuckets(records, range, now = Date.now(), maxDays = 90)` → `[{ ts, total, output, streamMs }]`；按本地日聚合，范围内连续天补 0；`range.from === 0`（all）时从最早记录日起算；窗口最多 `maxDays` 天（取最近）；无记录或范围无效 → `[]`。
  - `areaPath(values, w, h, pad = 4)` → `{ points: [{x, y}], line: string, area: string }`；`values.length < 2` 时 `line`/`area` 为 `''`；`max <= 0` 时所有点落在基线 `y = h - pad`。

- [ ] **Step 1: 写失败测试** `test/charts.test.mjs`

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { ringDash, sparkHeights, dailyBuckets, areaPath } from '../lib/charts.js';

const DAY = 86400000;
// 固定 now = 2026-08-13 15:00:00 本地时间
const NOW = new Date(2026, 7, 13, 15, 0, 0).getTime();
const dayStart = new Date(2026, 7, 13, 0, 0, 0).getTime();
const rec = (time, output, streamDurationMs, extra = {}) => ({
  time, model: 'm/a', inputOther: 10, inputCacheRead: 20, inputCacheCreation: 5, output, streamDurationMs, ...extra,
});

test('ringDash：null 为空态，0.5 为半程，超界 clamp', () => {
  const c = 2 * Math.PI * 7.5;
  assert.deepEqual(ringDash(null), { c: 47.12, off: 47.12 });
  assert.deepEqual(ringDash(0.5), { c: 47.12, off: +(c * 0.5).toFixed(2) });
  assert.deepEqual(ringDash(1), { c: 47.12, off: 0 });
  assert.deepEqual(ringDash(1.5), { c: 47.12, off: 0 });
  assert.deepEqual(ringDash(-0.2), { c: 47.12, off: 47.12 });
  const r10 = ringDash(0.25, 10);
  assert.equal(r10.c, 62.83);
  assert.equal(r10.off, +(2 * Math.PI * 10 * 0.75).toFixed(2));
});

test('sparkHeights：归一化、全 0、空数组、外部 max、最小 2px', () => {
  assert.deepEqual(sparkHeights([]), []);
  assert.deepEqual(sparkHeights([0, 0]), [0, 0]);
  assert.deepEqual(sparkHeights([5, 10], 20), [10, 20]);
  assert.deepEqual(sparkHeights([1, 100], 14), [2, 14]); // v>0 最小 2px
  assert.deepEqual(sparkHeights([50], 12, 100), [6]);     // 外部 max
  assert.deepEqual(sparkHeights([0], 12, 100), [0]);
});

test('dailyBuckets：连续天补 0、聚合 total/output/streamMs', () => {
  const records = [
    rec(dayStart + 1000, 100, 2000),      // 今天
    rec(dayStart - DAY, 200, 4000),       // 昨天
  ];
  const range = { from: dayStart - 2 * DAY, to: null }; // 前天起
  const b = dailyBuckets(records, range, NOW);
  assert.equal(b.length, 3);
  assert.equal(b[0].ts, dayStart - 2 * DAY);
  assert.deepEqual([b[0].total, b[0].output, b[0].streamMs], [0, 0, 0]); // 前天补 0
  assert.equal(b[1].total, 235); // 10+20+5+200
  assert.equal(b[1].streamMs, 4000);
  assert.equal(b[2].total, 135);
});

test('dailyBuckets：all 范围从最早记录起、窗口 cap、空记录', () => {
  assert.deepEqual(dailyBuckets([], { from: 0, to: null }, NOW), []);
  const old = rec(dayStart - 200 * DAY, 10, 1000);
  const b = dailyBuckets([old, rec(dayStart, 5, 500)], { from: 0, to: null }, NOW, 90);
  assert.equal(b.length, 90); // cap 到最近 90 天
  assert.equal(b[b.length - 1].ts, dayStart);
  assert.equal(b[b.length - 1].output, 5);
  // 指定 from 在 cap 之前同样被截断
  const b2 = dailyBuckets([old], { from: dayStart - 200 * DAY, to: null }, NOW, 90);
  assert.equal(b2.length, 90);
  // 范围内无记录但范围有效 → 连续空天
  const b3 = dailyBuckets([old], { from: dayStart - DAY, to: null }, NOW, 90);
  assert.equal(b3.length, 2);
  assert.equal(b3[1].total, 0);
});

test('areaPath：空/单点/正常/全 0', () => {
  assert.deepEqual(areaPath([], 100, 40), { points: [], line: '', area: '' });
  const one = areaPath([5], 100, 40, 4);
  assert.equal(one.points.length, 1);
  assert.equal(one.line, '');
  assert.equal(one.area, '');
  const two = areaPath([0, 10], 100, 40, 4);
  assert.equal(two.points.length, 2);
  assert.match(two.line, /^M/);
  assert.match(two.area, /Z$/);
  // 两点：起点 (4, 36) 终点 (96, 4)
  assert.deepEqual(two.points[0], { x: 4, y: 36 });
  assert.deepEqual(two.points[1], { x: 96, y: 4 });
  // 全 0 → 全落基线
  const zero = areaPath([0, 0, 0], 100, 40, 4);
  assert.ok(zero.points.every((p) => p.y === 36));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/charts.test.mjs`
Expected: FAIL，报 `Cannot find module '../lib/charts.js'`

- [ ] **Step 3: 实现 `lib/charts.js`**

```js
// 霓虹 HUD 图形生成的纯函数：圆环 dash、迷你柱状图高度、每日聚合、面积图路径。
// 全部为无副作用纯函数，供 dashboard/panel 渲染层调用，可在 node 下直接单测。

// 命中率圆环：返回周长 c 与 dashoffset（保留 2 位小数）；rate=null → 空态（off=c）
export function ringDash(rate, r = 7.5) {
  const c = +(2 * Math.PI * r).toFixed(2);
  if (rate == null) return { c, off: c };
  const clamped = Math.min(1, Math.max(0, rate));
  return { c, off: +(c * (1 - clamped)).toFixed(2) };
}

// 迷你柱状图高度：按 max 归一化到 [0, maxH]；v>0 最小 2px；可传外部 max（跨行共享口径）
export function sparkHeights(values, maxH = 14, max = null) {
  if (!values.length) return [];
  const m = max != null ? max : Math.max(...values);
  if (!(m > 0)) return values.map(() => 0);
  return values.map((v) => {
    if (!(v > 0)) return 0;
    return Math.max(2, +((v / m) * maxH).toFixed(1));
  });
}

// 每日聚合：range 内按本地日连续 bucket（空天补 0），含 total/output/streamMs。
// range.from === 0（all）时从最早记录日起；窗口最多 maxDays 天（取最近一段）。
export function dailyBuckets(records, range, now = Date.now(), maxDays = 90) {
  const DAY = 86400000;
  const dayStart = (ts) => { const d = new Date(ts); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
  const todayStart = dayStart(now);
  let earliest = null;
  for (const r of records) {
    if (typeof r.time !== 'number') continue;
    const ds = dayStart(r.time);
    if (earliest == null || ds < earliest) earliest = ds;
  }
  let from = range.from === 0 ? earliest : dayStart(range.from);
  if (from == null) return [];
  // cap：窗口最多 maxDays 天，取最近
  const capFrom = todayStart - (maxDays - 1) * DAY;
  if (from < capFrom) from = capFrom;
  // 最后一天：range.to 为排除端；无 to 或 to 在未来 → 今天
  const lastDay = dayStart(range.to == null ? now : Math.min(range.to - 1, now));
  if (lastDay < from) return [];
  const days = Math.round((lastDay - from) / DAY) + 1;
  const buckets = new Map(); // ds → { total, output, streamMs }
  for (const r of records) {
    if (typeof r.time !== 'number') continue;
    const ds = dayStart(r.time);
    if (ds < from || ds > lastDay) continue;
    let b = buckets.get(ds);
    if (!b) { b = { total: 0, output: 0, streamMs: 0 }; buckets.set(ds, b); }
    b.total += (r.inputOther || 0) + (r.inputCacheRead || 0) + (r.inputCacheCreation || 0) + (r.output || 0);
    b.output += r.output || 0;
    b.streamMs += r.streamDurationMs || 0;
  }
  const out = [];
  for (let i = 0; i < days; i++) {
    const ts = from + i * DAY;
    const b = buckets.get(ts) || { total: 0, output: 0, streamMs: 0 };
    out.push({ ts, total: b.total, output: b.output, streamMs: b.streamMs });
  }
  return out;
}

// 面积图路径：values → { points, line, area }；<2 点时 line/area 为空串（调用方画单点光斑）
export function areaPath(values, w, h, pad = 4) {
  if (!values.length) return { points: [], line: '', area: '' };
  const max = Math.max(...values);
  const iw = w - pad * 2, ih = h - pad * 2;
  const n = values.length;
  const points = values.map((v, i) => ({
    x: +(pad + (n === 1 ? iw / 2 : (i / (n - 1)) * iw)).toFixed(2),
    y: +(h - pad - (max > 0 ? (v / max) * ih : 0)).toFixed(2),
  }));
  if (n < 2) return { points, line: '', area: '' };
  const line = 'M' + points.map((p) => `${p.x},${p.y}`).join('L');
  const area = `${line}L${points[n - 1].x},${h - pad}L${points[0].x},${h - pad}Z`;
  return { points, line, area };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/charts.test.mjs`
Expected: PASS（4 个测试全绿）

- [ ] **Step 5: Commit（需用户确认）**

```bash
git add lib/charts.js test/charts.test.mjs
git commit -m "feat(lib): 新增 charts 纯函数模块（圆环/柱状图/每日聚合/面积路径）"
```

---

### Task 2: dashboard.css 暗面色板替换为 HUD + 装饰层

**Files:**
- Modify: `dashboard/dashboard.css:1-121`（三态 token 区）、`:123-133`（body）

**Interfaces:**
- Consumes: 无
- Produces: CSS 变量 `--grid-line`、`--deco-opacity`、`--glow`、`--edge-glow`、`--tok-grad`、`--hi`、`--low`、`--crit`、`--amber`、`--amber-glow`（Task 3/4/5/6 的样式依赖这些变量名）

- [ ] **Step 1: 亮面 `:root` 追加 HUD 图形变量（亮面视觉不变，仅补变量）**

在 `dashboard/dashboard.css:42`（`--mono` 行）之后插入：

```css
  /* HUD 图形变量（亮面：仅图形组件取色，装饰层关闭） */
  --grid-line: transparent;
  --deco-opacity: 0;
  --glow: rgba(37, 99, 235, 0.20);
  --edge-glow: rgba(37, 99, 235, 0.40);
  --tok-grad: linear-gradient(90deg, #3B82F6, #8B5CF6, #EC4899);
  --hi: #0891B2;
  --low: #B45309;
  --crit: #DC2626;
  --amber: #B45309;
  --amber-glow: rgba(180, 83, 9, 0.25);
```

- [ ] **Step 2: 替换 `:root[data-theme="dark"]` 整块（dashboard.css:46-80）为 HUD 色板**

```css
/* 月之暗面 = 霓虹 HUD（深海军蓝玻璃 + 青色光晕） */
:root[data-theme="dark"] {
  --bg: #060B1C;
  --bg-2: #060B1C;
  --card: rgba(10, 20, 46, 0.78);
  --card-raise: rgba(16, 30, 62, 0.85);
  --text: #E6F1FF;
  --sub: #7C93BE;                      /* 次文（对比 #060B1C ≈ 5.8:1，>=4.5） */
  --border: rgba(56, 189, 248, 0.20);
  --border-soft: rgba(56, 189, 248, 0.14);
  --accent: #22D3EE;
  --accent-hover: #67E8F9;
  --accent-strong: #0891B2;
  --accent-soft: rgba(34, 211, 238, 0.14);
  --accent-text: #67E8F9;
  --good: #22D3EE;
  --warn: #FBBF24;
  --shadow: 0 6px 24px rgba(0, 0, 0, 0.5);
  --scheme: dark;
  --hero-grad: linear-gradient(120deg, #081026 0%, #060B1C 55%, #081427 100%);
  --moon-glow: radial-gradient(circle at 34% 34%, rgba(34, 211, 238, 0.16), rgba(34, 211, 238, 0.03) 60%, transparent);
  --moon-crescent: inset -11px -6px 0 rgba(34, 211, 238, 0.30);
  --hover-bg: rgba(34, 211, 238, 0.10);
  --detail-bg: rgba(34, 211, 238, 0.10);
  --thead-bg: rgba(56, 189, 248, 0.05);
  --bar-track: rgba(56, 189, 248, 0.14);
  --hm-empty: rgba(56, 189, 248, 0.08);
  --hm-1: #0E3A4F;                     /* 热力图档位：暗青 → 亮青 */
  --hm-2: #155E75;
  --hm-3: #0891B2;
  --hm-4: #22D3EE;
  --btn-1: #2563EB;                    /* 主按钮渐变：蓝 → 青 */
  --btn-2: #06B6D4;
  --btn-glow: rgba(34, 211, 238, 0.35);
  /* HUD 图形变量 */
  --grid-line: rgba(56, 189, 248, 0.07);
  --deco-opacity: 1;
  --glow: rgba(34, 211, 238, 0.30);
  --edge-glow: rgba(34, 211, 238, 0.45);
  --tok-grad: linear-gradient(90deg, #3B82F6, #8B5CF6, #EC4899);
  --hi: #22D3EE;
  --low: #FBBF24;
  --crit: #F87171;
  --amber: #FFC24B;
  --amber-glow: rgba(255, 194, 75, 0.30);
  --mono: ui-monospace, "SF Mono", "Cascadia Mono", Consolas, monospace;
}
```

- [ ] **Step 3: 替换 `@media (prefers-color-scheme: dark)` 块（dashboard.css:84-121）**

保持选择器 `:root:not([data-theme]), :root[data-theme="system"]` 不变，变量值与 Step 2 逐行一致（复制同一份值，含 HUD 图形变量与 `--mono`）。

- [ ] **Step 4: body 增加全息网格 + 氛围光装饰层，卡片玻璃化**

修改 `dashboard/dashboard.css:125-133` 的 `body` 规则，在其后追加：

```css
/* 全息网格：青色细网格，顶部向远处淡出；亮面 --deco-opacity=0 不显示 */
body::before {
  content: '';
  position: fixed; inset: 0; z-index: 0; pointer-events: none;
  opacity: var(--deco-opacity);
  background:
    linear-gradient(var(--grid-line) 1px, transparent 1px),
    linear-gradient(90deg, var(--grid-line) 1px, transparent 1px);
  background-size: 32px 32px;
  -webkit-mask-image: radial-gradient(120% 90% at 50% 0%, #000 30%, transparent 100%);
  mask-image: radial-gradient(120% 90% at 50% 0%, #000 30%, transparent 100%);
}
/* 页面氛围光（顶部右 + 底部左） */
body::after {
  content: '';
  position: fixed; inset: 0; z-index: 0; pointer-events: none;
  opacity: var(--deco-opacity);
  background:
    radial-gradient(50% 26% at 85% -5%, var(--glow), transparent 70%),
    radial-gradient(45% 22% at 8% 105%, var(--glow), transparent 70%);
}
.hero, .container { position: relative; z-index: 1; }
/* HUD 卡片：玻璃拟态 + hover 边缘光晕（亮面 --card 不透明、--deco 关闭，视觉不变） */
.card, .stat, .filters {
  -webkit-backdrop-filter: blur(14px);
  backdrop-filter: blur(14px);
}
:root[data-theme="dark"] .stat { transition: border-color 0.2s, box-shadow 0.2s; }
:root[data-theme="dark"] .stat:hover { border-color: var(--edge-glow); box-shadow: 0 0 18px var(--glow); }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) .stat, :root[data-theme="system"] .stat { transition: border-color 0.2s, box-shadow 0.2s; }
  :root:not([data-theme]) .stat:hover, :root[data-theme="system"] .stat:hover { border-color: var(--edge-glow); box-shadow: 0 0 18px var(--glow); }
}
```

注意：`body` 原有 `background-attachment: fixed` 保留；`.stat` 的 hover 过渡仅暗面注册，避免改变亮面。

- [ ] **Step 5: 回归验证**

Run: `node --test test/`
Expected: 既有测试全绿（本任务纯 CSS，不改变行为）。人工核对：dashboard 暗色 = HUD 观感，亮面无变化。

- [ ] **Step 6: Commit（需用户确认）**

```bash
git add dashboard/dashboard.css
git commit -m "feat(dashboard): 暗色主题替换为霓虹 HUD 色板 + 全息网格装饰层"
```

---

### Task 3: dashboard 统计卡图形化（发光数字 / 命中率圆环 / tps 柱状图 / 琥珀金成本）

**Files:**
- Modify: `dashboard/dashboard.html:54-85`（`.cards` 区）
- Modify: `dashboard/dashboard.js:1-2`（import）、`:168-175`（汇总卡赋值）
- Modify: `dashboard/dashboard.css`（`.stat` 组件样式，追加于 `.stat-note` 之后）

**Interfaces:**
- Consumes: `ringDash(rate, r)`、`sparkHeights(values, maxH)`、`dailyBuckets(records, range, now, maxDays)`（Task 1）
- Produces: DOM id `c-hit-arc`（圆环进度弧）、`c-tps-spark`（柱状图容器）；CSS 类 `.stat-line`、`.stat-ring`、`.spark`、`.stat-cost`

- [ ] **Step 1: 改 HTML——命中率卡加圆环、tps 卡加柱状图容器、成本卡加类**

`dashboard/dashboard.html:70-79` 替换为：

```html
        <div class="stat">
          <span class="stat-label">平均生成速度</span>
          <span class="stat-line">
            <span class="stat-value" id="c-tps">—</span>
            <span class="spark" id="c-tps-spark" aria-hidden="true"></span>
          </span>
          <span class="stat-note">tokens/s · 按流式时长加权</span>
        </div>
        <div class="stat">
          <span class="stat-label">缓存命中率</span>
          <span class="stat-line">
            <span class="stat-value" id="c-hit">—</span>
            <svg class="stat-ring" viewBox="0 0 24 24" aria-hidden="true">
              <circle class="rb" cx="12" cy="12" r="9"/>
              <circle class="rf" id="c-hit-arc" cx="12" cy="12" r="9"/>
            </svg>
          </span>
          <span class="stat-note">缓存读 ÷（缓存读 + 普通输入）</span>
        </div>
        <div class="stat">
          <span class="stat-label">估算花费</span>
          <span class="stat-value stat-cost" id="c-cost">—</span>
          <span class="stat-note">按价目表估算 · 未定价不计</span>
        </div>
```

- [ ] **Step 2: CSS——`.stat-line` / `.stat-ring` / `.spark` / 发光数字 / 琥珀金成本**

在 `dashboard/dashboard.css` 的 `.stat-note` 规则后追加：

```css
/* HUD 统计卡：数值行（圆环/柱状图与数字同行） */
.stat-line { display: inline-flex; align-items: center; gap: 10px; min-height: 30px; }
.stat-ring { width: 26px; height: 26px; transform: rotate(-90deg); flex: none; }
.stat-ring .rb { fill: none; stroke: var(--bar-track); stroke-width: 4; }
.stat-ring .rf {
  fill: none; stroke: var(--accent); stroke-width: 4; stroke-linecap: round;
  filter: drop-shadow(0 0 4px var(--glow));
}
/* 主数字发光（HUD 数码感） */
.stat-value { text-shadow: 0 0 12px var(--glow); }
/* 平均 t/s 迷你柱状图 */
.spark { display: inline-flex; align-items: flex-end; gap: 2px; height: 18px; }
.spark i {
  width: 4px; border-radius: 1px;
  background: linear-gradient(180deg, var(--accent), var(--accent-strong));
  box-shadow: 0 0 6px var(--glow);
}
/* 估算花费：琥珀金高亮 */
.stat-cost { color: var(--amber); text-shadow: 0 0 12px var(--amber-glow); }
```

- [ ] **Step 3: JS——引入 charts.js，渲染圆环与柱状图**

`dashboard/dashboard.js:2` 的 import 行后追加：

```js
import { ringDash, sparkHeights, dailyBuckets } from '../lib/charts.js';
```

`dashboard/dashboard.js:168-175`（`renderModelView` 汇总卡赋值段）中，`$('c-hit').textContent = fmtPct(s.cacheHitRate);` 之后追加：

```js
  // 命中率发光圆环（r=9，周长≈56.55）；无数据 → 空态仅轨道
  const rd = ringDash(s.cacheHitRate, 9);
  const arc = $('c-hit-arc');
  arc.style.strokeDasharray = String(rd.c);
  arc.style.strokeDashoffset = String(rd.off);
```

同段末尾（`$('c-cost')...` 行之后）追加：

```js
  // 平均 t/s 迷你柱状图：近 14 天每日加权 tps（与范围联动，无数据不渲染）
  const buckets = dailyBuckets(records, range, Date.now(), 14);
  const tpsVals = buckets.map((b) => (b.streamMs > 0 ? (b.output / b.streamMs) * 1000 : 0));
  $('c-tps-spark').innerHTML = sparkHeights(tpsVals, 18).map((h) => `<i style="height:${h}px"></i>`).join('');
```

注意：`renderModelView(range)` 的形参 `range` 已在作用域内，直接用。

- [ ] **Step 4: 回归验证**

Run: `node --test test/`
Expected: 全绿。人工核对：暗色下统计卡有圆环/柱状图/琥珀金成本；亮面正常显示（图形取亮面变量色）。

- [ ] **Step 5: Commit（需用户确认）**

```bash
git add dashboard/dashboard.html dashboard/dashboard.js dashboard/dashboard.css
git commit -m "feat(dashboard): 统计卡 HUD 图形化（命中率圆环/tps 柱状图/琥珀金成本）"
```

---

### Task 4: dashboard 面积趋势图（新增卡片）

**Files:**
- Modify: `dashboard/dashboard.html:86`（`.heatmap-card` 之前插入新卡）
- Modify: `dashboard/dashboard.js`（`render()` 调用 + 新增 `renderTrend`）
- Modify: `dashboard/dashboard.css`（trend 组件样式）

**Interfaces:**
- Consumes: `dailyBuckets(records, range)`、`areaPath(values, w, h, pad)`（Task 1）
- Produces: DOM id `trend`、`trend-sub`；CSS 类 `.trend-card`、`.trend-body`、`.trend-line`、`.trend-area`、`.trend-dot`

- [ ] **Step 1: HTML——在热力图卡之前插入趋势卡**

`dashboard/dashboard.html:87`（`<div class="card heatmap-card">`）之前插入：

```html
      <div class="card trend-card">
        <div class="heatmap-head">
          <div style="min-width:0;">
            <div class="heatmap-title">用量趋势</div>
            <div class="heatmap-sub" id="trend-sub">按本地日聚合</div>
          </div>
        </div>
        <div id="trend" class="trend-body"></div>
      </div>
```

- [ ] **Step 2: CSS**

`dashboard/dashboard.css` 热力图样式区之前（`.heatmap-card` 规则前）追加：

```css
/* ── 用量趋势面积图（霓虹渐变 + 发光描边） ────────── */
.trend-card { padding: 16px 18px 14px; margin-top: 16px; }
.trend-body { height: 140px; }
.trend-body svg { width: 100%; height: 100%; display: block; }
.trend-line {
  fill: none; stroke: var(--accent); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round;
  filter: drop-shadow(0 0 5px var(--glow));
}
.trend-dot { fill: var(--accent); filter: drop-shadow(0 0 6px var(--glow)); }
.trend-base { stroke: var(--bar-track); stroke-width: 1; }
```

- [ ] **Step 3: JS——新增 `renderTrend(range)` 并接入 `render()`**

`dashboard/dashboard.js` 中 `renderHeatmap()` 函数定义之前插入：

```js
// 用量趋势面积图：复用每日聚合（与热力图同口径），随时间范围联动。
// 数据 <2 点 → 单点光斑 + 基线；无数据 → 空态文案。
function renderTrend(range) {
  const box = $('trend');
  if (!box) return;
  const buckets = dailyBuckets(records, range);
  $('trend-sub').textContent = buckets.length ? `近 ${buckets.length} 天 · 每日合计 tokens` : '按本地日聚合';
  if (!buckets.length || buckets.every((b) => b.total === 0)) {
    box.innerHTML = '<div class="empty">该时间段暂无用量记录</div>';
    return;
  }
  const values = buckets.map((b) => b.total);
  const W = 600, H = 140, PAD = 8;
  const { points, line, area } = areaPath(values, W, H, PAD);
  const last = points[points.length - 1];
  const ymd = (ts) => { const d = new Date(ts); return `${d.getMonth() + 1}/${d.getDate()}`; };
  box.innerHTML =
    `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="每日用量趋势">` +
    `<defs><linearGradient id="trend-fill" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" style="stop-color:var(--accent);stop-opacity:0.35"/>` +
    `<stop offset="1" style="stop-color:var(--accent);stop-opacity:0"/>` +
    `</linearGradient></defs>` +
    `<line class="trend-base" x1="${PAD}" y1="${H - PAD}" x2="${W - PAD}" y2="${H - PAD}"/>` +
    (area ? `<path class="trend-area" d="${area}" fill="url(#trend-fill)"/>` : '') +
    (line ? `<path class="trend-line" d="${line}"/>` : '') +
    (last ? `<circle class="trend-dot" cx="${last.x}" cy="${last.y}" r="3.5"/>` : '') +
    `<text x="${PAD}" y="${H - 1}" font-size="9" fill="var(--sub)">${ymd(buckets[0].ts)}</text>` +
    `<text x="${W - PAD}" y="${H - 1}" font-size="9" fill="var(--sub)" text-anchor="end">${ymd(buckets[buckets.length - 1].ts)}</text>` +
    `</svg>`;
}
```

`render()`（dashboard.js:146-151）中 `renderHeatmap();` 之前加一行：

```js
  renderTrend(range);
```

注意：`preserveAspectRatio="none"` 下 `text` 会被拉伸——把两处 `<text>` 的 `font-size` 保持 9 并接受轻微拉伸，或改为 `preserveAspectRatio="xMidYMid meet"`。实现时若字体拉伸观感差，改为外层包 `<div class="trend-axis">` 放两个 span（首选此方案，CSS 用 `display:flex;justify-content:space-between;font-size:10px;color:var(--sub);`）。

- [ ] **Step 4: 回归验证**

Run: `node --test test/`
Expected: 全绿。人工核对：今日（单点光斑）/ 近 7 天（面积图）/ 无数据（空态文案）三种形态。

- [ ] **Step 5: Commit（需用户确认）**

```bash
git add dashboard/dashboard.html dashboard/dashboard.js dashboard/dashboard.css
git commit -m "feat(dashboard): 新增用量趋势面积图卡片"
```

---

### Task 5: dashboard 模型表格行组件化（渐变条 + 圆环）

**Files:**
- Modify: `dashboard/dashboard.js:123-131`（`hitCell`）、`:181-196`（模型行模板）
- Modify: `dashboard/dashboard.css:351-358`（`.hitbar` 块替换）、`:341-343`（`td.total` 改造）

**Interfaces:**
- Consumes: `ringDash(rate)`（Task 1，默认 r=7.5）
- Produces: CSS 类 `.tok`、`.tok-num`、`.tok-bar`、`.hit.hi/.mid/.low/.crit`、`.hit .ring/.rb/.rf`（与 panel 同名同构）

- [ ] **Step 1: JS——`hitCell` 改为圆环**

`dashboard/dashboard.js:123-131` 整个 `hitCell` 函数替换为：

```js
// 命中率单元格：彩色数值 + 发光圆环（等级与 panel 同口径：≥90 hi / ≥70 mid / ≥50 low / 其余 crit）
function hitCell(rate) {
  if (rate == null) return '<td class="num">—</td>';
  const lv = rate >= 0.9 ? 'hi' : rate >= 0.7 ? 'mid' : rate >= 0.5 ? 'low' : 'crit';
  const rd = ringDash(rate);
  return `<td><span class="hit ${lv}">
    <b>${fmtPct(rate)}</b>
    <svg class="ring" viewBox="0 0 20 20" aria-hidden="true"><circle class="rb" cx="10" cy="10" r="7.5"/><circle class="rf" cx="10" cy="10" r="7.5" style="stroke-dasharray:${rd.c};stroke-dashoffset:${rd.off}"/></svg>
  </span></td>`;
}
```

- [ ] **Step 2: JS——模型行合计列加渐变条**

`dashboard/dashboard.js:181-196` 行模板中，先在 `tbody.innerHTML = rows.map(...)` 之前计算：

```js
    const maxTotal = Math.max(...rows.map((r) => r.total), 1);
```

再把 `<td class="total">${fmtNum(r.total)}</td>` 替换为：

```js
        <td class="total"><div class="tok"><span class="tok-num">${fmtNum(r.total)}</span><span class="tok-bar"><i style="width:${((r.total / maxTotal) * 100).toFixed(1)}%"></i></span></div></td>
```

- [ ] **Step 3: CSS——`.hitbar` 块替换为圆环 + tok 组件**

`dashboard/dashboard.css:351-358`（`.hit` 到 `.hitpct`）替换为：

```css
/* 命中率：彩色数值 + 发光圆环（与 panel 同构） */
.hit { display: inline-flex; align-items: center; justify-content: flex-end; gap: 6px; }
.hit b { font-family: var(--mono); font-weight: 700; font-size: 12.5px; }
.hit .ring { width: 16px; height: 16px; transform: rotate(-90deg); flex: none; }
.hit .rb { fill: none; stroke: var(--bar-track); stroke-width: 3.5; }
.hit .rf {
  fill: none; stroke: currentColor; stroke-width: 3.5; stroke-linecap: round;
  filter: drop-shadow(0 0 3px currentColor);
}
.hit.hi b, .hit.hi .ring { color: var(--hi); }
.hit.mid b, .hit.mid .ring { color: var(--accent); }
.hit.low b, .hit.low .ring { color: var(--low); }
.hit.crit b, .hit.crit .ring { color: var(--crit); }

/* 合计 tokens：发光数码 + 霓虹渐变条 */
.tok { display: flex; flex-direction: column; align-items: stretch; gap: 3px; min-width: 90px; }
.tok-num { text-align: right; text-shadow: 0 0 10px var(--glow); }
.tok-bar { height: 4px; border-radius: 99px; background: var(--bar-track); overflow: hidden; }
.tok-bar i { display: block; height: 100%; border-radius: 99px; background: var(--tok-grad); box-shadow: 0 0 8px var(--glow); }
```

`td.total` 规则（:342）保持不变（加粗等宽字体作用于 `.tok-num` 继承即可）。

- [ ] **Step 4: 回归验证**

Run: `node --test test/`
Expected: 全绿。人工核对：模型表命中率列圆环四档配色、合计列渐变条按最大值归一。

- [ ] **Step 5: Commit（需用户确认）**

```bash
git add dashboard/dashboard.js dashboard/dashboard.css
git commit -m "feat(dashboard): 模型表命中率圆环 + 合计渐变条（与 panel 同构）"
```

---

### Task 6: panel 补齐——tps 迷你柱状图 + 主题文案 HUD 化

**Files:**
- Modify: `panel/panel.js:14-17`（主题文案）、`:48-68`（render 表格）
- Modify: `panel/panel.css:206-207`（`td.ts` 块）

**Interfaces:**
- Consumes: `sparkHeights(values, maxH, max)`（Task 1）
- Produces: panel 无对外接口

- [ ] **Step 0: 先检查 popup 是否有同样的主题文案**

Run: `grep -n "月之暗面\|THEME_LABEL\|THEME_NAME" popup/popup.js popup/popup.html`
若有 `dark` 对应文案，同步按下述规则改。

- [ ] **Step 1: JS——主题文案**

`panel/panel.js:16-17`：

```js
const THEME_LABEL = { light: '亮', dark: 'HUD', system: '跟随' };
const THEME_NAME = { light: '月之亮面', dark: '霓虹 HUD', system: '跟随系统' };
```

`dashboard/dashboard.html:120` 的主题 pill 同步改：

```html
              <button data-theme-opt="dark" class="pill" title="霓虹 HUD">HUD</button>
```

`dashboard/dashboard.js:58-61` 与 `panel/panel.js:13` 的注释里「月之暗面」字样同步改为「霓虹 HUD」。

- [ ] **Step 2: JS——tps 列加迷你柱状图**

`panel/panel.js` 顶部 import 行（:2 之后）加：

```js
import { ringDash, sparkHeights } from '../lib/charts.js';
```

`panel/panel.js:52-65`：把内联 `RING_C` 逻辑换用 `ringDash`，并给 tps 列加柱状图。替换 `render()` 内对应段为：

```js
  // 霓虹 HUD 图形化：token 条按最大值归一；命中率圆环经 ringDash；tps 迷你柱按表内最大值归一
  const maxTotal = Math.max(...rows.map((r) => r.total), 1);
  const maxTps = Math.max(...rows.map((r) => r.tokensPerSec || 0), 0);
  $('tbody').innerHTML = rows.length
    ? rows.map((r) => {
        const rate = r.cacheHitRate;
        const lv = rate == null ? 'mid' : rate >= 0.9 ? 'hi' : rate >= 0.7 ? 'mid' : rate >= 0.5 ? 'low' : 'crit';
        const rd = ringDash(rate);
        const barW = ((r.total / maxTotal) * 100).toFixed(1);
        const tpsH = sparkHeights([r.tokensPerSec || 0], 12, maxTps)[0];
        return `<tr>
        <td title="${esc(r.key)}">${esc(r.displayName)}${r.configured ? '' : '<span class="badge">未配置</span>'}</td>
        <td><div class="tok"><span class="tok-num">${fmtNum(r.total)}</span><span class="tok-bar"><i style="width:${barW}%"></i></span></div></td>
        <td><span class="hit ${lv}"><b>${fmtPct(rate)}</b><svg class="ring" viewBox="0 0 20 20" aria-hidden="true"><circle class="rb" cx="10" cy="10" r="7.5"/><circle class="rf" cx="10" cy="10" r="7.5" style="stroke-dasharray:${rd.c};stroke-dashoffset:${rd.off}"/></svg></span></td>
        <td class="ts"><span class="ts-num">${r.tokensPerSec == null ? '—' : r.tokensPerSec.toFixed(1)}</span><span class="spark">${tpsH ? `<i style="height:${tpsH}px"></i>` : ''}</span></td>
      </tr>`;
      }).join('')
    : '<tr><td colspan="4" class="empty">暂无用量记录</td></tr>';
```

- [ ] **Step 3: CSS——`td.ts` 改造**

`panel/panel.css:206-207`（`td.ts` 规则）替换为：

```css
/* 平均 t/s：数码字 + 迷你柱状图 */
td.ts .ts-num { font-family: var(--mono); text-shadow: 0 0 8px var(--glow); }
td.ts { white-space: nowrap; }
.ts-num { margin-right: 6px; }
.spark { display: inline-flex; align-items: flex-end; gap: 2px; height: 12px; vertical-align: -1px; }
.spark i {
  display: block; width: 4px; border-radius: 1px;
  background: linear-gradient(180deg, var(--accent), var(--mid));
  box-shadow: 0 0 6px var(--glow);
}
```

- [ ] **Step 4: 回归验证**

Run: `node --test test/`
Expected: 全绿。人工核对：panel 的 tps 列出现发光小柱；主题按钮循环显示「亮/HUD/跟随」；dashboard 主题 pill 显示「HUD」。

- [ ] **Step 5: Commit（需用户确认）**

```bash
git add panel/panel.js panel/panel.css panel/panel.html dashboard/dashboard.html dashboard/dashboard.js popup/
git commit -m "feat(panel): tps 迷你柱状图 + 暗色主题文案改为霓虹 HUD"
```

---

### Task 7: 适度动效 + reduced-motion + 全量回归

**Files:**
- Modify: `dashboard/dashboard.css`、`panel/panel.css`（末尾追加动效块）

**Interfaces:**
- Consumes: Task 3/4/5/6 产出的类名（`.stat-value`、`.rf`、`.tok-bar i`、`.spark i`、`.trend-line`）
- Produces: 无新接口

- [ ] **Step 1: dashboard.css 末尾追加动效块**

```css
/* ── HUD 动效（适度）：数字淡入、圆环/渐变条/柱状图生长、面积图描边 ── */
@keyframes hud-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
@keyframes hud-grow { from { transform: scaleY(0); } to { transform: scaleY(1); } }
@keyframes hud-draw { to { stroke-dashoffset: 0; } }
.stat-value { animation: hud-in 0.3s ease-out; }
.hit .rf, .stat-ring .rf { transition: stroke-dashoffset 0.4s ease-out; }
.tok-bar i { transition: width 0.4s ease-out; }
.spark i { transform-origin: bottom; animation: hud-grow 0.4s ease-out; }
.trend-line { stroke-dasharray: 2000; stroke-dashoffset: 2000; animation: hud-draw 0.6s ease-out forwards; }
@media (prefers-reduced-motion: reduce) {
  .stat-value, .spark i, .trend-line { animation: none; }
  .hit .rf, .stat-ring .rf, .tok-bar i { transition: none; }
  .trend-line { stroke-dasharray: none; stroke-dashoffset: 0; }
}
```

注意：`.stat-value` 的入场动画只在节点首次插入时播放（后续 textContent 更新不重放），符合预期。`.trend-line` 的 dasharray 2000 大于实际路径长度（600 宽曲线 < 1500），保证从全隐藏开始描边。

- [ ] **Step 2: panel.css 末尾追加同样的 reduced-motion 守卫**

```css
/* 动效守卫：减少动态时关闭过渡 */
.hit .rf { transition: stroke-dashoffset 0.4s ease-out; }
.tok-bar i { transition: width 0.4s ease-out; }
.spark i { transform-origin: bottom; animation: hud-grow 0.4s ease-out; }
@keyframes hud-grow { from { transform: scaleY(0); } to { transform: scaleY(1); } }
@media (prefers-reduced-motion: reduce) {
  .hit .rf, .tok-bar i { transition: none; }
  .spark i { animation: none; }
}
```

- [ ] **Step 3: 全量回归**

Run: `node --test test/`
Expected: 全部测试（含既有 6 个文件 + charts.test.mjs）全绿。

- [ ] **Step 4: 人工验收清单（写进完成报告，逐项确认）**

- dashboard 暗色：网格 + 光晕背景、玻璃卡、发光数字、命中率圆环、tps 柱状图、面积图（今日/7 天/全部三档）
- dashboard 亮色：与改造前一致，新增图形取亮面色
- panel：tps 迷你柱、琥珀金成本、主题按钮「亮/HUD/跟随」
- 系统主题切换时 dashboard/panel 即时跟随
- 开启系统「减少动态效果」后无动画

- [ ] **Step 5: Commit（需用户确认）**

```bash
git add dashboard/dashboard.css panel/panel.css
git commit -m "feat: HUD 适度动效（生长/描边/淡入）+ reduced-motion 守卫"
```

---

## Self-Review 记录

- 规格覆盖：§4 主题机制 → Task 2/6；§5 panel → Task 6；§6.1 统计卡 → Task 3；§6.2 面积图 → Task 4；§6.3 表格 → Task 5；§6.4 热力图保留（仅色板变量替换，Task 2 覆盖）；§7 动效 → Task 7；§8 边界 → Task 1 单测 + Task 4 空态；§9 测试 → Task 1 + 各任务回归步。
- 类型一致性：`ringDash`/`sparkHeights`/`dailyBuckets`/`areaPath` 签名在 Task 1 定义，Task 3/4/5/6 调用处逐一核对一致。
- 已知留白：Task 4 Step 3 中 SVG text 拉伸问题给了首选替代方案（外层 div 轴标签），实现时择一，不算占位符。
