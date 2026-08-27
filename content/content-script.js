const MARKER_ID = 'kimi-usage-stats-entry';
const DRAWER_ID = 'kimi-usage-stats-drawer';
const ANCHOR_TEXT = '套餐用量';
const ENTRY_TEXT = '模型用量统计';
let anchorMissLogged = false; // 注入点缺失的调试日志只打一次，避免 MutationObserver 防抖回调刷屏
// 品牌 SVG 单一定义在 lib/brand.js（content-script 为 classic 脚本，用动态 import 拉取，
// lib/* 属于 web_accessible_resources）。加载完成前不替换图标，避免出现重复定义漂移。
let LOGO_SVG = null;
import(chrome.runtime.getURL('lib/brand.js'))
  .then((m) => { LOGO_SVG = m.LOGO_SVG; })
  .catch(() => console.debug('[kimi-usage-stats] 品牌 SVG 加载失败，沿用宿主图标'));

// 扩展上下文检测：扩展被重新加载后，旧页面里注入的 content script 上下文会失效，
// 此时 chrome.runtime.* 调用会抛错。点击入口时先检测，失效则提示刷新页面而非无声失败。
function isExtAlive() {
  try {
    if (!chrome?.runtime?.getURL) return false;
    void chrome.runtime.getURL('');
    return true;
  } catch {
    return false;
  }
}

// 轻量 toast：提示用户扩展已更新需要刷新页面（4 秒后自动消失）
function showStaleHint() {
  const existing = document.getElementById('kus-stale-hint');
  if (existing) existing.remove();
  const hint = document.createElement('div');
  hint.id = 'kus-stale-hint';
  hint.textContent = '扩展已更新，请刷新页面后重试';
  hint.style.cssText =
    'position:fixed;right:16px;bottom:16px;z-index:99999;background:#0B1220;color:#E5E7EB;' +
    'padding:10px 14px;border-radius:10px;font-size:13px;line-height:1.5;' +
    'box-shadow:0 4px 16px rgba(0,0,0,.25);font-family:system-ui,-apple-system,sans-serif;';
  document.body.appendChild(hint);
  setTimeout(() => hint.remove(), 4000);
}

function findAnchor() {
  for (const el of document.querySelectorAll('span, div, a, button, li')) {
    if (el.children.length === 0 && el.textContent.trim() === ANCHOR_TEXT) {
      return el.closest('li') || el.closest('a') || el.closest('button') || el.parentElement;
    }
  }
  if (!anchorMissLogged) {
    anchorMissLogged = true;
    console.debug('[kimi-usage-stats] 未找到"套餐用量"注入点，跳过注入');
  }
  return null;
}

function toggleDrawer() {
  const existing = document.getElementById(DRAWER_ID);
  if (existing) { existing.remove(); return; }
  let url;
  try {
    url = chrome.runtime.getURL('panel/panel.html');
  } catch {
    showStaleHint();
    return;
  }
  const drawer = document.createElement('div');
  drawer.id = DRAWER_ID;
  const iframe = document.createElement('iframe');
  iframe.src = url;
  drawer.appendChild(iframe);
  document.body.appendChild(drawer);
}

function injectEntry() {
  if (document.getElementById(MARKER_ID)) return;
  const anchor = findAnchor();
  if (!anchor || !anchor.parentElement) return;
  const item = anchor.cloneNode(true);
  item.id = MARKER_ID;
  item.removeAttribute('href');
  // 替换叶子文本
  for (const el of item.querySelectorAll('*')) {
    if (el.children.length === 0 && el.textContent.trim() === ANCHOR_TEXT) el.textContent = ENTRY_TEXT;
  }
  if (item.children.length === 0 && item.textContent.trim() === ANCHOR_TEXT) item.textContent = ENTRY_TEXT;
  // 替换图标为 Kimi logo（品牌 SVG 来自 lib/brand.js）
  const svg = item.querySelector('svg');
  if (svg && LOGO_SVG) svg.outerHTML = LOGO_SVG;
  item.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isExtAlive()) { showStaleHint(); return; }
    toggleDrawer();
  }, true);
  anchor.parentElement.insertBefore(item, anchor.nextSibling);
}

// ---- DSH 风格上下文用量指示器：徽章（百分比 + 内联拆分）+ 底部会话统计栏 ----
const CTX_BADGE_ID = 'kimi-ctx-badge';
const CTX_BAR_ID = 'kimi-ctx-bar';
let ctxTimer = null;
let ctxBusy = false;
let ctxSid = null;

const ctxSessionId = () => {
  const m = location.pathname.match(/\/sessions\/(session_[A-Za-z0-9-]+)/);
  return m ? m[1] : null;
};

const ctxFmtTok = (n) => {
  if (n == null) return '—';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
};

const ctxFmtDur = (ms) => {
  if (ms == null) return '—';
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${Math.round(s % 60)}s`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
};

function ensureCtxUi() {
  const sid = ctxSessionId();
  const wrap = document.querySelector('.cin-wrap');
  if (!sid || !wrap) { removeCtxUi(); return; }
  if (!document.getElementById(CTX_BADGE_ID)) {
    const badge = document.createElement('div');
    badge.id = CTX_BADGE_ID;
    badge.className = 'kimi-ctx-badge';
    badge.textContent = '上下文 …';
    wrap.insertBefore(badge, wrap.firstChild);
    const bar = document.createElement('div');
    bar.id = CTX_BAR_ID;
    bar.className = 'kimi-ctx-bar';
    wrap.parentElement.insertBefore(bar, wrap.nextSibling);
  }
  if (ctxSid !== sid) { ctxSid = sid; pollCtx(); }
  if (!ctxTimer) ctxTimer = setInterval(pollCtx, 3000);
}

function removeCtxUi() {
  for (const id of [CTX_BADGE_ID, CTX_BAR_ID]) document.getElementById(id)?.remove();
  if (ctxTimer) { clearInterval(ctxTimer); ctxTimer = null; }
  ctxSid = null;
}

async function pollCtx() {
  if (ctxBusy) return;
  ctxBusy = true;
  try {
    const sid = ctxSessionId();
    if (!sid) return;
    renderCtx(await chrome.runtime.sendMessage({ type: 'KUS_SESSION_STATS', sessionId: sid }));
  } catch { /* 扩展上下文失效等，忽略 */ } finally { ctxBusy = false; }
}

function renderCtx(r) {
  const badge = document.getElementById(CTX_BADGE_ID);
  const bar = document.getElementById(CTX_BAR_ID);
  if (!badge || !bar) return;
  if (!r || !r.ok) {
    badge.textContent = (r && (r.reason === 'no-dir' || r.reason === 'no-permission')) ? '上下文：未授权' : '上下文：—';
    badge.title = '打开「模型用量统计」面板选择 ~/.kimi-code 目录并授权后生效';
    bar.textContent = '';
    return;
  }
  const used = r.contextTotal || 0;
  const limit = r.maxContext || 0;
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : null;
  const b = r.breakdown;
  badge.textContent = `${pct == null ? `上下文 ${ctxFmtTok(used)}` : `上下文已用 ${pct}%`}　系统提示词 ~${ctxFmtTok(b.system)} · 工具 ~${ctxFmtTok(b.tools)} · 对话消息 ~${ctxFmtTok(b.messages)}`;
  badge.title = `~${ctxFmtTok(used)} / ${ctxFmtTok(limit)}`;
  const s = r.stats;
  const ttft = s.ttftAvg == null ? '—' : ctxFmtDur(s.ttftAvg);
  const tps = s.tokps == null ? '—' : `${Math.round(s.tokps)} tok/s`;
  const hit = s.cacheHit == null ? '—' : `${Math.round(s.cacheHit * 100)}%`;
  bar.textContent = `${s.turns} 轮 · ${s.steps} 步 | LLM ${ctxFmtDur(s.llmMs)} · 工具 ${ctxFmtDur(s.toolMs)} | 首 token 平均 ${ttft} · ${tps} | 缓存命中 ${hit} | 输入 ${ctxFmtTok(s.inTotal)} tok · 输出 ${ctxFmtTok(s.outTotal)} tok`;
}

let timer = null;
new MutationObserver(() => {
  clearTimeout(timer);
  timer = setTimeout(() => { injectEntry(); ensureCtxUi(); }, 500);
}).observe(document.body, { childList: true, subtree: true });

// 面板 iframe 里的关闭按钮通过 postMessage 请求关闭抽屉；校验来源确为该 iframe
window.addEventListener('message', (e) => {
  if (e.data?.type !== 'KUS_CLOSE_DRAWER') return;
  const drawer = document.getElementById(DRAWER_ID);
  const frame = drawer?.querySelector('iframe');
  if (frame && e.source === frame.contentWindow) drawer.remove();
});

injectEntry();
ensureCtxUi();
