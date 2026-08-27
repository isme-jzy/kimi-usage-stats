import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWireText, parseConfigModels } from '../lib/parser.js';

const CTX = { workspace: 'wd_demo_abc', sessionId: 'session_1', agent: 'main' };

const WIRE = [
  '{"type":"metadata","protocol_version":"1.5","created_at":1786600146225}',
  '{"type":"usage.record","model":"deepseek/deepseek-v4-flash","usage":{"inputOther":100,"output":10,"inputCacheRead":0,"inputCacheCreation":0},"usageScope":"turn","time":1786600147000}',
  '{"type":"context.append_loop_event","event":{"type":"step.end","turnId":"0","step":1,"finishReason":"tool_use","usage":{"inputOther":100,"output":10,"inputCacheRead":0,"inputCacheCreation":0},"llmStreamDurationMs":2000},"time":1786600148000}',
  '这不是 JSON',
  '{"type":"usage.record","model":"kimi-code/k3-256k","usage":{"inputOther":200,"output":20,"inputCacheRead":50,"inputCacheCreation":5},"usageScope":"turn","time":1786600150000}',
  '{"type":"context.append_loop_event","event":{"type":"step.end","turnId":"1","step":1,"finishReason":"stop","usage":{"inputOther":200,"output":20,"inputCacheRead":50,"inputCacheCreation":5},"llmStreamDurationMs":4000},"time":1786600151000}',
  '{"type":"context.append_loop_event","event":{"type":"step.end","turnId":"1","step":2,"finishReason":"stop","usage":{"inputOther":1,"output":2,"inputCacheRead":3,"inputCacheCreation":4}},"time":1786600152000}',
].join('\n') + '\n';

test('step.end 生成记录，模型归因于最近的 usage.record', () => {
  const { records, skippedLines } = parseWireText(WIRE, CTX);
  assert.equal(records.length, 3);
  assert.equal(skippedLines, 1);
  assert.equal(records[0].model, 'deepseek/deepseek-v4-flash');
  assert.deepEqual(
    [records[0].inputOther, records[0].output, records[0].streamDurationMs, records[0].time],
    [100, 10, 2000, 1786600148000],
  );
  assert.equal(records[1].model, 'kimi-code/k3-256k');
  assert.equal(records[1].inputCacheRead, 50);
  assert.equal(records[1].inputCacheCreation, 5);
  // 第三条 step.end 前没有新的 usage.record → 沿用当前模型；缺 llmStreamDurationMs → 0
  assert.equal(records[2].model, 'kimi-code/k3-256k');
  assert.equal(records[2].streamDurationMs, 0);
});

test('文件开头无 usage.record 时模型为 unknown', () => {
  const text = '{"type":"context.append_loop_event","event":{"type":"step.end","usage":{"inputOther":1,"output":2,"inputCacheRead":0,"inputCacheCreation":0},"llmStreamDurationMs":100},"time":1786600148000}\n';
  const { records } = parseWireText(text, CTX);
  assert.equal(records[0].model, 'unknown');
});

test('ctx 字段透传到每条记录', () => {
  const { records } = parseWireText(WIRE, CTX);
  assert.equal(records[0].workspace, 'wd_demo_abc');
  assert.equal(records[0].sessionId, 'session_1');
  assert.equal(records[0].agent, 'main');
});

test('initialModel：chunk 内无 usage.record 时 step.end 归因到 initialModel', () => {
  const text = '{"type":"context.append_loop_event","event":{"type":"step.end","usage":{"inputOther":1,"output":2,"inputCacheRead":0,"inputCacheCreation":0}},"time":1786600148000}\n';
  const { records, lastModel } = parseWireText(text, CTX, 'kimi-code/k3-256k');
  assert.equal(records[0].model, 'kimi-code/k3-256k');
  // chunk 内无新 usage.record → lastModel 回退为 initialModel
  assert.equal(lastModel, 'kimi-code/k3-256k');
});

test('initialModel：chunk 内有新 usage.record 时 lastModel 为新模型', () => {
  const { records, lastModel } = parseWireText(WIRE, CTX, 'old/model');
  // 第一条 step.end 前已有 usage.record 覆盖 initialModel
  assert.equal(records[0].model, 'deepseek/deepseek-v4-flash');
  assert.equal(lastModel, 'kimi-code/k3-256k');
});

test('两参调用行为不变：无 initialModel 且无 usage.record 时模型为 unknown，lastModel 为 null', () => {
  const text = '{"type":"context.append_loop_event","event":{"type":"step.end","usage":{"inputOther":1,"output":2,"inputCacheRead":0,"inputCacheCreation":0}},"time":1786600148000}\n';
  const { records, lastModel } = parseWireText(text, CTX);
  assert.equal(records[0].model, 'unknown');
  assert.equal(lastModel, null);
});

const SUBAGENT_WIRE = [
  '{"type":"context.append_loop_event","event":{"type":"step.begin","turnId":"0","step":1},"time":1786600146000}',
  '{"type":"llm.request","kind":"loop","provider":"openai","model":"deepseek-v4-flash","modelAlias":"__secondary__"}',
  '{"type":"usage.record","model":"__secondary__","usage":{"inputOther":100,"output":10,"inputCacheRead":0,"inputCacheCreation":0},"time":1786600147000}',
  '{"type":"context.append_loop_event","event":{"type":"step.end","turnId":"0","step":1,"usage":{"inputOther":100,"output":10,"inputCacheRead":0,"inputCacheCreation":0},"llmStreamDurationMs":2000},"time":1786600148000}',
].join('\n') + '\n';

test('别名解析：__secondary__ 归因到最近 loop 请求的真实模型', () => {
  const { records, lastModel, lastRequestModel } = parseWireText(SUBAGENT_WIRE, CTX);
  assert.equal(records.length, 1);
  assert.equal(records[0].model, 'deepseek-v4-flash');
  assert.equal(lastModel, 'deepseek-v4-flash');
  assert.equal(lastRequestModel, 'deepseek-v4-flash');
});

test('别名解析：改过副模型配置后，历史记录仍按当时请求归因', () => {
  const wire2 = SUBAGENT_WIRE.replaceAll('deepseek-v4-flash', 'qwen3.7-max');
  const { records } = parseWireText(SUBAGENT_WIRE + wire2, CTX);
  assert.equal(records[0].model, 'deepseek-v4-flash');
  assert.equal(records[1].model, 'qwen3.7-max');
});

test('别名解析：无非 loop 请求或完全没有请求时保留别名原样', () => {
  const noReq = [
    '{"type":"llm.request","kind":"title","model":"some-title-model"}',
    '{"type":"usage.record","model":"__secondary__","usage":{}}',
    '{"type":"context.append_loop_event","event":{"type":"step.end","usage":{"inputOther":1,"output":2,"inputCacheRead":0,"inputCacheCreation":0}},"time":1786600148000}',
  ].join('\n') + '\n';
  const { records, lastRequestModel } = parseWireText(noReq, CTX);
  assert.equal(records[0].model, '__secondary__'); // kind=title 不参与归因
  assert.equal(lastRequestModel, null);
});

test('别名解析：initialRequestModel 跨 chunk 续接', () => {
  const text = [
    '{"type":"usage.record","model":"__secondary__","usage":{}}',
    '{"type":"context.append_loop_event","event":{"type":"step.end","usage":{"inputOther":1,"output":2,"inputCacheRead":0,"inputCacheCreation":0}},"time":1786600148000}',
  ].join('\n') + '\n';
  const { records } = parseWireText(text, CTX, null, 'deepseek-v4-flash');
  assert.equal(records[0].model, 'deepseek-v4-flash');
});

const TOML = `
default_model = "kimi-code/k3-256k"

[models."deepseek/deepseek-v4-flash"]
provider = "deepseek"
model = "deepseek-v4-flash"
display_name = "DeepSeek V4 Flash"

[models."kimi-code/k3-256k"]
provider = "managed:kimi-code"
model = "k3-256k"

[providers.deepseek]
base_url = "https://example.com"
`;

// 语句顺序：setValue 后无需立即断言（value 由 set_value 写回）；UI 应在最终状态校验。
test('step.end 记录携带 turnId（归一化字符串），缺失时为空串', () => {
  const text = [
    '{"type":"context.append_loop_event","event":{"type":"step.end","turnId":"7","step":1,"usage":{"inputOther":1,"output":2,"inputCacheRead":3,"inputCacheCreation":4}},"time":1786600148000}',
    '{"type":"context.append_loop_event","event":{"type":"step.end","usage":{"inputOther":1,"output":2,"inputCacheRead":0,"inputCacheCreation":0}},"time":1786600149000}',
  ].join('\n') + '\n';
  const { records } = parseWireText(text, CTX);
  assert.equal(records[0].turnId, '7');
  assert.equal(records[1].turnId, '');
});

const INTERRUPT_WIRE = [
  '{"type":"turn.cancel","turnId":5,"target":"active","reason":"user_cancelled","time":1787327988779}',
  '{"type":"interruptionReminder.recorded","turnId":5,"time":1787327988786}',
  '{"type":"turn.ended","turnId":5,"reason":"cancelled","durationMs":1000,"time":1787327989000}',
  '{"type":"turn.ended","turnId":6,"reason":"completed","durationMs":1000,"time":1787327990000}',
  '{"type":"turn.ended","turnId":7,"reason":"","durationMs":0,"time":1787327991000}',
  '{"type":"turn.ended","turnId":8,"reason":"completed","time":1787327992000}',
  '{"type":"turn.cancel","target":"active","reason":"user_cancelled","time":1787327993000}',
].join('\n') + '\n';

test('中断标记解析：cancel/reminder/ended(中断reason)，数字 turnId 归一化为字符串', () => {
  const { interruptMarkers } = parseWireText(INTERRUPT_WIRE, CTX);
  // turn 5：cancel + reminder + ended(cancelled) 各一条；6(completed)/7(reason空)/8(completed) 不算；无 turnId 丢弃
  assert.equal(interruptMarkers.length, 3);
  assert.deepEqual(interruptMarkers[0], { kind: 'cancel', turnId: '5', reason: 'user_cancelled', time: 1787327988779 });
  assert.deepEqual(interruptMarkers[1], { kind: 'reminder', turnId: '5', reason: '', time: 1787327988786 });
  assert.deepEqual(interruptMarkers[2], { kind: 'ended', turnId: '5', reason: 'cancelled', time: 1787327989000 });
});

test('无中断事件时 interruptMarkers 为空数组（向后兼容）', () => {
  const { records, skippedLines, interruptMarkers, lastModel, lastRequestModel } = parseWireText(WIRE, CTX);
  assert.equal(records.length, 3);
  assert.equal(skippedLines, 1);
  assert.deepEqual(interruptMarkers, []);
  assert.equal(lastModel, 'kimi-code/k3-256k');
});

test('turn.ended 中断 reason 判定：cancelled 算、completed 不算、reason 空不算', () => {
  const wire = [
    '{"type":"turn.ended","turnId":1,"reason":"cancelled","time":1786600149000}',
    '{"type":"turn.ended","turnId":2,"reason":"interrupted","time":1786600150000}',
    '{"type":"turn.ended","turnId":3,"reason":"completed","time":1786600151000}',
    '{"type":"turn.ended","turnId":4,"reason":"","time":1786600152000}',
  ].join('\n') + '\n';
  const { interruptMarkers } = parseWireText(wire, CTX);
  assert.deepEqual(interruptMarkers.map((m) => [m.kind, m.turnId, m.reason]), [
    ['ended', '1', 'cancelled'],
    ['ended', '2', 'interrupted'],
  ]);
});

test('中断标记不影响用量记录解析（同 chunk 混合事件）', () => {
  const wire = [
    '{"type":"usage.record","model":"deepseek/deepseek-v4-flash","usage":{}}',
    '{"type":"context.append_loop_event","event":{"type":"step.end","turnId":"5","usage":{"inputOther":10,"output":20,"inputCacheRead":0,"inputCacheCreation":0}},"time":1787327989000}',
    '{"type":"turn.cancel","turnId":5,"reason":"user_cancelled","time":1787327989010}',
  ].join('\n') + '\n';
  const { records, interruptMarkers } = parseWireText(wire, CTX);
  assert.equal(records.length, 1);
  assert.equal(records[0].turnId, '5');
  assert.equal(records[0].model, 'deepseek/deepseek-v4-flash');
  assert.equal(interruptMarkers.length, 1);
  assert.equal(interruptMarkers[0].kind, 'cancel');
  assert.equal(interruptMarkers[0].turnId, '5');
});

test('parseConfigModels 提取模型段，忽略其他 section', () => {
  const models = parseConfigModels(TOML);
  assert.equal(models.length, 2);
  assert.deepEqual(models[0], {
    key: 'deepseek/deepseek-v4-flash',
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    displayName: 'DeepSeek V4 Flash',
  });
  // 缺 display_name 时回退为 key
  assert.equal(models[1].displayName, 'kimi-code/k3-256k');
});
