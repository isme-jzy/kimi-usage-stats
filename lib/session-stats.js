// 纯函数解析模块：wire.jsonl 文本 → 上下文用量 + 会话统计，background 与 Node 通用。
// 上下文总量取最近一条 step.end 的输入合计（即最近一次 LLM 调用实际消耗的上下文）；
// 拆分按字符估算系统提示词与工具定义，余量归对话消息（与 DSH 一致以 ~ 近似展示）。

const CJK_RE = /[㐀-䶿一-鿿豈-﫿　-〿＀-￯가-힯]/g;

// 粗估 token 数：CJK 字符 1:1，其余 4 字符 1 token。
export function estTokens(text) {
  if (!text) return 0;
  const cjk = (text.match(CJK_RE) || []).length;
  return cjk + Math.ceil((text.length - cjk) / 4);
}

export function parseSessionStats(text) {
  let turns = 0, steps = 0, llmMs = 0, toolMs = 0;
  let inTotal = 0, outTotal = 0, cacheRead = 0, inputOther = 0;
  let ttftSum = 0, ttftN = 0;
  let contextTotal = 0;
  let sysText = null, toolsText = null, modelAlias = null;
  const toolStart = new Map();

  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let o;
    try { o = JSON.parse(t); } catch { continue; }
    if (o.type === 'turn.prompt') { turns++; continue; }
    if (o.type === 'profile.bind') { if (typeof o.systemPrompt === 'string') sysText = o.systemPrompt; continue; }
    if (o.type === 'llm.tools_snapshot') { if (Array.isArray(o.tools)) toolsText = JSON.stringify(o.tools); continue; }
    if (o.type === 'llm.request' && o.kind === 'loop') { modelAlias = o.modelAlias || o.model || modelAlias; continue; }
    if (o.type !== 'context.append_loop_event') continue;
    const ev = o.event || {};
    const time = typeof o.time === 'number' ? o.time : 0;
    if (ev.type === 'step.end') {
      steps++;
      const u = ev.usage || {};
      const inp = (u.inputOther || 0) + (u.inputCacheRead || 0) + (u.inputCacheCreation || 0);
      inTotal += inp; outTotal += u.output || 0;
      cacheRead += u.inputCacheRead || 0; inputOther += u.inputOther || 0;
      llmMs += ev.llmStreamDurationMs || 0;
      if (typeof ev.llmFirstTokenLatencyMs === 'number') { ttftSum += ev.llmFirstTokenLatencyMs; ttftN++; }
      contextTotal = inp;
    } else if (ev.type === 'tool.call' && ev.toolCallId) {
      toolStart.set(ev.toolCallId, time);
    } else if (ev.type === 'tool.result' && ev.toolCallId && toolStart.has(ev.toolCallId)) {
      toolMs += Math.max(0, time - toolStart.get(ev.toolCallId));
      toolStart.delete(ev.toolCallId);
    }
  }

  const sysEst = estTokens(sysText);
  const toolsEst = estTokens(toolsText);
  return {
    modelAlias,
    contextTotal,
    breakdown: { system: sysEst, tools: toolsEst, messages: Math.max(0, contextTotal - sysEst - toolsEst) },
    stats: {
      turns, steps, llmMs, toolMs,
      ttftAvg: ttftN ? ttftSum / ttftN : null,
      tokps: llmMs > 0 ? outTotal / (llmMs / 1000) : null,
      cacheHit: inTotal > 0 ? cacheRead / inTotal : null,
      inTotal, outTotal,
    },
  };
}

export function fmtDur(ms) {
  if (ms == null) return '—';
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${Math.round(s % 60)}s`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

export function fmtTok(n) {
  if (n == null) return '—';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}
