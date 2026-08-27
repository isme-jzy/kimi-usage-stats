// 扫描 ~/.kimi-code：config.toml 模型清单 + sessions/**/wire.jsonl 增量解析。
import { parseWireText, parseConfigModels } from './parser.js';
import * as store from './store.js';

export async function ensureReadPermission(handle, request = false) {
  const opts = { mode: 'read' };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  if (!request) return false;
  return (await handle.requestPermission(opts)) === 'granted';
}

async function* walkWireFiles(dir, path) {
  for await (const [name, h] of dir.entries()) {
    const p = path ? `${path}/${name}` : name;
    if (h.kind === 'directory') yield* walkWireFiles(h, p);
    else if (name === 'wire.jsonl') yield { path: p, handle: h };
  }
}

// sessions/<ws>/session_<sid>/agents/<agent>/wire.jsonl → 解析上下文
function ctxFromPath(p) {
  const seg = p.split('/');
  return { workspace: seg[1] || '', sessionId: seg[2] || '', agent: seg[4] || '' };
}

// 解析口径版本：归因/字段规则变更时递增，下次扫描自动清掉旧偏移与记录做全量重扫（目录授权保留）
export const PARSER_VERSION = 3;

export async function scanKimiHome(dirHandle, onProgress = () => {}) {
  const result = { files: 0, added: 0, skippedLines: 0, models: [], workspaces: {} };

  if ((await store.getMeta('parserVersion')) !== PARSER_VERSION) {
    await store.resetScanData();
    await store.setMeta('parserVersion', PARSER_VERSION);
  }

  // 授权目录根下的 workspaces.json：wd_xxx → 真实项目名，供会话聚合映射显示名。缺失/解析失败静默降级。
  try {
    const wsHandle = await dirHandle.getFileHandle('workspaces.json');
    const data = JSON.parse(await (await wsHandle.getFile()).text());
    result.workspaces = (data && data.workspaces && typeof data.workspaces === 'object') ? data.workspaces : {};
  } catch {
    result.workspaces = {};
  }

  try {
    const cfgHandle = await dirHandle.getFileHandle('config.toml');
    result.models = parseConfigModels(await (await cfgHandle.getFile()).text());
  } catch {
    result.models = []; // 无 config.toml → 只展示记录里出现的模型（aggregate 负责兜底）
  }

  let sessionsDir;
  try {
    sessionsDir = await dirHandle.getDirectoryHandle('sessions');
  } catch {
    return result; // 目录还没产生过会话
  }

  for await (const { path, handle } of walkWireFiles(sessionsDir, 'sessions')) {
    const file = await handle.getFile();
    const prev = await store.getOffset(path);
    if (prev && prev.mtime === file.lastModified && prev.size === file.size) continue; // 无变化

    let start = 0;
    let initialModel = null;
    let initialRequestModel = null;
    if (prev && file.size >= prev.offset) {
      start = prev.offset; // 增量：从上次行边界继续
      initialModel = prev.lastModel ?? null; // 续接上一 chunk 的模型归因
      initialRequestModel = prev.lastRequestModel ?? null; // 续接别名解析所需的最近请求模型
    } else if (prev) {
      await store.deleteRecordsByPath(path); // 文件被截断/重建：清掉旧记录从头扫
      await store.deleteMarkersByPath(path);
    }

    const text = await file.slice(start).text();
    const cut = text.lastIndexOf('\n');
    const complete = cut >= 0 ? text.slice(0, cut + 1) : '';
    let lastModel = initialModel;
    let lastRequestModel = initialRequestModel;
    if (complete) {
      const parsed = parseWireText(complete, ctxFromPath(path), initialModel, initialRequestModel);
      lastModel = parsed.lastModel;
      lastRequestModel = parsed.lastRequestModel;
      await store.appendRecords(parsed.records.map((r) => ({ ...r, path })));
      result.files++;
      result.added += parsed.records.length;
      result.skippedLines += parsed.skippedLines;
      if (parsed.interruptMarkers && parsed.interruptMarkers.length) {
        await store.appendMarkers(parsed.interruptMarkers.map((m) => ({ ...m, path })));
      }
    }
    await store.setOffset(path, {
      // complete 以单字节 \n 结尾、边界字符对齐，存字节长度而非 UTF-16 code unit 数（中文场景两者不等）
      offset: start + new TextEncoder().encode(complete).length,
      size: file.size,
      mtime: file.lastModified,
      lastModel,
      lastRequestModel,
    });
    onProgress(result);
  }

  await store.setMeta('lastScanAt', Date.now());
  await store.setMeta('lastScanResult', { files: result.files, added: result.added, skippedLines: result.skippedLines });
  return result;
}
