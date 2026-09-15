// 开发辅助工具：用真实 ~/.kimi-code 数据预览「价目表 + 峰谷」的计算结果。
// 用途：改完价目表或时段后，不开浏览器也能确认各模型的估算花费与峰/谷拆分是否符合预期。
// 用法：node tools/pricing-preview.mjs [--home <kimi-code 目录>]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseWireText, parseConfigModels } from '../lib/parser.js';
import { aggregateByModel, summarize, fmtCost, fmtNum } from '../lib/aggregate.js';
import { getPriceEntry, describePeriod, resolvePrice } from '../lib/pricing.js';

const argv = process.argv.slice(2);
const homeIdx = argv.indexOf('--home');
const HOME = homeIdx >= 0 ? argv[homeIdx + 1] : path.join(os.homedir(), '.kimi-code');

if (!fs.existsSync(HOME)) {
  console.error(`目录不存在：${HOME}（可用 --home 指定）`);
  process.exit(1);
}

const cfgPath = path.join(HOME, 'config.toml');
const models = fs.existsSync(cfgPath) ? parseConfigModels(fs.readFileSync(cfgPath, 'utf8')) : [];

// 收集 sessions/**/agents/<agent>/wire.jsonl 记录（口径与 scanner 一致的最小实现）
const records = [];
let files = 0;
(function walk(dir) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (e.name !== 'wire.jsonl') continue;
    files++;
    const agentDir = path.dirname(p);
    const sessionDir = path.dirname(agentDir);
    const ctx = {
      workspace: path.basename(path.dirname(sessionDir)),
      sessionId: path.basename(sessionDir),
      agent: path.basename(agentDir),
    };
    records.push(...parseWireText(fs.readFileSync(p, 'utf8'), ctx).records);
  }
})(path.join(HOME, 'sessions'));

console.log(`数据源：${HOME}`);
console.log(`wire.jsonl ${files} 个文件 · ${records.length} 条记录 · config 模型 ${models.length} 个`);

// 生效时段（只看内置默认；用户在价目表里的覆盖请以 dashboard 为准）
const windows = new Map();
for (const r of records) {
  const short = String(r.model || '').split('/').pop();
  if (!short || windows.has(short)) continue;
  const entry = getPriceEntry(r.model, null);
  if (entry && entry.periods && entry.periods.length) {
    windows.set(short, entry.periods.map(describePeriod).join(' | '));
  }
}
console.log('\n== 内置默认峰谷时段 ==');
if (!windows.size) console.log('（无：当前内置价目表没有启用峰谷的模型）');
for (const [model, text] of windows) console.log(`- ${model}: ${text}`);

const rows = aggregateByModel(records, models, { from: 0, to: null }, null).filter((r) => r.requests > 0);
const s = summarize(rows);
console.log('\n== 各模型估算花费（全部时间范围）==');
for (const r of rows) {
  const split = r.tou ? `[峰谷] 峰 ${fmtCost(r.tiers.peak.cost)} / 谷 ${fmtCost(r.tiers.offpeak.cost)}` : '[单一价]';
  console.log(`- ${String(r.displayName).padEnd(34)} 总 ${fmtNum(r.total).padStart(10)}  花费 ${fmtCost(r.cost).padStart(10)}  ${split}`);
}
console.log('\n== 汇总 ==');
console.log(`总花费 ${fmtCost(s.cost)} · 高峰 ${fmtCost(s.tier.peak.cost)}（${fmtNum(s.tier.peak.token)} tok）` +
  ` · 低谷 ${fmtCost(s.tier.offpeak.cost)}（${fmtNum(s.tier.offpeak.token)} tok） · 单一计价 ${fmtCost(s.tier.flat.cost)}`);

// 抽样一条峰谷记录，便于直观核对「同一模型不同时刻单价不同」
const sample = records.find((r) => resolvePrice(r.model, null, r.time));
if (sample) {
  const p = resolvePrice(sample.model, null, sample.time);
  console.log(`\n抽样：${sample.model} @ ${new Date(sample.time).toLocaleString('zh-CN', { hour12: false })}` +
    ` → ${p.label}（kind=${p.kind}）单价 输入 ${p.input} / 缓存 ${p.cacheRead} / 输出 ${p.output}（元每百万 tokens）`);
}
