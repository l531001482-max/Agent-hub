'use strict';
// 本机 Codex：通过官方无界面模式 `codex exec` 调用，用你在 Codex 里登录的账号，不需要 API Key
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readLines } = require('./util');
const { safeName } = require('./attachments');
const { DEFAULT_WORKDIR, expandHome } = require('./claude-code');
const { wideScope } = require('./wide');
const { track, longNote } = require('./proctree');

const UPLOAD_DIR = '上传的文件';
const GROUP_NOTE = '\n\n这是群聊里的一次发言：不用读取知识库、记忆或项目说明文件，直接回答。';

// 工具权限。沙箱由 Codex 自己执行：read-only 不能写文件；workspace-write 只能写工作目录；两者都不能联网。
// 注意：能运行命令时，沙箱不限制「读」，Codex 能读到这台 Mac 上的其他文件
const TOOL_MODES = {
  chat: { sandbox: 'read-only', off: ['shell_tool', 'unified_exec'] }, // 只聊天：关掉命令工具，读不了文件
  read: { sandbox: 'read-only', off: [] },                             // 能运行命令查看文件，不能写
  edit: { sandbox: 'workspace-write', off: [] },                       // 能运行命令，只能写工作目录
  wide: { wide: true, off: [] },                                       // 能运行命令、联网，能写 writeDirs 里的文件夹（见 wide.js）
};
// 群聊里用不到、又能碰外部账号或另开任务的功能一律关掉（发布网站、插件、看电脑屏幕、再开子智能体等）
const OFF_FEATURES = ['apps', 'plugins', 'remote_plugin', 'plugin_sharing', 'plugin_discovery_prefetch', 'tool_suggest', 'skill_search',
  'skill_mcp_dependency_install', 'image_generation', 'computer_use', 'browser_use', 'browser_use_external', 'in_app_browser',
  'goals', 'multi_agent', 'collaboration_modes', 'hooks', 'workspace_dependencies', 'worktrees'];
const EFFORT = ['low', 'medium', 'high', 'xhigh', 'max'];
const IMAGE_EXT = { 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };

function findCodex(custom) {
  const candidates = [
    expandHome(custom),
    ...(process.env.PATH || '').split(':').filter(Boolean).map((d) => path.join(d, 'codex')),
    '/opt/homebrew/bin/codex', '/usr/local/bin/codex', path.join(os.homedir(), '.local/bin/codex'),
  ].filter(Boolean);
  for (const c of candidates) {
    try { fs.accessSync(c, fs.constants.X_OK); if (fs.statSync(c).isFile()) return c; } catch {}
  }
  return null;
}

// 宽权限的沙箱规则：越具体的路径优先，deny 优先于 read、write
function wideProfile(scope, workdir) {
  const rules = { '/': 'read' };
  for (const p of scope.write) rules[p] = 'write';
  for (const p of scope.keep) rules[p] = 'read';
  rules[workdir] = 'write';
  for (const p of scope.noRead) rules[p] = 'deny';
  const body = Object.entries(rules).map(([k, v]) => `${JSON.stringify(k)}=${JSON.stringify(v)}`).join(',');
  return `permissions.hubwide={extends=":workspace",filesystem={${body}},network={enabled=true}}`;
}

function clean(s, workdir) {
  let t = String(s || '').replace(/^\S+ -l?c /, '').replace(/\s+/g, ' ').trim();
  t = t.split(workdir + path.sep).join('');
  return (t.length > 160 ? t.slice(0, 160) + '…' : t).replace(os.homedir(), '~');
}

async function callCodex(agent, system, prompt, { signal, onDelta, onUsage = () => {}, onThinking = () => {}, onTrace = () => {}, limitMs = 3600000, ctx = {} }) {
  const bin = findCodex(agent.command);
  if (!bin) throw new Error('没找到 codex 命令：请先安装 Codex，或在 data/agents.json 里用 "command" 写上它的路径');
  const modeName = TOOL_MODES[agent.toolMode] ? agent.toolMode : 'chat';
  const mode = TOOL_MODES[modeName];
  const workdir = path.resolve(expandHome(agent.workdir) || DEFAULT_WORKDIR);
  fs.mkdirSync(workdir, { recursive: true });

  // --ignore-user-config：不加载 ~/.codex/config.toml 里的 MCP、钩子等设置（登录信息照常用）
  const args = ['exec', '--json', '--color', 'never', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config',
    '-C', workdir, ...(mode.wide
      ? ['-c', 'default_permissions="hubwide"', '-c', wideProfile(wideScope(agent), workdir), '-c', 'features.network_proxy=false', '-c', 'web_search="live"']
      : ['-s', mode.sandbox, '-c', 'web_search="disabled"']),
    '-c', `developer_instructions=${JSON.stringify(system + GROUP_NOTE + (modeName === 'chat' ? '' : longNote(limitMs)))}`];
  for (const f of [...OFF_FEATURES, ...mode.off]) args.push('-c', `features.${f}=false`);
  if (agent.model) args.push('-m', agent.model);
  if (EFFORT.includes(agent.effort)) args.push('-c', `model_reasoning_effort="${agent.effort}"`);

  // 用户上传的原文件：能用工具时复制进工作目录
  if (modeName !== 'chat' && ctx.files && ctx.files.length) {
    const to = path.join(workdir, UPLOAD_DIR);
    fs.mkdirSync(to, { recursive: true });
    const names = ctx.files.map((f) => { const n = safeName(f.name); fs.copyFileSync(f.path, path.join(to, n), fs.constants.COPYFILE_FICLONE); return `${UPLOAD_DIR}/${n}`; });
    prompt += `\n\n（用户上传的原文件已放进工作目录：${names.join('、')}，需要时可以直接读取或修改。）`;
  }
  // 图片：写成临时文件交给 -i，这次调用结束就删
  let tmp = null;
  if (ctx.images && ctx.images.length) {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-codex-'));
    ctx.images.forEach((im, i) => {
      const f = path.join(tmp, `${i + 1}${IMAGE_EXT[im.mime] || '.png'}`);
      fs.writeFileSync(f, Buffer.from(im.data, 'base64'), { mode: 0o600 });
      args.push('-i', f);
    });
  }

  const child = spawn(bin, args, { cwd: workdir, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  const procs = track(child.pid);
  const kill = () => {
    procs.reap(); // 先停它开的命令（趁 Codex 还在、进程树还完整）
    if (child.exitCode !== null) return;
    child.kill('SIGTERM');
    setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 3000).unref();
  };
  signal.addEventListener('abort', kill, { once: true });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
  child.stdin.on('error', () => {}); // 进程提前退出时忽略写入错误
  child.stdin.end(prompt);

  let text = '', failure = '';
  const emit = (s) => { if (s) { text += s; onDelta(s); } };
  const gap = () => { if (text && !text.endsWith('\n\n')) emit(text.endsWith('\n') ? '\n' : '\n\n'); };
  const reading = (async () => {
    for await (const line of readLines(child.stdout)) {
      let j; try { j = JSON.parse(line); } catch { continue; }
      const it = j.item || {};
      if (j.type === 'turn.completed' && j.usage) {
        const u = j.usage, cached = u.cached_input_tokens || 0;
        onUsage({ in: Math.max(0, (u.input_tokens || 0) - cached), cache: cached, out: (u.output_tokens || 0) + (u.reasoning_output_tokens || 0) });
      }
      if (j.type === 'turn.failed') failure = (j.error && j.error.message) || '未知错误';
      else if (j.type === 'error') failure = j.message || '未知错误';
      else if (j.type === 'item.started' && it.type === 'command_execution') { gap(); emit(`> 🔧 ${clean(it.command, workdir)}\n\n`); }
      else if (j.type === 'item.completed' && it.type === 'file_change') { gap(); emit(`> ✏️ ${clean((it.changes || []).map((c) => c.path).join('、'), workdir)}\n\n`); onTrace({ tool: 'Write', paths: (it.changes || []).map((c) => c.path).filter(Boolean), workdir }); }
      else if (j.type === 'item.completed' && it.type === 'reasoning' && it.text) onThinking(it.text + '\n');
      else if (j.type === 'item.completed' && /web_search/.test(it.type || '') && it.query) onTrace({ tool: 'WebSearch', input: { query: it.query }, workdir });
      else if (j.type === 'item.completed' && it.type === 'agent_message') { gap(); emit(it.text); }
    }
  })();
  const exited = new Promise((resolve) => child.on('close', resolve));
  const failed = new Promise((_, reject) => child.on('error', reject));
  try {
    const [, code] = await Promise.race([Promise.all([reading, exited]), failed]);
    if (signal.aborted) throw signal.reason || new Error('aborted');
    if (failure) throw new Error('Codex 出错：' + failure);
    if (code !== 0) throw new Error(`Codex 异常退出（代码 ${code}）：${stderr.trim().slice(-400) || '没有错误信息'}`);
    return text;
  } finally {
    signal.removeEventListener('abort', kill);
    kill();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { callCodex, findCodex, TOOL_MODES };
