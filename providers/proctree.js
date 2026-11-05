'use strict';
// 一次发言结束（说完、超时或被停止）时，把 AI 开的命令一起停掉，包括它放到后台跑的（不然会一直占着 CPU）。
// 三种找法一起用：
// ① 现在还在子进程树上的；② 发言期间每隔几秒记下的子进程（父进程先退出、变成孤儿的）；
// ③ Claude Code 每条命令的进程组（shell-prefix.sh 记下来的，nohup … & 这种马上脱离的也跑不掉）。
// 只停这次发言开始之后才启动的进程（按「进程号 + 命令」和启动时间核对），记录文件被改了也伤不到别的程序
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const POLL_MS = 3000;
const PREFIX = path.join(__dirname, 'shell-prefix.sh');

const secs = (t) => { // ps 的 etime：[[dd-]hh:]mm:ss
  const m = String(t).trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  return m ? (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + +m[3] * 60 + +m[4] : Infinity;
};
function snapshot() {
  try {
    const now = Date.now();
    return execFileSync('/bin/ps', ['-axww', '-o', 'pid=,ppid=,pgid=,etime=,command='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 5000 })
      .split('\n').map((l) => l.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/)).filter(Boolean)
      .map((m) => ({ pid: +m[1], ppid: +m[2], pgid: +m[3], started: now - secs(m[4]) * 1000, cmd: m[5] }));
  } catch { return []; }
}

function descendants(procs, rootPid) {
  const kids = new Map();
  for (const p of procs) { if (!kids.has(p.ppid)) kids.set(p.ppid, []); kids.get(p.ppid).push(p); }
  const out = [], seen = new Set(), stack = [...(kids.get(rootPid) || [])];
  while (stack.length) { const p = stack.pop(); if (seen.has(p.pid)) continue; seen.add(p.pid); out.push(p); stack.push(...(kids.get(p.pid) || [])); }
  return out;
}

// 用法：const t = track(child.pid, { pgidFile }); …结束时 t.reap()（rootPid 本身由调用方停）
function track(rootPid, { pgidFile } = {}) {
  const since = Date.now() - 2000; // ps 的启动时间只精确到秒
  const seen = new Map(); // pid → command
  const poll = () => { for (const p of descendants(snapshot(), rootPid)) seen.set(p.pid, p.cmd); };
  const timer = setInterval(poll, POLL_MS); timer.unref();
  return {
    poll,
    reap() {
      clearInterval(timer);
      const procs = snapshot();
      const now = new Map(procs.map((p) => [p.pid, p]));
      const pids = new Set(descendants(procs, rootPid).map((p) => p.pid));
      for (const [pid, cmd] of seen) if (now.get(pid) && now.get(pid).cmd === cmd) pids.add(pid);
      if (pgidFile) {
        let groups = [];
        try { groups = fs.readFileSync(pgidFile, 'utf8').split(/\s+/).map(Number).filter((n) => n > 1); fs.rmSync(pgidFile, { force: true }); } catch {}
        const g = new Set(groups);
        for (const p of procs) if (g.has(p.pgid)) pids.add(p.pid);
      }
      const self = now.get(process.pid);
      for (const pid of [...pids]) {
        const p = now.get(pid);
        if (!p || pid === rootPid || pid === process.pid || (self && p.pgid === self.pgid) || p.started < since) pids.delete(pid);
      }
      const sig = (s) => { for (const pid of pids) { try { process.kill(pid, s); } catch {} } };
      sig('SIGTERM');
      if (pids.size) setTimeout(() => sig('SIGKILL'), 3000).unref();
      return pids.size;
    },
  };
}

// 能运行命令时都附上：时限、发言结束会停掉它开的命令、大文件先抽样
const longNote = (ms) => `\n\n【时限】这次发言最多 ${Math.round(ms / 60000)} 分钟，到时间会被强制停止。发言一结束（包括超时），你开的所有命令都会被停掉，后台命令也一样，不要让后台任务在你说完之后接着跑、也不要等它的通知。`
  + '处理大文件（比如 4K 视频、整季剧集）前，先拿一小段试，估算全部要多久；太慢就降分辨率、抽样、只处理需要的部分，或者分批做。快到时间时先把已经完成的部分写进文件，在交接里写清楚做到哪了、剩下什么、怎么接着做。';

module.exports = { track, longNote, PREFIX };
