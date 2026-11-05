'use strict';
// 冒烟测试：在临时目录里启动一份 Agent Hub，只用演示智能体（mock，不调用任何模型），
// 检查默认设置、三种协作模式和任务清单。运行：npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const COPY = ['server.js', 'handoff.js', 'usage.js', 'package.json', 'providers', 'public'];
let dir, child, base;

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const api = async (p, opts = {}) => {
  const r = await fetch(base + p, { ...opts, headers: { 'content-type': 'application/json' }, body: opts.body && JSON.stringify(opts.body) });
  const j = await r.json();
  if (!r.ok) throw new Error(`${p} → ${r.status} ${j.error}`);
  return j;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitIdle(roomId, ms = 30000) {
  const end = Date.now() + ms;
  await sleep(300);
  while (Date.now() < end) {
    const r = await api(`/api/rooms/${roomId}`);
    if (!r.running) return r;
    await sleep(200);
  }
  throw new Error('等了太久还在运行');
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-test-'));
  for (const f of COPY) fs.cpSync(path.join(ROOT, f), path.join(dir, f), { recursive: true });
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port) };
  delete env.HOST;
  child = spawn(process.execPath, ['server.js'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 100; i++) {
    try { await fetch(base + '/api/info'); return; } catch { await sleep(100); }
    if (child.exitCode !== null) break;
  }
  throw new Error('Agent Hub 没有启动：\n' + log);
});

after(() => {
  if (child) child.kill();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test('第一次启动：默认智能体只能聊天，只监听本机', async () => {
  const agents = await api('/api/agents');
  assert.ok(agents.length >= 1);
  for (const a of agents) if (['claude-code', 'codex'].includes(a.provider)) assert.equal(a.toolMode, 'chat', a.name);
  const access = await api('/api/access');
  assert.equal(access.lan, false);
  assert.equal(access.host, '127.0.0.1');
});

test('网页能打开', async () => {
  const r = await fetch(base + '/');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /<html/i);
});

test('拒绝其他网站发来的写操作', async () => {
  const r = await fetch(base + '/api/rooms', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 403);
});

let ids;
test('添加演示智能体', async () => {
  const add = (name, persona) => api('/api/agents', { method: 'POST', body: { name, persona, provider: 'mock' } });
  ids = [];
  for (const [n, p] of [['产品经理', '擅长拆需求、排优先级'], ['工程师', '擅长写代码、估工作量'], ['设计师', '擅长界面和交互']]) ids.push((await add(n, p)).id);
  assert.equal(ids.length, 3);
});

for (const mode of ['chat', 'brainstorm', 'collab']) {
  test(`协作模式 ${mode} 能跑完`, async () => {
    const room = await api('/api/rooms', { method: 'POST', body: { name: mode, mode, memberIds: ids, leaderId: ids[0] } });
    await api(`/api/rooms/${room.id}/messages`, { method: 'POST', body: { text: '帮我规划一个记账小程序' } });
    const r = await waitIdle(room.id);
    const replies = r.messages.filter((m) => m.role === 'agent' && !m.error);
    assert.ok(replies.length >= 3, `${mode} 只有 ${replies.length} 条回复`);
    if (mode === 'collab') {
      assert.ok(r.board, '分工协作应该生成任务清单');
      assert.equal(r.board.status, 'done');
      assert.ok(r.board.tasks.every((t) => t.status === 'done'));
    }
  });
}
