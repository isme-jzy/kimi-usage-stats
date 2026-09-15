// 价目表弹层视图逻辑：单一价行 + 峰谷时段编辑。
// 只负责「构建 DOM / 读取 DOM」，不持有价目表状态、不碰 IndexedDB —— 状态与持久化由调用方
// （dashboard.js）负责，因此本模块可独立渲染，便于预览与测试。
import { getPriceEntry, describePeriod } from './pricing.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const WEEK_LABELS = ['日', '一', '二', '三', '四', '五', '六'];
const ALL_WEEK = [0, 1, 2, 3, 4, 5, 6];
const num = (v) => parseFloat(v) || 0;

// 表头（模型 / 三档基础价 / 峰谷）
export const PRICE_HEAD_HTML =
  '<div class="price-row price-head-row"><span class="price-key">模型</span>' +
  '<span class="price-sub">输入</span><span class="price-sub">缓存命中</span>' +
  '<span class="price-sub">输出</span><span class="price-sub">峰谷</span></div>';

// 一条时段编辑行：类型（低谷/高峰）+ 起止时间 + 三档价 + 适用日 + 删除。
// 价格缺省用模型当前基础价预填（新加时段时即以基础价为起点再改）。
export function periodRowEl(period, base) {
  const p = period || {};
  const kind = p.kind === 'peak' ? 'peak' : 'offpeak';
  const days = Array.isArray(p.days) && p.days.length ? p.days.map(Number) : ALL_WEEK;
  const val = (v, fb) => esc(v == null || v === '' ? fb : v);
  const row = document.createElement('div');
  row.className = 'tou-row';
  row.dataset.period = '1';
  row.innerHTML =
    `<select class="tou-kind" title="时段类型：低谷=闲时单价，高峰=按高峰单价">
      <option value="offpeak"${kind === 'offpeak' ? ' selected' : ''}>低谷</option>
      <option value="peak"${kind === 'peak' ? ' selected' : ''}>高峰</option>
    </select>
    <input class="tou-start" type="time" step="60" value="${val(p.start, '00:00')}" aria-label="开始时间">
    <input class="tou-end" type="time" step="60" value="${val(p.end, '00:00')}" aria-label="结束时间">
    <input class="tou-in" type="number" min="0" step="0.1" inputmode="decimal" placeholder="—" value="${val(p.input, base.input)}" aria-label="输入单价">
    <input class="tou-ca" type="number" min="0" step="0.1" inputmode="decimal" placeholder="—" value="${val(p.cacheRead, base.cacheRead)}" aria-label="缓存命中单价">
    <input class="tou-out" type="number" min="0" step="0.1" inputmode="decimal" placeholder="—" value="${val(p.output, base.output)}" aria-label="输出单价">
    <span class="tou-days">${WEEK_LABELS.map((t, i) =>
      `<button type="button" class="tou-day${days.includes(i) ? ' active' : ''}" data-day="${i}" title="周${t}">${t}</button>`).join('')}</span>
    <button type="button" class="tou-del" title="删除该时段" aria-label="删除该时段">×</button>`;
  return row;
}

// 时段区底部的操作行。hasPreset=false（该模型在内置价目表里没有峰谷时段）时按钮置灰，
// 悬停说明原因 —— 避免点了之后只是把用户的时段清空却什么都不填。
function touToolsEl(hasPreset) {
  const title = hasPreset
    ? '把该模型的内置峰谷时段（如 DeepSeek 的闲时窗口）填入下方时段列表：会覆盖当前时段，但不改上方三档基础价'
    : '内置价目表未给该模型配置峰谷时段，没有可套用的内容';
  const tools = document.createElement('div');
  tools.className = 'tou-tools';
  tools.innerHTML =
    '<button type="button" class="ghost tou-add">+ 添加时段</button>' +
    `<button type="button" class="ghost tou-preset"${hasPreset ? '' : ' disabled'} title="${esc(title)}">套用内置时段</button>` +
    '<span class="tou-hint">未落入任何时段的用量按上方基础价计（约定为高峰价）；时段跨天可写 18:00 → 00:00。</span>';
  return tools;
}

const touRowsIn = (box) => [...box.querySelectorAll('.tou-row[data-period]')];

// 标签行（起/止/三档价/适用日），仅在时段区展开时可见
function touLabelsEl() {
  const labels = document.createElement('div');
  labels.className = 'tou-row tou-labels';
  labels.innerHTML = '<span>类型</span><span>起</span><span>止</span><span>输入</span><span>缓存命中</span><span>输出</span><span>适用日</span><span></span>';
  return labels;
}

// 读取时段列表：时间非法/未填（或起止相同）的行忽略；7 天全选时省略 days（表示每天）。
export function readPeriods(box) {
  const out = [];
  for (const row of touRowsIn(box)) {
    const start = row.querySelector('.tou-start').value.trim();
    const end = row.querySelector('.tou-end').value.trim();
    if (!start || !end || start === end) continue;
    const days = [...row.querySelectorAll('.tou-day.active')].map((b) => Number(b.dataset.day)).sort((a, b) => a - b);
    const of = (sel) => row.querySelector(sel).value;
    out.push({
      kind: row.querySelector('.tou-kind').value === 'peak' ? 'peak' : 'offpeak',
      start, end,
      days: days.length === 7 ? undefined : days,
      input: num(of('.tou-in')),
      cacheRead: num(of('.tou-ca')),
      output: num(of('.tou-out')),
    });
  }
  return out;
}

function baseOf(refs) {
  return { input: num(refs.inputEl.value), cacheRead: num(refs.cacheEl.value), output: num(refs.outputEl.value) };
}

// 同步「未定价 / 单一价 / 峰谷 N 段」徽标、按钮态与时段摘要 tooltip
function syncTou(refs) {
  const periods = readPeriods(refs.touBox);
  const n = periods.length;
  // 三态：三档基础价全空且无时段 = 未定价（与主表「—」口径一致，不能说成"单一价"）
  const priced = [refs.inputEl, refs.cacheEl, refs.outputEl].some((el) => el.value.trim() !== '');
  refs.modeEl.textContent = n ? `峰谷 ${n} 段` : (priced ? '单一价' : '未定价');
  refs.modeEl.className = 'price-mode' + (n ? ' on' : '');
  refs.touBtn.textContent = n ? `峰谷 (${n})` : '峰谷…';
  refs.touBtn.classList.toggle('on', !refs.touBox.hidden);
  refs.touBtn.title = refs.modeEl.title = n
    ? periods.map((p) => describePeriod(p)).join('\n') + '\n（未落入时段的时间按上方基础价计）'
    : (priced ? '全天按上方基础价单一计价' : '三档价留空 = 未定价，该模型不计入花费汇总');
}

// 构建一个模型编辑块：基础价行 + 可展开的时段区。返回 { wrap, refs }。
// item: { key, short, displayName, entry, unconfigured, sharedKeys }
//   key          完整 config key（未配置的模型即记录里出现的 key）
//   short        定价键（priceKey 短名）—— 实际取价、去重都按它
//   displayName  主名：已配置模型用 config.toml 的 display_name，与主表一致
//   entry        getPriceEntry 的结果（含 periods）；null = 未定价
//   unconfigured 只在记录里出现、没写进 config.toml → 主名退回短名 + 「未在配置中」徽标
//   sharedKeys   共用这一行价格的全部完整 key（>1 说明多个渠道同价）
// entry 为 null（未定价）时三档价留空 → 显示占位符 —，保存时不会被误写成 0 价。
export function priceItemEl(item) {
  const entry = item.entry || null;
  const base = entry || { input: '', cacheRead: '', output: '' };
  const val = (v) => (v == null ? '' : String(v));
  // 内置默认条目（不含用户覆盖）：用于「套用内置时段」的内容与按钮可用性判断
  const builtin = getPriceEntry(item.key, null);
  const builtinPeriods = (builtin && builtin.periods) || [];
  const shared = Array.isArray(item.sharedKeys) ? item.sharedKeys.length : 1;
  // 次行：未配置的模型主名已经是短名，次行补完整 key；已配置的则给出取价用的短名（多 key 共用时点明）
  const subText = item.unconfigured
    ? item.key
    : (shared > 1 ? `${item.short} · ${shared} 个配置共用此价` : item.short);
  const title = [
    item.key,
    item.short !== item.key ? `定价键：${item.short}` : null,
    shared > 1 ? `以下配置共用这一行价格：\n${(item.sharedKeys || []).join('\n')}` : null,
  ].filter(Boolean).join('\n');
  const badge = item.unconfigured ? '<span class="badge">未在配置中</span>' : '';
  const wrap = document.createElement('div');
  wrap.className = 'price-item';
  wrap.dataset.short = item.short;
  wrap.innerHTML =
    `<div class="price-row">
      <span class="price-name">
        <span class="price-key" title="${esc(title)}">${esc(item.displayName || item.short)}<span class="price-mode"></span>${badge}</span>
        <span class="price-key-sub" title="${esc(subText)}">${esc(subText)}</span>
      </span>
      <input class="price-in" type="number" min="0" step="0.1" inputmode="decimal" placeholder="—" value="${esc(val(entry && entry.input))}" aria-label="基础输入单价">
      <input class="price-ca" type="number" min="0" step="0.1" inputmode="decimal" placeholder="—" value="${esc(val(entry && entry.cacheRead))}" aria-label="基础缓存命中单价">
      <input class="price-out" type="number" min="0" step="0.1" inputmode="decimal" placeholder="—" value="${esc(val(entry && entry.output))}" aria-label="基础输出单价">
      <button type="button" class="ghost price-tou-btn">峰谷…</button>
    </div>
    <div class="price-tou" hidden></div>`;
  const refs = {
    item,
    key: item.key,
    displayName: item.displayName || item.short,
    wrap,
    inputEl: wrap.querySelector('.price-in'),
    cacheEl: wrap.querySelector('.price-ca'),
    outputEl: wrap.querySelector('.price-out'),
    modeEl: wrap.querySelector('.price-mode'),
    touBtn: wrap.querySelector('.price-tou-btn'),
    touBox: wrap.querySelector('.price-tou'),
  };
  // 时段区默认收起，但 DOM 已在 → 保存时照常读取；顺序：标签行 / 已有（或内置）时段 / 操作行
  refs.touBox.appendChild(touLabelsEl());
  for (const p of ((entry && entry.periods) || [])) refs.touBox.appendChild(periodRowEl(p, base));
  refs.touBox.appendChild(touToolsEl(builtinPeriods.length > 0));
  refs.touBox.hidden = true;
  syncTou(refs);

  refs.touBtn.addEventListener('click', () => {
    refs.touBox.hidden = !refs.touBox.hidden;
    syncTou(refs);
  });
  // 改基础价时徽标跟着变（未定价 ↔ 单一价），不必等展开时段区
  wrap.addEventListener('input', () => syncTou(refs));
  refs.touBox.addEventListener('click', (e) => {
    if (e.target.closest('.tou-add')) {
      // 新时段预填 00:00-08:00（典型闲时窗口），价格以当前基础价为起点
      refs.touBox.insertBefore(periodRowEl({ start: '00:00', end: '08:00' }, baseOf(refs)), refs.touBox.querySelector('.tou-tools'));
      syncTou(refs);
      return;
    }
    if (e.target.closest('.tou-preset')) {
      // 套用内置峰谷时段：会覆盖当前时段列表（因此有内容时先确认），但不改上方三档基础价
      if (!builtinPeriods.length) return; // 无内置时段（按钮已置灰，这里兜底）
      const rows = touRowsIn(refs.touBox);
      if (rows.length && !confirm(`用内置时段覆盖当前的 ${rows.length} 段？当前这些时段会被丢弃（上方三档基础价不受影响）。`)) return;
      for (const row of rows) row.remove();
      for (const p of builtinPeriods) {
        refs.touBox.insertBefore(periodRowEl(p, builtin), refs.touBox.querySelector('.tou-tools'));
      }
      syncTou(refs);
      return;
    }
    const del = e.target.closest('.tou-del');
    if (del) { del.closest('.tou-row').remove(); syncTou(refs); return; }
    const day = e.target.closest('.tou-day');
    if (day) { day.classList.toggle('active'); syncTou(refs); } // 适用日：即时改 class，保存时统一读
  });
  return { wrap, refs };
}

// 「恢复内置默认价」：按内置默认重建某一行，返回新的 { wrap, refs } 供调用方替换。
// 保留原行的名字与共用信息，只把价换成内置默认（调用方应先确认该模型确实有内置价）。
export function resetItemEl(refs, short) {
  return priceItemEl({ ...(refs.item || {}), short, entry: getPriceEntry(refs.key, null) });
}

// 保存时读取整张表：inputs 为 Map<短名, refs>。
// 返回 { 短名: { input, cacheRead, output, periods } }；三档与时段全空的模型视为「未定价」不写入。
export function readPriceTable(inputs) {
  const next = {};
  for (const [short, refs] of inputs) {
    const inp = refs.inputEl.value.trim();
    const ca = refs.cacheEl.value.trim();
    const out = refs.outputEl.value.trim();
    const periods = readPeriods(refs.touBox);
    if (inp === '' && ca === '' && out === '' && !periods.length) continue;
    next[short] = {
      input: num(inp),
      cacheRead: num(ca),
      output: num(out),
      periods, // 显式写入（[] = 明确停用峰谷，避免被内置默认时段覆盖）
    };
  }
  return next;
}
