// 纯函数价目表模块：不碰 DOM / IndexedDB，浏览器与 Node 通用。
// 单价单位：元 / 百万 tokens（三档：input 普通输入、cacheRead 缓存命中读取、output 输出）。
// 缓存写（cacheWrite）不单独计费，归入 input 口径，由调用方决定 input 的取值。
//
// 匹配策略（由 getPrice 归纳）：
//   1. 精确短名命中（overrides 用户覆盖 > 默认表）
//   2. KEY_ALIASES 别名映射（Kimi Code 实际模型 key 短名 → 官方价目短名）
//   3. 前缀兜底（如 deepseek-v4-flash-0731 → deepseek-v4-flash，要求余下以 - / . 开头避免误配）
// 仍找不到 → 未定价，返回 null（UI 显示 —，可到「价目表」手动设置）。

// 内置默认价目表：键为模型短名（config.toml models key 去 `provider/` 前缀，如 ark/kimi-k3 → kimi-k3）。
// 取值参考公开价目；`元/百万 tokens`。
// 注：价格为公开参考价，可能随官方调整；DeepSeek 有高峰/闲时之分，此处取常规参考价，可在「价目表」内修改。
export const DEFAULT_PRICE_TABLE = Object.freeze({
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

// Kimi Code 实际模型 key 短名 → 官方价目短名（别名映射，避免用户配置的短名与官方 API 名不一致导致未定价）。
export const KEY_ALIASES = Object.freeze({
  'kimi-for-coding': 'kimi-k2.7-code', // K2.7 Coding
  'kimi-for-coding-highspeed': 'kimi-k2.7-code-highspeed', // K2.7 Coding Highspeed
  'k2p6': 'kimi-k2.6', // Kimi K2.6
  'k3': 'kimi-k3', // K3
  'k3-256k': 'kimi-k3', // K3-256k（参考同价）
  'deepseek-v4-flash-0731': 'deepseek-v4-flash',
});

// 归一到价目表短名：输入可带 provider 前缀（如 "ark/kimi-k3"）或无前缀（"kimi-k3"），返回斜杠后短名。
export function priceKey(model) {
  const s = String(model ?? '');
  if (!s) return '';
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
}

// 把短名解析到默认价目表里的官方键：精确 → 别名 → 最长前缀（余下以 - / . 开头）。
function resolveKey(short) {
  if (Object.prototype.hasOwnProperty.call(DEFAULT_PRICE_TABLE, short)) return short;
  if (Object.prototype.hasOwnProperty.call(KEY_ALIASES, short)) return KEY_ALIASES[short];
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

const toPrice = (p) => ({ input: p.input, cacheRead: p.cacheRead, output: p.output });

// 返回某模型 {input, cacheRead, output}；未定价返回 null。
// overrides：价目表覆盖（用户在「价目表」设置的内容），可省略。覆盖键以模型短名为准，官方键亦可命中。
export function getPrice(model, overrides = null) {
  const short = priceKey(model);
  if (!short) return null;
  const has = Object.prototype.hasOwnProperty;
  if (overrides && has.call(overrides, short) && overrides[short]) return toPrice(overrides[short]);
  const key = resolveKey(short);
  if (!key) return null;
  const eff = (overrides && has.call(overrides, key) && overrides[key]) || DEFAULT_PRICE_TABLE[key];
  if (!eff) return null;
  return toPrice(eff);
}

// 估算花费（元）：
//   cost = input/1e6*p.input + cacheRead/1e6*p.cacheRead + output/1e6*p.output
// usage 形如 {input, cacheRead, output}（input 由调用方决定是否含缓存写）。未定价返回 null。
export function calcCost(model, usage = {}, overrides = null) {
  const p = getPrice(model, overrides);
  if (!p) return null;
  const input = usage.input || 0;
  const cacheRead = usage.cacheRead || 0;
  const output = usage.output || 0;
  return (input / 1e6) * p.input + (cacheRead / 1e6) * p.cacheRead + (output / 1e6) * p.output;
}