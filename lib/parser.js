// 纯函数解析模块：不碰 DOM / 文件系统 / IndexedDB，浏览器与 Node 通用。

// 解析 wire.jsonl 的一段完整文本（调用方保证以换行符截齐）。
// 用量与时长取自 step.end；模型归因于本文件内最近一条 usage.record。
// 别名解析：usage.record 的 model 可能是 __secondary__ 这类占位符（子代理副模型槽位），
// 此时改用最近一条 llm.request(kind=loop) 里的真实 model——它按请求记录实际解析结果，
// 因此事后修改 config.toml 的 [secondary_model] 不影响历史记录的归因。
// initialModel / initialRequestModel：增量扫描时上一 chunk 末尾的状态（scanner 传入），缺省 null 保持向后兼容。
// 返回 lastModel / lastRequestModel = 本 chunk 末尾状态，供下一 chunk 续接。
// 返回结构向后兼容：在原有 {records, skippedLines, lastModel, lastRequestModel} 之上新增 interruptMarkers
// （中断标记列表），不破坏既有字段。中断标记是独立事件，无需像模型归因那样跨 chunk 续接状态。
const ALIAS_RE = /^__.*__$/;

// turn.ended 的中断类 reason（实测含 "cancelled"；interrupted/user_stop 等为通用值兜底）。reason 为空不算中断。
const INTERRUPT_REASONS = new Set(['cancelled', 'cancel', 'interrupted', 'user_stop', 'user_cancelled', 'stopped', 'aborted']);

// 中断标记：记录一条「被打断」证据。turnId 统一归一化为字符串（实测 step.end 的 turnId 为字符串，
// 而 turn.cancel/turn.ended/interruptionReminder.recorded 的 turnId 为数字），保证与记录匹配。
function interruptMarker(kind, obj) {
  if (obj.turnId == null) return null; // 无 turnId 无法归因，丢弃（早期 turn.cancel 有这种缺字段情况）
  return {
    kind,
    turnId: String(obj.turnId),
    reason: obj.reason || '',
    time: typeof obj.time === 'number' ? obj.time : 0,
  };
}

export function parseWireText(text, ctx, initialModel = null, initialRequestModel = null) {
  const records = [];
  const interruptMarkers = [];
  let skippedLines = 0;
  let currentModel = initialModel;
  let lastRequestModel = initialRequestModel;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let obj;
    try {
      obj = JSON.parse(t);
    } catch {
      skippedLines++;
      continue;
    }
    if (obj.type === 'llm.request' && obj.kind === 'loop' && obj.model) {
      lastRequestModel = obj.model;
      continue;
    }
    if (obj.type === 'usage.record' && obj.model) {
      // 占位符别名 → 用最近 loop 请求的真实模型；还没有过请求则保留别名原样展示
      currentModel = ALIAS_RE.test(obj.model) && lastRequestModel ? lastRequestModel : obj.model;
      continue;
    }
    // 中断信号：turn.ended 需 reason 属中断类；turn.cancel / interruptionReminder.recorded 出现即视为打断。
    if (obj.type === 'turn.cancel') {
      const m = interruptMarker('cancel', obj);
      if (m) interruptMarkers.push(m);
      continue;
    }
    if (obj.type === 'interruptionReminder.recorded') {
      const m = interruptMarker('reminder', obj);
      if (m) interruptMarkers.push(m);
      continue;
    }
    if (obj.type === 'turn.ended') {
      if (obj.reason && INTERRUPT_REASONS.has(obj.reason)) {
        const m = interruptMarker('ended', obj);
        if (m) interruptMarkers.push(m);
      }
      continue;
    }
    if (obj.type === 'context.append_loop_event' && obj.event?.type === 'step.end' && obj.event.usage) {
      const u = obj.event.usage;
      records.push({
        time: typeof obj.time === 'number' ? obj.time : 0,
        turnId: obj.event.turnId ? String(obj.event.turnId) : '', // 缺失则空串，保持既有字段不变
        model: currentModel || 'unknown',
        inputOther: u.inputOther || 0,
        inputCacheRead: u.inputCacheRead || 0,
        inputCacheCreation: u.inputCacheCreation || 0,
        output: u.output || 0,
        streamDurationMs: obj.event.llmStreamDurationMs || 0,
        workspace: ctx.workspace,
        sessionId: ctx.sessionId,
        agent: ctx.agent,
      });
    }
  }
  return { records, interruptMarkers, skippedLines, lastModel: currentModel, lastRequestModel };
}

// 提取 config.toml 的 [models."<key>"] 段；对 TOML 全量语法不做支持，只认本项目的扁平 key = "value" 行。
export function parseConfigModels(tomlText) {
  const models = [];
  let current = null;
  const flush = () => { if (current) models.push(current); current = null; };
  for (const rawLine of tomlText.split('\n')) {
    const line = rawLine.trim();
    const header = /^\[models\."([^"]+)"\]$/.exec(line);
    if (header) {
      flush();
      current = { key: header[1], provider: '', model: '', displayName: header[1] };
      continue;
    }
    if (line.startsWith('[')) { flush(); continue; }
    if (!current) continue;
    const num = /^max_context_size\s*=\s*(\d+)\s*$/.exec(line);
    if (num) { current.maxContextSize = parseInt(num[1], 10); continue; }
    const kv = /^(provider|model|display_name)\s*=\s*"([^"]*)"\s*$/.exec(line);
    if (!kv) continue;
    if (kv[1] === 'provider') current.provider = kv[2];
    else if (kv[1] === 'model') current.model = kv[2];
    else if (kv[2]) current.displayName = kv[2];
  }
  flush();
  return models;
}
