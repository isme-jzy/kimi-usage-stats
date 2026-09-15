import test from 'node:test';
import assert from 'node:assert/strict';
import { rangeBounds, aggregateByModel, aggregateBySession, interruptStats, summarize, fmtNum, fmtPct } from '../lib/aggregate.js';

// 固定 now = 2026-08-13 15:00:00 本地时间
const NOW = new Date(2026, 7, 13, 15, 0, 0).getTime();
const DAY = 86400000;
const dayStart = new Date(2026, 7, 13, 0, 0, 0).getTime();

const CONFIG = [
  { key: 'deepseek/deepseek-v4-flash', provider: 'deepseek', model: 'deepseek-v4-flash', displayName: 'DeepSeek V4 Flash' },
  { key: 'kimi-code/k3-256k', provider: 'managed:kimi-code', model: 'k3-256k', displayName: 'K3 256K' },
];

const rec = (time, model, output, streamDurationMs, extra = {}) => ({
  time, model, inputOther: 10, inputCacheRead: 20, inputCacheCreation: 5, output,
  streamDurationMs, workspace: 'wd_a', sessionId: 'session_x', agent: 'main', ...extra,
});

const RECORDS = [
  rec(dayStart + 1000, 'deepseek/deepseek-v4-flash', 100, 2000),       // 今天, 50 t/s
  rec(dayStart + 2000, 'deepseek-v4-flash', 50, 1000),                 // 今天, 短名 → 归一到配置 key
  rec(dayStart - 1000, 'kimi-code/k3-256k', 200, 8000),                // 昨天 23:59:59
  rec(dayStart - DAY, 'unknown-model', 10, 0),                         // 前天, 未配置模型, 时长 0
];

test('rangeBounds 四个档位（本地 0 点切日）', () => {
  assert.deepEqual(rangeBounds('today', NOW), { from: dayStart, to: null });
  assert.deepEqual(rangeBounds('yesterday', NOW), { from: dayStart - DAY, to: dayStart });
  assert.deepEqual(rangeBounds('7d', NOW), { from: dayStart - 6 * DAY, to: null });
  assert.deepEqual(rangeBounds('all', NOW), { from: 0, to: null });
});

test('aggregateByModel：求和、短名归一、加权 tokens/s、零用量配置模型也在', () => {
  const rows = aggregateByModel(RECORDS, CONFIG, rangeBounds('all', NOW));
  const ds = rows.find((r) => r.key === 'deepseek/deepseek-v4-flash');
  assert.equal(ds.displayName, 'DeepSeek V4 Flash');
  assert.equal(ds.requests, 2);
  assert.equal(ds.output, 150);
  assert.equal(ds.inputOther, 20);
  assert.equal(ds.total, 20 + 40 + 10 + 150); // input*2 + cacheRead*2 + cacheCreation*2 + output
  // 加权: 150 / ((2000+1000)/1000) = 50
  assert.equal(ds.tokensPerSec, 50);
  // 最近一条是短名那条: 50/1s = 50
  assert.equal(ds.lastTokensPerSec, 50);
  const k3 = rows.find((r) => r.key === 'kimi-code/k3-256k');
  assert.equal(k3.requests, 1);
  const unknown = rows.find((r) => r.key === 'unknown-model');
  assert.equal(unknown.configured, false);
  assert.equal(unknown.tokensPerSec, null); // 时长 0 → null
  // 按 total 降序
  assert.ok(rows[0].total >= rows[1].total);
});

test('aggregateByModel：缓存命中率 = 缓存读 ÷（缓存读 + 普通输入）', () => {
  const rows = aggregateByModel(RECORDS, CONFIG, rangeBounds('all', NOW));
  const ds = rows.find((r) => r.key === 'deepseek/deepseek-v4-flash');
  // 2 条记录：cacheRead 20*2=40，inputOther 10*2=20 → 40/60
  assert.ok(Math.abs(ds.cacheHitRate - 2 / 3) < 1e-9);
  const unknown = rows.find((r) => r.key === 'unknown-model');
  assert.ok(Math.abs(unknown.cacheHitRate - 20 / 30) < 1e-9);
});

test('aggregateByModel：无输入时命中率为 null（今日筛选下 k3 零用量）', () => {
  const rows = aggregateByModel(RECORDS, CONFIG, rangeBounds('today', NOW));
  const k3 = rows.find((r) => r.key === 'kimi-code/k3-256k');
  assert.equal(k3.cacheHitRate, null);
});

test('summarize：汇总卡口径', () => {
  const rows = aggregateByModel(RECORDS, CONFIG, rangeBounds('all', NOW)).filter((r) => r.requests > 0);
  const s = summarize(rows);
  assert.equal(s.requests, 4);
  assert.equal(s.output, 100 + 50 + 200 + 10);
  // input 合计: (10+20+5)*4 = 140, total = 140 + 360 = 500
  assert.equal(s.total, 500);
  // 加权 tps: 360 / ((2000+1000+8000+0)/1000) = 32.7
  assert.equal(s.tokensPerSec, 32.7);
  // 命中: (20*4)/(20*4 + 10*4) = 2/3
  assert.ok(Math.abs(s.cacheHitRate - 2 / 3) < 1e-9);
});

test('summarize：空数组', () => {
  const s = summarize([]);
  assert.equal(s.tokensPerSec, null);
  assert.equal(s.cacheHitRate, null);
  assert.equal(s.total, 0);
});

test('fmtPct', () => {
  assert.equal(fmtPct(null), '—');
  assert.equal(fmtPct(0.8), '80%');
  assert.equal(fmtPct(2 / 3), '66.7%');
  assert.equal(fmtPct(1), '100%');
});

test('aggregateByModel：今日筛选排除昨天', () => {
  const rows = aggregateByModel(RECORDS, CONFIG, rangeBounds('today', NOW));
  const k3 = rows.find((r) => r.key === 'kimi-code/k3-256k');
  assert.equal(k3.requests, 0);
  assert.equal(k3.tokensPerSec, null);
});

test('aggregateByModel：零用量已配置模型 cost=null（不显示 ¥0.00）', () => {
  // k3 在今日零用量、但已配置且价目表有价 —— 仍应为 null
  const rows = aggregateByModel(RECORDS, CONFIG, rangeBounds('today', NOW));
  const k3 = rows.find((r) => r.key === 'kimi-code/k3-256k');
  assert.equal(k3.requests, 0);
  assert.equal(k3.configured, true);
  assert.equal(k3.cost, null);
  assert.equal(k3.total, 0);
});

test('aggregateByModel：有用量已定价模型 cost 正常计算（口径）', () => {
  const rows = aggregateByModel(RECORDS, CONFIG, rangeBounds('all', NOW));
  const ds = rows.find((r) => r.key === 'deepseek/deepseek-v4-flash');
  assert.ok(ds.requests > 0);
  assert.equal(typeof ds.cost, 'number');
  assert.ok(ds.cost > 0);
  const unknown = rows.find((r) => r.key === 'unknown-model'); // 有用量但未定价
  assert.equal(unknown.cost, null);
});

test('fmtNum', () => {
  assert.equal(fmtNum(999), '999');
  assert.equal(fmtNum(12345), '12.3k');
  assert.equal(fmtNum(1234567), '1.23M');
});

// —— 会话聚合 aggregateBySession ——
const S1 = 'session_aaa111';
const S2 = 'session_bbb222';
const SessionRecords = [
  rec(dayStart + 1000, 'deepseek/deepseek-v4-flash', 100, 2000, { workspace: 'wd_projA', sessionId: S1, turnId: '1' }),
  rec(dayStart + 2000, 'deepseek-v4-flash', 50, 1000, { workspace: 'wd_projA', sessionId: S1, turnId: '2' }),
  rec(dayStart + 3000, 'kimi-code/k3-256k', 200, 8000, { workspace: 'wd_projB', sessionId: S2, turnId: '3' }),
];
const SessionMeta = {
  workspaces: { wd_projA: { root: 'C:/a', name: '项目A' }, wd_projB: { root: 'C:/b', name: '项目B' } },
  sessionNames: { wd_projA: { [S1]: '会话 Alpha' } },
  interruptedTurnIds: new Set(['2']),
};

test('aggregateBySession：分组、映射项目名、会话名、排序、中断计数', () => {
  const rows = aggregateBySession(SessionRecords, CONFIG, rangeBounds('all', NOW), null, SessionMeta);
  // 排序：wd_projB 总量 235(10+20+5+200) > wd_projA 220(135+85)，降序在前
  assert.equal(rows.length, 2);
  assert.equal(rows[0].workspace, 'wd_projB');
  assert.equal(rows[0].workspaceName, '项目B');
  assert.equal(rows[0].totalToken, 235);
  assert.equal(rows[0].requests, 1);
  assert.deepEqual(rows[0].models, ['k3-256k']);
  assert.equal(rows[0].interruptCount, 0);
  assert.equal(rows[1].workspaceName, '项目A');
  assert.equal(rows[1].totalToken, 220);
  assert.equal(rows[1].requests, 2);
  assert.equal(rows[1].startTime, dayStart + 1000);
  assert.equal(rows[1].endTime, dayStart + 2000);
  assert.deepEqual(rows[1].models, ['deepseek-v4-flash']);
  assert.equal(rows[1].interruptCount, 1); // turn '2' ∈ interruptedTurnIds
  assert.equal(rows[1].displayName, '会话 Alpha'); // sessionMeta 提供
});

test('aggregateBySession：workspace 无映射回退 wd 原样，会话名回退短 id', () => {
  const rows = aggregateBySession(SessionRecords, CONFIG, rangeBounds('all', NOW), null, {
    workspaces: { wd_projA: { name: '项目A' } }, // wd_projB 无映射
  });
  const b = rows.find((r) => r.workspace === 'wd_projB');
  assert.equal(b.workspaceName, 'wd_projB'); // 无映射 → 原样
  assert.equal(b.displayName, 'bbb222'); // 无会话名 → 去 session_ 前缀
  assert.equal(b.interruptCount, 0); // 无 interruptedTurnIds 参数 → 全 0
});

test('aggregateBySession：按 totalToken 降序、空态', () => {
  assert.deepEqual(aggregateBySession([], CONFIG, rangeBounds('all', NOW)), []);
  const rows = aggregateBySession(SessionRecords, CONFIG, rangeBounds('yesterday', NOW)); // 全部不在 range
  assert.deepEqual(rows, []);
});

test('aggregateBySession：cost 只累加已定价模型（未定价 cost 不计入）', () => {
  const recs = [
    rec(dayStart + 100, 'deepseek/deepseek-v4-flash', 100, 0, { workspace: 'wd_x', sessionId: 's1', turnId: '1' }),
    rec(dayStart + 200, 'unknown-model', 50, 0, { workspace: 'wd_x', sessionId: 's1', turnId: '2' }),
  ];
  const rows = aggregateBySession(recs, CONFIG, rangeBounds('all', NOW));
  assert.equal(rows.length, 1);
  // 记录时间 00:00:00.1 落在 DeepSeek 闲时窗口（00:00-09:00）→ 按闲时价 1.5/0.05/4.5 计
  const dsCost = 15 / 1e6 * 1.5 + 20 / 1e6 * 0.05 + 100 / 1e6 * 4.5;
  assert.ok(Math.abs(rows[0].cost - dsCost) < 1e-9);
  assert.equal(rows[0].totalToken, 220); // ds(135) + unknown(85)，未定价也计入 token
});

// —— 中断统计 interruptStats ——
const IntRecords = [
  rec(dayStart + 1000, 'deepseek/deepseek-v4-flash', 100, 0, { turnId: '1' }),
  rec(dayStart + 2000, 'deepseek-v4-flash', 50, 0, { turnId: '1' }),
  rec(dayStart + 3000, 'kimi-code/k3-256k', 200, 0, { turnId: '2' }), // 未中断
  rec(dayStart + 4000, 'unknown-model', 10, 0, { turnId: '1' }),       // 中断但未定价
];
const IntMarkers = [
  { turnId: '1', reason: 'cancelled', time: dayStart + 1000, kind: 'ended' },
];

test('interruptStats：累计被中断 turn 的用量（含未定价模型 cost=null）', () => {
  const s = interruptStats(IntRecords, IntMarkers, CONFIG, rangeBounds('all', NOW));
  assert.equal(s.turns, 1); // 只有 turn '1' 在 range 内被中断
  assert.equal(s.count, 3); // turn1 的 3 条记录（r1,r2,r4）
  assert.equal(s.totalToken, 135 + 85 + 45); // ds两条 + unknown
  // byModel 排序按 totalToken 降序
  assert.equal(s.byModel.length, 2);
  const ds = s.byModel[0];
  assert.equal(ds.model, 'deepseek-v4-flash');
  assert.equal(ds.key, 'deepseek/deepseek-v4-flash');
  assert.equal(ds.totalToken, 220);
  assert.equal(ds.count, 2);
  assert.ok(ds.cost > 0);
  const unknown = s.byModel[1];
  assert.equal(unknown.model, 'unknown-model');
  assert.equal(unknown.totalToken, 45);
  assert.equal(unknown.count, 1);
  assert.equal(unknown.cost, null); // 未定价
  // 总 cost 不含未定价模型；记录时间 00:00:0x 落在 DeepSeek 闲时窗口 → 按闲时价 1.5/0.05/4.5 计
  const dsCost = (15 + 15) / 1e6 * 1.5 + (20 + 20) / 1e6 * 0.05 + (100 + 50) / 1e6 * 4.5;
  assert.ok(Math.abs(s.cost - dsCost) < 1e-9);
});

test('interruptStats：range 过滤只统计 range 内被中断的 turn', () => {
  const yestRec = rec(dayStart - DAY, 'deepseek/deepseek-v4-flash', 500, 0, { turnId: '7' });
  const recs = [rec(dayStart + 100, 'deepseek/deepseek-v4-flash', 100, 0, { turnId: '5' }), yestRec];
  const markers = [
    { turnId: '5', reason: 'cancelled', time: dayStart + 100, kind: 'ended' },
    { turnId: '7', reason: 'cancelled', time: dayStart - DAY, kind: 'ended' }, // 昨天 → today 排除
  ];
  const s = interruptStats(recs, markers, CONFIG, rangeBounds('today', NOW));
  assert.equal(s.turns, 1); // 仅 turn '5'
  assert.equal(s.count, 1);
  assert.equal(s.totalToken, 135); // ds: 10+20+5+100
  assert.equal(s.byModel.length, 1);
});

test('interruptStats：无中断/空数据 → 空输出', () => {
  assert.deepEqual(interruptStats([], [], CONFIG, rangeBounds('all', NOW)), {
    count: 0, turns: 0, totalToken: 0, cost: 0, byModel: [],
  });
  const s = interruptStats(IntRecords, [], CONFIG, rangeBounds('all', NOW)); // 无 markers
  assert.equal(s.turns, 0);
  assert.equal(s.count, 0);
  assert.deepEqual(s.byModel, []);
});
