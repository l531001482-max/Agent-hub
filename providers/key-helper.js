'use strict';
// Claude Code 的 apiKeyHelper：Claude Code 接 DeepSeek 等第三方接口时，由它在沙箱外运行这个脚本拿 Key。
// 这样 Key 不放进环境变量，AI 运行的命令读不到（沙箱里也读不到 data/）
const fs = require('fs');
const path = require('path');
const id = process.argv[2];
try {
  const list = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'agents.json'), 'utf8'));
  const a = list.find((x) => x.id === id);
  let k = (a && a.apiKey) || '';
  if (k.startsWith('env:')) k = process.env[k.slice(4)] || '';
  if (!k) throw new Error('没有 Key');
  process.stdout.write(k);
} catch (e) { process.stderr.write('key-helper: ' + e.message + '\n'); process.exit(1); }
