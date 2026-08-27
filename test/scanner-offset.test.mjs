// 验证 scanner.js 的偏移计算模式：存的是字节长度而非 UTF-16 code unit 数。
// 不 import scanner.js（依赖浏览器 API），只复刻其 offset/slice 流程做纯 Node 验证。
import test from 'node:test';
import assert from 'node:assert/strict';

const encoder = new TextEncoder();
const byteLen = (s) => encoder.encode(s).length;

// 与 scanner.js 相同的切片逻辑：从字节偏移 start 切出文本，截到最后一个 \n（含）
function sliceComplete(buf, start) {
  const text = buf.subarray(start).toString('utf8');
  const cut = text.lastIndexOf('\n');
  return cut >= 0 ? text.slice(0, cut + 1) : '';
}

test('含中文文本：字节长度大于 code unit 数；纯 ASCII 两者相等', () => {
  const zh = '{"type":"usage.record","model":"中文模型"}\n';
  assert.notEqual(byteLen(zh), zh.length);
  assert.ok(byteLen(zh) > zh.length);

  const ascii = '{"type":"usage.record","model":"kimi-code/k3-256k"}\n';
  assert.equal(byteLen(ascii), ascii.length);
});

test('按字节偏移续扫：从上次行边界切回后不多读一行、不漏一行', () => {
  const line1 = '{"type":"usage.record","model":"中文模型A"}\n';
  const line2 = '{"type":"usage.record","model":"模型B"}\n';
  const line3partial = '{"type":"usage.record","model":"截断的一半';
  const buf = Buffer.from(line1 + line2 + line3partial, 'utf8');

  // 第一次扫描：从 0 开始，complete 为前两条完整行
  const complete1 = sliceComplete(buf, 0);
  assert.equal(complete1, line1 + line2);
  const offset = 0 + byteLen(complete1);

  // 第二次增量扫描：从字节偏移继续，不应重读 line2
  const complete2 = sliceComplete(buf, offset);
  assert.equal(complete2, ''); // 只剩半行，无完整行可读

  // 文件补全后：从同一字节偏移恰好读到第三行，不含前两条
  const buf2 = Buffer.from(line1 + line2 + line3partial + '"}\n', 'utf8');
  const complete3 = sliceComplete(buf2, offset);
  assert.equal(complete3, line3partial + '"}\n');
});

test('反例：若按 code unit 数存偏移，中文场景会回漂重读', () => {
  const line1 = '{"type":"usage.record","model":"中文模型A"}\n';
  const line2 = '{"type":"usage.record","model":"模型B"}\n';
  const buf = Buffer.from(line1 + line2, 'utf8');

  const complete = sliceComplete(buf, 0);
  const wrongOffset = complete.length; // 旧实现：code unit 数
  assert.ok(wrongOffset < byteLen(complete));
  // 用错误偏移切回 → 落在 line1 的多字节字符中间，行边界错位
  const reread = sliceComplete(buf, wrongOffset);
  assert.notEqual(reread, '');
});
