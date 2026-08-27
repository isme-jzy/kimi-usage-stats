import test from 'node:test';
import assert from 'node:assert/strict';
import { encodePng, drawIcon } from '../tools/gen-icons.mjs';

test('encodePng 产出合法 PNG（签名 + IHDR 尺寸）', () => {
  const size = 48;
  const png = encodePng(size, size, drawIcon(size));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), size);  // IHDR width
  assert.equal(png.readUInt32BE(20), size);  // IHDR height
  assert.equal(png[25], 6);                  // color type RGBA
});

test('drawIcon 输出 RGBA 像素数正确且非全透明', () => {
  const px = drawIcon(16);
  assert.equal(px.length, 16 * 16 * 4);
  assert.ok(px.some((v, i) => i % 4 === 3 && v > 0));
});
