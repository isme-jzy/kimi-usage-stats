import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PRICE_TABLE, priceKey, getPrice, calcCost } from '../lib/pricing.js';
import { aggregateByModel, summarize, fmtCost } from '../lib/aggregate.js';

// 固定 now = 2026-08-13 15:00:00 本地时间，仅用 'all' 区间避免日期边界干扰
const NOW = new Date(2026, 7, 13, 15, 0, 0).getTime();
const rangeAll = { from: 0, to: null };

const rec = (model, inputOther, inputCacheRead, inputCacheCreation, output) => ({
  time: NOW, model, inputOther, inputCacheRead, inputCacheCreation, output,
  streamDurationMs: 1000, workspace: 'wd_a', sessionId: 'session_x', agent: 'main',
});

test('DEFAULT_PRICE_TABLE 覆盖指定模型与三档字段', () => {
  for (const key of ['kimi-k2.7-code', 'kimi-k2.7-code-highspeed', 'kimi-k3', 'kimi-k2.6', 'kimi-k2.5']) {
    const p = DEFAULT_PRICE_TABLE[key];
    assert.ok(p, `缺少默认价目：${key}`);
    for (const f of ['input', 'cacheRead', 'output']) {
      assert.equal(typeof p[f], 'number', `${key}.${f} 应为数值`);
      assert.ok(p[f] > 0, `${key}.${f} 应大于 0`);
    }
  }
});

test('默认价目数值符合预设计价', () => {
  assert.deepEqual(DEFAULT_PRICE_TABLE['kimi-k2.7-code'], { input: 13, cacheRead: 2.6, output: 54 });
  assert.deepEqual(DEFAULT_PRICE_TABLE['kimi-k2.7-code-highspeed'], { input: 26, cacheRead: 5.2, output: 108 });
  assert.deepEqual(DEFAULT_PRICE_TABLE['kimi-k3'], { input: 20, cacheRead: 2, output: 100 });
});

test('priceKey：无前缀短名原样，带 provider 前缀取斜杠后短名', () => {
  assert.equal(priceKey('kimi-k3'), 'kimi-k3');
  assert.equal(priceKey('ark/kimi-k3'), 'kimi-k3');
  assert.equal(priceKey('kimi-code/k3'), 'k3');
  assert.equal(priceKey(''), '');
  assert.equal(priceKey(null), '');
});

test('getPrice：精确、后缀匹配、统一返回三档对象', () => {
  assert.deepEqual(getPrice('kimi-k2.7-code'), { input: 13, cacheRead: 2.6, output: 54 });
  // config key 带 provider 前缀 → 后缀匹配到价目
  assert.deepEqual(getPrice('ark/kimi-k2.7-code'), { input: 13, cacheRead: 2.6, output: 54 });
  assert.deepEqual(getPrice('kimi-code/k3', { ...DEFAULT_PRICE_TABLE, k3: { input: 1, cacheRead: 2, output: 3 } }),
    { input: 1, cacheRead: 2, output: 3 });
  // 不传 overrides：别名 k3 → kimi-k3 默认价
  assert.deepEqual(getPrice('kimi-code/k3'), { input: 20, cacheRead: 2, output: 100 });
});

test('getPrice：未定价模型返回 null，overrides 不影响默认定价模型缺省', () => {
  assert.equal(getPrice('foo/bar-baz'), null);
  assert.equal(getPrice(''), null);
  assert.equal(getPrice(undefined), null);
});

test('getPrice：Kimi Code 实际短名通过别名映射到官方价', () => {
  assert.deepEqual(getPrice('kimi-code/kimi-for-coding'), { input: 13, cacheRead: 2.6, output: 54 });
  assert.deepEqual(getPrice('kimi-code/kimi-for-coding-highspeed'), { input: 26, cacheRead: 5.2, output: 108 });
  assert.deepEqual(getPrice('kimi-for-coding/k2p6'), { input: 6.5, cacheRead: 0.6, output: 27 });
  assert.deepEqual(getPrice('kimi-code/k3-256k'), { input: 20, cacheRead: 2, output: 100 });
});

test('getPrice：DeepSeek 内置参考价（峰谷制度下取高峰基础价）+ 带日期后缀模型前缀兜底', () => {
  // DeepSeek 自 2026-08-17 起峰谷定价：此项返回「基础价 = 高峰价」，闲时价见 periods
  assert.deepEqual(getPrice('deepseek/deepseek-v4-flash'), { input: 3, cacheRead: 0.1, output: 9 });
  assert.deepEqual(getPrice('ark/deepseek-v4-pro'), { input: 9, cacheRead: 0.3, output: 27 });
  // 前缀兜底：0731 等日期后缀 → deepseek-v4-flash
  assert.deepEqual(getPrice('alibaba-token-plan-cn/deepseek-v4-flash-0731'), { input: 3, cacheRead: 0.1, output: 9 });
  // 防误配：kimi-k30 不应命中 kimi-k3
  assert.equal(getPrice('kimi-k30'), null);
});

test('calcCost：别名与 DeepSeek 模型按价计费', () => {
  // k3-256k（别名 kimi-k3）1M 输入 + 1M 缓存读 + 1M 输出 → 20+2+100
  assert.equal(calcCost('kimi-code/k3-256k', { input: 1e6, cacheRead: 1e6, output: 1e6 }), 122);
  // deepseek-v4-flash 未带时间（calcCost 走基础价=高峰价）1M 输入 + 1M 缓存读 + 1M 输出 → 3+0.1+9
  assert.equal(calcCost('ark/deepseek-v4-flash', { input: 1e6, cacheRead: 1e6, output: 1e6 }), 12.1);
});

test('calcCost：三档计价正确（1M 输入 + 1M 缓存读 + 1M 输出 → 13+2.6+54=69.6）', () => {
  const cost = calcCost('kimi-k2.7-code', { input: 1e6, cacheRead: 1e6, output: 1e6 });
  assert.equal(cost, 69.6);
  assert.ok(Math.abs(cost - (13 + 2.6 + 54)) < 1e-9);
});

test('calcCost：按 token 数比例计费', () => {
  // 0.5M 输入 kimi-k2.7-code → 13/2 = 6.5
  assert.equal(calcCost('kimi-k2.7-code', { input: 500000, cacheRead: 0, output: 0 }), 6.5);
  // 只输出 200k kimi-k3 → 100 * 0.2 = 20
  assert.equal(calcCost('kimi-k3', { input: 0, cacheRead: 0, output: 200000 }), 20);
});

test('calcCost：未定价 / 缺省用量字段返回 null 或 0', () => {
  assert.equal(calcCost('unknown-model', { input: 1e6, cacheRead: 0, output: 0 }), null);
  // 未定价：即使有 overrides 也只在覆盖里命中才算
  assert.equal(calcCost('unknown-model', { input: 1e6 }, { 'unknown-model': { input: 5, cacheRead: 1, output: 20 } }), 5);
  // 缺省 usage 字段按 0 计
  assert.equal(calcCost('kimi-k3', { input: 1e6 }), 20);
  assert.equal(calcCost('kimi-k3', {}), 0);
});

test('calcCost：override 覆盖默认定价', () => {
  const overrides = { 'kimi-k2.7-code': { input: 100, cacheRead: 10, output: 200 } };
  // 100/1e6*1e6 + 10/1e6*1e6 + 200/1e6*1e6 = 310
  assert.equal(calcCost('kimi-k2.7-code', { input: 1e6, cacheRead: 1e6, output: 1e6 }, overrides), 310);
  // 返回 getPrice 也取覆盖值
  assert.deepEqual(getPrice('kimi-k2.7-code', overrides), { input: 100, cacheRead: 10, output: 200 });
});

test('aggregateByModel：cost 字段按默认价目表计算，未定价为 null', () => {
  const CONFIG = [{ key: 'ark/kimi-k3', provider: 'ark', model: 'kimi-k3', displayName: 'K3' }];
  const rows = aggregateByModel(
    [rec('ark/kimi-k3', 1e6, 1e6, 0, 1e6), rec('ark/some-unknown', 100, 0, 0, 100)],
    CONFIG, rangeAll,
  );
  const k3 = rows.find((r) => r.key === 'ark/kimi-k3');
  // input 口径 = inputOther + inputCacheCreation = 1e6; cacheRead 1e6; output 1e6
  assert.equal(k3.cost, 20 + 2 + 100);
  const unknown = rows.find((r) => r.key === 'ark/some-unknown');
  assert.equal(unknown.cost, null);
});

test('aggregateByModel：cost 尊重 priceOverrides 覆盖', () => {
  const CONFIG = [{ key: 'kimi-code/k3', provider: 'kimi-code', model: 'k3', displayName: 'K3' }];
  const overrides = { k3: { input: 5, cacheRead: 1, output: 10 } };
  const rows = aggregateByModel([rec('kimi-code/k3', 1e6, 1e6, 0, 1e6)], CONFIG, rangeAll, overrides);
  // 无覆盖时 k3 经别名命中 kimi-k3 默认价 20+2+100=122；覆盖后按 5+1+10=16 计
  const without = aggregateByModel([rec('kimi-code/k3', 1e6, 1e6, 0, 1e6)], CONFIG, rangeAll).find((r) => r.key === 'kimi-code/k3');
  assert.equal(without.cost, 20 + 2 + 100);
  assert.equal(rows.find((r) => r.key === 'kimi-code/k3').cost, 16);
});

test('summarize：cost 汇总只累加已定价模型', () => {
  const rows = [
    { total: 10, output: 10, requests: 1, sumStreamMs: 0, inputCacheRead: 0, inputOther: 0, cost: 69.6 },
    { total: 5, output: 5, requests: 1, sumStreamMs: 0, inputCacheRead: 0, inputOther: 0, cost: null },
  ];
  const s = summarize(rows);
  assert.equal(s.cost, 69.6); // 未定价行不计
});

test('fmtCost：金额格式化', () => {
  assert.equal(fmtCost(69.6), '¥69.60');
  assert.equal(fmtCost(0), '¥0.00');
  assert.equal(fmtCost(null), '—');
});