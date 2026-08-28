import { LOGO_SVG } from '../lib/brand.js';
import { rangeBounds, aggregateByModel, summarize, fmtNum, fmtPct, fmtCost } from '../lib/aggregate.js';
import { ringDash, sparkHeights } from '../lib/charts.js';
import * as store from '../lib/store.js';
import { ensureReadPermission, scanKimiHome } from '../lib/scanner.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let dirHandle = null;
let models = [];
let records = [];
let priceOverrides = null;

// ── 三态主题（与 dashboard/popup 共享 kus-theme；deferred 模块运行时 DOM 已就绪） ──
const THEME_KEY = 'kus-theme';
const THEME_MODES = ['light', 'dark', 'system'];
const THEME_LABEL = { light: '亮', dark: 'HUD', system: '跟随' };
const THEME_NAME = { light: '月之亮面', dark: '霓虹 HUD', system: '跟随系统' };

function readThemePref() {
  let v = null;
  try { v = localStorage.getItem(THEME_KEY); } catch { /* 隐私模式/受限等场景忽略，回退 system */ }
  return THEME_MODES.includes(v) ? v : 'system';
}
function applyTheme(applied) {
  document.documentElement.dataset.theme = applied;
  const b = $('btn-theme');
  if (b) {
    b.textContent = THEME_LABEL[applied];
    b.title = `主题：${THEME_NAME[applied]}（点击切换）`;
  }
}
function cycleTheme() {
  const cur = readThemePref();
  const next = THEME_MODES[(THEME_MODES.indexOf(cur) + 1) % THEME_MODES.length];
  try { localStorage.setItem(THEME_KEY, next); } catch { /* 隐私模式等忽略 */ }
  applyTheme(next);
}
const themeMq = window.matchMedia('(prefers-color-scheme: dark)');
themeMq.addEventListener('change', () => {
  if (readThemePref() === 'system') {
    delete document.documentElement.dataset.theme;
    requestAnimationFrame(() => { document.documentElement.dataset.theme = 'system'; });
  }
});
applyTheme(readThemePref());
if ($('btn-theme')) $('btn-theme').addEventListener('click', cycleTheme);

function render() {
  // 概览如何折零用量：默认只显示有数据的模型（与 dashboard 默认口径一致）
  const rows = aggregateByModel(records, models, rangeBounds($('range').value), priceOverrides)
    .filter((r) => r.requests > 0);
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
  // 概览底部：估算花费总计；无数据或全部未定价时显示 —（而非 ¥0.00）
  const footCost = $('foot-cost');
  const totalCost = $('total-cost');
  if (footCost && totalCost) {
    footCost.style.display = 'block';
    const priced = rows.some((r) => r.cost != null);
    totalCost.textContent = rows.length && priced ? fmtCost(summarize(rows).cost) : '—';
  }
}

async function refresh() {
  const res = await scanKimiHome(dirHandle);
  models = res.models;
  records = await store.loadAllRecords();
  render();
}

$('range').addEventListener('change', render);
$('btn-rescan').addEventListener('click', () => dirHandle && refresh());
const openDashboard = () => chrome.runtime.sendMessage({ type: 'OPEN_DASHBOARD' });
$('btn-open').addEventListener('click', openDashboard);
$('btn-open2').addEventListener('click', openDashboard);
// iframe 与宿主页面跨域，关闭抽屉需 postMessage 通知 content script
$('btn-close').addEventListener('click', () => {
  if (window.parent !== window) window.parent.postMessage({ type: 'KUS_CLOSE_DRAWER' }, '*');
});

$('logo').innerHTML = LOGO_SVG;

(async () => {
  priceOverrides = await store.initPriceTable(); // 首次播种默认价目表，返回生效覆盖
  dirHandle = await store.loadDirHandle();
  const ok = dirHandle && (await ensureReadPermission(dirHandle));
  $('hint').hidden = !!ok;
  $('table').hidden = !ok;
  $('btn-rescan').hidden = !ok; // 未授权时隐藏刷新，避免点击触发权限不足的 rejection
  if (ok) await refresh();
})();
