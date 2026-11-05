'use strict';
const $ = (s) => document.querySelector(s);
const state = { agents: [], rooms: [], room: null, es: null, running: false, editing: null, info: null };
const relayDrafts = {}; // 手动转达时还没提交的回复草稿，避免重新渲染时丢失

// 模型名可能随厂商更新而变化，以各家控制台为准。group 开始一个分组，后面没写 group 的都归这一组
const tpl = (o) => JSON.stringify(o, null, 2); // 「自定义 JSON 接口」的请求模板
const PRESETS = [
  { label: '— 选择后自动填写接口地址和模型 —' },
  { group: '本机助手', label: 'Claude Code · 宽权限', provider: 'claude-code', toolMode: 'wide', note: '能用 skill、联网、运行命令，能写「可写文件夹」（默认整个主目录）。Agent Hub 自己的文件、~/Library 和各 AI 的配置不能改，Key 和登录凭证读不到。只能在 Mac 上打开。' },
  { label: 'Claude Code · 可用 Skill', provider: 'claude-code', toolMode: 'skills', note: '能用你装进 Claude Code 的 skill（比如 agent-reach 查小红书/B站/YouTube、AI 工程课程），能搜索、读网页，能在工作目录里改文件；命令只能运行 agent-reach 的只读查询。只能在 Mac 上添加。' },
  { label: 'Claude Code · 可改文件', provider: 'claude-code', toolMode: 'edit', note: '能在工作目录里新建、修改文件（默认 agent-hub/workspace），不能运行命令。' },
  { label: 'Claude Code · 只聊天', provider: 'claude-code', toolMode: 'chat', note: '用你在 Claude Code 里登录的账号，不需要 API Key；模型留空就用 Claude Code 的默认模型。' },
  { label: 'Codex · 宽权限', provider: 'codex', model: 'gpt-6.1-sol', effort: 'low', toolMode: 'wide', note: '能联网、运行命令，能写「可写文件夹」（默认整个主目录）。Agent Hub 自己的文件、~/Library 和各 AI 的配置不能改，Key 和登录凭证读不到。只能在 Mac 上打开。' },
  { label: 'Codex · 可改文件', provider: 'codex', model: 'gpt-6.1-sol', effort: 'low', toolMode: 'edit', note: '用你在 Codex 里登录的 ChatGPT 账号，不需要 API Key。能运行命令、只能写工作目录（默认 agent-hub/workspace），不能联网。只能在 Mac 上添加。' },
  { label: 'Codex · 只聊天', provider: 'codex', model: 'gpt-6.1-sol', effort: 'low', toolMode: 'chat', note: '用你在 Codex 里登录的 ChatGPT 账号，不需要 API Key；不运行命令，读不了文件。' },
  { group: '官方接口', label: 'DeepSeek Flash（便宜，能看图）', provider: 'openai', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', note: '在 platform.deepseek.com 充值并创建 API Key，按用量付费。deepseek-flash 便宜；想要更强换成 deepseek-v4-pro（只能看文字）。模型名填错时，测试连接会列出可用的模型。' },
  { label: 'DeepSeek V4 Pro（更强，只看文字）', provider: 'openai', baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-pro', note: '比 Flash 贵，推理更强；看不了图片（发图时会自动改成只发文字）。' },
  { label: 'DeepSeek Flash · 宽权限（借 Claude Code 的工具）', provider: 'claude-code', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', toolMode: 'wide', note: '模型是 DeepSeek，按 DeepSeek 的价格计费；用 Claude Code 的工具读写文件、运行命令、读网页（没有网页搜索），限制和 Claude Code 宽权限一样。要装好 Claude Code（不用登录）。只能在 Mac 上打开。' },
  { label: '手动转达（Claude App 等没有接口的助手）', provider: 'relay', note: '轮到它时把提示词复制给它，再把它的回复粘贴回来。' },
  { group: '本机模型 · 自己训练的模型', label: 'Ollama（最简单，免费）', provider: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'qwen3:4b', historyChars: 6000, note: '先安装 Ollama（ollama.com），在终端运行 ollama pull qwen3:4b，不需要 Key。自己的 GGUF 模型文件：写一个只有一行「FROM ./模型文件.gguf」的 Modelfile，运行 ollama create 我的模型 -f Modelfile，再点上面的「🔍 查找」就能选到。8GB 内存的 Mac 建议用 4B 以下的量化模型。' },
  { label: 'Ollama 原生接口（可以设上下文长度）', provider: 'rest', baseUrl: 'http://localhost:11434/api/chat', model: 'qwen3:4b', historyChars: 8000, bodyTemplate: tpl({ model: '{{model}}', messages: '{{messages}}', stream: true, options: { num_ctx: 8192, temperature: '{{temperature}}', num_predict: '{{max_tokens}}', stop: '{{stop}}' } }), note: 'Ollama 默认的上下文只有几千 token，群聊记录一长，开头的人设和规则会被悄悄截掉。这个预设用原生接口把上下文设成 8192（num_ctx），聊天记录上限也调到 8000 字。' },
  { label: 'LM Studio（本机，免费）', provider: 'openai', baseUrl: 'http://localhost:1234/v1', model: '', historyChars: 6000, note: '在 LM Studio 里下载模型，打开左边「开发者」里的 Local Server；模型名填它显示的名字，或者点上面的「🔍 查找」直接选。' },
  { label: 'MLX（Apple 芯片，适合自己用 MLX 微调的模型）', provider: 'openai', baseUrl: 'http://localhost:8080/v1', model: '', historyChars: 6000, startCommand: 'mlx_lm.server --model ~/models/我的模型 --port 8080', note: '先在终端运行 pip3 install mlx-lm。把下面「启动命令」里的路径换成你的模型文件夹（LoRA 微调的再加上 --adapter-path 适配器文件夹），Agent Hub 第一次用到它时会自动启动、闲置 15 分钟自动关掉。模型名留空 = 用启动命令里的模型。' },
  { label: 'llama.cpp（GGUF 模型文件）', provider: 'openai', baseUrl: 'http://localhost:8080/v1', model: '', historyChars: 8000, startCommand: 'llama-server -m ~/models/我的模型.gguf --port 8080 -c 8192', note: '先在终端运行 brew install llama.cpp。把下面「启动命令」里的路径换成你的 .gguf 文件（-c 8192 是上下文长度），第一次用到时自动启动。' },
  { group: '远程服务 · 自定义接口', label: 'vLLM / LLaMA-Factory / SGLang（云服务器、学校 GPU）', provider: 'openai', baseUrl: 'http://服务器地址:8000/v1', model: '', note: '这些工具部署出来的都是 OpenAI 兼容接口（LLaMA-Factory 用 llamafactory-cli api 启动）。把地址换成服务器的 IP 或域名，模型名填部署时的名字；不知道就在上面「🔍 查找」的地址框里输入服务器地址查一下。' },
  { label: '原始文本 + Alpaca 模板（llama.cpp /completion）', provider: 'rest', baseUrl: 'http://localhost:8080/completion', model: '', historyChars: 6000, bodyTemplate: tpl({ prompt: '{{system}}\n\n### Instruction:\n{{prompt}}\n\n### Response:\n', n_predict: 1024, temperature: '{{temperature}}', stream: true, stop: ['### Instruction:', '### Input:'] }), note: '给按 Alpaca 格式（### Instruction / ### Response）微调、服务端又没有对应对话模板的模型用：按训练时的格式把提示词拼好再发。把模板改成你训练时用的格式就行。' },
  { label: '原始文本 + ChatML 模板（/v1/completions）', provider: 'rest', baseUrl: 'http://localhost:8080/v1/completions', model: '', historyChars: 6000, bodyTemplate: tpl({ model: '{{model}}', prompt: '<|im_start|>system\n{{system}}<|im_end|>\n<|im_start|>user\n{{prompt}}<|im_end|>\n<|im_start|>assistant\n', max_tokens: 1024, temperature: '{{temperature}}', stream: true, stop: ['<|im_end|>'] }), note: 'Qwen 系列和很多微调模型用 ChatML 格式。服务端没带对话模板、或者带的模板和训练时不一样时，用这个按原样拼提示词。' },
  { label: 'Dify 应用（知识库 / 工作流机器人）', provider: 'rest', baseUrl: 'https://api.dify.ai/v1/chat-messages', model: '', contextMode: 'latest', bodyTemplate: tpl({ inputs: {}, query: '{{prompt}}', response_mode: 'streaming', user: 'agent-hub' }), note: 'API Key 填 Dify 应用「访问 API」页面里的密钥（app-…）；自己部署的 Dify 把地址换成你的域名。默认只把最新一条消息发给它。' },
  { label: '自定义 JSON 接口（自己写的 FastAPI / Flask 等）', provider: 'rest', baseUrl: 'http://localhost:8000/chat', model: '', bodyTemplate: tpl({ prompt: '{{prompt}}', system: '{{system}}', messages: '{{messages}}' }), note: '把模板改成你的接口要的格式。回复是 JSON 时，常见字段（reply、response、text、answer、choices…）会自动认出来，认不出时在「回复所在位置」里写，比如 data.reply。' },
  { label: '推理脚本（本机命令，不用写服务器）', provider: 'command', command: 'python3 {root}/examples/my_model_cli.py', inputFormat: 'json', model: '', historyChars: 6000, note: '每次发言运行一次你的脚本：提示词从标准输入传进去，打印出来的就是回复。示例脚本默认是演示模式；在命令前面加 MODEL=模型文件夹 就用 MLX 加载你的模型，详见 examples/my_model_cli.py 开头的说明。' },
  { label: '自定义程序（Agent Hub 协议）', provider: 'http', baseUrl: 'http://localhost:9000/agent', model: '', note: '接入你自己写的智能体程序（可以查资料、调工具、多步推理），协议见 README「接入自己的程序」，examples/ 里有示例。' },
  { group: '其他', label: '演示模式（不调用模型）', provider: 'mock', baseUrl: '', model: 'demo', note: '' },
];
const KIND_LABEL = { plan: '分工', task: '子任务', summary: '总结' };
const ic = (name, cls = '') => `<svg class="ic${cls ? ' ' + cls : ''}" aria-hidden="true"><use href="#i-${name}"/></svg>`; // 线条图标（index.html 里的 lucide）
const MODE_NAME = { chat: '自由讨论', brainstorm: '头脑风暴', collab: '分工协作' };
const TOOL_MODE_NAME = { chat: '只聊天', read: '只读', edit: '可改文件', skills: '可用 Skill', wide: '宽权限' };
const COLORS = ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#06b6d4', '#8b5cf6', '#ec4899', '#84cc16'];

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (data.relogin) { location.reload(); throw new Error(data.error); } // 手机上：登录失效或手机访问被关了，回到登录页
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
const TOUCH = matchMedia('(pointer: coarse)').matches; // 手机、平板
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const agentById = (id) => state.agents.find((a) => a.id === id);
const fail = (e) => alert(e.message || e);

// ---------- 简易 Markdown ----------
function inline(s) {
  return s.replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\(((?:https?:\/\/|\/(?!\/))[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}
function md(src) {
  let html = '';
  String(src || '').split('```').forEach((part, i) => {
    if (i % 2) { // 代码块（流式输出时可能还没闭合）
      html += `<pre><code>${esc(part.replace(/^[^\n]*\n?/, '').replace(/\n$/, ''))}</code></pre>`;
      return;
    }
    let para = [];
    const flush = () => { if (para.length) { html += `<p>${para.join('<br>')}</p>`; para = []; } };
    const lines = part.split('\n');
    const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(esc(c.trim())));
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let m;
      // 表格：| a | b | 下一行是 |---|---|
      if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] || '')) {
        flush();
        const head = cells(line), rows = [];
        i += 2;
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
        i--;
        html += `<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
        continue;
      }
      if (!line.trim()) flush();
      else if ((m = line.match(/^\s{0,3}#{1,6}\s+(.*)$/))) { flush(); html += `<h4>${inline(esc(m[1]))}</h4>`; }
      else if ((m = line.match(/^\s*>\s?(.*)$/))) { flush(); html += `<blockquote>${inline(esc(m[1]))}</blockquote>`; }
      else para.push(inline(esc(line.replace(/^(\s*)[-*+]\s+/, '$1• '))));
    }
    flush();
  });
  return html;
}
function avatarHtml(a, sm) {
  return `<div class="avatar${sm ? ' sm' : ''}" style="background:${esc(a?.color || '#888')}">${esc(a?.avatar || (a?.name || '?')[0])}</div>`;
}

// ---------- 侧栏 ----------
const isLocalUrl = (u) => /\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(u || '');
function agentSub(a) {
  const u = a.usage || {};
  const money = u.over ? ' · <span class="over">预算用完</span>' : u.limited ? ` · 预算 ${Math.round(u.ratio * 100)}%` : '';
  return agentKind(a) + (a.onlyWhenMentioned ? ' · 被@才说' : '') + money;
}
function agentKind(a) {
  if (a.provider === 'mock') return '演示模式';
  if (a.provider === 'http') return '自定义程序';
  if (a.provider === 'rest') return '自定义接口' + (a.model ? ' · ' + esc(a.model) : '');
  if (a.provider === 'command') return '本机命令' + (a.model ? ' · ' + esc(a.model) : '');
  if (a.provider === 'relay') return '手动转达';
  if (a.provider === 'claude-code') return 'Claude Code' + (a.baseUrl ? '（' + esc(a.model || '第三方接口') + '）' : '') + ' · ' + (TOOL_MODE_NAME[a.toolMode] || '只聊天');
  if (a.provider === 'codex') return 'Codex · ' + (TOOL_MODE_NAME[a.toolMode] || '只聊天');
  const local = isLocalUrl(a.baseUrl);
  return esc(a.model || (local ? '默认模型' : '未设置模型')) + (local ? ' · 本机' : '') + (a.missingKey ? ' · <span class="over">未填 Key</span>' : '');
}
function renderSidebar() {
  $('#roomList').innerHTML = state.rooms.map((r) => `
    <li data-id="${r.id}" class="${state.room?.id === r.id ? 'active' : ''}">
      <span class="grow"><div class="name">${esc(r.name)}</div><div class="sub">${MODE_NAME[r.mode] || ''} · ${r.count} 条</div></span>
      ${r.running ? '<span class="dot" title="运行中"></span>' : ''}
    </li>`).join('');
  $('#agentList').innerHTML = state.agents.map((a) => `
    <li data-id="${a.id}">${avatarHtml(a, true)}
      <span class="grow"><div class="name">${esc(a.name)}</div><div class="sub">${agentSub(a)}</div></span>
    </li>`).join('') || '<li class="sub">还没有智能体，点右上角的加号添加</li>';
}
$('#roomList').onclick = (e) => { const li = e.target.closest('li[data-id]'); if (li) openRoom(li.dataset.id).catch(fail); };
$('#agentList').onclick = (e) => { const li = e.target.closest('li[data-id]'); if (li) openAgentDialog(agentById(li.dataset.id)); };
$('#newRoom').onclick = async () => {
  try {
    const r = await api('POST', '/api/rooms', { name: '房间 ' + (state.rooms.length + 1) });
    await refreshRooms(); await openRoom(r.id);
  } catch (e) { fail(e); }
};
$('#newAgent').onclick = () => openAgentDialog(null);
$('#menuBtn').onclick = () => $('#sidebar').classList.toggle('open');
// 手机上：点侧栏外面就收起侧栏
document.addEventListener('click', (e) => {
  const sb = $('#sidebar');
  if (sb.classList.contains('open') && !e.target.closest('#sidebar, #menuBtn, dialog')) sb.classList.remove('open');
});

async function refreshAgents() { state.agents = await api('GET', '/api/agents'); renderSidebar(); }
async function refreshRooms() { state.rooms = await api('GET', '/api/rooms'); renderSidebar(); }

// ---------- 房间 ----------
async function openRoom(id) {
  $('#sidebar').classList.remove('open');
  if (state.room?.id !== id) clearPending();
  if (state.es) state.es.close();
  const es = new EventSource(`/api/rooms/${id}/stream`);
  state.es = es;
  const live = () => state.es === es && state.room?.id === id;
  const on = (ev, fn) => es.addEventListener(ev, (e) => { if (live()) fn(JSON.parse(e.data)); });
  on('status', (d) => {
    setRunning(d.running);
    const r = state.rooms.find((x) => x.id === id);
    if (r) { r.running = d.running; r.count = state.room.messages.length; renderSidebar(); }
    renderBoard();
    if (!d.running) refreshAgents().catch(() => {}); // 侧栏上的预算用量
  });
  on('message', (m) => { if (!state.room.messages.some((x) => x.id === m.id)) { state.room.messages.push(m); appendMessage(m); } });
  on('delta', ({ id: mid, text }) => { const m = state.room.messages.find((x) => x.id === mid); if (m) { m.content += text; updateMessage(m, true); } });
  on('update', (m) => { const i = state.room.messages.findIndex((x) => x.id === m.id); if (i >= 0) { state.room.messages[i] = m; updateMessage(m, false); } });
  on('reload', () => reloadRoom(id));
  on('board', (b) => { state.room.board = b; renderBoard(); });
  // 先连上推送再拉取房间内容，避免漏消息；断线重连后重新同步
  let first = true;
  es.addEventListener('open', () => { if (!first && state.es === es) reloadRoom(id); });
  await new Promise((resolve) => { es.addEventListener('open', resolve, { once: true }); es.addEventListener('error', resolve, { once: true }); setTimeout(resolve, 4000); });
  first = false;
  if (state.es !== es) return;
  state.room = await api('GET', '/api/rooms/' + id);
  try { localStorage.setItem('agenthub.room', id); } catch {}
  renderRoom(); renderSidebar();
}

async function reloadRoom(id) {
  const r = await api('GET', '/api/rooms/' + id).catch(() => null);
  if (r && state.room?.id === id) { state.room = r; renderRoom(); }
}
// 手机锁屏或切到别的 App 再回来时，实时推送可能已经断了：重新连上并同步
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
  if (state.room && (state.es?.readyState === EventSource.CLOSED || (TOUCH && Date.now() - hiddenAt > 30000))) openRoom(state.room.id).catch(() => {});
});

function renderRoom() {
  const r = state.room;
  $('#roomName').value = r.name;
  document.querySelectorAll('#modes button').forEach((b) => b.classList.toggle('on', b.dataset.mode === r.mode));
  renderSettings(); renderMessages(); renderChips(); setRunning(r.running); renderBoard();
}
$('#roomName').onchange = (e) => saveRoom({ name: e.target.value.trim() || '未命名房间' }).catch(fail);
$('#modes').onclick = async (e) => {
  const b = e.target.closest('button[data-mode]'); if (!b) return;
  try { await saveRoom({ mode: b.dataset.mode }); renderRoom(); } catch (err) { fail(err); }
};
$('#settingsBtn').onclick = () => { $('#settings').hidden = !$('#settings').hidden; };

async function saveRoom(patch) {
  const updated = await api('PUT', '/api/rooms/' + state.room.id, patch);
  state.room = { ...state.room, ...updated };
  await refreshRooms();
}

function renderSettings() {
  const r = state.room;
  const order = r.memberIds.filter((id) => agentById(id));
  $('#settingsBtn').innerHTML = `${ic('users')}<span>成员 ${order.length}</span>`;
  $('#memberChecks').innerHTML = state.agents.map((a) => {
    const idx = order.indexOf(a.id);
    return `<label class="${idx >= 0 ? 'on' : ''}"><input type="checkbox" value="${a.id}" ${idx >= 0 ? 'checked' : ''}>${avatarHtml(a, true)}${esc(a.name)}<span class="order">${idx >= 0 ? idx + 1 : ''}</span></label>`;
  }).join('') || '<span class="hint">先在左侧添加智能体</span>';
  $('#leaderSel').innerHTML = order.map(agentById).map((a) => `<option value="${a.id}" ${a.id === r.leaderId ? 'selected' : ''}>${esc(a.name)}</option>`).join('');
  $('#roundsInp').value = r.rounds || 1;
  $('#confirmPlanChk').checked = !!r.confirmPlan;
}
$('#confirmPlanChk').onchange = (e) => saveRoom({ confirmPlan: e.target.checked }).catch(fail);
$('#memberChecks').onchange = async (e) => {
  const id = e.target.value;
  let ids = state.room.memberIds.filter((x) => agentById(x));
  ids = e.target.checked ? [...ids, id] : ids.filter((x) => x !== id);
  const patch = { memberIds: ids };
  if (!ids.includes(state.room.leaderId)) patch.leaderId = ids[0] || null;
  try { await saveRoom(patch); renderSettings(); renderChips(); } catch (err) { fail(err); }
};
$('#leaderSel').onchange = (e) => saveRoom({ leaderId: e.target.value }).catch(fail);
$('#roundsInp').onchange = (e) => saveRoom({ rounds: Math.max(1, Math.min(5, Number(e.target.value) || 1)) }).catch(fail);
$('#clearRoom').onclick = async () => {
  if (confirm('清空这个房间的所有消息？')) await api('POST', `/api/rooms/${state.room.id}/clear`).catch(fail);
};
$('#deleteRoom').onclick = async () => {
  if (!confirm(`删除房间「${state.room.name}」？聊天记录会一起删除。`)) return;
  try {
    await api('DELETE', '/api/rooms/' + state.room.id);
    await refreshRooms();
    if (!state.rooms.length) { await api('POST', '/api/rooms', { name: '默认房间' }); await refreshRooms(); }
    await openRoom(state.rooms[0].id);
  } catch (e) { fail(e); }
};

// ---------- 消息 ----------
function messageHtml(m) {
  if (m.role === 'system') return `<div class="msg system" data-id="${m.id}"><div class="bubble">${md(m.content)}</div></div>`;
  const time = new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (m.role === 'user') {
    return `<div class="msg user" data-id="${m.id}">${avatarHtml({ avatar: '我', color: '#64748b' })}<div class="body"><div class="meta"><span>${time}</span><b>我</b></div>${filesHtml(m)}${m.content ? `<div class="bubble">${md(m.content)}</div>` : ''}</div></div>`;
  }
  const a = agentById(m.agentId) || { name: m.name };
  const live = state.running && !m.error && !m.relay && (m.live || m === state.room.messages[state.room.messages.length - 1]); // 同时在做的子任务都算
  const inner = m.relay ? relayHtml(m) : m.content ? contentHtml(m.content) : live ? '' : '<i>（无内容）</i>';
  return `<div class="msg agent ${m.kind === 'summary' ? 'summary' : ''}" data-id="${m.id}">${avatarHtml(a)}
    <div class="body"><div class="meta">${live ? `<span class="speaking" style="background:${esc(a.color || '#888')}" title="正在发言"></span>` : ''}<b>${esc(m.name)}</b>${KIND_LABEL[m.kind] ? `<span class="badge">${KIND_LABEL[m.kind]}</span>` : ''}<span>${time}</span>${usageHtml(m.usage)}</div>
    ${thinkingHtml(m)}<div class="bubble ${live ? 'typing' : ''}">${inner}</div>${traceHtml(m)}
    ${m.error ? `<div class="err">${ic('triangle-alert')}<span>调用失败：${esc(m.error)}</span></div>` : ''}</div></div>`;
}
// 正文 + 末尾的「【交接】」单独放在一个安静的框里
function contentHtml(text) {
  const i = text.lastIndexOf('【交接】');
  if (i < 0) return md(text);
  const main = text.slice(0, i).trim(), note = text.slice(i + 4).trim();
  return (main ? md(main) : '') + `<div class="handoff"><div class="hlabel">${ic('arrow-up')}交接给后面的成员</div>${md(note)}</div>`;
}
// 思考过程（折叠）和这次用到的资料、写出的文件
function thinkingHtml(m) {
  if (!m.thinking) return '';
  return `<details class="thinking"><summary>${ic('lightbulb')}思考过程 · ${m.thinking.length.toLocaleString()} 字</summary><div class="tk">${esc(m.thinking)}</div></details>`;
}
function traceHtml(m) {
  const t = m.trace; if (!t) return '';
  const name = (p) => esc(String(p).split('/').pop());
  const bits = [];
  if (t.urls?.length) bits.push(`查过 ${t.urls.slice(0, 3).map((u) => { let h = u; try { h = new URL(u).hostname; } catch {} return `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(h)}</a>`; }).join('、')}${t.urls.length > 3 ? ` 等 ${t.urls.length} 个网页` : ''}`);
  if (t.searches?.length) bits.push(`搜过「${esc(t.searches[0])}」${t.searches.length > 1 ? ` 等 ${t.searches.length} 次` : ''}`);
  if (t.wrote?.length) bits.push(`写了 ${t.wrote.slice(0, 3).map((p) => `<span title="${esc(p)}">${name(p)}</span>`).join('、')}${t.wrote.length > 3 ? ` 等 ${t.wrote.length} 个文件` : ''}`);
  if (t.read?.length) bits.push(`读了 ${t.read.length} 个文件`);
  return bits.length ? `<div class="trace">${ic('paperclip')}<span>${bits.join(' · ')}</span></div>` : '';
}

// 这条回复用了多少 token / 花了多少钱
const kTok = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n || 0));
const usd = (n) => '$' + (n >= 1 ? n.toFixed(2) : n >= 0.01 ? n.toFixed(3) : n.toFixed(4));
function usageHtml(u) {
  if (!u) return '';
  const title = `输入 ${u.in + u.cache} token（其中缓存 ${u.cache}），输出 ${u.out} token` + (typeof u.cost === 'number' ? `，${u.est ? '按你填的单价估算' : '接口报的花费'} ${usd(u.cost)}` : '，没填单价，不知道花了多少钱');
  return `<span class="usage" title="${esc(title)}">${kTok(u.in + u.cache)} → ${kTok(u.out)}${typeof u.cost === 'number' ? ' · ' + (u.est ? '≈' : '') + usd(u.cost) : ''}</span>`;
}

// ---------- 任务清单（分工协作）：流程图 + 列表 ----------
const TASK_ICON = { todo: 'circle', doing: 'circle-dot', done: 'circle-check', failed: 'circle-x' };
const TASK_LABEL = { todo: '待做', doing: '进行中', done: '完成', failed: '失败' };
const boardUi = { drafts: [], open: {}, saving: Promise.resolve(), view: 'flow' }; // 还没保存的新子任务；每张清单展开还是收起；看流程图还是列表
try { boardUi.view = localStorage.getItem('agenthub.boardView') || 'flow'; } catch {}
// 老清单没有 after：每个子任务等上一个
const depsOf = (tasks, i) => (Array.isArray(tasks[i].after) ? tasks[i].after : i ? [tasks[i - 1].id] : []).filter((id) => tasks.some((t) => t.id === id));
// 流程图分列：第几列 = 要等的子任务里最靠后的那一列 + 1
function flowLevels(tasks) {
  const lv = new Map();
  tasks.forEach((t, i) => { lv.set(t.id, Math.max(-1, ...depsOf(tasks, i).map((d) => lv.get(d) ?? -1)) + 1); });
  return lv;
}
function agentChip(id) {
  const a = agentById(id);
  return a ? `<span class="who">${avatarHtml(a, true)}<b>${esc(a.name)}</b></span>` : '<span class="who"><b>（已删除的成员）</b></span>';
}
function flowHtml(b) {
  const tasks = b.tasks, lv = flowLevels(tasks);
  const cols = [];
  tasks.forEach((t, i) => { const c = lv.get(t.id); (cols[c] = cols[c] || []).push([t, i]); });
  const leader = state.room.leaderId;
  const planMsg = state.room.messages.find((m) => m.runId === b.runId && m.kind === 'plan');
  const node = (cls, id, icon, who, title, sub, extra = '') => `<div class="fnode ${cls}" data-node="${id}" ${extra}>
      <div class="fhead"><span class="ti">${ic(icon)}</span>${who}</div>
      <div class="ftitle">${title}</div>${sub ? `<div class="fsub">${sub}</div>` : ''}</div>`;
  const sum = b.summaryStatus || (b.status === 'done' ? 'done' : 'todo');
  let html = `<div class="flow"><svg class="flow-lines" aria-hidden="true"></svg>`;
  html += `<div class="fcol">${node('st-done', 'plan', 'list-checks', agentChip(planMsg?.agentId || leader), '分工', '负责人拆任务、按擅长派活', planMsg ? `data-goto="${planMsg.id}"` : '')}</div>`;
  for (const col of cols) {
    html += `<div class="fcol">${col.map(([t, i]) => {
      const st = t.status || 'todo';
      const a = agentById(t.agentId);
      const dot = st === 'doing' ? `<span class="speaking" style="background:${esc(a?.color || '#888')}"></span>` : '';
      return node(`st-${st}`, t.id, TASK_ICON[st] || 'circle', agentChip(t.agentId) + dot, `<span class="fno">${i + 1}</span>${esc(t.task)}`,
        t.error ? `<span class="ferr">${esc(t.error)}</span>` : t.why ? esc(t.why) : TASK_LABEL[st], t.msgId ? `data-goto="${t.msgId}"` : '');
    }).join('')}</div>`;
  }
  html += `<div class="fcol">${node(`st-${sum}`, 'summary', TASK_ICON[sum] || 'circle', agentChip(leader), '整合', TASK_LABEL[sum] || '', b.summaryId ? `data-goto="${b.summaryId}"` : '')}</div>`;
  return html + '</div>';
}
// 箭头：从要等的子任务连到它；第一列的子任务连「分工」，没人等的连「整合」
function drawFlow() {
  const flow = $('#board .flow'); if (!flow) return;
  const svg = flow.querySelector('.flow-lines'), b = state.room.board, tasks = b.tasks;
  const box = flow.getBoundingClientRect();
  const at = (id) => flow.querySelector(`[data-node="${id}"]`)?.getBoundingClientRect();
  const edges = [];
  const needed = new Set();
  tasks.forEach((t, i) => { const d = depsOf(tasks, i); d.forEach((x) => { edges.push([x, t.id]); needed.add(x); }); if (!d.length) edges.push(['plan', t.id]); });
  tasks.forEach((t) => { if (!needed.has(t.id)) edges.push([t.id, 'summary']); });
  const sx = flow.scrollLeft, sy = flow.scrollTop;
  const paths = edges.map(([from, to]) => {
    const a = at(from), c = at(to); if (!a || !c) return '';
    const x1 = a.right - box.left + sx, y1 = a.top + a.height / 2 - box.top + sy, x2 = c.left - box.left + sx, y2 = c.top + c.height / 2 - box.top + sy;
    const mx = (x1 + x2) / 2;
    const st = (tasks.find((t) => t.id === from) || { status: 'done' }).status;
    return `<path class="${st === 'done' ? 'on' : ''}" d="M${x1} ${y1} C${mx} ${y1}, ${mx} ${y2}, ${x2 - 6} ${y2}" marker-end="url(#fa)"/>`;
  }).join('');
  svg.setAttribute('width', flow.scrollWidth); svg.setAttribute('height', flow.scrollHeight);
  svg.innerHTML = `<defs><marker id="fa" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="8" markerHeight="8" orient="auto"><path d="M0 0 L8 4 L0 8 z"/></marker></defs>${paths}`;
}
addEventListener('resize', () => drawFlow());

function renderBoard() {
  const el = $('#board'), b = state.room?.board;
  if (!b) { el.hidden = true; el.innerHTML = ''; boardUi.drafts = []; return; }
  const busy = state.running || b.status === 'running';
  const editable = !busy;
  const members = state.room.memberIds.map(agentById).filter(Boolean);
  const nDone = b.tasks.filter((t) => t.status === 'done').length;
  const nFail = b.status === 'done' ? b.tasks.length - nDone : b.tasks.filter((t) => t.status === 'failed').length;
  const head = { awaiting: '等你确认分工', running: '执行中', stopped: '停下了', done: nFail ? '做完了，有没完成的子任务' : '全部完成' }[b.status] || '';
  const open = boardUi.open[b.id] ?? (b.status !== 'done' || nFail > 0);
  const view = boardUi.view === 'list' ? 'list' : 'flow';
  const who = (t, i) => {
    if (!editable || t.status === 'done') return agentChip(t.agentId);
    return `<select data-k="agentId" aria-label="第 ${i + 1} 个子任务的负责人">${members.map((a) => `<option value="${a.id}" ${a.id === t.agentId ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}${members.some((a) => a.id === t.agentId) ? '' : '<option value="" selected>（选一个成员）</option>'}</select>`;
  };
  const all = [...b.tasks, ...(editable ? boardUi.drafts : [])];
  // 要等哪几步：编辑时点编号切换；不编辑时写成一句话
  const depsHtml = (t, i) => {
    const deps = t.id ? depsOf(all, i) : (t.after || []);
    if (!i) return '';
    if (!editable) return `<div class="tdeps">${deps.length ? `等第 ${deps.map((d) => all.findIndex((x) => x.id === d) + 1).join('、')} 步做完` : '马上开始'}</div>`;
    return `<div class="tdeps">等这些做完：${all.slice(0, i).map((x, j) => `<button type="button" class="dep ${deps.includes(x.id) ? 'on' : ''}" data-b="dep" data-dep="${x.id || ''}" ${x.id ? '' : 'disabled'} aria-pressed="${deps.includes(x.id)}">${j + 1}</button>`).join('')}<span class="hint-inline">${deps.length ? '' : '都不选 = 马上开始，和别的同时做'}</span></div>`;
  };
  const row = (t, i, draft) => `<li class="task st-${t.status || 'todo'}" data-tid="${t.id || ''}" ${draft ? 'data-draft="1"' : ''} data-after="${esc(JSON.stringify(t.id ? depsOf(all, i) : (t.after || [])))}">
      <span class="ti" title="${TASK_LABEL[t.status] || '待做'}">${ic(TASK_ICON[t.status] || 'circle')}</span>
      <div class="tbody">
        <div class="trow"><span class="tno">${i + 1}</span>${who(t, i)}<span class="tst">${draft ? '新加的' : TASK_LABEL[t.status] || ''}</span>${t.why ? `<span class="twhy">${esc(t.why)}</span>` : ''}<span class="grow"></span>
          ${t.msgId ? '<button type="button" class="link" data-b="goto">看产出</button>' : ''}
          ${editable && t.status === 'done' ? '<button type="button" class="link" data-b="redo">重做</button>' : ''}
          ${editable ? `<button type="button" class="link danger" data-b="del" title="删掉这个子任务" aria-label="删掉这个子任务">${ic('x')}</button>` : ''}</div>
        ${editable && t.status !== 'done' ? `<textarea data-k="task" rows="1" placeholder="写下这个子任务要做什么">${esc(t.task)}</textarea>` : `<div class="tt">${esc(t.task)}</div>`}
        ${depsHtml(t, i)}
        ${t.error ? `<div class="err">${ic('triangle-alert')}<span>${esc(t.error)}</span></div>` : ''}
      </div></li>`;
  const add = ['add', ic('plus') + '添加子任务'];
  const actions = !editable ? '' : b.status === 'awaiting' ? [['run', ic('play') + '开始执行', 'primary'], add, ['drop', '放弃这次分工', 'danger']]
    : b.status === 'stopped' ? [['run', ic('play') + `继续，还有 ${b.tasks.length - nDone} 个`, 'primary'], add, ['drop', '放弃', 'danger']]
    : nFail ? [['run', ic('rotate-ccw') + `重做没完成的 ${nFail} 个`, 'primary'], add, ['drop', '清掉清单']]
    : [add, ['drop', '清掉清单']];
  el.hidden = false;
  el.innerHTML = `<details ${open ? 'open' : ''}><summary>${ic('clipboard-list')}<b>任务清单</b><span class="bhead st-${b.status}">${head}</span><span class="bprog">${nDone}/${b.tasks.length}</span><span class="btopic">${esc(b.topic || '')}</span>
      <span class="seg" role="tablist"><button type="button" data-view="flow" class="${view === 'flow' ? 'on' : ''}">流程图</button><button type="button" data-view="list" class="${view === 'list' ? 'on' : ''}">${editable ? '列表 · 编辑' : '列表'}</button></span></summary>
    ${view === 'flow' ? flowHtml(b) : `<ol class="tasks">${b.tasks.map((t, i) => row(t, i)).join('')}${editable ? boardUi.drafts.map((d, i) => row(d, b.tasks.length + i, true)).join('') : ''}</ol>`}
    ${actions ? `<div class="row gap wrap">${actions.filter((a) => view === 'list' || a[0] !== 'add').map(([k, label, cls]) => `<button type="button" class="btn ${cls === 'primary' ? 'primary' : 'ghost'} ${cls === 'danger' ? 'danger' : ''}" data-b="${k}">${label}</button>`).join('')}</div>` : ''}
    ${b.status === 'awaiting' && editable ? `<p class="hint">${view === 'flow' ? '要改内容、换人、调整先后顺序，切到「列表 · 编辑」。' : '改完点「开始执行」。'}也可以直接发消息说哪里不对，负责人会重新分工。</p>` : ''}
  </details>`;
  el.querySelectorAll('textarea[data-k]').forEach(fitTask);
  if (view === 'flow' && open) { drawFlow(); setTimeout(drawFlow, 120); } // 字体加载完布局可能变，过一下再画一次
}
function fitTask(t) { t.style.height = 'auto'; t.style.height = t.scrollHeight + 2 + 'px'; }
// 从页面上读出当前的清单（已保存的 + 新加的、写了内容的）
function boardFromDom() {
  return [...$('#board').querySelectorAll('li.task')].map((li) => {
    const t = state.room.board.tasks.find((x) => x.id === li.dataset.tid) || {};
    let after = []; try { after = JSON.parse(li.dataset.after || '[]'); } catch {}
    return { id: li.dataset.draft ? '' : li.dataset.tid, agentId: li.querySelector('[data-k="agentId"]')?.value ?? t.agentId, task: li.querySelector('[data-k="task"]')?.value.trim() ?? t.task, after, draft: !!li.dataset.draft };
  });
}
function saveBoard(list) {
  const roomId = state.room.id;
  const keep = list.filter((t) => t.draft && !t.task); // 还没写内容的新子任务先留在页面上
  const tasks = list.filter((t) => !(t.draft && !t.task));
  boardUi.saving = api('PUT', `/api/rooms/${roomId}/board`, { tasks })
    .then((b) => { boardUi.drafts = keep; if (state.room?.id === roomId) { state.room.board = b; renderBoard(); } })
    .catch((e) => { fail(e); renderBoard(); });
  return boardUi.saving;
}
$('#board').addEventListener('change', (e) => { if (e.target.dataset.k) saveBoard(boardFromDom()); });
$('#board').addEventListener('input', (e) => { if (e.target.dataset.k === 'task') fitTask(e.target); });
$('#board').addEventListener('toggle', (e) => { if (state.room?.board && e.target.tagName === 'DETAILS') { boardUi.open[state.room.board.id] = e.target.open; if (e.target.open) drawFlow(); } }, true);
$('#board').addEventListener('scroll', () => drawFlow(), true);
function gotoMessage(id) {
  const m = document.querySelector(`.msg[data-id="${id}"]`);
  if (m) { m.scrollIntoView({ behavior: 'smooth', block: 'start' }); m.classList.add('flash'); setTimeout(() => m.classList.remove('flash'), 1600); }
  else alert('这条产出已经不在聊天记录里了');
}
$('#board').addEventListener('click', async (e) => {
  const v = e.target.closest('button[data-view]');
  if (v) { e.preventDefault(); boardUi.view = v.dataset.view; try { localStorage.setItem('agenthub.boardView', boardUi.view); } catch {} renderBoard(); return; }
  const n = e.target.closest('.fnode[data-goto]');
  if (n) return gotoMessage(n.dataset.goto);
  const btn = e.target.closest('button[data-b]'); if (!btn) return;
  const b = state.room.board, roomId = state.room.id, k = btn.dataset.b;
  const li = btn.closest('li.task'), t = li && b.tasks.find((x) => x.id === li.dataset.tid);
  try {
    await boardUi.saving; // 先等刚才的修改存好
    if (k === 'goto') gotoMessage(t.msgId);
    else if (k === 'dep') {
      let after = []; try { after = JSON.parse(li.dataset.after || '[]'); } catch {}
      const id = btn.dataset.dep;
      li.dataset.after = JSON.stringify(after.includes(id) ? after.filter((x) => x !== id) : [...after, id]);
      if (li.dataset.draft) { const d = boardUi.drafts[[...$('#board').querySelectorAll('li[data-draft]')].indexOf(li)]; if (d) d.after = JSON.parse(li.dataset.after); renderBoard(); }
      else await saveBoard(boardFromDom());
    } else if (k === 'add') {
      const members = state.room.memberIds.map(agentById).filter(Boolean);
      const last = b.tasks[b.tasks.length - 1];
      boardUi.drafts.push({ agentId: members[0]?.id || '', task: '', status: 'todo', after: last ? [last.id] : [] });
      renderBoard();
      [...$('#board').querySelectorAll('li[data-draft] textarea')].pop()?.focus();
    } else if (k === 'del') {
      if (li.dataset.draft) { boardUi.drafts.splice([...$('#board').querySelectorAll('li[data-draft]')].indexOf(li), 1); renderBoard(); return; }
      if (t && t.status === 'done' && !confirm('这个子任务已经做完了，确定从清单里删掉？（聊天里的产出不会删）')) return;
      await saveBoard(boardFromDom().filter((x) => x.id !== li.dataset.tid));
    } else if (k === 'redo') {
      if (!confirm(`让 ${agentById(t.agentId)?.name || '负责人'} 重做这个子任务，然后重新整合？`)) return;
      await api('POST', `/api/rooms/${roomId}/board/run`, { redo: [t.id] });
    } else if (k === 'run') {
      if (boardUi.drafts.some((d) => !d.task) && !confirm('有新加的子任务还没写内容，这些会被忽略。继续？')) return;
      await api('POST', `/api/rooms/${roomId}/board/run`, {});
    } else if (k === 'drop') {
      if (!confirm(b.status === 'done' ? '清掉这张任务清单？（聊天记录不受影响）' : '放弃这次分工？没做的子任务就不做了（聊天记录不受影响）')) return;
      await api('DELETE', `/api/rooms/${roomId}/board`);
    }
  } catch (err) { fail(err); }
});

// 消息里的文件：图片显示缩略图，点开看大图；其他文件点一下下载
const FILE_ICON = { image: 'image', doc: 'file-text', other: 'package' };
function fileSub(a) {
  const kb = a.size < 1048576 ? Math.max(1, Math.round(a.size / 1024)) + ' KB' : (a.size / 1048576).toFixed(1) + ' MB';
  if (a.scanned) return `${kb} · 扫描件，前 ${a.images} 页转成图片发给模型`;
  if (a.kind === 'doc' && a.chars) return `${kb} · ${a.chars.toLocaleString()} 字${a.truncated ? '（太长，只发了前面一部分）' : ''}`;
  return a.note ? `${kb} · ${a.note}` : kb;
}
function filesHtml(m) {
  if (!m.attachments?.length) return '';
  const base = `/api/rooms/${state.room.id}/files/`;
  return `<div class="files">${m.attachments.map((a) => {
    const src = base + a.id + (a.inline ? '' : '?preview');
    if (a.kind === 'video') {
      const poster = a.preview ? ` poster="${base + a.id}?preview"` : '';
      const player = a.inline ? `<video controls playsinline preload="metadata"${poster} src="${base + a.id}"></video>`
        : a.preview ? `<img src="${base + a.id}?preview" alt="${esc(a.name)}" loading="lazy">` : '';
      return `<div class="file-video">${player}<a class="file-chip" href="${base + a.id}" download="${esc(a.name)}" title="点一下下载">${ic('play')}<span class="fname">${esc(a.name)}</span><small>${esc(fileSub(a))}</small></a></div>`;
    }
    if (a.kind === 'image' && (a.inline || a.preview)) return `<a class="file-img" href="${src}" target="_blank" rel="noopener" title="${esc(a.name)}${a.note ? '：' + esc(a.note) : ''}"><img src="${src}" alt="${esc(a.name)}" loading="lazy"></a>`;
    return `<a class="file-chip" href="${base + a.id}" download="${esc(a.name)}" title="点一下下载">${ic(FILE_ICON[a.kind] || 'package')}<span class="fname">${esc(a.name)}</span><small>${esc(fileSub(a))}</small></a>`;
  }).join('')}</div>`;
}
function relayHtml(m) {
  const r = m.relay;
  return `<div class="relay">
    <p>等 <b>${esc(m.name)}</b> 回复：把提示词复制给它，再把它的回复粘贴到下面。</p>
    <div class="row gap"><button class="btn ghost" data-relay="copy" data-mid="${m.id}">${ic('copy')}复制提示词</button><span class="copied" hidden></span></div>
    <details><summary class="hint">查看提示词</summary><pre>${esc(r.prompt)}</pre></details>
    <textarea rows="4" data-relay="input" data-mid="${m.id}" placeholder="把 ${esc(m.name)} 的回复粘贴到这里">${esc(relayDrafts[m.id] || '')}</textarea>
    <div class="row gap"><button class="btn primary" data-relay="send" data-mid="${m.id}">提交回复</button><button class="btn ghost" data-relay="skip" data-mid="${m.id}">跳过</button></div>
    ${r.replyFile ? `<p class="hint">它也可以把回复写进 <code>${esc(r.replyFile)}</code>，这里会自动继续。</p>` : ''}
  </div>`;
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  // 手机用局域网 http 打开时没有剪贴板接口，用老办法：iPhone 要 readonly + setSelectionRange；弹窗开着时要放进弹窗里才选得中
  const t = document.createElement('textarea');
  t.value = text; t.readOnly = true; t.style.position = 'fixed'; t.style.top = '0'; t.style.opacity = '0';
  (document.querySelector('dialog[open]') || document.body).appendChild(t);
  t.select(); t.setSelectionRange(0, text.length);
  let ok = false; try { ok = document.execCommand('copy'); } catch {}
  t.remove(); return ok;
}
$('#messages').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-relay]'); if (!b) return;
  const id = b.dataset.mid;
  const m = state.room.messages.find((x) => x.id === id); if (!m || !m.relay) return;
  if (b.dataset.relay === 'copy') {
    const tip = b.parentElement.querySelector('.copied');
    tip.textContent = (await copyText(m.relay.prompt)) ? '已复制' : '复制失败，请展开「查看提示词」手动复制';
    tip.hidden = false;
    return;
  }
  const text = b.closest('.relay').querySelector('textarea').value.trim();
  if (b.dataset.relay === 'send' && !text) return alert('请先粘贴回复，或者点「跳过」');
  try {
    await api('POST', '/api/relay/' + id, b.dataset.relay === 'skip' ? { skip: true } : { text });
    delete relayDrafts[id];
  } catch (err) { fail(err); }
});
$('#messages').addEventListener('input', (e) => { if (e.target.dataset.relay === 'input') relayDrafts[e.target.dataset.mid] = e.target.value; });

const nearBottom = () => { const el = $('#messages'); return el.scrollHeight - el.scrollTop - el.clientHeight < 120; };
const scrollBottom = () => { const el = $('#messages'); el.scrollTop = el.scrollHeight; };
function renderMessages() {
  const ms = state.room.messages;
  $('#messages').innerHTML = ms.length ? ms.map(messageHtml).join('') : `<div class="empty"><h2>开始一场多智能体协作</h2>
    <p>选上方的模式，然后发一条消息或布置一个任务</p>
    <dl class="modes-help"><dt>${ic('message-square')}自由讨论</dt><dd>成员轮流发言，<code>@名字</code> 只让某人回答</dd>
    <dt>${ic('lightbulb')}头脑风暴</dt><dd>独立出点子，再互评，最后主持人总结</dd>
    <dt>${ic('list-checks')}分工协作</dt><dd>负责人拆解分配，成员依次完成，最后整合交付</dd></dl></div>`;
  scrollBottom();
}
function appendMessage(m) {
  const stick = nearBottom();
  const box = $('#messages');
  box.querySelector('.empty')?.remove();
  box.querySelectorAll('.bubble.typing').forEach((b) => b.classList.remove('typing'));
  box.insertAdjacentHTML('beforeend', messageHtml(m));
  if (stick || m.role === 'user') scrollBottom();
}
function updateMessage(m, live) {
  const el = document.querySelector(`.msg[data-id="${m.id}"]`); if (!el) return;
  const stick = nearBottom();
  if (live) { const b = el.querySelector('.bubble'); b.innerHTML = contentHtml(m.content); b.classList.add('typing'); }
  else { el.outerHTML = messageHtml(m); document.querySelector(`.msg[data-id="${m.id}"] .bubble`)?.classList.remove('typing'); }
  if (stick) scrollBottom();
}
function renderChips() {
  const members = state.room.memberIds.map(agentById).filter(Boolean);
  $('#mentionChips').innerHTML = members.map((a) => `<button class="chip" data-name="${esc(a.name)}">@${esc(a.name)}</button>`).join('');
}
$('#mentionChips').onclick = (e) => {
  const c = e.target.closest('.chip'); if (!c) return;
  const t = $('#input');
  t.value = (t.value && !t.value.endsWith(' ') ? t.value + ' ' : t.value) + '@' + c.dataset.name + ' ';
  t.focus();
};
function setRunning(on) {
  state.running = !!on;
  $('#stopBtn').hidden = !on;
  $('#sendBtn').textContent = on ? '插话' : '发送';
  if (!on) document.querySelectorAll('.bubble.typing').forEach((b) => b.classList.remove('typing'));
}
async function send() {
  const t = $('#input'); const text = t.value.trim(); if (!state.room || (!text && !pending.length)) return;
  const roomId = state.room.id;
  if (pending.some((p) => p.status === 'uploading')) { // 等文件传完再发
    $('#sendBtn').disabled = true;
    await Promise.all(pending.map((p) => p.promise));
    $('#sendBtn').disabled = false;
    if (state.room?.id !== roomId) return;
  }
  if (pending.some((p) => p.status === 'error')) return alert('有文件没传上去：点它右边的 × 去掉，再发送');
  const files = pending.splice(0);
  t.value = ''; autoGrow(); renderPending();
  try {
    await api('POST', `/api/rooms/${roomId}/messages`, { text, attachments: files.map((p) => p.meta.id) });
  } catch (e) { t.value = text; if (state.room?.id === roomId) { pending.unshift(...files); renderPending(); } fail(e); }
}

// ---------- 上传文件：📎 选文件、拖进窗口、粘贴截图 ----------
const pending = []; // 还没发出去的文件：{ name, size, status: uploading / done / error, meta, error, thumb, promise }
const FILE_COUNT = 10;
const fileLimit = () => state.info?.uploadBytes || 1024 ** 3;
const sizeText = (n) => (n >= 1024 ** 3 ? (n / 1024 ** 3).toFixed(n % 1024 ** 3 ? 1 : 0) + 'GB' : Math.round(n / 1048576) + 'MB');
function renderPending() {
  const box = $('#attachList');
  box.hidden = !pending.length;
  box.innerHTML = pending.map((p, i) => `<div class="attach ${p.status}" title="${esc(p.error || p.name)}">
    ${p.thumb ? `<img src="${p.thumb}" alt="">` : `<span class="ficon">${ic(p.status === 'error' ? 'triangle-alert' : p.video ? 'play' : 'file-text', 'lg')}</span>`}
    <span class="aname">${esc(p.name)}<small>${p.status === 'uploading' ? (p.progress >= 0.999 ? '处理中…' : p.progress ? `上传中 ${Math.floor(p.progress * 100)}%` : '上传中…') : p.status === 'error' ? esc(p.error) : esc(fileSub(p.meta))}</small></span>
    <button class="icon-btn" data-remove="${i}" title="去掉">×</button></div>`).join('');
}
function addFiles(list) {
  if (!state.room) return;
  for (const file of list) {
    if (pending.length >= FILE_COUNT) { alert(`一条消息最多带 ${FILE_COUNT} 个文件`); break; }
    if (file.size > fileLimit()) { alert(`「${file.name}」太大了（最多 ${sizeText(fileLimit())}）`); continue; }
    if (!file.size) { alert(`「${file.name}」是空文件`); continue; }
    const name = file.name && file.name !== 'image.png' ? file.name : `截图-${new Date().toTimeString().slice(0, 8).replace(/:/g, '')}.png`;
    const p = { name, size: file.size, status: 'uploading', video: /^video\//.test(file.type), thumb: /^image\/(png|jpeg|gif|webp)$/.test(file.type) ? URL.createObjectURL(file) : '' };
    p.promise = new Promise((resolve) => {
      const x = new XMLHttpRequest();
      x.open('POST', `/api/rooms/${state.room.id}/files?name=${encodeURIComponent(name)}`);
      x.setRequestHeader('content-type', 'application/octet-stream');
      let last = 0;
      x.upload.onprogress = (e) => { if (e.lengthComputable && Date.now() - last > 300) { last = Date.now(); p.progress = e.loaded / e.total; renderPending(); } };
      x.onload = () => {
        let d = {}; try { d = JSON.parse(x.responseText); } catch {}
        if (d.relogin) location.reload();
        if (x.status >= 200 && x.status < 300) { p.meta = d; p.status = 'done'; }
        else { p.status = 'error'; p.error = d.error || (x.status === 413 ? `文件太大了（最多 ${sizeText(fileLimit())}）` : '上传失败'); }
        resolve();
      };
      x.onerror = () => { p.status = 'error'; p.error = '上传失败：连不上 Agent Hub'; resolve(); };
      x.send(file);
    }).finally(renderPending);
    pending.push(p);
  }
  renderPending();
}
function clearPending() { for (const p of pending) if (p.thumb) URL.revokeObjectURL(p.thumb); pending.length = 0; renderPending(); }
$('#attachList').onclick = (e) => {
  const b = e.target.closest('button[data-remove]'); if (!b) return;
  const [p] = pending.splice(Number(b.dataset.remove), 1);
  if (p?.thumb) URL.revokeObjectURL(p.thumb);
  renderPending();
};
$('#attachBtn').onclick = () => $('#fileInput').click();
$('#fileInput').onchange = (e) => { addFiles([...e.target.files]); e.target.value = ''; };
$('#input').addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); addFiles(files); }
});
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
let dragDepth = 0;
$('.main').addEventListener('dragenter', (e) => { if (hasFiles(e) && state.room) { dragDepth++; $('.main').classList.add('dropping'); } });
$('.main').addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; $('.main').classList.remove('dropping'); } });
$('.main').addEventListener('dragover', (e) => { if (hasFiles(e) && state.room) e.preventDefault(); });
$('.main').addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault(); dragDepth = 0; $('.main').classList.remove('dropping');
  addFiles([...e.dataTransfer.files]);
});
$('#sendBtn').onclick = send;
$('#stopBtn').onclick = () => api('POST', `/api/rooms/${state.room.id}/stop`).catch(fail);
// isComposing / 229：中文输入法选词时按回车不发送
$('#input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); send(); } });
function autoGrow() { const t = $('#input'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 200) + 'px'; }
$('#input').addEventListener('input', autoGrow);

// ---------- 智能体编辑 ----------
const dlg = $('#agentDlg'), form = $('#agentForm');
const F = (n) => form.elements.namedItem(n);
function renderPresets() {
  let html = '', open = '';
  PRESETS.forEach((p, i) => {
    if (i && p.group) { html += `${open ? '</optgroup>' : ''}<optgroup label="${esc(p.group)}">`; open = p.group; }
    html += `<option value="${i}">${esc(p.label)}</option>`;
  });
  $('#presetSel').innerHTML = html + (open ? '</optgroup>' : '');
}
renderPresets();
// 预设里没写的字段恢复成默认值，免得上一个预设的模板、聊天记录上限留在表单里
const PRESET_DEFAULTS = { baseUrl: '', model: '', effort: '', fallbackModels: '', bodyTemplate: '', responsePath: '', headers: '', extraBody: '', stop: '', inputFormat: 'text', contextMode: 'full', systemMode: 'system', messageFormat: 'single', historyChars: '' };
$('#presetSel').onchange = (e) => {
  const p = PRESETS[e.target.value];
  $('#presetNote').hidden = !p.note; $('#presetNote').textContent = p.note || '';
  if (!p.provider) return;
  F('provider').value = p.provider;
  for (const [k, d] of Object.entries(PRESET_DEFAULTS)) F(k).value = p[k] ?? d;
  if (p.toolMode) F('toolMode').value = p.toolMode;
  syncWriteDirs();
  // 运行命令、读写文件夹的设置只能在 Mac 上改（手机上这几个输入框是灰的，不动它们）
  if (!F('startCommand').disabled) F('startCommand').value = p.startCommand || '';
  if (p.command && !F('command').disabled) F('command').value = p.command.replace('{root}', state.info ? tilde(state.info.root) : '~/Desktop/agent-hub');
  if (p.startCommand || p.contextMode) $('#advBox').open = true;
  syncProviderFields();
};
function syncProviderFields() {
  const p = F('provider').value;
  form.querySelectorAll('[data-for]').forEach((el) => { el.hidden = !el.dataset.for.split(' ').includes(p); });
  $('#baseUrlLabel').textContent = p === 'http' ? '程序地址（会收到 POST 请求）' : p === 'rest' ? '接口地址（完整网址，会收到 POST 请求）' : p === 'anthropic' ? '接口地址（留空 = 官方 api.anthropic.com）' : p === 'claude-code' ? '接口地址（留空 = 用 Claude 账号）' : '接口地址 Base URL';
  F('baseUrl').placeholder = p === 'http' ? 'http://localhost:9000/agent' : p === 'rest' ? 'http://localhost:11434/api/chat' : p === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.deepseek.com';
  const a = state.editing;
  F('apiKey').placeholder = a?.hasKey && !a.apiKeyEnv ? '已保存（留空不修改，填 - 清除）'
    : p === 'anthropic' ? '留空 = 读取环境变量 ANTHROPIC_API_KEY' : p === 'http' ? '可选，会作为 Bearer Token 发送'
    : p === 'rest' ? '可选；默认作为 Bearer Token 发送，也可以在请求头里写 {{key}}' : 'xai-… 或 env:XAI_API_KEY';
  F('model').placeholder = p === 'claude-code' ? '留空 = Claude Code 默认模型' : p === 'codex' ? 'gpt-6.1-sol' : p === 'anthropic' ? 'claude-opus-5-5'
    : p === 'rest' ? '会填进模板里的 {{model}}' : p === 'command' ? '可选，脚本里读 AGENT_HUB_MODEL' : '比如 deepseek-flash（本机服务可留空）';
  F('workdir').placeholder = p === 'command' ? '默认：你的主目录 ~' : '默认：' + (state.info ? tilde(state.info.workspace) : 'agent-hub/workspace');
  $('#localOnlyNote').hidden = !!state.info?.local || !['command', 'claude-code', 'codex'].includes(p);
  // Codex 没有「可用 Skill」这一档
  const skills = F('toolMode').querySelector('option[value="skills"]');
  skills.hidden = skills.disabled = p === 'codex';
  if (p === 'codex' && F('toolMode').value === 'skills') F('toolMode').value = 'edit';
  syncWriteDirs();
  updateRelayTask();
}
const tilde = (p) => (state.info?.home && p.startsWith(state.info.home) ? '~' + p.slice(state.info.home.length) : p);
function updateRelayTask() {
  const slug = (F('mailbox').value || F('name').value || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug || !state.info) { $('#relayTask').textContent = '（请先填写英文信箱名）'; return; }
  const base = `${state.info.mailboxRoot}/${slug}`;
  $('#relayTask').textContent = `每分钟检查一次这台 Mac 上的文件夹：\n${base}/requests/\n如果里面有 .md 文件，而 ${base}/replies/ 里还没有同名文件：\n1. 读取这个文件，按里面的要求，以你自己的身份写一段群聊发言；\n2. 把发言正文保存为 ${base}/replies/ 下的同名 .md 文件。\n不要修改或删除 requests 里的文件；没有新文件就什么都不做，也不用通知我。`;
}
F('mailbox').addEventListener('input', updateRelayTask);
F('name').addEventListener('input', updateRelayTask);
$('#copyRelayTask').onclick = async () => {
  const b = $('#copyRelayTask');
  b.textContent = (await copyText($('#relayTask').textContent)) ? '已复制' : '复制失败，请手动选中复制';
  setTimeout(() => { b.textContent = '复制这段话'; }, 2000);
};
F('provider').addEventListener('change', syncProviderFields);
F('toolMode').addEventListener('change', syncWriteDirs);
function syncWriteDirs() { $('#writeDirsBox').hidden = F('toolMode').value !== 'wide' || !['claude-code', 'codex'].includes(F('provider').value); }
function setTestOut(text, cls) { const o = $('#testOut'); o.textContent = text; o.className = 'test-out ' + (cls || ''); }
function openAgentDialog(a) {
  state.editing = a || null;
  $('#agentDlgTitle').textContent = a ? '编辑智能体' : '添加智能体';
  form.reset(); $('#presetSel').value = '0'; $('#presetNote').hidden = true; setTestOut('');
  const v = a || { name: '', avatar: '🤖', color: COLORS[state.agents.length % COLORS.length], persona: '', provider: 'openai', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' };
  for (const f of ['name', 'avatar', 'persona', 'provider', 'baseUrl', 'model']) F(f).value = v[f] ?? '';
  F('color').value = /^#[0-9a-f]{6}$/i.test(v.color || '') ? v.color : '#64748b';
  F('temperature').value = v.temperature ?? '';
  F('effort').value = v.effort || '';
  F('apiKey').value = a?.apiKeyEnv || '';
  F('toolMode').value = v.toolMode || 'chat';
  F('workdir').value = v.workdir || '';
  F('writeDirs').value = v.writeDirs || '';
  F('mailbox').value = v.mailbox || '';
  F('fallbackModels').value = v.fallbackModels || '';
  for (const f of ['bodyTemplate', 'responsePath', 'headers', 'command', 'startCommand', 'stop', 'extraBody']) F(f).value = v[f] || '';
  F('inputFormat').value = v.inputFormat || 'text';
  F('contextMode').value = v.contextMode || 'full';
  F('systemMode').value = v.systemMode || 'system';
  F('messageFormat').value = v.messageFormat || 'single';
  F('historyChars').value = v.historyChars || '';
  F('maxTokens').value = v.maxTokens || '';
  F('hideThinking').checked = v.thinking !== 'keep';
  F('onlyWhenMentioned').checked = !!v.onlyWhenMentioned;
  F('budgetUsd').value = v.budgetUsd || '';
  F('budgetTokensWan').value = v.budgetTokens ? v.budgetTokens / 10000 : '';
  F('priceIn').value = v.priceIn || '';
  F('priceOut').value = v.priceOut || '';
  const u = a?.usage;
  $('#budgetSum').textContent = u && u.calls ? `本月 ${u.calls} 次 · ${kTok(u.tokens)} token${u.cost ? ' · ' + usd(u.cost) : ''}${u.limited ? `（预算用了 ${Math.round(u.ratio * 100)}%）` : ''}` : '';
  $('#budgetBox').open = !!(v.budgetUsd || v.budgetTokens || v.priceIn || v.priceOut);
  // 能运行命令、读写文件夹的设置只能在 Mac 上改；手机上变灰（不提交），服务端也会拦
  for (const f of ['command', 'startCommand', 'workdir', 'writeDirs']) F(f).disabled = !state.info?.local;
  $('#advBox').open = !!(v.contextMode || v.systemMode || v.messageFormat || v.historyChars || v.stop || v.extraBody || v.headers || v.startCommand || v.thinking === 'keep');
  $('#discoverOut').hidden = true; $('#discoverOut').innerHTML = '';
  $('#keyHint').innerHTML = 'Key 只保存在本机 <code>data/agents.json</code>；写成 <code>env:变量名</code> 则从环境变量或 <code>.env</code> 文件读取。';
  $('#delAgent').hidden = !a;
  syncProviderFields();
  dlg.showModal();
}
function formData() {
  const d = Object.fromEntries(new FormData(form));
  d.temperature = d.temperature === '' ? null : Number(d.temperature);
  d.onlyWhenMentioned = F('onlyWhenMentioned').checked;
  d.thinking = F('hideThinking').checked ? 'hide' : 'keep';
  delete d.hideThinking;
  d.budgetTokens = d.budgetTokensWan === '' ? '' : Math.round(Number(d.budgetTokensWan) * 10000);
  delete d.budgetTokensWan;
  return d;
}
$('#cancelAgent').onclick = () => dlg.close();
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const d = formData();
  try {
    if (state.editing) await api('PUT', '/api/agents/' + state.editing.id, d);
    else {
      const a = await api('POST', '/api/agents', d);
      if (state.room && confirm(`把「${a.name}」加入当前房间「${state.room.name}」？`)) {
        await refreshAgents();
        await saveRoom({ memberIds: [...state.room.memberIds, a.id] });
      }
    }
    dlg.close();
    await refreshAgents();
    if (state.room) renderRoom();
  } catch (err) { fail(err); }
});
$('#testAgent').onclick = async () => {
  setTestOut('测试中…');
  try {
    const r = await api('POST', '/api/test-agent', { ...formData(), id: state.editing?.id });
    setTestOut(r.ok ? '连接成功：' + r.text : '连接失败：' + r.error, r.ok ? 'ok' : 'bad');
  } catch (e) { setTestOut('连接失败：' + e.message, 'bad'); }
};
$('#delAgent').onclick = async () => {
  if (!confirm(`删除智能体「${state.editing.name}」？`)) return;
  try {
    await api('DELETE', '/api/agents/' + state.editing.id);
    dlg.close(); await refreshAgents();
    if (state.room) await reloadRoom(state.room.id);
  } catch (e) { fail(e); }
};

// ---------- 查找本机正在运行的模型 ----------
let discovered = [];
const NO_LOCAL = '没找到正在运行的本机模型。想在这台 Mac 上跑模型，最简单的是装 Ollama（ollama.com），在终端运行 ollama pull qwen3:4b，再点一次查找；自己训练的模型怎么接，见 README「接入本地模型、自己训练的模型」。';
async function discoverModels(url) {
  const box = $('#discoverOut');
  box.hidden = false;
  box.innerHTML = `<p class="hint">${url ? `正在查 ${esc(url)} …` : '正在查找本机的模型服务…'}</p>`;
  let r;
  try { r = await api('GET', '/api/local-models' + (url ? '?url=' + encodeURIComponent(url) : '')); }
  catch (e) { box.innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
  discovered = r.servers;
  const list = r.servers.map((s, si) => `<div class="disc-server"><b>${esc(s.name)}</b> <code>${esc(s.baseUrl)}</code>
    <div class="disc-models">${s.models.map((m, mi) => `<button type="button" class="chip${m.chat ? '' : ' muted'}" data-si="${si}" data-mi="${mi}" title="${m.chat ? '点一下填好接口地址和模型' : '看起来不是聊天模型（向量、语音等）'}">${m.id ? esc(m.id) : '默认模型'}${m.note ? `<small>${esc(m.note)}</small>` : ''}</button>`).join('') || '<span class="hint">服务开着，但里面还没有模型</span>'}</div></div>`).join('');
  box.innerHTML = (list || (url ? '' : `<p class="hint">${esc(NO_LOCAL)}</p>`))
    + r.hints.map((h) => `<p class="hint">${esc(h)}</p>`).join('')
    + `<div class="row gap disc-url"><input id="discUrl" placeholder="查别的地址：局域网电脑、云服务器，比如 http://192.168.1.8:8000" value="${esc(url || '')}"><button type="button" class="btn ghost" id="discUrlBtn">查找</button></div>`;
}
function useDiscovered(s, m) {
  const local = isLocalUrl(s.baseUrl);
  F('provider').value = 'openai'; F('baseUrl').value = s.baseUrl; F('model').value = m.id;
  F('fallbackModels').value = ''; F('effort').value = '';
  if (!F('name').value.trim()) F('name').value = m.id ? m.id.split('/').pop() : '本机模型';
  if (local && !F('historyChars').value) F('historyChars').value = 6000;
  $('#presetSel').value = '0';
  $('#presetNote').hidden = false;
  $('#presetNote').textContent = `已填好 ${s.name} 的 ${m.id || '默认模型'}${local ? '（本机模型，聊天记录上限先设成 6000 字，在「小模型 / 专精模型适配」里可以改）' : ''}。点「测试连接」试一下，没问题就保存。`;
  syncProviderFields();
}
$('#discoverBtn').onclick = () => discoverModels();
$('#discoverOut').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-si]');
  if (b) { const s = discovered[b.dataset.si]; useDiscovered(s, s.models[b.dataset.mi]); return; }
  if (e.target.id === 'discUrlBtn' && $('#discUrl').value.trim()) discoverModels($('#discUrl').value.trim());
});
// 在地址框里按回车是查找，不是提交（保存）整个表单
$('#discoverOut').addEventListener('keydown', (e) => {
  if (e.target.id !== 'discUrl' || e.key !== 'Enter' || e.isComposing) return;
  e.preventDefault();
  if (e.target.value.trim()) discoverModels(e.target.value.trim());
});

// ---------- 手机访问（只在 Mac 本机上显示）----------
const phoneDlg = $('#phoneDlg');
const fmtTime = (t) => new Date(t).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
async function renderPhone(patch) {
  let a;
  try { a = await api(patch ? 'POST' : 'GET', '/api/access', patch); }
  catch (e) { $('#phoneBody').innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
  const code = `<b class="phone-code">${esc(a.code)}</b>`;
  const addr = a.urls.map((u) => `<code>${esc(u.url)}</code>`).join(' 或 ');
  const devices = a.devices.length
    ? `<ul class="phone-devices">${a.devices.map((d) => `<li>${esc(d.device)} · ${fmtTime(d.created)} 登录 · 最近使用 ${fmtTime(d.lastSeen)}</li>`).join('')}</ul>`
    : '<p class="hint">还没有设备登录过。</p>';
  let html;
  if (!a.lan) html = `<p>现在只允许本机访问（默认设置，监听 <code>${esc(a.host)}</code>），手机连不上。要用手机访问：在 <code>.env</code> 里写 <code>HOST=0.0.0.0</code>，再重新启动 Agent Hub。</p>`;
  else if (!a.enabled) html = '<p>手机访问已关闭，局域网里的设备都打不开 Agent Hub。</p><div class="row gap"><button class="btn primary" data-phone="on">开启手机访问</button></div>';
  else if (!a.urls.length) html = '<p>这台 Mac 现在没有连 Wi-Fi，手机找不到它。连上 Wi-Fi 后再打开这里。</p>';
  else html = `
    ${a.qrSvg ? `<div class="phone-qr">${a.qrSvg}</div>` : ''}
    <ol class="phone-steps">
      <li>手机和这台 Mac 连同一个 Wi-Fi。</li>
      <li>${a.qrSvg ? '用 iPhone 相机扫上面的二维码，点弹出的链接，第一次会自动登录。' : `在手机 Safari 里打开 ${addr}，输入访问码 ${code}。`}</li>
      <li>想像 App 一样用：在 Safari 里点「分享」→「添加到主屏幕」。从主屏幕打开时如果要登录，输入访问码 ${code}。</li>
    </ol>
    ${a.qrSvg ? `<p class="hint">扫不了码：在手机 Safari 里打开 ${addr}，输入访问码 ${code}。</p>` : ''}
    <p class="hint">连不上的话：Mac 上开着 VPN 时，要在 VPN 设置里打开「本地网络共享」；另外 Agent Hub 要开着、Mac 不能睡眠，合上盖子就断开了。</p>
    <details><summary class="hint">已登录的设备（${a.devices.length}）</summary>${devices}</details>
    <div class="row gap phone-actions"><button class="btn ghost" data-phone="reset">换一个访问码</button><button class="btn danger ghost" data-phone="off">关闭手机访问</button></div>`;
  $('#phoneBody').innerHTML = html;
}
$('#phoneBtn').onclick = () => { $('#phoneBody').innerHTML = '<p class="hint">加载中…</p>'; phoneDlg.showModal(); renderPhone(); };
$('#closePhone').onclick = () => phoneDlg.close();
$('#phoneBody').onclick = (e) => {
  const b = e.target.closest('button[data-phone]'); if (!b) return;
  const act = b.dataset.phone;
  if (act === 'reset' && !confirm('换一个访问码？已经登录的手机都要重新扫码。')) return;
  if (act === 'off' && !confirm('关闭手机访问？已经登录的手机也会打不开，之后可以在这里重新开启。')) return;
  renderPhone(act === 'reset' ? { reset: true } : { enabled: act === 'on' });
};

// ---------- 用量 ----------
const usageDlg = $('#usageDlg');
async function renderUsage() {
  let r;
  try { r = await api('GET', '/api/usage'); } catch (e) { $('#usageBody').innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
  const cost = (t) => (t.costCalls ? (t.costCalls < t.calls ? '≥' : '') + usd(t.cost) : '—');
  const bar = (row) => {
    const parts = [];
    if (row.budgetUsd) parts.push([row.month.cost / row.budgetUsd, `${usd(row.month.cost)} / ${usd(row.budgetUsd)}`]);
    if (row.budgetTokens) parts.push([(row.month.in + row.month.out) / row.budgetTokens, `${kTok(row.month.in + row.month.out)} / ${kTok(row.budgetTokens)}`]);
    if (!parts.length) return '<span class="hint">不限</span>';
    return parts.map(([p, t]) => `<div class="meter ${p >= 1 ? 'over' : p >= 0.8 ? 'warn' : ''}"><i style="width:${Math.min(100, p * 100).toFixed(1)}%"></i></div><small>${t}</small>`).join('');
  };
  const rows = r.rows.map((x) => `<tr><td><span class="who">${x.exists ? avatarHtml(x, true) : ''}<span>${esc(x.name)}</span></span></td>
    <td class="num">${x.today.calls ? `${x.today.calls} 次<br><small>${kTok(x.today.in + x.today.cache)} → ${kTok(x.today.out)}</small>` : '—'}</td>
    <td class="num">${x.month.calls ? `${x.month.calls} 次<br><small>${kTok(x.month.in + x.month.cache)} → ${kTok(x.month.out)}</small>` : '—'}</td>
    <td class="num">${cost(x.month)}${x.month.calls && !x.month.costCalls && x.provider !== 'claude-code' ? '<br><small>没填单价</small>' : ''}</td>
    <td class="budget">${bar(x)}</td></tr>`).join('');
  const hist = r.history.map((h) => `<li><b>${h.month}</b>　${h.calls} 次 · 输入 ${kTok(h.in + h.cache)} · 输出 ${kTok(h.out)}${h.costCalls ? ' · ' + cost(h) : ''}</li>`).join('');
  $('#usageBody').innerHTML = `<p class="hint">本月（${r.month}）。「输入 → 输出」是 token 数；花费：Claude Code 是它自己按 API 价格折算的（用订阅时不是真扣钱），其他的要在智能体设置里填单价才能估算，「≥」表示有几次没算进去。</p>
    <div class="table-wrap"><table class="usage-table"><thead><tr><th>智能体</th><th>今天</th><th>本月</th><th>花费</th><th>本月预算</th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="hint">还没有记录：从现在开始，每次回复都会记下用量</td></tr>'}</tbody></table></div>
    <p class="hint">点左边智能体，展开「预算和用量」设上限：用完自动跳过，用到 80% 时群里提醒一次。</p>
    ${hist ? `<details><summary class="hint">最近几个月</summary><ul class="hist">${hist}</ul></details>` : ''}`;
}
$('#usageBtn').onclick = () => { $('#usageBody').innerHTML = '<p class="hint">加载中…</p>'; usageDlg.showModal(); renderUsage(); };
$('#closeUsage').onclick = () => usageDlg.close();

// ---------- 启动 ----------
(async () => {
  if (TOUCH) $('#input').placeholder = '发消息或布置任务';
  state.info = await api('GET', '/api/info').catch(() => null);
  $('#phoneBtn').hidden = !state.info?.local;
  await refreshAgents(); await refreshRooms();
  let last = null; try { last = localStorage.getItem('agenthub.room'); } catch {}
  const r = state.rooms.find((x) => x.id === last) || state.rooms[0];
  if (r) await openRoom(r.id);
})().catch((e) => { document.body.insertAdjacentHTML('afterbegin', `<p style="color:#d64545;padding:10px;margin:0">加载失败：${esc(e.message)}</p>`); });
