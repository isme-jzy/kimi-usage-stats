// 纯函数聚合模块：不碰 DOM / IndexedDB，浏览器与 Node 通用。

import { calcCost } from './pricing.js';

export function rangeBounds(key, now = Date.now()) {
  const d = new Date(now);
  const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const DAY = 86400000;
  switch (key) {
    case 'today': return { from: dayStart, to: null };
    case 'yesterday': return { from: dayStart - DAY, to: dayStart };
    case '7d': return { from: dayStart - 6 * DAY, to: null };
    default: return { from: 0, to: null };
  }
}

// 记录里的模型名 → 配置 key：精确匹配优先，其次 "配置key 以 /短名 结尾" 后缀匹配。
function resolveModelKey(model, knownKeys) {
  if (knownKeys.has(model)) return { key: model, configured: true };
  for (const k of knownKeys) {
    if (k.endsWith('/' + model)) return { key: k, configured: true };
  }
  return { key: model, configured: false };
}

function emptyRow(key, displayName, configured) {
  return {
    key, displayName, configured,
    inputOther: 0, inputCacheRead: 0, inputCacheCreation: 0, output: 0, total: 0,
    requests: 0, sumStreamMs: 0, cost: null,
    tokensPerSec: null, lastTokensPerSec: null, lastTime: 0,
  };
}

const inRange = (r, range) => r.time >= range.from && (range.to == null || r.time < range.to);

// priceOverrides 为可选价目表覆盖（缺省用内置默认价目表），用于支持用户自定义单价。
// 每行含 cost = 估算花费（元），未定价模型为 null。
export function aggregateByModel(records, configModels, range, priceOverrides = null) {
  const rows = new Map();
  const knownKeys = new Set(configModels.map((m) => m.key));
  for (const m of configModels) rows.set(m.key, emptyRow(m.key, m.displayName, true));
  for (const r of records) {
    if (!inRange(r, range)) continue;
    const { key, configured } = resolveModelKey(r.model, knownKeys);
    let row = rows.get(key);
    if (!row) { row = emptyRow(key, key, configured); rows.set(key, row); }
    row.inputOther += r.inputOther;
    row.inputCacheRead += r.inputCacheRead;
    row.inputCacheCreation += r.inputCacheCreation;
    row.output += r.output;
    row.requests += 1;
    row.sumStreamMs += r.streamDurationMs;
    if (r.time >= row.lastTime) {
      row.lastTime = r.time;
      row.lastTokensPerSec = r.streamDurationMs > 0 ? round1(r.output / (r.streamDurationMs / 1000)) : null;
    }
  }
  for (const row of rows.values()) {
    row.total = row.inputOther + row.inputCacheRead + row.inputCacheCreation + row.output;
    row.tokensPerSec = row.sumStreamMs > 0 ? round1(row.output / (row.sumStreamMs / 1000)) : null;
    // 命中率口径：缓存读 = 命中，普通输入 = 未命中；分母为 0（无输入）时为 null
    const cacheBase = row.inputCacheRead + row.inputOther;
    row.cacheHitRate = cacheBase > 0 ? row.inputCacheRead / cacheBase : null;
    // 估算花费：缓存写不单独计费，归入 input 口径。
    // 零用量行（requests===0，无任何记录）cost 置 null → 显示 —，避免误读成 ¥0.00。
    row.cost = row.requests === 0 ? null : calcCost(row.key, {
      input: row.inputOther + row.inputCacheCreation,
      cacheRead: row.inputCacheRead,
      output: row.output,
    }, priceOverrides);
  }
  return [...rows.values()].sort((a, b) => b.total - a.total);
}

// 汇总卡：对 aggregateByModel 的结果（通常已按时间段过滤）求总计
export function summarize(rows) {
  let total = 0, output = 0, requests = 0, sumStreamMs = 0, hit = 0, miss = 0, cost = 0;
  for (const r of rows) {
    total += r.total; output += r.output; requests += r.requests; sumStreamMs += r.sumStreamMs;
    hit += r.inputCacheRead; miss += r.inputOther;
    if (r.cost != null) cost += r.cost;
  }
  return {
    total, output, requests, cost,
    tokensPerSec: sumStreamMs > 0 ? round1(output / (sumStreamMs / 1000)) : null,
    cacheHitRate: hit + miss > 0 ? hit / (hit + miss) : null,
  };
}

// 短名：取 key 斜杠后一段（如 "deepseek/deepseek-v4-flash" → "deepseek-v4-flash"）。
function shortKey(m) {
  const s = String(m || '');
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
}

// 会话显示名回退：优先用 sessionMeta 提供的会话名，否则用 sessionId 短段（去掉 "session_" 前缀）。
function sessionDisplayName(sessionId, sessionNames, workspace, workspaceName) {
  const provided = sessionNames?.[workspace]?.[sessionId];
  if (provided) return provided;
  const short = String(sessionId || '').replace(/^session_/, '') || sessionId;
  return short === workspaceName ? short : short;
}

// 单条记录的估算花费（元）；未定价模型/null。口径与 aggregateByModel 一致（缓存写归入 input）。
function recordCost(key, r, priceOverrides) {
  return calcCost(key, {
    input: r.inputOther + r.inputCacheCreation,
    cacheRead: r.inputCacheRead,
    output: r.output,
  }, priceOverrides);
}

// 会话级聚合：按 workspace+sessionId 分组。
// 参数与既有聚合一致，另加 sessionMeta 提供环境映射与中断信息：
//   { workspaces: { wd_xxx: { name } },       // wd_xxx → 真实项目名（scanner 从 workspaces.json 读取）
//     sessionNames: { wd_xxx: { sessionId } }, // 可选：会话显示名
//     interruptedTurnIds: Set<turnId> }        // 可选：range 内被中断的 turnId，供该会话统计中断次数
// 输出按 totalToken 降序。
export function aggregateBySession(records, configModels, range, priceOverrides = null, sessionMeta = null) {
  const meta = sessionMeta || {};
  const workspaces = meta.workspaces || {};
  const sessionNames = meta.sessionNames || {};
  const interrupted = meta.interruptedTurnIds instanceof Set ? meta.interruptedTurnIds : new Set();
  const knownKeys = new Set(configModels.map((m) => m.key));
  const groups = new Map();

  for (const r of records) {
    if (!inRange(r, range)) continue;
    const gkey = (r.workspace || '') + '::' + (r.sessionId || '');
    let g = groups.get(gkey);
    if (!g) {
      g = {
        key: gkey,
        workspace: r.workspace || '',
        sessionId: r.sessionId || '',
        startTime: Infinity,
        endTime: -Infinity,
        models: new Set(),
        interruptedTurns: new Set(),
        totalToken: 0,
        cost: 0,
        requests: 0,
      };
      groups.set(gkey, g);
    }
    const { key } = resolveModelKey(r.model, knownKeys);
    g.models.add(shortKey(r.model));
    const total = r.inputOther + r.inputCacheRead + r.inputCacheCreation + r.output;
    g.totalToken += total;
    g.requests += 1;
    if (r.time < g.startTime) g.startTime = r.time;
    if (r.time > g.endTime) g.endTime = r.time;
    const c = recordCost(key, r, priceOverrides);
    if (c != null) g.cost += c;
    if (r.turnId && interrupted.has(r.turnId)) g.interruptedTurns.add(r.turnId);
  }

  const rows = [];
  for (const g of groups.values()) {
    const workspaceName = (workspaces[g.workspace] && (workspaces[g.workspace].name || workspaces[g.workspace].displayName)) || g.workspace;
    rows.push({
      key: g.key,
      workspace: g.workspace,
      workspaceName,
      sessionId: g.sessionId,
      displayName: sessionDisplayName(g.sessionId, sessionNames, g.workspace, workspaceName),
      startTime: g.startTime,
      endTime: g.endTime,
      models: [...g.models].sort(),
      totalToken: g.totalToken,
      cost: g.cost,
      requests: g.requests,
      interruptCount: g.interruptedTurns.size,
    });
  }
  return rows.sort((a, b) => b.totalToken - a.totalToken);
}

// 中断统计：把 range 内被中断的 turnId 与 records 按 turnId 匹配，累计这些 turn 的 step.end 用量。
// markers：parseWireText 返回的 interruptMarkers（含 turnId(字符串)/reason/time/kind）。
// 输出口径与 summarize 一致：未定价模型 cost=null，不计入总 cost。
export function interruptStats(records, markers, configModels, range, priceOverrides = null) {
  const knownKeys = new Set(configModels.map((m) => m.key));
  const interruptedTurns = new Set();
  for (const m of markers || []) {
    if (m && m.turnId && inRange({ time: m.time }, range)) interruptedTurns.add(m.turnId);
  }
  const rows = new Map();
  let total = 0, requests = 0;
  for (const r of records) {
    if (!inRange(r, range)) continue;
    if (!r.turnId || !interruptedTurns.has(r.turnId)) continue;
    const { key } = resolveModelKey(r.model, knownKeys);
    let row = rows.get(key);
    if (!row) {
      row = { model: shortKey(r.model), key, totalToken: 0, count: 0, _input: 0, _cacheRead: 0, _cacheCreation: 0, _output: 0 };
      rows.set(key, row);
    }
    row.totalToken += r.inputOther + r.inputCacheRead + r.inputCacheCreation + r.output;
    row.count += 1;
    row._input += r.inputOther;
    row._cacheRead += r.inputCacheRead;
    row._cacheCreation += r.inputCacheCreation;
    row._output += r.output;
    total += r.inputOther + r.inputCacheRead + r.inputCacheCreation + r.output;
    requests += 1;
  }
  const byModel = [...rows.values()].map((row) => {
    const cost = calcCost(row.key, {
      input: row._input + row._cacheCreation,
      cacheRead: row._cacheRead,
      output: row._output,
    }, priceOverrides);
    return { model: row.model, key: row.key, totalToken: row.totalToken, cost, count: row.count };
  }).sort((a, b) => b.totalToken - a.totalToken);
  let cost = 0;
  for (const b of byModel) if (b.cost != null) cost += b.cost;
  return { count: requests, turns: interruptedTurns.size, totalToken: total, cost, byModel };
}

const round1 = (n) => Math.round(n * 10) / 10;

export function fmtNum(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

export function fmtPct(v) {
  if (v == null) return '—';
  return (v * 100).toFixed(1).replace(/\.0$/, '') + '%';
}

// 金额格式化：元，保留两位小数；null（未定价/无数据）→ "—"
export function fmtCost(v) {
  if (v == null) return '—';
  return '¥' + v.toFixed(2);
}
