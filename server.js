#!/usr/bin/env node
'use strict';
// Agent Hub —— 本地多智能体协作台（Node 20+；Claude 智能体需要先 npm install）
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const ROOT = __dirname;
loadDotEnv(path.join(ROOT, '.env'));
const { callLLM, missingKey } = require('./providers');
const { submitRelay, MAILBOX_ROOT } = require('./providers/relay');
const { DEFAULT_WORKDIR } = require('./providers/claude-code');
const { discover } = require('./providers/discover');
const { stopServers } = require('./providers/local-server');
const { stopCommands } = require('./providers/command');
const { parseTemplate } = require('./providers/template');
const attachments = require('./providers/attachments');
const usage = require('./usage');
const handoff = require('./handoff');

const PORT = Number(process.env.PORT) || 8787;
// 默认只监听本机。要用手机访问，在 .env 里写 HOST=0.0.0.0（所有网卡）；不是本机的访问都要先用访问码登录
const HOST = process.env.HOST === undefined || process.env.HOST === '127.0.0.1' ? '127.0.0.1' : process.env.HOST === '0.0.0.0' || process.env.HOST === 'all' ? '' : process.env.HOST;
const DATA = path.join(ROOT, 'data');
const ACCESS_FILE = path.join(DATA, 'access.json');
const AGENTS_FILE = path.join(DATA, 'agents.json');
const ROOMS_DIR = path.join(DATA, 'rooms');
const PUBLIC = path.join(ROOT, 'public');
const HISTORY_CHAR_BUDGET = Number(process.env.HISTORY_CHARS) || 24000;
const MODES = ['chat', 'brainstorm', 'collab'];
const PROVIDERS = ['openai', 'anthropic', 'claude-code', 'codex', 'relay', 'rest', 'command', 'http', 'mock'];
const TOOL_MODES = ['chat', 'read', 'edit', 'skills', 'wide']; // 权限从小到大
const CODEX_MODES = ['chat', 'read', 'edit', 'wide'];
const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];
// 小模型 / 专精模型适配（见 buildRequest）；每项第一个是默认值，默认值不写进 agents.json
const CHOICES = {
  contextMode: ['full', 'latest', 'raw'],    // 发给它的内容：群聊记录 / 只发最新一条 / 原样转发
  systemMode: ['system', 'merge', 'none'],   // 系统提示词：正常发 / 合并进用户消息 / 不发
  messageFormat: ['single', 'multi'],        // 聊天记录放一条消息 / 拆成多轮对话
  inputFormat: ['text', 'json'],             // 本机命令的标准输入：纯文本 / JSON
  thinking: ['hide', 'keep'],                // <think> 思考过程：隐藏 / 保留
};

// ---------- 工具 ----------
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const uid = () => crypto.randomBytes(6).toString('hex');
const short = (s, n = 30) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
function writeJsonAtomic(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, file); return; }
    catch (e) { // Windows 上杀毒软件偶尔正占着文件，等一下再试
      if (i >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

// ---------- 智能体（可直接手动编辑 data/agents.json）----------
const seedAgents = () => [
  { name: 'Claude Code', avatar: '💻', color: '#0f766e', provider: 'claude-code', toolMode: 'chat' },
  { name: 'Codex', avatar: '🧠', color: '#10a37f', provider: 'codex', model: 'gpt-6.1-sol', effort: 'low', toolMode: 'chat' },
  { name: 'DeepSeek', avatar: '🐋', color: '#4d6bfe', provider: 'openai', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' },
].map((a) => ({ id: uid(), apiKey: '', temperature: null, effort: '', ...a }));

function loadAgents() {
  if (!fs.existsSync(AGENTS_FILE)) writeJsonAtomic(AGENTS_FILE, seedAgents());
  let list;
  try { list = JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8')); }
  catch (e) { throw new Error('data/agents.json 格式错误：' + e.message); }
  if (!Array.isArray(list)) throw new Error('data/agents.json 应该是一个数组 [...]');
  // 手动添加时可以不写 id / provider，这里自动补上
  let changed = false;
  for (const a of list) {
    if (!a.id) { a.id = uid(); changed = true; }
    if (!a.provider) { a.provider = 'openai'; changed = true; }
  }
  if (changed) writeJsonAtomic(AGENTS_FILE, list);
  return list;
}
const saveAgents = (list) => writeJsonAtomic(AGENTS_FILE, list);
function publicAgent(a) {
  const { apiKey, ...rest } = a; // 不把 Key 发给浏览器
  const isEnv = typeof apiKey === 'string' && apiKey.startsWith('env:');
  const b = usage.budget(a);
  return { ...rest, hasKey: !!apiKey, apiKeyEnv: isEnv ? apiKey : '', missingKey: missingKey(a),
    usage: { cost: b.spent.cost, tokens: usage.tokensOf(b.spent), calls: b.spent.calls, ratio: b.ratio, over: b.over, limited: b.limited, text: usage.budgetText(a, b) } };
}
const TEXT_FIELDS = ['headers', 'bodyTemplate', 'responsePath', 'command', 'startCommand', 'stop', 'extraBody', 'writeDirs'];
// 预算和单价（美元；单价是每百万 token），留空 = 不限 / 不估算
const MONEY_FIELDS = ['budgetUsd', 'budgetTokens', 'priceIn', 'priceOut'];
const AGENT_FIELDS = ['name', 'avatar', 'color', 'persona', 'provider', 'baseUrl', 'model', 'temperature', 'maxTokens', 'effort', 'toolMode', 'workdir', 'mailbox', 'fallbackModels', 'writeDirs',
  'historyChars', 'onlyWhenMentioned', ...MONEY_FIELDS, ...TEXT_FIELDS, ...Object.keys(CHOICES)];
// 能在 Mac 上运行命令、读写任意文件夹的设置：只能在 Mac 本机上改，手机登录了也不行
const LOCAL_ONLY = { command: '要运行的命令', startCommand: '启动命令', workdir: '工作目录', writeDirs: '可写文件夹' };
function applyAgentFields(target, body, local = true) {
  if (!local) {
    for (const [f, label] of Object.entries(LOCAL_ONLY)) {
      if (f in body && String(body[f] ?? '').trim() !== String(target[f] ?? '').trim()) throw new Error(`「${label}」只能在 Mac 上修改`);
    }
    // 「可用 Skill」「宽权限」能在 Mac 上运行命令：只能在 Mac 上打开或调高（手机上可以调低）
    const claudeNow = target.provider === 'claude-code' ? TOOL_MODES.indexOf(target.toolMode) : 0;
    if ((body.provider ?? target.provider) === 'claude-code' && TOOL_MODES.indexOf(body.toolMode) >= 3 && TOOL_MODES.indexOf(body.toolMode) > claudeNow) throw new Error('这一档权限只能在 Mac 上打开');
    // Codex 的「只读」「可改文件」能运行命令：只能在 Mac 上打开或调高（手机上可以调低）
    const now = target.provider === 'codex' ? CODEX_MODES.indexOf(target.toolMode) : 0;
    if ((body.provider ?? target.provider) === 'codex' && CODEX_MODES.indexOf(body.toolMode) > Math.max(now, 0)) throw new Error('Codex 能运行命令的权限只能在 Mac 上打开');
  }
  for (const f of AGENT_FIELDS) if (f in body) target[f] = body[f];
  const t = target.temperature;
  target.temperature = t === '' || t === null || t === undefined || isNaN(Number(t)) ? null : Number(t);
  if (!PROVIDERS.includes(target.provider)) target.provider = 'openai';
  if (!EFFORTS.includes(target.effort)) target.effort = '';
  if (target.provider === 'claude-code' && !TOOL_MODES.includes(target.toolMode)) target.toolMode = 'chat';
  if (target.provider === 'codex' && !CODEX_MODES.includes(target.toolMode)) target.toolMode = 'chat';
  if (target.provider === 'relay') { // 信箱名只用英文、数字、- 和 _
    target.mailbox = String(target.mailbox || target.name || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || target.id;
  }
  // 小模型 / 专精模型适配：空的、默认的不写进 agents.json，JSON 写错了保存时就提示
  for (const f of ['historyChars', 'maxTokens']) {
    if (!(f in target)) continue;
    const n = Math.round(Number(target[f]));
    if (n > 0) target[f] = f === 'historyChars' ? Math.max(500, Math.min(200000, n)) : n; else delete target[f];
  }
  for (const f of MONEY_FIELDS) {
    if (!(f in target)) continue;
    const n = Number(target[f]);
    if (n > 0 && Number.isFinite(n)) target[f] = f === 'budgetTokens' ? Math.round(n) : Math.round(n * 10000) / 10000; else delete target[f];
  }
  for (const [f, list] of Object.entries(CHOICES)) if (!list.includes(target[f]) || target[f] === list[0]) delete target[f];
  for (const f of TEXT_FIELDS) {
    if (typeof target[f] === 'string') target[f] = target[f].trim();
    if (!target[f]) delete target[f];
  }
  for (const [f, label] of [['headers', '请求头'], ['bodyTemplate', '请求体模板'], ['extraBody', '额外参数']]) {
    const v = target[f] ? parseTemplate(target[f], label) : null;
    if (v && f !== 'bodyTemplate' && (typeof v !== 'object' || Array.isArray(v))) throw new Error(`${label}要写成 JSON 对象，比如 {"top_p": 0.9}`);
  }
  if (target.onlyWhenMentioned === true || target.onlyWhenMentioned === 'true' || target.onlyWhenMentioned === 'on') target.onlyWhenMentioned = true;
  else delete target.onlyWhenMentioned;
  // apiKey 留空 = 不修改；填 "-" = 清除
  if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
    const k = body.apiKey.trim();
    target.apiKey = k === '-' ? '' : k;
  }
  target.name = String(target.name || '').trim() || '未命名智能体';
}

// ---------- 房间 ----------
const rooms = new Map();
function loadRooms() {
  fs.mkdirSync(ROOMS_DIR, { recursive: true });
  for (const f of fs.readdirSync(ROOMS_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const r = JSON.parse(fs.readFileSync(path.join(ROOMS_DIR, f), 'utf8'));
      for (const m of r.messages) { if (m.relay) { delete m.relay; m.error = m.error || '服务重启，这次转达已取消'; } delete m.live; }
      if (r.board && r.board.status === 'running') { // 服务重启时正在执行的任务清单：停在原地，可以点「继续」
        r.board.status = 'stopped';
        for (const t of r.board.tasks) if (t.status === 'doing') t.status = 'todo';
      }
      rooms.set(r.id, r);
    } catch (e) { console.warn('跳过损坏的房间文件', f, e.message); }
  }
  if (rooms.size === 0) createRoom({ name: '默认房间' });
}
// 房间删除后，还在收尾的任务不应把文件写回来
function saveRoom(room) {
  if (rooms.has(room.id)) writeJsonAtomic(path.join(ROOMS_DIR, room.id + '.json'), room);
}
function applyRoomFields(room, body) {
  if (typeof body.name === 'string') room.name = body.name.trim().slice(0, 60) || '未命名房间';
  if (MODES.includes(body.mode)) room.mode = body.mode;
  if (Array.isArray(body.memberIds)) room.memberIds = [...new Set(body.memberIds.map(String))];
  if ('leaderId' in body) room.leaderId = body.leaderId ? String(body.leaderId) : null;
  if ('rounds' in body) room.rounds = Math.max(1, Math.min(5, Math.round(Number(body.rounds)) || 1));
  if ('confirmPlan' in body) room.confirmPlan = !!body.confirmPlan;
}
function createRoom(body = {}) {
  const agents = loadAgents();
  const room = {
    id: uid(), name: '新房间', mode: 'chat', memberIds: agents.map((a) => a.id),
    leaderId: agents[0] ? agents[0].id : null, rounds: 1, messages: [], createdAt: Date.now(),
  };
  applyRoomFields(room, body);
  rooms.set(room.id, room); saveRoom(room); return room;
}
function getMembers(room) {
  const agents = loadAgents();
  return room.memberIds.map((id) => agents.find((a) => a.id === id)).filter(Boolean);
}
loadRooms();
// 上传的文件：data/uploads/<房间 id>/
const uploadsDir = (roomId) => path.join(DATA, 'uploads', roomId);
const roomView = (r) => ({ ...r, running: running.has(r.id) });
const roomSummary = (r) => ({ id: r.id, name: r.name, mode: r.mode, count: r.messages.length, running: running.has(r.id), createdAt: r.createdAt });

// ---------- 实时推送（SSE）----------
const clients = new Map(); // roomId -> Set<res>
const running = new Map(); // roomId -> { ac: AbortController, interjected: boolean }
function broadcast(roomId, event, data) {
  const set = clients.get(roomId); if (!set) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) res.write(payload);
}
setInterval(() => { for (const set of clients.values()) for (const res of set) res.write(': ping\n\n'); }, 20000).unref();

// ---------- 提示词 ----------
const speakerName = (m) => (m.role === 'user' ? '用户' : m.role === 'system' ? '系统' : m.name);
function buildSystem(agent, members) {
  const others = members.filter((m) => m.id !== agent.id).map((m) => `${m.name}（${short(m.persona, 24)}）`).join('；') || '无';
  return [
    `你是「${agent.name}」，正在一个多智能体协作群聊里，和其他 AI 成员及一位人类用户一起讨论、出主意、分工完成任务。`,
    agent.persona ? `你的角色设定：${agent.persona}` : '',
    `其他成员：${others}。`,
    `规则：只以「${agent.name}」的身份发言，不替别人说话，开头不要写自己的名字；言之有物，不重复别人说过的内容；需要时可以 @名字 点名其他成员；默认使用用户使用的语言。`,
  ].filter(Boolean).join('\n');
}
const clip = (s, n) => (s.length > n ? `${s.slice(0, Math.max(0, n))}…（后面还有 ${s.length - n} 字，省略了）` : s);
// 从最近的消息往前取，超出长度预算就省略更早的；本轮用户的需求、最近一次发的文件（pinned，可以是一个或几个）始终保留。
// strict（智能体自己设了长度上限，一般是上下文小的本机模型）：单条太长的消息也截短，并给 pinned 预留位置，总长不超过上限
function pickRecent(messages, pinned, budget, strict) {
  const pins = [].concat(pinned || []).filter(Boolean);
  const take = (limit) => {
    const picked = []; let used = 0, cut = false;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (!m.content) continue;
      const len = m.content.length + 10;
      if (used + len > limit && (picked.length || strict)) {
        if (!picked.length) picked.push({ ...m, content: clip(m.content, limit - 10) });
        cut = true; break;
      }
      picked.unshift(m); used += len;
    }
    return { picked, cut };
  };
  let r = take(budget);
  const missing = pins.filter((p) => !r.picked.some((m) => m.id === p.id)).sort((a, b) => a.ts - b.ts);
  if (r.cut && missing.length) {
    if (!strict) { r.picked.unshift(...missing); return r; }
    const ps = missing.map((p) => ({ ...p, content: clip(p.content, Math.floor(budget / 2 / missing.length)) }));
    r = take(budget - ps.reduce((n, p) => n + p.content.length + 10, 0));
    r.picked.unshift(...ps.filter((p) => !r.picked.some((m) => m.id === p.id)));
  }
  return r;
}
function transcript(messages, pinned, budget = HISTORY_CHAR_BUDGET, strict = false) {
  const { picked, cut } = pickRecent(messages, pinned, budget, strict);
  const lines = picked.map((m) => `【${speakerName(m)}】${m.content}`);
  if (cut) lines.unshift('（更早的消息已省略）');
  return lines.join('\n\n');
}
const buildPrompt = (history, instruction, pinned, budget, strict) => `以下是目前的群聊记录：\n\n${transcript(history, pinned, budget, strict) || '（暂无）'}\n\n---\n${instruction}`;

// 拆成多轮对话：它自己说过的话作为 assistant，其他人（用户、别的智能体）的话作为 user 并写上名字；连续同一方的合并成一条
function chatTurns(agent, history, instruction, pinned, budget, strict) {
  const { picked, cut } = pickRecent(history, pinned, budget, strict);
  const turns = [];
  const add = (role, content) => {
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.content += '\n\n' + content; else turns.push({ role, content });
  };
  if (cut) add('user', '（更早的消息已省略）');
  for (const m of picked) {
    if (m.role === 'agent' && m.agentId === agent.id) add('assistant', m.content);
    else add('user', `【${speakerName(m)}】${m.content}`);
  }
  add('user', instruction);
  if (turns[0].role !== 'user') turns.unshift({ role: 'user', content: '（群聊开始）' }); // 有的模型要求第一条是 user
  return turns;
}
// 系统提示词怎么发：正常发 / 合并进第一条用户消息（有的模型不支持 system 角色）/ 不发（模型自带人设）
function shapeSystem(agent, system, prompt, turns) {
  if (agent.systemMode === 'none') system = '';
  else if (agent.systemMode === 'merge' && system) {
    prompt = `${system}\n\n${prompt}`;
    turns = [{ ...turns[0], content: `${system}\n\n${turns[0].content}` }, ...turns.slice(1)];
    system = '';
  }
  return { system, prompt, messages: system ? [{ role: 'system', content: system }, ...turns] : turns };
}
// 发给智能体的内容：system、prompt（字符串）和 messages（OpenAI 格式），按它的「小模型 / 专精模型适配」设置组织
function buildRequest(agent, members, history, instruction, pinned, task) {
  const strict = Number(agent.historyChars) > 0;
  const budget = strict ? Number(agent.historyChars) : HISTORY_CHAR_BUDGET;
  const lastUser = [...history].reverse().find((m) => m.role === 'user' && m.content);
  const latest = task || (lastUser || [].concat(pinned || [])[0] || {}).content || '';
  const fit = (s) => (strict ? clip(s, budget) : s);
  let system = buildSystem(agent, members), prompt, turns;
  if (agent.contextMode === 'raw') { // 原样转发：只发那条消息本身（分工协作时是它的子任务），适合只会做一件事的专精模型
    system = ''; prompt = fit(latest);
  } else if (agent.contextMode === 'latest') { // 只发最新一条：不带群聊记录，系统提示词只留人设
    system = `你是「${agent.name}」。${agent.persona || ''}`.trim();
    prompt = fit(task && lastUser ? `用户的需求：${lastUser.content}\n\n你负责的部分：${task}` : latest);
  } else {
    prompt = buildPrompt(history, instruction, pinned, budget, strict);
    if (agent.messageFormat === 'multi') turns = chatTurns(agent, history, instruction, pinned, budget, strict);
  }
  return { ...shapeSystem(agent, system, prompt, turns || [{ role: 'user', content: prompt }]), latest };
}

// ---------- 编排 ----------
class Aborted extends Error {}
const sysMsg = (content, runId) => ({ id: uid(), role: 'system', content, ts: Date.now(), runId });
function pushMessage(room, msg) { room.messages.push(msg); broadcast(room.id, 'message', msg); saveRoom(room); return msg; }

// 能把图片发过去的接口（模型本身看不了图时，openai.js 会自动改成只发文字）
const VISION = new Set(['openai', 'anthropic', 'claude-code', 'codex']);
const withFiles = (dir, m) => (m.attachments && m.attachments.length ? { ...m, content: [m.content, attachments.promptText(dir, m.attachments)].filter(Boolean).join('\n\n') } : m);
function addNote(req, note) {
  req.prompt += '\n\n' + note;
  const i = req.messages.map((m) => m.role).lastIndexOf('user');
  if (i >= 0) req.messages[i] = { ...req.messages[i], content: req.messages[i].content + '\n\n' + note };
}

async function speak(room, agent, instruction, { run, runId, members, topicMsg, filter, purpose, kind, task, onStart, deps = [] }) {
  const signal = run.ac.signal;
  // 预算用完了：不调用，直接记一条失败（分工协作里这个子任务会标成失败，调高预算后可以重做）
  const left = usage.budget(agent);
  if (left.over) {
    return pushMessage(room, { id: uid(), role: 'agent', agentId: agent.id, name: agent.name, content: '', ts: Date.now(), runId, kind: kind || '',
      error: `本月预算已用完（${usage.budgetText(agent, left)}），这次没有调用。点左边「${agent.name}」调高「本月预算」就能继续。` });
  }
  if (run.interjected) { // 用户在运行中插话，让下一位发言者先回应
    run.interjected = false;
    instruction = '（用户刚刚在讨论中插话了，请先回应用户的最新消息，再继续下面的要求。）\n' + instruction;
  }
  // 发过文件的消息：文件内容接在消息后面；最近一次发的文件一直带着（追问时模型还能看到），图片另外发给能看图的模型
  const dir = uploadsDir(room.id);
  const depSet = new Set(deps);
  const history = (filter ? room.messages.filter(filter) : room.messages.slice()).map((m) => handoff.enrich(withFiles(dir, m), { runId, receiver: agent, deps: depSet }));
  const fileMsg = [...history].reverse().find((m) => m.attachments && m.attachments.length);
  const depMsgs = history.filter((m) => depSet.has(m.id) && m.content); // 要等的子任务的产出：再长也不省略
  const topic = withFiles(dir, topicMsg);
  const msg = { id: uid(), role: 'agent', agentId: agent.id, name: agent.name, content: '', ts: Date.now(), runId, kind: kind || '', live: true };
  if (onStart) onStart(msg.id);
  room.messages.push(msg);
  broadcast(room.id, 'message', msg);
  const req = buildRequest(agent, members, history, instruction, [topic, fileMsg, ...depMsgs].filter(Boolean), task);
  let images = fileMsg ? attachments.visuals(dir, fileMsg.attachments) : [];
  if (images.length && !VISION.has(agent.provider)) { images = []; addNote(req, attachments.NO_VISION); }
  // 原文件只在这一轮新发的时候交给 Claude Code、Codex（复制到工作目录）
  const files = fileMsg && fileMsg.ts >= topicMsg.ts ? attachments.originals(dir, fileMsg.attachments) : [];
  let thinking = ''; const trace = handoff.tracer(); // 思考过程、用到的资料和写的文件
  let used = null; // 这次调用报回来的用量（有的接口一次调用里报好几次，加起来）
  const onUsage = (u) => {
    used = used ? { in: used.in + (u.in || 0), cache: used.cache + (u.cache || 0), out: used.out + (u.out || 0),
      cost: typeof u.cost === 'number' || typeof used.cost === 'number' ? (used.cost || 0) + (u.cost || 0) : undefined } : { in: u.in || 0, cache: u.cache || 0, out: u.out || 0, cost: u.cost };
  };
  try {
    await callLLM(agent, req.system, req.prompt, {
      signal, purpose, members, instruction, topic: topic.content, topicTs: topicMsg.ts, messageId: msg.id,
      messages: req.messages, latest: req.latest, images, files,
      onRelay: (info) => { msg.relay = { prompt: info.prompt, replyFile: info.replyFile ? info.replyFile.replace(os.homedir(), '~') : '' }; broadcast(room.id, 'update', msg); saveRoom(room); },
      room: { id: room.id, name: room.name, mode: room.mode },
      history: history.filter((m) => m.content).slice(-50).map((m) => ({ id: m.id, role: m.role, name: speakerName(m), content: m.content })),
      onDelta: (d) => { msg.content += d; broadcast(room.id, 'delta', { id: msg.id, text: d }); },
      onReset: () => { msg.content = ''; broadcast(room.id, 'update', msg); },
      onUsage,
      onThinking: (d) => { if (thinking.length < handoff.THINK_KEEP) thinking += d; },
      onTrace: (ev) => trace.on(ev),
    });
  } catch (e) {
    if (signal.aborted) msg.content += msg.content ? '\n\n*（已停止）*' : '*（已停止）*';
    else msg.error = e.message || String(e);
  } finally {
    delete msg.relay; delete msg.live;
    const rec = used && usage.record(agent, used, { roomId: room.id });
    if (rec) msg.usage = { in: rec.in, cache: rec.cache, out: rec.out, cost: rec.cost, est: rec.est };
    if (thinking.trim()) msg.thinking = thinking.trim().slice(0, handoff.THINK_KEEP);
    if (trace.value) msg.trace = trace.value;
    broadcast(room.id, 'update', msg); saveRoom(room);
  }
  const warn = usage.shouldWarn(agent);
  if (warn) pushMessage(room, sysMsg(`「${agent.name}」本月预算已经用了 ${Math.round(warn.ratio * 100)}%（${usage.budgetText(agent, warn)}），用完后会自动跳过它。`, runId));
  if (signal.aborted) throw new Aborted();
  return msg;
}

function parsePlan(text, members, leader) {
  let obj = null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fence && fence[1], text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)].filter(Boolean);
  for (const c of candidates) { try { obj = JSON.parse(c); break; } catch {} }
  const raw = obj && Array.isArray(obj.tasks) ? obj.tasks : Array.isArray(obj) ? obj : null;
  if (!raw || !raw.length) return null;
  const find = (n) => {
    n = String(n || '').replace(/^@/, '').trim();
    return members.find((m) => m.name === n) || members.find((m) => n && (m.name.includes(n) || n.includes(m.name)));
  };
  // after 用的是负责人写的编号（从 1 开始）；没写 after 的子任务默认等上一步（和原来一样按顺序）
  const kept = raw.map((t, i) => ({ t, n: i + 1 })).filter((x) => x.t && x.t.task).slice(0, 12);
  const pos = new Map(kept.map((x, i) => [x.n, i]));
  return kept.map(({ t }, i) => {
    let after;
    if (Array.isArray(t.after)) after = [...new Set(t.after.map((n) => pos.get(Number(n))).filter((j) => j !== undefined && j < i))];
    else after = i ? [i - 1] : [];
    return { agent: find(t.assignee) || leader, task: String(t.task), why: t.why ? short(String(t.why), 60) : '', after, soft: !Array.isArray(t.after) };
  });
}

// 每个成员能做什么：分工时告诉负责人，让它把活分给擅长、也有能力做的人
const ABILITY = {
  'claude-code': { chat: '只能聊天', read: '能读工作目录里的文件', edit: '能在工作目录里新建、修改文件', skills: '能联网查资料、用 skill、改工作目录里的文件', wide: '能联网、运行命令、改文件' },
  codex: { chat: '只能聊天', read: '能运行命令查看文件，不能联网', edit: '能运行命令、改工作目录里的文件，不能联网', wide: '能联网、运行命令、改文件' },
};
function abilityOf(a) {
  if (ABILITY[a.provider]) return ABILITY[a.provider][a.toolMode] || ABILITY[a.provider].chat;
  if (a.provider === 'relay') return '要人手动转达，比较慢';
  if (a.provider === 'command' || a.provider === 'http' || a.provider === 'rest') return '专门的模型或程序，看角色设定';
  return '只能聊天（不能联网、不能改文件、不能运行命令）';
}
const rosterText = (members) => members.map((m) => `- ${m.name}：${m.persona ? short(m.persona, 80) : '（没写角色设定）'}；${abilityOf(m)}`).join('\n');

// 一次运行：登记「运行中」、处理停止和出错；正在执行的任务清单被打断时停在原地
async function withRun(room, body) {
  const run = { ac: new AbortController(), interjected: false };
  running.set(room.id, run);
  broadcast(room.id, 'status', { running: true });
  try { await body(run); }
  catch (e) {
    if (e instanceof Aborted) pushMessage(room, sysMsg('已停止', run.runId));
    else { console.error(e); pushMessage(room, sysMsg('运行出错：' + e.message, run.runId)); }
  } finally {
    const b = room.board;
    if (b && b.status === 'running') {
      b.status = 'stopped';
      for (const t of b.tasks) if (t.status === 'doing') t.status = 'todo';
      boardChanged(room);
    }
    running.delete(room.id);
    broadcast(room.id, 'status', { running: false });
  }
}

// 这次能发言的成员：官方接口还没填 Key 的、本月预算用完的先跳过
function activeMembers(room, runId) {
  const everyone = getMembers(room);
  if (!everyone.length) { pushMessage(room, sysMsg('这个房间还没有成员，点右上角「成员」添加智能体。', runId)); return null; }
  const noKey = everyone.filter(missingKey);
  const broke = everyone.filter((m) => !noKey.includes(m) && usage.budget(m).over);
  const members = everyone.filter((m) => !noKey.includes(m) && !broke.includes(m));
  if (noKey.length) pushMessage(room, sysMsg(`还没填 API Key，这次先跳过：${noKey.map((m) => m.name).join('、')}。点左边它们的名字，粘贴 Key、测试连接后保存就能用。`, runId));
  if (broke.length) pushMessage(room, sysMsg(`本月预算已用完，这次先跳过：${broke.map((m) => `${m.name}（${usage.budgetText(m)}）`).join('、')}。点左边它们的名字可以调高预算。`, runId));
  return members.length ? { members, skipped: [...noKey, ...broke] } : null;
}

// ---------- 任务清单（借鉴 Paperclip 的 tickets）----------
// 分工协作时负责人拆出的子任务存在 room.board：每个有负责人和状态（todo 待做 / doing 进行中 / done 完成 / failed 失败）。
// 可以先让用户确认分工再开工（房间设置「先给我确认分工」）；停止、出错、重启后能从没做完的地方继续，单个子任务也能重做。
const MAX_TASKS = 12;
function boardChanged(room) { broadcast(room.id, 'board', room.board || null); saveRoom(room); }
// 老清单没有 after：按原来的规矩，每个子任务等上一个
const depsOf = (b, i) => (Array.isArray(b.tasks[i].after) ? b.tasks[i].after : i ? [b.tasks[i - 1].id] : []).filter((id) => b.tasks.some((t) => t.id === id));
const taskList = (room, tasks) => {
  const b = { tasks };
  return tasks.map((t, i) => {
    const a = loadAgents().find((x) => x.id === t.agentId);
    const deps = depsOf(b, i).map((id) => tasks.findIndex((x) => x.id === id) + 1);
    return `${i + 1}. **${a ? a.name : '（已删除的成员）'}**：${t.task}${deps.length ? `（等第 ${deps.join('、')} 步）` : i ? '（马上开始）' : ''}`;
  }).join('\n');
};

async function runTasks(room, ctx, leader) {
  const b = room.board;
  b.status = 'running'; delete b.summaryStatus;
  for (const t of b.tasks) if (t.status !== 'done') { t.status = 'todo'; delete t.error; }
  boardChanged(room);
  const n = b.tasks.length;
  const idx = new Map(b.tasks.map((t, i) => [t.id, i]));
  const done = (id) => b.tasks[idx.get(id)].status === 'done';
  const tried = new Set(), busy = new Set(), live = new Map(), inflight = new Set(); // 正在做的：子任务 id → Promise；正在写的消息
  let aborted = false;
  const start = (t, i, agent) => {
    tried.add(t.id); busy.add(agent.id);
    t.status = 'doing'; delete t.error; boardChanged(room);
    const deps = depsOf(b, i).map((id) => idx.get(id) + 1);
    const ins = `【子任务 ${i + 1}/${n}】你被分配的任务：${t.task}\n请直接完成并给出具体产出（不要只写计划）${deps.length ? `。第 ${deps.join('、')} 个子任务的成果（连同它们的交接${handoff.onClaude(agent) ? '' : '、思考过程节选'}、查过的资料、写出的文件）都在上面，在它们的基础上做` : ''}。` + handoff.ASK;
    const depIds = depsOf(b, i).map((id) => b.tasks[idx.get(id)].msgId).filter(Boolean);
    // 同时在做的别人的子任务还没写完，不放进它的聊天记录
    const p = speak(room, agent, ins, { ...ctx, kind: 'task', task: t.task, deps: depIds, filter: (m) => !inflight.has(m.id), onStart: (mid) => { t.msgId = mid; inflight.add(mid); } })
      .then((m) => { t.msgId = m.id; if (m.error) { t.status = 'failed'; t.error = short(m.error, 120); } else t.status = 'done'; })
      .catch((e) => { t.status = 'todo'; if (e instanceof Aborted) aborted = true; else { t.status = 'failed'; t.error = short(e.message, 120); } })
      .finally(() => { inflight.delete(t.msgId); busy.delete(agent.id); live.delete(t.id); boardChanged(room); });
    live.set(t.id, p);
  };
  for (;;) {
    if (!aborted) {
      for (const [i, t] of b.tasks.entries()) {
        if (t.status === 'done' || tried.has(t.id) || live.has(t.id)) continue;
        const deps = depsOf(b, i);
        const soft = t.soft || !Array.isArray(t.after); // 负责人没写依赖、只是按顺序排的：前面失败了也接着做
        if (!deps.every((d) => done(d) || (soft && tried.has(d) && !live.has(d) && b.tasks[idx.get(d)].status === 'failed'))) continue;
        const agent = ctx.members.find((m) => m.id === t.agentId);
        if (!agent) { tried.add(t.id); t.status = 'failed'; t.error = '负责的成员这次不能发言（不在房间里、没填 Key 或预算用完）：换一个人再继续'; boardChanged(room); continue; }
        if (busy.has(agent.id)) continue; // 同一个成员一次只做一个，做完再接下一个
        start(t, i, agent);
      }
    }
    if (!live.size) break;
    await Promise.race(live.values());
  }
  if (aborted || ctx.run.ac.signal.aborted) throw new Aborted();
  // 因为要等的子任务失败了，没能开始的
  for (const t of b.tasks) if (t.status === 'todo' && !tried.has(t.id)) t.error = '它要等的子任务没完成，没法开始';
  boardChanged(room);
  const failed = b.tasks.map((t, i) => (t.status !== 'done' ? i + 1 : 0)).filter(Boolean);
  const note = failed.length ? `\n注意：第 ${failed.join('、')} 个子任务没有完成，整合时说明缺了什么，能补的就补上。` : '';
  b.summaryStatus = 'doing'; boardChanged(room);
  const sum = await speak(room, leader, '【整合】子任务已经做完。请整合各成员的成果（看它们的交接：没把握的地方要核实或注明），输出最终交付物；发现缺漏或冲突时指出并补全。' + note,
    { ...ctx, kind: 'summary', deps: b.tasks.map((t) => t.msgId).filter(Boolean) });
  b.summaryId = sum.id; b.summaryStatus = sum.error ? 'failed' : 'done';
  b.status = 'done'; boardChanged(room);
  if (failed.length) pushMessage(room, sysMsg(`有 ${failed.length} 个子任务没完成：在上方「任务清单」里点「重做失败的」，只重做这几个再重新整合。`, ctx.runId));
}

async function runRoom(room, userMsg) {
  const runId = userMsg.runId;
  await withRun(room, async (run) => {
    run.runId = runId;
    const act = activeMembers(room, runId);
    if (!act) return;
    const { members, skipped } = act;
    const ctx = { run, runId, members, topicMsg: userMsg };
    const leader = members.find((m) => m.id === room.leaderId) || members[0];
    const rounds = Math.max(1, Math.min(5, Number(room.rounds) || 1));

    // 设置了「只在被 @ 时发言」的成员（专精模型）：消息里点了它的名字才发言
    const called = (m) => !m.onlyWhenMentioned || userMsg.content.includes('@' + m.name);
    const onlyMentioned = () => pushMessage(room, sysMsg('这些成员都设置了「只在被 @ 时发言」：用 @名字 点名谁来回答。', runId));

    if (room.mode === 'brainstorm') {
      const crowd = members.filter(called);
      if (!crowd.length) { onlyMentioned(); return; }
      // 第 1 轮互相看不到本轮其他人的点子，避免跟风
      const independent = (m) => m.runId !== runId || m.role === 'user';
      for (const a of crowd) await speak(room, a, '【头脑风暴·第 1 轮】请独立提出 3 个左右有创意、具体可落地的点子，每个点子用一两句话说明理由。', { ...ctx, filter: independent });
      for (let r = 2; r <= rounds; r++) {
        for (const a of crowd) await speak(room, a, `【头脑风暴·第 ${r} 轮】阅读大家的点子，挑出你认为最好的 1–2 个，说明如何改进或组合，并指出明显风险。不要重复已有内容。`, ctx);
      }
      await speak(room, leader, '【总结】你是本次主持人。请汇总所有点子：去重归类，给出推荐的前 3 个方案，每个写明理由和下一步行动。', { ...ctx, kind: 'summary' });

    } else if (room.mode === 'collab') {
      const plan = await speak(room, leader,
        `【分工】你是本次任务的负责人。请把用户的任务拆成若干子任务，按每个成员擅长什么、能做什么分配（也可以分给你自己）：\n${rosterText(members)}\n`
        + '需要联网查资料、改文件、运行命令的活，只能交给有这些能力的成员；只能聊天的成员适合写作、分析、出主意、检查。\n'
        + `先用一两句话说明思路，然后输出一个 JSON 代码块，格式如下：\n\`\`\`json\n{"tasks":[{"assignee":"成员名字","task":"具体的子任务描述","why":"为什么交给他（10 个字左右）","after":[]}]}\n\`\`\`\n`
        + `after 写这个子任务要等哪几个子任务做完（填编号，第一个是 1）；不用等的写 []，互相不依赖的子任务会同时开工。子任务总数不超过 ${Math.min(8, members.length * 2)} 个。`,
        { ...ctx, purpose: 'plan', kind: 'plan' });
      let tasks = plan.error ? null : parsePlan(plan.content, members, leader);
      if (!tasks) {
        tasks = members.map((m, i) => ({ agent: m, task: '从你的专长出发，完成用户任务中你最擅长的部分', after: i ? [i - 1] : [], soft: true }));
        pushMessage(room, sysMsg('没能解析负责人的分工，改为每位成员按专长各做一部分。', runId));
      }
      room.board = {
        id: uid(), runId, topicId: userMsg.id, topic: short(userMsg.content, 80), createdAt: Date.now(), status: room.confirmPlan ? 'awaiting' : 'running',
        tasks: [],
      };
      const tids = tasks.map(() => uid());
      room.board.tasks = tasks.slice(0, MAX_TASKS).map((t, i) => ({ id: tids[i], agentId: t.agent.id, task: t.task, status: 'todo', why: t.why || '', after: (t.after || (i ? [i - 1] : [])).map((j) => tids[j]), ...(t.soft ? { soft: true } : {}) }));
      pushMessage(room, sysMsg('分工：\n' + taskList(room, room.board.tasks), runId));
      if (room.confirmPlan) { // 先给用户确认（像 Paperclip 的审批关卡）：省得分错了白花额度
        boardChanged(room);
        pushMessage(room, sysMsg('分工放在上方的「任务清单」里等你确认：可以改内容、换人、删掉或新增，然后点「开始执行」。不满意也可以直接发消息，让负责人重新分工。', runId));
        return;
      }
      await runTasks(room, ctx, leader);

    } else {
      // 自由讨论：@某人 时只让被点名的成员回答
      const topic = userMsg.content;
      const mentioned = members.filter((m) => topic.includes('@' + m.name));
      const all = /@(所有人|全体|all)/i.test(topic);
      if (!mentioned.length && !all && skipped.some((m) => topic.includes('@' + m.name))) return; // 点名的成员都没填 Key 或预算用完，上面已经提示过
      const targets = mentioned.length && !all ? mentioned : all ? members : members.filter(called);
      if (!targets.length) { onlyMentioned(); return; }
      const n = mentioned.length && !all ? 1 : rounds;
      for (let r = 1; r <= n; r++) {
        for (const a of targets) {
          const ins = r === 1
            ? `现在轮到你（${a.name}）发言。请回应用户最新的消息，也可以回应其他成员的观点。`
            : `【第 ${r} 轮】请在前面讨论的基础上补充、反驳或推进，不要重复。如果没有新内容，简短表态即可。`;
          await speak(room, a, targets.length > 1 ? ins + handoff.ASK : ins, ctx);
        }
      }
    }
  });
}

// 按任务清单开始 / 继续执行（确认分工后、停止后、重做失败的子任务）
function resumeBoard(room) {
  const b = room.board;
  return withRun(room, async (run) => {
    run.runId = b.runId;
    const act = activeMembers(room, b.runId);
    if (!act) return;
    const { members } = act;
    const topicMsg = room.messages.find((m) => m.id === b.topicId) || { id: b.topicId, role: 'user', content: b.topic, ts: b.createdAt };
    const leader = members.find((m) => m.id === room.leaderId) || members[0];
    const todo = b.tasks.filter((t) => t.status !== 'done').length;
    pushMessage(room, sysMsg(`按任务清单${b.status === 'awaiting' ? '开始执行' : `继续：还有 ${todo} 个子任务要做`}\n` + taskList(room, b.tasks), b.runId));
    await runTasks(room, { run, runId: b.runId, members, topicMsg }, leader);
  });
}

// 用户在网页上改任务清单：没变的子任务保留状态和产出，改过的、新加的变成「待做」
function editBoard(room, list) {
  const b = room.board;
  if (!Array.isArray(list)) throw new Error('任务清单格式不对');
  const ids = new Set(room.memberIds);
  const tasks = list.slice(0, MAX_TASKS + 1).map((x) => ({ agentId: String(x && x.agentId || ''), task: String(x && x.task || '').trim().slice(0, 2000), id: x && x.id ? String(x.id) : '',
    after: x && Array.isArray(x.after) ? x.after.map(String) : null }));
  if (tasks.length > MAX_TASKS) throw new Error(`子任务最多 ${MAX_TASKS} 个`);
  if (!tasks.length) throw new Error('至少要留一个子任务；不想做了就点「放弃这次分工」');
  for (const t of tasks) {
    if (!t.task) throw new Error('子任务内容不能是空的');
    if (!ids.has(t.agentId)) throw new Error('有子任务分给了不在这个房间里的成员');
  }
  const next = tasks.map((t) => {
    const old = b.tasks.find((o) => o.id === t.id);
    const base = old && old.task === t.task && old.agentId === t.agentId ? old : { id: old ? old.id : uid(), agentId: t.agentId, task: t.task, status: 'todo', why: old && old.agentId === t.agentId ? old.why || '' : '' };
    return { ...base, _after: t.after, _oldAfter: old ? old.after : undefined, _soft: !!(old && (old.soft || !Array.isArray(old.after))) };
  });
  b.tasks = next.map((t, i) => {
    const earlier = new Set(next.slice(0, i).map((x) => x.id));
    const want = t._after || t._oldAfter || (i ? [next[i - 1].id] : []);
    const after = [...new Set(want)].filter((id) => earlier.has(id));
    const { _after, _oldAfter, _soft, ...rest } = t;
    delete rest.soft;
    const was = (Array.isArray(_oldAfter) ? _oldAfter : i ? [next[i - 1].id] : []).filter((id) => earlier.has(id));
    const same = JSON.stringify(after) === JSON.stringify(was);
    return _soft && same ? { ...rest, after, soft: true } : { ...rest, after };
  });
  if (b.status === 'done' && b.tasks.some((t) => t.status !== 'done')) b.status = 'stopped';
}

// ---------- HTTP ----------
function send(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 2e6) { reject(new Error('请求过大')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { if (!chunks.length) return resolve({}); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('JSON 格式错误')); } });
    req.on('error', reject);
  });
}
const LOOPBACK = ['127.0.0.1', 'localhost', '::1'].includes(HOST);
// 拒绝其他网站发来的写操作（防跨站请求伪造）
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin || req.method === 'GET' || req.method === 'HEAD') return true;
  let host;
  try { host = new URL(origin).host.toLowerCase(); } catch { return false; }
  return host === String(req.headers.host || '').toLowerCase();
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- 手机访问：本机打开 localhost 不用登录，其他设备要先用访问码登录 ----------
const COOKIE = 'agenthub_session';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉了容易看混的 I、O、0、1
const newCode = () => Array.from(crypto.randomBytes(8), (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
const normCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const fmtCode = (c) => c.replace(/^(.{4})(?=.)/, '$1-');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
function loadAccess() {
  let a = null;
  try { a = JSON.parse(fs.readFileSync(ACCESS_FILE, 'utf8')); } catch {}
  const code = normCode(a && a.code);
  if (code.length < 6) return { enabled: true, code: newCode(), sessions: [] }; // 第一次运行或文件损坏：生成新的访问码
  return { enabled: a.enabled !== false, code, sessions: Array.isArray(a.sessions) ? a.sessions.filter((s) => s && typeof s.hash === 'string') : [] };
}
const access = loadAccess(); // 登录过的设备只存凭证的哈希
const saveAccess = () => writeJsonAtomic(ACCESS_FILE, access);
saveAccess();

const LOCAL_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
// Host 也要是 localhost：别的网站把域名解析到 127.0.0.1 来访问（DNS 重绑定）时同样要登录
const isLocal = (req) => LOCAL_ADDRS.has(req.socket.remoteAddress) && /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(String(req.headers.host || ''));
function findSession(req) {
  const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([\\w-]+)`));
  if (!m) return null;
  const hash = sha256(m[1]);
  return access.sessions.find((s) => s.hash === hash) || null;
}
const sessionCookie = (token) => `${COOKIE}=${token}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`;
function deviceName(req) {
  const ua = String(req.headers['user-agent'] || '');
  return /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Macintosh/.test(ua) ? 'Mac 或 iPad' : /Windows/.test(ua) ? 'Windows' : '其他设备';
}
const failures = []; // 最近 10 分钟输错的时间：错满 10 次先锁住，防止有人一个个试
function login(code, req) {
  const now = Date.now();
  while (failures.length && now - failures[0] > 600000) failures.shift();
  if (failures.length >= 10) return { status: 429, error: '输错太多次了，请 10 分钟后再试' };
  const got = Buffer.from(normCode(code)), want = Buffer.from(access.code);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
    failures.push(now);
    return { status: 401, error: '访问码不对：请对照 Mac 上「手机访问」里显示的访问码' };
  }
  const token = crypto.randomBytes(32).toString('base64url');
  access.sessions = [...access.sessions, { hash: sha256(token), device: deviceName(req), created: now, lastSeen: now }].slice(-20);
  saveAccess();
  return { token };
}
// 关闭手机访问或换访问码后，断开手机上还连着的实时推送，让它们回到登录页
function dropRemoteStreams() {
  for (const set of clients.values()) for (const res of set) if (!res.local) res.end();
}
const OPEN_FILES = new Set(['/manifest.webmanifest', '/icon-180.png', '/icon-512.png']); // 添加到主屏幕时要用，不含隐私
// 返回 true = 已登录，继续处理；false = 这里已经回复了（登录页、401 等）
async function gate(req, res, url) {
  const isApi = url.pathname.startsWith('/api/');
  if (!access.enabled) {
    const notice = '手机访问已关闭。要用的话，在 Mac 上打开 Agent Hub，点左下角「手机访问」重新开启。';
    if (isApi) send(res, 403, { error: notice, relogin: true }); else loginPage(res, { status: 403, notice });
    return false;
  }
  if (OPEN_FILES.has(url.pathname)) return true;
  if (url.pathname === '/api/login' && req.method === 'POST') {
    const r = login((await readBody(req)).code, req);
    if (r.token) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'set-cookie': sessionCookie(r.token) });
      res.end('{"ok":true}');
    } else send(res, r.status, { error: r.error });
    return false;
  }
  const code = req.method === 'GET' && !isApi ? url.searchParams.get('code') : null; // 扫二维码打开的链接里带着访问码
  const session = findSession(req);
  if (session) {
    if (Date.now() - session.lastSeen > 3600000) { session.lastSeen = Date.now(); saveAccess(); }
    if (!code) return true;
    res.writeHead(302, { location: '/', 'cache-control': 'no-store' }); // 已经登录了：去掉网址里的访问码
    res.end();
    return false;
  }
  if (code) {
    const r = login(code, req);
    if (r.token) {
      res.writeHead(302, { 'set-cookie': sessionCookie(r.token), location: '/', 'cache-control': 'no-store' });
      res.end();
    } else loginPage(res, { status: r.status, error: r.error });
    return false;
  }
  if (isApi) send(res, 401, { error: '需要登录：在 Mac 上的「手机访问」里扫码，或输入访问码', relogin: true });
  else loginPage(res, { status: req.method === 'GET' ? 200 : 401 });
  return false;
}
function loginPage(res, { status = 200, error = '', notice = '' } = {}) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Agent Hub</title>
<link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/icon-180.png">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="Agent Hub">
<style>
:root{--bg:#f7f7f9;--panel:#fff;--text:#1d1d22;--muted:#6b6b76;--border:#e3e3ea;--accent:#5b5bd6;--danger:#d64545}
@media (prefers-color-scheme:dark){:root{--bg:#15151a;--panel:#1c1c22;--text:#e8e8ee;--muted:#9a9aa6;--border:#2c2c35;--accent:#7c7cf0}}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%;background:var(--bg);color:var(--text);font:16px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}
main{max-width:400px;margin:0 auto;padding:calc(10vh + env(safe-area-inset-top)) 20px 40px;text-align:center}
h1{font-size:22px;font-weight:600;margin:0 0 8px}
p{color:var(--muted);font-size:14px;margin:0 0 20px}
form{display:flex;flex-direction:column;gap:10px}
input{font:600 20px/1.2 ui-monospace,Menlo,monospace;letter-spacing:.12em;text-align:center;text-transform:uppercase;padding:12px;border:1px solid var(--border);border-radius:10px;background:var(--panel);color:var(--text)}
input:focus{outline:2px solid var(--accent);outline-offset:-1px}
button{font:inherit;font-weight:500;padding:12px;border:0;border-radius:10px;background:var(--accent);color:#fff}
button:disabled{opacity:.6}
.err{color:var(--danger);min-height:1.5em;margin-top:12px}
.notice{color:var(--text);background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:16px}
</style></head>
<body><main>
<h1>Agent Hub</h1>
${notice ? `<p class="notice">${escHtml(notice)}</p>` : `<p>在 Mac 上打开 Agent Hub，点左下角「手机访问」，用 iPhone 相机扫二维码；或者在下面输入那里显示的访问码。</p>
<form id="f"><input id="code" placeholder="XXXX-XXXX" autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false" maxlength="20" required><button id="go">登录</button></form>
<p class="err" id="err">${escHtml(error)}</p>
<script>
document.getElementById('f').onsubmit = async (e) => {
  e.preventDefault();
  const btn = document.getElementById('go'), err = document.getElementById('err');
  btn.disabled = true; err.textContent = '';
  try {
    const r = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: document.getElementById('code').value }) });
    const d = await r.json().catch(() => ({}));
    if (r.ok) return location.replace('/');
    err.textContent = d.error || '登录失败';
  } catch (x) { err.textContent = '连不上 Agent Hub：确认 Mac 上它还开着，手机和 Mac 连的是同一个 Wi-Fi'; }
  btn.disabled = false;
};
</script>`}
</main></body></html>`);
}

let mdnsName; // 这台 Mac 在局域网里的名字（xxx.local），IP 变了也能用
function localName() {
  if (mdnsName === undefined) {
    try { mdnsName = require('child_process').execFileSync('/usr/sbin/scutil', ['--get', 'LocalHostName'], { encoding: 'utf8', timeout: 2000 }).trim(); } catch { mdnsName = ''; }
    mdnsName = mdnsName ? mdnsName + '.local' : /\.local$/i.test(os.hostname()) ? os.hostname() : '';
  }
  return mdnsName;
}
function lanAddresses() {
  const list = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
      const tailscale = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address); // Tailscale 用 100.64.0.0/10
      if (/^(utun|ppp|ipsec|bridge|vmenet|awdl|llw)/.test(name) && !tailscale) continue; // VPN、虚拟网卡：手机连不到
      list.push({ name, address: a.address, tailscale });
    }
  }
  const rank = (a) => (a.tailscale ? 2 : a.name === 'en0' ? 0 : 1); // Wi-Fi 排第一
  return list.sort((a, b) => rank(a) - rank(b));
}
function qrSvg(text) {
  let qrcode;
  try { qrcode = require('qrcode-generator'); } catch { return ''; } // 没装依赖时只显示网址
  const qr = qrcode(0, 'M'); qr.addData(text); qr.make();
  const n = qr.getModuleCount(), q = 4; let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + q} ${r + q}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + q * 2} ${n + q * 2}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
function accessView() {
  const lan = LOOPBACK ? [] : lanAddresses();
  const urls = lan.map((a) => ({ url: `http://${a.address}:${PORT}`, note: a.tailscale ? 'Tailscale' : a.name === 'en0' ? 'Wi-Fi' : a.name }));
  if (urls.length && localName()) urls.splice(1, 0, { url: `http://${localName()}:${PORT}`, note: '局域网名字，IP 变了也能用' });
  const link = urls.length ? `${urls[0].url}/?code=${access.code}` : '';
  return {
    lan: !LOOPBACK, host: HOST, enabled: access.enabled, code: fmtCode(access.code), urls, qrSvg: link ? qrSvg(link) : '',
    devices: access.sessions.map(({ device, created, lastSeen }) => ({ device, created, lastSeen })).reverse(),
  };
}
function serveStatic(req, res, pathname) {
  const file = path.normalize(path.join(PUBLIC, pathname === '/' ? 'index.html' : decodeURIComponent(pathname)));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(buf);
  });
}

// 测试连接：按它的适配设置发一句自我介绍的请求
function testRequest(agent, q) {
  const system = agent.contextMode === 'raw' ? '' : `你是「${agent.name}」。${agent.persona || ''}`;
  return { ...shapeSystem(agent, system, q, [{ role: 'user', content: q }]), latest: q };
}

async function handleApi(req, res, parts, url) {
  const [, , resource, id, action] = parts; // ['', 'api', resource, id, action]
  const method = req.method;

  // 测试一个智能体配置（可以是还没保存的）
  if (resource === 'test-agent' && method === 'POST') {
    const body = await readBody(req);
    const saved = body.id ? loadAgents().find((a) => a.id === body.id) : null;
    const probe = { id: 'probe', provider: 'openai', apiKey: '', ...(saved || {}) };
    try { applyAgentFields(probe, body, isLocal(req)); } catch (e) { return send(res, 200, { ok: false, error: e.message }); }
    const q = '请用一句话做自我介绍。';
    const t = testRequest(probe, q);
    try {
      const onUsage = saved ? (u) => usage.record(saved, u) : undefined; // 已保存的智能体：测试连接也算进它的用量
      const text = await callLLM(probe, t.system, t.prompt, { purpose: 'test', members: [probe], topic: '', instruction: q, history: [], room: null, messages: t.messages, latest: t.latest, onUsage });
      return send(res, 200, { ok: true, text: short(text, 300) || '（返回了空内容）' });
    } catch (e) { return send(res, 200, { ok: false, error: e.message }); }
  }

  // 网页上提交手动转达的回复（skip = 跳过）
  if (resource === 'relay' && id && !action && method === 'POST') {
    const body = await readBody(req);
    if (!submitRelay(id, body.skip ? '' : body.text)) return send(res, 404, { error: '这条转达已经结束或已失效' });
    return send(res, 200, { ok: true });
  }
  // 查找本机正在运行的模型服务（带 ?url= 时只查那个地址）
  if (resource === 'local-models' && method === 'GET') return send(res, 200, await discover(url.searchParams.get('url')));
  // 用量：本月、今天按智能体汇总，最近 6 个月总数
  if (resource === 'usage' && method === 'GET') return send(res, 200, usage.report(loadAgents()));
  if (resource === 'info' && method === 'GET') {
    return send(res, 200, { root: ROOT, workspace: DEFAULT_WORKDIR, mailboxRoot: MAILBOX_ROOT, home: os.homedir(), local: isLocal(req), uploadBytes: attachments.LIMITS.fileBytes });
  }
  // 手机访问的设置（访问码、开关、已登录设备）：只能在 Mac 本机上看和改
  if (resource === 'access' && !id) {
    if (!isLocal(req)) return send(res, 403, { error: '手机访问只能在 Mac 上设置' });
    if (method === 'POST') {
      const body = await readBody(req);
      if (typeof body.enabled === 'boolean') access.enabled = body.enabled;
      if (body.reset) { access.code = newCode(); access.sessions = []; }
      saveAccess();
      if (body.reset || body.enabled === false) dropRemoteStreams();
    }
    if (method === 'GET' || method === 'POST') return send(res, 200, accessView());
  }

  if (resource === 'agents') {
    const agents = loadAgents();
    if (!id && method === 'GET') return send(res, 200, agents.map(publicAgent));
    if (!id && method === 'POST') {
      const a = { id: uid(), provider: 'openai', apiKey: '', temperature: null, effort: '' };
      applyAgentFields(a, await readBody(req), isLocal(req)); agents.push(a); saveAgents(agents);
      return send(res, 200, publicAgent(a));
    }
    const a = agents.find((x) => x.id === id);
    if (!a) return send(res, 404, { error: '智能体不存在' });
    if (!action && method === 'PUT') { applyAgentFields(a, await readBody(req), isLocal(req)); saveAgents(agents); return send(res, 200, publicAgent(a)); }
    if (!action && method === 'DELETE') { saveAgents(agents.filter((x) => x.id !== id)); return send(res, 200, { ok: true }); }
  }

  if (resource === 'rooms') {
    if (!id && method === 'GET') return send(res, 200, [...rooms.values()].sort((a, b) => a.createdAt - b.createdAt).map(roomSummary));
    if (!id && method === 'POST') return send(res, 200, roomView(createRoom(await readBody(req))));
    const room = rooms.get(id);
    if (!room) return send(res, 404, { error: '房间不存在' });

    if (action === 'stream' && method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(`event: status\ndata: ${JSON.stringify({ running: running.has(id) })}\n\n`);
      res.local = isLocal(req);
      if (!clients.has(id)) clients.set(id, new Set());
      clients.get(id).add(res);
      req.on('close', () => { const set = clients.get(id); if (set) set.delete(res); });
      return;
    }
    // 上传文件（先传文件，发消息时再带上它的 id）
    if (action === 'files' && method === 'POST') {
      const { fileBytes: limit, keepFree } = attachments.LIMITS;
      const tooBig = `文件太大了（最多 ${limit >= 1024 ** 3 ? Math.round(limit / 1024 ** 3) + 'GB' : Math.round(limit / 1048576) + 'MB'}）`;
      const len = Number(req.headers['content-length']) || 0;
      if (len > limit) return send(res, 413, { error: tooBig });
      const free = attachments.diskFree(DATA);
      if (free - len < keepFree) return send(res, 507, { error: `Mac 硬盘快满了（还剩 ${(free / 1024 ** 3).toFixed(1)}GB），为了不把电脑塞满，这个文件先不收` });
      let got;
      try { got = await attachments.receive(req, uploadsDir(id), limit); } catch (e) { return send(res, e.status || 400, { error: e.status === 413 ? tooBig : e.message }); }
      if (!got.size) { fs.rmSync(got.path, { force: true }); return send(res, 400, { error: '文件是空的' }); }
      return send(res, 200, attachments.pub(await attachments.save(uploadsDir(id), url.searchParams.get('name') || '文件', got)));
    }
    // 看 / 下载上传的文件：图片直接显示，其他文件一律下载（不在网页里打开，防止里面有脚本）
    if (action === 'files' && method === 'GET' && parts[5]) {
      const f = attachments.servable(uploadsDir(id), parts[5], url.searchParams.has('preview'));
      if (!f) return send(res, 404, { error: '文件不存在' });
      const total = fs.statSync(f.file).size;
      const headers = {
        'content-type': f.mime, 'cache-control': 'private, max-age=86400', 'accept-ranges': 'bytes',
        'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox",
        'content-disposition': `${f.inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
      };
      const m = String(req.headers.range || '').match(/^bytes=(\d*)-(\d*)$/);
      if (m && (m[1] || m[2])) {
        let start = m[1] ? Number(m[1]) : Math.max(0, total - Number(m[2])), end = m[1] && m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
        if (start > end || start >= total) { res.writeHead(416, { 'content-range': `bytes */${total}` }); return res.end(); }
        res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${total}`, 'content-length': end - start + 1 });
        return fs.createReadStream(f.file, { start, end }).pipe(res);
      }
      res.writeHead(200, { ...headers, 'content-length': total });
      return fs.createReadStream(f.file).pipe(res);
    }
    if (action === 'messages' && method === 'POST') {
      const body = await readBody(req);
      const text = String(body.text || '').trim();
      const ids = Array.isArray(body.attachments) ? [...new Set(body.attachments.map(String))] : [];
      if (ids.length > attachments.LIMITS.perMessage) return send(res, 400, { error: `一条消息最多带 ${attachments.LIMITS.perMessage} 个文件` });
      const files = ids.map((fid) => attachments.load(uploadsDir(id), fid));
      if (files.some((f) => !f)) return send(res, 400, { error: '文件不见了，请重新上传' });
      if (!text && !files.length) return send(res, 400, { error: '消息为空' });
      const run = running.get(id);
      const msg = { id: uid(), role: 'user', content: text, ts: Date.now(), runId: run ? null : uid() };
      if (files.length) msg.attachments = files.map(attachments.pub);
      pushMessage(room, msg);
      // 运行中插话：不另起一轮，下一位发言的成员会先回应
      if (run) run.interjected = true; else runRoom(room, msg);
      return send(res, 200, { ok: true, interjected: !!run });
    }
    // 任务清单：改（PUT）、开始 / 继续 / 重做（POST …/board/run，redo = 要重做的子任务 id）、放弃（DELETE）
    if (action === 'board') {
      const b = room.board;
      if (!b) return send(res, 404, { error: '这个房间现在没有任务清单' });
      if (running.has(id)) return send(res, 409, { error: '正在运行，请先停止' });
      if (method === 'PUT' && !parts[5]) {
        try { editBoard(room, (await readBody(req)).tasks); } catch (e) { return send(res, 400, { error: e.message }); }
        boardChanged(room); return send(res, 200, b);
      }
      if (method === 'POST' && parts[5] === 'run') {
        const body = await readBody(req);
        const redo = [].concat(body.redo || []).map(String);
        for (const t of b.tasks) if (redo.includes(t.id)) { t.status = 'todo'; delete t.error; }
        if (b.status === 'done' && !b.tasks.some((t) => t.status !== 'done')) return send(res, 400, { error: '子任务都做完了：要重做哪个，点它右边的「重做」' });
        resumeBoard(room);
        return send(res, 200, { ok: true });
      }
      if (method === 'DELETE' && !parts[5]) { room.board = null; boardChanged(room); return send(res, 200, { ok: true }); }
    }
    if (action === 'stop' && method === 'POST') { const run = running.get(id); if (run) run.ac.abort(); return send(res, 200, { ok: true }); }
    if (action === 'clear' && method === 'POST') {
      if (running.has(id)) return send(res, 409, { error: '正在运行，请先停止' });
      room.messages = []; room.board = null; saveRoom(room); broadcast(id, 'reload', {});
      fs.rmSync(uploadsDir(id), { recursive: true, force: true });
      return send(res, 200, { ok: true });
    }
    if (!action && method === 'GET') return send(res, 200, roomView(room));
    if (!action && method === 'PUT') { applyRoomFields(room, await readBody(req)); saveRoom(room); return send(res, 200, roomView(room)); }
    if (!action && method === 'DELETE') {
      const run = running.get(id); if (run) run.ac.abort();
      rooms.delete(id); fs.rmSync(path.join(ROOMS_DIR, id + '.json'), { force: true });
      fs.rmSync(uploadsDir(id), { recursive: true, force: true });
      return send(res, 200, { ok: true });
    }
  }
  send(res, 404, { error: '接口不存在' });
}

const server = http.createServer(async (req, res) => {
  try {
    if (!sameOrigin(req)) { res.writeHead(403); return res.end('Forbidden'); }
    const url = new URL(req.url, 'http://localhost');
    if (!isLocal(req) && !(await gate(req, res, url))) return;
    const parts = url.pathname.split('/');
    if (parts[1] === 'api') await handleApi(req, res, parts, url);
    else serveStatic(req, res, url.pathname);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: e.message });
  }
});
// 退出时（Ctrl+C、关掉终端窗口）把自动启动的本机模型服务和还在运行的命令一起关掉
process.on('exit', () => { stopServers(); stopCommands(); try { usage.flush(); } catch {} });
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(0));
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`\n  端口 ${PORT} 已被占用：可能已经启动过了，直接打开 http://localhost:${PORT}；或用 PORT=8788 npm start 换个端口。\n`);
  else console.error(e);
  process.exit(1);
});
function onListen() {
  const lan = LOOPBACK ? null : lanAddresses()[0];
  console.log(`\n  🤖 Agent Hub 已启动：http://localhost:${PORT}`);
  if (lan) console.log(access.enabled
    ? `  📱 手机访问：手机连同一个 Wi-Fi，打开 http://${lan.address}:${PORT} ，访问码 ${fmtCode(access.code)}（网页左下角「手机访问」里有二维码）`
    : '  📱 手机访问：已关闭（网页左下角「手机访问」可以开启）');
  console.log(`  数据目录：${DATA}\n  按 Ctrl+C 停止\n`);
  if (process.env.OPEN_BROWSER === '1') openBrowser(`http://localhost:${PORT}`); // 「双击启动」的文件会设这个
}
function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { require('child_process').spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => {}).unref(); } catch {}
}
server.requestTimeout = 3600000; // 大文件上传可能要好几分钟（Node 默认 5 分钟就断）
if (HOST) server.listen(PORT, HOST, onListen); else server.listen(PORT, onListen); // 不指定地址时 IPv4、IPv6 都监听
