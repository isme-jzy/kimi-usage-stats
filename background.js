import * as store from './lib/store.js';
import { ensureReadPermission } from './lib/scanner.js';
import { parseConfigModels } from './lib/parser.js';
import { parseSessionStats } from './lib/session-stats.js';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'OPEN_DASHBOARD') {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html') });
    return;
  }
  if (msg?.type === 'KUS_SESSION_STATS') {
    getSessionStats(msg.sessionId).then(sendResponse);
    return true; // 异步 sendResponse
  }
});

let dirHandle = null;
async function getHandle() {
  if (dirHandle) return dirHandle;
  dirHandle = await store.loadDirHandle();
  return dirHandle;
}

// sessions/<ws>/<sid>/agents/<agent>/wire.jsonl，优先 main agent
async function findWireHandle(sessionsDir, sid) {
  for await (const [, wsDir] of sessionsDir.entries()) {
    if (wsDir.kind !== 'directory') continue;
    let sdir;
    try { sdir = await wsDir.getDirectoryHandle(sid); } catch { continue; }
    let agents;
    try { agents = await sdir.getDirectoryHandle('agents'); } catch { continue; }
    let best = null;
    for await (const [agentName, agentDir] of agents.entries()) {
      if (agentDir.kind !== 'directory') continue;
      try {
        const f = await agentDir.getFileHandle('wire.jsonl');
        if (!best || agentName === 'main') best = f;
      } catch { /* 该 agent 无 wire 文件 */ }
    }
    if (best) return best;
  }
  return null;
}

const TAIL_BYTES = 4 * 1024 * 1024; // 尾部解析上限：统计与最近上下文
const HEAD_BYTES = 512 * 1024; // 头部解析：profile.bind / tools_snapshot 出现在会话开头

async function readAligned(file, start, end) {
  let text = await file.slice(start, end).text();
  if (start > 0) text = text.slice(text.indexOf('\n') + 1); // 行边界对齐，丢弃首行残段
  return text;
}

async function getSessionStats(sid) {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(sid || '')) return { ok: false, reason: 'bad-session' };
    const h = await getHandle();
    if (!h) return { ok: false, reason: 'no-dir' };
    if (!(await ensureReadPermission(h))) return { ok: false, reason: 'no-permission' };
    let sessionsDir;
    try { sessionsDir = await h.getDirectoryHandle('sessions'); } catch { return { ok: false, reason: 'no-sessions' }; }
    const wire = await findWireHandle(sessionsDir, sid);
    if (!wire) return { ok: false, reason: 'no-session' };
    const file = await wire.getFile();
    const tailStart = Math.max(0, file.size - TAIL_BYTES);
    const tail = parseSessionStats(await readAligned(file, tailStart, file.size));
    let head = null;
    if (tailStart > 0) head = parseSessionStats(await readAligned(file, 0, Math.min(HEAD_BYTES, tailStart)));
    const breakdown = {
      system: tail.breakdown.system || head?.breakdown.system || 0,
      tools: tail.breakdown.tools || head?.breakdown.tools || 0,
      messages: tail.breakdown.messages,
    };
    const modelAlias = tail.modelAlias || head?.modelAlias || null;
    let maxContext = 0;
    try {
      const cfgText = await (await h.getFileHandle('config.toml')).getFile().then((f) => f.text());
      const m = parseConfigModels(cfgText).find((x) => x.key === modelAlias);
      maxContext = m?.maxContextSize || 0;
    } catch { /* 缺 config 不影响主路径 */ }
    return { ok: true, maxContext, modelAlias, contextTotal: tail.contextTotal, breakdown, stats: tail.stats };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
}
