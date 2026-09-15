// IndexedDB 薄封装：kv（目录句柄、meta）、offsets（文件读取偏移）、records（用量记录，path 索引）。
import { DEFAULT_PRICE_TABLE, PRICE_TABLE_VERSION, clonePriceTable, migratePriceTable } from './pricing.js';
const DB_NAME = 'kimi-usage-stats';
const DB_VERSION = 2;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // DB_VERSION 1 的既有库：已存在则跳过；新库从 0 建起时依次创建。
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('offsets')) db.createObjectStore('offsets');
      if (!db.objectStoreNames.contains('records')) {
        const recs = db.createObjectStore('records', { autoIncrement: true });
        recs.createIndex('path', 'path');
      }
      // v2 新增：中断标记（turnId/reason/time/kind），path 索引，供中断统计实时读取。
      if (!db.objectStoreNames.contains('markers')) {
        const mk = db.createObjectStore('markers', { autoIncrement: true });
        mk.createIndex('path', 'path');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function withStore(name, mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(name, mode);
        const req = fn(t.objectStore(name));
        t.oncomplete = () => resolve(req && 'result' in req ? req.result : undefined);
        t.onerror = () => reject(t.error);
      }),
  );
}

export const saveDirHandle = (h) => withStore('kv', 'readwrite', (s) => s.put(h, 'dirHandle'));
export const loadDirHandle = () => withStore('kv', 'readonly', (s) => s.get('dirHandle'));
export const getOffset = (path) => withStore('offsets', 'readonly', (s) => s.get(path));
export const setOffset = (path, v) => withStore('offsets', 'readwrite', (s) => s.put(v, path));
export const setMeta = (k, v) => withStore('kv', 'readwrite', (s) => s.put(v, `meta:${k}`));
export const getMeta = (k) => withStore('kv', 'readonly', (s) => s.get(`meta:${k}`));
export const loadAllRecords = () => withStore('records', 'readonly', (s) => s.getAll()).then((r) => r || []);

// 价目表覆盖：kv 键 "priceOverrides"。初始由 initPriceTable 用默认价目表填充，用户改动后整体覆盖。
const PRICE_KEY = 'priceOverrides';
export const getPriceOverrides = () =>
  withStore('kv', 'readonly', (s) => s.get(PRICE_KEY)).then((v) => (v == null ? null : v));
export const setPriceOverrides = (table) =>
  withStore('kv', 'readwrite', (s) => s.put(table || {}, PRICE_KEY));
// 首次（或尚未写入过覆盖）用默认价目表播种；已存在则按结构版本做一次升级迁移。
// 迁移规则见 pricing.migratePriceTable：未改动过的行升到新内置价（含峰谷时段），用户改过的行原样保留。
// 返回生效的价目表。
export async function initPriceTable() {
  const existing = await getPriceOverrides();
  if (existing == null) {
    const seed = clonePriceTable(DEFAULT_PRICE_TABLE);
    await setPriceOverrides(seed);
    await setMeta('priceTableVersion', PRICE_TABLE_VERSION);
    return seed;
  }
  const ver = await getMeta('priceTableVersion');
  if (typeof ver === 'number' && ver >= PRICE_TABLE_VERSION) return existing;
  const migrated = migratePriceTable(existing);
  await setPriceOverrides(migrated);
  await setMeta('priceTableVersion', PRICE_TABLE_VERSION);
  return migrated;
}

export function appendRecords(records) {
  if (!records.length) return Promise.resolve();
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction('records', 'readwrite');
        const s = t.objectStore('records');
        for (const r of records) s.put(r);
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
      }),
  );
}

export function deleteRecordsByPath(path) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction('records', 'readwrite');
        const idx = t.objectStore('records').index('path');
        idx.openCursor(IDBKeyRange.only(path)).onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor) { cursor.delete(); cursor.continue(); }
        };
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
      }),
  );
}

// —— 中断标记（v2）——
export function appendMarkers(markers) {
  if (!markers.length) return Promise.resolve();
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction('markers', 'readwrite');
        const s = t.objectStore('markers');
        for (const m of markers) s.put(m);
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
      }),
  );
}

export const loadAllMarkers = () => withStore('markers', 'readonly', (s) => s.getAll()).then((r) => r || []);

export function deleteMarkersByPath(path) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction('markers', 'readwrite');
        const idx = t.objectStore('markers').index('path');
        idx.openCursor(IDBKeyRange.only(path)).onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor) { cursor.delete(); cursor.continue(); }
        };
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
      }),
  );
}

export async function clearAllData() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(['kv', 'offsets', 'records', 'markers'], 'readwrite');
    for (const n of ['kv', 'offsets', 'records', 'markers']) t.objectStore(n).clear();
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

// 只清扫描产物（偏移 + 记录 + 中断标记），保留 kv 里的目录授权与 meta —— 用于解析口径升级后的全量重扫
export async function resetScanData() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(['offsets', 'records', 'markers'], 'readwrite');
    t.objectStore('offsets').clear();
    t.objectStore('records').clear();
    t.objectStore('markers').clear();
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

// 扫描锁持有判定（决策纯函数）：cur 存在、at 为数字且 now - at < ttl（严格小于）视为持有，供多实例互斥
export function scanLockHeld(cur, now, ttl) {
  return !!cur && typeof cur.at === 'number' && now - cur.at < ttl;
}
