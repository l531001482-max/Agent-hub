'use strict';
// 本机 Claude Code：通过官方无界面模式 `claude -p` 调用，用你在 Claude Code 里登录的账号，不需要 API Key
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readLines } = require('./util');
const { claudeContent, safeName } = require('./attachments');
const { wideScope } = require('./wide');
const { track, longNote, PREFIX } = require('./proctree');

const DEFAULT_WORKDIR = path.join(__dirname, '..', 'workspace');
const UPLOAD_DIR = '上传的文件';

// 工具权限：始终加 --restricted（不能运行命令，文件操作限制在工作目录内）和 --strict-mcp-config（不加载 MCP，不能控制电脑）
const TOOL_MODES = {
  chat: { tools: '', permission: 'dontAsk' },                              // 只聊天，不用任何工具
  read: { tools: 'Read,Glob,Grep', permission: 'dontAsk' },                // 只能读工作目录里的文件
  edit: { tools: 'Read,Glob,Grep,Edit,Write', permission: 'acceptEdits' }, // 可以在工作目录里新建、修改文件
  // 可用 Skill：在 edit 的基础上能用 ~/.claude/skills 里装的 skill、搜索和读网页；命令只放行 agent-reach 的只读查询（见 REACH_ALLOW）
  skills: { tools: 'Read,Glob,Grep,Edit,Write,Skill,WebFetch,WebSearch,Bash', permission: 'acceptEdits', skills: true },
  // 宽权限：在 skills 的基础上能运行任何命令、联网，能写 writeDirs 里的文件夹；命令在系统沙箱里跑（见 wide.js）
  wide: { tools: 'Read,Glob,Grep,Edit,Write,Skill,WebFetch,WebSearch,Bash', permission: 'acceptEdits', skills: true, wide: true },
};

// agent-reach 只放行读取：搜索、读帖、取字幕、看状态。安装、登录、更新、卸载、配置 Key 要你自己在终端里运行。
// Claude Code 会把 && ; | $( ) 拼起来的命令拆开逐个检查，拼不进别的命令
const REACH_READ = ['read', 'channels', 'doctor', 'check', 'github', 'youtube', 'bilibili', 'v2ex', 'web', 'twitter', 'reddit',
  'facebook', 'instagram', 'xiaohongshu', 'linkedin', 'boss', 'xueqiu', 'xiaoyuzhou'];
const REACH_ALLOW = REACH_READ.map((c) => `Bash(agent-reach ${c}:*)`);
const SKILLS_NOTE = '\n\n【工具】你可以用 Skill 工具调用已安装的 skill（名字以 hub: 开头）。命令只能运行 agent-reach 的只读查询（搜索、读帖、取字幕）；'
  + '要安装、登录、更新的，请告诉用户在 Mac 的终端里自己运行，不要反复尝试。文件只能在工作目录里读写。';
const WIDE_NOTE = '\n\n【工具】你可以用 Skill 工具调用已安装的 skill（名字以 hub: 开头），可以运行命令、联网。命令在沙箱里跑：只能写工作目录和用户指定的文件夹，'
  + 'Agent Hub 自己的文件不能改，Key 和登录凭证读不到。被沙箱拒绝时告诉用户，不要尝试绕过。';

// --restricted 不加载 ~/.claude/skills，所以把它复制成一个只在本次运行加载的插件（--plugin-dir）。
// 用复制品而不是链接：skill 的参考文件要能读（--add-dir），但群聊里的 Claude Code 不能改到你真正的 skill
const SKILLS_SRC = path.join(os.homedir(), '.claude', 'skills');
const SKILLS_PLUGIN = path.join(__dirname, '..', '.cache', 'skills-plugin');
const SKILL_FILE_LIMIT = 5 * 1024 * 1024; // 单个文件超过 5MB 不复制（skill 里一般只有文字）
let skillsStamp = '';

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const statOrNull = (p) => { try { return fs.statSync(p); } catch { return null; } }; // 跟着软链接走；坏掉的链接返回 null
const copyable = (src) => { const st = statOrNull(src); return !!st && (st.isDirectory() ? !['.git', 'node_modules'].includes(path.basename(src)) : st.size <= SKILL_FILE_LIMIT); };

function stampOf(dir, out) { // 文件名 + 大小 + 修改时间，skill 有变化才重新复制
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = copyable(p) && statOrNull(p); // 比如 agent-reach 链到 ~/.agents/skills
    if (!st) continue;
    if (st.isDirectory()) stampOf(p, out); else out.push(`${p}:${st.size}:${st.mtimeMs}`);
  }
  return out;
}

function prepareSkillsPlugin() {
  let names = [];
  try { names = fs.readdirSync(SKILLS_SRC).filter((n) => !n.startsWith('.') && fs.existsSync(path.join(SKILLS_SRC, n, 'SKILL.md'))); } catch {}
  const stamp = names.map((n) => stampOf(path.join(SKILLS_SRC, n), []).join('|')).join('\n');
  if (stamp === skillsStamp && fs.existsSync(path.join(SKILLS_PLUGIN, '.claude-plugin'))) return SKILLS_PLUGIN;
  const tmp = `${SKILLS_PLUGIN}.tmp-${process.pid}-${Date.now()}`;
  fs.mkdirSync(path.join(tmp, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'hub', version: '1.0.0', description: '复制自 ~/.claude/skills，供 Agent Hub 使用', skills: './skills/' }, null, 2));
  for (const n of names) {
    fs.cpSync(path.join(SKILLS_SRC, n), path.join(tmp, 'skills', n), { recursive: true, dereference: true, filter: copyable });
  }
  fs.rmSync(SKILLS_PLUGIN, { recursive: true, force: true });
  fs.renameSync(tmp, SKILLS_PLUGIN);
  skillsStamp = stamp;
  return SKILLS_PLUGIN;
}

const expandHome = (p) => (p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

function findClaude(custom) {
  const home = os.homedir();
  const candidates = [
    expandHome(custom),
    ...(process.env.PATH || '').split(':').filter(Boolean).map((d) => path.join(d, 'claude')),
    '/opt/homebrew/bin/claude', '/usr/local/bin/claude',
    path.join(home, '.local/bin/claude'), path.join(home, '.claude/local/claude'),
    path.join(path.dirname(process.execPath), 'claude'),
  ].filter(Boolean);
  for (const c of candidates) {
    try { fs.accessSync(c, fs.constants.X_OK); if (fs.statSync(c).isFile()) return c; } catch {}
  }
  return null;
}

function toolLabel(block, workdir) {
  const i = block.input || {};
  let target = String(i.file_path || i.path || i.pattern || i.url || i.query || i.skill || i.command || '').replace(/\s+/g, ' ');
  if (target.startsWith(workdir + path.sep)) target = target.slice(workdir.length + 1); // 工作目录里的文件只显示相对路径
  if (target.length > 160) target = target.slice(0, 160) + '…';
  return block.name + (target ? ' ' + target.replace(os.homedir(), '~') : '');
}

// 「接口地址」：留空 = 用 Claude Code 登录的账号；填了就改接这个 Anthropic 格式的接口（DeepSeek 只填域名时自动补 /anthropic）
function customApi(agent) {
  const raw = String(agent.baseUrl || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  try { const u = new URL(raw); return /(^|\.)deepseek\.com$/i.test(u.hostname) && (u.pathname === '/' || u.pathname === '' || u.pathname === '/v1') ? u.origin + '/anthropic' : raw; }
  catch { return raw; }
}

async function callClaudeCode(agent, system, prompt, { signal, onDelta, onUsage = () => {}, onThinking = () => {}, onTrace = () => {}, limitMs = 3600000, ctx = {} }) {
  const bin = findClaude(agent.command);
  if (!bin) throw new Error('没找到 claude 命令：请先安装 Claude Code，或在 data/agents.json 里用 "command" 写上它的路径');
  const modeName = TOOL_MODES[agent.toolMode] ? agent.toolMode : 'chat';
  const mode = TOOL_MODES[modeName];
  const api = customApi(agent); // 接第三方接口（比如 DeepSeek）时不用 Claude 账号
  const tools = api ? mode.tools.split(',').filter((t) => t !== 'WebSearch').join(',') : mode.tools; // 网页搜索是 Anthropic 服务器上的功能，第三方接口没有
  const workdir = path.resolve(expandHome(agent.workdir) || DEFAULT_WORKDIR);
  fs.mkdirSync(workdir, { recursive: true });

  const args = [
    '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--no-session-persistence', '--strict-mcp-config', '--restricted',
    '--tools', tools, '--permission-mode', mode.permission,
    // 只聊天时换成群聊的系统提示词；能用工具时保留 Claude Code 自带的提示词，再追加群聊规则
    modeName === 'chat' ? '--system-prompt' : '--append-system-prompt', (mode.wide ? system + WIDE_NOTE : mode.skills ? system + SKILLS_NOTE : system) + (modeName === 'chat' ? '' : longNote(limitMs)),
  ];
  if (agent.model) args.push('--model', agent.model);
  if (agent.effort) args.push('--effort', agent.effort);
  const env = { ...process.env };
  const settings = {};
  if (api) {
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) delete env[k];
    env.ANTHROPIC_BASE_URL = api;
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
    // 后台的小任务（读网页时总结、起标题等）也用同一个模型
    if (agent.model) for (const k of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']) env[k] = agent.model;
    // Key 不放环境变量（AI 运行的命令能读到环境变量），由 Claude Code 在沙箱外运行 key-helper.js 去 data/ 里取
    const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
    settings.apiKeyHelper = [process.execPath, path.join(__dirname, 'key-helper.js'), agent.id].map(q).join(' ');
  }
  if (mode.skills) {
    const plugin = prepareSkillsPlugin();
    const ro = '/' + plugin + '/**'; // 开头两个斜杠 = 绝对路径
    const scope = mode.wide ? wideScope(agent) : null;
    const rule = (tool) => (p) => `${tool}(/${p}${tool === 'Read' || isDir(p) ? '/**' : ''})`;
    const noEdit = scope ? [...scope.keep, ...scope.noRead].flatMap((p) => ['Edit', 'Write', 'NotebookEdit'].map((t) => rule(t)(p))) : [];
    args.push('--plugin-dir', plugin, '--add-dir', plugin, ...(scope ? scope.write : []),
      '--allowedTools', 'Skill', ...(api ? [] : ['WebSearch']), 'WebFetch', ...(scope ? ['Bash'] : REACH_ALLOW),
      '--disallowedTools', `Edit(${ro})`, `Write(${ro})`, `NotebookEdit(${ro})`, ...noEdit, ...(scope ? scope.noRead.map(rule('Read')) : []));
    if (scope) {
      settings.sandbox = {
        enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false,
        filesystem: { allowWrite: [workdir, ...scope.write], denyWrite: [...scope.keep, ...scope.noRead], denyRead: scope.noRead },
        network: { allowedDomains: ['*'] },
      };
    }
    // agent-reach 装在 ~/.local/bin（uv 的默认位置），从「访达」双击启动时 PATH 里可能没有它
    const dirs = String(env.PATH || '').split(':');
    const extra = [path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin'].filter((d) => !dirs.includes(d) && fs.existsSync(d));
    if (extra.length) env.PATH = [...extra, ...dirs].filter(Boolean).join(':');
  }

  if (Object.keys(settings).length) args.push('--settings', JSON.stringify(settings));

  // 用户上传的原文件：能读写文件时复制进工作目录（PDF、Word 等可以直接打开或修改）
  if (modeName !== 'chat' && ctx.files && ctx.files.length) {
    const to = path.join(workdir, UPLOAD_DIR);
    fs.mkdirSync(to, { recursive: true });
    const names = ctx.files.map((f) => { const n = safeName(f.name); fs.copyFileSync(f.path, path.join(to, n), fs.constants.COPYFILE_FICLONE); return `${UPLOAD_DIR}/${n}`; });
    prompt += `\n\n（用户上传的原文件已放进工作目录：${names.join('、')}，需要时可以直接读取或修改。）`;
  }
  // 有图片时改用 stream-json 输入，把图片和文字放在同一条消息里
  const images = ctx.images && ctx.images.length ? ctx.images : null;
  if (images) args.push('--input-format', 'stream-json');

  // 每条命令经过 shell-prefix.sh 记下进程组，结束时连后台命令一起停（记录放在工作目录：沙箱里也写得进去）
  const pgidFile = path.join(workdir, '.agent-hub-runs', `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  if (modeName !== 'chat') {
    fs.mkdirSync(path.dirname(pgidFile), { recursive: true });
    env.CLAUDE_CODE_SHELL_PREFIX = PREFIX;
    env.AGENT_HUB_PGID_FILE = pgidFile;
  }
  const child = spawn(bin, args, { cwd: workdir, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const procs = track(child.pid, { pgidFile });
  const kill = () => {
    procs.reap(); // 先停它开的命令（趁 Claude Code 还在、进程树还完整）
    if (child.exitCode !== null) return;
    child.kill('SIGTERM');
    setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 3000).unref();
  };
  signal.addEventListener('abort', kill, { once: true });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
  child.stdin.on('error', () => {}); // 进程提前退出时忽略写入错误
  child.stdin.end(images ? JSON.stringify({ type: 'user', message: { role: 'user', content: claudeContent(prompt, images) } }) + '\n' : prompt);

  let text = '', partial = false, partialThinking = false, result = null;
  const emit = (s) => { if (s) { text += s; onDelta(s); } };
  const gap = () => { if (text && !text.endsWith('\n\n')) emit(text.endsWith('\n') ? '\n' : '\n\n'); };
  const reading = (async () => {
    for await (const line of readLines(child.stdout)) {
      let j; try { j = JSON.parse(line); } catch { continue; }
      if (j.type === 'stream_event') {
        const ev = j.event || {};
        if (ev.type === 'content_block_start' && ev.content_block && ev.content_block.type === 'text') gap();
        if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') { partial = true; emit(ev.delta.text); }
        if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'thinking_delta' && ev.delta.thinking) { partialThinking = true; onThinking(ev.delta.thinking); }
      } else if (j.type === 'assistant' && j.message) {
        for (const c of j.message.content || []) {
          if (c.type === 'tool_use') { gap(); emit(`> 🔧 ${toolLabel(c, workdir)}\n\n`); onTrace({ tool: c.name, input: c.input || {}, workdir }); }
          else if (c.type === 'thinking' && c.thinking && !partialThinking) onThinking(c.thinking + '\n');
          else if (c.type === 'text' && !partial) { gap(); emit(c.text); }
        }
      } else if (j.type === 'result') result = j;
    }
  })();
  const exited = new Promise((resolve) => child.on('close', resolve));
  const failed = new Promise((_, reject) => child.on('error', reject));
  try {
    const [, code] = await Promise.race([Promise.all([reading, exited]), failed]);
    if (result && (result.usage || typeof result.total_cost_usd === 'number')) {
      const u = result.usage || {};
      onUsage({ in: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0), cache: u.cache_read_input_tokens || 0, out: u.output_tokens || 0,
        // 接第三方接口时 Claude Code 报的花费是按 Claude 价格瞎算的，不用；填了单价就按单价估
        cost: !api && typeof result.total_cost_usd === 'number' ? result.total_cost_usd : undefined });
    }
    if (signal.aborted) throw signal.reason || new Error('aborted');
    if (result && result.is_error) throw new Error('Claude Code 出错：' + (result.result || result.subtype || '未知错误'));
    if (!result && code !== 0) throw new Error(`Claude Code 异常退出（代码 ${code}）：${stderr.trim().slice(-400) || '没有错误信息'}`);
    if (!text && result && result.result) emit(result.result);
    const denied = (result && result.permission_denials) || [];
    if (denied.length) emit(`\n\n> ⚠ 有 ${denied.length} 个操作超出权限被拒绝（${mode.wide ? '被沙箱拦下' : `只能在工作目录 ${workdir.replace(os.homedir(), '~')} 里操作${mode.skills ? '，命令只能运行 agent-reach 的只读查询' : ''}`}）`);
    return text;
  } finally {
    signal.removeEventListener('abort', kill);
    kill();
  }
}

module.exports = { callClaudeCode, customApi, findClaude, prepareSkillsPlugin, DEFAULT_WORKDIR, TOOL_MODES, REACH_ALLOW, expandHome };
