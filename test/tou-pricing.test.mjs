// 峰谷计价单测：时段匹配（含跨天/适用日）、按时取价、聚合分桶、价目表升级迁移与向后兼容。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PRICE_TABLE, LEGACY_PRICE_TABLE, PRICE_TABLE_VERSION,
  parseHM, normalizeDays, normalizeKind, matchPeriod, describePeriod,
  cloneEntry, clonePriceTable, getPriceEntry, getPrice, resolvePrice,
  calcCost, calcCostAt, costWithPrice, migratePriceTable,
} from '../lib/pricing.js';
import {
  aggregateByModel, aggregateBySession, interruptStats, summarize, recordUsage,
} from '../lib/aggregate.js';

// 本地时间构造：基准日 2026-08-13（星期几由 getDay 现取，避免手算星期出错）
const BASE = new Date(2026, 7, 13);
const WED = BASE.getDay(); // 基准日星期
const D = (h, mi = 0, dayOffset = 0) => new Date(2026, 7, 13 + dayOffset, h, mi, 0, 0).getTime();
const rangeAll = { from: 0, to: null };

const DS_FLASH = { key: 'ark/deepseek-v4-flash', provider: 'ark', model: 'deepseek-v4-flash', displayName: 'DeepSeek Flash' };
// 1M 输入 + 1M 缓存读 + 1M 输出：高峰 3+0.1+9；闲时 1.5+0.05+4.5
const usageTriple = { input: 1e6, cacheRead: 1e6, output: 1e6 };
const rec = (time, model, extra = {}) => ({
  time, model, inputOther: 1e6, inputCacheRead: 1e6, inputCacheCreation: 0, output: 1e6,
  streamDurationMs: 1000, workspace: 'wd_a', sessionId: 'session_x', agent: 'main', ...extra,
});

// ── 时段解析与匹配 ──────────────────────────────────────────

test('parseHM：合法 HH:mm 与 24:00，非法一律 null', () => {
  assert.equal(parseHM('00:00'), 0);
  assert.equal(parseHM('09:00'), 540);
  assert.equal(parseHM('9:05'), 545);
  assert.equal(parseHM('23:59'), 1439);
  assert.equal(parseHM('24:00'), 1440);
  assert.equal(parseHM(' 12:30 '), 750);
  for (const bad of ['', null, undefined, '24:01', '25:00', '09:60', '0900', '9', 'ab:cd']) {
    assert.equal(parseHM(bad), null, `应拒绝：${String(bad)}`);
  }
});

test('normalizeDays：缺省/空/全非法回落每天，去重排序', () => {
  assert.deepEqual(normalizeDays(undefined), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(normalizeDays([]), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(normalizeDays([9, -1]), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(normalizeDays([5, 1, 1]), [1, 5]);
  assert.deepEqual(normalizeDays(['6', '0']), [0, 6]);
});

test('normalizeKind：仅 peak 为高峰，其余一律低谷', () => {
  assert.equal(normalizeKind('peak'), 'peak');
  assert.equal(normalizeKind('offpeak'), 'offpeak');
  assert.equal(normalizeKind(undefined), 'offpeak');
  assert.equal(normalizeKind('other'), 'offpeak');
});

test('matchPeriod：半开区间 [start, end)，端点归属正确', () => {
  const p = [{ kind: 'offpeak', start: '00:00', end: '09:00' }];
  assert.ok(matchPeriod(p, D(0, 0)));
  assert.ok(matchPeriod(p, D(8, 59)));
  assert.equal(matchPeriod(p, D(9, 0)), null); // 右端点不含
  assert.equal(matchPeriod(p, D(12, 0)), null);
});

test('matchPeriod：18:00 → 00:00 表示当日 [18:00, 24:00)，不侵入次日凌晨', () => {
  const p = [{ kind: 'offpeak', start: '18:00', end: '00:00' }];
  assert.ok(matchPeriod(p, D(18, 0)));
  assert.ok(matchPeriod(p, D(23, 59)));
  assert.equal(matchPeriod(p, D(0, 30)), null);
  assert.equal(matchPeriod(p, D(17, 59)), null);
});

test('matchPeriod：真跨天 22:00 → 06:00，次日凌晨归属「声明该时段的前一天」', () => {
  const p = [{ kind: 'offpeak', start: '22:00', end: '06:00', days: [WED] }];
  assert.ok(matchPeriod(p, D(23, 0, 0)));            // 基准日（WED）23:00
  assert.ok(matchPeriod(p, D(3, 0, 1)));             // 次日 03:00 → 归属 WED 的时段
  assert.equal(matchPeriod(p, D(7, 0, 1)), null);    // 次日 07:00 出窗
  assert.equal(matchPeriod(p, D(23, 0, -1)), null);  // 前一天（非 WED）不适用
  assert.equal(matchPeriod(p, D(3, 0, 2)), null);    // 隔天凌晨不再归属
});

test('matchPeriod：适用日过滤（每天 / 工作日 / 周末）', () => {
  const every = [{ start: '09:00', end: '12:00' }];
  const wedOnly = [{ start: '09:00', end: '12:00', days: [WED] }];
  const other = [{ start: '09:00', end: '12:00', days: [(WED + 1) % 7] }];
  assert.ok(matchPeriod(every, D(10, 0)));
  assert.ok(matchPeriod(wedOnly, D(10, 0)));
  assert.equal(matchPeriod(other, D(10, 0)), null);
});

test('matchPeriod：先声明者优先；非法/零长度时段跳过；入参异常返回 null', () => {
  const p = [
    { kind: 'peak', start: '09:00', end: '12:00' },
    { kind: 'offpeak', start: '10:00', end: '11:00' },
  ];
  assert.equal(matchPeriod(p, D(10, 30)).kind, 'peak'); // 前一条先命中
  assert.equal(matchPeriod([{ start: '09:00', end: '09:00' }], D(9, 0)), null);
  assert.equal(matchPeriod([{ start: 'xx', end: '10:00' }], D(9, 0)), null);
  assert.equal(matchPeriod([], D(9, 0)), null);
  assert.equal(matchPeriod(null, D(9, 0)), null);
  assert.equal(matchPeriod([{ start: '08:00', end: '09:00' }], null), null);
  assert.equal(matchPeriod([{ start: '08:00', end: '09:00' }], 'x'), null);
  assert.equal(matchPeriod([null, undefined], D(9, 0)), null);
});

test('describePeriod：可读时段描述 + 适用日后缀', () => {
  assert.equal(describePeriod({ kind: 'offpeak', start: '00:00', end: '09:00' }), '低谷 00:00-09:00');
  assert.equal(describePeriod({ kind: 'peak', start: '09:00', end: '12:00', days: [1, 2, 3, 4, 5] }), '高峰 09:00-12:00 · 周一二三四五');
});

// ── 取价与计费 ──────────────────────────────────────────────

test('内置价目表：DeepSeek 为峰谷条目（基础价=高峰价，另带 3 段闲时窗口）', () => {
  const flash = DEFAULT_PRICE_TABLE['deepseek-v4-flash'];
  assert.deepEqual({ input: flash.input, cacheRead: flash.cacheRead, output: flash.output }, { input: 3, cacheRead: 0.1, output: 9 });
  assert.equal(flash.periods.length, 3);
  for (const p of flash.periods) {
    assert.equal(p.kind, 'offpeak');
    assert.deepEqual([p.input, p.cacheRead, p.output], [1.5, 0.05, 4.5]); // 闲时 = 高峰的一半
  }
  const pro = DEFAULT_PRICE_TABLE['deepseek-v4-pro'];
  assert.deepEqual([pro.input, pro.cacheRead, pro.output], [9, 0.3, 27]);
  assert.deepEqual([pro.periods[0].input, pro.periods[0].cacheRead, pro.periods[0].output], [4.5, 0.15, 13.5]);
  // 未启用峰谷的模型不带 periods
  assert.equal(DEFAULT_PRICE_TABLE['kimi-k3'].periods, undefined);
});

test('getPriceEntry：用户条目缺 periods 时继承内置时段；显式 [] 表示停用', () => {
  const inherited = getPriceEntry('deepseek-v4-flash', { 'deepseek-v4-flash': { input: 6, cacheRead: 0.2, output: 18 } });
  assert.deepEqual([inherited.input, inherited.cacheRead, inherited.output], [6, 0.2, 18]);
  assert.equal(inherited.periods.length, 3); // 未给 periods → 继承内置
  const disabled = getPriceEntry('deepseek-v4-flash', { 'deepseek-v4-flash': { input: 6, cacheRead: 0.2, output: 18, periods: [] } });
  assert.equal(disabled.periods, undefined);
  // 别名短名也走同一套继承
  const aliased = getPriceEntry('alibaba-token-plan-cn/deepseek-v4-flash-0731', null);
  assert.equal(aliased.periods.length, 3);
});

test('resolvePrice：无峰谷模型恒为 flat，未定价为 null', () => {
  assert.equal(resolvePrice('kimi-code/k3-256k', null, D(10, 0)).kind, 'flat');
  assert.equal(resolvePrice('kimi-code/k3-256k', null, D(10, 0)).tou, false);
  assert.deepEqual(getPrice('ark/kimi-k3'), { input: 20, cacheRead: 2, output: 100 });
  assert.equal(resolvePrice('unknown-model', null, D(10, 0)), null);
  assert.equal(resolvePrice('', null, D(10, 0)), null);
});

test('resolvePrice：DeepSeek 按时段取价（高峰=基础价，闲时=半价）', () => {
  const at = (h, mi = 0) => resolvePrice('ark/deepseek-v4-flash', null, D(h, mi));
  assert.deepEqual([at(9, 30).kind, at(9, 30).input, at(9, 30).output], ['peak', 3, 9]);
  assert.deepEqual([at(15, 0).kind, at(15, 0).input, at(15, 0).output], ['peak', 3, 9]);   // 14:00-18:00 高峰
  assert.deepEqual([at(3, 0).kind, at(3, 0).input, at(3, 0).output], ['offpeak', 1.5, 4.5]);
  assert.deepEqual([at(13, 0).kind, at(13, 0).input, at(13, 0).output], ['offpeak', 1.5, 4.5]); // 12:00-14:00 闲时
  assert.deepEqual([at(20, 0).kind, at(20, 0).input, at(20, 0).output], ['offpeak', 1.5, 4.5]); // 18:00-24:00 闲时
  assert.equal(at(12, 0).kind, 'offpeak'); // 高峰 09:00-12:00 右开 → 12:00 起属闲时
  assert.equal(at(14, 0).kind, 'peak');    // 14:00 起回到高峰（右开）
  assert.equal(at(8, 59).kind, 'offpeak');
  assert.equal(at(9, 0).kind, 'peak');
  assert.equal(at(3, 0).tou, true);
  assert.equal(at(3, 0).label, '低谷');
  // 未给时间 → 退化为基础价（与 calcCost 同口径），但标记该条目启用了峰谷
  const noTime = resolvePrice('ark/deepseek-v4-flash', null, null);
  assert.deepEqual([noTime.kind, noTime.input, noTime.tou], ['flat', 3, true]);
});

test('calcCostAt：同一用量在不同时段得到不同金额；calcCost 保持基础价口径', () => {
  assert.equal(calcCostAt('ark/deepseek-v4-flash', usageTriple, null, D(3, 0)), 6.05);   // 1.5+0.05+4.5
  assert.equal(calcCostAt('ark/deepseek-v4-flash', usageTriple, null, D(10, 0)), 12.1);  // 3+0.1+9
  assert.equal(calcCost('ark/deepseek-v4-flash', usageTriple), 12.1);                     // 无时间 → 基础价
  assert.equal(calcCostAt('unknown-model', usageTriple, null, D(3, 0)), null);
  assert.equal(calcCostAt('ark/deepseek-v4-flash', {}, null, D(3, 0)), 0);
});

test('costWithPrice：直接用已解析单价计费，p 为空返回 null', () => {
  assert.equal(costWithPrice({ input: 2, cacheRead: 1, output: 4 }, { input: 1e6, cacheRead: 1e6, output: 1e6 }), 7);
  assert.equal(costWithPrice(null, usageTriple), null);
});

test('recordUsage：缓存写归入输入口径', () => {
  assert.deepEqual(recordUsage({ inputOther: 1, inputCacheCreation: 2, inputCacheRead: 3, output: 4 }),
    { input: 3, cacheRead: 3, output: 4 });
  assert.deepEqual(recordUsage({}), { input: 0, cacheRead: 0, output: 0 });
});

// ── 聚合分桶 ────────────────────────────────────────────────

test('aggregateByModel：同一模型按记录时间分时段计费并汇总总成本', () => {
  const rows = aggregateByModel([rec(D(3), DS_FLASH.key), rec(D(10), DS_FLASH.key)], [DS_FLASH], rangeAll);
  const r = rows[0];
  assert.equal(r.requests, 2);
  assert.equal(r.total, 6e6);
  assert.ok(Math.abs(r.cost - (6.05 + 12.1)) < 1e-9); // 闲时 + 高峰
  assert.equal(r.tou, true);
  assert.equal(r.tiers.offpeak.token, 3e6);
  assert.ok(Math.abs(r.tiers.offpeak.cost - 6.05) < 1e-9);
  assert.equal(r.tiers.peak.token, 3e6);
  assert.ok(Math.abs(r.tiers.peak.cost - 12.1) < 1e-9);
  assert.equal(r.tiers.flat.token, 0);
  assert.equal(r.tiers.flat.cost, 0);
});

test('aggregateByModel：多段闲时窗口分别命中，峰值桶只收高峰记录', () => {
  const rows = aggregateByModel(
    [rec(D(1), DS_FLASH.key), rec(D(13), DS_FLASH.key), rec(D(20), DS_FLASH.key), rec(D(16), DS_FLASH.key)],
    [DS_FLASH], rangeAll,
  );
  const r = rows[0];
  assert.equal(r.tiers.offpeak.token, 3e6 * 3);  // 01:00 / 13:00 / 20:00 三段闲时
  assert.equal(r.tiers.peak.token, 3e6 * 1);     // 16:00 高峰
  assert.ok(Math.abs(r.cost - (6.05 * 3 + 12.1)) < 1e-9);
});

test('aggregateByModel：未启用峰谷的模型全部计入 flat 桶且 tou=false', () => {
  const CONFIG = [{ key: 'kimi-code/k3-256k', provider: 'kimi-code', model: 'k3-256k', displayName: 'K3 256K' }];
  const rows = aggregateByModel(
    [{ ...rec(D(3), 'kimi-code/k3-256k'), inputOther: 0, output: 1e6 }],
    CONFIG, rangeAll,
  );
  const r = rows[0];
  assert.equal(r.tou, false);
  assert.equal(r.tiers.flat.token, 2e6); // 1M 缓存读 + 1M 输出
  assert.equal(r.tiers.peak.token, 0);
  assert.equal(r.tiers.offpeak.cost, 0);
  assert.equal(r.cost, 2 + 100); // 缓存读 2 + 输出 100（kimi-k3，全天单一价）
});

test('aggregateByModel：显式停用峰谷（periods: []）后全时段按基础价', () => {
  const overrides = { 'deepseek-v4-flash': { input: 6, cacheRead: 0, output: 12, periods: [] } };
  const rows = aggregateByModel([rec(D(3), DS_FLASH.key)], [DS_FLASH], rangeAll, overrides);
  const r = rows[0];
  assert.equal(r.tou, false);
  assert.equal(r.tiers.flat.cost, 18); // 6 + 0 + 12
  assert.equal(r.tiers.offpeak.cost, 0);
});

test('aggregateByModel：未定价模型仍为 cost=null，不受峰谷改动影响', () => {
  const rows = aggregateByModel([rec(D(3), 'ark/no-such-model')], [], rangeAll);
  assert.equal(rows[0].cost, null);
  assert.equal(rows[0].tiers.offpeak.token, 0); // 未定价 → 不进任何桶
  assert.equal(rows[0].tou, false);
});

test('summarize：汇总峰/谷/单一价三桶花费与 token，并给出 tou 标记', () => {
  const mixed = aggregateByModel(
    [rec(D(3), DS_FLASH.key), rec(D(10), DS_FLASH.key), { ...rec(D(4), 'kimi-code/k3-256k'), output: 1e6 }],
    [DS_FLASH, { key: 'kimi-code/k3-256k', displayName: 'K3' }], rangeAll,
  );
  const s = summarize(mixed);
  assert.equal(s.tou, true);
  assert.ok(Math.abs(s.tier.offpeak.cost - 6.05) < 1e-9); // DS 03:00 闲时
  assert.ok(Math.abs(s.tier.peak.cost - 12.1) < 1e-9);    // DS 10:00 高峰
  assert.equal(s.tier.flat.cost, 122);                    // kimi-k3 全天单一价：20+2+100
  assert.equal(s.tier.offpeak.token, 3e6);
  assert.equal(s.tier.flat.token, 3e6);
  assert.equal(s.tier.peak.token, 3e6);
  assert.ok(Math.abs(s.cost - (6.05 + 12.1 + 122)) < 1e-9); // = 三桶之和
  // 全程单一价 → tou=false，且全部计入 flat 桶
  const flatOnly = summarize(aggregateByModel([rec(D(3), 'kimi-code/k3-256k')], [{ key: 'kimi-code/k3-256k', displayName: 'K3' }], rangeAll));
  assert.equal(flatOnly.tou, false);
  assert.equal(flatOnly.tier.flat.token, 3e6);
  assert.equal(flatOnly.tier.flat.cost, 122);
});

test('aggregateBySession / interruptStats：会话与中断金额同样逐条按时间取价', () => {
  const recs = [rec(D(3), DS_FLASH.key, { turnId: '1' }), rec(D(10), DS_FLASH.key, { turnId: '1' })];
  const sessions = aggregateBySession(recs, [DS_FLASH], rangeAll);
  assert.equal(sessions.length, 1);
  assert.ok(Math.abs(sessions[0].cost - (6.05 + 12.1)) < 1e-9);
  const s = interruptStats(recs, [{ turnId: '1', reason: 'cancelled', time: D(10), kind: 'ended' }], [DS_FLASH], rangeAll);
  assert.equal(s.count, 2);
  assert.ok(Math.abs(s.cost - (6.05 + 12.1)) < 1e-9);
  assert.equal(s.byModel[0].tou, true);
});

// ── 价目表升级迁移 ──────────────────────────────────────────

test('cloneEntry：深拷贝 periods，改副本不影响源', () => {
  const src = getPriceEntry('deepseek-v4-flash', null);
  const copy = cloneEntry(src);
  copy.periods[0].input = 999;
  assert.equal(src.periods[0].input, 1.5);
  assert.notEqual(copy.periods, src.periods);
});

test('migratePriceTable：未改动过的行升级到新默认（拿到峰谷时段）', () => {
  const stored = clonePriceTable(LEGACY_PRICE_TABLE);
  assert.equal(stored['deepseek-v4-flash'].periods, undefined); // v1 表无时段
  const out = migratePriceTable(stored);
  assert.equal(out['deepseek-v4-flash'].periods.length, 3);
  assert.deepEqual([out['deepseek-v4-flash'].input, out['deepseek-v4-flash'].cacheRead, out['deepseek-v4-flash'].output], [3, 0.1, 9]);
  assert.equal(out['deepseek-v4-pro'].periods.length, 3);
  // 未变动的非 DeepSeek 行保持同价（迁移不引入数值变化）
  assert.deepEqual(out['kimi-k3'], { input: 20, cacheRead: 2, output: 100 });
});

test('migratePriceTable：用户改过的行原样保留（含显式停用峰谷的行）', () => {
  const custom = { input: 5, cacheRead: 1, output: 10 };
  const disabled = { input: 6, cacheRead: 0.2, output: 18, periods: [] };
  const out = migratePriceTable({
    'kimi-k3': custom,
    'deepseek-v4-flash': disabled,
    'my-own-model': { input: 1, cacheRead: 1, output: 1 },
  });
  assert.deepEqual(out['kimi-k3'], custom);
  assert.deepEqual(out['deepseek-v4-flash'], disabled); // 与 v1 内置不同价 → 视为已改
  assert.deepEqual(out['my-own-model'], { input: 1, cacheRead: 1, output: 1 }); // 自建模型保留
  assert.ok(!('deepseek-v4-pro' in out)); // 存量表里没有的行不擅自补写
});

test('migratePriceTable：存量表缺失的内置行不擅自补写（避免覆盖用户的空价意图）', () => {
  const out = migratePriceTable({ 'kimi-k3': { input: 20, cacheRead: 2, output: 100 } });
  assert.deepEqual(Object.keys(out), ['kimi-k3']);
  assert.equal(PRICE_TABLE_VERSION, 2);
});
