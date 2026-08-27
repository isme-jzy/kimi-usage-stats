// store.js 扫描锁的决策纯函数单测。store.js / pricing.js 顶层不依赖浏览器 API（indexedDB 仅在
// openDb() 内使用），因此 scanLockHeld 可直接在 Node 下 import 测试，无需 fake-indexeddb。
import test from 'node:test';
import assert from 'node:assert/strict';
import { scanLockHeld } from '../lib/store.js';

test('scanLockHeld：未超 TTL 且 at 为数字 → 视为有效持有', () => {
  const now = 5000;
  const cur = { owner: 'scan-x', at: 1000 };
  assert.equal(scanLockHeld(cur, now, 120000), true); // 4s < 120s
});

test('scanLockHeld：超过 TTL → 过期 → false（允许重获）', () => {
  const now = 5000;
  const cur = { owner: 'scan-x', at: 1000 };
  assert.equal(scanLockHeld(cur, now, 3000), false); // 4s > 3s
});

test('scanLockHeld：恰好等于 TTL → 已过期 → false（判定为 `now-at < ttl` 严格小于）', () => {
  const ttl = 2000;
  assert.equal(scanLockHeld({ owner: 'a', at: 1000 }, 1000 + ttl, ttl), false); // now-at === ttl
});

test('scanLockHeld：超过 TTL 1ms → 已过期 → false', () => {
  assert.equal(scanLockHeld({ owner: 'a', at: 1000 }, 3001, 2000), false); // 2001 > 2000，超界 1ms
});

test('scanLockHeld：无锁记录 / at 非数字 → false（无锁或坏记录）', () => {
  assert.equal(scanLockHeld(null, 5000), false);
  assert.equal(scanLockHeld(undefined, 5000), false);
  assert.equal(scanLockHeld({ owner: 'scan-x', at: 'abc' }, 5000), false);
  assert.equal(scanLockHeld({ owner: 'scan-x' }, 5000), false);
});