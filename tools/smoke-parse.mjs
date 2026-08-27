import { readFileSync } from 'node:fs';
import os from 'node:os';
import { parseWireText, parseConfigModels } from '../lib/parser.js';

// 默认解析本机的 ~/.kimi-code（跨平台）；可用第一个命令行参数覆盖目录。
const HOME = process.argv[2] || `${os.homedir()}/.kimi-code`;
const wire = readFileSync(
  `${HOME}/sessions/wd_.kimi-code_c74c5dae9aab/session_3da0ab02-c456-4f31-a383-a9a58b928edd/agents/main/wire.jsonl`,
  'utf8',
);
const { records, skippedLines } = parseWireText(wire, { workspace: 'smoke', sessionId: 's', agent: 'main' });
console.log('records:', records.length, 'skipped:', skippedLines);
console.log('sample:', records[0]);
console.log('models:', parseConfigModels(readFileSync(`${HOME}/config.toml`, 'utf8')).map((m) => m.key));
