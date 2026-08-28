import test from 'node:test';
import assert from 'node:assert/strict';
import { ringDash, sparkHeights, dailyBuckets } from '../lib/charts.js';

const DAY = 86400000;
// 固定 now = 2026-08-13 15:00:00 本地时间
const NOW = new Date(2026, 7, 13, 15, 0, 0).getTime();
const dayStart = new Date(2026, 7, 13, 0, 0, 0).getTime();
const rec = (time, output, streamDurationMs, extra = {}) => ({
  time, model: 'm/a', inputOther: 10, inputCacheRead: 20, inputCacheCreation: 5, output, streamDurationMs, ...extra,
});

test('ringDash：null 为空态，0.5 为半程，超界 clamp', () => {
  const c = 2 * Math.PI * 7.5;
  assert.deepEqual(ringDash(null), { c: 47.12, off: 47.12 });
  assert.deepEqual(ringDash(0.5), { c: 47.12, off: +(c * 0.5).toFixed(2) });
  assert.deepEqual(ringDash(1), { c: 47.12, off: 0 });
  assert.deepEqual(ringDash(1.5), { c: 47.12, off: 0 });
  assert.deepEqual(ringDash(-0.2), { c: 47.12, off: 47.12 });
  const r10 = ringDash(0.25, 10);
  assert.equal(r10.c, 62.83);
  assert.equal(r10.off, +(2 * Math.PI * 10 * 0.75).toFixed(2));
});

test('sparkHeights：归一化、全 0、空数组、外部 max、最小 2px', () => {
  assert.deepEqual(sparkHeights([]), []);
  assert.deepEqual(sparkHeights([0, 0]), [0, 0]);
  assert.deepEqual(sparkHeights([5, 10], 20), [10, 20]);
  assert.deepEqual(sparkHeights([1, 100], 14), [2, 14]); // v>0 最小 2px
  assert.deepEqual(sparkHeights([50], 12, 100), [6]);     // 外部 max
  assert.deepEqual(sparkHeights([0], 12, 100), [0]);
});

test('dailyBuckets：连续天补 0、聚合 total/output/streamMs', () => {
  const records = [
    rec(dayStart + 1000, 100, 2000),      // 今天
    rec(dayStart - DAY, 200, 4000),       // 昨天
  ];
  const range = { from: dayStart - 2 * DAY, to: null }; // 前天起
  const b = dailyBuckets(records, range, NOW);
  assert.equal(b.length, 3);
  assert.equal(b[0].ts, dayStart - 2 * DAY);
  assert.deepEqual([b[0].total, b[0].output, b[0].streamMs], [0, 0, 0]); // 前天补 0
  assert.equal(b[1].total, 235); // 10+20+5+200
  assert.equal(b[1].streamMs, 4000);
  assert.equal(b[2].total, 135);
});

test('dailyBuckets：all 范围从最早记录起、窗口 cap、空记录', () => {
  assert.deepEqual(dailyBuckets([], { from: 0, to: null }, NOW), []);
  const old = rec(dayStart - 200 * DAY, 10, 1000);
  const b = dailyBuckets([old, rec(dayStart, 5, 500)], { from: 0, to: null }, NOW, 90);
  assert.equal(b.length, 90); // cap 到最近 90 天
  assert.equal(b[b.length - 1].ts, dayStart);
  assert.equal(b[b.length - 1].output, 5);
  // 指定 from 在 cap 之前同样被截断
  const b2 = dailyBuckets([old], { from: dayStart - 200 * DAY, to: null }, NOW, 90);
  assert.equal(b2.length, 90);
  // 范围内无记录但范围有效 → 连续空天
  const b3 = dailyBuckets([old], { from: dayStart - DAY, to: null }, NOW, 90);
  assert.equal(b3.length, 2);
  assert.equal(b3[1].total, 0);
});