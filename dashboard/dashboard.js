import { LOGO_SVG } from '../lib/brand.js';
import { rangeBounds, aggregateByModel, aggregateBySession, interruptStats, summarize, recordUsage, fmtNum, fmtPct, fmtCost } from '../lib/aggregate.js';
import { ringDash, sparkHeights, dailyBuckets } from '../lib/charts.js';
import { DEFAULT_PRICE_TABLE, priceKey, getPriceEntry, calcCostAt, costWithPrice, resolvePrice } from '../lib/pricing.js';
import { PRICE_HEAD_HTML, priceItemEl, resetItemEl, readPriceTable } from '../lib/price-editor.js';
import * as store from '../lib/store.js';
import { ensureReadPermission, scanKimiHome } from '../lib/scanner.js';

const $ = (id) => document.getElementById(id);
let dirHandle = null;
let models = [];
let records = [];
let markers = []; // 中断标记（store.loadAllMarkers），经 range 过滤后用于会话中断统计
let workspaces = {}; // { wd_xxx: { name } }，scanner 从 workspaces.json 读
let priceOverrides = null; // 生效价目表覆盖（含默认播种），启动时 initPriceTable 填充
let rangeKey = 'today';
let view = 'model'; // 'model' | 'session'，模型 / 会话视图切换
// 热力图点击选中的日（'YYYY-MM-DD' | null）。存在时 render() 把 range 覆盖为当天 [0点,次日0点)，
// 表格/汇总/中断卡按当天渲染；时间筛选或视图切换时清空（见 filters/views 处理器），不持久化。
let selectedDate = null;
// 显示全部开关：默认折叠零用量模型（只显示有记录的行），开启后显示含零用量已配置模型。localStorage 持久化。
let showZeroModels = localStorage.getItem('kus-show-zero-models') === '1';
let sessionDetailMap = new Map(); // groupkey(wd::sid) → 会话下钻详情，renderSession 时重建

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtTime = (t) => (t ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '—');
const fmtTps = (v) => (v == null ? '—' : v.toFixed(1));

// 会话视图友好的相对时间：今天/昨天 MM-DD HH:mm，避免完整时间戳占宽
const fmtRelTime = (t) => {
  if (!t) return '—';
  const d = new Date(t), now = new Date();
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (sameDay(d, now)) return `今天 ${hm}`;
  if (sameDay(d, new Date(now.getTime() - 86400000))) return `昨天 ${hm}`;
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hm}`;
};

// 会话时长：<1m 显示秒，<1h 显示 m，否则 h+m
const fmtDur = (ms) => {
  if (!(ms > 0)) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
};

// 'YYYY-MM-DD' → 当天本地日 0 点起整日范围 [from, to)。月/日越界由 Date 自动回卷，天然覆盖月末/年末。
const ymdDayRange = (ymd) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return { from: new Date(y, m - 1, d).getTime(), to: new Date(y, m - 1, d + 1).getTime() };
};

function show(section) {
  for (const id of ['onboarding', 'reauth', 'main']) $(id).hidden = id !== section;
}

// ── 三态主题（月之亮面 / 霓虹 HUD / 跟随系统） ──────────────
// 共享状态键 kus-theme，三端（dashboard/panel/popup）同源共享。
// 值写入 <html data-theme>；'light'/'dark' 走 CSS 显式 token，
// 'system' 由 CSS media query 实时跟随系统，无需额外重算。
const THEME_KEY = 'kus-theme';
const THEME_MODES = ['light', 'dark', 'system'];

function readThemePref() {
  let v = null;
  try { v = localStorage.getItem(THEME_KEY); } catch { /* 隐私模式/受限等场景忽略，回退 system */ }
  return THEME_MODES.includes(v) ? v : 'system';
}
let themePref = readThemePref();

function applyTheme(pref) {
  themePref = pref;
  document.documentElement.dataset.theme = pref; // 'light'|'dark'|'system'
  // 同步控件：高亮当前模式 pill（文字即「亮/暗/跟随」简单中文名）
  document.querySelectorAll('#theme .pill').forEach((b) =>
    b.classList.toggle('active', b.dataset.themeOpt === pref)
  );
}

function setTheme(pref) {
  if (!THEME_MODES.includes(pref)) pref = 'system';
  applyTheme(pref);
  try { localStorage.setItem(THEME_KEY, themePref); } catch { /* 隐私模式等场景忽略 */ }
}

// 仅 system 模式下需要监听系统切换（直接重写为 'system'，由 CSS 实时驱动视觉）
const themeMq = window.matchMedia('(prefers-color-scheme: dark)');
function onSystemThemeChange() {
  if (themePref === 'system') {
    delete document.documentElement.dataset.theme;
    requestAnimationFrame(() => { document.documentElement.dataset.theme = 'system'; });
  }
}

function initTheme() {
  applyTheme(themePref);
  themeMq.addEventListener('change', onSystemThemeChange);
  const group = $('theme');
  if (group) {
    group.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-theme-opt]');
      if (btn) setTheme(btn.dataset.themeOpt);
    });
  }
}
initTheme(); // 模块为 deferred，DOM 已就绪（无 html 属性时 CSS 已按系统主题渲染，无闪烁）

async function refresh() {
  $('btn-rescan').disabled = true;
  try {
    const res = await scanKimiHome(dirHandle);
    models = res.models;
    workspaces = res.workspaces || {};
    records = await store.loadAllRecords();
    markers = await store.loadAllMarkers();
    render();
  } finally {
    $('btn-rescan').disabled = false;
  }
}

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

function render() {
  document.querySelectorAll('#filters .pill').forEach((b) => b.classList.toggle('active', b.dataset.range === rangeKey));
  document.querySelectorAll('#views .pill').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $('model-table').hidden = view !== 'model';
  $('session-table').hidden = view !== 'session';

  // 有效范围：选中日期时覆盖为当天 [0点,次日0点)，否则按 rangeKey
  const range = selectedDate ? ymdDayRange(selectedDate) : rangeBounds(rangeKey);
  const from = range.from, to = range.to;
  // 中断轮次集合：range 内被中断的 turnId（口径与 interruptStats 一致：按 marker.time 过滤）
  const interruptedTurnSet = new Set();
  for (const m of markers) if (m && m.turnId && m.time >= from && (to == null || m.time < to)) interruptedTurnSet.add(m.turnId);

  renderModelView(range);
  renderSessionView(range, interruptedTurnSet);
  renderInterruptCard(range, interruptedTurnSet);
  renderHeatmap();
  renderDayDetail(range);
  renderDateChip();

  const meta = store.getMeta('lastScanResult');
  const at = store.getMeta('lastScanAt');
  Promise.all([meta, at]).then(([res, t]) => {
    $('footer-info').textContent =
      `共 ${records.length} 条记录 · 上次扫描 ${t ? fmtTime(t) : '—'}` + (res?.skippedLines ? ` · 已跳过 ${res.skippedLines} 行` : '');
  });
}

// 模型视图：现有表格（缓存写列已清除，合计/命中率口径不变）
function renderModelView(range) {
  // 默认折叠零用量：只显示有记录的模型；「显示全部」开启时再列出已配置零用量模型
  const allRows = aggregateByModel(records, models, range, priceOverrides);
  const rows = allRows.filter((r) => r.requests > 0 || (showZeroModels && r.configured));

  // 汇总卡（只统计有用量的行，零用量行不影响求和但避免误导读者的请求数）
  const s = summarize(rows.filter((r) => r.requests > 0));
  $('c-total').textContent = fmtNum(s.total);
  $('c-requests').textContent = s.requests;
  $('c-output').textContent = fmtNum(s.output);
  $('c-tps').textContent = fmtTps(s.tokensPerSec);
  $('c-hit').textContent = fmtPct(s.cacheHitRate);
  // 命中率发光圆环（r=9，周长≈56.55）；无数据 → 空态仅轨道
  const rd = ringDash(s.cacheHitRate, 9);
  const arc = $('c-hit-arc');
  arc.style.strokeDasharray = String(rd.c);
  arc.style.strokeDashoffset = String(rd.off);
  // 没有任何模型被定价时显示 —（与表格/panel 口径一致），而非 ¥0.00
  $('c-cost').textContent = rows.some((r) => r.cost != null) ? fmtCost(s.cost) : '—';
  // 峰谷汇总：高峰 / 低谷各自的花费（单一计价模型的花费单列，便于区分口径）
  const touEl = $('c-cost-tou');
  if (touEl) {
    if (s.tou) {
      const parts = [`峰 ${fmtCost(s.tier.peak.cost)}`, `谷 ${fmtCost(s.tier.offpeak.cost)}`];
      if (s.tier.flat.cost > 0) parts.push(`单一价 ${fmtCost(s.tier.flat.cost)}`);
      touEl.textContent = parts.join(' · ');
      touEl.title =
        `高峰 ${fmtNum(s.tier.peak.token)} tokens → ${fmtCost(s.tier.peak.cost)}\n` +
        `低谷 ${fmtNum(s.tier.offpeak.token)} tokens → ${fmtCost(s.tier.offpeak.cost)}` +
        (s.tier.flat.cost > 0 ? `\n单一计价 ${fmtNum(s.tier.flat.token)} tokens → ${fmtCost(s.tier.flat.cost)}` : '');
      touEl.hidden = false;
    } else {
      touEl.textContent = '当前无峰谷计价模型';
      touEl.title = '在「价目表」里为模型添加高峰/低谷时段即可启用峰谷计价';
      touEl.hidden = false;
    }
  }
  // 平均 t/s 迷你柱状图：近 14 天每日加权 tps（与范围联动，无数据不渲染）
  const buckets = dailyBuckets(records, range, Date.now(), 14);
  const tpsVals = buckets.map((b) => (b.streamMs > 0 ? (b.output / b.streamMs) * 1000 : 0));
  $('c-tps-spark').innerHTML = sparkHeights(tpsVals, 18).map((h) => `<i style="height:${h}px"></i>`).join('');

  const tbody = $('tbody');
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="11" class="empty">该时间段暂无用量记录</td></tr>`;
  } else {
    const maxTotal = Math.max(...rows.map((r) => r.total), 1);
    tbody.innerHTML = rows.map((r) => {
      const badge = (r.configured ? '' : '<span class="badge">未在配置中</span>')
        + (r.tou ? '<span class="badge tou" title="该模型启用了峰谷计价，花费按记录发生时间分时段计算">峰谷</span>' : '');
      // 花费单元格：仅「启用峰谷」的模型在金额下方补一行「峰 / 谷」拆分。
      // 单一价模型的 tiers 恒为 0（它全在 flat 桶里），显示「峰 ¥0.00 · 谷 ¥0.00」会误导。
      const costCell = r.cost == null
        ? '—'
        : `${fmtCost(r.cost)}${r.tou
          ? `<span class="cost-tou" title="高峰 ${fmtCost(r.tiers.peak.cost)} · 低谷 ${fmtCost(r.tiers.offpeak.cost)}">峰 ${fmtCost(r.tiers.peak.cost)} · 谷 ${fmtCost(r.tiers.offpeak.cost)}</span>`
          : ''}`;
      return `<tr class="model-row" data-key="${esc(r.key)}">
        <td class="model-name">${esc(r.displayName)}${badge}</td>
        <td class="num">${fmtNum(r.inputOther)}</td>
        <td class="num">${fmtNum(r.inputCacheRead)}</td>
        ${hitCell(r.cacheHitRate)}
        <td class="num">${fmtNum(r.output)}</td>
        <td class="total"><div class="tok"><span class="tok-num">${fmtNum(r.total)}</span><span class="tok-bar"><i style="width:${((r.total / maxTotal) * 100).toFixed(1)}%"></i></span></div></td>
        <td class="num cost-cell">${costCell}</td>
        <td class="num">${r.requests}</td>
        <td class="num">${fmtTps(r.tokensPerSec)}</td>
        <td class="num">${fmtTps(r.lastTokensPerSec)}</td>
        <td class="num">${fmtTime(r.lastTime)}</td>
      </tr>`;
    }).join('');
  }
}

// 会话视图：aggregateBySession 行 + 预计算的会话下钻详情
function renderSessionView(range, interruptedTurnSet) {
  const rows = aggregateBySession(records, models, range, priceOverrides, {
    workspaces,
    interruptedTurnIds: interruptedTurnSet,
  });
  sessionDetailMap = buildSessionDetail(range, interruptedTurnSet);
  // 把会话显示名(完整 UUID)挂到下钻 map,展开时可见
  for (const r of rows) {
    const d = sessionDetailMap.get(r.key);
    if (d) d.displayName = r.displayName;
  }

  const tbody = $('session-tbody');
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="empty">该时间段暂无会话记录</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((r, i) => {
    const inter = r.interruptCount > 0 ? `<span class="session-inter" title="${r.interruptCount} 个被打断轮次">${r.interruptCount} 轮</span>` : '—';
    const models = r.models || [];
    const modelCell = models.length
      ? `${esc(models[0])}${models.length > 1 ? ` <span class="session-more" title="${esc(models.join(', '))}">+${models.length - 1}</span>` : ''}`
      : '—';
    return `<tr class="session-row" data-groupkey="${esc(r.key)}" tabindex="0">
      <td>${esc(r.workspaceName)}</td>
      <td class="session-name" title="${esc(r.displayName)}">#${i + 1}</td>
      <td class="num">${fmtRelTime(r.startTime)}</td>
      <td class="num">${fmtDur(r.endTime - r.startTime)}</td>
      <td class="session-models">${modelCell}</td>
      <td class="num">${fmtNum(r.totalToken)}</td>
      <td class="num">${fmtCost(r.cost)}</td>
      <td class="num">${r.requests}</td>
      <td class="num">${inter}</td>
    </tr>`;
  }).join('');
}

// 中断汇总卡：打断轮次去重数 + 消耗 token + 估算金额；无中断 → —
function renderInterruptCard(range, interruptedTurnSet) {
  const s = interruptStats(records, markers, models, range, priceOverrides);
  if (interruptedTurnSet.size > 0) {
    $('c-interrupt').textContent = `${s.turns} 轮 · ${fmtNum(s.totalToken)} tokens · ${fmtCost(s.cost)}`;
    $('c-interrupt-note').textContent = '被打断轮次唯一数 · 消耗估算';
  } else {
    $('c-interrupt').textContent = '—';
    $('c-interrupt-note').textContent = '被打断轮次 token 估算';
  }
}

// 每日消耗热力图（GitHub 风格 365 天日历）：数据从 records 按本地日现算。
// 口径与 aggregateByModel 一致：dayTotal = 未命中+缓存读+缓存写+输出；
// 花费 = 逐条按记录发生时间取价（支持峰谷；缓存写归入 input，未定价不计 → '—'）。
// 窗口 = max(最早记录本地日, today-364 天 0 点) 至今，最多 365 天。
// 布局：列 = 周（周一为每周起点，首列顶部补空），行 = 周一..周日；每格 13px；
// 颜色按当日 total 分 5 档（0=空档，1-4 依 max 的 25/50/75% 分档）；今日格描边高亮。
function renderHeatmap() {
  const $grid = $('heatmap');
  if (!$grid) return;
  const DAY = 86400000;
  const now = Date.now();
  const dayStart = (ts) => { const d = new Date(ts); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
  const mondayRow = (ts) => (new Date(ts).getDay() + 6) % 7; // 周一=0 .. 周日=6

  const todayStart = dayStart(now);
  let from = todayStart - 364 * DAY; // 兜底起点：today 前 364 天（含 today 共 365 天）
  let earliestDay = null;
  for (const r of records) {
    if (typeof r.time !== 'number') continue;
    const ds = dayStart(r.time);
    if (earliestDay == null || ds < earliestDay) earliestDay = ds;
  }
  // 窗口起点 = max(最早记录本地日, today-364)；早期记录早于一年的不再拉长窗口
  if (earliestDay != null && earliestDay > from) from = earliestDay;
  const days = Math.round((todayStart - from) / DAY) + 1; // 1..365

  $('heatmap-title').textContent = '每日消耗热力图';
  $('heatmap-sub').textContent = `近 ${days} 天 · 悬停看明细`;

  // 模型 key 解析（与 buildSessionDetail / renderTrend 原口径一致）；缓存写归入 input。
  const knownKeys = new Set(models.map((m) => m.key));
  const resolveKey = (m) => {
    if (knownKeys.has(m)) return m;
    for (const k of knownKeys) if (k.endsWith('/' + m)) return k;
    return m;
  };
  const recCost = (r) => calcCostAt(resolveKey(r.model), recordUsage(r), priceOverrides, r.time);

  const bucketByDay = new Map(); // ds → { total, cost, hasCost }
  for (const r of records) {
    if (typeof r.time !== 'number') continue;
    const ds = dayStart(r.time);
    if (ds < from || ds > todayStart) continue;
    let b = bucketByDay.get(ds);
    if (!b) { b = { total: 0, cost: 0, hasCost: false }; bucketByDay.set(ds, b); }
    b.total += (r.inputOther || 0) + (r.inputCacheRead || 0) + (r.inputCacheCreation || 0) + (r.output || 0);
    const c = recCost(r);
    if (c != null) { b.cost += c; b.hasCost = true; }
  }

  const noRecords = !records.length;
  const noData = noRecords || bucketByDay.size === 0;
  if (noData) {
    $grid.innerHTML = `<div class="empty">${noRecords
      ? '暂无消耗记录。授权扫描后将展示近 365 天每日消耗热力图。'
      : '近 365 天窗口内无记录，可调节时间范围或检查数据。'}</div>`;
    return;
  }

  let maxTok = 0;
  for (const b of bucketByDay.values()) if (b.total > maxTok) maxTok = b.total;

  // 网格：8 基行（行 1=月份、行 2..8=周一..周日），列 1=周几标签、列 2..N+1=周
  const offset = mondayRow(from); // 首列顶部需补的空格数（0..6）
  const dayLabels = [['周一', 0], ['周三', 2], ['周五', 4], ['周日', 6]]
    .map(([t, r]) => `<span class="hm-dl" style="grid-row:${r + 2}">${t}</span>`).join('');
  const months = [];
  const cells = [];
  for (let i = 0; i < days; i++) {
    const ds = from + i * DAY;
    const d = new Date(ds);
    const col = Math.floor((i + offset) / 7);
    const b = bucketByDay.get(ds);
    const total = b ? b.total : 0;
    let lvl = 0;
    if (total > 0) {
      const frac = total / maxTok;
      lvl = frac <= 0.25 ? 1 : frac <= 0.5 ? 2 : frac <= 0.75 ? 3 : 4;
    }
    const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const costStr = b && b.hasCost ? fmtCost(b.cost) : '—';
    const tip = b ? `${ymd} · ${fmtNum(total)} tokens · ${costStr}` : `${ymd} · 无记录`;
    const cls = ['hm-cell', lvl ? `l${lvl}` : '', ds === todayStart ? 'today' : '', selectedDate === ymd ? 'selected' : ''].filter(Boolean).join(' ');
    cells.push(`<span class="${cls}" data-date="${ymd}" title="${esc(tip)}" role="button" tabindex="0" aria-label="${ymd} 消耗详情" style="grid-row:${mondayRow(ds) + 2};grid-column:${col + 2}"></span>`);
    if (d.getDate() === 1) months.push(`<span class="hm-month" style="grid-column:${col + 2}">${d.getMonth() + 1}月</span>`);
  }

  const legend = ['', 'l1', 'l2', 'l3', 'l4']
    .map((c) => `<span class="hm-legend-cell ${c}"></span>`).join('');
  $grid.innerHTML =
    `<div class="heatmap-grid">${dayLabels}${months.join('')}${cells.join('')}</div>` +
    `<div class="heatmap-legend"><span class="hm-legend-label">少</span>${legend}<span class="hm-legend-label">多</span></div>`;
}

// 当日详情面板：未选中显示默认提示，选中后显示日期标题 + 概要 + 该天模型明细 mini 表 + 清除按钮。
function renderDayDetail(range) {
  const box = $('heatmap-day-detail');
  if (!box) return;
  if (!selectedDate) {
    box.innerHTML = '<span class="hm-dd-hint">点击日期查看当日明细</span>';
    return;
  }
  // 该天模型明细：aggregateByModel + 当天范围，仅显示有记录（requests>0）的行
  const rows = aggregateByModel(records, models, range, priceOverrides).filter((r) => r.requests > 0);
  const s = summarize(rows);
  const tbody = rows.length
    ? rows.map((r) => {
        const badge = r.configured ? '' : '<span class="badge">未配置</span>';
        return `<tr>
          <td>${esc(r.displayName)}${badge}</td>
          <td class="num">${fmtNum(r.inputOther)}</td>
          <td class="num">${fmtNum(r.inputCacheRead)}</td>
          <td class="num">${fmtNum(r.output)}</td>
          <td class="num">${fmtNum(r.total)}</td>
          <td class="num">${fmtCost(r.cost)}</td>
          <td class="num">${r.requests}</td>
        </tr>`;
      }).join('')
    : '<tr><td colspan="7" class="empty">当天暂无用量记录</td></tr>';
  box.innerHTML =
    `<div class="hm-dd-head">
      <span class="hm-dd-title">${esc(selectedDate)} 详情</span>
      <span class="hm-dd-summary">请求 ${s.requests} · 总 token ${fmtNum(s.total)} · 估算花费 ${fmtCost(s.cost)}</span>
      <button id="btn-day-clear" class="hm-dd-clear" title="清除选中日期" aria-label="清除选中日期">× 清除</button>
    </div>
    <div class="hm-dd-scroll"><table class="hm-dd-table">
      <thead><tr><th>模型</th><th>未命中</th><th>缓存命中</th><th>输出</th><th>合计</th><th>花费</th><th>请求</th></tr></thead>
      <tbody>${tbody}</tbody>
    </table></div>`;
}

// 工具栏「已选日期」chip：选中日期时显示可清除标签，未选中时隐藏
function renderDateChip() {
  const chip = $('date-chip');
  if (!chip) return;
  if (selectedDate) {
    chip.hidden = false;
    chip.innerHTML =
      `<span class="date-chip-label">已选 ${esc(selectedDate)}</span>` +
      `<button class="date-chip-x" aria-label="清除选中日期" title="清除选中日期">×</button>`;
  } else {
    chip.hidden = true;
  }
}

// 一次性 O(n) 遍历，为每个会话建立下钻数据：模型分布 + 被打断轮次消耗
function buildSessionDetail(range, interruptedTurnSet) {
  const knownKeys = new Set(models.map((m) => m.key));
  const shortName = (m) => { const s = String(m || ''); const i = s.lastIndexOf('/'); return i >= 0 ? s.slice(i + 1) : s; };
  const resolveKey = (m) => {
    if (knownKeys.has(m)) return m;
    for (const k of knownKeys) if (k.endsWith('/' + m)) return k;
    return m;
  };
  const from = range.from, to = range.to;
  const map = new Map();
  for (const r of records) {
    if (typeof r.time !== 'number' || r.time < from || (to != null && r.time >= to)) continue;
    const gkey = (r.workspace || '') + '::' + (r.sessionId || '');
    let d = map.get(gkey);
    if (!d) { d = { models: new Map(), turns: new Set(), itoken: 0, icost: 0, _cin: 0, _ccr: 0, _ccc: 0, _cout: 0 }; map.set(gkey, d); }
    const key = resolveKey(r.model);
    const sn = shortName(key);
    // 以完整 key 分组（同短名不同 provider 的模型分开统计），展示名为短名
    let mo = d.models.get(key);
    if (!mo) { mo = { key, name: sn, totalToken: 0, cost: 0, priced: false, tou: false }; d.models.set(key, mo); }
    const total = (r.inputOther || 0) + (r.inputCacheRead || 0) + (r.inputCacheCreation || 0) + (r.output || 0);
    mo.totalToken += total;
    const interrupted = !!(r.turnId && interruptedTurnSet.has(r.turnId));
    if (interrupted) { d.turns.add(r.turnId); d.itoken += total; }
    // 花费逐条按记录发生时间取价累计（支持峰谷），口径与 aggregateByModel 一致（未定价 cost=null → 不计）
    const p = resolvePrice(key, priceOverrides, r.time);
    const c = costWithPrice(p, recordUsage(r));
    if (c != null) {
      mo.cost += c;
      mo.priced = true;
      if (p.tou) mo.tou = true;
      if (interrupted) d.icost += c;
    }
  }
  const out = new Map();
  for (const [gkey, d] of map) {
    out.set(gkey, {
      models: [...d.models.values()].map((mo) => ({
        name: mo.name || shortName(mo.key),
        totalToken: mo.totalToken,
        tou: mo.tou,
        cost: mo.priced ? mo.cost : null,
      })).sort((a, b) => b.totalToken - a.totalToken),
      turns: d.turns.size,
      itoken: d.itoken,
      icost: d.icost,
    });
  }
  return out;
}

$('filters').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-range]');
  if (!btn) return;
  rangeKey = btn.dataset.range;
  selectedDate = null; // 切换时间筛选时清除日期选择，回到 rangeKey 口径
  render();
});

$('views').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-view]');
  if (!btn) return;
  view = btn.dataset.view;
  selectedDate = null; // 切换模型/会话视图时清除日期选择，保持简单一致
  render();
});

// 热力图日期格点击（事件委托，容器不变）：点同格取消，点他格切到该日
function toggleCellDate(date) {
  if (!date) return;
  selectedDate = selectedDate === date ? null : date;
  render();
}
$('heatmap').addEventListener('click', (e) => {
  const cell = e.target.closest('.hm-cell');
  if (!cell) return;
  toggleCellDate(cell.dataset.date);
});
// 键盘可达：Enter / 空格 触发与点击一致（格为 role=button + tabindex）
$('heatmap').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const cell = e.target.closest('.hm-cell');
  if (!cell) return;
  e.preventDefault();
  toggleCellDate(cell.dataset.date);
});

// 详情面板「× 清除」按钮
$('heatmap-day-detail').addEventListener('click', (e) => {
  if (e.target.closest('#btn-day-clear')) {
    selectedDate = null;
    render();
  }
});

// 工具栏「已选日期」chip 的 × 清除按钮
$('date-chip').addEventListener('click', (e) => {
  if (e.target.closest('.date-chip-x')) {
    selectedDate = null;
    render();
  }
});

// 显示全部开关：折叠/展开零用量已配置模型，状态持久化到 localStorage
const $showZero = $('show-zero');
if ($showZero) {
  $showZero.checked = showZeroModels;
  $showZero.addEventListener('change', (e) => {
    showZeroModels = e.target.checked;
    try { localStorage.setItem('kus-show-zero-models', showZeroModels ? '1' : '0'); } catch { /* 隐私模式等场景忽略 */ }
    render();
  });
}

// 会话行下钻：点击展开/收起该会话的模型分布与被打断轮次消耗
function toggleSessionDetail(row) {
  if (!row) return;
  const next = row.nextElementSibling;
  if (next && next.classList.contains('session-detail')) { next.remove(); return; } // 收起
  const d = sessionDetailMap.get(row.dataset.groupkey);
  if (!d) return;
  const detailTr = document.createElement('tr');
  detailTr.className = 'session-detail';
  const interKv = d.turns > 0
    ? `<div class="detail-kv">
        <span>轮次</span><b>${d.turns} 轮</b>
        <span>消耗</span><b>${fmtNum(d.itoken)} tokens</b>
        <span>金额</span><b>${fmtCost(d.icost)}</b>
      </div>`
    : '<span class="detail-nums">—</span>';
  detailTr.innerHTML = `<td colspan="9"><div class="detail">
    <div class="detail-sub">会话 ID · ${esc(d.displayName || row.dataset.groupkey)}</div>
    <div class="detail-col">
      <div class="detail-title">模型分布</div>
      <table class="mini">
        <thead><tr><th>模型</th><th>总 token</th><th>花费</th></tr></thead>
        <tbody>${d.models.map((m) => `<tr><td>${esc(m.name)}${m.tou ? '<span class="badge tou" title="该模型按峰谷计价">峰谷</span>' : ''}</td><td class="num">${fmtNum(m.totalToken)}</td><td class="num">${fmtCost(m.cost)}</td></tr>`).join('') || '<tr><td colspan="3" class="empty">—</td></tr>'}</tbody>
      </table>
    </div>
    <div class="detail-col">
      <div class="detail-title">被打断轮次</div>
      ${interKv}
    </div>
  </div></td>`;
  row.after(detailTr);
}
$('session-tbody').addEventListener('click', (e) => {
  toggleSessionDetail(e.target.closest('tr.session-row'));
});
// 键盘可达：会话行聚焦后 Enter/空格 展开收起
$('session-tbody').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const row = e.target.closest('tr.session-row');
  if (!row) return;
  e.preventDefault();
  toggleSessionDetail(row);
});

$('btn-rescan').addEventListener('click', refresh);

// ── 价目表设置（单一价 / 峰谷）──────────────────────────
// 视图逻辑（行/时段 DOM 的构建与读取）在 lib/price-editor.js；此处只管状态与持久化。
// priceInputs：短名 → refs（见 price-editor.priceItemEl）
const priceInputs = new Map();

function openPriceEditor() {
  if (!priceOverrides) return;
  // 定价按短名（priceKey）走，所以同短名的多个 config key 共用一行价格。
  // 这里把「主名 / 定价键 / 未配置 / 共用关系」一起备好，交给 lib/price-editor.js 渲染。
  const shown = new Map(); // 短名 → { key, short, displayName, configured, used, keys }
  const add = (key, displayName, configured, used) => {
    const short = priceKey(key);
    if (!short) return;
    let row = shown.get(short);
    if (!row) {
      row = { key, short, displayName: short, configured: false, used: false, keys: [] };
      shown.set(short, row);
    }
    const firstConfigured = configured && !row.configured; // 同短名多个配置时，以先出现的那个为行主
    row.configured = row.configured || configured;
    row.used = row.used || used;
    if (!row.keys.includes(key)) row.keys.push(key);
    // 主名优先取 config.toml 的 display_name —— 与主表显示保持一致；没有配置名的退回短名
    if (firstConfigured) { row.key = key; row.displayName = displayName || short; }
  };
  // 已配置模型（有 display_name，与主表同款名字）
  for (const m of models) add(m.key, m.displayName, true, false);
  // 记录里出现但没配置的模型
  for (const r of records) add(r.model, null, false, true);
  // 内置价目表 / 用户覆盖里已有、但当前既未配置也未使用的模型（便于提前调价）
  for (const short of Object.keys({ ...DEFAULT_PRICE_TABLE, ...(priceOverrides || {}) })) add(short, short, false, false);

  const list = [...shown.values()].map((row) => ({
    ...row,
    unconfigured: row.used && !row.configured,
    sharedKeys: row.keys,
  })).sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh'));

  priceInputs.clear();
  const body = $('price-body');
  body.innerHTML = PRICE_HEAD_HTML;
  for (const it of list) {
    const { wrap, refs } = priceItemEl({ ...it, entry: getPriceEntry(it.key, priceOverrides) });
    body.appendChild(wrap);
    priceInputs.set(it.short, refs);
  }
  $('price-modal').hidden = false;
}

function closePriceEditor() {
  $('price-modal').hidden = true;
}

$('btn-prices').addEventListener('click', openPriceEditor);
$('btn-price-cancel').addEventListener('click', closePriceEditor);
$('price-modal').addEventListener('click', (e) => {
  if (e.target.id === 'price-modal') closePriceEditor(); // 点遮罩关闭
});

// 恢复内置默认价（含 DeepSeek 峰谷时段）：仅改当前弹层内容，仍需「保存」才写入。
// 只处理内置价目表里存在的模型；自建 / 未收录的模型保持原样，避免一键清空用户自己填的价。
$('btn-price-reset').addEventListener('click', () => {
  const targets = [...priceInputs].filter(([, refs]) => getPriceEntry(refs.key, null));
  const skipped = priceInputs.size - targets.length;
  const msg = `把 ${targets.length} 行恢复为内置默认价（含 DeepSeek 峰谷时段）？`
    + (skipped ? `\n另有 ${skipped} 行无内置参考价（自建 / 未收录模型），将保持不动。` : '')
    + '\n点「保存」后才会写入。';
  if (!targets.length || !confirm(msg)) return;
  for (const [short, refs] of targets) {
    const { wrap, refs: next } = resetItemEl(refs, short);
    refs.wrap.replaceWith(wrap);
    priceInputs.set(short, next);
  }
});

$('btn-price-save').addEventListener('click', async () => {
  const next = readPriceTable(priceInputs);
  try {
    await store.setPriceOverrides(next);
    priceOverrides = { ...DEFAULT_PRICE_TABLE, ...next }; // 合并默认，保证后续取价兜底
    closePriceEditor();
    render();
  } catch (err) {
    console.error('保存价目表失败', err);
    alert('保存失败：' + (err && err.message ? err.message : err));
  }
});

$('btn-pick').addEventListener('click', async () => {
  try {
    dirHandle = await showDirectoryPicker({ id: 'kimi-code-home', mode: 'read' });
  } catch {
    return; // 用户取消
  }
  await store.saveDirHandle(dirHandle);
  show('main');
  await refresh();
});

$('btn-reauth').addEventListener('click', async () => {
  if (await ensureReadPermission(dirHandle, true)) {
    show('main');
    await refresh();
  }
});

$('logo').innerHTML = LOGO_SVG;
$('logo-big').innerHTML = LOGO_SVG;
$('logo-big2').innerHTML = LOGO_SVG;

(async () => {
  priceOverrides = await store.initPriceTable(); // 首次播种默认价目表，返回生效覆盖
  dirHandle = await store.loadDirHandle();
  if (!dirHandle) return show('onboarding');
  if (!(await ensureReadPermission(dirHandle))) return show('reauth');
  show('main');
  await refresh();
})();
