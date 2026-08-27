import { LOGO_SVG } from '../lib/brand.js';
import * as store from '../lib/store.js';

// ── 三态主题（与 dashboard/panel 共享 kus-theme；deferred 模块运行时 DOM 已就绪） ──
const THEME_KEY = 'kus-theme';
const THEME_MODES = ['light', 'dark', 'system'];
const THEME_LABEL = { light: '亮', dark: '暗', system: '跟随' };
const THEME_NAME = { light: '月之亮面', dark: '月之暗面', system: '跟随系统' };

function readThemePref() {
  let v = null;
  try { v = localStorage.getItem(THEME_KEY); } catch { /* 隐私模式/受限等场景忽略，回退 system */ }
  return THEME_MODES.includes(v) ? v : 'system';
}
function applyTheme(applied) {
  document.documentElement.dataset.theme = applied;
  const b = document.getElementById('btn-theme');
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
  if (readThemePref() === 'system') document.documentElement.dataset.theme = 'system';
});
applyTheme(readThemePref());
const btnTheme = document.getElementById('btn-theme');
if (btnTheme) btnTheme.addEventListener('click', cycleTheme);

document.getElementById('logo').innerHTML = LOGO_SVG;
document.getElementById('btn-open').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html') });
});

(async () => {
  const [handle, at, res] = await Promise.all([
    store.loadDirHandle(),
    store.getMeta('lastScanAt'),
    store.getMeta('lastScanResult'),
  ]);
  const el = document.getElementById('status');
  if (!handle) el.textContent = '尚未授权目录，请先打开完整页完成初始化。';
  else if (!at) el.textContent = '已授权，尚未扫描。';
  else el.textContent = `上次扫描：${new Date(at).toLocaleString('zh-CN', { hour12: false })}，新增 ${res?.added ?? 0} 条。`;
})();
