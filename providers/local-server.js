'use strict';
// 启动命令：本机模型服务（mlx_lm.server、llama-server、自己写的程序……）没开着时，第一次用到就自动启动，
// 闲置一段时间（默认 15 分钟）或 Agent Hub 退出时自动关掉，给 8GB 内存的 Mac 省内存。
// 服务已经开着（比如你自己在终端里开的）就直接用，不会重复启动。启动命令只能在 Mac 本机上设置（见 server.js 的 LOCAL_ONLY）。
const { spawn } = require('child_process');
const os = require('os');
const { commandEnv, killTree } = require('./command');
const { sleep } = require('./util');

const START_MS = Number(process.env.LOCAL_SERVER_START_MS) || 180000;
const IDLE_MS = (Number(process.env.LOCAL_SERVER_IDLE_MIN) || 15) * 60000;
const servers = new Map(); // 启动命令 -> { child, log, exited, code, active, lastUsed }

const refused = (e) => /ECONNREFUSED|ECONNRESET|EPIPE|socket hang up/i.test(String((e && e.message) || ''));
const tail = (s, n = 600) => String(s || '').trim().slice(-n);

function launch(cmd) {
  const child = spawn('/bin/sh', ['-c', cmd], { cwd: os.homedir(), env: commandEnv(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const s = { child, log: '', exited: false, code: null, active: 0, lastUsed: Date.now() };
  const keep = (d) => { s.log = (s.log + d).slice(-4000); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  child.on('exit', (code, sig) => { s.exited = true; s.code = code === null ? sig : code; });
  child.on('error', (e) => { s.exited = true; s.code = e.code || e.message; keep(e.message); });
  servers.set(cmd, s);
  return s;
}

// 等服务能用：/health 返回 503（llama-server 还在加载模型）就接着等；连得上、返回别的都算准备好了
async function waitReady(s, url, signal) {
  const health = new URL(url).origin + '/health';
  const until = Date.now() + START_MS;
  while (Date.now() < until) {
    if (signal.aborted) throw signal.reason || new Error('aborted');
    if (s.exited) throw new Error(`启动命令已经退出（${s.code}）：${tail(s.log) || '没有输出'}`);
    try {
      const res = await fetch(health, { signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]) });
      await res.body?.cancel().catch(() => {});
      if (res.status !== 503) return;
    } catch (e) { if (signal.aborted) throw e; }
    await sleep(1000);
  }
  throw new Error(`等了 ${Math.round(START_MS / 1000)} 秒，本机模型服务还没准备好：${tail(s.log) || '启动命令没有输出'}`);
}

// 包住一次调用：连不上时先启动（或重新启动）本机模型服务，等它准备好再试一次
async function withServer(agent, call, { signal, onDelta, onReset }) {
  const cmd = String(agent.startCommand || '').trim();
  const url = String(agent.baseUrl || '').trim();
  if (!cmd || !/^https?:\/\//i.test(url) || process.platform === 'win32') return call(); // 启动命令目前只支持 Mac
  const known = servers.get(cmd);
  if (known) known.active++;
  try { return await call(); }
  catch (e) { if (signal.aborted || !refused(e)) throw e; }
  finally { if (known) { known.active--; known.lastUsed = Date.now(); } }
  let s = servers.get(cmd);
  if (!s || s.exited) s = launch(cmd);
  s.active++;
  try {
    onDelta('*（正在启动本机模型服务，第一次加载模型可能要一两分钟…）*');
    await waitReady(s, url, signal);
    onReset();
    return await call();
  } finally { s.active--; s.lastUsed = Date.now(); }
}

// 闲置太久的自动关掉
setInterval(() => {
  const now = Date.now();
  for (const [cmd, s] of servers) {
    if (s.exited) servers.delete(cmd);
    else if (s.active <= 0 && now - s.lastUsed > IDLE_MS) { killTree(s.child); servers.delete(cmd); }
  }
}, Math.max(1000, Math.min(60000, IDLE_MS / 3))).unref();

const stopServers = () => { for (const s of servers.values()) killTree(s.child); servers.clear(); };

module.exports = { withServer, stopServers };
