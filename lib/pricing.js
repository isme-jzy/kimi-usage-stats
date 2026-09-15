// 纯函数价目表模块：不碰 DOM / IndexedDB，浏览器与 Node 通用。
// 单价单位：元 / 百万 tokens（三档：input 普通输入、cacheRead 缓存命中读取、output 输出）。
// 缓存写（cacheWrite）不单独计费，归入 input 口径，由调用方决定 input 的取值。
//
// ── 两种计价方式（逐模型可选，可混用）────────────────────────────
// 1) 单一计价（原有行为，向后兼容）：条目只含 { input, cacheRead, output }，全天同价。
// 2) 峰谷计价：条目额外带 periods 时段列表，按「记录发生时间」落到不同时段各自计价。
//    - 顶层三档价 = 兜底价，约定为高峰价；periods 通常只声明低谷（闲时）窗口；
//    - 未命中任何时段的时间点 → 按兜底价（高峰）计；
//    - periods: [] （显式空数组）表示停用峰谷，退化为单一计价；undefined 表示继承内置默认。
//    - 命中多个时段时「先声明者优先」，便于把特例时段写在前面。
//    - 时段支持跨天（如 18:00 → 00:00 表示 [18:00, 24:00)）与「适用日」过滤（0=周日 .. 6=周六）。
//
// ── 匹配策略（由 getPriceEntry 归纳）─────────────────────────────
//   1. 精确短名命中（overrides 用户覆盖 > 默认表）
//   2. KEY_ALIASES 别名映射（Kimi Code 实际模型 key 短名 → 官方价目短名）
//   3. 前缀兜底（如 deepseek-v4-flash-0731 → deepseek-v4-flash，要求余下以 - / . 开头避免误配）
// 仍找不到 → 未定价，返回 null（UI 显示 —，可到「价目表」手动设置）。

// 内置默认价目表：键为模型短名（config.toml models key 去 `provider/` 前缀，如 ark/kimi-k3 → kimi-k3）。
// 取值参考公开价目；`元/百万 tokens`。
// 注：价格为公开参考价，可能随官方调整。
//
// DeepSeek 自 2026-08-17 00:00（北京时间）起改用峰谷定价：高峰为每日 09:00-12:00 与 14:00-18:00，
// 其余时段为闲时，闲时单价为高峰的一半。故这两个模型的顶层三档价取「高峰价」，
// periods 声明三段闲时窗口（00:00-09:00 / 12:00-14:00 / 18:00-00:00）。
const deepseekOffPeak = (input, cacheRead, output) => [
  { kind: 'offpeak', start: '00:00', end: '09:00', input, cacheRead, output },
  { kind: 'offpeak', start: '12:00', end: '14:00', input, cacheRead, output },
  { kind: 'offpeak', start: '18:00', end: '00:00', input, cacheRead, output },
];

export const DEFAULT_PRICE_TABLE = Object.freeze({
  'kimi-k2.7-code': { input: 13, cacheRead: 2.6, output: 54 },
  'kimi-k2.7-code-highspeed': { input: 26, cacheRead: 5.2, output: 108 },
  'kimi-k3': { input: 20, cacheRead: 2, output: 100 },
  'kimi-k2.6': { input: 6.5, cacheRead: 0.6, output: 27 },
  'kimi-k2.5': { input: 4, cacheRead: 0.7, output: 21 },
  'moonshot-v1-8k': { input: 12, cacheRead: 1.2, output: 12 },
  'moonshot-v1-32k': { input: 24, cacheRead: 2.4, output: 24 },
  'moonshot-v1-128k': { input: 60, cacheRead: 6, output: 60 },
  'deepseek-v4-flash': {
    input: 3, cacheRead: 0.1, output: 9, // 高峰价
    periods: deepseekOffPeak(1.5, 0.05, 4.5), // 闲时价 = 高峰的一半
  },
  'deepseek-v4-pro': {
    input: 9, cacheRead: 0.3, output: 27, // 高峰价
    periods: deepseekOffPeak(4.5, 0.15, 13.5), // 闲时价 = 高峰的一半
  },
});

// v1（峰谷计价上线前）内置价快照：只含单一批发价，用于升级时判定「用户是否改过这一行」。
// 未改动过的行 → 自动升级为新默认（含峰谷时段）；改动过的行 → 原样保留用户设置。
export const LEGACY_PRICE_TABLE = Object.freeze({
  'kimi-k2.7-code': { input: 13, cacheRead: 2.6, output: 54 },
  'kimi-k2.7-code-highspeed': { input: 26, cacheRead: 5.2, output: 108 },
  'kimi-k3': { input: 20, cacheRead: 2, output: 100 },
  'kimi-k2.6': { input: 6.5, cacheRead: 0.6, output: 27 },
  'kimi-k2.5': { input: 4, cacheRead: 0.7, output: 21 },
  'moonshot-v1-8k': { input: 12, cacheRead: 1.2, output: 12 },
  'moonshot-v1-32k': { input: 24, cacheRead: 2.4, output: 24 },
  'moonshot-v1-128k': { input: 60, cacheRead: 6, output: 60 },
  'deepseek-v4-flash': { input: 1, cacheRead: 0.2, output: 2 },
  'deepseek-v4-pro': { input: 12, cacheRead: 1, output: 24 },
});

// 价目表结构版本：v1 单一批发价 → v2 支持峰谷时段。store.initPriceTable 据此做一次迁移。
export const PRICE_TABLE_VERSION = 2;

// Kimi Code 实际模型 key 短名 → 官方价目短名（别名映射，避免用户配置的短名与官方 API 名不一致导致未定价）。
export const KEY_ALIASES = Object.freeze({
  'kimi-for-coding': 'kimi-k2.7-code', // K2.7 Coding
  'kimi-for-coding-highspeed': 'kimi-k2.7-code-highspeed', // K2.7 Coding Highspeed
  'k2p6': 'kimi-k2.6', // Kimi K2.6
  'k3': 'kimi-k3', // K3
  'k3-256k': 'kimi-k3', // K3-256k（参考同价）
  'deepseek-v4-flash-0731': 'deepseek-v4-flash',
});

const ALL_DAYS = Object.freeze([0, 1, 2, 3, 4, 5, 6]);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

// 归一到价目表短名：输入可带 provider 前缀（如 "ark/kimi-k3"）或无前缀（"kimi-k3"），返回斜杠后短名。
export function priceKey(model) {
  const s = String(model ?? '');
  if (!s) return '';
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
}

// 把短名解析到默认价目表里的官方键：精确 → 别名 → 最长前缀（余下以 - / . 开头）。
function resolveKey(short) {
  if (has(DEFAULT_PRICE_TABLE, short)) return short;
  if (has(KEY_ALIASES, short)) return KEY_ALIASES[short];
  let best = null;
  let bestLen = 0;
  for (const key of Object.keys(DEFAULT_PRICE_TABLE)) {
    if (short.startsWith(key)) {
      const rest = short.slice(key.length);
      if (rest.length > 0 && (rest[0] === '-' || rest[0] === '.') && key.length > bestLen) {
        best = key;
        bestLen = key.length;
      }
    }
  }
  return best;
}

// ── 时段模型工具 ────────────────────────────────────────────────

// 'HH:mm'（或 'H:mm'）→ 当日分钟数；'24:00' 合法（= 1440）。非法返回 null。
export function parseHM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (mi > 59) return null;
  if (h === 24) return mi === 0 ? 1440 : null;
  return h > 23 ? null : h * 60 + mi;
}

// 适用日归一：缺省/空/全非法 → 每天（0=周日 .. 6=周六）
export function normalizeDays(days) {
  if (!Array.isArray(days) || !days.length) return [...ALL_DAYS];
  const set = new Set();
  for (const d of days) {
    const n = Number(d);
    if (Number.isInteger(n) && n >= 0 && n <= 6) set.add(n);
  }
  return set.size ? [...set].sort((a, b) => a - b) : [...ALL_DAYS];
}

// 时段类型归一：'peak' | 'offpeak'（缺省视为低谷，因为用户通常只声明闲时窗口）
export function normalizeKind(kind) {
  return kind === 'peak' ? 'peak' : 'offpeak';
}

export const KIND_LABEL = Object.freeze({ peak: '高峰', offpeak: '低谷', flat: '单一价' });

// 命中检测：返回第一个命中的时段对象，未命中返回 null。
// 区间为半开 [start, end)；start > end 视为跨天（如 18:00 → 00:00）。
// 跨天后半段（次日 00:00 起）归属「声明该时段的前一天」，故用 (day+6)%7 反查。
export function matchPeriod(periods, timeMs) {
  if (!Array.isArray(periods) || !periods.length) return null;
  if (typeof timeMs !== 'number' || !Number.isFinite(timeMs)) return null;
  const d = new Date(timeMs);
  const min = d.getHours() * 60 + d.getMinutes();
  const day = d.getDay();
  for (const p of periods) {
    if (!p) continue;
    const s = parseHM(p.start);
    const e = parseHM(p.end);
    if (s == null || e == null || s === e) continue; // 非法 / 零长度时段跳过
    const days = normalizeDays(p.days);
    if (s < e) {
      if (days.includes(day) && min >= s && min < e) return p;
      continue;
    }
    if (min >= s) { if (days.includes(day)) return p; continue; }
    if (min < e && days.includes((day + 6) % 7)) return p;
  }
  return null;
}

// 把命中时段的三档价补齐（缺字段回落基础价），并归一 kind / label。
function periodPrice(p, base) {
  const kind = normalizeKind(p.kind);
  return {
    kind,
    label: typeof p.label === 'string' && p.label ? p.label : KIND_LABEL[kind],
    input: p.input === undefined ? base.input : num(p.input),
    cacheRead: p.cacheRead === undefined ? base.cacheRead : num(p.cacheRead),
    output: p.output === undefined ? base.output : num(p.output),
  };
}

// ── 条目解析 ────────────────────────────────────────────────────

export function cloneEntry(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  const out = { input: num(entry.input), cacheRead: num(entry.cacheRead), output: num(entry.output) };
  // periods 为「显式给出」时原样保留（含空数组 —— 空数组表示明确停用峰谷，不能被当成未设置而回落内置时段）
  if (Array.isArray(entry.periods)) {
    out.periods = entry.periods.map((p) => ({
      kind: normalizeKind(p && p.kind),
      start: String((p && p.start) ?? ''),
      end: String((p && p.end) ?? ''),
      days: normalizeDays(p && p.days),
      input: num(p && p.input),
      cacheRead: num(p && p.cacheRead),
      output: num(p && p.output),
    }));
  }
  return out;
}

export function clonePriceTable(table) {
  const out = {};
  for (const [k, v] of Object.entries(table || {})) out[k] = cloneEntry(v);
  return out;
}

// 用户条目与内置默认合并：periods 仅在用户「显式给出」时生效（undefined → 继承内置默认）。
function mergeEntry(user, def) {
  const periods = user.periods !== undefined ? user.periods : def && def.periods;
  const e = { input: num(user.input), cacheRead: num(user.cacheRead), output: num(user.output) };
  if (Array.isArray(periods) && periods.length) e.periods = periods;
  return e;
}

// 返回某模型的生效条目（含 periods）；未定价返回 null。
// overrides：价目表覆盖（用户在「价目表」设置的内容），可省略。覆盖键以模型短名为准，官方键亦可命中。
export function getPriceEntry(model, overrides = null) {
  const short = priceKey(model);
  if (!short) return null;
  if (overrides && has(overrides, short) && overrides[short]) {
    const key = resolveKey(short);
    return mergeEntry(overrides[short], key ? DEFAULT_PRICE_TABLE[key] : null);
  }
  const key = resolveKey(short);
  if (!key) return null;
  const def = DEFAULT_PRICE_TABLE[key];
  const eff = (overrides && has(overrides, key) && overrides[key]) || def;
  if (!eff) return null;
  return mergeEntry(eff, def);
}

// 返回某模型的基础三档价（峰谷条目返回其兜底/高峰价）；未定价返回 null。
// 单一批价调用方保持此接口即可，行为与峰谷上线前完全一致。
export function getPrice(model, overrides = null) {
  const e = getPriceEntry(model, overrides);
  if (!e) return null;
  return { input: e.input, cacheRead: e.cacheRead, output: e.output };
}

// 按时点解析生效单价（峰谷计价核心入口）：
// 返回 { input, cacheRead, output, kind, label, tou }；未定价返回 null。
//   kind: 'flat'（单一计价）| 'peak'（高峰/兜底价）| 'offpeak'（低谷）
//   tou:  该条目是否启用了峰谷时段
// timeMs 缺省（null）→ 一律回落到兜底价（kind='flat'），便于与 calcCost 保持同一口径。
export function resolvePrice(model, overrides = null, timeMs = null) {
  const e = getPriceEntry(model, overrides);
  if (!e) return null;
  const base = { input: e.input, cacheRead: e.cacheRead, output: e.output };
  const tou = Array.isArray(e.periods) && e.periods.length > 0;
  if (!tou || timeMs == null) return { ...base, kind: 'flat', label: KIND_LABEL.flat, tou };
  const p = matchPeriod(e.periods, timeMs);
  if (!p) return { ...base, kind: 'peak', label: KIND_LABEL.peak, tou: true };
  return { ...periodPrice(p, base), tou: true };
}

// 用「已解析单价」直接计费（供已自行取价的聚合循环复用，避免重复解析）：
//   cost = input/1e6*p.input + cacheRead/1e6*p.cacheRead + output/1e6*p.output
// usage 形如 {input, cacheRead, output}（input 由调用方决定是否含缓存写）。p 为 null（未定价）返回 null。
export function costWithPrice(p, usage = {}) {
  if (!p) return null;
  const input = usage.input || 0;
  const cacheRead = usage.cacheRead || 0;
  const output = usage.output || 0;
  return (input / 1e6) * p.input + (cacheRead / 1e6) * p.cacheRead + (output / 1e6) * p.output;
}

// 估算花费（元）：基础三档价口径（不区分时段），保持既有调用方行为不变。
export function calcCost(model, usage = {}, overrides = null) {
  return calcCostAt(model, usage, overrides, null);
}

// 按时点计费：timeMs 命中峰谷时段则用该时段单价，否则用兜底价；timeMs 为 null 时等同 calcCost。
export function calcCostAt(model, usage = {}, overrides = null, timeMs = null) {
  return costWithPrice(resolvePrice(model, overrides, timeMs), usage);
}

// ── 价目表升级迁移（v1 单一价 → v2 峰谷价）────────────────────────
// 判定「用户未改动过该行」：无 periods 且三档价与 v1 内置价逐一相等。
function untouched(cur, legacy) {
  if (!cur || !legacy) return false;
  if (Array.isArray(cur.periods) && cur.periods.length) return false;
  return num(cur.input) === legacy.input && num(cur.cacheRead) === legacy.cacheRead && num(cur.output) === legacy.output;
}

// 把已存储的价目表迁移到新版内置价目表：
//   - 未改动过的行 → 升级为新默认（拿到峰谷时段）；
//   - 用户改动过的行 → 原样保留；
//   - 只在旧表里存在的行（用户自建）→ 保留；
//   - 只在默认表里存在的行（新增模型）→ 补齐默认。
export function migratePriceTable(stored, legacy = LEGACY_PRICE_TABLE) {
  const out = clonePriceTable(stored);
  for (const [k, v] of Object.entries(DEFAULT_PRICE_TABLE)) {
    if (!has(out, k)) {
      if (!has(legacy, k)) out[k] = cloneEntry(v);
      continue;
    }
    if (untouched(out[k], legacy[k])) out[k] = cloneEntry(v);
  }
  return out;
}

// 时段可读描述（UI / 提示用）：'低谷 00:00-09:00' + 适用日后缀
export function describePeriod(p) {
  const kind = normalizeKind(p && p.kind);
  const days = normalizeDays(p && p.days);
  const everyDay = days.length === 7;
  const week = ['日', '一', '二', '三', '四', '五', '六'];
  const dayText = everyDay ? '' : ' · 周' + days.map((d) => week[d]).join('');
  return `${KIND_LABEL[kind]} ${String((p && p.start) ?? '')}-${String((p && p.end) ?? '')}${dayText}`;
}
