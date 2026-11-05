'use strict';
// 「宽权限」：能联网、能运行命令，只能写指定的文件夹。Claude Code、Codex 共用同一份底线，由各自的系统沙箱执行
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const ROOT = path.join(__dirname, '..');
const DEFAULT_WRITE = []; // 默认只能写自己的工作目录；要写别的地方，在智能体设置的「可写文件夹」里加（底线见下面的 NO_READ 和 PROTECT）
const expand = (p) => (p.startsWith('~') ? path.join(HOME, p.slice(1)) : p);

// 读不到：Agent Hub 的 Key 和访问码、各种登录凭证、钥匙串、浏览器数据（能联网时，读得到就可能被发出去）
const NO_READ = [
  path.join(ROOT, 'data'), path.join(ROOT, '.env'), path.join(ROOT, '.backup'), // 旧备份里也可能有 Key
  ...['.ssh', '.gnupg', '.aws', '.netrc', '.config/gh', '.codex/auth.json', '.claude/.credentials.json',
    'Library/Keychains', 'Library/Cookies', 'Library/Safari', 'Library/Application Support/Google/Chrome', 'Library/Application Support/Firefox']
    .map((p) => path.join(HOME, p)),
];

// 能写整个主目录时，这些也不能改：改了它们就能在沙箱外运行命令、或者下次关掉限制
// （shell 启动脚本、开机自启、各 AI 自己的配置和 hook、知识库整理脚本、App、~/Library 里的各种设置）
const PROTECT = ['.zshrc', '.zshenv', '.zprofile', '.zlogin', '.bashrc', '.bash_profile', '.profile', '.ssh', '.gitconfig', '.config',
  '.claude', '.codex', '.agents', '.local', 'Library', 'Applications'].map((p) => path.join(HOME, p));

// 不能改：Agent Hub 自己和启动文件（改了它们，下次启动时这些限制就没了）。工作目录例外
const selfFiles = () => [
  ...fs.readdirSync(ROOT).filter((n) => !['workspace', 'data', '.env'].includes(n)).map((n) => path.join(ROOT, n)),
  path.join(ROOT, '..', 'start.command'),
  ...PROTECT,
];

function wideScope(agent) {
  const list = String(agent.writeDirs || '').split(/[\n,，]+/).map((s) => s.trim()).filter(Boolean);
  const write = [...new Set((list.length ? list : DEFAULT_WRITE).map((p) => path.resolve(expand(p))))];
  for (const d of write) {
    if (d !== HOME && !d.startsWith(HOME + path.sep)) throw new Error(`可写文件夹不能是 ${d}：只能是主目录或主目录里的文件夹`);
  }
  return { write, keep: selfFiles(), noRead: NO_READ };
}

module.exports = { wideScope, DEFAULT_WRITE, NO_READ, PROTECT };
