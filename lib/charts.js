// 霓虹 HUD 图形生成的纯函数：圆环 dash、迷你柱状图高度、每日聚合、面积图路径。
// 全部为无副作用纯函数，供 dashboard/panel 渲染层调用，可在 node 下直接单测。

// 命中率圆环：返回周长 c 与 dashoffset（保留 2 位小数）；rate=null → 空态（off=c）
export function ringDash(rate, r = 7.5) {
  const c = +(2 * Math.PI * r).toFixed(2);
  if (rate == null) return { c, off: c };
  const clamped = Math.min(1, Math.max(0, rate));
  return { c, off: +(c * (1 - clamped)).toFixed(2) };
}

// 迷你柱状图高度：按 max 归一化到 [0, maxH]；v>0 最小 2px；可传外部 max（跨行共享口径）
export function sparkHeights(values, maxH = 14, max = null) {
  if (!values.length) return [];
  const m = max != null ? max : Math.max(...values);
  if (!(m > 0)) return values.map(() => 0);
  return values.map((v) => {
    if (!(v > 0)) return 0;
    return Math.max(2, +((v / m) * maxH).toFixed(1));
  });
}

// 每日聚合：range 内按本地日连续 bucket（空天补 0），含 total/output/streamMs。
// range.from === 0（all）时从最早记录日起；窗口最多 maxDays 天（取最近一段）。
export function dailyBuckets(records, range, now = Date.now(), maxDays = 90) {
  const DAY = 86400000;
  const dayStart = (ts) => { const d = new Date(ts); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
  const todayStart = dayStart(now);
  let earliest = null;
  for (const r of records) {
    if (typeof r.time !== 'number') continue;
    const ds = dayStart(r.time);
    if (earliest == null || ds < earliest) earliest = ds;
  }
  let from = range.from === 0 ? earliest : dayStart(range.from);
  if (from == null) return [];
  // cap：窗口最多 maxDays 天，取最近
  const capFrom = todayStart - (maxDays - 1) * DAY;
  if (from < capFrom) from = capFrom;
  // 最后一天：range.to 为排除端；无 to 或 to 在未来 → 今天
  const lastDay = dayStart(range.to == null ? now : Math.min(range.to - 1, now));
  if (lastDay < from) return [];
  const days = Math.round((lastDay - from) / DAY) + 1;
  const buckets = new Map(); // ds → { total, output, streamMs }
  for (const r of records) {
    if (typeof r.time !== 'number') continue;
    const ds = dayStart(r.time);
    if (ds < from || ds > lastDay) continue;
    let b = buckets.get(ds);
    if (!b) { b = { total: 0, output: 0, streamMs: 0 }; buckets.set(ds, b); }
    b.total += (r.inputOther || 0) + (r.inputCacheRead || 0) + (r.inputCacheCreation || 0) + (r.output || 0);
    b.output += r.output || 0;
    b.streamMs += r.streamDurationMs || 0;
  }
  const out = [];
  for (let i = 0; i < days; i++) {
    const ts = from + i * DAY;
    const b = buckets.get(ts) || { total: 0, output: 0, streamMs: 0 };
    out.push({ ts, total: b.total, output: b.output, streamMs: b.streamMs });
  }
  return out;
}