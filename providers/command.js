'use strict';
// 本机命令 / 推理脚本：每次轮到它发言就运行一次你的命令（比如 python3 ~/models/infer.py），不用写服务器。
// 提示词从标准输入（stdin）传进去，标准输出（stdout）就是回复，边输出边显示；退出码不是 0 时显示标准错误（stderr）的最后几行。
// 提示词只走 stdin、不拼进命令行，群聊里的内容不会被当成命令执行；命令本身只能在 Mac 本机上设置（见 server.js 的 LOCAL_ONLY）。
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { payloadFor } = require('./http');
const { pickReply } = require('./reply');

const expandHome = (p) => (p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
const tail = (s, n = 600) => String(s || '').trim().slice(-n);
const children = new Set(); // 正在运行的命令：Agent Hub 退出时一起结束

// 给命令用的环境：补上常见的命令目录（双击 start.command 启动时 PATH 很短）；Python 不缓冲输出、用 UTF-8
function commandEnv(extra = {}) {
  const home = os.homedir();
  const dirs = ['/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.local/bin'), path.dirname(process.execPath)];
  try { for (const v of fs.readdirSync(path.join(home, 'Library/Python'))) dirs.push(path.join(home, 'Library/Python', v, 'bin')); } catch {}
  const PATH = [...new Set([...(process.env.PATH || '').split(':'), ...dirs].filter(Boolean))].join(':');
  return { ...process.env, PATH, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', ...extra };
}

// 结束整个进程组（命令里有 cd、&& 时 sh 会再开子进程，只结束 sh 不够）
function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
  setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 3000).unref();
}
const stopCommands = () => { for (const c of children) killTree(c); children.clear(); };

async function callCommand(agent, system, prompt, { signal, onDelta, onReset, ctx }) {
  const cmd = String(agent.command || '').trim();
  if (!cmd) throw new Error('没有填写要运行的命令');
  if (process.platform === 'win32') throw new Error('「本机命令」目前只支持 Mac');
  const cwd = path.resolve(expandHome(String(agent.workdir || '').trim()) || os.homedir());
  if (!fs.existsSync(cwd)) throw new Error(`工作目录不存在：${cwd.replace(os.homedir(), '~')}`);
  const input = agent.inputFormat === 'json'
    ? JSON.stringify(payloadFor(agent, system, prompt, ctx)) + '\n'
    : (system ? `${system}\n\n` : '') + prompt;
  const env = commandEnv({
    AGENT_HUB_AGENT: agent.name || '', AGENT_HUB_PURPOSE: ctx.purpose || 'reply', AGENT_HUB_MODEL: agent.model || '',
    AGENT_HUB_MAX_TOKENS: Number(agent.maxTokens) > 0 ? String(agent.maxTokens) : '',
  });
  const child = spawn('/bin/sh', ['-c', cmd], { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(child);
  const kill = () => killTree(child);
  signal.addEventListener('abort', kill, { once: true });
  let stderr = '', text = '';
  child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
  child.stdin.on('error', () => {}); // 命令不读输入、提前退出时忽略写入错误
  child.stdin.end(input);
  const reading = (async () => {
    const dec = new TextDecoder();
    for await (const chunk of child.stdout) { const s = dec.decode(chunk, { stream: true }); if (s) { text += s; onDelta(s); } }
    const s = dec.decode(); if (s) { text += s; onDelta(s); }
  })();
  const exited = new Promise((resolve) => child.on('close', (code, sig) => resolve(code === null ? sig : code)));
  const failed = new Promise((_, reject) => child.on('error', reject));
  try {
    const [, code] = await Promise.race([Promise.all([reading, exited]), failed]);
    if (signal.aborted) throw signal.reason || new Error('aborted');
    if (code !== 0) throw new Error(`命令出错（退出码 ${code}）：${tail(stderr) || '没有错误信息'}`);
    const t = text.trim();
    if (!t) throw new Error(`命令运行完了，但没有输出任何内容${stderr.trim() ? '：' + tail(stderr) : ''}`);
    // 脚本打印的是一个 JSON（比如 {"reply": "…"}）时只取回复文字
    if (/^\{[\s\S]*\}$/.test(t)) {
      try { const r = pickReply(JSON.parse(t)); onReset(); onDelta(r); return r; } catch {}
    }
    return text;
  } finally {
    signal.removeEventListener('abort', kill);
    children.delete(child);
    kill();
  }
}

module.exports = { callCommand, commandEnv, killTree, stopCommands };
